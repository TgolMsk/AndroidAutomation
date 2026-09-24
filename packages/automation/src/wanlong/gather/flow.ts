/**
 * 「自动采集资源」主状态机（G0~G16 + 唤醒短流程）。
 *
 * 一轮（cycle）= 从「确认在世界地图」开始，到「派完能派的队并算出下次唤醒时刻」为止。
 * 调用方（ETA 调度器）只需要：
 *     const r = await runGatherCycle({ io, templates, config, state })
 *     saveState(r.state); scheduleWakeAt(r.nextWakeAt)
 *
 * 状态编号与 packages/automation/game-data/wanlong/gather-flow.json 一一对应：
 *   G0  确保在世界地图                G1  读部队管理面板（队列 N/M、各队 ETA）
 *   G2  判定是否派兵（纯计算）        G3  打开搜索面板
 *   G4  选资源分类（对账式）          G5  探测等级上限
 *   G6  把滑杆调到搜索下限            G7  点搜索
 *   G8  校验资源点卡片                G9  对账「自动采集至清空」
 *   G10 点采集                        G11 进创建部队页
 *   G12 一键采集编成                  G13 读 travelTime / 兵力 / 负载量
 *   G14 行军                          G15 确认队列 +1
 *   G16 记账并算下次唤醒
 *
 * ★★ 反复强调、也是最容易写错的一条：卡片等级判据是 `>= searchFloor`，不是 `==`。
 *    具体理由与真机证据写在 card.ts 的文件头与 validateCard 里。
 */

import { AppError, serializeError, type SerializedError } from '../errors.js'
import type { RawFrame } from '../../contracts.js'
import {
  effectiveLevelPolicy,
  normalizeGatherConfig,
  RESOURCE_LABEL,
  type GatherConfig,
  type ResourceEntry
} from '../config.js'
import { readCard, reconcileAutoGather, validateCard, waitForCard } from './card.js'
import { dispatchTroop } from './dispatch.js'
import { backoffSeconds, planWake, toMarchRecords } from './eta.js'
import {
  WORLD_MAP_TEMPLATES,
  closeResourceCard,
  closeTroopPanel,
  closeSearchPanel,
  ensureWorldMap
} from './navigation.js'
import {
  effectiveMaxLevel,
  expireNoResult,
  isMaxLevelStale,
  learnFromSearch,
  levelMemoryOf,
  onCard,
  onNoCard,
  onUnsuitable,
  planStartFloor,
  recordMaxLevel,
  sanitizeLevelMemory,
  startFloorSearch,
  type FloorStep
} from './levelMemory.js'
import {
  findSearchAnchor,
  openSearchPanel,
  probeMaxLevel,
  selectCategory,
  setSearchFloor,
  tapSearch,
  type SearchAnchor
} from './searchPanel.js'
import {
  GatherHalt,
  GatherSession,
  type GatherIo,
  type GatherLogger,
  type UnknownScreenAdvisor
} from './session.js'
import { type GatherTemplates } from './templates.js'
import { emptyTroopPanel, openTroopPanel, readTroopPanel } from './troopPanel.js'
import {
  createRuntimeState,
  type DispatchRecord,
  type GatherCycleResult,
  type GatherOutcome,
  type GatherRuntimeState,
  type TroopPanelReading
} from './types.js'

/**
 * 一次顺利的派兵实测要 17 帧（离线回放真机截图量得；设计文档估的 9~12 偏乐观）。
 * 2026-09-19 加了两道复验：waitForCard 的停稳复验（顺利时 +1、最坏 +2，有硬上限
 * CARD_SETTLE_ATTEMPTS）与 G10 点采集前的重新定位（+1）。所以顺利 19、最坏 20。
 * 剩余配额少于这个数就不再开新的派兵。
 */
const CAPTURES_PER_DISPATCH = 20

export interface RunGatherCycleOptions {
  io: GatherIo
  templates: GatherTemplates
  /** 可以是部分配置，内部会归一化。 */
  config?: Parameters<typeof normalizeGatherConfig>[0]
  /** 上一轮的运行期状态。首次调用可不传。 */
  state?: GatherRuntimeState
  log?: GatherLogger
  onShot?: (label: string, raw: RawFrame) => void | Promise<void>
  signal?: AbortSignal
  now?: () => number
  random?: () => number
  shrink?: number
  /** 认不出界面时的外部顾问（AI），可选。 */
  advisor?: UnknownScreenAdvisor
  instanceIndex?: number | null
}

/** 跑一轮自动采集。**不抛异常**：一切结果都体现在返回值里（含 error 字段）。 */
export async function runGatherCycle(opts: RunGatherCycleOptions): Promise<GatherCycleResult> {
  const cfg = normalizeGatherConfig(opts.config)
  const state = cloneState(opts.state)
  const now = opts.now ?? ((): number => Date.now())
  const random = opts.random ?? Math.random

  const s = new GatherSession({
    io: opts.io,
    templates: opts.templates,
    config: cfg,
    log: opts.log,
    onShot: opts.onShot,
    signal: opts.signal,
    now,
    shrink: opts.shrink,
    advisor: opts.advisor,
    instanceIndex: opts.instanceIndex ?? null
  })

  const dispatched: DispatchRecord[] = []
  let panel: TroopPanelReading | null = null
  let outcome: GatherOutcome = 'noResourceWanted'
  let message = ''
  let error: SerializedError | undefined

  try {
    if (!cfg.enabled) {
      return finish(
        s,
        state,
        dispatched,
        panel,
        'noResourceWanted',
        '自动采集未启用。',
        null,
        '未启用，不安排唤醒。'
      )
    }

    // 放弃后的冷却期。
    if (state.giveUpUntil && now() < state.giveUpUntil) {
      const left = Math.round((state.giveUpUntil - now()) / 1000)
      return finish(
        s,
        state,
        dispatched,
        panel,
        'giveUp',
        `上一轮搜不到可用资源点，仍在冷却中（还剩 ${left} 秒）。`,
        state.giveUpUntil,
        '冷却结束后再试。'
      )
    }

    // 熔断：每小时派兵次数。
    state.dispatchTimestamps = state.dispatchTimestamps.filter((t) => now() - t < 3_600_000)
    const limit = cfg.schedule.maxDispatchesPerHour
    if (limit > 0 && state.dispatchTimestamps.length >= limit) {
      const oldest = Math.min(...state.dispatchTimestamps)
      const at = oldest + 3_600_000
      return finish(
        s,
        state,
        dispatched,
        panel,
        'circuitBroken',
        `最近一小时已派兵 ${state.dispatchTimestamps.length} 次，达到熔断上限 ${limit} 次，` +
          '暂停派兵（这条保护是为了在识别出错疯狂重试时兜底）。',
        at,
        '等本小时窗口滑过后再试。'
      )
    }

    // ── G0 / G1 ────────────────────────────────────────────────────────
    await ensureWorldMap(s)
    panel = (await openTroopPanel(s)) ? await readTroopPanel(s) : emptyTroopPanel(s)
    for (const w of panel.warnings) s.warn(w)
    state.inFlight = toMarchRecords(panel, state, cfg)
    state.lastPanelSampledAt = panel.sampledAt

    // （原 G2「耐力硬前置」已删除：2026-09-10 用户确认该游戏的指挥官耐力只用于打架，不影响采集。）

    // ── 主循环：能派几支派几支 ─────────────────────────────────────────
    for (;;) {
      s.ensureAlive()

      const slots = freeSlots(panel, cfg, state)
      if (slots <= 0) {
        outcome = dispatched.length > 0 ? 'dispatched' : 'queueFull'
        message =
          dispatched.length > 0
            ? `本轮派出 ${dispatched.length} 支队伍，队列已排满（${panel.queueUsed}/${panel.queueTotal}）。`
            : `行军队列没有空位（${panel.queueUsed}/${panel.queueTotal}，预留 ${cfg.queuePlan.reserveQueues}）。`
        break
      }

      const entry = pickResource(cfg, state, dispatched)
      if (!entry) {
        outcome = dispatched.length > 0 ? 'dispatched' : 'noResourceWanted'
        message =
          dispatched.length > 0
            ? `本轮派出 ${dispatched.length} 支队伍，各资源的队列配额都已满足。`
            : '每种资源的队列配额都已满足，本轮无需派兵。'
        break
      }

      if (s.captures + CAPTURES_PER_DISPATCH > cfg.safety.maxCapturesPerCycle) {
        s.log(
          'info',
          `本轮截图配额只剩 ${cfg.safety.maxCapturesPerCycle - s.captures} 张，不足以再派一支队，收尾。`
        )
        outcome = dispatched.length > 0 ? 'dispatched' : 'queueFull'
        message =
          dispatched.length > 0
            ? `本轮派出 ${dispatched.length} 支队伍，截图配额用尽，剩下的下一轮再派。`
            : '截图配额不足以完成一次派兵，本轮先收尾。'
        break
      }

      const before = panel.queueUsed
      const one = await dispatchOne(s, cfg, state, entry)

      if (one.kind === 'giveUp') {
        state.giveUpUntil = now() + cfg.schedule.giveUpCooldownMin * 60_000
        outcome = dispatched.length > 0 ? 'dispatched' : 'giveUp'
        message = one.reason
        break
      }
      if (one.kind === 'abort') {
        throw new AppError('STEP_FAILED', one.reason, { step: 'dispatch' })
      }

      // ── G15：回世界地图，重读面板确认队列 +1 ───────────────────────
      await ensureWorldMap(s)
      panel = (await openTroopPanel(s)) ? await readTroopPanel(s) : emptyTroopPanel(s)
      for (const w of panel.warnings) s.warn(w)

      if (panel.queueUsed <= before) {
        s.warn(
          `派兵后队列占用没有增加（派兵前 ${before}，现在 ${panel.queueUsed}），` +
            '这一次派兵可能实际没成功（队列被别的功能块抢了，或弹了错误提示）。本次不计入成功。',
          { before, after: panel.queueUsed }
        )
        await s.shot('g15-queue-not-increased')
        state.inFlight = toMarchRecords(panel, state, cfg)
        state.lastPanelSampledAt = panel.sampledAt
        outcome = dispatched.length > 0 ? 'dispatched' : 'queueFull'
        message = '派兵后队列数没变，本轮到此为止，等下一轮重新决策。'
        break
      }

      // ── G16：记账 ───────────────────────────────────────────────────
      const record = one.record
      dispatched.push(record)
      state.dispatchTimestamps.push(record.at)
      state.backoffIndex = 0
      if (record.coord) {
        if (record.travelTimeSec !== null)
          state.travelTimeByCoord[record.coord] = record.travelTimeSec
        state.resourceByCoord[record.coord] = record.resource
      }
      state.inFlight = toMarchRecords(panel, state, cfg)
      state.lastPanelSampledAt = panel.sampledAt

      s.log(
        'info',
        `派兵成功：${RESOURCE_LABEL[record.resource].category} 等级${record.level ?? '?'} ` +
          `坐标 ${record.coord ?? '?'}，单程 ${record.travelTimeSec ?? '?'} 秒。`,
        { ...record }
      )
      outcome = 'dispatched'
      message = `本轮已派出 ${dispatched.length} 支队伍。`
    }
  } catch (e) {
    if (e instanceof GatherHalt) {
      outcome = e.outcome
      message = e.message
      s.log(e.outcome === 'cancelled' ? 'info' : 'error', e.message)
    } else {
      outcome = 'error'
      const err = AppError.from(e, 'STEP_FAILED')
      message = err.message
      error = serializeError(err)
      s.log('error', `自动采集本轮失败：${err.message}`, { code: err.code, detail: err.detail })
      await s.shot('cycle-error')
    }
  }

  // 收尾：尽量把游戏留在世界地图（失败不影响结果）。
  // ★ 搜索面板也要关：本轮在 G6/G7 失败时游戏正停在搜索页，不关它就会一直挂在那个子页面上，
  //   用户看到的就是「卡在搜索页面不动」（2026-09-18 真机反馈）。
  try {
    if (error?.code !== 'GAME_UPDATE_REQUIRED' && error?.code !== 'AI_RISK_BLOCKED') {
      await closeTroopPanel(s)
      await closeSearchPanel(s)
    }
  } catch {
    // 收尾动作失败无所谓，下一轮的 G0 会把界面拉回来。
  }

  // ── 算下次唤醒 ────────────────────────────────────────────────────────
  let wakeAt: number | null
  let wakeReason: string
  if (outcome === 'cancelled') {
    wakeAt = null
    wakeReason = '已被中止，不安排唤醒。'
  } else if (outcome === 'error') {
    wakeAt = now() + backoffSeconds(cfg, state.backoffIndex) * 1000
    state.backoffIndex = Math.min(
      state.backoffIndex + 1,
      cfg.schedule.retryBackoffSeconds.length - 1
    )
    wakeReason = '本轮出错，按退避序列重试。'
  } else if (outcome === 'giveUp' && state.giveUpUntil) {
    wakeAt = state.giveUpUntil
    wakeReason = `搜不到可用资源点，冷却 ${cfg.schedule.giveUpCooldownMin} 分钟后再试。`
  } else if (outcome === 'circuitBroken') {
    wakeAt = now() + 10 * 60_000
    wakeReason = '熔断中，10 分钟后复查。'
  } else {
    if (outcome === 'queueFull') {
      // 唤醒后队列仍未空 ⇒ 退避档位往后挪一格（wakeupLoop 的 W3）。
      state.backoffIndex = Math.min(
        state.backoffIndex + 1,
        Math.max(0, cfg.schedule.retryBackoffSeconds.length - 1)
      )
    }
    const plan = planWake(cfg, now(), state.inFlight, state.backoffIndex, random)
    wakeAt = plan.at
    wakeReason = plan.reason
  }

  if (!message) message = '本轮结束。'
  s.log(
    'info',
    `${message} 下次唤醒：${wakeAt ? new Date(wakeAt).toLocaleTimeString('zh-CN') : '不唤醒'}（${wakeReason}）`
  )

  return {
    outcome,
    message,
    dispatched,
    queue: panel ? { used: panel.queueUsed, total: panel.queueTotal } : null,
    nextWakeAt: wakeAt,
    nextWakeReason: wakeReason,
    captures: s.captures,
    state,
    warnings: s.warnings,
    error
  }
}

// ── 单次派兵：G3 ~ G14 ────────────────────────────────────────────────────

type DispatchOnce =
  | { kind: 'dispatched'; record: DispatchRecord }
  | { kind: 'giveUp'; reason: string }
  | { kind: 'abort'; reason: string }

async function dispatchOne(
  s: GatherSession,
  cfg: GatherConfig,
  state: GatherRuntimeState,
  entry: ResourceEntry
): Promise<DispatchOnce> {
  const label = RESOURCE_LABEL[entry.type].category
  const policy = effectiveLevelPolicy(cfg, entry)

  // ── G3 / G4 ──────────────────────────────────────────────────────────
  let anchor: SearchAnchor = await openSearchPanel(s)
  anchor = await selectCategory(s, entry.type, anchor)

  // ── G5：滑杆上限（★ 按资源各自缓存：每个分类的滑杆上限可以不一样；上限随游戏进程增长但变化极慢）──
  const retry = cfg.searchRetry
  const mem = levelMemoryOf(state, entry.type)
  if (retry.probeMaxLevel && isMaxLevelStale(mem, s.now(), retry.probeIntervalMin)) {
    const probed = await probeMaxLevel(s, anchor, policy)
    const r = recordMaxLevel(mem, probed.maxLevel, s.now())
    if (r.forgotNoResult !== null) {
      s.log(
        'info',
        `「${label}」的滑杆上限从 ${r.previous ?? '未知'} 变成 ${probed.maxLevel}，` +
          `作废「下限 ${r.forgotNoResult} 级搜不到」的记忆。`
      )
    }
  }
  const maxLv = effectiveMaxLevel(mem, policy)
  const expired = expireNoResult(mem, s.now(), retry.probeIntervalMin)
  if (expired !== null) {
    s.log('debug', `「${label}」「下限 ${expired} 级搜不到」的记忆已过期，本轮重新从策略下限试起。`)
  }

  // ★ searchFloor 是**搜索下限**：游戏会返回等级 >= 它的点，可能是它本身，也可能更高。
  // ★ 滑杆上限 ≠ 附近真有的最高等级（魔水池实测滑杆 10、附近只有 8 级），所以起步下限还要看记忆：
  //   上次「9 级搜不到」，这一轮直接从 8 起步，别再白等一次 8 秒的空搜。
  const plan = planStartFloor(policy, mem, maxLv, s.now(), retry.probeIntervalMin)
  let search = startFloorSearch(plan.floor)
  s.log(
    'info',
    `开始为「${label}」找点：滑杆上限 ${maxLv}，搜索下限 ${plan.floor}` +
      (plan.fromMemory
        ? `（策略算出 ${plan.policyFloor}，但上次 ${mem.noResultFloor} 级附近搜不到，直接从 ${plan.floor} 起步）`
        : '') +
      '。'
  )

  const busyCoords = new Set(
    state.inFlight.map((r) => r.coord).filter((c): c is string => Boolean(c))
  )

  for (;;) {
    s.ensureAlive()
    if (s.captures + 4 > cfg.safety.maxCapturesPerCycle) {
      return giveUp(`为「${label}」找点时截图配额用尽（已用 ${s.captures} 张），本轮先收尾。`)
    }

    // 面板可能被上一次搜索的卡片盖住/关掉了，先确保它还在。
    const still = await findSearchAnchor(s)
    if (still) {
      anchor = still
    } else {
      anchor = await openSearchPanel(s)
      anchor = await selectCategory(s, entry.type, anchor)
    }

    // ── G6 / G7 ────────────────────────────────────────────────────────
    await setSearchFloor(s, anchor, search.floor, policy.maxLevelHardCap)
    await tapSearch(s, anchor)

    // ── G8 ─────────────────────────────────────────────────────────────
    const cardAnchor = await waitForCard(s)
    if (!cardAnchor) {
      // ★ 没出卡片 = 这个下限附近没有点。以前当成「点不合适」在同一下限上白等 4 次（每次 8 秒 + 约 9 张截图），
      //   截图熔断先到、下一轮又从头来 —— 魔水池滑杆 10、附近只有 8 级时永远派不出去。现在立刻放宽。
      s.log('warn', `搜索后没出现资源点卡片：附近没有 ≥ ${search.floor} 级的「${label}」。`)
      const done = applyStep(onNoCard(search, policy, retry))
      if (done) return done
      continue
    }
    // 卡片出现了 ⇒ 搜索机制正常；此前观察到的「更高下限搜不到」现在可以确认写进记忆。
    const learned = learnFromSearch(mem, search, s.now(), retry.probeIntervalMin, search.floor)
    if (learned.committed !== null) {
      s.log(
        'info',
        `记住：「${label}」下限 ${learned.committed} 级附近搜不到点，接下来 ${retry.probeIntervalMin} 分钟内` +
          `直接从 ${Math.max(policy.minLevel, learned.committed - 1)} 级起步。`
      )
    }
    if (learned.forgot !== null) {
      s.log(
        'info',
        `「${label}」在下限 ${search.floor} 搜到了点，作废「下限 ${learned.forgot} 级搜不到」的旧记忆。`
      )
    }
    search = onCard(search)

    const needAlliance = cfg.thresholds.allianceTerritory !== 'any'
    const card = await readCard(s, cardAnchor, needAlliance)
    const verdict = validateCard(cfg, entry, card, search.floor, busyCoords)

    if (!verdict.ok) {
      if (verdict.kind === 'abort') {
        await s.shot('g8-abort')
        return { kind: 'abort', reason: verdict.reason }
      }
      if (verdict.kind === 'wrongCategory') {
        // 分类选错不是「点不合适」，不计入 occupiedFails。
        s.warn(verdict.reason)
        await closeResourceCard(s)
        anchor = await openSearchPanel(s)
        anchor = await selectCategory(s, entry.type, anchor)
        continue
      }
      s.log('info', `换点：${verdict.reason}`)
      const done = applyStep(onUnsuitable(search, policy, retry))
      if (done) return done
      continue
    }

    // ── G9：对账「自动采集至清空」──────────────────────────────────────
    const reconciled = await reconcileAutoGather(s, cardAnchor, cfg.autoGatherUntilEmpty)
    if (!reconciled && cfg.safety.abortOnReconcileFail) {
      await s.shot('g9-reconcile-failed')
      return {
        kind: 'abort',
        reason:
          '「自动采集至清空」对账失败（读不出或点完复验仍不符），' +
          '按 safety.abortOnReconcileFail 中止本轮，避免反复点击把状态点乱。'
      }
    }

    // ── G10 ~ G14 ──────────────────────────────────────────────────────
    const result = await dispatchTroop(s, cardAnchor, cfg, entry, card.storage)
    if (!result.ok) {
      if (result.kind === 'abort') return { kind: 'abort', reason: result.reason }
      s.log('info', `换点：${result.reason}`)
      const done = applyStep(onUnsuitable(search, policy, retry))
      if (done) return done
      continue
    }

    // 确认已经回到世界地图（派完兵游戏会自己退回去）。
    // ★ 用 anyTemplate：放大镜镜片半透明、分数随地形漂移，见 navigation.ts 的 WORLD_MAP_TEMPLATES。
    const back = await s.waitFor(WORLD_MAP_TEMPLATES, { waitMs: 8000, pollMs: 800 })
    if (!back) {
      s.warn('派兵后没能确认回到世界地图，下一步会强制把界面拉回来。')
    }

    return {
      kind: 'dispatched',
      record: {
        at: s.now(),
        resource: entry.type,
        coord: card.coord,
        level: card.level,
        searchFloor: search.floor,
        storage: card.storage,
        travelTimeSec: result.travelTimeSec,
        troops: result.troops
      }
    }
  }

  /** 找点放弃：先把本次观察到的「搜不到」写进记忆（下一轮别再从头撞），再返回放弃。 */
  function giveUp(reason: string): DispatchOnce {
    const learned = learnFromSearch(mem, search, s.now(), retry.probeIntervalMin)
    if (learned.committed !== null) {
      s.log(
        'info',
        `记住：「${label}」下限 ${learned.committed} 级附近搜不到点，下一轮直接从 ` +
          `${Math.max(policy.minLevel, learned.committed - 1)} 级起步。`
      )
    }
    return { kind: 'giveUp', reason }
  }

  /**
   * 执行下限状态机的一步（levelMemory.ts 的 onNoCard / onUnsuitable）。
   * 「搜不到」立刻放宽、「点不合适」重试够次数才放宽 —— 两者分开计数是 2026-09-18 那次修正的核心。
   * @returns 需要结束本次找点时返回结果，否则 null（按新状态继续重搜）
   */
  function applyStep(step: FloorStep): DispatchOnce | null {
    search = step.state
    if (step.kind === 'giveUp') {
      return giveUp(`「${label}」${step.reason}，本轮放弃，进入冷却。`)
    }
    s.log('info', `「${label}」${step.reason}。`)
    return null
  }
}

// ── 决策辅助 ──────────────────────────────────────────────────────────────

/**
 * 可用队列数 = 队列上限 − 已用 − 预留，并受「自动采集最多占几个队列」约束。
 *
 * ★ 「哪些队伍是本引擎派的」只能靠**目标坐标**与派兵记账对上号，而坐标是识别出来的、可能读不出。
 *   读不出时一律**当成是自己的**（见 countOwnGathering），方向是「少派」而不是「多派」。
 */
function freeSlots(panel: TroopPanelReading, cfg: GatherConfig, state: GatherRuntimeState): number {
  const byQueue = panel.queueTotal - panel.queueUsed - cfg.queuePlan.reserveQueues
  const ownGathering = countOwnGathering(state)
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
function countOwnGathering(state: GatherRuntimeState): number {
  return state.inFlight.filter((r) => r.ownDispatch || r.coord === null).length
}

/**
 * G2：挑一个「还欠队列」的资源。按 priority 升序，第一个没派满 queues 的就是它。
 * @returns 所有资源的配额都满足时返回 null
 */
function pickResource(
  cfg: GatherConfig,
  state: GatherRuntimeState,
  dispatched: readonly DispatchRecord[]
): ResourceEntry | null {
  const candidates = cfg.resources
    .filter((r) => r.enabled && r.queues > 0)
    .sort((a, b) => a.priority - b.priority)

  const used = new Map<string, number>()
  const counted = new Set<string>()
  for (const r of state.inFlight) {
    if (!r.resource) continue
    used.set(r.resource, (used.get(r.resource) ?? 0) + 1)
    if (r.coord) counted.add(r.coord)
  }

  // ★★ 真机实测教训（2026-09-09）：**本轮自己刚派出去的队必须无条件计入配额**。
  //    上面那份记账是「面板行 -> 目标坐标 -> resourceByCoord」推出来的，
  //    整条链路系在「行内坐标能读对」上；一旦坐标读不出（字形集曾缺 0/4，
  //    且为了不接受假坐标已把阈值抬到 0.90），刚派出去的队就查不到资源类型，
  //    每种资源的 used 都还是 0，引擎会立刻再派一支 —— 实测一轮之内连派两支伐木场。
  //    dispatched 是本轮的**事实**，不依赖任何识别，拿它兜底最可靠。
  //    坐标已经在面板行里认出来的那些不能重复计数，用 counted 去重。
  for (const d of dispatched) {
    if (d.coord && counted.has(d.coord)) continue
    used.set(d.resource, (used.get(d.resource) ?? 0) + 1)
  }

  for (const c of candidates) {
    if ((used.get(c.type) ?? 0) < c.queues) return c
  }
  return null
}

// ── 收尾 ──────────────────────────────────────────────────────────────────

/**
 * 「还没走到主循环就该结束了」的早退出口（未启用 / 冷却中 / 熔断）。
 * 这些情况的唤醒时刻是调用点算好的确定值，这里不再二次推算 —— 尤其是「未启用」必须保持 null，
 * 否则会给一个已经关掉的功能排上定时器。
 */
function finish(
  s: GatherSession,
  state: GatherRuntimeState,
  dispatched: DispatchRecord[],
  panel: TroopPanelReading | null,
  outcome: GatherOutcome,
  message: string,
  wakeAt: number | null,
  wakeReason: string
): GatherCycleResult {
  s.log('info', message)
  return {
    outcome,
    message,
    dispatched,
    queue: panel ? { used: panel.queueUsed, total: panel.queueTotal } : null,
    nextWakeAt: wakeAt,
    nextWakeReason: wakeReason,
    captures: s.captures,
    state,
    warnings: s.warnings
  }
}

function cloneState(src?: GatherRuntimeState): GatherRuntimeState {
  const base = createRuntimeState()
  if (!src) return base
  return {
    // 旧状态文件里四种资源共用的 maxLevel / maxLevelProbedAt 在这里被丢弃（sanitize 只认按资源分的那份），下一轮重新探测。
    levelByResource: sanitizeLevelMemory(src.levelByResource),
    backoffIndex: src.backoffIndex ?? 0,
    giveUpUntil: src.giveUpUntil ?? null,
    dispatchTimestamps: [...(src.dispatchTimestamps ?? [])],
    inFlight: [...(src.inFlight ?? [])],
    lastPanelSampledAt: src.lastPanelSampledAt ?? null,
    travelTimeByCoord: { ...(src.travelTimeByCoord ?? {}) },
    resourceByCoord: { ...(src.resourceByCoord ?? {}) }
  }
}
