import { isAvdmError } from '@avdm/core';

/** Message of any thrown value (AvdmError messages are already user-facing Chinese). */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name || String(err);
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export function errorCode(err: unknown): string | undefined {
  if (isAvdmError(err)) return err.code;
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Plain Uint8Array for IPC. Node Buffers are often views into a larger pooled ArrayBuffer and the
 * structured-clone serializer would copy the whole backing store, so slice-copy those.
 */
export function toU8(buf: Uint8Array): Uint8Array {
  if (buf.byteOffset === 0 && buf.byteLength === buf.buffer.byteLength) {
    return new Uint8Array(buf.buffer, 0, buf.byteLength);
  }
  return new Uint8Array(buf);
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Width/height from a PNG IHDR chunk (0x0 if the data is not a PNG). */
export function pngSize(png: Uint8Array): { width: number; height: number } {
  if (png.length < 24 || PNG_SIGNATURE.some((b, i) => png[i] !== b)) return { width: 0, height: 0 };
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/**
 * Height matching `width` at the device aspect ratio. Screenshot requests pass both dimensions: the
 * emulator (37.1.11, verified) ignores a width-only request and fits the frame inside width × height.
 * Rounded up so `width` stays the binding side, like core's fitScreenshotBox.
 */
export function heightFor(width: number, device: { width: number; height: number }): number {
  if (!(device.width > 0) || !(device.height > 0)) return 0;
  return Math.max(1, Math.ceil((width * device.height) / device.width));
}

export function isInstanceIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 64;
}

/** Validate an index list coming from a renderer; de-duplicated, order kept. */
export function asIndices(value: unknown): number[] {
  if (!Array.isArray(value)) throw new Error('参数错误：实例编号列表无效');
  const out: number[] = [];
  for (const v of value) {
    if (!isInstanceIndex(v)) throw new Error(`参数错误：无效的实例编号 ${String(v)}`);
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

export function asIndex(value: unknown): number {
  if (!isInstanceIndex(value)) throw new Error(`参数错误：无效的实例编号 ${String(value)}`);
  return value;
}

export function asStrings(value: unknown, what = '参数'): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) throw new Error(`参数错误：${what}需为字符串列表`);
  return value as string[];
}

/** undefined, or a plain object whose values are all strings (renderer input). */
export function asOptionalStringRecord(value: unknown, what = '参数'): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value) || Object.values(value).some((v) => typeof v !== 'string')) {
    throw new Error(`参数错误：${what}需为字符串映射`);
  }
  return Object.fromEntries(Object.entries(value as Record<string, string>));
}

/** Resolve with `p`, or with `fallback` after `ms`. */
export function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

/** File-name friendly timestamp yyyyMMdd-HHmmss (local time). */
export function fileStamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Strip characters that are awkward in file names. */
export function safeFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim();
  return cleaned.slice(0, 60) || 'instance';
}
