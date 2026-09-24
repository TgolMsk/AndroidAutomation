/**
 * ETA 调度与队列状态的公共契约（主进程 ⇄ 渲染进程）。移植自原版 src/shared/scheduler.ts。
 *
 * ★ 本文件是**纯**模块：不引 sharp / OpenCV / node:*，经 `@avdm/automation/wanlong/pure` 给渲染进程用。
 *   面板每秒递推倒计时与主进程排期用的是**同一份**函数（deriveMarchView / formatDuration …），
 *   绝不在渲染层再写一份。
 *
 * 核心时间模型（全部是**绝对时刻**，毫秒。绝不存相对值，否则面板重启即失效）：
 *
 *   sampledAt        本次读面板的时刻
 *   remainingMs      面板上读到的倒计时
 *   gatherDoneAt     采集完成时刻 = sampledAt + remainingMs（状态=采集中时，含深夜疲惫换算）
 *   travelTimeMs     单程行军耗时（派兵时从「创建部队」页行军按钮直接读到）
 *   freeAt           队列真正释放、可派下一轮的时刻 = gatherDoneAt + travelTimeMs
 *
 * 调度定时器挂在 `freeAt + slackSeconds` 上（**宁晚勿早**），不是 gatherDoneAt。
 * UI 侧按本地时钟递推显示，零 adb 开销；只有到点唤醒与周期校准才真的去动模拟器。
 */

// ── 队伍状态 ──────────────────────────────────────────────────────────────

/**
 * 面板里读到的队伍状态。
 * 取值来自真机实测的状态词模板；未来补采「驻扎中/集结中/战斗中」时在这里加。
 */
export type MarchStatus =
  /** 采集中（白字压在载重进度条上，倒计时是「采集剩余」） */
  | 'gathering'
  /** 采集行军中 —— 去程。实测状态词是 5 个字，不是「行军中」 */
  | 'gatherMarching'
  /** 返回中 —— 采集完成或被召回后回城，倒计时归零即释放队列 */
  | 'returning'
  /** 行没有内容，队列空位 */
  | 'idle'
  /** 行有内容但状态词没认出来（模板未采集 / 遮挡）。按兜底 ETA 处理，绝不猜 */
  | 'unknown'

/** 状态词的中文显示名。面板直接用它，不要在渲染层再写一份。 */
export const MARCH_STATUS_TEXT: Record<MarchStatus, string> = {
  gathering: '采集中',
  gatherMarching: '采集行军中',
  returning: '返回中',
  idle: '空闲',
  unknown: '未知状态'
}

/** travelTime 的来源，决定 freeAt 有多可信。 */
export type TravelTimeSource =
  /** 没有这支队的派兵记录（手动派出的，或记录已丢失）：只能按配置兜底值估 */
  | 'unrecorded'
  /** 派兵时从「创建部队」页行军按钮上直接读到的，最可信 */
  | 'dispatch'
  /** 由「采集行军中」倒计时观察反推 */
  | 'observed'
  /** 谁都没给，用配置里的兜底值 */
  | 'fallback'

/** 指挥官耐力。读不出时两项都是 null，**绝不填猜测值**。 */
export interface StaminaValue {
  current: number | null
  max: number | null
}

/** 采集资源类型（与 config.ts 的 GatherResourceType 同值；放在契约层供面板/调度器共用）。 */
export type MarchResourceType = 'wood' | 'gold' | 'iron' | 'mana'

/** 一支队伍（部队管理面板里的一行）。 */
export interface MarchState {
  /** 面板中的行序，1 起。 */
  slot: number
  status: MarchStatus
  /** 状态词原文（识别到什么就是什么，便于排查）。 */
  statusText: string
  /** 目标坐标，如 "615,535"。读不出为 null。 */
  targetCoord: string | null
  /** 兵力，如 31500。读不出为 null。 */
  troopCount: number | null
  /** 本行两名指挥官的耐力（读不出的位置是 {null,null}）。 */
  commanders: StaminaValue[]

  /** 本次采样读到的倒计时（毫秒）。读不出为 null。 */
  remainingMs: number | null
  /** 本行倒计时归零的绝对时刻 = sampledAt + remainingMs。 */
  timerEndsAt: number | null
  /** 采集完成的绝对时刻。状态不是「采集中」时可能为 null。 */
  gatherDoneAt: number | null
  /** ★ 队列真正释放的绝对时刻。调度定时器就挂在它上面。 */
  freeAt: number | null
  /** 单程行军耗时（毫秒）。 */
  travelTimeMs: number | null
  travelTimeSource: TravelTimeSource
  /**
   * 这支队在采什么。来源：① 采集中的行按左侧资源点缩略图识别（tpl_row_res_*）；
   * ② 行军中/返回中的行缩略图是部队图，只能靠派兵记账按坐标对上。都没有 = null（面板显示「?」）。
   */
  resourceType?: MarchResourceType | null
  /**
   * 采样时载重进度条的绿色占比（0~1）：游戏里这条随采集线性填满。
   * 面板进度条用它做起点、按剩余时间线性外推到 1；读不到为 null（退回按时间估）。轻量读法，误差几个百分点。
   */
  fillRatio?: number | null

  sampledAt: number
  /** 识别不确定 / 数据缺失时的中文说明，面板标黄用。 */
  warning?: string
}

/** UI 展示用的派生视图。纯函数算出来，不产生任何 adb 开销。 */
export type MarchPhase =
  /** 去资源点的路上 */
  | 'marching'
  /** 正在采集 */
  | 'gathering'
  /** 回城路上 */
  | 'returning'
  /** 按本地递推应该已经空了，等下一次校验 */
  | 'due'
  | 'idle'
  | 'unknown'

export interface MarchView {
  phase: MarchPhase
  /** 中文阶段名。 */
  phaseText: string
  /** 当前阶段的剩余毫秒（不可用为 null）。 */
  remainingMs: number | null
  /** 距队列释放还有多久（不可用为 null）。 */
  untilFreeMs: number | null
  /** 0..1，仅在能算出总时长时有值，用来画进度条。 */
  progress: number | null
}

// ── 每个实例的队列状态 ────────────────────────────────────────────────────

export interface InstanceQueueState {
  instanceIndex: number
  /** 绑定的账号 id，没有为 null。 */
  accountId: string | null
  /** 面板右上的 N（已用行军队列）。读不出为 null。 */
  queueUsed: number | null
  /** 面板右上的 M（队列上限）。读不出为 null。 */
  queueTotal: number | null
  marches: MarchState[]
  /** 上次成功采样的时刻；从没采过为 0。 */
  lastSampledAt: number
  /** 上次采样是否成功。 */
  lastSampleOk: boolean
  /** 最近一次失败的中文原因；正常为 null。 */
  error: string | null
  /** 采样过程中的中文告警（识别不确定、行数对不上等），每次采样覆盖。 */
  warnings: string[]

  /** 是否开启了 ETA 自动调度。 */
  auto: boolean
  /** 当前正在采样（面板可以显示转圈并禁用手动采样按钮）。 */
  sampling: boolean
  /** 当前设备操作尚未结束；auto=false 时可显示“正在停止”。不持久化。 */
  operating?: boolean
  /** 下一次唤醒的绝对时刻；没有排期为 null。 */
  nextWakeAt: number | null
  /** 下一次唤醒的中文理由，如「队列释放校验」「周期校准」「退避重试 60s」。 */
  nextWakeReason: string | null
  /** 连续退避次数，0 表示没在退避。 */
  backoffStep: number
}

// ── 面板采样结果（采样器 → 调度器）───────────────────────────────────────

export interface RowSample {
  slot: number
  status: MarchStatus
  statusText: string
  remainingMs: number | null
  targetCoord: string | null
  troopCount: number | null
  commanders: StaminaValue[]
  /** 采集中行的载重进度条绿色占比（0~1），读不到为 null。 */
  fillRatio: number | null
  /** 按行左侧资源点缩略图识别出的资源类型；行军中/返回中（缩略图是部队图）或没模板时为 null。 */
  resourceType: MarchResourceType | null
  warning?: string
}

export interface PanelSample {
  sampledAt: number
  queueUsed: number | null
  queueTotal: number | null
  rows: RowSample[]
  warnings: string[]
}

// ── 调度配置 ──────────────────────────────────────────────────────────────

export interface SchedulerConfig {
  /** 唤醒时刻 = freeAt + slackSeconds。宁晚勿早，默认 60s。 */
  slackSeconds: number
  /** 唤醒后队列仍未空时的退避阶梯（秒）。 */
  retryBackoffSeconds: number[]
  /** 退避封顶（秒）。 */
  maxBackoffSeconds: number
  /** 周期校准间隔（分钟）。 */
  calibrateIntervalMin: number
  /**
   * 健康探针间隔（分钟），0 = 关闭。
   * 只截一帧、不开面板：跑顶号探针 + 看游戏进程还在不在。
   * 用来给「顶号 / 掉线」的检测延迟设一个上限 —— 否则队列满着的时候，
   * 下一次采样可能要等几小时后的队列释放唤醒，顶号了也没人发现。
   */
  healthProbeIntervalMin: number
  /** 每次唤醒附加的随机抖动上限（秒），多实例错峰用。 */
  jitterSeconds: number
  /** 没拿到 travelTime 时的单程兜底估计（秒）。回程约 1 分钟量级，默认给 90s。 */
  defaultTravelSeconds: number
  /** 状态词或倒计时读不出时的兜底 ETA（秒）。 */
  unknownEtaFallbackSeconds: number
  /** 两次采样之间的最小间隔（毫秒），防止手抖连点把模拟器打爆。 */
  minSampleIntervalMs: number
  /** 单次采样总超时（毫秒）。单张截图实测 750ms，一次采样十几张。 */
  sampleTimeoutMs: number
  /** 采样完成后是否关闭面板（默认 true，读完即关，不常驻）。 */
  closePanelAfterSample: boolean
  /** 最多扫描几行（= 队列上限）。 */
  maxRows: number
  /** 是否读取坐标/兵力/耐力这些非必需字段（关掉能省一半识别时间）。 */
  readOptionalFields: boolean
  /**
   * 使用哪个模板集。原版按包名自动挑；本工程的模板集由用户按实例显式选择（采集设置里的 templateDir），
   * 这个字段只作记录与兼容（填了模板集 id 时必须与所选目录的 manifest.id 一致，否则拒绝采样）。
   */
  templateSetId: string
}

export function defaultSchedulerConfig(): SchedulerConfig {
  return {
    slackSeconds: 60,
    retryBackoffSeconds: [30, 60, 120, 240, 300],
    maxBackoffSeconds: 300,
    calibrateIntervalMin: 15,
    healthProbeIntervalMin: 3,
    jitterSeconds: 20,
    defaultTravelSeconds: 90,
    unknownEtaFallbackSeconds: 300,
    minSampleIntervalMs: 8000,
    sampleTimeoutMs: 60000,
    closePanelAfterSample: true,
    maxRows: 5,
    readOptionalFields: true,
    templateSetId: ''
  }
}

/** 每个数值字段的合法区间（设置页的 min/max 也用它，别在界面再写一份）。 */
export const SCHEDULER_CONFIG_RANGE = {
  slackSeconds: [0, 3600],
  maxBackoffSeconds: [5, 3600],
  calibrateIntervalMin: [1, 720],
  healthProbeIntervalMin: [0, 120],
  jitterSeconds: [0, 600],
  defaultTravelSeconds: [0, 7200],
  unknownEtaFallbackSeconds: [10, 86400],
  minSampleIntervalMs: [1000, 600000],
  sampleTimeoutMs: [5000, 600000],
  maxRows: [1, 8]
} as const

function num(v: unknown, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

function ranged(key: keyof typeof SCHEDULER_CONFIG_RANGE, v: unknown, dflt: number): number {
  const [lo, hi] = SCHEDULER_CONFIG_RANGE[key]
  return clamp(num(v, dflt), lo, hi)
}

/**
 * 逐字段合并配置：单个字段非法只回退这一个字段，不整体作废（原版 store.ts 的 mergeConfig）。
 * 退避阶梯只收正数；一个都不剩时沿用原值。
 */
export function mergeSchedulerConfig(
  base: SchedulerConfig,
  patch: Partial<SchedulerConfig> | null | undefined
): SchedulerConfig {
  const p = (patch ?? {}) as Partial<Record<keyof SchedulerConfig, unknown>>
  const ladder = Array.isArray(p.retryBackoffSeconds)
    ? (p.retryBackoffSeconds as unknown[])
        .filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0)
        .slice(0, 16)
    : []
  return {
    slackSeconds: ranged('slackSeconds', p.slackSeconds, base.slackSeconds),
    retryBackoffSeconds: ladder.length > 0 ? ladder : [...base.retryBackoffSeconds],
    maxBackoffSeconds: ranged('maxBackoffSeconds', p.maxBackoffSeconds, base.maxBackoffSeconds),
    calibrateIntervalMin: ranged('calibrateIntervalMin', p.calibrateIntervalMin, base.calibrateIntervalMin),
    healthProbeIntervalMin: ranged(
      'healthProbeIntervalMin',
      p.healthProbeIntervalMin,
      base.healthProbeIntervalMin
    ),
    jitterSeconds: ranged('jitterSeconds', p.jitterSeconds, base.jitterSeconds),
    defaultTravelSeconds: ranged('defaultTravelSeconds', p.defaultTravelSeconds, base.defaultTravelSeconds),
    unknownEtaFallbackSeconds: ranged(
      'unknownEtaFallbackSeconds',
      p.unknownEtaFallbackSeconds,
      base.unknownEtaFallbackSeconds
    ),
    minSampleIntervalMs: ranged('minSampleIntervalMs', p.minSampleIntervalMs, base.minSampleIntervalMs),
    sampleTimeoutMs: ranged('sampleTimeoutMs', p.sampleTimeoutMs, base.sampleTimeoutMs),
    closePanelAfterSample:
      typeof p.closePanelAfterSample === 'boolean' ? p.closePanelAfterSample : base.closePanelAfterSample,
    maxRows: Math.round(ranged('maxRows', p.maxRows, base.maxRows)),
    readOptionalFields:
      typeof p.readOptionalFields === 'boolean' ? p.readOptionalFields : base.readOptionalFields,
    templateSetId:
      typeof p.templateSetId === 'string' ? p.templateSetId.trim().slice(0, 128) : base.templateSetId
  }
}

/** 一条已排定的唤醒任务（面板的「调度」页用它列出待办）。 */
export interface WakeInfo {
  instanceIndex: number
  dueAt: number
  reason: string
  backoffStep: number
}

// ── 纯函数：本地递推（主进程与渲染进程共用同一份，避免两边算出不同的秒数）─────

/**
 * 采集中的进度：采样时读到的载重占比作起点，按剩余时间线性外推到 1；没读到载重就退回
 * 「自上次采样起过了多少」（这只是本次采样周期内的推进，不代表整趟的进度）。
 */
function fillProgress(m: MarchState, now: number): number | null {
  const fill = m.fillRatio
  if (fill == null || m.gatherDoneAt == null) return ratio(m.gatherDoneAt, m.sampledAt, now)
  const f0 = Math.min(1, Math.max(0, fill))
  const span = m.gatherDoneAt - m.sampledAt
  const t = span <= 0 ? 1 : Math.min(1, Math.max(0, (now - m.sampledAt) / span))
  return Math.min(1, f0 + (1 - f0) * t)
}

/** 按当前时刻把一支队伍换算成 UI 视图。不做任何 IO。 */
export function deriveMarchView(m: MarchState, now: number = Date.now()): MarchView {
  if (m.status === 'idle') {
    return {
      phase: 'idle',
      phaseText: '空闲',
      remainingMs: null,
      untilFreeMs: null,
      progress: null
    }
  }

  const untilFree = m.freeAt == null ? null : Math.max(0, m.freeAt - now)

  // 去程：倒计时归零后进入采集，但采集时长面板没给，只能等下一次校准。
  if (m.status === 'gatherMarching') {
    const left = m.timerEndsAt == null ? null : Math.max(0, m.timerEndsAt - now)
    if (left != null && left > 0) {
      return {
        phase: 'marching',
        phaseText: '采集行军中',
        remainingMs: left,
        untilFreeMs: untilFree,
        progress: ratio(m.timerEndsAt, m.sampledAt, now)
      }
    }
    // 已经到点了，但采集时长未知 —— 只能标成待校验，绝不编一个倒计时出来。
    return {
      phase: 'due',
      phaseText: '已抵达，待校准',
      remainingMs: null,
      untilFreeMs: untilFree,
      progress: null
    }
  }

  if (m.status === 'returning') {
    if (untilFree != null && untilFree > 0) {
      return {
        phase: 'returning',
        phaseText: '返回中',
        remainingMs: untilFree,
        untilFreeMs: untilFree,
        progress: ratio(m.freeAt, m.sampledAt, now)
      }
    }
    return { phase: 'due', phaseText: '应已归队', remainingMs: 0, untilFreeMs: 0, progress: 1 }
  }

  if (m.status === 'gathering') {
    if (m.gatherDoneAt != null && now < m.gatherDoneAt) {
      return {
        phase: 'gathering',
        phaseText: '采集中',
        remainingMs: m.gatherDoneAt - now,
        untilFreeMs: untilFree,
        progress: fillProgress(m, now)
      }
    }
    // 采集已完成 -> 本地直接切成「返回中」，不需要再开面板采样。
    if (m.freeAt != null && now < m.freeAt) {
      return {
        phase: 'returning',
        phaseText: '返回中',
        remainingMs: m.freeAt - now,
        untilFreeMs: untilFree,
        progress: ratio(m.freeAt, m.gatherDoneAt ?? m.sampledAt, now)
      }
    }
    return { phase: 'due', phaseText: '应已归队', remainingMs: 0, untilFreeMs: 0, progress: 1 }
  }

  // unknown
  return {
    phase: 'unknown',
    phaseText: m.statusText || '未知状态',
    remainingMs: untilFree,
    untilFreeMs: untilFree,
    progress: null
  }
}

function ratio(endAt: number | null, startAt: number | null, now: number): number | null {
  if (endAt == null || startAt == null || endAt <= startAt) return null
  const p = (now - startAt) / (endAt - startAt)
  return Math.min(1, Math.max(0, p))
}

/** 毫秒 -> HH:MM:SS（超过一天按天+时分秒）。面板倒计时统一用它，保证两处显示一致。 */
export function formatDuration(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return '--:--:--'
  const total = Math.max(0, Math.round(ms / 1000))
  const d = Math.floor(total / 86400)
  const h = Math.floor((total % 86400) / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const hh = String(h).padStart(2, '0')
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return d > 0 ? `${d}天 ${hh}:${mm}:${ss}` : `${hh}:${mm}:${ss}`
}

/** 这个实例现在还有几个空队列位？读不出返回 null（**不要当成 0 或无限**）。 */
export function freeQueueSlots(s: Pick<InstanceQueueState, 'queueUsed' | 'queueTotal'>): number | null {
  if (s.queueUsed == null || s.queueTotal == null) return null
  return Math.max(0, s.queueTotal - s.queueUsed)
}

/** 全部队伍里最早释放的时刻；一个都没有返回 null。 */
export function earliestFreeAt(s: Pick<InstanceQueueState, 'marches'>): number | null {
  let best: number | null = null
  for (const m of s.marches) {
    if (m.status === 'idle' || m.freeAt == null) continue
    if (best == null || m.freeAt < best) best = m.freeAt
  }
  return best
}

/** 多个实例的汇总（面板顶部「在外 N 支 / 空位 M 个」用）。只统计读得出 N/M 的实例。 */
export function summarizeQueues(states: readonly InstanceQueueState[]): {
  instances: number
  auto: number
  marchesOut: number
  freeSlots: number
  unknownQueues: number
  earliestFreeAt: number | null
} {
  let auto = 0
  let marchesOut = 0
  let freeSlots = 0
  let unknownQueues = 0
  let earliest: number | null = null
  for (const s of states) {
    if (s.auto) auto++
    marchesOut += s.marches.filter((m) => m.status !== 'idle').length
    const free = freeQueueSlots(s)
    if (free == null) unknownQueues++
    else freeSlots += free
    const at = earliestFreeAt(s)
    if (at != null && (earliest == null || at < earliest)) earliest = at
  }
  return { instances: states.length, auto, marchesOut, freeSlots, unknownQueues, earliestFreeAt: earliest }
}
