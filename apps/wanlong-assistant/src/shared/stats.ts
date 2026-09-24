/**
 * 「每日数据统计」contract shared by the main process, the renderer and the Telegram bot (original
 * `src/shared/stats.ts`). Pure: no Node, Electron or DOM imports (checked by shared-purity.test.ts).
 *
 * What is counted (original 【统计口径】):
 *  1. Buckets are **Beijing** calendar days (the game runs on UTC+8, the host zone can be anything). Keys are
 *     `YYYY-MM-DD` from `cstDateKey()` in ./time — the single implementation; never `toLocaleDateString`/`getDate`.
 *  2. The main source is dispatch bookkeeping: every dispatch read the resource card's storage (exact to the unit)
 *     and gathering defaults to 「自动采集至清空」, so one trip ≈ its storage. `estimatedAmount` = Σ storage; a trip
 *     whose storage was not read counts 0 and raises `unknownStorageDispatches` (the page says the estimate is low).
 *     ★ The in-game resource table (道具 → 资源统计) is only accurate to 0.1亿: it is kept as snapshots for
 *     reconciliation and never used to compute a daily amount.
 *  3. Counters: per-resource dispatches / estimated amount / completed trips, total dispatches, failed cycles,
 *     circuit breaks (separate from failures), alerts, paused time and resource snapshots — each both per instance
 *     and in total.
 *  4. Everything starts as a fact (`StatsEvent`); the main process folds facts into day buckets. Sources:
 *       dispatch        AutomationHost onDispatched (every record, also of cycles that ended in an error)
 *       cycleFailed     AutomationHost onCycleResult (outcome 'error' | 'circuitBroken'; GAME_UPDATE_REQUIRED /
 *                       AI_RISK_BLOCKED are not failures: a dedicated「需要人处理」alert covers them)
 *       tripCompleted   EtaScheduler onMarchGone (a march that was out is gone from the troop panel)
 *       alertRaised     the alert conclusions actually raised (not per-run noise)
 *       paused/resumed  ★ only EtaScheduler onAutoChanged (fires on a real flip of the auto switch)
 *       snapshot        a successful resource-table read (「读一次资源统计」, the bot's 💰 资源)
 */
import {
  RESOURCE_NAME, RESOURCE_TYPES, formatCnAmount, normalizeResourceSnapshot, type ResourceSnapshot, type ResourceType,
} from '@avdm/automation/wanlong/pure';
import { cstDateKey, isDateKey, type DateKey } from './time';

export {
  cstDateKey, cstDayStart, cstNextDayStart, dateKeyRange, dateKeyToDayStart, isDateKey, shiftDateKey, type DateKey,
} from './time';
export type { ResourceSnapshot, ResourceType } from '@avdm/automation/wanlong/pure';

// ── Day buckets ──────────────────────────────────────────────────────────────

/** One resource on one day. */
export interface DailyResourceStat {
  /** Dispatches (sent by this engine and confirmed by the queue +1). */
  dispatches: number;
  /** Σ card storage at dispatch time (units). A trip whose storage was not read counts 0. */
  estimatedAmount: number;
  /** Dispatches whose storage was not read (the estimate is low by that many trips). */
  unknownStorageDispatches: number;
  /** Trips completed: a dispatched march disappeared from the troop panel (it came home). A reference metric. */
  completed: number;
}

/** One instance on one day. */
export interface InstanceDailyStats {
  instanceIndex: number;
  /**
   * Key of this bucket in `DailyStats.byInstance`: `String(index)` for the AVD at that index now, and
   * `${index}@${createdAt}` for an earlier AVD at the same index that was replaced that day — a recreated
   * instance never inherits the old one's numbers or account (instance identity = `record.createdAt`).
   */
  key: string;
  /** Instance identity the facts were recorded against; null when it could not be read. */
  instanceCreatedAt: string | null;
  /** An AVD that was replaced at this index later the same day. */
  replaced: boolean;
  /** Name of the account bound to this AVD at its last fact of the day; null when none was bound. */
  accountName: string | null;
  byResource: Record<ResourceType, DailyResourceStat>;
  /** Total dispatches (= Σ byResource.dispatches). */
  dispatches: number;
  /** Cycles that ended with outcome 'error' (including cycles that never got started). */
  failures: number;
  /** Circuit breaks (outcome 'circuitBroken'): a designed stop, never counted as a failure. */
  circuitBreaks: number;
  /** Alert conclusions raised for this instance (including ones whose push was suppressed by the cooldown). */
  alerts: number;
  /** Closed pauses of the day (ms). A pause across midnight is split: the old day up to 24:00, the new from 00:00. */
  pausedMs: number;
  /** Start of the pause still running within this day (00:00 after a midnight split); null when not paused. */
  pausedSince: number | null;
}

/** One Beijing day. */
export interface DailyStats {
  gameId: string;
  dateKey: DateKey;
  /** Totals over every instance. */
  byResource: Record<ResourceType, DailyResourceStat>;
  dispatches: number;
  failures: number;
  circuitBreaks: number;
  alerts: number;
  pausedMs: number;
  /** Per instance, keyed by `InstanceDailyStats.key`. */
  byInstance: Record<string, InstanceDailyStats>;
  /** Resource-table snapshots of the day, ascending, at most `STATS_SNAPSHOTS_PER_DAY` (the newest are kept). */
  snapshots: ResourceSnapshot[];
  /** Time of the latest fact of the day (0 = nothing recorded). */
  updatedAt: number;
}

/** The only game wired to statistics today. */
export const STATS_GAME_ID = 'wanlong';
/** Snapshots kept per day (one per instance at midnight plus manual reads; stops a bot button used like a mouse). */
export const STATS_SNAPSHOTS_PER_DAY = 48;
/** Days kept on disk ([today − 89, today]). */
export const STATS_RETENTION_DAYS = 90;
/** Longest range one query may return. */
export const STATS_RANGE_MAX_DAYS = 366;

export function emptyResourceStat(): DailyResourceStat {
  return { dispatches: 0, estimatedAmount: 0, unknownStorageDispatches: 0, completed: 0 };
}

export function emptyByResource(): Record<ResourceType, DailyResourceStat> {
  return { gold: emptyResourceStat(), wood: emptyResourceStat(), iron: emptyResourceStat(), mana: emptyResourceStat() };
}

export function emptyInstanceDailyStats(instanceIndex: number, key = String(instanceIndex)): InstanceDailyStats {
  return {
    instanceIndex, key, instanceCreatedAt: null, replaced: false, accountName: null, byResource: emptyByResource(),
    dispatches: 0, failures: 0, circuitBreaks: 0, alerts: 0, pausedMs: 0, pausedSince: null,
  };
}

export function emptyDailyStats(dateKey: DateKey, updatedAt = 0, gameId = STATS_GAME_ID): DailyStats {
  return {
    gameId, dateKey, byResource: emptyByResource(), dispatches: 0, failures: 0, circuitBreaks: 0, alerts: 0,
    pausedMs: 0, byInstance: {}, snapshots: [], updatedAt,
  };
}

function numOr(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function normalizeByResource(raw: unknown): Record<ResourceType, DailyResourceStat> {
  const out = emptyByResource();
  if (typeof raw !== 'object' || raw === null) return out;
  const o = raw as Record<string, unknown>;
  for (const t of RESOURCE_TYPES) {
    const v = o[t];
    if (typeof v !== 'object' || v === null) continue;
    const s = v as Record<string, unknown>;
    out[t] = {
      dispatches: numOr(s['dispatches']),
      estimatedAmount: numOr(s['estimatedAmount']),
      unknownStorageDispatches: numOr(s['unknownStorageDispatches']),
      completed: numOr(s['completed']),
    };
  }
  return out;
}

/**
 * Tolerant restore of a day bucket from disk, a push or an imported legacy file (original normalizeDailyStats):
 * a bad field falls back alone instead of discarding the day; bad instance keys and snapshots are dropped.
 */
export function normalizeDailyStats(raw: unknown, fallbackKey: DateKey, gameId = STATS_GAME_ID): DailyStats {
  const base = emptyDailyStats(fallbackKey, 0, gameId);
  if (typeof raw !== 'object' || raw === null) return base;
  const o = raw as Record<string, unknown>;
  const out: DailyStats = {
    ...base,
    gameId: typeof o['gameId'] === 'string' && o['gameId'] ? o['gameId'] : gameId,
    dateKey: isDateKey(o['dateKey']) ? o['dateKey'] : fallbackKey,
    byResource: normalizeByResource(o['byResource']),
    dispatches: numOr(o['dispatches']),
    failures: numOr(o['failures']),
    circuitBreaks: numOr(o['circuitBreaks']),
    alerts: numOr(o['alerts']),
    pausedMs: numOr(o['pausedMs']),
    updatedAt: numOr(o['updatedAt']),
    snapshots: Array.isArray(o['snapshots'])
      ? (o['snapshots'] as unknown[]).map(normalizeResourceSnapshot)
        .filter((snap): snap is ResourceSnapshot => snap !== null).slice(-STATS_SNAPSHOTS_PER_DAY)
      : [],
  };
  if (typeof o['byInstance'] === 'object' && o['byInstance'] !== null) {
    for (const [k, v] of Object.entries(o['byInstance'] as Record<string, unknown>)) {
      if (typeof v !== 'object' || v === null) continue;
      const iv = v as Record<string, unknown>;
      const idx = Number(k.split('@')[0]);
      if (!Number.isInteger(idx) || idx < 0) continue;
      out.byInstance[k] = {
        instanceIndex: idx,
        key: k,
        instanceCreatedAt: typeof iv['instanceCreatedAt'] === 'string' ? iv['instanceCreatedAt'] : null,
        replaced: iv['replaced'] === true,
        accountName: typeof iv['accountName'] === 'string' ? iv['accountName'] : null,
        byResource: normalizeByResource(iv['byResource']),
        dispatches: numOr(iv['dispatches']),
        failures: numOr(iv['failures']),
        circuitBreaks: numOr(iv['circuitBreaks']),
        alerts: numOr(iv['alerts']),
        pausedMs: numOr(iv['pausedMs']),
        pausedSince: typeof iv['pausedSince'] === 'number' && Number.isFinite(iv['pausedSince']) ? iv['pausedSince'] : null,
      };
    }
  }
  return out;
}

// ── Events (facts only, no conclusions) ──────────────────────────────────────

/** One confirmed dispatch (the subset of DispatchRecord the bucket needs). */
export interface StatsDispatchEvent {
  kind: 'dispatch';
  at: number;
  instanceIndex: number;
  resource: ResourceType;
  /** Card storage (units); null when unread (counted in unknownStorageDispatches). */
  storage: number | null;
  coord: string | null;
  level: number | null;
  travelTimeSec: number | null;
}

/** A gather cycle that ended in an error or a circuit break. */
export interface StatsCycleFailedEvent {
  kind: 'cycleFailed';
  at: number;
  instanceIndex: number;
  /** 'error' counts as a failure, 'circuitBroken' as a circuit break. */
  outcome: 'error' | 'circuitBroken';
  message: string;
  step: string | null;
  errorCode: string | null;
}

/** A march dispatched by this engine came home (it disappeared from the troop panel). */
export interface StatsTripCompletedEvent {
  kind: 'tripCompleted';
  at: number;
  instanceIndex: number;
  coord: string | null;
  /** The resource from the dispatch bookkeeping; null when unknown (the service resolves or drops it). */
  resource: ResourceType | null;
}

/** An alert conclusion was raised (whether or not it paused anything or its push went out). */
export interface StatsAlertRaisedEvent {
  kind: 'alertRaised';
  at: number;
  instanceIndex: number;
  /** Alert type as a string (the alerts module's type); only stored, never interpreted. */
  alertType: string;
}

/** The instance's automatic schedule was switched off / on. pausedMs is the time between the two. */
export interface StatsPausedEvent {
  kind: 'paused';
  at: number;
  instanceIndex: number;
  reason: string | null;
}

export interface StatsResumedEvent {
  kind: 'resumed';
  at: number;
  instanceIndex: number;
}

/** A resource-table snapshot was read. */
export interface StatsSnapshotEvent {
  kind: 'snapshot';
  at: number;
  instanceIndex: number;
  snapshot: ResourceSnapshot;
}

export type StatsEvent =
  | StatsDispatchEvent
  | StatsCycleFailedEvent
  | StatsTripCompletedEvent
  | StatsAlertRaisedEvent
  | StatsPausedEvent
  | StatsResumedEvent
  | StatsSnapshotEvent;

export type StatsEventKind = StatsEvent['kind'];

// ── Text (the bot's 「📈 今日统计」 and the page summary share this wording) ──

/** ms → `3小时12分` / `45分` / `<1分`; zero, negative or NaN → `0分`. */
export function formatPausedDuration(ms: number): string {
  if (!(ms > 0)) return '0分';
  const min = Math.floor(ms / 60_000);
  if (min < 1) return '<1分';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h}小时${m}分` : `${m}分`;
}

/** Paused time of an instance on its day, including the pause still running at `now`. */
export function livePausedMs(inst: Pick<InstanceDailyStats, 'pausedMs' | 'pausedSince'>, now: number = Date.now()): number {
  return inst.pausedMs + (inst.pausedSince != null ? Math.max(0, now - inst.pausedSince) : 0);
}

/** How an instance bucket is named in texts: `实例 0「主号」`, `实例 0（已替换的旧实例）`. */
export function instanceLabel(inst: Pick<InstanceDailyStats, 'instanceIndex' | 'accountName' | 'replaced'>): string {
  return `实例 ${inst.instanceIndex}${inst.accountName ? `「${inst.accountName}」` : ''}${inst.replaced ? '（已替换的旧实例）' : ''}`;
}

/**
 * One day as plain text (★ no Markdown, the bot sends it without parse_mode):
 *
 *   【今日统计】2026-09-09（北京时间，截至 21:22:05）
 *   派兵 12 次｜完成 9 趟｜失败 1 轮｜熔断 0 次｜告警 2 条｜暂停 15分
 *   木材 6 次 ≈ 756万　金币 3 次 ≈ 210万　铁矿石 3 次 ≈ 180万　魔水 0 次
 *   ── 实例 0「主号」：派兵 12 次 ≈ 1146万，暂停 15分
 *   资源统计快照 1 张（最近 00:03:10）
 *   （预计采集量 = Σ 派兵时卡片储量，按「自动采集至清空」估算）
 */
export function renderDailyStatsText(s: DailyStats, opts: { now?: number; formatClock: (at: number) => string }): string {
  const now = opts.now ?? Date.now();
  const isToday = cstDateKey(now) === s.dateKey;
  const totalPaused = Object.values(s.byInstance).reduce((acc, i) => acc + livePausedMs(i, now), 0);
  const completed = RESOURCE_TYPES.reduce((acc, t) => acc + s.byResource[t].completed, 0);
  const unknown = RESOURCE_TYPES.reduce((acc, t) => acc + s.byResource[t].unknownStorageDispatches, 0);

  const lines: string[] = [
    `【${isToday ? '今日' : '当日'}统计】${s.dateKey}（北京时间${isToday ? `，截至 ${opts.formatClock(now)}` : ''}）`,
    `派兵 ${s.dispatches} 次｜完成 ${completed} 趟｜失败 ${s.failures} 轮｜熔断 ${s.circuitBreaks} 次｜告警 ${s.alerts} 条｜暂停 ${formatPausedDuration(totalPaused)}`,
    RESOURCE_TYPES.map((t) => {
      const r = s.byResource[t];
      return r.dispatches > 0 ? `${RESOURCE_NAME[t]} ${r.dispatches} 次 ≈ ${formatCnAmount(r.estimatedAmount)}` : `${RESOURCE_NAME[t]} 0 次`;
    }).join('　'),
  ];
  const instances = Object.values(s.byInstance).sort((a, b) => a.instanceIndex - b.instanceIndex || Number(a.replaced) - Number(b.replaced));
  for (const i of instances) {
    const amount = RESOURCE_TYPES.reduce((acc, t) => acc + i.byResource[t].estimatedAmount, 0);
    const paused = livePausedMs(i, now);
    lines.push(
      `── ${instanceLabel(i)}：派兵 ${i.dispatches} 次 ≈ ${formatCnAmount(amount)}` +
      `${i.failures > 0 ? `，失败 ${i.failures} 轮` : ''}` +
      `${paused > 0 ? `，暂停 ${formatPausedDuration(paused)}` : ''}` +
      `${i.pausedSince != null ? '（暂停中）' : ''}`,
    );
  }
  if (s.snapshots.length > 0) {
    const last = s.snapshots[s.snapshots.length - 1]!;
    lines.push(`资源统计快照 ${s.snapshots.length} 张（最近 ${opts.formatClock(last.at)}）`);
  }
  if (unknown > 0) lines.push(`⚠️ 有 ${unknown} 趟储量没读出来，预计采集量偏低。`);
  lines.push('（预计采集量 = Σ 派兵时卡片储量，按「自动采集至清空」估算）');
  return lines.join('\n');
}
