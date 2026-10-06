/**
 * 采集的派兵名额判定（G2 的纯计算部分）：还能派几支、还欠哪几种资源。
 *
 * ★ 唯一一份：采集一轮（flow.ts）真正派兵时用它，技能层的预判（skills/gather.ts）也用它。
 *   两边按同一套规则算，预判与实际的差异只可能来自「两次读面板读到的东西不同」。
 * 纯函数，不碰设备。
 */

import type { GatherConfig, GatherResourceType, ResourceEntry } from '../config.js'

/** 名额计算只看一支在外队伍的这三件事（MarchRecord 天然满足）。 */
export interface QuotaMarch {
  /** 目标坐标；读不出为 null。 */
  coord: string | null
  /** 是否本引擎派的（目标坐标出现在派兵记账里）。 */
  ownDispatch: boolean
  /** 本引擎派的队伍去采什么（只有派兵时记了账才知道）。 */
  resource?: GatherResourceType
}

/** 本轮刚派出的一支（DispatchRecord 天然满足）。 */
export interface QuotaDispatch {
  coord: string | null
  resource: GatherResourceType
}

/**
 * 可用队列数 = 队列上限 − 已用 − 预留，并受「自动采集最多占几个队列」约束。
 *
 * ★ 「哪些队伍是本引擎派的」只能靠**目标坐标**与派兵记账对上号，而坐标是识别出来的、可能读不出。
 *   读不出时一律**当成是自己的**（见 countOwnGathering），方向是「少派」而不是「多派」。
 */
export function freeSlots(
  queue: { queueUsed: number; queueTotal: number },
  cfg: GatherConfig,
  inFlight: readonly QuotaMarch[]
): number {
  const byQueue = queue.queueTotal - queue.queueUsed - cfg.queuePlan.reserveQueues
  const ownGathering = countOwnGathering(inFlight)
  const byPlan = cfg.queuePlan.maxConcurrentGather - ownGathering
  return Math.max(0, Math.min(byQueue, byPlan))
}

/**
 * 本引擎派出去、还在外面的采集队数量。
 *
 * ★★ 真机实测教训（2026-09-09）：**坐标读不出的行必须算进来**。
 *    ownDispatch 的判据是「该行的目标坐标出现在 travelTimeByCoord 里」，
 *    而部队管理面板行内的坐标识别本来就容易失手（字形集曾缺 0/4，且为了不接受假坐标
 *    已经把接受阈值抬到 0.90，读不出的概率更高）。
 *    如果把「读不出坐标」当成「不是我派的」，自己刚派出去的那支队就不算数，
 *    引擎会以为配额还空着，于是接着再派一支 —— 一轮下来把队列全占满。
 *    所以这里按「未知 = 假定是自己的」处理：方向是少派，不是多派。
 */
export function countOwnGathering(inFlight: readonly QuotaMarch[]): number {
  return inFlight.filter((r) => r.ownDispatch || r.coord === null).length
}

/**
 * 还欠队列的资源：按 priority 升序，所有没派满 queues 的（第一个就是 G2 要派的那个）。
 *
 * ★★ 真机实测教训（2026-09-09）：**本轮自己刚派出去的队必须无条件计入配额**。
 *    在外队伍的记账是「面板行 -> 目标坐标 -> resourceByCoord」推出来的，
 *    整条链路系在「行内坐标能读对」上；一旦坐标读不出（字形集曾缺 0/4，
 *    且为了不接受假坐标已把阈值抬到 0.90），刚派出去的队就查不到资源类型，
 *    每种资源的 used 都还是 0，引擎会立刻再派一支 —— 实测一轮之内连派两支伐木场。
 *    dispatched 是本轮的**事实**，不依赖任何识别，拿它兜底最可靠。
 *    坐标已经在面板行里认出来的那些不能重复计数，用 counted 去重。
 */
export function wantedResources(
  cfg: GatherConfig,
  inFlight: readonly QuotaMarch[],
  dispatched: readonly QuotaDispatch[]
): ResourceEntry[] {
  const candidates = cfg.resources
    .filter((r) => r.enabled && r.queues > 0)
    .sort((a, b) => a.priority - b.priority)

  const used = new Map<string, number>()
  const counted = new Set<string>()
  for (const r of inFlight) {
    if (!r.resource) continue
    used.set(r.resource, (used.get(r.resource) ?? 0) + 1)
    if (r.coord) counted.add(r.coord)
  }
  for (const d of dispatched) {
    if (d.coord && counted.has(d.coord)) continue
    used.set(d.resource, (used.get(d.resource) ?? 0) + 1)
  }

  return candidates.filter((c) => (used.get(c.type) ?? 0) < c.queues)
}

/**
 * G2：挑一个「还欠队列」的资源。按 priority 升序，第一个没派满 queues 的就是它。
 * @returns 所有资源的配额都满足时返回 null
 */
export function pickResource(
  cfg: GatherConfig,
  inFlight: readonly QuotaMarch[],
  dispatched: readonly QuotaDispatch[]
): ResourceEntry | null {
  return wantedResources(cfg, inFlight, dispatched)[0] ?? null
}
