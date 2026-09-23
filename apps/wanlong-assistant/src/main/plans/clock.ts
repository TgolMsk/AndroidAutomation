import type { TaskTrigger } from './types';

const DAY = 86_400_000;
const CST = 8 * 3_600_000;
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parseClock(value: string): number | null {
  const match = CLOCK.exec(value);
  return match ? Number(match[1]) * 3_600_000 + Number(match[2]) * 60_000 : null;
}

export function beijingDayStart(at: number): number {
  return Math.floor((at + CST) / DAY) * DAY - CST;
}

export function inWindow(at: number, window: { from: string; to: string }): boolean {
  const from = parseClock(window.from);
  const to = parseClock(window.to);
  if (from === null || to === null) return false;
  if (from === to) return true;
  const offset = at - beijingDayStart(at);
  return from < to ? offset >= from && offset <= to : offset >= from || offset <= to;
}

/** Most recent trigger no later than now, with an explicit Beijing clock. */
export function dueAt(trigger: TaskTrigger, now: number, lastClaimedAt: number | null, createdAt: number): number | null {
  if (trigger.kind === 'manual') return null;
  if (trigger.kind === 'daily') {
    const offsets = trigger.at.map(parseClock).filter((v): v is number => v !== null).sort((a, b) => a - b);
    if (!offsets.length) return null;
    const day = beijingDayStart(now);
    const today = offsets.filter((v) => day + v <= now);
    const at = today.length ? day + today[today.length - 1]! : day - DAY + offsets[offsets.length - 1]!;
    return lastClaimedAt !== null && lastClaimedAt >= at ? null : at;
  }
  const baseline = lastClaimedAt ?? createdAt;
  const at = baseline + trigger.everyMinutes * 60_000;
  if (at > now) return null;
  if (trigger.window && !inWindow(now, trigger.window)) return null;
  return at;
}
