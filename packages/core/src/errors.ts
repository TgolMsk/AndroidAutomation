export type AvdmErrorCode =
  | 'SDK_MISSING'
  | 'EMULATOR_MISSING'
  | 'ADB_MISSING'
  | 'IMAGE_MISSING'
  | 'LICENSE_NOT_ACCEPTED'
  | 'DOWNLOAD_FAILED'
  | 'CHECKSUM_MISMATCH'
  | 'INSTANCE_NOT_FOUND'
  | 'INSTANCE_RUNNING'
  | 'INSTANCE_NOT_RUNNING'
  | 'NO_FREE_INDEX'
  | 'ADMISSION_DENIED'
  | 'BOOT_TIMEOUT'
  | 'STOP_TIMEOUT'
  | 'SCRIPT_NOT_FOUND'
  | 'INVALID_ARGUMENT'
  | 'COMMAND_FAILED'
  | 'LOCK_TIMEOUT'
  | 'UNSUPPORTED';

export class AvdmError extends Error {
  readonly code: AvdmErrorCode;
  readonly details?: unknown;

  constructor(code: AvdmErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AvdmError';
    this.code = code;
    this.details = details;
  }
}

export function isAvdmError(err: unknown, code?: AvdmErrorCode): err is AvdmError {
  return err instanceof AvdmError && (code === undefined || err.code === code);
}
