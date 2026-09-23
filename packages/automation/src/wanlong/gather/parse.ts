/** 采集流程里几个字段的宽松解析。严格版在 ../vision/digits.ts。 */

import { parseHms } from '../vision/digits.js'

/**
 * 倒计时解析。主形态是 `HH:MM:SS`；部队管理面板在剩余时间不足一小时时**有可能**只显示 `MM:SS`，
 * 所以这里额外兼容两段式。两段式与三段式都读不出就返回 null（绝不猜值）。
 */
export function parseHmsFlexible(text: string): number | null {
  const strict = parseHms(text)
  if (strict !== null) return strict
  const m = /^(\d{1,2}):(\d{2})$/.exec(text)
  if (!m) return null
  const mm = Number(m[1])
  const ss = Number(m[2])
  if (ss > 59) return null
  return mm * 60 + ss
}
