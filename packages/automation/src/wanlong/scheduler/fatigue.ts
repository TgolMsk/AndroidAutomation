/**
 * 深夜疲惫期的倒计时换算 + 北京时间边界。移植自原版 src/main/scheduler/fatigue.ts 与 state.ts 的边界函数。
 *
 * 游戏机制（用户 2026-09-09 给出）：
 *   北京时间 00:00–09:00 为「深夜疲惫」，**资源采集速度 -80%**（= 正常速度的 20%，即耗时 5 倍）。
 *   ★ 对宝石矿无效。
 *
 * 为什么需要换算：
 *   游戏显示的倒计时是**按当前速度**算出来的剩余时间，它不会预判速度变化。
 *   所以疲劳期内派出的队伍会显示一个很长的小时数，9 点一到速度恢复，倒计时骤然缩短；
 *   反过来，白天派出、会跨过午夜的队伍，实际完成时间要比显示的晚得多。
 *
 * 只靠「到边界再重读一次」也能纠正，但那是**事后**纠正：在边界到来之前，
 * 面板显示的剩余时间和调度排的 freeAt 都是错的（最长可错好几个小时）。
 * 有了确切倍率就可以**当场**算准，边界重采样退化成一道校验兜底。
 *
 * 换算模型：把「显示剩余时间」看成当前速度下的耗时，沿时间轴分段推进，
 * 每跨过一个速度边界就按速度比换算一次剩余耗时：
 *   · 从疲劳期跨出（速度 ×5）⇒ 剩余耗时 ÷5
 *   · 从正常期跨入（速度 ÷5）⇒ 剩余耗时 ×5
 * 一趟采集可能连续跨越多个边界（例如 22:00 派出、跨午夜、再跨 9 点），所以用循环。
 *
 * ★ 北京时间只有一份实现：应用的 src/shared/time.ts 的 nextCstBoundary 转调这里。
 *   必须显式按 UTC+8 计算，不能用本机时区：实测开发机是 America/Los_Angeles，
 *   直接用本地小时数会把边界算偏 15 小时。
 */

const CST_OFFSET_MS = 8 * 3_600_000
const DAY_MS = 86_400_000

/** 疲劳期的两个边界：0 点进入、9 点结束（北京时间）。 */
export const FATIGUE_BOUNDARY_HOURS_CST: readonly number[] = [0, 9]

/** 疲劳期采集速度为正常的 1/FATIGUE_SLOWDOWN。-80% ⇒ 20% ⇒ 5 倍耗时。 */
export const FATIGUE_SLOWDOWN = 5

/** 疲劳期**不影响**的资源类型（游戏机制：宝石矿不受影响）。 */
export const FATIGUE_EXEMPT_RESOURCES: ReadonlySet<string> = new Set(['gem'])

/** 下一次跨过「北京时间 hourCst 点」的绝对时刻（严格晚于 now）。 */
export function nextCstBoundary(now: number, hourCst: number): number {
  const cstNow = now + CST_OFFSET_MS
  const dayStart = Math.floor(cstNow / DAY_MS) * DAY_MS
  let due = dayStart + hourCst * 3_600_000
  if (due <= cstNow) due += DAY_MS
  return due - CST_OFFSET_MS
}

/** 给定时刻是否处于疲劳期（北京时间 0:00–9:00）。 */
export function isFatigueWindow(at: number): boolean {
  const hour = Math.floor((((at + CST_OFFSET_MS) % DAY_MS) + DAY_MS) % DAY_MS / 3_600_000)
  return hour < 9
}

export interface FatigueAdjustOptions {
  /** 减速倍率，默认 5（-80%）。游戏改版时只改这里。 */
  slowdown?: number
  /** 该资源是否豁免（宝石矿）。豁免则原样返回。 */
  exempt?: boolean
}

/**
 * 把「采样时刻 + 游戏显示的剩余毫秒」换算成**真实完成时刻**（绝对 epoch 毫秒）。
 *
 * @param sampledAt   读到这个倒计时的时刻
 * @param remainingMs 游戏显示的剩余毫秒（按采样那一刻的速度计）
 */
export function fatigueAdjustedDoneAt(
  sampledAt: number,
  remainingMs: number,
  opts: FatigueAdjustOptions = {}
): number {
  const slowdown = opts.slowdown ?? FATIGUE_SLOWDOWN
  if (opts.exempt || !(remainingMs > 0) || !(slowdown > 0)) return sampledAt + Math.max(0, remainingMs)

  let t = sampledAt
  let rem = remainingMs
  // 一趟采集最长也就几十小时，边界每天两个，64 次循环足够；留 guard 防死循环。
  for (let i = 0; i < 64; i++) {
    const inFatigue = isFatigueWindow(t)
    // 当前处于疲劳期就看下一个 9 点，否则看下一个 0 点。
    const boundary = nextCstBoundary(t, inFatigue ? 9 : 0)
    const untilBoundary = boundary - t
    if (rem <= untilBoundary) return t + rem
    rem -= untilBoundary
    t = boundary
    // 跨出疲劳期 ⇒ 速度变快 ⇒ 剩余耗时变短；跨入疲劳期 ⇒ 反之。
    rem = inFatigue ? rem / slowdown : rem * slowdown
  }
  return t + rem
}

/** 该资源类型是否豁免疲劳减速。 */
export function isFatigueExempt(resourceType: string | null | undefined): boolean {
  return resourceType != null && FATIGUE_EXEMPT_RESOURCES.has(resourceType)
}
