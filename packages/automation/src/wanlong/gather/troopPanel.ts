/**
 * G1：「部队管理」面板的打开与读取。
 *
 * 这是派兵的**硬前置**（队列有没有空位）与 ETA 调度的**唯一数据源**（各队还剩多久）。
 *
 * 两类行的渲染方式完全不同，数字字形集绝不可互换（实测）：
 *   · 采集中：状态词与倒计时是**白字压在载重进度条上**，整体居中 ⇒ 用 dig_light16。
 *     进度条左段绿右段灰，边界随进度右移会先后盖过「采」「集」「中」，
 *     所以状态词要用 tpl_status_gathering(全灰底) 与 _green(采集二字落绿底) 两张做 anyTemplate。
 *   · 采集行军中 / 返回中：**深灰字直接压在行底色上**，左对齐 ⇒ 用 dig_dark20。
 *
 * 截图预算：面板读数很容易把一轮的截图配额吃光，所以只有「队列 N/M」和「倒计时」给重试机会，
 * 坐标与耐力读一次就算（读不出按 null 处理，不影响派兵决策的正确性）。
 */

import { AppError } from '../errors.js'
import type { Rect } from '../../contracts.js'
import { parseCoord, parseRatio } from '../vision/digits.js'
import {
  COORD_MIN_SCORE,
  FIXED_TAP,
  TROOP_PANEL,
  coordRoiRightOf,
  rowBand,
  staminaRoiRightOf,
  timerRoiRightOf
} from './geometry.js'
import { dismissNoticeDialog } from './navigation.js'
import { parseHmsFlexible } from './parse.js'
import type { GatherSession } from './session.js'
import { GLYPH, TPL } from './templates.js'
import type { TroopPanelReading, TroopRow, TroopStatus } from './types.js'

/** 状态词模板 -> 语义。 */
const STATUS_BY_TEMPLATE: Record<string, TroopStatus> = {
  [TPL.statusGathering]: 'gathering',
  [TPL.statusGatheringGreen]: 'gathering',
  [TPL.statusGatherMarching]: 'gatherMarching',
  [TPL.statusReturning]: 'returning'
}

const STATUS_TEMPLATES = Object.keys(STATUS_BY_TEMPLATE)

/**
 * 打开「部队管理」面板。
 * ★ 入口坐标务必 x=2522：点 2468 会落到地图上把地图拖走，(2524,682) 是收起右侧栏的双箭头。
 */
/** 右侧栏入口图标的搜索区：覆盖列表图标（≈592）与收起双箭头（≈682）。 */
const MAP_ENTRY_ROI = { x: 2430, y: 540, w: 130, h: 220 }

/**
 * 「没有队伍在野外」时的面板读数：入口根本不存在，面板打不开，按全空处理。
 * 队列上限此刻读不到，用几何表里的 maxRows（= 队列上限）估计；派兵后 G15 会读到真实值。
 */
export function emptyTroopPanel(s: GatherSession): TroopPanelReading {
  return {
    queueUsed: 0,
    queueTotal: TROOP_PANEL.maxRows,
    rows: [],
    sampledAt: s.now(),
    warnings: [
      `世界地图右侧没有部队管理入口，判定没有队伍在野外；队列上限按 ${TROOP_PANEL.maxRows} 估计（派兵后会读到真实值）。`
    ]
  }
}

/**
 * 打开「部队管理」面板。返回 false 表示**入口不存在（没有队伍在野外）**，此时调用方应改用 emptyTroopPanel()。
 * ★ 入口坐标务必 x=2522：点 2468 会落到地图上把地图拖走，(2524,682) 是收起右侧栏的双箭头。
 * ★ 入口只在有队伍在野外时出现：小号刚开号时盲点三次无反应，会被误判成掉线并暂停实例（2026-09-10 实测）。
 */
export async function openTroopPanel(s: GatherSession, maxAttempts = 3): Promise<boolean> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    s.ensureAlive()
    const already = await s.matchOptional(TPL.panelTitleTroop, TROOP_PANEL.titleRoi)
    if (already && already.found) return true

    // 先看入口在不在（模板缺失时跳过这道判断，退回原来的盲点行为）。
    const entry = await s.matchOptional(TPL.queueIconMap, MAP_ENTRY_ROI)
    if (entry && !entry.found) {
      s.log('info', `世界地图右侧没有部队管理入口（${entry.score.toFixed(3)}）⇒ 没有队伍在野外，按空队列处理。`)
      return false
    }

    await s.tapAt(FIXED_TAP.troopPanelEntry, 900)
    const hit = await s.waitFor(TPL.panelTitleTroop, {
      roi: TROOP_PANEL.titleRoi,
      waitMs: 6000,
      pollMs: 700
    })
    if (hit) return true

    // 没开起来，多半是点到了地图上（把地图拖走了）或者弹了别的东西。
    s.log('warn', `部队管理面板没打开（第 ${attempt}/${maxAttempts} 次），清理后重试。`)
    await dismissNoticeDialog(s)
  }
  await s.shot('g1-panel-not-open')
  throw new AppError(
    'STEP_FAILED',
    `连点 ${maxAttempts} 次都没能打开「部队管理」面板。` +
      '请确认世界地图右侧的部队入口位置没变（实测 2522,592），以及 tpl_panel_title_troop 模板仍然有效。',
    { step: 'G1' }
  )
}

/**
 * 读一次面板：队列 N/M + 每一行的状态、倒计时、目标坐标、指挥官耐力。
 * 调用前必须已经 openTroopPanel。
 */
export async function readTroopPanel(s: GatherSession): Promise<TroopPanelReading> {
  const sampledAt = s.now()
  const warnings: string[] = []

  // ── 队列 N/M（派兵硬前置，值得多试几次）─────────────────────────────────
  const queue = await s.readNumberField<[number, number]>({
    field: '行军队列 N/M',
    glyphSet: GLYPH.dark20,
    tries: 3,
    resolveRoi: async () => {
      const icon = await s.match(TPL.queueIconPanel, TROOP_PANEL.queueIconRoi)
      if (!icon.found) return null
      const off = TROOP_PANEL.queueDigitRoiRelIcon
      return { x: icon.x + off.x, y: icon.y + off.y, w: off.w, h: off.h }
    },
    parse: (t) => parseRatio(t, TROOP_PANEL.maxRows)
  })

  if (!queue) {
    await s.shot('g1-queue-unreadable')
    throw new AppError(
      'STEP_FAILED',
      '读不出「部队管理」面板右上角的行军队列 N/M。没有这个数就无法判断能不能派兵，本轮中止。' +
        '（排查方向：tpl_queue_icon_panel 是否命中、dig_dark20 字形集是否齐全。）',
      { step: 'G1' }
    )
  }

  const [queueUsed, queueTotal] = queue
  const rows: TroopRow[] = []
  const rowCount = Math.min(queueUsed, TROOP_PANEL.maxRows)

  for (let i = 1; i <= rowCount; i++) {
    s.ensureAlive()
    const band = rowBand(i)
    const statusRoi: Rect = {
      x: TROOP_PANEL.statusBandX,
      y: band.y,
      w: TROOP_PANEL.statusBandW,
      h: band.h
    }
    const statusHit = await s.bestOf(STATUS_TEMPLATES, statusRoi)
    const status: TroopStatus = statusHit ? STATUS_BY_TEMPLATE[statusHit.id] ?? 'unknown' : 'unknown'

    if (!statusHit) {
      warnings.push(
        `第 ${i} 行的状态词认不出来（可能是「驻扎中/集结中/战斗中」这类还没裁模板的状态）。`
      )
    }

    // 倒计时：字形集取决于这一行的渲染方式（见文件头）。
    let remainingSec: number | null = null
    if (statusHit) {
      const glyphSet = status === 'gathering' ? GLYPH.light16 : GLYPH.dark20
      remainingSec = await s.readNumberField<number>({
        field: `第 ${i} 行倒计时`,
        glyphSet,
        tries: 2,
        resolveRoi: async () => {
          const again = await s.bestOf(STATUS_TEMPLATES, statusRoi)
          if (!again) return null
          return timerRoiRightOf(again.match)
        },
        parse: parseHmsFlexible
      })
    }

    // 目标坐标（用于「避免两队派同一个点」）。读一次就算。
    const coordRoiBand: Rect = {
      x: TROOP_PANEL.coordBandX,
      y: band.y,
      w: TROOP_PANEL.coordBandW,
      h: band.h
    }
    let coord: string | null = null
    const coordLabel = await s.matchOptional(TPL.labelCoordRow, coordRoiBand)
    if (coordLabel && coordLabel.found) {
      coord = await s.readNumberField<string>({
        field: `第 ${i} 行目标坐标`,
        glyphSet: GLYPH.cardCoord,
        tries: 1,
        resolveRoi: async () => coordRoiRightOf(coordLabel),
        parse: parseCoord,
        minScore: COORD_MIN_SCORE
      })
    }

    // 指挥官耐力。读一次就算，读不出按「未知」处理（不阻塞派兵）。
    let stamina: [number, number] | null = null
    const dropRoi: Rect = {
      x: TROOP_PANEL.staminaBandX,
      y: band.y,
      w: TROOP_PANEL.staminaBandW,
      h: band.h
    }
    const drop = await s.matchOptional(TPL.staminaDrop, dropRoi)
    if (drop && drop.found) {
      stamina = await s.readNumberField<[number, number]>({
        field: `第 ${i} 行指挥官耐力`,
        glyphSet: GLYPH.stamina,
        tries: 1,
        resolveRoi: async () => staminaRoiRightOf(drop),
        parse: (t) => parseRatio(t, 999)
      })
    }

    rows.push({ index: i, status, remainingSec, coord, stamina, sampledAt })
  }

  if (rows.length !== queueUsed) {
    warnings.push(
      `面板显示已用 ${queueUsed} 个队列，但只解析出 ${rows.length} 行；以行数为准并在下一轮强制校准。`
    )
  }

  s.log('info', `部队管理：队列 ${queueUsed}/${queueTotal}，解析出 ${rows.length} 行。`, {
    queueUsed,
    queueTotal,
    rows: rows.map((r) => ({
      index: r.index,
      status: r.status,
      remainingSec: r.remainingSec,
      coord: r.coord
    }))
  })

  return { queueUsed, queueTotal, rows, sampledAt, warnings }
}

/** 面板里所有行的最大耐力当前值。没有任何一行读到耐力时返回 null（= 未知，不阻塞派兵）。 */
export function maxStamina(reading: TroopPanelReading): number | null {
  let best: number | null = null
  for (const r of reading.rows) {
    if (!r.stamina) continue
    best = best === null ? r.stamina[0] : Math.max(best, r.stamina[0])
  }
  return best
}
