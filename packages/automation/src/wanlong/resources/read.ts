/**
 * 读游戏里「道具 → 资源 → 资源统计」那张表（4 行 × 2 列），返回 ResourceSnapshot。
 *
 * 两层：
 *   · `readResourceStatsFromFrame`：纯识别，输入一帧裸图，不碰设备。离线测试直接喂合成帧跑它。
 *   · `readResourceStatsPanel`：预检 → 导航打开弹窗 → 读表 → 还原到主界面。每一步都用模板校验，
 *     **绝不盲点**：预检不过（不在主界面 / 有弹窗 / 开着面板）直接抛中文错误，一次都不点。
 *
 * ★ 精度只到 0.1亿（1000 万），这张表只作日切快照与粗对账，不能用来算日采集量（见 contract.ts 文件头）。
 * ★ 调用方必须持有该实例的设备租约（与采集 / 采样同一把锁）再调 readResourceStatsPanel，否则会和采集抢屏幕；
 *   设备操作走与采集流程同一个 GatherIo 端口（worker 里由 createGatherIo 包 device-RPC）。
 */

import { AppError } from '../errors.js'
import {
  PANEL_AMOUNT_PRECISION,
  RESOURCE_NAME,
  RESOURCE_PANEL_ROW_ORDER,
  SNAPSHOT_MAX_AMOUNT,
  emptyResourceSnapshot,
  parseCnAmount,
  type ResourceSnapshot,
  type ResourceSnapshotRow
} from './contract.js'
import type { MatchResult, Point, PreparedFrame, RawFrame, Rect } from '../../contracts.js'
import { matchIn, prepareFrame } from '../../vision.js'
import { DEFAULT_GATHER_CONFIG, type GatherConfig } from '../config.js'
import { CARD, GAME_PACKAGE } from '../gather/geometry.js'
import {
  CITY_TEMPLATES,
  WORLD_MAP_TEMPLATES,
  dismissNoticeDialog,
  dismissPopupByClose,
  ensureWorldMap
} from '../gather/navigation.js'
import { GatherSession, type GatherIo, type GatherLogger } from '../gather/session.js'
import { TPL, type GatherTemplates } from '../gather/templates.js'
import { readDigits, type GlyphSet } from '../vision/digits.js'
import { RESOURCE_STATS_LAYOUT, rowRoi, type ResourceStatsColumn } from './layout.js'
import { RES_GLYPH, RES_LABEL_TPL, RES_TPL, RES_UNIT_CHAR, RESOURCE_REQUIRED_TEMPLATES } from './ids.js'
import { loadResourceUnitTemplates, type ResourceUnitTemplates } from './templates.js'

// ── 识别参数（与 resource-stats.json 的 pipeline.readOptions 一致）────────────

/** 单位字（亿/万）在单元格里的命中阈值。离线实测正样本 0.966~1.0，异极性（顶栏白字）只有 0.37。 */
export const UNIT_THRESHOLD = 0.8
/**
 * 单字形接受阈值。★ 抬到 0.9 是有意为之：字形集缺 5/8 时 argmax 会拿最像的现有字形顶上，
 * 读出一个格式合法、值却是错的串；0.9 让缺字位落成 '?' → 该格 null，宁可读不出也不给错值。
 */
export const DIGIT_MIN_SCORE = 0.9
/** 一格最多几个字符（最长如 1234.5亿 → 6 个数字 + 点）。 */
const MAX_CHARS = 8
/** 有单位时的整串形状：1~4 位整数 + 可选 1 位小数。 */
const PATTERN_WITH_UNIT = /^\d{1,4}(\.\d)?$/
/** 无单位时：千分位整数（游戏里 <1 万才这样显示）。 */
const PATTERN_NO_UNIT = /^\d{1,3}(,\d{3})*$/
/** 万龙觉醒的资源量级最高千亿；超过就是读错了。 */
const MAX_VALUE = SNAPSHOT_MAX_AMOUNT

/** 读表流程自己的截图熔断（预检 1 + 导航 2~6 + 读表 1~2 + 还原 2~6，正常 ≤ 15 张）。 */
export const RESOURCE_READ_MAX_CAPTURES = 30

/** 等待界面切换的时长与轮询间隔。 */
const WAIT_MS = 6000
const POLL_MS = 800

/** 预检时「在主界面」的判据：世界地图 anyTemplate + 城内的地图切换钮（两者都含阵营变体）。 */
const MAIN_SCREEN_TEMPLATES = [...WORLD_MAP_TEMPLATES, ...CITY_TEMPLATES]

// ══════════════════════════════════════════════════════════════════════════
// 一、纯识别：一帧 → 快照
// ══════════════════════════════════════════════════════════════════════════

/** 单格读数。 */
interface CellReading {
  /** 解析成功的整数；读不出 / 校验不过为 null。 */
  value: number | null
  /** 识别到的原文（含单位；缺字位会带 '?'）。什么都没认出来为空串。 */
  raw: string
  /** 中文降级原因（value 为 null 时必有）。 */
  reason: string | null
}

export interface ReadFromFrameOptions {
  /** 已按 shrink=1 编好的单位字模板。不传则按 templateDir 自动加载（带缓存）。 */
  units?: ResourceUnitTemplates
  /** 模板集目录（与 loadGatherTemplates 同一个）；没传 units 时必填。 */
  templateDir?: string
  /** 单位字编译失败时的中文提示（原版打 console.warn；流程里接到会话日志）。 */
  onWarn?: (message: string) => void
}

/**
 * 从一帧（弹窗已打开）里读出 4 行 × 2 列。**不碰设备、不抛识别类错误**：
 * 读不出的格子记 null 并把原文放进 rawItem/rawTotal，warnings 里写中文原因。
 * 只有字形集根本不存在（还没导入）或单位字无从加载时才抛 TEMPLATE_NOT_FOUND。
 */
export async function readResourceStatsFromFrame(
  raw: RawFrame,
  templates: GatherTemplates,
  instanceIndex: number,
  at: number,
  opts: ReadFromFrameOptions = {}
): Promise<ResourceSnapshot> {
  const glyphs = templates.requireGlyphs(RES_GLYPH)
  const units = opts.units ?? (await loadUnits(opts.templateDir, opts.onWarn))
  const refW = templates.refWidth
  const refH = templates.refHeight
  const f1 = await prepareFrame(raw, { refW, refH, shrink: 1 })

  const snap = emptyResourceSnapshot(instanceIndex, at, 'panel')
  const present = new Set(glyphs.glyphs.map((g) => g.char))
  const missingDigits = '0123456789'.split('').filter((c) => !present.has(c))
  let anyUnreadable = false

  for (const row of snap.rows) {
    for (const column of ['item', 'total'] as const) {
      const cell = rowRoi(row.type, column)
      const reading = await readCell(raw, f1, cell, glyphs, units, refW, refH)
      if (column === 'item') {
        row.itemTotal = reading.value
        row.rawItem = reading.raw
      } else {
        row.total = reading.value
        row.rawTotal = reading.raw
      }
      if (reading.value == null) {
        anyUnreadable = true
        snap.warnings.push(`${RESOURCE_NAME[row.type]}·${columnName(column)}读不出：${reading.reason}`)
      }
    }
    if (row.itemTotal != null && row.total != null && row.total < row.itemTotal) {
      snap.warnings.push(
        `${RESOURCE_NAME[row.type]}的资源总量（${row.rawTotal}）小于道具总量（${row.rawItem}），疑似读错列`
      )
    }
  }

  if (anyUnreadable && missingDigits.length > 0) {
    snap.warnings.push(`本套字形缺 ${missingDigits.join('/')}，含这些数字的值会读成「?」，请在调度空窗补裁`)
  }
  if (units.missing.length > 0 && anyUnreadable) {
    const names = units.missing.map((id) => RES_UNIT_CHAR[id] ?? id)
    snap.warnings.push(`单位字模板缺「${names.join('」「')}」，带该单位的值会按无单位整数读`)
  }
  return snap
}

/** @throws AppError('TEMPLATE_NOT_FOUND') 没给目录 / 模板集读不出来（中文说明，见 loadResourceUnitTemplates）。 */
async function loadUnits(templateDir: string | undefined, onWarn?: (message: string) => void): Promise<ResourceUnitTemplates> {
  if (!templateDir) {
    throw new AppError(
      'TEMPLATE_NOT_FOUND',
      '读资源统计需要模板集目录来加载单位字模板（亿/万），请先在「模板」页选择模板集。'
    )
  }
  return loadResourceUnitTemplates(templateDir, onWarn)
}

async function readCell(
  raw: RawFrame,
  f1: PreparedFrame,
  cell: Rect,
  glyphs: GlyphSet,
  units: ResourceUnitTemplates,
  refW: number,
  refH: number
): Promise<CellReading> {
  // ① 先定位单位字：整字相关匹配不受列投影切分影响。
  let unit: { char: '亿' | '万'; match: MatchResult } | null = null
  for (const [id, tpl] of units.units) {
    const m = await matchIn(f1, tpl, { roi: cell, threshold: UNIT_THRESHOLD })
    if (!m.found) continue
    if (!unit || m.score > unit.match.score) unit = { char: RES_UNIT_CHAR[id] ?? '亿', match: m }
  }

  // ② 数字 ROI 截到单位字左侧（unit.x 含 1px 裁剪边，恰好落在数字与单位之间的空列上）。
  const digitsRoi: Rect = unit
    ? { x: cell.x, y: cell.y, w: Math.max(0, unit.match.x - cell.x), h: cell.h }
    : cell
  if (digitsRoi.w < 8) {
    return { value: null, raw: unit?.char ?? '', reason: '单位字左边没有数字区域' }
  }

  // ③ 逐字形多峰识别（shrink=1 裸帧）。
  const reading = await readDigits(raw, digitsRoi, glyphs, refW, refH, {
    minScore: DIGIT_MIN_SCORE,
    maxChars: MAX_CHARS
  })
  const rawText = reading.text + (unit?.char ?? '')
  if (reading.text.length === 0) {
    return { value: null, raw: rawText, reason: '没有认出任何数字（可能是动画中间帧或字形缺失）' }
  }
  if (reading.hasGap || reading.text.includes('?')) {
    return { value: null, raw: rawText, reason: `中间有认不出的字位（读到「${rawText}」）` }
  }
  const pattern = unit ? PATTERN_WITH_UNIT : PATTERN_NO_UNIT
  if (!pattern.test(reading.text)) {
    return { value: null, raw: rawText, reason: `读到「${rawText}」，形状不像资源统计表的值` }
  }
  const value = parseCnAmount(rawText)
  if (value == null) {
    return { value: null, raw: rawText, reason: `「${rawText}」无法解析成金额` }
  }
  if (value > MAX_VALUE) {
    return { value: null, raw: rawText, reason: `「${rawText}」超出合理量级` }
  }
  return { value, raw: rawText, reason: null }
}

function columnName(column: ResourceStatsColumn): string {
  return column === 'item' ? '道具总量' : '资源总量'
}

/**
 * 合并两帧的读数：两帧都读出则必须一致（不一致 ⇒ null + 告警），只有一帧读出则采用那一帧。
 * 第一帧常常是弹窗淡入的中间帧，所以「只读出一帧」是常态，不能因此丢值。
 */
export function mergeSnapshots(first: ResourceSnapshot, second: ResourceSnapshot): ResourceSnapshot {
  const out: ResourceSnapshot = { ...second, rows: [], warnings: [] }
  const warnings: string[] = []
  for (const type of RESOURCE_PANEL_ROW_ORDER) {
    const a = first.rows.find((r) => r.type === type)
    const b = second.rows.find((r) => r.type === type)
    const row: ResourceSnapshotRow = { type, itemTotal: null, total: null, rawItem: '', rawTotal: '' }
    for (const column of ['item', 'total'] as const) {
      const va = column === 'item' ? a?.itemTotal ?? null : a?.total ?? null
      const vb = column === 'item' ? b?.itemTotal ?? null : b?.total ?? null
      const ra = column === 'item' ? a?.rawItem ?? '' : a?.rawTotal ?? ''
      const rb = column === 'item' ? b?.rawItem ?? '' : b?.rawTotal ?? ''
      let value: number | null
      let rawText: string
      if (va != null && vb != null) {
        if (va === vb) {
          value = va
          rawText = rb
        } else {
          value = null
          rawText = `${ra}≠${rb}`
          warnings.push(`${RESOURCE_NAME[type]}·${columnName(column)}两帧读数不一致（${ra} / ${rb}），已置空`)
        }
      } else if (vb != null) {
        value = vb
        rawText = rb
      } else if (va != null) {
        value = va
        rawText = ra
      } else {
        value = null
        rawText = rb || ra
        warnings.push(`${RESOURCE_NAME[type]}·${columnName(column)}两帧都读不出（${rb || ra || '空'}）`)
      }
      if (column === 'item') {
        row.itemTotal = value
        row.rawItem = rawText
      } else {
        row.total = value
        row.rawTotal = rawText
      }
    }
    out.rows.push(row)
  }
  // 字形缺失之类的整体说明只保留第二帧那份（两帧内容相同）。
  const generic = second.warnings.filter((w) => !/读不出：|疑似读错列/.test(w))
  out.warnings = [...warnings, ...generic]
  return out
}

// ══════════════════════════════════════════════════════════════════════════
// 二、完整流程：预检 → 打开弹窗 → 读表 → 还原
// ══════════════════════════════════════════════════════════════════════════

export interface ReadResourceStatsOptions {
  /** 与采集流程同一个设备端口（参考坐标）。 */
  io: GatherIo
  templates: GatherTemplates
  /** 模板集目录（与 loadGatherTemplates 同一个）；用来按 shrink=1 加载单位字。传了 units 可省。 */
  templateDir?: string
  /** 预先编好的单位字（worker 常驻时复用，省一次读 manifest）。 */
  units?: ResourceUnitTemplates
  instanceIndex: number
  log: GatherLogger
  signal?: AbortSignal
  /** 留痕钩子（失败帧）。给的是裸帧，落盘由调用方决定（按 shotPolicy）。 */
  onShot?: (label: string, raw: RawFrame) => void | Promise<void>
  now?: () => number
  /** 覆盖会话配置（离线测试用）。默认 DEFAULT_GATHER_CONFIG + 本模块自己的截图熔断。 */
  config?: GatherConfig
}

/**
 * 读一次「资源统计」表并把游戏还原到主界面。
 *
 * @throws AppError('STEP_FAILED') 预检不过 / 没打开道具页 / 弹窗没出现 / 还原失败（message 都是中文）
 * @throws AppError('TEMPLATE_NOT_FOUND') 必需模板或字形集还没入库、或模板集目录读不出来（此时一个动作都不发）
 */
export async function readResourceStatsPanel(opts: ReadResourceStatsOptions): Promise<ResourceSnapshot> {
  const config: GatherConfig = opts.config ?? {
    ...DEFAULT_GATHER_CONFIG,
    safety: { ...DEFAULT_GATHER_CONFIG.safety, maxCapturesPerCycle: RESOURCE_READ_MAX_CAPTURES }
  }
  const s = new GatherSession({
    io: opts.io,
    templates: opts.templates,
    config,
    log: opts.log,
    onShot: opts.onShot,
    signal: opts.signal,
    now: opts.now,
    instanceIndex: opts.instanceIndex
  })
  // 必需模板先查一遍，缺了就别去点屏幕。
  for (const id of RESOURCE_REQUIRED_TEMPLATES) {
    if (!opts.templates.has(id)) {
      throw new AppError(
        'TEMPLATE_NOT_FOUND',
        `模板集里缺少「${id}」，读不了资源统计表。请在「模板」页导入资源统计模板（或从截图按规格裁切）。`,
        { templateId: id }
      )
    }
  }
  if (!opts.templates.hasGlyphs(RES_GLYPH)) {
    throw new AppError(
      'TEMPLATE_NOT_FOUND',
      `字形集「${RES_GLYPH}」还没入库，读不了资源统计表。请在「模板」页导入资源统计模板（或从截图按规格裁切）。`,
      { glyphSet: RES_GLYPH }
    )
  }
  const units = opts.units ?? (await loadUnits(opts.templateDir, (m) => opts.log('warn', m)))

  // ① 预检：不在主界面就一次都不点。
  await precheckMainScreen(s)

  // ② ③ ④ 打开并读表；无论成败都走 ⑤ 还原（预检之后才动过屏幕）。
  let snap: ResourceSnapshot | null = null
  let failure: unknown = null
  try {
    await openStatsDialog(s)
    snap = await readOpenDialog(s, opts, units)
  } catch (e) {
    failure = e
  }

  // ⑤ 还原。
  const restoreWarning = await restoreMainScreen(s, failure)
  if (failure) throw failure
  if (!snap) throw new AppError('STEP_FAILED', '读资源统计表没有得到结果（内部状态异常）。')
  if (restoreWarning) snap.warnings.push(restoreWarning)
  opts.log(
    'info',
    `资源统计读取完成：${snap.rows.map((r) => `${RESOURCE_NAME[r.type]} ${r.rawItem || '?'}/${r.rawTotal || '?'}`).join('，')}（精度 ${PANEL_AMOUNT_PRECISION / 10_000} 万）`,
    {
      instanceIndex: opts.instanceIndex,
      captures: s.captures,
      warnings: snap.warnings
    }
  )
  return snap
}

/** 预检：前台是游戏、没有弹窗、没开面板、能看到主界面判据。任何不满足都抛错且**不点任何东西**。 */
async function precheckMainScreen(s: GatherSession): Promise<void> {
  const fg = await s.io.foregroundPackage()
  if (fg !== GAME_PACKAGE) {
    throw new AppError('STEP_FAILED', `游戏不在前台（当前是「${fg ?? '未知'}」），稍后再试。`, { foreground: fg })
  }
  s.invalidate()
  const notice = await s.matchOptional(TPL.dlgTitleNotice)
  if (notice?.found) {
    throw new AppError('STEP_FAILED', '当前有弹窗（注意/确认框），稍后再试。', { template: TPL.dlgTitleNotice })
  }
  let main = await s.bestOf(MAIN_SCREEN_TEMPLATES)
  if (!main && (await dismissPopupByClose(s))) {
    // 活动弹窗盖着主界面：关掉再看一次（只多一个动作，且只点弹窗自己的 ×）。
    s.invalidate()
    main = await s.bestOf(MAIN_SCREEN_TEMPLATES)
  }
  if (!main) {
    await s.shot('res-precheck-not-main')
    throw new AppError('STEP_FAILED', '当前不在主界面（可能开着面板或弹窗），稍后再试。', {
      templates: MAIN_SCREEN_TEMPLATES
    })
  }
  // 主界面判据仍可见但压着卡片 / 二级面板的情况。
  const blockers: Array<[string, Rect | undefined, string]> = [
    [TPL.btnGather, CARD.anchorRoi, '资源点卡片'],
    [TPL.panelTitleTroop, undefined, '部队管理面板'],
    [TPL.btnSearch, undefined, '搜索面板'],
    [TPL.titleCreateTroop, undefined, '创建部队页']
  ]
  for (const [id, roi, name] of blockers) {
    const m = await s.matchOptional(id, roi)
    if (m?.found) {
      throw new AppError('STEP_FAILED', `当前开着${name}，不在主界面，稍后再试。`, { template: id })
    }
  }
  s.log('debug', `资源统计预检通过（${main.id} 命中 ${main.match.score}）。`)
}

/** ② 点「道具」→ 等资源统计按钮；③ 点按钮 → 等弹窗标题。 */
async function openStatsDialog(s: GatherSession): Promise<void> {
  const nav = await s.matchOptional(RES_TPL.navItems)
  const itemsTap: Point = nav?.found
    ? { x: nav.centerX, y: nav.centerY }
    : RESOURCE_STATS_LAYOUT.nav.itemsTap
  await s.tapAt(itemsTap, 1200)
  let btn = await s.waitFor([RES_TPL.btnResStats], { waitMs: WAIT_MS, pollMs: POLL_MS })
  if (!btn) {
    // 道具页可能停在上次选中的分类：点一下「资源」分类再等一次。
    const items = await s.matchOptional(RES_TPL.titleItemsRes)
    s.log('warn', `点「道具」后 ${WAIT_MS}ms 内没看到资源统计按钮${items?.found ? '（已在资源页）' : ''}，点「资源」分类再等一次。`)
    await s.tapAt(RESOURCE_STATS_LAYOUT.itemsPage.resourceCategoryTap, 1000)
    btn = await s.waitFor([RES_TPL.btnResStats], { waitMs: WAIT_MS, pollMs: POLL_MS })
  }
  if (!btn) {
    await s.shot('res-items-page-missing')
    throw new AppError('STEP_FAILED', '点了「道具」但没打开资源页（没找到「资源统计」按钮），已尝试还原。', {
      step: 'items'
    })
  }
  await s.tapAt({ x: btn.match.centerX, y: btn.match.centerY }, 1000)
  const title = await s.waitFor([RES_TPL.titleResStats], { waitMs: WAIT_MS, pollMs: POLL_MS })
  if (!title) {
    await s.shot('res-stats-dialog-missing')
    throw new AppError('STEP_FAILED', '点了「资源统计」按钮但弹窗没出现，已尝试还原。', { step: 'dialog' })
  }
}

/** ④ 弹窗已开：等动画停稳，读一帧；有格子读不出就换一帧再读一次并合并。 */
async function readOpenDialog(
  s: GatherSession,
  opts: ReadResourceStatsOptions,
  units: ResourceUnitTemplates
): Promise<ResourceSnapshot> {
  await s.sleep(600)
  s.invalidate()
  let f = await s.frame()
  let snap = await readResourceStatsFromFrame(f.raw, opts.templates, opts.instanceIndex, s.now(), { units })
  await verifyRowLabels(s, snap)
  if (snap.rows.some((r) => r.itemTotal == null || r.total == null)) {
    s.log('warn', `第一帧有格子读不出（${snap.warnings.join('；')}），换一帧复核。`)
    await s.sleep(500)
    s.invalidate()
    f = await s.frame()
    const second = await readResourceStatsFromFrame(f.raw, opts.templates, opts.instanceIndex, s.now(), { units })
    snap = mergeSnapshots(snap, second)
    if (snap.rows.some((r) => r.itemTotal == null || r.total == null)) {
      await s.shot('res-cell-unreadable')
    }
  }
  return snap
}

/** 行标签模板存在时顺手校验行序；不匹配只记告警，不改值。 */
async function verifyRowLabels(s: GatherSession, snap: ResourceSnapshot): Promise<void> {
  for (const row of snap.rows) {
    const id = RES_LABEL_TPL[row.type]
    const m = await s.matchOptional(id)
    if (m && !m.found) {
      snap.warnings.push(`第 ${RESOURCE_PANEL_ROW_ORDER.indexOf(row.type) + 1} 行标签不像「${RESOURCE_NAME[row.type]}」，行序可能变了`)
    }
  }
}

/**
 * ⑤ 还原：BACK → （标题仍在则点 X）→ BACK → 校验主界面；不行再用 ensureWorldMap 兜底。
 * ★ 每次 BACK 之后必须紧跟 dismissNoticeDialog：世界地图上多按一次 BACK 会弹「确定要退出游戏吗」，
 *   它只点「取消」，绝不点「确定」。
 * @returns 用了兜底阶梯才回来时的中文说明；干净回来返回 null
 * @throws AppError('STEP_FAILED') 仍回不到主界面（若前面已有失败，把还原失败追加进原错误的 message 后抛原错误）
 */
async function restoreMainScreen(s: GatherSession, priorFailure: unknown): Promise<string | null> {
  let warning: string | null = null
  try {
    await s.key('BACK', 900)
    await dismissNoticeDialog(s)
    // 第一次 BACK 后弹窗还在：点右上 X（只在模板命中时点）。
    const title = await s.matchOptional(RES_TPL.titleResStats)
    if (title?.found) {
      const close = await s.matchOptional(RES_TPL.btnCloseResStats)
      const at: Point = close?.found ? { x: close.centerX, y: close.centerY } : RESOURCE_STATS_LAYOUT.dialog.closeTap
      s.log('warn', 'BACK 没关掉资源统计弹窗，改点右上角 X。')
      await s.tapAt(at, 900)
      warning = 'BACK 没关掉资源统计弹窗，用右上角 X 关的'
    }
    await s.key('BACK', 900)
    await dismissNoticeDialog(s)
    const back = await s.waitFor(MAIN_SCREEN_TEMPLATES, { waitMs: WAIT_MS, pollMs: POLL_MS })
    if (back) {
      s.log('debug', `已还原到主界面（${back.id} 命中 ${back.match.score}）。`)
      return warning
    }
    await s.shot('res-restore-failed')
    s.log('warn', 'BACK×2 后没回到主界面，用 G0 阶梯兜底。')
    await ensureWorldMap(s, 3)
    return '读完后 BACK×2 没回到主界面，靠 G0 兜底才回来的，请留意模板是否仍有效'
  } catch (e) {
    const msg = `读完资源统计后没能回到主界面，请打开模拟器看一眼。（${errMsg(e)}）`
    s.log('error', msg)
    if (priorFailure instanceof Error) {
      priorFailure.message = `${priorFailure.message} 另外：${msg}`
      return null
    }
    throw new AppError('STEP_FAILED', msg, { step: 'restore' })
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
