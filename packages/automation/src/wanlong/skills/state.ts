/**
 * 万龙觉醒的「游戏状态快照」：一个实例（一个号）此刻已知的事实，加上算好的结论。技能的 check 与决策层只看它。
 *
 * ★ 设计纪律（为以后接决策模型定的）：
 *   - 字段名用英文、结构扁平：以后原样序列化给决策模型（Jev 这类模型英文精度最高）；
 *   - 时间一律绝对毫秒；「还能派几支」「还欠哪种资源」「冷却 / 熔断到没到」这类算数和比较在这里算好，
 *     而且用的是采集流程自己的那份规则（gather/quota.ts）—— 决策模型不擅长算数和比时间，也不该另算一套；
 *   - 读不出就是 null（不知道），绝不填猜测值（与调度器队列状态同一条纪律）。
 * ★ 纯模块：只由已有状态拼出来（调度器的队列读数 + 采集配置 + 采集运行期记账），不碰设备、不读盘。
 *
 * 以后加技能时往这里加它需要的事实（资源库存、建筑队列、联盟帮助……），每样都写清来源和「不知道」时的取值。
 */

import type { GatherConfig, GatherResourceType } from '../config.js'
import { countOwnGathering, freeSlots, wantedResources, type QuotaMarch } from '../gather/quota.js'
import type { GatherRuntimeState } from '../gather/types.js'
import {
  earliestFreeAt,
  type InstanceQueueState,
  type MarchResourceType,
  type MarchStatus
} from '../scheduler/model.js'

const HOUR_MS = 3_600_000

export interface WanlongGameState {
  instanceIndex: number
  accountId: string | null
  /** 快照时刻（毫秒）。 */
  at: number
  /** 告警模块暂停这个实例的原因（顶号、维护、需要人看……）；没暂停为 null。 */
  pausedReason: string | null
  queue: GameStateQueue
  gather: GameStateGather
}

/** 行军队列：ETA 调度器最近一次读部队管理面板的结果。 */
export interface GameStateQueue {
  /** 已用 / 上限（面板右上角 N/M）；读不出为 null。 */
  used: number | null
  total: number | null
  /** 最近一次成功读面板的时刻；0 = 从没读过。 */
  sampledAt: number
  /** 在外的队伍（不含空行）。 */
  marches: GameStateMarch[]
  /** 最早释放一个队列的时刻；不知道为 null。 */
  nextFreeAt: number | null
}

export interface GameStateMarch {
  status: MarchStatus
  /** 目标坐标；读不出为 null。 */
  coord: string | null
  /** 在采什么（面板缩略图或派兵记账，手动派的队也算）；认不出为 null。 */
  resource: MarchResourceType | null
  /** 本引擎派的（坐标对上了派兵记账）。 */
  own: boolean
  /** 队列真正释放的时刻；不知道为 null。 */
  freeAt: number | null
}

/** 自动采集：配置、运行期记账，以及按采集流程同一份规则算好的结论。 */
export interface GameStateGather {
  enabled: boolean
  /** 留给其它功能块的队列数。 */
  reserveQueues: number
  /** 自动采集最多同时占几个队列。 */
  maxConcurrent: number
  /** 自动采集在外的队数（坐标读不出的也算自己的，方向是少派）。 */
  ownOut: number
  /** ★ 结论：现在还能派几支（队列空位 − 预留，且受并发上限约束）；队列占用读不出为 null。 */
  freeSlots: number | null
  /** ★ 结论：还欠队列的资源，按优先级（第一个就是下一支要派的）。 */
  wanted: GatherResourceType[]
  /** 「搜不到可用点」冷却到何时；不在冷却（或已过期）为 null。 */
  cooldownUntil: number | null
  /** 近一小时派兵次数；没有运行期记账时为 null（不知道）。 */
  dispatchesLastHour: number | null
  /** 每小时派兵上限，0 = 不限。 */
  maxDispatchesPerHour: number
  /** 熔断解除时刻；没熔断（或不知道）为 null。 */
  circuitUntil: number | null
  /**
   * 读到运行期记账了吗。false 时分不清哪些队是本引擎派的：空位按「坐标读不出的才算自己的」、
   * 配额按「一支都没派」算，结论偏宽 —— 宁可白跑一轮，不可漏派。
   */
  bookkeeping: boolean
}

export interface GameStateInput {
  /** ETA 调度器的队列状态（到点唤醒时刚读过面板）。 */
  queue: InstanceQueueState
  /** 归一化后的采集配置（绑定了账号的用账号那份）。 */
  config: GatherConfig
  /** 采集运行期状态（派兵记账、冷却、派兵时刻）；读不到为 null，相应结论按「不知道」处理。 */
  runtime: GatherRuntimeState | null
  pausedReason?: string | null
  now: number
}

export function buildGameState(input: GameStateInput): WanlongGameState {
  const { queue, config, runtime, now } = input
  const occupied = queue.marches.filter((m) => m.status !== 'idle')

  // 与 gather/eta.ts 的 buildRecord 同一判据：坐标在 travelTimeByCoord 里 = 本引擎派的，resourceByCoord 给出它采什么。
  const quota: QuotaMarch[] = occupied.map((m) => {
    const coord = m.targetCoord
    return {
      coord,
      ownDispatch: Boolean(runtime && coord && runtime.travelTimeByCoord[coord] !== undefined),
      resource: runtime && coord ? runtime.resourceByCoord[coord] : undefined
    }
  })
  const marches: GameStateMarch[] = occupied.map((m, i) => ({
    status: m.status,
    coord: m.targetCoord,
    resource: m.resourceType ?? null,
    own: quota[i]?.ownDispatch ?? false,
    freeAt: m.freeAt
  }))

  // 与 flow.ts 开头的熔断判定同一算法：近一小时的派兵次数达到上限，就熔断到最早那次满一小时。
  const recent = runtime ? runtime.dispatchTimestamps.filter((t) => now - t < HOUR_MS) : null
  const limit = config.schedule.maxDispatchesPerHour
  const circuitUntil = recent && limit > 0 && recent.length >= limit ? Math.min(...recent) + HOUR_MS : null
  const giveUpUntil = runtime?.giveUpUntil ?? null
  const { queueUsed, queueTotal } = queue

  return {
    instanceIndex: queue.instanceIndex,
    accountId: queue.accountId,
    at: now,
    pausedReason: input.pausedReason ?? null,
    queue: {
      used: queueUsed,
      total: queueTotal,
      sampledAt: queue.lastSampledAt,
      marches,
      nextFreeAt: earliestFreeAt(queue)
    },
    gather: {
      enabled: config.enabled,
      reserveQueues: config.queuePlan.reserveQueues,
      maxConcurrent: config.queuePlan.maxConcurrentGather,
      ownOut: countOwnGathering(quota),
      freeSlots:
        queueUsed !== null && queueTotal !== null ? freeSlots({ queueUsed, queueTotal }, config, quota) : null,
      wanted: wantedResources(config, quota, []).map((entry) => entry.type),
      cooldownUntil: giveUpUntil !== null && giveUpUntil > now ? giveUpUntil : null,
      dispatchesLastHour: recent ? recent.length : null,
      maxDispatchesPerHour: limit,
      circuitUntil,
      bookkeeping: runtime !== null
    }
  }
}
