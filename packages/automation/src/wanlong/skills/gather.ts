/**
 * 第一个技能：自动采集。执行就是现有的 G0~G16 采集一轮（主进程里 run 直接调它），这里只放纯的部分：
 *   - checkGather：只看状态快照，判断「现在值不值得跑一轮」；
 *   - gatherSkillOutcome：把采集一轮的结果归到技能的三种结果。
 *
 * ★ check 是**预判**，采集流程才是**裁判**：流程会重读部队面板再按 quota.ts 算名额。两边用的是同一份规则，
 *   所以预判只会在「两次读面板读到的东西不同」或「没读到运行期记账」时和实际不一致；
 *   没有记账时快照的结论本来就偏宽（见 GameStateGather.bookkeeping），方向是宁可白跑一轮，不可漏派。
 * ★ 判定顺序与 flow.ts 一致：未启用 → 冷却 → 熔断 → 空位 → 配额。
 */

import { blockedVerdict, readyVerdict, type SkillOutcome, type SkillSpec, type SkillVerdict } from '../../skills.js'
import { RESOURCE_LABEL } from '../config.js'
import type { GatherOutcome } from '../gather/types.js'
import { formatDuration } from '../scheduler/model.js'
import type { WanlongGameState } from './state.js'

export const GATHER_SKILL_ID = 'gather'

export function checkGather(state: WanlongGameState, now: number): SkillVerdict {
  const g = state.gather
  if (!g.enabled) return blockedVerdict('自动采集未启用')
  if (state.pausedReason) return blockedVerdict(`实例已暂停：${state.pausedReason}`)
  if (g.cooldownUntil !== null && g.cooldownUntil > now) {
    return blockedVerdict(
      `上一轮搜不到可用资源点，冷却中（还剩 ${formatDuration(g.cooldownUntil - now)}）`,
      g.cooldownUntil
    )
  }
  if (g.circuitUntil !== null && g.circuitUntil > now) {
    return blockedVerdict(
      `最近一小时已派兵 ${g.dispatchesLastHour ?? '?'} 次，达到熔断上限 ${g.maxDispatchesPerHour} 次`,
      g.circuitUntil
    )
  }
  const { used, total, nextFreeAt } = state.queue
  if (g.freeSlots === null) return blockedVerdict('行军队列占用没读出来')
  if (g.freeSlots <= 0) {
    return blockedVerdict(
      `没有可派的队列（已用 ${used}/${total}，预留 ${g.reserveQueues}，自动采集在外 ${g.ownOut}/${g.maxConcurrent}）`,
      nextFreeAt
    )
  }
  if (g.wanted.length === 0) return blockedVerdict('每种资源的队列配额都已满足', nextFreeAt)
  const wanted = g.wanted.map((type) => RESOURCE_LABEL[type].resource).join('、')
  return readyVerdict(`可派 ${g.freeSlots} 支，还欠：${wanted}`)
}

export const gatherSkill: SkillSpec<WanlongGameState> = {
  id: GATHER_SKILL_ID,
  title: '自动采集',
  summary:
    'Send idle march queues to gather wood, gold, iron or mana from resource nodes on the world map, ' +
    'following the configured per-resource quotas and priorities. Worth doing when a march queue is free ' +
    'and some resource still wants marches.',
  check: checkGather
}

/** 采集一轮正常结束时归到技能结果（error / cancelled 由调用方抛错，不走这里）。 */
export function gatherSkillOutcome(
  outcome: Exclude<GatherOutcome, 'error' | 'cancelled'>,
  dispatched: number
): SkillOutcome {
  if (outcome === 'circuitBroken') return 'deferred'
  return dispatched > 0 ? 'done' : 'idle'
}
