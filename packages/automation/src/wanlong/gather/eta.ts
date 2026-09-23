/**
 * G16：ETA 记账与下次唤醒时刻的计算。
 *
 * 关键机制（真机实测）：**采集完成后队伍会自动回城**，队列要等它到家才释放。
 * 所以：
 *      etaAt  = 采样时刻 + 面板上该行的剩余秒数     （当前阶段结束）
 *      freeAt = etaAt + 单程行军秒数                （队列真正释放）
 *      wakeAt = freeAt + slackSeconds + rand(jitter)
 *
 * 单程行军秒数只有派兵那一刻能从「行军」按钮上读到，所以要按目标坐标记在 runtimeState 里。
 *
 * 用户明确要求：**不必卡死时间，留冗余，宁晚勿早**。所以这里所有的不确定性一律往「更晚」的方向估，
 * 读不出来的值走 safety.unknownEtaFallbackSeconds，绝不乐观估计。
 */

import type { GatherConfig } from '../config.js'
import type { GatherRuntimeState, MarchRecord, TroopPanelReading, TroopRow } from './types.js'

/** 把一次面板读数变成在途记账。 */
export function toMarchRecords(
  reading: TroopPanelReading,
  state: GatherRuntimeState,
  cfg: GatherConfig
): MarchRecord[] {
  return reading.rows.map((row) => buildRecord(row, state, cfg))
}

function buildRecord(
  row: TroopRow,
  state: GatherRuntimeState,
  cfg: GatherConfig
): MarchRecord {
  const fallback = cfg.safety.unknownEtaFallbackSeconds
  const travelTimeSec = row.coord ? (state.travelTimeByCoord[row.coord] ?? null) : null
  const resource = row.coord ? state.resourceByCoord[row.coord] : undefined
  const remaining = row.remainingSec

  // 当前阶段结束时刻。读不出倒计时就按保守值估（宁晚勿早）。
  const etaAt = row.sampledAt + (remaining ?? fallback) * 1000

  // 队列释放时刻。
  let freeAt: number
  switch (row.status) {
    case 'returning':
      // 已经在回城路上，倒计时结束就释放。
      freeAt = etaAt
      break
    case 'gathering':
      // 采完之后还要走回来。回程时间取派兵时读到的单程行军时间；没记到就用兜底值的 1/6
      // （兜底值 600s 是「一段未知时长」的保守估计，回程通常只有分钟量级）。
      freeAt = etaAt + (travelTimeSec ?? Math.round(fallback / 6)) * 1000
      break
    case 'gatherMarching':
      // 还在去的路上：到了之后要采多久完全未知，只能整体按兜底值往后压。
      freeAt = etaAt + fallback * 1000
      break
    default:
      freeAt = row.sampledAt + fallback * 1000
      break
  }

  return {
    rowIndex: row.index,
    coord: row.coord,
    status: row.status,
    remainingSec: remaining,
    sampledAt: row.sampledAt,
    travelTimeSec,
    etaAt,
    freeAt,
    resource,
    ownDispatch: Boolean(row.coord && state.travelTimeByCoord[row.coord] !== undefined)
  }
}

/** 最早会释放的队列时刻。没有在途队伍返回 null。 */
export function earliestFreeAt(records: MarchRecord[]): number | null {
  let best: number | null = null
  for (const r of records) {
    if (r.freeAt === null) continue
    best = best === null ? r.freeAt : Math.min(best, r.freeAt)
  }
  return best
}

/** 是否存在「倒计时没读出来」的在途队伍 —— 有的话唤醒时刻要加一层校准兜底。 */
export function hasUncertainEta(records: MarchRecord[]): boolean {
  return records.some((r) => r.remainingSec === null || r.status === 'unknown')
}

/** 取当前退避档位的秒数（用完取最后一项，并受 maxBackoffSeconds 封顶）。 */
export function backoffSeconds(cfg: GatherConfig, backoffIndex: number): number {
  const list = cfg.schedule.retryBackoffSeconds
  const idx = Math.min(Math.max(0, backoffIndex), list.length - 1)
  return Math.min(list[idx] ?? 30, cfg.schedule.maxBackoffSeconds)
}

export interface WakePlan {
  at: number
  reason: string
}

/**
 * 算下一次唤醒时刻。
 *
 * @param records      当前在途队伍
 * @param backoffIndex 连续「唤醒后队列仍未空」的次数
 * @param random       注入随机源便于测试
 */
export function planWake(
  cfg: GatherConfig,
  now: number,
  records: MarchRecord[],
  backoffIndex: number,
  random: () => number = Math.random
): WakePlan {
  const jitter = Math.floor(random() * Math.max(0, cfg.schedule.jitterSeconds) * 1000)
  const backoffAt = now + backoffSeconds(cfg, backoffIndex) * 1000
  const free = earliestFreeAt(records)

  if (free === null) {
    return {
      at: backoffAt,
      reason: `没有在途队伍可参考，按退避序列第 ${backoffIndex + 1} 档（${Math.round((backoffAt - now) / 1000)} 秒后）唤醒。`
    }
  }

  let at = free + cfg.schedule.slackSeconds * 1000 + jitter
  let reason =
    `最早释放的队列预计 ${fmtTime(free)} 空出，加 ${cfg.schedule.slackSeconds} 秒冗余` +
    `${jitter > 0 ? ` 与 ${Math.round(jitter / 1000)} 秒错峰抖动` : ''}后唤醒。`

  // ETA 已经过期（读数偏旧 / 机器休眠过）：别立刻猛冲，走退避。
  if (at < now + 10_000) {
    at = backoffAt
    reason = `在途队伍的预计释放时刻已经过期，改按退避序列第 ${backoffIndex + 1} 档唤醒，避免空转。`
  }

  // 有队伍的倒计时没读出来 ⇒ 本地递推不可信，最迟隔 calibrateIntervalMin 就回来重采一次。
  if (hasUncertainEta(records)) {
    const calibrateAt = now + cfg.schedule.calibrateIntervalMin * 60_000
    if (calibrateAt < at) {
      at = calibrateAt
      reason =
        `有队伍的倒计时没读出来，ETA 不可信，先按兜底校准间隔 ${cfg.schedule.calibrateIntervalMin} 分钟回来重采一次。`
    }
  }

  return { at, reason }
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
