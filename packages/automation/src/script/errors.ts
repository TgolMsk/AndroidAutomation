/** Errors raised while executing a script. Messages are Chinese and reach the user verbatim. */

export type ScriptErrorCode =
  | 'STEP_FAILED'
  | 'TIMEOUT'
  | 'SCRIPT_INVALID'
  | 'TEMPLATE_NOT_FOUND'
  | 'CANCELLED'
  | 'AI_RISK_BLOCKED'
  | 'INVALID_ARGUMENT'
  | 'DEVICE'
  | 'UNKNOWN';

export class ScriptError extends Error {
  constructor(readonly code: ScriptErrorCode, message: string, readonly detail?: Record<string, unknown>) {
    super(message);
    this.name = 'ScriptError';
  }

  /** Keeps a ScriptError as is; wraps anything else with `fallback` as its code. */
  static from(error: unknown, fallback: ScriptErrorCode = 'UNKNOWN'): ScriptError {
    if (error instanceof ScriptError) return error;
    const message = error instanceof Error ? error.message : String(error);
    return new ScriptError(fallback, message || '未知错误');
  }
}

/**
 * An execution precondition that retries, onFail rules and the AI advisor must never bypass: the instance was
 * replaced, the account binding changed, the game left the foreground before an input, or the run's time limit.
 */
export class ExecutionGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutionGuardError';
  }
}

export function isExecutionGuardError(error: unknown): error is ExecutionGuardError {
  return error instanceof ExecutionGuardError || (error instanceof Error && error.name === 'ExecutionGuardError');
}
