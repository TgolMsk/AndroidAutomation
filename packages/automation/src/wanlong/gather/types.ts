/**
 * 采集流程的运行期类型：跨轮持久化的状态、面板读数、单轮结果。
 *
 * ★ 本文件刻意不 import 任何 IO —— 它是「采集模块」与「ETA 调度器」之间的契约面。
 *   调度器只需要：把上一轮的 GatherRuntimeState 存起来，到点了再连同配置一起交回来，
 *   然后按结果里的 nextWakeAt 排下一次唤醒。
 */

import type { SerializedError } from '../errors.js'
import type { GatherResourceType } from '../config.js'

/** 部队管理面板里一行的状态词。 */
export type TroopStatus = 'gathering' | 'gatherMarching' | 'returning' | 'unknown'

export const TROOP_STATUS_LABEL: Record<TroopStatus, string> = {
  gathering: '采集中',
  gatherMarching: '采集行军中',
  returning: '返回中',
  unknown: '未知'
}

/** 部队管理面板里的一行（一支在外的队伍）。 */
export interface TroopRow {
  /** 1 起。 */
  index: number
  status: TroopStatus
  /** 状态词旁边的倒计时（秒）。读不出为 null。 */
  remainingSec: number | null
  /** 该行的目标坐标，形如 `615,535`。读不出为 null。 */
  coord: string | null
  /** 该行指挥官耐力 [当前, 上限]。读不出为 null。 */
  stamina: [number, number] | null
  /** 本行数据的采样时刻。 */
  sampledAt: number
}

/** 一次「部队管理」面板读数。 */
export interface TroopPanelReading {
  /** 行军队列已用 / 上限（面板右上角 N/M）。 */
  queueUsed: number
  queueTotal: number
  rows: TroopRow[]
  sampledAt: number
  /** 识别过程中的降级说明（中文），用于面板告警。 */
  warnings: string[]
}

/** 在途队伍记账。UI 每秒本地递推倒计时就靠它。 */
export interface MarchRecord {
  /** 面板行号（每次读面板会重排，只作参考）。 */
  rowIndex: number
  coord: string | null
  status: TroopStatus
  /** 本次采样时该行剩余秒数。 */
  remainingSec: number | null
  sampledAt: number
  /** 单程行军秒数。派兵时从行军按钮上直接读到，没读到则为 null。 */
  travelTimeSec: number | null
  /** 当前阶段的结束时刻（采集完成 / 抵达 / 到家）。 */
  etaAt: number | null
  /** 队列真正释放的时刻 = 采集完成 + 回城行军。★唤醒取 freeAt + slack。 */
  freeAt: number | null
  /** 这一趟是去采什么（只有本引擎派出的队伍才知道）。 */
  resource?: GatherResourceType
  /** 该记录是否由本引擎派出（外部派的队伍只能从面板推断）。 */
  ownDispatch: boolean
}

/** 一次成功派兵的记录。 */
export interface DispatchRecord {
  at: number
  resource: GatherResourceType
  /** 目标坐标，读不出为 null。 */
  coord: string | null
  /** 卡片上的资源点等级，读不出为 null。 */
  level: number | null
  /** 使用的搜索下限。 */
  searchFloor: number
  /** 卡片储量。 */
  storage: number | null
  /** 单程行军秒数（★ freeAt 计算的关键输入）。 */
  travelTimeSec: number | null
  /** 本次编成的兵力。 */
  troops: number | null
}

/**
 * 每种资源各自的等级记忆。
 *
 * ★ 按资源分，不共用：每个分类的滑杆上限可以不一样（2026-09-18 真机实证：魔水池滑杆能推到 10，
 *   附近却只有 8 级点；以前四种资源共用一个上限，魔水探到 10 会把伐木场 / 金矿 / 铁矿也带到「下限 9」）。
 * ★ 滑杆上限 ≠ 附近真有的最高等级，所以还要记「从哪个下限起才搜得到点」（noResultFloor）。
 *   决策逻辑在 levelMemory.ts，这里只是数据。
 */
export interface ResourceLevelMemory {
  /** 动态探测到的**滑杆**上限（把滑杆推到最右读到的数）。 */
  maxLevel: number | null
  /** 上次探测上限的时刻。 */
  probedAt: number | null
  /** 已确认「这个搜索下限附近搜不到点」的最低下限；下一轮从它 −1 起步。null = 没有记忆。 */
  noResultFloor: number | null
  /** 写入 noResultFloor 的时刻。记忆与上限探测同寿命（searchRetry.probeIntervalMin）。 */
  noResultAt: number | null
}

export type LevelMemoryMap = Partial<Record<GatherResourceType, ResourceLevelMemory>>

/**
 * 跨轮持久化的运行期状态。
 * 由调度器负责存取（内存或落盘皆可），采集模块只读改不落盘。
 */
export interface GatherRuntimeState {
  /**
   * 每种资源的等级记忆（滑杆上限缓存 + 「搜不到」的下限记忆）。
   * 旧版本的 `maxLevel` / `maxLevelProbedAt` 是四种资源共用的一个值，读到旧状态文件时直接丢弃、重新探测。
   */
  levelByResource: LevelMemoryMap
  /** 退避序列游标。派兵成功后清零。 */
  backoffIndex: number
  /** 「下限已放宽到底仍搜不到」后的冷却截止时刻。 */
  giveUpUntil: number | null
  /** 近一小时的派兵时刻（熔断用）。 */
  dispatchTimestamps: number[]
  /** 在途队伍。 */
  inFlight: MarchRecord[]
  /** 上次读部队管理面板的时刻。 */
  lastPanelSampledAt: number | null
  /**
   * 本引擎派出的队伍：目标坐标 -> 单程行军秒数。
   * 面板上只有「本阶段剩余时间」，算 freeAt 还要加上回城的行军时间，那个值只有派兵时读得到。
   */
  travelTimeByCoord: Record<string, number>
  /**
   * 本引擎派出的队伍：目标坐标 -> 采的是什么资源。
   * 面板上看不出一支队伍去采什么，只能靠派兵时自己记；用于「每种资源占几个队列」的配额判断。
   */
  resourceByCoord: Record<string, GatherResourceType>
}

export function createRuntimeState(): GatherRuntimeState {
  return {
    levelByResource: {},
    backoffIndex: 0,
    giveUpUntil: null,
    dispatchTimestamps: [],
    inFlight: [],
    lastPanelSampledAt: null,
    travelTimeByCoord: {},
    resourceByCoord: {}
  }
}

/** 单轮结束的原因。 */
export type GatherOutcome =
  /** 本轮至少派出了一支队 */
  | 'dispatched'
  /** 队列没空位（正常结束，按最早 freeAt 排唤醒） */
  | 'queueFull'
  /** 配置里没有还欠队列的资源（正常结束） */
  | 'noResourceWanted'
  /** 下限已放宽到底仍搜不到可用点，进入冷却 */
  | 'giveUp'
  /** 指挥官耐力不足 */
  | 'staminaLow'
  /** 熔断：每小时派兵次数 / 单轮截图数超限 */
  | 'circuitBroken'
  /** 被外部中止 */
  | 'cancelled'
  /** 出错（error 字段有值） */
  | 'error'

export interface GatherCycleResult {
  outcome: GatherOutcome
  /** 中文摘要，可直接显示在面板上。 */
  message: string
  /** 本轮派出的队伍。 */
  dispatched: DispatchRecord[]
  /** 本轮最后一次读到的队列占用。 */
  queue: { used: number; total: number } | null
  /** 建议的下次唤醒时刻（毫秒时间戳）。null 表示不需要再唤醒（例如已禁用/熔断）。 */
  nextWakeAt: number | null
  /** 建议唤醒的理由（中文），写进日志便于排障。 */
  nextWakeReason: string
  /** 本轮截图数。 */
  captures: number
  /** 更新后的运行期状态（★调度器必须存回去）。 */
  state: GatherRuntimeState
  /** 非致命的降级告警（模板缺失、识别失败等）。 */
  warnings: string[]
  error?: SerializedError
}
