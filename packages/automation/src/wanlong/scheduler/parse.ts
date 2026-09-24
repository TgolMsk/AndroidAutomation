/**
 * 调度器读数的解析器与整串格式（原版 src/main/scheduler/digits.ts 的解析器部分）。
 * 纯函数、单位是毫秒，与采集流程里以秒为单位的 gather/parse.ts 分开 —— 两边的调用方不同，别混用。
 */

/** "00:01:04" / "01:04" -> 毫秒。格式不对返回 null（分、秒都必须 ≤ 59）。 */
export function parseClockMs(text: string | null): number | null {
  if (!text) return null
  const parts = text.split(':')
  if (parts.length < 2 || parts.length > 3) return null
  if (parts.some((p) => !/^\d+$/.test(p))) return null
  const nums = parts.map((p) => Number(p))
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null
  const [a, b, c] = nums.length === 3 ? (nums as [number, number, number]) : [0, nums[0]!, nums[1]!]
  if (b > 59 || c > 59) return null
  return ((a * 3600 + b * 60 + c) * 1000) | 0
}

/** "1,260,000" -> 1260000。格式不对返回 null。 */
export function parseAmount(text: string | null): number | null {
  if (!text) return null
  const cleaned = text.replace(/,/g, '')
  if (!/^\d+$/.test(cleaned)) return null
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : null
}

/** "4/5" -> { used: 4, total: 5 }。格式不对返回 null；上限必须 > 0。 */
export function parseFraction(text: string | null): { used: number; total: number } | null {
  if (!text) return null
  const m = /^(\d{1,3})\/(\d{1,3})$/.exec(text)
  if (!m) return null
  const used = Number(m[1])
  const total = Number(m[2])
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return null
  return { used, total }
}

/** "615,535" -> "615,535"（只做格式校验，坐标本身就当字符串用）。 */
export function parseCoord(text: string | null): string | null {
  if (!text) return null
  return /^\d{1,4},\d{1,4}$/.test(text) ? text : null
}

export const CLOCK_PATTERN = /^\d{1,2}:\d{2}(:\d{2})?$/
export const FRACTION_PATTERN = /^\d{1,3}\/\d{1,3}$/
export const AMOUNT_PATTERN = /^\d{1,3}(,\d{3})*$|^\d+$/
export const COORD_PATTERN = /^\d{1,4},\d{1,4}$/
