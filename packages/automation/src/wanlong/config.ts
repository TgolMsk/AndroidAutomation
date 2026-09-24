/**
 * 自动采集配置：类型 + 默认值 + 归一化。
 *
 * 与 packages/automation/game-data/wanlong/gather-config.schema.json（draft-07, version=2）一一对应。
 * 这里不引 ajv：面板保存时可以用 schema 校验，运行期只需要一个「把任意输入夹成合法值」的归一化函数，
 * 缺字段一律回落默认值，绝不让一个手滑的配置把流程搞成死循环。
 *
 * ★★ 全文最重要的一条语义（写在类型注释里，防止后来者改坏）：
 *   游戏搜索的规则是「返回等级 **>=** 搜索等级的资源点」，不是精确匹配。
 *   所以这里出现的一切等级值都是 **搜索下限 searchFloor**，不是目标值。
 *   搜 5 级跳到 7 级点是正常且更优的结果。卡片校验必须写 `卡片等级 >= searchFloor`，
 *   写成 `==` 会在完全正常的情况下判失败并重搜，表现为「一直在搜、永远不派兵」。
 *   游戏也**不可能**提供等级上界 —— 要避开不想要的点只能靠储量 / 采集者 / 联盟 / 行军时长。
 */

export const GATHER_CONFIG_VERSION = 2

export type GatherResourceType = 'wood' | 'gold' | 'iron' | 'mana'

export const RESOURCE_LABEL: Record<GatherResourceType, { resource: string; category: string }> = {
  wood: { resource: '木材', category: '伐木场' },
  gold: { resource: '金币', category: '金矿' },
  iron: { resource: '铁矿石', category: '铁矿' },
  mana: { resource: '魔水', category: '魔水池' }
}

/** 等级**下限**策略。算出来的是 searchFloor，不存在上界。 */
export type LevelPolicy =
  | {
      mode: 'relative'
      /** searchFloor = maxLv + offset。默认 -1（下限 maxLv-1，实际常采到 maxLv 的点）。 */
      offset: number
      /** 下限最多放宽到这里。 */
      minLevel: number
      /** 探测失败时假定的上限。 */
      assumedMaxLevel: number
      /** 识别合理性护栏：读到超过它一律判为识别错误。★不是资源点等级上界。 */
      maxLevelHardCap: number
    }
  | {
      mode: 'absolute'
      /** 固定搜索下限。★是下限不是目标值：配 6 会搜到 6 级及以上的点。 */
      level: number
      minLevel: number
      /** 关掉则固定下限搜不到就放弃本轮，不放宽。 */
      allowRelax: boolean
      maxLevelHardCap: number
    }

export interface ResourceEntry {
  type: GatherResourceType
  enabled: boolean
  /** 数字越小越先派。 */
  priority: number
  /** 这种资源最多同时占用几个行军队列。 */
  queues: number
  /** 覆盖全局。 */
  levelPolicy?: LevelPolicy
  minStorage?: number
  maxTravelSeconds?: number
}

export type AllianceTerritory = 'own-only' | 'own-and-neutral' | 'any'

export interface GatherThresholds {
  /** 最低储量。0 = 不限制。 */
  minStorage: number
  /** 最长单程行军秒数。★首选的距离约束，在创建部队页从行军按钮上直接读到。0 = 不限制。 */
  maxTravelSeconds: number
  /**
   * 最远直线距离（公里）。0 = 不限制。
   * ★ 本模块目前**不消费**它 —— 算距离要先知道自家主城坐标，而流程里没有读主城坐标的环节；
   *   距离约束一律走 maxTravelSeconds（行军按钮上直接读得到，更准）。
   *   之所以仍然保留字段：配置页（GatherConfigView）按 schema 提供了这一项，
   *   归一化时若把它丢掉，用户填的值会在「面板保存 → 主进程归一化 → 回写」的往返里被静默抹掉。
   */
  maxDistanceKm: number
  /** 必须「采集者 无」。除非调试，不要关。 */
  requireGathererNone: boolean
  /** 所属联盟策略。 */
  allianceTerritory: AllianceTerritory
  /** 本方联盟缩写。留空则降级为「只接受中立（所属联盟=无）」并告警。 */
  ownAllianceTag: string
  /** 负载量 < 卡片储量时换点。默认关（勾了「自动采集至清空」后游戏会自己续采）。 */
  preferLoadCoversStorage: boolean
}

export interface QueuePlan {
  /** 留给打野/集结等其它功能块的队列数。 */
  reserveQueues: number
  /** 自动采集最多同时占用几个队列。 */
  maxConcurrentGather: number
  /** 用部队管理面板每行的坐标去重，避免两队派同一个点。 */
  avoidDuplicateTarget: boolean
  /**
   * @deprecated 已废弃（2026-09-10）：该游戏的指挥官耐力只用于打架，不影响采集，派兵不再据此拦截。
   * 字段保留只为兼容旧配置文件，面板不再展示。
   */
  minCommanderStamina: number
}

export interface SearchRetry {
  /** 同一下限下最多重搜几次。★「等级高于下限」不算失败，不得计数。 */
  occupiedRetryLimit: number
  /** 每次把搜索下限放宽几级。 */
  floorRelaxStep: number
  /** 两次搜索之间的间隔（ms）。太小会截到动画中间帧导致识别失败。 */
  researchDelayMs: number
  /** 动态探测等级上限。 */
  probeMaxLevel: boolean
  /** 重新探测上限的间隔（分钟）。 */
  probeIntervalMin: number
}

export interface GatherSchedule {
  /** 唤醒冗余（秒）。唤醒时刻 = freeAt + slackSeconds。宁晚勿早。 */
  slackSeconds: number
  /** 队列仍未空时的退避序列（秒）。 */
  retryBackoffSeconds: number[]
  maxBackoffSeconds: number
  /** 兜底校准间隔（分钟）。 */
  calibrateIntervalMin: number
  /** 多实例错峰抖动（秒）。 */
  jitterSeconds: number
  /** 每小时派兵次数上限（熔断）。0 = 不限制。 */
  maxDispatchesPerHour: number
  /** 下限已放宽到底仍搜不到时的冷却（分钟）。 */
  giveUpCooldownMin: number
}

export interface GatherSafety {
  /** 游戏内设置项点完复验仍不符时中止本轮。 */
  abortOnReconcileFail: boolean
  /** 卡片等级识别失败时：abort=中止；acceptCard=按「游戏只返回 >= 下限的点」视为满足下限。 */
  onUnknownLevel: 'abort' | 'acceptCard'
  /** 储量识别失败时。 */
  onUnknownStorage: 'skipPoint' | 'accept'
  /** 倒计时识别失败时的保守 ETA（秒）。 */
  unknownEtaFallbackSeconds: number
  /** 单轮派兵截图数上限（熔断）。游戏在前台时单张截图实测约 750ms。 */
  maxCapturesPerCycle: number
  /** adb input swipe 偶发 INJECT_EVENTS 被拒，实测重试即成功。 */
  swipeRetry: number
  /**
   * 留痕截图策略。
   * ★ 本模块自己不写磁盘，只把每一帧交给 runGatherCycle 的 `onShot` 回调；
   *   真正决定「存不存」的是接线层，它应当读这个字段来决定要不要传 onShot / 要不要落盘。
   *   字段放在这里而不是接线层，是因为它属于用户在采集配置页里配的东西（schema 里就有）。
   */
  shotPolicy: 'never' | 'onFail' | 'always'
}

export interface GatherConfig {
  version: number
  enabled: boolean
  resources: ResourceEntry[]
  levelPolicy: LevelPolicy
  thresholds: GatherThresholds
  /** 游戏内建勾选框。★必须对账：读实际态 -> 只在不一致时点 -> 复验。 */
  autoGatherUntilEmpty: boolean
  queuePlan: QueuePlan
  searchRetry: SearchRetry
  schedule: GatherSchedule
  safety: GatherSafety
}

export const DEFAULT_LEVEL_POLICY: LevelPolicy = {
  mode: 'relative',
  offset: -1,
  minLevel: 5,
  assumedMaxLevel: 8,
  maxLevelHardCap: 15
}

export const DEFAULT_GATHER_CONFIG: GatherConfig = {
  version: GATHER_CONFIG_VERSION,
  enabled: false,
  resources: [
    { type: 'wood', enabled: true, priority: 1, queues: 2 },
    { type: 'gold', enabled: true, priority: 2, queues: 1 },
    { type: 'iron', enabled: true, priority: 3, queues: 1 },
    { type: 'mana', enabled: false, priority: 4, queues: 0 }
  ],
  levelPolicy: DEFAULT_LEVEL_POLICY,
  thresholds: {
    minStorage: 300000,
    maxTravelSeconds: 600,
    maxDistanceKm: 0,
    requireGathererNone: true,
    // 用户 2026-09-09 明确裁定：任何领地的资源点都可以采，不做联盟过滤。
    // 取 'any' 时 card.ts 的联盟判据整段短路，flow.ts 也不会去识别「所属联盟」字段（省一次识别）。
    allianceTerritory: 'any',
    ownAllianceTag: '',
    preferLoadCoversStorage: false
  },
  autoGatherUntilEmpty: true,
  queuePlan: {
    reserveQueues: 0,
    maxConcurrentGather: 5,
    avoidDuplicateTarget: true,
    minCommanderStamina: 1
  },
  searchRetry: {
    occupiedRetryLimit: 4,
    floorRelaxStep: 1,
    researchDelayMs: 900,
    probeMaxLevel: true,
    probeIntervalMin: 720
  },
  schedule: {
    slackSeconds: 60,
    retryBackoffSeconds: [30, 60, 120, 240, 300],
    maxBackoffSeconds: 300,
    calibrateIntervalMin: 15,
    jitterSeconds: 20,
    maxDispatchesPerHour: 30,
    giveUpCooldownMin: 10
  },
  safety: {
    abortOnReconcileFail: true,
    /**
     * ★ 这里刻意与 schema 的 default('abort') 不同，取 'acceptCard'：
     *   当前模板库里 dig_card_title 只有 7、8 两个字形（附近的资源点只有 7/8 级），
     *   取 'abort' 会让每一轮都在读卡片等级时中止。而「等级判据是 >=、游戏只返回满足下限的点」
     *   这条机制保证了 acceptCard 是安全的：读不出等级时按满足下限处理，其余判据照常校验。
     *   等 dig_card_title 补齐 0-9 后可以改回 'abort'。
     */
    onUnknownLevel: 'acceptCard',
    onUnknownStorage: 'skipPoint',
    unknownEtaFallbackSeconds: 600,
    /**
     * ★ 这里也刻意与 schema 的 default(24) 不同，取 60。
     *   离线回放实测：一次**顺利**的派兵要 17 帧（设计文档估的 9~12 偏乐观，
     *   waitFor 轮询与数字复读都会额外吃帧），一个「点不合适、换一个」的循环要 6~7 帧。
     *   ★ 2026-09-19 起每一轮再加 1~2 帧（G8 卡片停稳复验）、派兵那次再加 1 帧（G10 点前重定位），
     *   于是顺利派兵 19~20 帧、重试循环 7~9 帧。
     *   默认 occupiedRetryLimit=4 意味着最坏要 20 + 4*9 ≈ 56 帧，
     *   配额给 24 的话重试策略根本跑不满就被熔断了，表现为「明明还能再搜两次却直接收工」。
     *   60 帧 × 750ms ≈ 45 秒，作为「流程卡住」的熔断线仍然足够灵敏。
     */
    maxCapturesPerCycle: 60,
    swipeRetry: 3,
    shotPolicy: 'onFail'
  }
}

// ── 归一化 ────────────────────────────────────────────────────────────────

type DeepPartial<T> = T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T

/**
 * 把任意（可能残缺、可能越界）的输入归一化成一份可以直接跑的配置。
 * 只夹值不抛错 —— 配置页保存时应该已经用 schema 拦过一道，运行期再抛就太晚了。
 */
export function normalizeGatherConfig(input?: DeepPartial<GatherConfig> | null): GatherConfig {
  const d = DEFAULT_GATHER_CONFIG
  const src = input ?? {}

  const resources = normalizeResources(src.resources as ResourceEntry[] | undefined)
  const th = (src.thresholds ?? {}) as Partial<GatherThresholds>
  const qp = (src.queuePlan ?? {}) as Partial<QueuePlan>
  const sr = (src.searchRetry ?? {}) as Partial<SearchRetry>
  const sc = (src.schedule ?? {}) as Partial<GatherSchedule>
  const sf = (src.safety ?? {}) as Partial<GatherSafety>

  return {
    version: GATHER_CONFIG_VERSION,
    enabled: bool(src.enabled, d.enabled),
    resources,
    levelPolicy: normalizeLevelPolicy(src.levelPolicy as LevelPolicy | undefined),
    thresholds: {
      minStorage: int(th.minStorage, d.thresholds.minStorage, 0, 100_000_000),
      maxTravelSeconds: int(th.maxTravelSeconds, d.thresholds.maxTravelSeconds, 0, 86_400),
      maxDistanceKm: int(th.maxDistanceKm, d.thresholds.maxDistanceKm, 0, 10_000),
      requireGathererNone: bool(th.requireGathererNone, d.thresholds.requireGathererNone),
      allianceTerritory: oneOf(
        th.allianceTerritory,
        ['own-only', 'own-and-neutral', 'any'] as const,
        d.thresholds.allianceTerritory
      ),
      ownAllianceTag: String(th.ownAllianceTag ?? d.thresholds.ownAllianceTag).slice(0, 8).trim(),
      preferLoadCoversStorage: bool(
        th.preferLoadCoversStorage,
        d.thresholds.preferLoadCoversStorage
      )
    },
    autoGatherUntilEmpty: bool(src.autoGatherUntilEmpty, d.autoGatherUntilEmpty),
    queuePlan: {
      reserveQueues: int(qp.reserveQueues, d.queuePlan.reserveQueues, 0, 5),
      maxConcurrentGather: int(qp.maxConcurrentGather, d.queuePlan.maxConcurrentGather, 1, 5),
      avoidDuplicateTarget: bool(qp.avoidDuplicateTarget, d.queuePlan.avoidDuplicateTarget),
      minCommanderStamina: int(qp.minCommanderStamina, d.queuePlan.minCommanderStamina, 0, 999)
    },
    searchRetry: {
      occupiedRetryLimit: int(sr.occupiedRetryLimit, d.searchRetry.occupiedRetryLimit, 1, 20),
      floorRelaxStep: int(sr.floorRelaxStep, d.searchRetry.floorRelaxStep, 1, 3),
      researchDelayMs: int(sr.researchDelayMs, d.searchRetry.researchDelayMs, 0, 10_000),
      probeMaxLevel: bool(sr.probeMaxLevel, d.searchRetry.probeMaxLevel),
      probeIntervalMin: int(sr.probeIntervalMin, d.searchRetry.probeIntervalMin, 1, 100_000)
    },
    schedule: {
      slackSeconds: int(sc.slackSeconds, d.schedule.slackSeconds, 0, 900),
      retryBackoffSeconds: normalizeBackoff(sc.retryBackoffSeconds),
      maxBackoffSeconds: int(sc.maxBackoffSeconds, d.schedule.maxBackoffSeconds, 30, 86_400),
      calibrateIntervalMin: int(sc.calibrateIntervalMin, d.schedule.calibrateIntervalMin, 1, 1440),
      jitterSeconds: int(sc.jitterSeconds, d.schedule.jitterSeconds, 0, 600),
      maxDispatchesPerHour: int(sc.maxDispatchesPerHour, d.schedule.maxDispatchesPerHour, 0, 1000),
      giveUpCooldownMin: int(sc.giveUpCooldownMin, d.schedule.giveUpCooldownMin, 1, 1440)
    },
    safety: {
      abortOnReconcileFail: bool(sf.abortOnReconcileFail, d.safety.abortOnReconcileFail),
      onUnknownLevel: oneOf(sf.onUnknownLevel, ['abort', 'acceptCard'] as const, d.safety.onUnknownLevel),
      onUnknownStorage: oneOf(
        sf.onUnknownStorage,
        ['skipPoint', 'accept'] as const,
        d.safety.onUnknownStorage
      ),
      unknownEtaFallbackSeconds: int(
        sf.unknownEtaFallbackSeconds,
        d.safety.unknownEtaFallbackSeconds,
        60,
        86_400
      ),
      maxCapturesPerCycle: int(sf.maxCapturesPerCycle, d.safety.maxCapturesPerCycle, 6, 500),
      swipeRetry: int(sf.swipeRetry, d.safety.swipeRetry, 0, 10),
      shotPolicy: oneOf(sf.shotPolicy, ['never', 'onFail', 'always'] as const, d.safety.shotPolicy)
    }
  }
}

function normalizeResources(input?: ResourceEntry[]): ResourceEntry[] {
  const types: GatherResourceType[] = ['wood', 'gold', 'iron', 'mana']
  const byType = new Map<GatherResourceType, ResourceEntry>()
  for (const def of DEFAULT_GATHER_CONFIG.resources) byType.set(def.type, { ...def })
  if (Array.isArray(input)) {
    for (const raw of input) {
      if (!raw || !types.includes(raw.type)) continue
      const base = byType.get(raw.type)
      if (!base) continue
      byType.set(raw.type, {
        type: raw.type,
        enabled: bool(raw.enabled, base.enabled),
        priority: int(raw.priority, base.priority, 1, 4),
        queues: int(raw.queues, base.queues, 0, 5),
        levelPolicy: raw.levelPolicy ? normalizeLevelPolicy(raw.levelPolicy) : undefined,
        minStorage: raw.minStorage === undefined ? undefined : int(raw.minStorage, 0, 0, 100_000_000),
        maxTravelSeconds:
          raw.maxTravelSeconds === undefined ? undefined : int(raw.maxTravelSeconds, 0, 0, 86_400)
      })
    }
  }
  return types.map((t) => byType.get(t)!).sort((a, b) => a.priority - b.priority)
}

export function normalizeLevelPolicy(input?: LevelPolicy | null): LevelPolicy {
  const d = DEFAULT_LEVEL_POLICY as Extract<LevelPolicy, { mode: 'relative' }>
  if (input && input.mode === 'absolute') {
    const hardCap = int(input.maxLevelHardCap, d.maxLevelHardCap, 1, 30)
    return {
      mode: 'absolute',
      level: int(input.level, 6, 1, hardCap),
      minLevel: int(input.minLevel, d.minLevel, 1, hardCap),
      allowRelax: bool(input.allowRelax, true),
      maxLevelHardCap: hardCap
    }
  }
  const rel = (input ?? d) as Extract<LevelPolicy, { mode: 'relative' }>
  const hardCap = int(rel.maxLevelHardCap, d.maxLevelHardCap, 1, 30)
  return {
    mode: 'relative',
    offset: int(rel.offset, d.offset, -5, 0),
    minLevel: int(rel.minLevel, d.minLevel, 1, hardCap),
    assumedMaxLevel: int(rel.assumedMaxLevel, d.assumedMaxLevel, 1, hardCap),
    maxLevelHardCap: hardCap
  }
}

function normalizeBackoff(v?: number[]): number[] {
  const d = DEFAULT_GATHER_CONFIG.schedule.retryBackoffSeconds
  if (!Array.isArray(v) || v.length === 0) return [...d]
  const out = v.map((x) => int(x, 30, 5, 86_400))
  return out.length > 0 ? out : [...d]
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback
}

function int(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback
}

// ── 由配置推导 ────────────────────────────────────────────────────────────

/**
 * 计算本轮的搜索**下限**。
 *
 * ★ 返回值是 searchFloor：游戏会返回等级 >= 它的点，可能是 8、9、10……都算合格。
 */
export function computeSearchFloor(policy: LevelPolicy, maxLevel: number): number {
  if (policy.mode === 'absolute') {
    return clampInt(policy.level, policy.minLevel, Math.max(policy.minLevel, maxLevel))
  }
  const raw = maxLevel + policy.offset
  return clampInt(raw, policy.minLevel, Math.max(policy.minLevel, maxLevel))
}

/** 下限还能不能继续放宽。absolute + allowRelax=false 时不允许。 */
export function canRelaxFloor(policy: LevelPolicy): boolean {
  return policy.mode === 'relative' ? true : policy.allowRelax
}

/** 某个资源条目生效的等级策略 / 阈值（条目覆盖全局）。 */
export function effectiveLevelPolicy(cfg: GatherConfig, entry: ResourceEntry): LevelPolicy {
  return entry.levelPolicy ?? cfg.levelPolicy
}

export function effectiveMinStorage(cfg: GatherConfig, entry: ResourceEntry): number {
  return entry.minStorage ?? cfg.thresholds.minStorage
}

export function effectiveMaxTravelSeconds(cfg: GatherConfig, entry: ResourceEntry): number {
  return entry.maxTravelSeconds ?? cfg.thresholds.maxTravelSeconds
}

function clampInt(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(v)))
}
