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

  static from(error: unknown, fallback = 'UNKNOWN'): AppError {
    if (error instanceof AppError) return error;
    if (error instanceof Error) return new AppError(fallback, error.message, { name: error.name });
    return new AppError(fallback, String(error));
  }
}

export function serializeError(error: unknown): SerializedError {
  if (error instanceof AppError) return { code: error.code, message: error.message, detail: error.detail };
  return { code: 'UNKNOWN', message: error instanceof Error ? error.message : String(error) };
}
