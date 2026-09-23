import { AvdmError } from '../errors.js';

/**
 * Parse an instance selector against the set of existing indices.
 *   "all" | "*"        → every existing index
 *   "3"                → [3]
 *   "0,2,5"            → [0, 2, 5]
 *   "1-4"              → [1, 2, 3, 4] (only those that exist)
 *   "0,3-5,9"          → mixed
 * Explicitly listed single indices that do not exist raise INSTANCE_NOT_FOUND;
 * ranges silently skip gaps. Result is sorted and de-duplicated.
 */
export function parseSelector(selector: string | number | number[], existing: number[]): number[] {
  const have = new Set(existing);
  if (Array.isArray(selector)) return finalize(selector, have, true);
  if (typeof selector === 'number') return finalize([selector], have, true);

  const s = selector.trim();
  if (s === '' ) throw new AvdmError('INVALID_ARGUMENT', '实例选择器为空');
  if (s === 'all' || s === '*') return [...have].sort((a, b) => a - b);

  const picked: number[] = [];
  for (const part of s.split(',').map((p) => p.trim()).filter(Boolean)) {
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(part);
    if (range) {
      const a = Number(range[1]);
      const b = Number(range[2]);
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      for (let i = lo; i <= hi; i++) if (have.has(i)) picked.push(i);
      continue;
    }
    if (!/^\d+$/.test(part)) throw new AvdmError('INVALID_ARGUMENT', `无法解析实例选择器: "${part}"`);
    const n = Number(part);
    if (!have.has(n)) throw new AvdmError('INSTANCE_NOT_FOUND', `实例 ${n} 不存在`);
    picked.push(n);
  }
  return finalize(picked, have, false);
}

function finalize(list: number[], have: Set<number>, strict: boolean): number[] {
  if (strict) {
    for (const n of list) {
      if (!have.has(n)) throw new AvdmError('INSTANCE_NOT_FOUND', `实例 ${n} 不存在`);
    }
  }
  return [...new Set(list)].sort((a, b) => a - b);
}
