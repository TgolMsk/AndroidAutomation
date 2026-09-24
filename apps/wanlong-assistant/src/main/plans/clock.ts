import { cstDayStart, inClockWindow, parseClock as parseCstClock } from '../../shared/time';
import type { TaskTrigger } from './types';

const DAY = 86_400_000;

/**
 * Strict `HH:MM` for stored plans. Delegates to the shared Beijing clock (`src/shared/time.ts`), which also
 * tolerates surrounding spaces like the original; plans keep rejecting them so stored times stay canonical.
 */
export function parseClock(value: string): number | null {
  return value === value.trim() ? parseCstClock(value) : null;
}

/** Beijing midnight of the day containing `at`. */
export function beijingDayStart(at: number): number {
  return cstDayStart(at);
}

/**
 * Whether `at` is inside the Beijing window. Unlike the original `inClockWindow` (an invalid window counts as
 * the whole day), an invalid window never matches here; the plans port decides which semantics to keep.
 */
export function inWindow(at: number, window: { from: string; to: string }): boolean {
  if (parseClock(window.from) === null || parseClock(window.to) === null) return false;
  return inClockWindow(at, window);
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
