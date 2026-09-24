/**
 * 本地递推：把一次面板采样换算成「绝对时刻」的队列状态，并算出下一次该几点去看。
 * 移植自原版 src/main/scheduler/state.ts。
 *
 * 全是纯函数，不碰 IO、不碰 electron —— 时间语义是整个调度里最容易算错的地方，
 * 独立出来才好推敲、好测试。
 *
 * 时间语义（务必分清，写反了就会在队伍还没回来的时候去派兵）：
 *   gatherDoneAt = sampledAt + 采集剩余      ← 面板上「采集中 HH:MM:SS」归零的时刻（含深夜疲惫换算）
 *   freeAt       = gatherDoneAt + travelTime ← 队列**真正释放**的时刻（采集完自动回城）
 *   唤醒时刻      = freeAt + slack            ← 宁晚勿早
 */

import {
  MARCH_STATUS_TEXT,
  type InstanceQueueState,
  type MarchResourceType,
  type MarchState,
  type PanelSample,
  type RowSample,
  type SchedulerConfig,
  type TravelTimeSource
} from './model.js'
import {
  FATIGUE_BOUNDARY_HOURS_CST,
  fatigueAdjustedDoneAt,
  isFatigueExempt,
  nextCstBoundary
} from './fatigue.js'

/** 派兵时从「创建部队」页行军按钮上读到的单程耗时。由采集流程通过 noteDispatch 交进来。 */
export interface TravelHint {
  travelTimeMs: number
  source: TravelTimeSource
  /** 记录时刻，用来挑「最近一次派兵」。 */
  at: number
  /** 目标坐标，能对上就优先按坐标匹配。 */
  coord: string | null
  /** 派的是什么资源（面板派兵时记下）；行军中/返回中的行靠它显示资源类型。 */
  resourceType?: MarchResourceType | null
}

/** 每个实例只留最近几条派兵记录：够用，且不会让状态文件无限长大。 */
export const MAX_TRAVEL_HINTS = 8

export function emptyInstanceState(instanceIndex: number): InstanceQueueState {
  return {
    instanceIndex,
    accountId: null,
    queueUsed: null,
    queueTotal: null,
    marches: [],
    lastSampledAt: 0,
    lastSampleOk: false,
    error: null,
    warnings: [],
    auto: false,
    sampling: false,
    nextWakeAt: null,
    nextWakeReason: null,
    backoffStep: 0
  }
}

/**
 * 给某一行挑一个 travelTime。
 * 优先级：坐标对得上的派兵记录 > 最近一次派兵记录 > 由去程倒计时观察到的下限 > 配置兜底。
 */
export function pickTravel(
  row: RowSample,
  hints: readonly TravelHint[],
  config: SchedulerConfig
): { ms: number; source: TravelTimeSource; resourceType: MarchResourceType | null } {
  if (row.targetCoord) {
    const byCoord = hints
      .filter((h) => h.coord && h.coord === row.targetCoord)
      .sort((a, b) => b.at - a.at)[0]
    if (byCoord) {
      return {
        ms: byCoord.travelTimeMs,
        source: byCoord.source,
        resourceType: byCoord.resourceType ?? null
      }
    }
  }
  const latest = [...hints].sort((a, b) => b.at - a.at)[0]
  // ★ 资源类型只在坐标对上时才可信：最近一次派兵不一定是这一行。
  if (latest) return { ms: latest.travelTimeMs, source: latest.source, resourceType: null }

  // 去程还没走完时，剩余时间是单程耗时的**下限**，比配置兜底更贴近真实。
  if (row.status === 'gatherMarching' && row.remainingMs != null) {
    return {
      ms: Math.max(row.remainingMs, config.defaultTravelSeconds * 1000),
      source: 'observed',
      resourceType: null
    }
  }
  // 一条派兵记录都对不上：多半是手动派出的（或面板重装后记录丢了），只能按兜底值估。
  return { ms: config.defaultTravelSeconds * 1000, source: 'unrecorded', resourceType: null }
}

/** 把一行采样换算成带绝对时刻的 MarchState。 */
export function toMarchState(
  row: RowSample,
  sampledAt: number,
  hints: readonly TravelHint[],
  config: SchedulerConfig
): MarchState {
  const base: MarchState = {
    slot: row.slot,
    status: row.status,
    statusText: row.statusText || MARCH_STATUS_TEXT[row.status],
    targetCoord: row.targetCoord,
    troopCount: row.troopCount,
    commanders: row.commanders.map((c) => ({ ...c })),
    remainingMs: row.remainingMs,
    timerEndsAt: null,
    gatherDoneAt: null,
    freeAt: null,
    travelTimeMs: null,
    travelTimeSource: 'fallback',
    resourceType: null,
    fillRatio: null,
    sampledAt,
    warning: row.warning
  }

  if (row.status === 'idle') return base

  const travel = pickTravel(row, hints, config)
  base.travelTimeMs = travel.ms
  base.travelTimeSource = travel.source
  // 采集中的行按缩略图识别；行军中/返回中的行缩略图是部队图，只能靠派兵记账按坐标对上。
  base.resourceType = row.resourceType ?? travel.resourceType ?? null
  base.fillRatio = row.fillRatio ?? null

  const endsAt = row.remainingMs == null ? null : sampledAt + row.remainingMs
  base.timerEndsAt = endsAt

  switch (row.status) {
    case 'gathering': {
      // ★ 深夜疲惫换算：北京时间 0-9 点采集速度 -80%，而**游戏显示的倒计时是按当前速度算的**，
      //   不预判速度变化。所以显示值必须按速度比分段换算成真实完成时刻。
      //   实测：北京 22:00 读到「剩 4 小时」，实际要到次日 09:12 才完成（差 7 小时 12 分）。
      //   不换算的话调度会在 02:00 醒来扑空，然后按退避每 5 分钟开一次面板，整夜白开约 84 次。
      //   行军时间不受疲劳影响（机制只写了「资源采集速度」），所以 travel.ms 原样相加。
      const exempt = isFatigueExempt(base.resourceType)
      const adjusted =
        row.remainingMs == null
          ? null
          : fatigueAdjustedDoneAt(sampledAt, row.remainingMs, { exempt })
      base.gatherDoneAt = adjusted
      base.freeAt =
        adjusted == null ? sampledAt + config.unknownEtaFallbackSeconds * 1000 : adjusted + travel.ms
      if (adjusted == null) {
        base.warning =
          base.warning ??
          '采集剩余时间没读出来，已按兜底 ETA 排期，会在到点后重新读一次面板校准。'
      } else if (endsAt != null && Math.abs(adjusted - endsAt) > 60_000) {
        // 换算与显示值差得多时明说，免得用户对不上面板上的数字。
        const dh = ((adjusted - endsAt) / 3_600_000).toFixed(1)
        base.warning =
          base.warning ??
          `已按深夜疲惫（采集 -80%）换算完成时刻：比游戏显示的倒计时${Number(dh) > 0 ? '晚' : '早'} ${Math.abs(Number(dh))} 小时。`
      }
      break
    }

    case 'gatherMarching':
      // 去程结束后才开始采集，而**采集时长面板此刻并不显示**，
      // 所以这时候 freeAt 是真的未知。绝不能拿去程时间去凑一个假的 freeAt，
      // 只能等抵达后再读一次面板。
      base.gatherDoneAt = null
      base.freeAt = null
      break

    case 'returning':
      // 回到城的那一刻队列就释放了。
      base.gatherDoneAt = sampledAt
      base.freeAt = endsAt ?? sampledAt + config.unknownEtaFallbackSeconds * 1000
      break

    default:
      base.freeAt = sampledAt + config.unknownEtaFallbackSeconds * 1000
      break
  }
  return base
}

/** 把一次采样合并进实例状态（返回新对象，不改原对象）。 */
export function applySample(
  prev: InstanceQueueState,
  sample: PanelSample,
  hints: readonly TravelHint[],
  config: SchedulerConfig
): InstanceQueueState {
  return {
    ...prev,
    queueUsed: sample.queueUsed,
    queueTotal: sample.queueTotal,
    marches: sample.rows.map((r) => toMarchState(r, sample.sampledAt, hints, config)),
    lastSampledAt: sample.sampledAt,
    lastSampleOk: true,
    error: null,
    warnings: [...sample.warnings],
    sampling: false
  }
}

/**
 * 「上次在外、这次不见了」的队伍（数据统计据此记「完成趟数」）。
 * 只比对目标坐标：上次 status!=='idle' 且有坐标、本次面板里没有相同坐标的行。
 * 面板行重排 / 坐标读不出都会漏计或误计，所以它只是参考指标，主指标是派兵记账。
 */
export function marchesGone(
  prev: Pick<InstanceQueueState, 'marches'>,
  sample: Pick<PanelSample, 'rows'>
): Array<{ slot: number; coord: string | null }> {
  const stillThere = new Set(
    sample.rows
      .map((r) => r.targetCoord)
      .filter((c): c is string => typeof c === 'string' && c !== '')
  )
  return prev.marches
    .filter((m) => m.status !== 'idle' && m.targetCoord && !stillThere.has(m.targetCoord))
    .map((m) => ({ slot: m.slot, coord: m.targetCoord }))
}

// ── 下一次该几点去看 ──────────────────────────────────────────────────────

export interface WakePlan {
  dueAt: number
  reason: string
}

/** 健康探针唤醒的 reason 字面量。onWake 用它分流，绝不要改成别的字符串。 */
export const HEALTH_PROBE_REASON = '健康探针'

export interface PlanExtras {
  /** 上一次健康探针的时刻（运行期内存态，不落盘）。 */
  lastHealthProbeAt?: number
  /** 抖动用的随机源，默认 Math.random（可注入，便于离线自检）。 */
  random?: () => number
}

/**
 * 排下一次唤醒。
 *
 * 候选来源：
 *   · 某支队 freeAt + slack             —— 队列释放校验（主线）
 *   · 去程队伍 timerEndsAt + slack      —— 抵达后读采集时长（此前 freeAt 未知）
 *   · 队列有空位 / 队列状态未知          —— 现在就去
 *   · 北京时间 0 点 / 9 点 + 30s         —— 疲劳期边界重读（有队伍在外时）
 *   · lastSampledAt + 校准间隔          —— 兜底纠偏
 *   · 健康探针                           —— 给顶号 / 游戏退出的发现延迟设上限
 * 取最早的一个；再加一点随机抖动错峰，并保证不早于 now + max(30s, minSampleIntervalMs)。
 *
 * @param now 传进来而不是内部取，是为了让这个函数可测。
 */
export function planNextWake(
  state: InstanceQueueState,
  config: SchedulerConfig,
  now: number,
  extras: PlanExtras = {}
): WakePlan | null {
  if (!state.auto) return null

  const slack = Math.max(0, config.slackSeconds) * 1000
  const candidates: WakePlan[] = []

  for (const m of state.marches) {
    if (m.status === 'idle') continue
    if (m.status === 'gatherMarching' && m.timerEndsAt != null) {
      candidates.push({
        dueAt: m.timerEndsAt + slack,
        reason: `第 ${m.slot} 队抵达资源点后读采集时长`
      })
      continue
    }
    if (m.freeAt != null) {
      candidates.push({ dueAt: m.freeAt + slack, reason: `第 ${m.slot} 队队列释放校验` })
    }
  }

  // ★ 队列现在就有空位 —— 这本身就是「该派兵了」的信号，必须作为候选。
  //   少了它会出现这个真实故障：开启自动调度时若已有空位（例如刚起面板、或部分队伍早就回来了），
  //   最早的候选只剩 15 分钟后的「周期校准」，于是干等 15 分钟才派第一支队；
  //   更糟的是用户每点一次「立即采样」都会刷新 lastSampledAt，把校准再往后推 15 分钟 ——
  //   越刷新越不派兵。
  //   不必担心空转：地板值 max(30s, minSampleIntervalMs) 兜住频率，
  //   派完仍有空位时 onWake 会走退避阶梯（30s→60s→120s→240s→300s）。
  if (hasFreeSlot(state) === true) {
    candidates.push({ dueAt: now, reason: '队列有空位，尽快派遣' })
  }
  // ★ 队列状态未知（新接入的实例、或从没成功读过面板）：不能干等 15 分钟的周期校准，
  //   先读一次面板把 N/M 拿到 —— 实测新开第二个实例后它空转了整整一个校准周期。
  if (hasFreeSlot(state) === null) {
    candidates.push({ dueAt: now, reason: '队列状态未知，先读一次面板' })
  }

  // ★ 疲劳期边界：跨过它倒计时就不再线性，必须主动重读一次，
  //   否则要等下一次周期校准（默认 15 分钟）才发现队伍早回来了。
  //   只在有队伍在外时才排 —— 没队伍就没有倒计时需要纠正。
  //   +30 秒是留给游戏自己把速度切过去。
  if (state.marches.some((m) => m.status !== 'idle')) {
    for (const h of FATIGUE_BOUNDARY_HOURS_CST) {
      candidates.push({
        dueAt: nextCstBoundary(now, h) + 30_000,
        reason: h === 9 ? '疲劳期结束，重读倒计时' : '进入疲劳期，重读倒计时'
      })
    }
  }

  const calibrateAt =
    (state.lastSampledAt || now) + Math.max(1, config.calibrateIntervalMin) * 60_000
  candidates.push({ dueAt: calibrateAt, reason: '周期校准' })

  // ★ 健康探针：给「顶号 / 游戏退出」的发现延迟设上限。
  //   实测故障：队列 5/5 时下一次采样要等队列释放（可能几小时），顶号了整段时间无人发现；
  //   等到采样了也只能走「连续 3 次认不出界面」的慢路径（再加 30s+60s 退避）。
  //   探针只截一帧不开面板（≈750ms），3 分钟一次可以接受。
  if (config.healthProbeIntervalMin > 0) {
    const last = extras.lastHealthProbeAt ?? (state.lastSampledAt || now)
    candidates.push({
      dueAt: last + config.healthProbeIntervalMin * 60_000,
      reason: HEALTH_PROBE_REASON
    })
  }

  candidates.sort((a, b) => a.dueAt - b.dueAt)
  const pick = candidates[0]
  if (!pick) return null

  const random = extras.random ?? Math.random
  const jitter = Math.floor(random() * Math.max(0, config.jitterSeconds) * 1000)
  // ★ 地板值不能只用 minSampleIntervalMs（默认 8s）：已经过期的 freeAt 会被压到 8 秒后，
  //   队列迟迟不空时就变成每 8 秒开一次面板。地板至少 30s，剩下的交给退避阶梯。
  const floor = now + Math.max(30_000, config.minSampleIntervalMs)
  return { dueAt: Math.max(pick.dueAt + jitter, floor), reason: pick.reason }
}

/** 退避第 step 次（step 从 1 起）该等多久（毫秒）。 */
export function backoffMs(config: SchedulerConfig, step: number): number {
  const ladder = config.retryBackoffSeconds.length > 0 ? config.retryBackoffSeconds : [30, 60, 120]
  const idx = Math.min(Math.max(1, step), ladder.length) - 1
  const sec = Math.min(ladder[idx] ?? 30, Math.max(1, config.maxBackoffSeconds))
  return sec * 1000
}

/**
 * 现在有没有空队列位可以派兵。
 * 读不出 N/M 时返回 null —— **不要当成有空位**，那会让调度器一直去撞墙。
 */
export function hasFreeSlot(state: Pick<InstanceQueueState, 'queueUsed' | 'queueTotal'>): boolean | null {
  if (state.queueUsed == null || state.queueTotal == null) return null
  return state.queueUsed < state.queueTotal
}
