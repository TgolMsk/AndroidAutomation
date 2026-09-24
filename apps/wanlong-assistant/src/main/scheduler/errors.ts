/** Error codes the scheduler, the vision worker and their hooks agree on. Messages are user-facing Chinese. */
export type SchedulerErrorCode =
  | 'CONCURRENCY_LIMIT'
  | 'RUN_ABORTED'
  | 'CANCELLED'
  | 'GAME_UPDATE_REQUIRED'
  | 'AI_RISK_BLOCKED'
  | 'INVALID_ARGUMENT'
  | 'NOT_FOUND'
  | 'TIMEOUT'
  | 'TEMPLATE_NOT_FOUND'
  | 'STEP_FAILED'
  | 'PROBE_REJECTED'
  | 'DEVICE_NOT_READY'
  | 'UNKNOWN';

/** An Error with a stable code; the IPC envelope forwards `code` to the renderer. */
export class SchedulerError extends Error {
  constructor(readonly code: SchedulerErrorCode | string, message: string, readonly detail?: Record<string, unknown>) {
    super(message);
    this.name = 'SchedulerError';
  }
}

export function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'UNKNOWN';
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Codes that mean "the automatic work was stopped on purpose", never a device or cycle failure. */
export function isAbortCode(code: string): boolean {
  return code === 'RUN_ABORTED' || code === 'CANCELLED';
}

/** A human must look (game update prompt, AI judged a confirm risky): not a failure, the instance is paused. */
export function isAttentionCode(code: string): boolean {
  return code === 'GAME_UPDATE_REQUIRED' || code === 'AI_RISK_BLOCKED';
}

/** The abort reason as a coded error (a plain reason becomes RUN_ABORTED so hooks can tell it apart). */
export function abortError(signal: AbortSignal | undefined, fallback = '自动调度已停止。'): SchedulerError {
  const reason = signal?.reason;
  if (reason instanceof SchedulerError && isAbortCode(reason.code)) return reason;
  return new SchedulerError('RUN_ABORTED', reason instanceof Error && reason.message ? reason.message : fallback);
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError(signal);
}

/** Sleep that stays unref'd (never pins the process) and wakes early on abort. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError(signal)); return; }
    const timer = setTimeout(done, Math.max(0, ms));
    timer.unref?.();
    function done(): void { signal?.removeEventListener('abort', onAbort); resolve(); }
    function onAbort(): void { clearTimeout(timer); reject(abortError(signal)); }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
