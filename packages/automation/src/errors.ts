/**
 * Coded errors shared by the vision engine, the template library and the game modules.
 *
 * The host transports `code` across the IPC boundary (the envelope keeps it), so the UI can branch on it:
 * for example `TEMPLATE_LOW_VARIANCE` renders the 「换一块有图标或文字的区域」 guidance instead of a toast.
 * `detail` stays in the process that threw it; user-facing numbers must also appear in `message`.
 */

/** Codes used by the vision / template layer (a subset of the original panel's error codes, plus TEMPLATE_EXISTS). */
export const VISION_ERROR_CODES = [
  'INVALID_ARGUMENT',
  'NOT_FOUND',
  'IO_ERROR',
  'CAPTURE_BAD_FRAME',
  'TEMPLATE_LOW_VARIANCE',
  'TEMPLATE_TOO_LARGE',
  'TEMPLATE_NOT_FOUND',
  'TEMPLATE_DECODE_FAILED',
  'TEMPLATE_EXISTS',
  'CV_INIT_FAILED',
] as const;

export type VisionErrorCode = (typeof VISION_ERROR_CODES)[number];

/**
 * Plain-data form for worker and IPC boundaries (structured clone drops custom error fields).
 * `__wlError` is the original panel's marker: only a value carrying it is a serialized AppError whose `code` is kept by
 * `AppError.from`. It is optional in the type so hand-built results (`{ code, message }`) stay valid.
 */
export interface SerializedError {
  readonly __wlError?: true;
  code: string;
  message: string;
  detail?: Record<string, unknown>;
}

export class AppError extends Error {
  constructor(readonly code: string, message: string, readonly detail?: Record<string, unknown>) {
    super(message);
    this.name = 'AppError';
  }

  /**
   * Keeps the code of an AppError or a serialized one (`__wlError` marker); anything else — a plain Error, a Node
   * system error (ENOENT, EPIPE, …) or a core AvdmError (LOCK_TIMEOUT, …) — is wrapped with `fallback`, as in the
   * original panel, so failure classification sees STEP_FAILED / ADB_COMMAND_FAILED instead of OS codes.
   */
  static from(error: unknown, fallback = 'UNKNOWN'): AppError {
    if (error instanceof AppError) return error;
    if (isSerializedError(error)) return new AppError(error.code, error.message, error.detail);
    if (error instanceof Error) return new AppError(fallback, error.message, { name: error.name });
    return new AppError(fallback, String(error));
  }
}

/** A serialized AppError: carries the explicit `__wlError` marker (duck-typed `{ code, message }` does not count). */
export function isSerializedError(value: unknown): value is SerializedError {
  return typeof value === 'object' && value !== null
    && (value as { __wlError?: unknown }).__wlError === true
    && typeof (value as { code?: unknown }).code === 'string'
    && typeof (value as { message?: unknown }).message === 'string';
}

/** Any thrown value → plain data for a worker / IPC boundary; uncoded values get `fallback` (original semantics). */
export function serializeError(error: unknown, fallback = 'UNKNOWN'): SerializedError {
  const app = AppError.from(error, fallback);
  return app.detail
    ? { __wlError: true, code: app.code, message: app.message, detail: app.detail }
    : { __wlError: true, code: app.code, message: app.message };
}

/** The code of any thrown value, if it carries one (for display / diagnostics only, never for classification). */
export function errorCodeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}
