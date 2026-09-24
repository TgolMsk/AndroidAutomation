/**
 * 采集配置的**校验 / 宽松还原 / 导入导出 / 人话说明**。移植自原版 src/renderer/src/features/gather/config.ts
 * 与 configStorage.ts 的纯函数部分。
 *
 * ★ 纯模块：经 `@avdm/automation/wanlong/pure` 给渲染进程用，主进程保存配置前也用它把关。
 *   不引 sharp / OpenCV / node:*。
 *
 * 为什么同时有 `coerceGatherConfig` 和 `normalizeGatherConfig`（config.ts）：
 *   · normalizeGatherConfig 是**运行期**用的：把任意输入**夹**进合法区间，绝不让流程跑出死循环；
 *   · coerceGatherConfig 是**表单与保存把关**用的（原版渲染进程的 normalizeGatherConfig）：
 *     只补缺字段、取整，**不夹值** —— 越界的值原样留着，交给 validateGatherConfig 报出中文问题。
 *     否则用户填了 20 个队列，保存时被悄悄夹成 5，他永远不知道自己的输入被改过。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 【全模块最重要的一条不变量，改代码前必读】
 * 游戏的搜索规则是「返回等级 >= 搜索等级的资源点」，**不是精确匹配**。
 * 真机实测：伐木场把搜索值调到 1，连续搜 6 次返回的点是 8,7,7,7,7,8 —— 没有一次等于搜索值。
 * 所以本配置里所有等级值都叫 **searchFloor（搜索下限）**，不是目标值。
 * ════════════════════════════════════════════════════════════════════════════
 */

import {
  DEFAULT_GATHER_CONFIG,
  DEFAULT_LEVEL_POLICY,
  GATHER_CONFIG_VERSION,
  type AllianceTerritory,
  type GatherConfig,
  type GatherResourceType,
  type LevelPolicy,
  type ResourceEntry
} from './config.js'

/** 资源的固定展示顺序（与 schema 的 definitions.resourceType 一致）。表单按它排，不按优先级排。 */
export const GATHER_RESOURCE_ORDER: readonly GatherResourceType[] = ['wood', 'gold', 'iron', 'mana']

/** 切到「绝对值」模式时的起始策略（原版 GatherConfigView 的 Segmented 切换值）。 */
export const ABSOLUTE_LEVEL_POLICY_DEFAULT: Extract<LevelPolicy, { mode: 'absolute' }> = {
  mode: 'absolute',
  level: 7,
  minLevel: 5,
  allowRelax: true,
  maxLevelHardCap: 15
}

type RelativePolicy = Extract<LevelPolicy, { mode: 'relative' }>
type AbsolutePolicy = Extract<LevelPolicy, { mode: 'absolute' }>

/** 一份可以随便改的默认配置（深拷贝，绝不把 DEFAULT_GATHER_CONFIG 本身交出去让人改）。 */
export function defaultGatherConfig(): GatherConfig {
  return JSON.parse(JSON.stringify(DEFAULT_GATHER_CONFIG)) as GatherConfig
}

/** 默认的相对等级策略（深拷贝）。 */
export function defaultLevelPolicy(): RelativePolicy {
  return { ...(DEFAULT_LEVEL_POLICY as RelativePolicy) }
}

// ── 宽松还原：补缺字段、取整，不夹值 ──────────────────────────────────────

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback
}
function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback
}
function str(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback
}
function pick<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback
}
function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

function coerceLevelPolicy(raw: unknown, fallback: LevelPolicy): LevelPolicy {
  if (!raw || typeof raw !== 'object') return { ...fallback }
  const o = raw as Record<string, unknown>
  const d = defaultLevelPolicy()
  if (o.mode === 'absolute') {
    const a = ABSOLUTE_LEVEL_POLICY_DEFAULT
    return {
      mode: 'absolute',
      level: num(o.level, a.level),
      minLevel: num(o.minLevel, a.minLevel),
      allowRelax: bool(o.allowRelax, a.allowRelax),
      maxLevelHardCap: num(o.maxLevelHardCap, a.maxLevelHardCap)
    }
  }
  return {
    mode: 'relative',
    offset: num(o.offset, d.offset),
    minLevel: num(o.minLevel, d.minLevel),
    assumedMaxLevel: num(o.assumedMaxLevel, d.assumedMaxLevel),
    maxLevelHardCap: num(o.maxLevelHardCap, d.maxLevelHardCap)
  }
}

/**
 * 把任意来源的对象（旧版本、缺字段、手改过的 JSON、别的面板导出的）补成一份完整配置。
 * **不抛异常、不夹值** —— 认不出的字段回落默认值，越界的数字原样保留，交给 validateGatherConfig 报。
 * 资源固定按 木材 / 金币 / 铁矿石 / 魔水 排列；每种资源上的覆盖项（levelPolicy / minStorage /
 * maxTravelSeconds）原样保留（界面不编辑它们，但保存一次不能把它们抹掉）。
 */
export function coerceGatherConfig(raw: unknown): GatherConfig {
  const d = defaultGatherConfig()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return d
  const o = raw as Record<string, unknown>

  const rawResources = Array.isArray(o.resources) ? o.resources : []
  const resources: ResourceEntry[] = GATHER_RESOURCE_ORDER.map((type) => {
    const def = d.resources.find((r) => r.type === type)!
    const found = rawResources.find(
      (r) => r && typeof r === 'object' && (r as Record<string, unknown>).type === type
    ) as Record<string, unknown> | undefined
    if (!found) return { ...def }
    const entry: ResourceEntry = {
      type,
      enabled: bool(found.enabled, def.enabled),
      priority: num(found.priority, def.priority),
      queues: num(found.queues, def.queues)
    }
    if (found.levelPolicy) entry.levelPolicy = coerceLevelPolicy(found.levelPolicy, d.levelPolicy)
    if (found.minStorage !== undefined) entry.minStorage = num(found.minStorage, d.thresholds.minStorage)
    if (found.maxTravelSeconds !== undefined) {
      entry.maxTravelSeconds = num(found.maxTravelSeconds, d.thresholds.maxTravelSeconds)
    }
    return entry
  })

  const th = rec(o.thresholds)
  const qp = rec(o.queuePlan)
  const sr = rec(o.searchRetry)
  const sc = rec(o.schedule)
  const sf = rec(o.safety)

  const backoff = Array.isArray(sc.retryBackoffSeconds)
    ? sc.retryBackoffSeconds.filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
    : []

  return {
    version: GATHER_CONFIG_VERSION,
    enabled: bool(o.enabled, d.enabled),
    resources,
    levelPolicy: coerceLevelPolicy(o.levelPolicy, d.levelPolicy),
    thresholds: {
      minStorage: num(th.minStorage, d.thresholds.minStorage),
      maxTravelSeconds: num(th.maxTravelSeconds, d.thresholds.maxTravelSeconds),
      maxDistanceKm: num(th.maxDistanceKm, d.thresholds.maxDistanceKm),
      requireGathererNone: bool(th.requireGathererNone, d.thresholds.requireGathererNone),
      allianceTerritory: pick<AllianceTerritory>(
        th.allianceTerritory,
        ['own-only', 'own-and-neutral', 'any'],
        d.thresholds.allianceTerritory
      ),
      ownAllianceTag: str(th.ownAllianceTag, d.thresholds.ownAllianceTag).slice(0, 8),
      preferLoadCoversStorage: bool(th.preferLoadCoversStorage, d.thresholds.preferLoadCoversStorage)
    },
    autoGatherUntilEmpty: bool(o.autoGatherUntilEmpty, d.autoGatherUntilEmpty),
    queuePlan: {
      reserveQueues: num(qp.reserveQueues, d.queuePlan.reserveQueues),
      maxConcurrentGather: num(qp.maxConcurrentGather, d.queuePlan.maxConcurrentGather),
      avoidDuplicateTarget: bool(qp.avoidDuplicateTarget, d.queuePlan.avoidDuplicateTarget),
      minCommanderStamina: num(qp.minCommanderStamina, d.queuePlan.minCommanderStamina)
    },
    searchRetry: {
      occupiedRetryLimit: num(sr.occupiedRetryLimit, d.searchRetry.occupiedRetryLimit),
      floorRelaxStep: num(sr.floorRelaxStep, d.searchRetry.floorRelaxStep),
      researchDelayMs: num(sr.researchDelayMs, d.searchRetry.researchDelayMs),
      probeMaxLevel: bool(sr.probeMaxLevel, d.searchRetry.probeMaxLevel),
      probeIntervalMin: num(sr.probeIntervalMin, d.searchRetry.probeIntervalMin)
    },
    schedule: {
      slackSeconds: num(sc.slackSeconds, d.schedule.slackSeconds),
      retryBackoffSeconds: backoff.length > 0 ? backoff : d.schedule.retryBackoffSeconds,
      maxBackoffSeconds: num(sc.maxBackoffSeconds, d.schedule.maxBackoffSeconds),
      calibrateIntervalMin: num(sc.calibrateIntervalMin, d.schedule.calibrateIntervalMin),
      jitterSeconds: num(sc.jitterSeconds, d.schedule.jitterSeconds),
      maxDispatchesPerHour: num(sc.maxDispatchesPerHour, d.schedule.maxDispatchesPerHour),
      giveUpCooldownMin: num(sc.giveUpCooldownMin, d.schedule.giveUpCooldownMin)
    },
    safety: {
      abortOnReconcileFail: bool(sf.abortOnReconcileFail, d.safety.abortOnReconcileFail),
      onUnknownLevel: pick(sf.onUnknownLevel, ['abort', 'acceptCard'] as const, d.safety.onUnknownLevel),
      onUnknownStorage: pick(sf.onUnknownStorage, ['skipPoint', 'accept'] as const, d.safety.onUnknownStorage),
      unknownEtaFallbackSeconds: num(sf.unknownEtaFallbackSeconds, d.safety.unknownEtaFallbackSeconds),
      maxCapturesPerCycle: num(sf.maxCapturesPerCycle, d.safety.maxCapturesPerCycle),
      swipeRetry: num(sf.swipeRetry, d.safety.swipeRetry),
      shotPolicy: pick(sf.shotPolicy, ['never', 'onFail', 'always'] as const, d.safety.shotPolicy)
    }
  }
}

// ── 校验 ────────────────────────────────────────────────────────────────────

export interface ConfigIssue {
  /** error 会挡住保存；warning 只提示。 */
  level: 'error' | 'warning'
  /** 出问题的字段路径，用于把错误挂到对应的表单项上。 */
  path: string
  message: string
}

function range(issues: ConfigIssue[], path: string, label: string, v: number, min: number, max: number): void {
  if (!Number.isFinite(v) || !Number.isInteger(v)) {
    issues.push({ level: 'error', path, message: `${label}必须是整数。` })
    return
  }
  if (v < min || v > max) {
    issues.push({ level: 'error', path, message: `${label}必须在 ${min} ~ ${max} 之间，当前是 ${v}。` })
  }
}

/**
 * 只查上限（下限另有专门的中文说法）。★ 这些上限就是运行期 normalizeGatherConfig 会夹到的边界：
 * 超出就报错挡住保存，而不是让主进程保存时悄悄夹掉。
 */
function atMost(issues: ConfigIssue[], path: string, label: string, v: number, max: number): void {
  if (!Number.isFinite(v) || !Number.isInteger(v)) {
    issues.push({ level: 'error', path, message: `${label}必须是整数。` })
    return
  }
  if (v > max) issues.push({ level: 'error', path, message: `${label}不能超过 ${max}，当前是 ${v}。` })
}

const RESOURCE_NAME: Record<GatherResourceType, string> = { wood: '木材', gold: '金币', iron: '铁矿石', mana: '魔水' }

/**
 * 一份等级策略的校验。全局策略 prefix / who 都是空串（路径就是 levelPolicy.*）；
 * 资源上的覆盖项 prefix = `resources.<type>.`、who = 「木材」单独设置的。
 */
function checkLevelPolicy(issues: ConfigIssue[], prefix: string, who: string, lp: LevelPolicy): void {
  const at = (field: string) => `${prefix}levelPolicy.${field}`
  if (lp.mode === 'relative') {
    range(issues, at('offset'), `${who}相对上限的偏移`, lp.offset, -5, 0)
    range(issues, at('minLevel'), `${who}下限可放宽到的最低值`, lp.minLevel, 1, 15)
    range(issues, at('assumedMaxLevel'), `${who}探测失败时假定的上限`, lp.assumedMaxLevel, 1, 15)
    range(issues, at('maxLevelHardCap'), `${who}上限硬顶`, lp.maxLevelHardCap, 1, 30)
    if (lp.assumedMaxLevel + lp.offset < lp.minLevel) {
      issues.push({
        level: 'warning',
        path: at('offset'),
        message:
          `${who}按当前假定上限 ${lp.assumedMaxLevel} 算出的搜索下限是 ${lp.assumedMaxLevel + lp.offset}，` +
          `已经低于「可放宽到的最低值 ${lp.minLevel}」，放宽机制形同虚设。`
      })
    }
    // ★ 本工程补：运行期归一化会把这两个值夹到硬顶以下，这里提前报出来。
    if (Number.isInteger(lp.maxLevelHardCap) && lp.assumedMaxLevel > lp.maxLevelHardCap) {
      issues.push({
        level: 'error',
        path: at('assumedMaxLevel'),
        message: `${who}「探测失败时假定的上限 ${lp.assumedMaxLevel}」超过了「上限硬顶 ${lp.maxLevelHardCap}」，会被当成识别错误。`
      })
    }
    if (Number.isInteger(lp.maxLevelHardCap) && lp.minLevel > lp.maxLevelHardCap) {
      issues.push({
        level: 'error',
        path: at('minLevel'),
        message: `${who}「下限可放宽到的最低值 ${lp.minLevel}」超过了「上限硬顶 ${lp.maxLevelHardCap}」。`
      })
    }
  } else {
    range(issues, at('level'), `${who}固定搜索下限`, lp.level, 1, 15)
    range(issues, at('minLevel'), `${who}下限可放宽到的最低值`, lp.minLevel, 1, 15)
    range(issues, at('maxLevelHardCap'), `${who}上限硬顶`, (lp as AbsolutePolicy).maxLevelHardCap, 1, 30)
    if (lp.minLevel > lp.level) {
      issues.push({
        level: 'error',
        path: at('minLevel'),
        message: `${who}「可放宽到的最低值 ${lp.minLevel}」比「固定搜索下限 ${lp.level}」还高，放宽将永远无法生效。`
      })
    }
    if (Number.isInteger(lp.maxLevelHardCap) && lp.level > lp.maxLevelHardCap) {
      issues.push({
        level: 'error',
        path: at('level'),
        message: `${who}「固定搜索下限 ${lp.level}」超过了「上限硬顶 ${lp.maxLevelHardCap}」。`
      })
    }
  }
}

/** 返回全部问题（不是遇到第一个就停），方便表单一次性把红字标满。 */
export function validateGatherConfig(cfg: GatherConfig): ConfigIssue[] {
  const issues: ConfigIssue[] = []

  // 资源
  const on = cfg.resources.filter((r) => r.enabled)
  if (cfg.enabled && on.length === 0) {
    issues.push({
      level: 'error',
      path: 'resources',
      message: '已启用自动采集，但一种资源都没选。至少勾一种，否则调度器无事可做。'
    })
  }
  for (const r of cfg.resources) {
    const name = RESOURCE_NAME[r.type] ?? r.type
    range(issues, `resources.${r.type}.priority`, `「${name}」的优先级`, r.priority, 1, 4)
    range(issues, `resources.${r.type}.queues`, `「${name}」的队列数`, r.queues, 0, 5)
    if (r.enabled && r.queues === 0) {
      issues.push({
        level: 'warning',
        path: `resources.${r.type}.queues`,
        message: '这种资源已启用但分配了 0 个队列，等于不会被派兵。要么给它队列，要么关掉它。'
      })
    }
  }
  const dupPriority = new Set<number>()
  for (const r of on) {
    if (dupPriority.has(r.priority)) {
      issues.push({
        level: 'warning',
        path: 'resources',
        message: `有多种资源都用了优先级 ${r.priority}，同优先级之间的先后顺序不确定。`
      })
    }
    dupPriority.add(r.priority)
  }
  const sumQueues = on.reduce((s, r) => s + r.queues, 0)
  if (sumQueues > cfg.queuePlan.maxConcurrentGather) {
    issues.push({
      level: 'warning',
      path: 'queuePlan.maxConcurrentGather',
      message:
        `各资源分配的队列数之和是 ${sumQueues}，超过了「自动采集最多占用 ${cfg.queuePlan.maxConcurrentGather} 个队列」。` +
        '超出部分不会生效，低优先级的资源会一直派不出去。'
    })
  }

  // 等级下限
  checkLevelPolicy(issues, '', '', cfg.levelPolicy)

  // ★ 每种资源单独设置的覆盖项（界面不编辑，但旧配置 / 手改的 JSON / 直接送进来的负载里可能有）：
  //   运行期 normalizeGatherConfig 同样会把它们夹掉，所以一样要在保存时报出来。
  for (const r of cfg.resources) {
    const name = RESOURCE_NAME[r.type] ?? r.type
    const prefix = `resources.${r.type}.`
    const who = `「${name}」单独设置的`
    if (r.levelPolicy) checkLevelPolicy(issues, prefix, who, r.levelPolicy)
    if (r.minStorage !== undefined) {
      if (r.minStorage < 0) issues.push({ level: 'error', path: `${prefix}minStorage`, message: `${who}最低储量不能是负数。` })
      else atMost(issues, `${prefix}minStorage`, `${who}最低储量`, r.minStorage, 100_000_000)
    }
    if (r.maxTravelSeconds !== undefined) {
      if (r.maxTravelSeconds < 0) {
        issues.push({ level: 'error', path: `${prefix}maxTravelSeconds`, message: `${who}最长单程行军不能是负数。填 0 表示不限制。` })
      } else atMost(issues, `${prefix}maxTravelSeconds`, `${who}最长单程行军`, r.maxTravelSeconds, 86_400)
    }
  }

  // 阈值
  const th = cfg.thresholds
  if (th.minStorage < 0) {
    issues.push({ level: 'error', path: 'thresholds.minStorage', message: '最低储量不能是负数。' })
  } else atMost(issues, 'thresholds.minStorage', '最低储量', th.minStorage, 100_000_000)
  if (th.maxTravelSeconds < 0) {
    issues.push({
      level: 'error',
      path: 'thresholds.maxTravelSeconds',
      message: '最长单程行军不能是负数。填 0 表示不限制。'
    })
  } else atMost(issues, 'thresholds.maxTravelSeconds', '最长单程行军', th.maxTravelSeconds, 86_400)
  if (th.maxTravelSeconds > 0 && th.maxTravelSeconds < 30) {
    issues.push({
      level: 'warning',
      path: 'thresholds.maxTravelSeconds',
      message: '最长单程行军小于 30 秒，附近几乎没有点能满足，很容易一直搜不到而放弃本轮。'
    })
  }
  range(issues, 'thresholds.maxDistanceKm', '最远距离', th.maxDistanceKm, 0, 10_000)
  if (!th.requireGathererNone) {
    issues.push({
      level: 'warning',
      path: 'thresholds.requireGathererNone',
      message: '关掉「必须采集者为无」等于允许去抢已被占用的点，实际会派兵失败。除非在调试，不要关。'
    })
  }
  if (th.allianceTerritory !== 'any' && th.ownAllianceTag.trim() === '') {
    issues.push({
      level: 'warning',
      path: 'thresholds.ownAllianceTag',
      message:
        '没有填本方联盟缩写，引擎会自动降级为「只接受所属联盟＝无（中立点）」。' +
        '方向是安全的（少采而不是采错），但会漏掉本方领地上的加成点。'
    })
  }

  // 队列
  range(issues, 'queuePlan.reserveQueues', '预留队列数', cfg.queuePlan.reserveQueues, 0, 5)
  range(issues, 'queuePlan.maxConcurrentGather', '自动采集最多占用的队列数', cfg.queuePlan.maxConcurrentGather, 1, 5)
  range(issues, 'queuePlan.minCommanderStamina', '指挥官耐力下限', cfg.queuePlan.minCommanderStamina, 0, 999)

  // 搜索重试
  range(issues, 'searchRetry.occupiedRetryLimit', '同一下限下最多重搜次数', cfg.searchRetry.occupiedRetryLimit, 1, 20)
  range(issues, 'searchRetry.floorRelaxStep', '每次放宽的级数', cfg.searchRetry.floorRelaxStep, 1, 3)
  range(issues, 'searchRetry.researchDelayMs', '两次搜索之间的间隔', cfg.searchRetry.researchDelayMs, 0, 10_000)
  if (cfg.searchRetry.researchDelayMs < 300) {
    issues.push({
      level: 'warning',
      path: 'searchRetry.researchDelayMs',
      message: '两次搜索间隔小于 300ms，很可能截到地图跳转的动画中间帧，导致模板匹配失败、白白多搜几次。'
    })
  }
  range(issues, 'searchRetry.probeIntervalMin', '重新探测上限的间隔', cfg.searchRetry.probeIntervalMin, 1, 100_000)

  // 调度
  const sc = cfg.schedule
  range(issues, 'schedule.slackSeconds', '唤醒冗余', sc.slackSeconds, 0, 900)
  if (sc.slackSeconds < 15) {
    issues.push({
      level: 'warning',
      path: 'schedule.slackSeconds',
      message:
        '唤醒冗余小于 15 秒。用户明确要求「宁晚勿早」——冗余太小会经常撞上「队伍还没回来」，' +
        '白跑一次开面板（约 750ms/帧）后还要退避重排，反而更慢。'
    })
  }
  if (sc.retryBackoffSeconds.length === 0) {
    issues.push({
      level: 'error',
      path: 'schedule.retryBackoffSeconds',
      message: '退避序列不能为空，否则队列没空时会原地疯狂重试。'
    })
  }
  if (sc.retryBackoffSeconds.some((n) => n < 5)) {
    issues.push({ level: 'error', path: 'schedule.retryBackoffSeconds', message: '退避序列里每一项都必须 ≥ 5 秒。' })
  }
  if (sc.retryBackoffSeconds.some((n) => !Number.isInteger(n) || n > 86_400)) {
    issues.push({
      level: 'error',
      path: 'schedule.retryBackoffSeconds',
      message: '退避序列里每一项都必须是不超过 86400 的整数秒。'
    })
  }
  for (let i = 1; i < sc.retryBackoffSeconds.length; i++) {
    if (sc.retryBackoffSeconds[i]! < sc.retryBackoffSeconds[i - 1]!) {
      issues.push({
        level: 'warning',
        path: 'schedule.retryBackoffSeconds',
        message: '退避序列不是递增的，指数退避的意义会被削弱。'
      })
      break
    }
  }
  if (sc.maxBackoffSeconds < 30) {
    issues.push({ level: 'error', path: 'schedule.maxBackoffSeconds', message: '退避上限不能小于 30 秒。' })
  } else atMost(issues, 'schedule.maxBackoffSeconds', '退避上限', sc.maxBackoffSeconds, 86_400)
  if (sc.calibrateIntervalMin < 1) {
    issues.push({ level: 'error', path: 'schedule.calibrateIntervalMin', message: '兜底校准间隔至少 1 分钟。' })
  } else atMost(issues, 'schedule.calibrateIntervalMin', '兜底校准间隔', sc.calibrateIntervalMin, 1440)
  if (sc.jitterSeconds < 0) {
    issues.push({ level: 'error', path: 'schedule.jitterSeconds', message: '错峰抖动不能是负数。' })
  } else atMost(issues, 'schedule.jitterSeconds', '错峰抖动', sc.jitterSeconds, 600)
  range(issues, 'schedule.maxDispatchesPerHour', '每小时派兵次数上限', sc.maxDispatchesPerHour, 0, 1000)
  if (sc.giveUpCooldownMin < 1) {
    issues.push({ level: 'error', path: 'schedule.giveUpCooldownMin', message: '放弃后的冷却至少 1 分钟。' })
  } else atMost(issues, 'schedule.giveUpCooldownMin', '放弃后的冷却', sc.giveUpCooldownMin, 1440)

  // 安全
  if (cfg.safety.unknownEtaFallbackSeconds < 60) {
    issues.push({
      level: 'error',
      path: 'safety.unknownEtaFallbackSeconds',
      message: '倒计时识别失败时的保守 ETA 至少 60 秒（宁晚勿早）。'
    })
  } else atMost(issues, 'safety.unknownEtaFallbackSeconds', '倒计时识别失败时的保守 ETA', cfg.safety.unknownEtaFallbackSeconds, 86_400)
  if (cfg.safety.maxCapturesPerCycle < 6) {
    issues.push({
      level: 'error',
      path: 'safety.maxCapturesPerCycle',
      message: '单轮派兵截图上限至少 6 张，低于这个数一轮流程根本走不完。'
    })
  } else atMost(issues, 'safety.maxCapturesPerCycle', '单轮派兵截图上限', cfg.safety.maxCapturesPerCycle, 500)
  range(issues, 'safety.swipeRetry', '滑动重试次数', cfg.safety.swipeRetry, 0, 10)
  if (cfg.safety.swipeRetry === 0) {
    issues.push({
      level: 'warning',
      path: 'safety.swipeRetry',
      message:
        '滑动重试设为 0。实测 adb input swipe 会偶发 SecurityException: INJECT_EVENTS，重试即成功；' +
        '设 0 等于把这种偶发失败直接变成整轮失败。'
    })
  }
  if (!cfg.safety.abortOnReconcileFail) {
    issues.push({
      level: 'warning',
      path: 'safety.abortOnReconcileFail',
      message: '关掉「对账复验失败即中止」后，「自动采集至清空」的勾选框可能被反复点开点关。建议保持开启。'
    })
  }

  return issues
}

/** 有没有会挡住保存的错误。 */
export function hasBlockingIssue(issues: readonly ConfigIssue[]): boolean {
  return issues.some((i) => i.level === 'error')
}

/**
 * 把会挡住保存的错误拼成一句中文（主进程拒绝保存时的报错）。没有错误返回 null。
 * 最多列 6 条，其余说「等 N 处」，免得一条报错把整个提示框撑满。
 */
export function describeBlockingIssues(issues: readonly ConfigIssue[]): string | null {
  const errors = issues.filter((i) => i.level === 'error')
  if (errors.length === 0) return null
  const shown = errors.slice(0, 6).map((i) => i.message.replace(/。$/, ''))
  const more = errors.length > shown.length ? `等 ${errors.length} 处` : `共 ${errors.length} 处`
  return `采集配置有错误（${more}），没有保存：${shown.join('；')}。`
}

// ── 原始输入的类型把关（主进程保存 / 导入用）────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function shortJson(v: unknown): string {
  let text: string
  try {
    text = JSON.stringify(v) ?? String(v)
  } catch {
    text = String(v)
  }
  return text.length > 40 ? `${text.slice(0, 40)}…` : text
}

/** 叶子字段：原始值存在、却和还原后的值不同，说明 coerceGatherConfig 把它换掉（类型不对）或取整了。 */
function leafIssue(issues: ConfigIssue[], path: string, raw: unknown, coerced: unknown): void {
  if (raw === undefined || raw === coerced) return
  let message: string
  if (typeof coerced === 'number') {
    message = typeof raw === 'number' && Number.isFinite(raw)
      ? `「${path}」必须是整数，当前是 ${raw}。`
      : `「${path}」必须是数字，当前是 ${shortJson(raw)}。`
  } else if (typeof coerced === 'boolean') {
    message = `「${path}」只能是 true 或 false，当前是 ${shortJson(raw)}。`
  } else {
    message = typeof raw === 'string'
      ? `「${path}」的取值 ${shortJson(raw)} 无效（不在可选范围内或超长）。`
      : `「${path}」必须是文字，当前是 ${shortJson(raw)}。`
  }
  issues.push({ level: 'error', path, message })
}

function diffNode(issues: ConfigIssue[], path: string, raw: unknown, coerced: unknown): void {
  if (raw === undefined) return
  if (Array.isArray(coerced)) {
    if (!Array.isArray(raw)) {
      issues.push({ level: 'error', path, message: `「${path}」必须是一个数组，当前是 ${shortJson(raw)}。` })
      return
    }
    if (raw.length === 0) {
      issues.push({ level: 'error', path, message: `「${path}」不能为空。` })
      return
    }
    if (raw.length !== coerced.length || raw.some((v, i) => v !== coerced[i])) {
      issues.push({ level: 'error', path, message: `「${path}」里每一项都必须是数字，当前是 ${shortJson(raw)}。` })
    }
    return
  }
  if (isPlainObject(coerced)) {
    if (!isPlainObject(raw)) {
      issues.push({ level: 'error', path, message: `「${path}」必须是一个对象，当前是 ${shortJson(raw)}。` })
      return
    }
    for (const key of Object.keys(coerced)) diffNode(issues, path ? `${path}.${key}` : key, raw[key], coerced[key])
    return
  }
  leafIssue(issues, path, raw, coerced)
}

/**
 * 原始输入里「认得的字段」类型对不对。coerceGatherConfig 为了表单好用，会把类型不对的值换成默认值、
 * 把小数取整、丢掉认不出的资源 —— 界面上看得见，可 IPC 直接送进来的负载（手改的 JSON、旧版本存下来的）
 * 就被悄悄改掉了。这里把每一处「被换掉的」都报成错误（路径与 validateGatherConfig 同一套：资源按类型）。
 */
export function gatherConfigTypeIssues(raw: unknown): ConfigIssue[] {
  const issues: ConfigIssue[] = []
  if (!isPlainObject(raw)) {
    issues.push({ level: 'error', path: '', message: '采集配置必须是一个 JSON 对象。' })
    return issues
  }
  const coerced = coerceGatherConfig(raw)
  for (const key of Object.keys(coerced) as (keyof GatherConfig)[]) {
    if (key === 'version' || key === 'resources') continue
    diffNode(issues, key, raw[key], coerced[key])
  }
  if (raw.version !== undefined && raw.version !== GATHER_CONFIG_VERSION) {
    issues.push({ level: 'error', path: 'version', message: `配置版本是 ${shortJson(raw.version)}，只认 version = ${GATHER_CONFIG_VERSION}。` })
  }
  if (raw.resources === undefined) return issues
  if (!Array.isArray(raw.resources)) {
    issues.push({ level: 'error', path: 'resources', message: `「resources」必须是一个数组，当前是 ${shortJson(raw.resources)}。` })
    return issues
  }
  const seen = new Set<string>()
  for (const entry of raw.resources as unknown[]) {
    const type = isPlainObject(entry) ? entry.type : undefined
    if (typeof type !== 'string' || !(GATHER_RESOURCE_ORDER as readonly string[]).includes(type)) {
      issues.push({ level: 'error', path: 'resources', message: `认不出的资源条目 ${shortJson(entry)}：type 只能是 wood / gold / iron / mana。` })
      continue
    }
    if (seen.has(type)) {
      issues.push({ level: 'error', path: `resources.${type}`, message: `资源「${RESOURCE_NAME[type as GatherResourceType]}」出现了不止一次。` })
      continue
    }
    seen.add(type)
    const found = coerced.resources.find((r) => r.type === type)!
    const { type: _type, ...fields } = found
    diffNode(issues, `resources.${type}`, entry, fields)
  }
  return issues
}

/**
 * 保存闸门：原始输入的类型问题 + 还原后的取值问题（主进程保存采集配置前调它，有错误就拒绝，
 * 存下去的是**这份还原后的文档**再归一化，不会出现「校验过的是一份、存下去的是另一份」）。
 */
export function validateGatherConfigInput(raw: unknown): ConfigIssue[] {
  const typeIssues = gatherConfigTypeIssues(raw)
  if (!isPlainObject(raw)) return typeIssues
  return [...typeIssues, ...validateGatherConfig(coerceGatherConfig(raw))]
}

// ── 便于界面解释的派生说明 ──────────────────────────────────────────────────

/**
 * 用一句人话说明当前等级策略会搜到什么。
 * @param probedMaxLv 已探测到的等级上限；没探测过传 null，用 assumedMaxLevel。
 */
export function describeLevelPolicy(policy: LevelPolicy, probedMaxLv: number | null): string {
  if (policy.mode === 'absolute') {
    return (
      `固定按 ${policy.level} 级作为搜索下限去搜：${policy.level} 级及以上的点都算合格，` +
      `搜到 ${policy.level + 1}、${policy.level + 2} 级是好事，不是失败。` +
      (policy.allowRelax
        ? `连续搜不到时会把下限一路放宽到 ${policy.minLevel} 级。`
        : '已关闭放宽，搜不到就直接放弃本轮。')
    )
  }
  const maxLv = probedMaxLv ?? policy.assumedMaxLevel
  const floor = maxLv + policy.offset
  return (
    `当前等级上限按 ${maxLv} 计（${probedMaxLv === null ? '未探测，用假定值' : '已从滑杆探测'}），` +
    `搜索下限 = ${maxLv} ${policy.offset >= 0 ? '+' : '−'} ${Math.abs(policy.offset)} = ${floor} 级。` +
    `实际会采到 ${floor} 级及以上的点，采到 ${maxLv} 级收益更高、属于正常结果。` +
    `连续搜不到时下限逐步放宽，最低放到 ${policy.minLevel} 级。`
  )
}

/** 把储量数字写成「30 万」这种好读的形式。 */
export function formatStorage(n: number): string {
  if (n <= 0) return '不限制'
  if (n >= 100000000) return `${(n / 100000000).toFixed(2).replace(/\.?0+$/, '')} 亿`
  if (n >= 10000) return `${(n / 10000).toFixed(1).replace(/\.0$/, '')} 万`
  return String(n)
}

/** 秒 -> 「10 分 0 秒」。 */
export function formatSeconds(n: number): string {
  if (n <= 0) return '不限制'
  const m = Math.floor(n / 60)
  const s = n % 60
  if (m === 0) return `${s} 秒`
  return s === 0 ? `${m} 分钟` : `${m} 分 ${s} 秒`
}

// ── 导入 / 导出 ─────────────────────────────────────────────────────────────

/** 导出成便于粘贴/备份的 JSON 文本。 */
export function exportGatherConfig(config: GatherConfig): string {
  return JSON.stringify(config, null, 2)
}

/** 从粘贴进来的 JSON 文本导入。格式不对时抛中文错误；缺失的字段补默认值（不夹值，越界的交给校验报）。 */
export function importGatherConfig(text: string): GatherConfig {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    throw new Error(`不是合法的 JSON：${e instanceof Error ? e.message : String(e)}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('顶层必须是一个 JSON 对象。')
  }
  const version = (parsed as Record<string, unknown>).version
  if (version !== undefined && version !== 2) {
    throw new Error(`配置版本是 ${String(version)}，当前面板只认 version = 2（缺失的字段会补默认值）。`)
  }
  return coerceGatherConfig(parsed)
}
