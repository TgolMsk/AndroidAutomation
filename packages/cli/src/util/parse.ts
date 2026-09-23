import { AvdmError, parseSelector } from '@avdm/core';
import { InvalidArgumentError } from 'commander';

/**
 * Argument parsers for commander options / arguments. They throw commander's InvalidArgumentError
 * (rendered as "错误: 选项 … 的值 … 无效。<reason>") so bad input is reported before the manager opens.
 */

function toInt(value: string): number | undefined {
  const v = value.trim();
  if (!/^[+-]?\d+$/.test(v)) return undefined;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : undefined;
}

export function intInRange(min: number, max: number): (value: string) => number {
  return (value: string) => {
    const n = toInt(value);
    if (n === undefined || n < min || n > max) {
      throw new InvalidArgumentError(`需为 ${min}..${max} 的整数。`);
    }
    return n;
  };
}

export const positiveInt = (value: string): number => {
  const n = toInt(value);
  if (n === undefined || n < 1) throw new InvalidArgumentError('需为正整数。');
  return n;
};

export const nonNegativeInt = (value: string): number => {
  const n = toInt(value);
  if (n === undefined || n < 0) throw new InvalidArgumentError('需为非负整数。');
  return n;
};

/** Screen coordinate (non-negative integer, decimals are rounded). */
export const coordinate = (value: string): number => {
  const n = Number(value.trim());
  if (!Number.isFinite(n) || n < 0 || value.trim() === '') throw new InvalidArgumentError('坐标需为非负数。');
  return Math.round(n);
};

/** "3072", "3072m", "3G", "3.5g" → MB */
export const megabytes = (value: string): number => {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(m|mb|g|gb)?\s*$/i.exec(value);
  if (!m) throw new InvalidArgumentError('需为内存大小，例如 3072、4G。');
  const num = Number(m[1]);
  const unit = (m[2] ?? 'm').toLowerCase();
  const mb = unit.startsWith('g') ? num * 1024 : num;
  if (!Number.isInteger(mb) || mb <= 0) throw new InvalidArgumentError('需为整数 MB，例如 3072、4G。');
  return mb;
};

/** "16", "16G", "16gb" → GB */
export const gigabytes = (value: string): number => {
  const m = /^\s*(\d+)\s*(g|gb)?\s*$/i.exec(value);
  if (!m) throw new InvalidArgumentError('需为整数 GB，例如 16、16G。');
  const n = Number(m[1]);
  if (n <= 0) throw new InvalidArgumentError('需为正整数 GB。');
  return n;
};

/** "1280x720" (also "1280X720", "1280*720") → { width, height } */
export const resolution = (value: string): { width: number; height: number } => {
  const m = /^\s*(\d+)\s*[xX*×]\s*(\d+)\s*$/.exec(value);
  if (!m) throw new InvalidArgumentError('需为 宽x高，例如 1280x720。');
  return { width: Number(m[1]), height: Number(m[2]) };
};

/** Seconds (positive number, decimals allowed) → milliseconds. */
export const secondsToMs = (value: string): number => {
  const n = Number(value.trim());
  if (!Number.isFinite(n) || n <= 0) throw new InvalidArgumentError('需为正数（秒）。');
  return Math.round(n * 1000);
};

/** Seconds (non-negative number, decimals allowed; 0 = no limit) → milliseconds. */
export const nonNegativeSecondsToMs = (value: string): number => {
  const n = Number(value.trim());
  if (!Number.isFinite(n) || n < 0 || value.trim() === '') throw new InvalidArgumentError('需为非负数（秒，0 表示不限时）。');
  return Math.round(n * 1000);
};

export const GPU_MODES = ['host', 'software', 'auto'] as const;
export const GL_DRIVERS = ['angle', 'translator'] as const;

/** Resolve a selector that must name exactly one existing instance (e.g. `logs <index>`). */
export function parseSingleIndex(sel: string, existing: number[]): number {
  const s = sel.trim();
  if (!/^\d+$/.test(s)) {
    throw new AvdmError('INVALID_ARGUMENT', `此命令只接受单个实例编号（收到 "${sel}"）`);
  }
  const picked = parseSelector(s, existing);
  const first = picked[0];
  if (first === undefined) throw new AvdmError('INSTANCE_NOT_FOUND', `实例 ${s} 不存在`);
  return first;
}

/**
 * `settings set` value: JSON when it parses (numbers, booleans, arrays, objects, quoted strings),
 * otherwise the raw string.
 */
export function parseSettingValue(raw: string): unknown {
  const t = raw.trim();
  if (t === '') return raw;
  try {
    return JSON.parse(t);
  } catch {
    return raw;
  }
}
