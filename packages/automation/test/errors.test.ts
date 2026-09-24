import { describe, expect, it } from 'vitest';
import { AppError, errorCodeOf, isSerializedError, serializeError } from '../src/errors.js';

/** The original panel's semantics (src/shared/errors.ts): only real AppErrors keep their own code. */
describe('AppError.from / serializeError', () => {
  it('keeps the code of an AppError and of a serialized one (explicit marker), round-tripping through plain data', () => {
    const original = new AppError('TEMPLATE_LOW_VARIANCE', '模板「x」方差过低 std=3.0 < 12', { std: 3 });
    expect(AppError.from(original, 'STEP_FAILED')).toBe(original);
    const plain = JSON.parse(JSON.stringify(serializeError(original))) as unknown;
    expect(isSerializedError(plain)).toBe(true);
    expect(AppError.from(plain, 'STEP_FAILED')).toMatchObject({ code: 'TEMPLATE_LOW_VARIANCE', detail: { std: 3 } });
  });

  it('wraps Node system errors, core errors and duck-typed objects with the fallback code', () => {
    const enoent = Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
    const lock = Object.assign(new Error('lock timeout'), { name: 'AvdmError', code: 'LOCK_TIMEOUT' });
    expect(AppError.from(enoent, 'ADB_COMMAND_FAILED').code).toBe('ADB_COMMAND_FAILED');
    expect(AppError.from(lock, 'STEP_FAILED')).toMatchObject({ code: 'STEP_FAILED', message: 'lock timeout', detail: { name: 'AvdmError' } });
    expect(isSerializedError({ code: 'EPIPE', message: 'broken pipe' })).toBe(false);
    expect(AppError.from({ code: 'EPIPE', message: 'broken pipe' }, 'STEP_FAILED').code).toBe('STEP_FAILED');
    expect(AppError.from('boom').code).toBe('UNKNOWN');
  });

  it('serializes uncoded values with the fallback and still exposes codes for display', () => {
    expect(serializeError(new Error('x'))).toMatchObject({ __wlError: true, code: 'UNKNOWN', message: 'x' });
    expect(serializeError(Object.assign(new Error('y'), { code: 'ETIMEDOUT' }), 'ADB_COMMAND_FAILED').code).toBe('ADB_COMMAND_FAILED');
    expect(errorCodeOf(Object.assign(new Error('z'), { code: 'ENOENT' }))).toBe('ENOENT');
  });
});
