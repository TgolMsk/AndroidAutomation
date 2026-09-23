/**
 * 等级记忆与搜索下限的**纯决策**：每种资源各自记「滑杆上限」和「从哪个下限起才搜得到点」，
 * 并决定一次找点过程里「搜不到 / 点不合适」之后下限怎么走。
 *
 * 为什么要有它（2026-09-18 真机故障，魔水池永远派不出去）：
 *   魔水池的滑杆能推到 10，但附近最高只有 8 级。原来的实现有三个问题叠在一起：
 *   ① 把滑杆上限当成「附近真有的最高等级」：下限 = 10 − 1 = 9，附近根本没有 ≥ 9 的点；
 *   ② 四种资源共用一个上限缓存（12 小时）：魔水探到 10，伐木场 / 金矿 / 铁矿也被带到下限 9；
 *   ③ 「搜不出卡片」被当成「这个点不合适」，在同一下限上重试 4 次，每次白等 8 秒、截约 9 张图，
 *      60 张的截图熔断先到 → 放弃 → 10 分钟冷却 → 下一轮又从 9 开始，没有记忆。
 *
 * 三条修正（本文件只做决策，不碰 IO，flow.ts 按返回值执行）：
 *   1. 搜不出卡片 = 这个下限附近没有点，**立刻放宽一档**，不重试（onNoCard）；
 *      「点不合适」（被占 / 储量不够 / 坐标重复）照旧在同一下限重试 occupiedRetryLimit 次再放宽（onUnsuitable）。
 *   2. 记住「下限 F 搜不到」（noResultFloor），下一轮直接从 F−1 起步（planStartFloor）。
 *      记忆只在「更低的下限搜到了卡片」或「本次找点放弃」时写入（learnFromSearch），一次搜索按钮没点上
 *      这类一次性故障不会留下记忆；记忆与上限探测同寿命（probeIntervalMin），探测值一变立即作废。
 *      ★ 记忆只会把起步下限往低压，而游戏返回的是「不低于下限的最高级点」，
 *        所以就算记错了，代价也只是多花一次搜索，不会采到更差的点。
 *   3. 上限按资源分别记（levelMemoryOf）。
 *
 * 纯函数 + 传入时钟，离线自检 `npm run check:level`。
 */

import {
  canRelaxFloor,
  computeSearchFloor,
  type GatherResourceType,
  type LevelPolicy,
  type SearchRetry
} from '../config.js'
import type { GatherRuntimeState, LevelMemoryMap, ResourceLevelMemory } from './types.js'

export const GATHER_RESOURCE_TYPES: readonly GatherResourceType[] = ['wood', 'gold', 'iron', 'mana']

// ── 记忆条目 ──────────────────────────────────────────────────────────────

export function emptyLevelMemory(): ResourceLevelMemory {
  return { maxLevel: null, probedAt: null, noResultFloor: null, noResultAt: null }
}

/** 取某资源的记忆条目；没有就建一个空的挂到 state 上，之后的改动直接落在 state 里。 */
export function levelMemoryOf(
  state: GatherRuntimeState,
  type: GatherResourceType
): ResourceLevelMemory {
  let mem = state.levelByResource[type]
  if (!mem) {
    mem = emptyLevelMemory()
    state.levelByResource[type] = mem
  }
  return mem
}

/** 上限缓存是否该重新探测（没探过、或超过 probeIntervalMin）。 */
export function isMaxLevelStale(
  mem: ResourceLevelMemory,
  now: number,
  probeIntervalMin: number
): boolean {
  if (mem.maxLevel === null || mem.probedAt === null) return true
  return now - mem.probedAt > Math.max(0, probeIntervalMin) * 60_000
}

export interface RecordMaxLevelResult {
  previous: number | null
  changed: boolean
  /** 上限变了、被顺手作废的「搜不到」记忆；没有作废为 null。 */
  forgotNoResult: number | null
}

/** 记下探测结果。上限变了说明附近的等级格局变了，「搜不到」的记忆一并作废。 */
export function recordMaxLevel(
  mem: ResourceLevelMemory,
  maxLevel: number,
  now: number
): RecordMaxLevelResult {
  const previous = mem.maxLevel
  const changed = previous !== maxLevel
  let forgotNoResult: number | null = null
  if (changed && mem.noResultFloor !== null) {
    forgotNoResult = mem.noResultFloor
    forgetNoResult(mem)
  }
  mem.maxLevel = maxLevel
  mem.probedAt = now
  return { previous, changed, forgotNoResult }
}

/** 本轮用的上限：没探测过就用策略里假定的值。 */
export function effectiveMaxLevel(mem: ResourceLevelMemory, policy: LevelPolicy): number {
  if (mem.maxLevel !== null) return mem.maxLevel
  return policy.mode === 'relative' ? policy.assumedMaxLevel : policy.maxLevelHardCap
}

/** 「搜不到」的记忆是否还在有效期内。 */
export function hasFreshNoResult(
  mem: ResourceLevelMemory,
  now: number,
  probeIntervalMin: number
): boolean {
  if (mem.noResultFloor === null || mem.noResultAt === null) return false
  return now - mem.noResultAt <= Math.max(0, probeIntervalMin) * 60_000
}

/** 过期的记忆清掉。返回被清掉的下限（便于打日志），没有过期返回 null。 */
export function expireNoResult(
  mem: ResourceLevelMemory,
  now: number,
  probeIntervalMin: number
): number | null {
  if (mem.noResultFloor === null) return null
  if (hasFreshNoResult(mem, now, probeIntervalMin)) return null
  const floor = mem.noResultFloor
  forgetNoResult(mem)
  return floor
}

export function forgetNoResult(mem: ResourceLevelMemory): void {
  mem.noResultFloor = null
  mem.noResultAt = null
}

// ── 起步下限 ──────────────────────────────────────────────────────────────

export interface StartFloorPlan {
  /** 本轮的起步下限。 */
  floor: number
  /** 是否因为「搜不到」的记忆而比策略算出的更低。 */
  fromMemory: boolean
  /** 策略本身算出的下限（上限 + 偏移 / 固定值）。 */
  policyFloor: number
}

/**
 * 算本轮的起步下限：策略下限与「记忆下限 − 1」取更低者（都不低于 minLevel）。
 * 策略不允许放宽（absolute + allowRelax=false）时不看记忆 —— 用户要的就是固定值。
 */
export function planStartFloor(
  policy: LevelPolicy,
  mem: ResourceLevelMemory,
  maxLevel: number,
  now: number,
  probeIntervalMin: number
): StartFloorPlan {
  const policyFloor = computeSearchFloor(policy, maxLevel)
  if (
    !canRelaxFloor(policy) ||
    mem.noResultFloor === null ||
    !hasFreshNoResult(mem, now, probeIntervalMin)
  ) {
    return { floor: policyFloor, fromMemory: false, policyFloor }
  }
  const remembered = Math.max(policy.minLevel, mem.noResultFloor - 1)
  if (remembered >= policyFloor) return { floor: policyFloor, fromMemory: false, policyFloor }
  return { floor: remembered, fromMemory: true, policyFloor }
}

/**
 * 放宽下限（搜不到可用点时）。
 * ★ 语义是「放宽下限以匹配更多候选点」，**不是**「退而求其次采低级点」——放宽后游戏仍然优先返回高等级的点。
 * @returns 新的下限；已经放宽到底（或策略不允许放宽）时返回 null
 */
export function relaxFloor(policy: LevelPolicy, current: number, step: number): number | null {
  if (!canRelaxFloor(policy)) return null
  const next = current - Math.max(1, step)
  if (next < policy.minLevel) return null
  return next
}

// ── 一次找点过程里的下限状态机 ────────────────────────────────────────────

export interface FloorSearch {
  /** 当前搜索下限。 */
  floor: number
  /** 同一下限上「点不合适」的连续次数（搜不到卡片不计入）。 */
  unsuitableFails: number
  /**
   * 本次找点里观察到「搜不到卡片」的最低下限（只记第一张卡片出现之前的）。
   * 下限在一次找点里只会往下走，所以最近一次搜不到的就是最低的。
   */
  lowestEmptyFloor: number | null
  /**
   * 本次找点是否已经见过卡片。见过之后再遇到「搜不到」只放宽、不记忆 ——
   * 更高的下限都搜到了点，更低的下限反而搜不到，只能是一次性故障（搜索没点上、面板被盖住）。
   */
  cardSeen: boolean
}

export function startFloorSearch(floor: number): FloorSearch {
  return { floor, unsuitableFails: 0, lowestEmptyFloor: null, cardSeen: false }
}

export type FloorStep =
  /** 同一下限再搜一次。 */
  | { kind: 'retry'; state: FloorSearch; reason: string }
  /** 下限已放宽，按新下限再搜。 */
  | { kind: 'relaxed'; state: FloorSearch; from: number; to: number; reason: string }
  /** 放不动了，本次找点放弃。 */
  | { kind: 'giveUp'; state: FloorSearch; reason: string }

function cannotRelaxText(policy: LevelPolicy): string {
  return (
    `不能再低于 minLevel=${policy.minLevel}` +
    (policy.mode === 'absolute' && !policy.allowRelax ? '，且配置不允许放宽' : '')
  )
}

/**
 * 搜索后**没出现卡片**：这个下限附近没有点，立刻放宽，不重试。
 * ★ 与 onUnsuitable 分开计数是本次修正的核心：以前把它当成「点不合适」在同一下限上白等 4 次。
 */
export function onNoCard(st: FloorSearch, policy: LevelPolicy, retry: SearchRetry): FloorStep {
  const next: FloorSearch = { ...st }
  if (!st.cardSeen) next.lowestEmptyFloor = st.floor
  const to = relaxFloor(policy, st.floor, retry.floorRelaxStep)
  if (to === null) {
    return {
      kind: 'giveUp',
      state: next,
      reason: `搜索下限 ${st.floor} 附近搜不到点，且搜索下限不能再放宽（${cannotRelaxText(policy)}）`
    }
  }
  next.floor = to
  next.unsuitableFails = 0
  return {
    kind: 'relaxed',
    state: next,
    from: st.floor,
    to,
    reason: `搜不出卡片说明附近没有 ≥ ${st.floor} 级的点，把搜索下限直接放宽到 ${to}（不重试）`
  }
}

/**
 * 卡片出现了但**这个点不合适**（被占 / 储量不够 / 坐标重复 / 派兵页失败）：
 * 同一下限重搜 occupiedRetryLimit 次（游戏每次会跳到下一个点），用完才放宽。
 */
export function onUnsuitable(st: FloorSearch, policy: LevelPolicy, retry: SearchRetry): FloorStep {
  const limit = Math.max(1, retry.occupiedRetryLimit)
  const fails = st.unsuitableFails + 1
  if (fails < limit) {
    return {
      kind: 'retry',
      state: { ...st, unsuitableFails: fails },
      reason: `同一下限 ${st.floor} 第 ${fails}/${limit} 次没找到可用点，重搜换一个点`
    }
  }
  const to = relaxFloor(policy, st.floor, retry.floorRelaxStep)
  if (to === null) {
    return {
      kind: 'giveUp',
      state: { ...st, unsuitableFails: fails },
      reason: `连续 ${fails} 次都没找到可用的点，且搜索下限已经放宽到 ${st.floor}（${cannotRelaxText(policy)}）`
    }
  }
  return {
    kind: 'relaxed',
    state: { ...st, floor: to, unsuitableFails: 0 },
    from: st.floor,
    to,
    reason:
      `同一下限连续 ${fails} 次没找到可用点，把搜索下限从 ${st.floor} 放宽到 ${to}` +
      '（放宽下限只是让更多点进入候选，仍可能采到高等级的点）'
  }
}

/** 卡片出现了：记下「见过卡片」，此前的「搜不到」观察已由 learnFromSearch 写进记忆，这里清掉。 */
export function onCard(st: FloorSearch): FloorSearch {
  return { ...st, cardSeen: true, lowestEmptyFloor: null }
}

export interface LearnResult {
  /** 写进记忆的「搜不到」下限；没有可写为 null。 */
  committed: number | null
  /** 因为「在这个下限搜到了点」而作废的旧记忆；没有为 null。 */
  forgot: number | null
}

/**
 * 把本次找点的观察写进记忆。两个时机：第一张卡片出现时（cardAt = 出卡片的下限）、找点放弃时（不传 cardAt）。
 *   · 此前观察到过「搜不到」→ 记下最低的那个下限；已有更低的新鲜记忆就保留更低者
 *   · 在 cardAt 搜到了卡片、而记忆却说 cardAt 及以下搜不到 → 记忆已过时，作废
 */
export function learnFromSearch(
  mem: ResourceLevelMemory,
  st: FloorSearch,
  now: number,
  probeIntervalMin: number,
  cardAt?: number
): LearnResult {
  const out: LearnResult = { committed: null, forgot: null }
  if (cardAt !== undefined && mem.noResultFloor !== null && cardAt >= mem.noResultFloor) {
    out.forgot = mem.noResultFloor
    forgetNoResult(mem)
  }
  if (st.lowestEmptyFloor !== null) {
    let floor = st.lowestEmptyFloor
    if (
      mem.noResultFloor !== null &&
      hasFreshNoResult(mem, now, probeIntervalMin) &&
      mem.noResultFloor < floor
    ) {
      floor = mem.noResultFloor
    }
    mem.noResultFloor = floor
    mem.noResultAt = now
    out.committed = floor
  }
  return out
}

// ── 落盘容错 ──────────────────────────────────────────────────────────────

function intOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v > 0 ? v : null
}

function timeOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null
}

/**
 * 把磁盘上读到的（可能是旧版本 / 手改坏了的）记忆收成合法值。
 * 旧版本共用的 `maxLevel` / `maxLevelProbedAt` 不在这里迁移 —— 它对四种资源一视同仁，正是要修掉的东西，丢弃后下一轮重新探测即可。
 */
export function sanitizeLevelMemory(raw: unknown): LevelMemoryMap {
  const out: LevelMemoryMap = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  const map = raw as Record<string, unknown>
  for (const type of GATHER_RESOURCE_TYPES) {
    const item = map[type]
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const o = item as Record<string, unknown>
    const mem: ResourceLevelMemory = {
      maxLevel: intOrNull(o.maxLevel),
      probedAt: timeOrNull(o.probedAt),
      noResultFloor: intOrNull(o.noResultFloor),
      noResultAt: timeOrNull(o.noResultAt)
    }
    // 半截数据（有值没时刻、有时刻没值）一律当没有。
    if (mem.maxLevel === null || mem.probedAt === null) {
      mem.maxLevel = null
      mem.probedAt = null
    }
    if (mem.noResultFloor === null || mem.noResultAt === null) forgetNoResult(mem)
    if (mem.maxLevel === null && mem.noResultFloor === null) continue
    out[type] = mem
  }
  return out
}

/** 深拷贝（cloneState 用；state 会被本轮就地修改，绝不能和上一轮共享对象）。 */
export function cloneLevelMemory(map: LevelMemoryMap): LevelMemoryMap {
  const out: LevelMemoryMap = {}
  for (const type of GATHER_RESOURCE_TYPES) {
    const mem = map[type]
    if (mem) out[type] = { ...mem }
  }
  return out
}
