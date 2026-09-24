/**
 * Error codes the assistant creates and the UI may branch on (original `ERROR_CODES`, only the ones produced today).
 * A failed assistant call keeps its code across IPC (`WanlongError.code`, `errorCodeOf(e)` in the renderer); the
 * message stays user-facing Chinese. Core `AvdmError` codes (e.g. `LOCK_TIMEOUT`, `ADMISSION_DENIED`) pass through
 * unchanged. A module that starts throwing a new code (`RUN_ABORTED`, `GAME_UPDATE_REQUIRED`, `AI_RISK_BLOCKED` …)
 * appends it here and types its error's `code` with `WanlongErrorCode`.
 */
export const WANLONG_ERROR_CODES = [
  /** The instance is used by another activity (occupancy table or device lease); the message names it. */
  'CONCURRENCY_LIMIT',
  /** Queued device work was discarded (instance stopped, assistant quitting). */
  'CANCELLED',
] as const;

export type WanlongErrorCode = (typeof WANLONG_ERROR_CODES)[number];

const RETRY_LATER_CODES: readonly WanlongErrorCode[] = ['CONCURRENCY_LIMIT', 'CANCELLED'];

/**
 * True for a refusal that only means 「try again later」: the instance is busy with another activity, or queued
 * device work was dropped. The UI shows these as a warning instead of an error.
 */
export function isRetryLaterCode(code: unknown): boolean {
  return RETRY_LATER_CODES.includes(code as WanlongErrorCode);
}
