/**
 * Beijing time (UTC+8) — the single implementation shared by the main process and the renderer.
 *
 * The game runs on Beijing time (daily reset, fatigue window 0:00–9:00, plan clocks), while the host time zone
 * can be anything (the original panel's host was America/Los_Angeles). Every function here shifts by a fixed
 * UTC+8 offset and reads UTC fields, so results never depend on the host zone. Never use `toLocaleString()`,
 * `getHours()` or `getDate()` for game time. Pure functions only: no Node, Electron or DOM dependencies.
 *
 * Ported from wanlong-panel `src/shared/alerts.ts` (formatCst*), `src/shared/stats.ts` (date keys),
 * `src/shared/plan.ts` (clock helpers and triggers) and `src/main/scheduler/state.ts` (nextCstBoundary).
 */

export const CST_OFFSET_MS = 8 * 3_600_000;
export const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

const pad2 = (n: number): string => String(n).padStart(2, '0');

// ── Formatting ──────────────────────────────────────────────────────────────

/** Absolute time → Beijing `YYYY-MM-DD HH:MM:SS` (or `YYYY-MM-DD HH:MM`); non-finite input → `--`. */
export function formatCst(at: number, withSeconds = true): string {
  if (!Number.isFinite(at)) return '--';
  const d = new Date(at + CST_OFFSET_MS);
  const ymd = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  const hm = `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
  return withSeconds ? `${ymd} ${hm}:${pad2(d.getUTCSeconds())}` : `${ymd} ${hm}`;
}

/** Beijing `HH:MM:SS` only, for tight spaces; non-finite input → `--:--:--`. */
export function formatCstClock(at: number): string {
  if (!Number.isFinite(at)) return '--:--:--';
  const d = new Date(at + CST_OFFSET_MS);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

/** Beijing `MM-DD HH:MM`, the compact form used in lists; non-finite input → `--`. */
export function formatCstShort(at: number): string {
  if (!Number.isFinite(at)) return '--';
  const d = new Date(at + CST_OFFSET_MS);
  return `${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

// ── Beijing date keys ───────────────────────────────────────────────────────

/** A Beijing calendar date `YYYY-MM-DD`. */
export type DateKey = string;

const DATE_KEY_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** Shape check only (like the original): `2026-02-30` passes and later normalizes to March. */
export function isDateKey(value: unknown): value is DateKey {
  return typeof value === 'string' && DATE_KEY_RE.test(value);
}

/**
 * Absolute time → Beijing date key.
 *   cstDateKey(Date.UTC(2026, 8, 9, 15, 59)) === '2026-09-09'   // Beijing 23:59
 *   cstDateKey(Date.UTC(2026, 8, 9, 16, 0))  === '2026-09-10'   // Beijing 00:00 the next day
 * Non-finite input returns '0000-00-00', which callers treat as "no date".
 */
export function cstDateKey(at: number): DateKey {
  if (!Number.isFinite(at)) return '0000-00-00';
  const d = new Date(at + CST_OFFSET_MS);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** Beijing midnight (absolute ms) of the day containing `at`. */
export function cstDayStart(at: number): number {
  return Math.floor((at + CST_OFFSET_MS) / DAY_MS) * DAY_MS - CST_OFFSET_MS;
}

/** The next Beijing midnight after `at` (equals `nextCstBoundary(at, 0)`). */
export function cstNextDayStart(at: number): number {
  return cstDayStart(at) + DAY_MS;
}

/** Date key → Beijing midnight of that day (absolute ms); an invalid key returns NaN. */
export function dateKeyToDayStart(key: DateKey): number {
  if (!isDateKey(key)) return Number.NaN;
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d) - CST_OFFSET_MS;
}

/** Add `n` days (may be negative) to a date key. */
export function shiftDateKey(key: DateKey, n: number): DateKey {
  return cstDateKey(dateKeyToDayStart(key) + n * DAY_MS);
}

/** Every date key in [from, to], both ends included; empty when from > to. At most 366 days. */
export function dateKeyRange(fromKey: DateKey, toKey: DateKey): DateKey[] {
  const a = dateKeyToDayStart(fromKey);
  const b = dateKeyToDayStart(toKey);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a > b) return [];
  const out: DateKey[] = [];
  for (let t = a; t <= b && out.length < 366; t += DAY_MS) out.push(cstDateKey(t));
  return out;
}

// ── Clock of day ────────────────────────────────────────────────────────────

/** A Beijing time-of-day window. `from > to` wraps midnight (e.g. 22:00 → 06:00). */
export interface ClockWindow {
  from: string;
  to: string;
}

const CLOCK_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** `'HH:MM'` → offset from midnight in ms; invalid input returns null. Surrounding spaces are ignored. */
export function parseClock(hhmm: string): number | null {
  const match = CLOCK_RE.exec(hhmm.trim());
  if (!match) return null;
  return Number(match[1]) * HOUR_MS + Number(match[2]) * MINUTE_MS;
}

/** Offset from midnight → `'HH:MM'` (wraps into one day). */
export function formatClock(offsetMs: number): string {
  const v = ((offsetMs % DAY_MS) + DAY_MS) % DAY_MS;
  return `${pad2(Math.floor(v / HOUR_MS))}:${pad2(Math.floor((v % HOUR_MS) / MINUTE_MS))}`;
}

/** Offset of `at` within its Beijing day (0 … 86 399 999). */
export function cstOffsetOfDay(at: number): number {
  return (((at + CST_OFFSET_MS) % DAY_MS) + DAY_MS) % DAY_MS;
}

/** Beijing hour of day (0–23) of `at`. */
export function cstHourOf(at: number): number {
  return Math.floor(cstOffsetOfDay(at) / HOUR_MS);
}

/** Beijing midnight of the day containing `at`; same value as `cstDayStart`. */
export function cstDayStartOf(at: number): number {
  return at - cstOffsetOfDay(at);
}

/**
 * Whether `at` falls in the Beijing window, both ends included. An invalid window, or `from === to`, counts
 * as the whole day (original semantics; callers that must reject invalid windows validate them first).
 */
export function inClockWindow(at: number, window: ClockWindow): boolean {
  const from = parseClock(window.from);
  const to = parseClock(window.to);
  if (from === null || to === null || from === to) return true;
  const now = cstOffsetOfDay(at);
  return from < to ? now >= from && now <= to : now >= from || now <= to;
}

/** The first window start at or after `at`; an invalid window returns `at`. */
export function nextWindowStart(at: number, window: ClockWindow): number {
  const from = parseClock(window.from);
  if (from === null) return at;
  const today = cstDayStartOf(at) + from;
  return today >= at ? today : today + DAY_MS;
}

/**
 * The next time strictly after `now` at which the Beijing clock reads `hourCst:00`. One implementation: the ETA
 * scheduler's fatigue planning (`@avdm/automation/wanlong/pure`) owns it and this module re-exports it.
 */
export { nextCstBoundary } from '@avdm/automation/wanlong/pure';

// ── Clock triggers ──────────────────────────────────────────────────────────

/**
 * When something runs, in Beijing time: `manual` never fires by itself; `daily` fires at each `HH:MM`;
 * `interval` fires every `everyMinutes`, optionally only inside `window`. Structurally identical to the plans'
 * `TaskTrigger`.
 */
export type ClockTrigger =
  | { kind: 'manual' }
  | { kind: 'daily'; at: string[] }
  | { kind: 'interval'; everyMinutes: number; window?: ClockWindow };

function dailyOffsets(at: readonly string[]): number[] {
  return at.map(parseClock).filter((v): v is number => v !== null).sort((a, b) => a - b);
}

/**
 * The next absolute time to run; null for manual or unusable triggers.
 *
 * daily: the earliest listed time later than `now`, else tomorrow's earliest.
 * interval: `lastRunAt + every` (never earlier than `now`; a trigger that never ran fires at `now`), pushed to the
 * next window start when it falls outside `window`.
 */
export function nextFireAt(trigger: ClockTrigger, now: number, lastRunAt: number | null): number | null {
  if (trigger.kind === 'manual') return null;
  if (trigger.kind === 'daily') {
    const offsets = dailyOffsets(trigger.at);
    if (offsets.length === 0) return null;
    const dayStart = cstDayStartOf(now);
    for (const offset of offsets) {
      const due = dayStart + offset;
      if (due > now) return due;
    }
    return dayStart + DAY_MS + offsets[0]!;
  }
  const every = Math.max(1, Math.round(trigger.everyMinutes)) * MINUTE_MS;
  let due = lastRunAt === null ? now : lastRunAt + every;
  if (due < now) due = now;
  if (trigger.window && !inClockWindow(due, trigger.window)) due = nextWindowStart(due, trigger.window);
  return due;
}

/**
 * The latest daily time that has already passed (today's, else yesterday's last); null for other triggers.
 * Used for catch-up decisions together with `lastRunAt` and a catch-up window.
 */
export function previousFireAt(trigger: ClockTrigger, now: number): number | null {
  if (trigger.kind !== 'daily') return null;
  const offsets = dailyOffsets(trigger.at);
  if (offsets.length === 0) return null;
  const dayStart = cstDayStartOf(now);
  let best: number | null = null;
  for (const offset of offsets) {
    const at = dayStart + offset;
    if (at <= now && (best === null || at > best)) best = at;
  }
  return best ?? dayStart - DAY_MS + offsets[offsets.length - 1]!;
}
