import { cstDateKey, dateKeyToDayStart, isDateKey, type DateKey } from '../../shared/time';

export type StatsErrorCode = 'INVALID_ARGUMENT' | 'STEP_FAILED' | 'IO_ERROR';

/** A statistics error with a stable code (forwarded to the renderer by the IPC envelope); the message is Chinese. */
export class StatsError extends Error {
  constructor(readonly code: StatsErrorCode, message: string) {
    super(message);
    this.name = 'StatsError';
  }
}

/** A real Beijing calendar date `YYYY-MM-DD` (the shape check alone would let `2026-02-30` through). */
export function isRealDateKey(value: unknown): value is DateKey {
  return isDateKey(value) && cstDateKey(dateKeyToDayStart(value)) === value;
}

/** The original's wording for a bad date argument. */
export function assertDateKey(value: unknown): DateKey {
  if (!isRealDateKey(value)) throw new StatsError('INVALID_ARGUMENT', `日期格式应为 YYYY-MM-DD，收到：${String(value)}`);
  return value;
}
