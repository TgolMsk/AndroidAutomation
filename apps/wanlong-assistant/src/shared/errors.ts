/**
 * Error codes the assistant UI branches on (original `ERROR_CODES`, the subset that still exists). A failed
 * assistant call keeps its code across IPC (`WanlongError.code`, `errorCodeOf(e)` in the renderer); messages stay
 * user-facing Chinese. Core `AvdmError` codes (e.g. `LOCK_TIMEOUT`, `ADMISSION_DENIED`) pass through unchanged.
 */
export const WANLONG_ERROR_CODES = [
  /** The instance is used by another activity (occupancy table or device lease); the message names it. */
  'CONCURRENCY_LIMIT',
  /** Queued device work was discarded (instance stopped, assistant quitting). */
  'CANCELLED',
  /** A run was stopped by the user or by shutdown; not a failure. */
  'RUN_ABORTED',
  'DEVICE_NOT_READY',
  'TEMPLATE_LOW_VARIANCE',
  'AI_RISK_BLOCKED',
  'GAME_UPDATE_REQUIRED',
  'INVALID_ARGUMENT',
  'NOT_FOUND',
  'IO_ERROR',
] as const;

export type WanlongErrorCode = (typeof WANLONG_ERROR_CODES)[number];

export function isWanlongErrorCode(value: unknown): value is WanlongErrorCode {
  return typeof value === 'string' && (WANLONG_ERROR_CODES as readonly string[]).includes(value);
}
