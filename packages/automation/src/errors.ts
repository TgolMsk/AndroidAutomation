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

/** Plain-data form for worker and IPC boundaries (structured clone drops custom error fields). */
export interface SerializedError {
  code: string;
  message: string;
  detail?: Record<string, unknown>;
}

export class AppError extends Error {
  constructor(readonly code: string, message: string, readonly detail?: Record<string, unknown>) {
    super(message);
    this.name = 'AppError';
  }

  /** Keeps an existing code (also from serialized or duck-typed errors); otherwise wraps with `fallback`. */
  static from(error: unknown, fallback = 'UNKNOWN'): AppError {
    if (error instanceof AppError) return error;
    if (isSerializedError(error)) return new AppError(error.code, error.message, error.detail);
    if (error instanceof Error) return new AppError(fallback, error.message, { name: error.name });
    return new AppError(fallback, String(error));
  }
}

/** Any object with a string `code` and `message` (an `AppError`, a serialized one, or a coded Node error). */
export function isSerializedError(value: unknown): value is SerializedError {
  if (!value || typeof value !== 'object') return false;
  const { code, message } = value as { code?: unknown; message?: unknown };
  return typeof code === 'string' && typeof message === 'string';
}

export function serializeError(error: unknown): SerializedError {
  if (error instanceof AppError) {
    return error.detail ? { code: error.code, message: error.message, detail: error.detail } : { code: error.code, message: error.message };
  }
  if (isSerializedError(error)) return { code: error.code, message: error.message };
  return { code: 'UNKNOWN', message: error instanceof Error ? error.message : String(error) };
}

/** The code of any thrown value, if it carries one. */
export function errorCodeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}
