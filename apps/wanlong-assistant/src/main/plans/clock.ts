import { cstDayStart, inClockWindow, parseClock as parseCstClock } from '../../shared/time';

/**
 * Store-side clock checks. The trigger maths (`nextFireAt`, `previousFireAt`, `dueReason`, `describeTrigger`) has
 * exactly one implementation, in `src/shared/time.ts` / `src/shared/plan.ts`, used by main and the renderer alike.
 */

/**
 * Strict `HH:MM` for stored plans. Delegates to the shared Beijing clock (`src/shared/time.ts`), which also
 * tolerates surrounding spaces like the original; plans keep rejecting them so stored times stay canonical
 * (the page and the loader trim before saving).
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
 * the whole day), an invalid window never matches here; stored windows are validated on save, so the two agree.
 */
export function inWindow(at: number, window: { from: string; to: string }): boolean {
  if (parseClock(window.from) === null || parseClock(window.to) === null) return false;
  return inClockWindow(at, window);
}
