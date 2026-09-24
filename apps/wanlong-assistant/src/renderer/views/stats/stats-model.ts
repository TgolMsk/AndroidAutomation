/**
 * Pure helpers of the 数据统计 page (original features/stats/statsStore.ts + StatsView/ResourceSnapshotTable
 * helpers), kept out of the components so Node tests cover them. Dates are Beijing date keys only: never host dates.
 */
import {
  PANEL_AMOUNT_PRECISION, RESOURCE_PANEL_ROW_ORDER, RESOURCE_TYPES, formatCnAmount, snapshotRow, type ResourceSnapshot,
  type ResourceType,
} from '@avdm/automation/wanlong/pure';
import { livePausedMs, type DailyResourceStat, type DailyStats, type InstanceDailyStats } from '../../../shared/stats';
import type { DateKey } from '../../../shared/time';

/** Rows of the 「近 N 天」 table (today included). */
export const RECENT_DAYS = 14;
/** The running pause is re-rendered this often (a duration, not a countdown). */
export const LIVE_TICK_MS = 30_000;
/** Detail rows per page in the snapshot table. */
export const SNAPSHOT_PAGE_SIZE = 12;

export function totalEstimated(s: DailyStats): number {
  return RESOURCE_TYPES.reduce((acc, t) => acc + s.byResource[t].estimatedAmount, 0);
}

export function totalCompleted(s: DailyStats): number {
  return RESOURCE_TYPES.reduce((acc, t) => acc + s.byResource[t].completed, 0);
}

export function totalUnknownStorage(s: DailyStats): number {
  return RESOURCE_TYPES.reduce((acc, t) => acc + s.byResource[t].unknownStorageDispatches, 0);
}

export function instanceEstimated(i: InstanceDailyStats): number {
  return RESOURCE_TYPES.reduce((acc, t) => acc + i.byResource[t].estimatedAmount, 0);
}

/**
 * Paused time of the day over every instance, the running pause included. Only today has a running pause (a past day
 * is closed at 24:00 by the main process), so `now` never inflates a past day.
 */
export function totalPausedMs(s: DailyStats, now: number): number {
  return Object.values(s.byInstance).reduce((acc, i) => acc + livePausedMs(i, now), 0);
}

/** Instances whose pause is still running on this day. */
export function pausedNowCount(s: DailyStats): number {
  return Object.values(s.byInstance).filter((i) => i.pausedSince != null).length;
}

export function hasAnyData(s: DailyStats): boolean {
  return s.dispatches > 0 || s.failures > 0 || s.circuitBreaks > 0 || s.alerts > 0 || s.pausedMs > 0 ||
    s.snapshots.length > 0 || Object.keys(s.byInstance).length > 0;
}

export interface ResourceRow extends DailyResourceStat {
  type: ResourceType;
  /** Share of the day: of the estimated amount; of the dispatches when no storage was read at all; else 0. */
  share: number;
}

/** The 按资源 card: share of the estimate, falling back to the share of dispatches (never an empty column). */
export function resourceRows(s: DailyStats): ResourceRow[] {
  const estimated = totalEstimated(s);
  return RESOURCE_TYPES.map((type) => {
    const r = s.byResource[type];
    const share = estimated > 0 ? r.estimatedAmount / estimated : s.dispatches > 0 ? r.dispatches / s.dispatches : 0;
    return { type, ...r, share };
  });
}

/** 按实例 rows: by index, the AVD at that index now before an earlier (replaced) one. */
export function instanceRows(s: DailyStats): InstanceDailyStats[] {
  return Object.values(s.byInstance).sort((a, b) => a.instanceIndex - b.instanceIndex || Number(a.replaced) - Number(b.replaced));
}

/** `1,234,567 个` for the exact-value tooltip (en-US grouping like the original). */
export function exactAmount(n: number): string {
  return `${Math.round(n).toLocaleString('en-US')} 个`;
}

// ── page store semantics (original statsStore) ──────────────────────────────

export interface StatsViewState {
  /** Today's bucket as the main process sees it (its date key decides what "today" is). */
  today: DailyStats | null;
  selectedKey: DateKey;
  selected: DailyStats | null;
  /** The last RECENT_DAYS days, ascending (the last one is today). */
  recent: DailyStats[];
}

/**
 * A `stats-today` push. The selected bucket follows when it shows that day; after Beijing midnight a page that was on
 * the old today moves to the new day. The recent list replaces the same day or, across midnight, appends the new one
 * and drops the oldest.
 */
export function applyTodayPush(state: StatsViewState, s: DailyStats): StatsViewState {
  const previousKey = state.today?.dateKey ?? null;
  const crossed = previousKey !== null && previousKey !== s.dateKey;
  const next: StatsViewState = { ...state, today: s };
  if (state.selectedKey === s.dateKey) {
    next.selected = s;
  } else if (crossed && state.selectedKey === previousKey) {
    next.selectedKey = s.dateKey;
    next.selected = s;
  }
  const idx = state.recent.findIndex((d) => d.dateKey === s.dateKey);
  if (idx >= 0) {
    const recent = state.recent.slice();
    recent[idx] = s;
    next.recent = recent;
  } else if (crossed) {
    next.recent = [...state.recent, s].slice(-RECENT_DAYS);
  }
  return next;
}

/** A day the page already holds (today or the recent list): switching to it needs no IPC. */
export function cachedDay(state: StatsViewState, key: DateKey): DailyStats | null {
  if (state.today?.dateKey === key) return state.today;
  return state.recent.find((d) => d.dateKey === key) ?? null;
}

// ── snapshot table (original ResourceSnapshotTable) ─────────────────────────

/** An instance's earliest and latest snapshot of the day (the same object when there is only one). */
export interface InstancePair {
  instanceIndex: number;
  first: ResourceSnapshot;
  last: ResourceSnapshot;
}

export function pairByInstance(snapshots: readonly ResourceSnapshot[]): InstancePair[] {
  const byInstance = new Map<number, ResourceSnapshot[]>();
  for (const snap of snapshots) {
    const list = byInstance.get(snap.instanceIndex) ?? [];
    list.push(snap);
    byInstance.set(snap.instanceIndex, list);
  }
  const out: InstancePair[] = [];
  for (const [instanceIndex, list] of byInstance) {
    list.sort((a, b) => a.at - b.at);
    out.push({ instanceIndex, first: list[0]!, last: list[list.length - 1]! });
  }
  return out.sort((a, b) => a.instanceIndex - b.instanceIndex);
}

export interface CompareRow {
  key: string;
  instanceIndex: number;
  type: ResourceType;
  /** First row of an instance (the instance cell spans the four resource rows). */
  firstOfInstance: boolean;
  firstAt: number;
  lastAt: number;
  same: boolean;
  firstTotal: number | null;
  lastTotal: number | null;
  lastItem: number | null;
  rawFirstTotal: string;
  rawLastTotal: string;
  rawLastItem: string;
}

/** One row per instance × resource, in the table's row order (gold, wood, iron, mana). */
export function compareRows(snapshots: readonly ResourceSnapshot[]): CompareRow[] {
  const rows: CompareRow[] = [];
  for (const pair of pairByInstance(snapshots)) {
    RESOURCE_PANEL_ROW_ORDER.forEach((type, i) => {
      const a = snapshotRow(pair.first, type);
      const b = snapshotRow(pair.last, type);
      rows.push({
        key: `${pair.instanceIndex}:${type}`,
        instanceIndex: pair.instanceIndex,
        type,
        firstOfInstance: i === 0,
        firstAt: pair.first.at,
        lastAt: pair.last.at,
        same: pair.first === pair.last,
        firstTotal: a?.total ?? null,
        lastTotal: b?.total ?? null,
        lastItem: b?.itemTotal ?? null,
        rawFirstTotal: a?.rawTotal ?? '',
        rawLastTotal: b?.rawTotal ?? '',
        rawLastItem: b?.rawItem ?? '',
      });
    });
  }
  return rows;
}

export interface AmountView {
  text: string;
  title: string;
  /** Not a number (unread / unparsed): shown dim. */
  dim: boolean;
}

/** A table amount: `≈11.1亿` with the raw OCR text and the exact value in the tooltip; unread → raw text or 读不出. */
export function amountView(value: number | null, raw: string): AmountView {
  if (value === null) {
    return { text: raw || '读不出', title: raw ? `识别到「${raw}」但没能解析成数字` : '这一格没读出来', dim: true };
  }
  return { text: `≈${formatCnAmount(value)}`, title: `识别原文：${raw || '（无）'}　精确值 ${value.toLocaleString('en-US')}`, dim: false };
}

export type DeltaView =
  | { kind: 'none'; text: '—' }
  | { kind: 'flat'; text: '≈0'; title: string }
  | { kind: 'up' | 'down'; text: string };

/**
 * The 「变化」 cell: difference of the two totals. Below the table's precision (0.1亿 = 1000 万) it is noise, shown
 * as ≈0 without a direction; a missing side is 「—」.
 */
export function deltaView(from: number | null, to: number | null): DeltaView {
  if (from === null || to === null) return { kind: 'none', text: '—' };
  const d = to - from;
  if (Math.abs(d) < PANEL_AMOUNT_PRECISION) return { kind: 'flat', text: '≈0', title: '两张快照相差不到 0.1亿，在这张表的精度内视为没变化' };
  return { kind: d > 0 ? 'up' : 'down', text: `${d > 0 ? '+' : '-'}${formatCnAmount(Math.abs(d))}` };
}

/** Rows of one page of a list (1-based page, clamped). */
export function pageOf<T>(items: readonly T[], page: number, size: number): { rows: T[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(items.length / size));
  const current = Math.min(pages, Math.max(1, Math.floor(page)));
  return { rows: items.slice((current - 1) * size, current * size), page: current, pages };
}
