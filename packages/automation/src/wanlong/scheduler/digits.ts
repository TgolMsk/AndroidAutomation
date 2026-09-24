/**
 * 数字识别（0-9 与 : / , . 的模板匹配），**不引任何 OCR 依赖**。移植自原版 src/main/scheduler/digits.ts。
 *
 * 为什么不用 tesseract：游戏里的数字是等宽位图字体，用现成的模板匹配就能做到
 * 实测 100% 正确率（见 tplkit ocr 的跨场景自检），而 tesseract 会引入几十 MB 的
 * 依赖与几百毫秒的延迟，还认不准这种带描边的游戏字体。
 *
 * 算法（与 tplkit 的 ocr 子命令同一套，那套已在真机上逐场景验证过）：
 *   ① 在 ROI 内按**列投影**把一串数字切成单字（不按固定步长切格子 ——
 *      实测 '1' 的墨迹只有 14px 而字宽 24px，固定切格会错位）；
 *   ② 每个字位拿整套字形做 matchIn，取 **argmax**（不是「第一个超过阈值就算」——
 *      实测同套内 6↔8 互匹能到 0.872，只看阈值必错）；
 *   ③ 按 x 拼串，再用正则整串校验；
 *   ④ 最高分与次高分的**余量**低于门限时标为低置信，由调用方决定要不要重截一帧。
 *
 * 三条硬约束（踩过就知道疼）：
 *   · 字形模板必须按 **shrink=1** 编译。TM_CCOEFF_NORMED 没有尺度不变性，
 *     数字只有 18~25px 高，shrink=2 掉到 9~12px，1/7、3/8 立刻混。
 *   · 字号或前景/背景**极性**不同的数字，必须是不同的字形集，绝不可复用
 *     （跨极性是强负相关，一个都匹配不上）。
 *   · 连字符（: / ,）一律当字形入集，不靠字间距去猜。
 *
 * ★ 本工程里它跑在视觉工作线程里（原版在主进程，每 24 次匹配让出一次事件循环；
 *   工作线程不需要让出，那段 maybeYield 已去掉）。
 */

import type { PreparedFrame, PreparedTemplate, Rect } from '../../contracts.js'
import { matchIn } from '../../vision.js'
import { AppError } from '../errors.js'

/** 字形集：一套「同字号 + 同极性」的 0-9 与分隔符。 */
export interface GlyphSet {
  /** 模板 id 前缀，例如 dig_dark20。 */
  prefix: string
  /** 中文说明，出现在错误信息里。 */
  label: string
  /** dark = 浅底深字；light = 深底浅字。决定列投影时哪一侧算前景。 */
  polarity: 'dark' | 'light'
  glyphs: { char: string; tpl: PreparedTemplate }[]
  /** 集内最宽的字形（参考分辨率像素），用来给窄字位补足 ROI。 */
  maxTplW: number
  /** 集内最高的字形。 */
  maxTplH: number
  /** 压平背景后的字形（懒生成缓存），见 readNumberText 里关于进度条的说明。 */
  binGlyphs?: { char: string; tpl: PreparedTemplate }[]
}

export interface ReadOptions {
  /** 整串必须匹配的正则；不过就判失败（宁可返回 null 也不给一个错的数）。 */
  pattern?: RegExp
  /** 字形最低分，默认 0.70。低于它的字位记 '?'。 */
  minScore?: number
  /** 判定「可信」的最低分，默认 0.78。达不到但余量足够大时仍算可信，见 confidentMargin。 */
  confidentScore?: number
  /** argmax 与次高分的最小余量，默认 0.06。低于它一律记 '?'。 */
  minMargin?: number
  /**
   * 余量达到这个值就算可信（默认 0.15），哪怕绝对分没到 confidentScore。
   *
   * ★ 为什么需要这一条：冒号只有 7px 宽，绝对分天然比数字低（实测 0.748~0.762），
   *   但它与次高分的差距有 0.27 —— 判别力其实好得很。只看绝对分会让每一条
   *   「00:00:23」都挂上低置信告警，把真正该看的告警淹掉。
   */
  confidentMargin?: number
  /**
   * 匹配前把识别带与字形的背景「压平」（背景侧的像素统一抬/压到同一灰度，字芯灰阶原样保留）。
   * 不传：深底浅字集（进度条上的白字）先原样读、读不出或不可信再压平重读；浅底深字集只原样读。
   * ★ 为什么：绿色载重条随进度推进，边界扫到哪个数字，哪个数字底下就一半绿一半灰，
   *   灰底裁的字形打上去只有 0.7~0.8，字位就丢了（实测「01:44:06」读成「01:4:06」）。
   *   压平后绿(≈115)灰(≈138)变成同一个值，边界随之消失，得分与底色无关。
   */
  binarize?: boolean
  /** 一个字形段至少多少列才算数（滤掉描边毛刺），默认 3。 */
  minSegW?: number
  /** 期望的字符个数；给了就用来校验切分是否合理。 */
  expectChars?: number
}

export interface ReadResult {
  /** 识别到的整串；失败为 null。 */
  text: string | null
  /** 每个字位都达到 confidentScore 且整串过正则。 */
  confident: boolean
  /** 中文失败/告警原因；成功且高置信时为 undefined。 */
  reason?: string
  /** 排障用：每个字位的落点、选中的字符、得分与余量。 */
  detail: { x: number; w: number; char: string; score: number; margin: number }[]
}

/**
 * 前景判定的「收紧程度」阶梯（越小越只认字芯）。第一档切不出东西就自动放宽。
 *
 * ★ 为什么不是简单的「与背景差 > 固定阈值」：游戏里很多数字是**白字 + 黑描边**
 *   （部队管理的耐力 105/105、兵力 31,500 都是）。按「与背景不同」去切，
 *   相邻两个字的黑描边会连在一起，整串被切成**一段**，读出来只有一个 '?'。
 *   改成按分位数只认「字芯」那一档亮度，描边自然落在前景之外，字与字就分开了。
 */
const FG_FACTORS = [0.35, 0.5, 0.65, 0.8]

/** 模板 id 后缀 -> 实际字符。 */
export function charOfSuffix(suffix: string): string | null {
  if (/^\d$/.test(suffix)) return suffix
  switch (suffix) {
    case 'colon':
      return ':'
    case 'slash':
      return '/'
    case 'comma':
      return ','
    case 'dot':
      return '.'
    default:
      return null
  }
}

/**
 * 从已编译好的模板表里挑出一套字形。
 * @param tpls  必须是 **shrink=1** 编译出来的表
 */
export function buildGlyphSet(
  prefix: string,
  label: string,
  polarity: 'dark' | 'light',
  tpls: Iterable<[string, PreparedTemplate]>
): GlyphSet {
  const glyphs: { char: string; tpl: PreparedTemplate }[] = []
  for (const [id, tpl] of tpls) {
    if (!id.startsWith(`${prefix}_`)) continue
    const char = charOfSuffix(id.slice(prefix.length + 1))
    if (char == null) continue
    if (tpl.shrink !== 1) {
      throw new AppError(
        'INVALID_ARGUMENT',
        `数字字形「${id}」是按 shrink=${tpl.shrink} 编译的。\n` +
          '数字模板只有 18~25 像素高，必须用 shrink=1 编译，否则 1/7、3/8 会互相混淆。' +
          `请在模板库里给它加上 digit 与 ${prefix} 两个标签后重新保存。`,
        { templateId: id, shrink: tpl.shrink }
      )
    }
    glyphs.push({ char, tpl })
  }
  if (glyphs.length === 0) {
    throw new AppError(
      'TEMPLATE_NOT_FOUND',
      `模板集里找不到前缀为「${prefix}_」的数字字形（${label}）。\n` +
        '请先在模板库里把这套字形裁出来（标签 digit + 字形集名），否则这一项数值读不出来。',
      { prefix }
    )
  }
  return {
    prefix,
    label,
    polarity,
    glyphs,
    maxTplW: Math.max(...glyphs.map((g) => g.tpl.refW)),
    maxTplH: Math.max(...glyphs.map((g) => g.tpl.refH))
  }
}

/** 集里有哪些字符（拼错误信息用）。 */
export function glyphChars(set: GlyphSet): string {
  return set.glyphs
    .map((g) => g.char)
    .sort()
    .join('')
}

// ── 列投影切字 ────────────────────────────────────────────────────────────

interface Segment {
  x0: number
  x1: number
}

/** 把 rect 夹进帧范围内；夹完为空返回 null。 */
function clampRect(frame: PreparedFrame, r: Rect): Rect | null {
  const x = Math.max(0, Math.round(r.x))
  const y = Math.max(0, Math.round(r.y))
  const x2 = Math.min(frame.w, Math.round(r.x + r.w))
  const y2 = Math.min(frame.h, Math.round(r.y + r.h))
  if (x2 - x < 2 || y2 - y < 2) return null
  return { x, y, w: x2 - x, h: y2 - y }
}

interface Levels {
  /** 中位数 ≈ 背景（文字总是 ROI 里的少数派）。 */
  bg: number
  /** 2% 分位，≈ 最暗的字芯/描边。 */
  lo: number
  /** 98% 分位，≈ 最亮的字芯。 */
  hi: number
}

/** 统计 ROI 的亮度分位数。比「取四条边的中位数」稳得多 —— 文字压在色条上时边框就是色条本身。 */
function levelsOf(frame: PreparedFrame, r: Rect): Levels {
  const px: number[] = []
  for (let j = 0; j < r.h; j++) {
    const row = (r.y + j) * frame.w + r.x
    for (let i = 0; i < r.w; i++) px.push(frame.gray[row + i]!)
  }
  px.sort((a, b) => a - b)
  const at = (q: number): number => px[Math.min(px.length - 1, Math.max(0, Math.floor(q * px.length)))] ?? 128
  return { bg: at(0.5), lo: at(0.02), hi: at(0.98) }
}

/** 按分位数算出「多亮/多暗才算字芯」的分界值。 */
function cutOf(lv: Levels, polarity: 'dark' | 'light', factor: number): number {
  return polarity === 'light'
    ? Math.max(lv.bg + 10, lv.hi - factor * (lv.hi - lv.bg))
    : Math.min(lv.bg - 10, lv.lo + factor * (lv.bg - lv.lo))
}

function segmentColumns(
  frame: PreparedFrame,
  r: Rect,
  polarity: 'dark' | 'light',
  cut: number,
  minSegW: number
): Segment[] {
  const isFg = (v: number): boolean => (polarity === 'light' ? v >= cut : v <= cut)
  const cols = new Array<number>(r.w).fill(0)
  for (let j = 0; j < r.h; j++) {
    const row = (r.y + j) * frame.w + r.x
    for (let i = 0; i < r.w; i++) {
      if (isFg(frame.gray[row + i]!)) cols[i]!++
    }
  }
  const segs: Segment[] = []
  let cur: Segment | null = null
  for (let i = 0; i < r.w; i++) {
    if (cols[i]! > 0) {
      if (!cur) cur = { x0: i, x1: i }
      else cur.x1 = i
    } else if (cur) {
      if (cur.x1 - cur.x0 + 1 >= minSegW) segs.push(cur)
      cur = null
    }
  }
  if (cur && cur.x1 - cur.x0 + 1 >= minSegW) segs.push(cur)
  return segs
}

/** 背景压平的分界：背景中位数往字芯方向走这么大比例。 */
const FLATTEN_FACTOR = 0.35

/**
 * 把识别带（外扩一个字形的宽高）「压平背景」成一个独立的小帧：
 * 深底浅字把 < level 的像素抬到 level；浅底深字把 > level 的像素压到 level。字芯灰阶原样保留。
 */
function flattenedBand(
  frame: PreparedFrame,
  rect: Rect,
  set: GlyphSet,
  level: number
): { frame: PreparedFrame; dx: number; dy: number } | null {
  const mx = set.maxTplW + 8
  const my = set.maxTplH + 8
  const band = clampRect(frame, {
    x: rect.x - mx,
    y: rect.y - my,
    w: rect.w + mx * 2,
    h: rect.h + my * 2
  })
  if (!band) return null
  const light = set.polarity === 'light'
  const gray = new Uint8Array(band.w * band.h)
  for (let j = 0; j < band.h; j++) {
    const row = (band.y + j) * frame.w + band.x
    for (let i = 0; i < band.w; i++) {
      const v = frame.gray[row + i]!
      gray[j * band.w + i] = light ? Math.max(v, level) : Math.min(v, level)
    }
  }
  return {
    frame: { ...frame, gray, w: band.w, h: band.h, width: band.w, height: band.h },
    dx: band.x,
    dy: band.y
  }
}

/** 字形按自身亮度分位数压平背景（与 flattenedBand 同口径），每套只算一次。 */
function flattenedGlyphs(set: GlyphSet): { char: string; tpl: PreparedTemplate }[] {
  if (set.binGlyphs) return set.binGlyphs
  const light = set.polarity === 'light'
  set.binGlyphs = set.glyphs.map((g) => {
    const px = Array.from(g.tpl.gray).sort((a, b) => a - b)
    const at = (q: number): number =>
      px[Math.min(px.length - 1, Math.max(0, Math.floor(q * px.length)))] ?? 128
    const level = light
      ? Math.round(at(0.5) + FLATTEN_FACTOR * (at(0.98) - at(0.5)))
      : Math.round(at(0.5) - FLATTEN_FACTOR * (at(0.5) - at(0.02)))
    const flat = new Uint8Array(g.tpl.gray.length)
    for (let i = 0; i < flat.length; i++) {
      const v = g.tpl.gray[i]!
      flat[i] = light ? Math.max(v, level) : Math.min(v, level)
    }
    return { char: g.char, tpl: { ...g.tpl, id: `${g.tpl.id}#flat`, gray: flat } }
  })
  return set.binGlyphs
}

/** 单个字形段宽度超过集里最宽字形的这个倍数，就认为是两个字形黏在一起了。 */
const WIDE_SEGMENT_RATIO = 1.35

/**
 * 把过宽的字形段在「前景像素最少的那一列」劈开（只在中间 30%~70% 区间找谷底，别劈到字形边缘）。
 * 劈完仍过宽会继续劈；找不到明显谷底就原样保留（宁可少认一个字位，也不乱切）。
 */
function splitWideSegments(
  frame: PreparedFrame,
  r: Rect,
  polarity: 'dark' | 'light',
  cut: number,
  segs: Segment[],
  maxGlyphW: number
): Segment[] {
  const limit = Math.max(6, Math.round(maxGlyphW * WIDE_SEGMENT_RATIO))
  const isFg = (v: number): boolean => (polarity === 'light' ? v >= cut : v <= cut)
  const out: Segment[] = []
  const queue: Segment[] = [...segs]
  let guard = 0
  while (queue.length > 0 && guard++ < 64) {
    const seg = queue.shift()!
    const w = seg.x1 - seg.x0 + 1
    if (w <= limit) {
      out.push(seg)
      continue
    }
    const cols = new Array<number>(w).fill(0)
    for (let j = 0; j < r.h; j++) {
      const row = (r.y + j) * frame.w + r.x + seg.x0
      for (let i = 0; i < w; i++) if (isFg(frame.gray[row + i]!)) cols[i]!++
    }
    const lo = Math.floor(w * 0.3)
    const hi = Math.ceil(w * 0.7)
    let at = -1
    let min = Number.POSITIVE_INFINITY
    for (let i = lo; i <= hi; i++) {
      if (cols[i]! < min) {
        min = cols[i]!
        at = i
      }
    }
    // 谷底还有一半以上的行是前景，说明不是缝而是笔画（例如一个真的很宽的字形），不劈。
    if (at < 0 || min > r.h * 0.5) {
      out.push(seg)
      continue
    }
    queue.unshift({ x0: seg.x0 + at + 1, x1: seg.x1 })
    queue.unshift({ x0: seg.x0, x1: seg.x0 + at - 1 })
  }
  // 超过 guard 还没处理完的段原样保留（极端输入，不能静默丢字位）。
  out.push(...queue)
  return out.filter((sg) => sg.x1 >= sg.x0).sort((a, b) => a.x0 - b.x0)
}

// ── 读一串数字 ────────────────────────────────────────────────────────────

/**
 * 在 ROI 里读出一串数字。
 *
 * @param frame  **shrink=1** 的预处理帧（数字识别不接受降采样帧）
 * @param roi    参考分辨率坐标
 */
export async function readNumberText(
  frame: PreparedFrame,
  roi: Rect,
  set: GlyphSet,
  opts: ReadOptions = {}
): Promise<ReadResult> {
  // 深底浅字（进度条上的白字）默认两遍：先原样匹配（底色单一时得分最高），
  // 读不出或不可信时再「压平背景」重读一遍（绿灰边界压住数字时靠它），取更好的那次。
  if (opts.binarize === undefined && set.polarity === 'light') {
    const plain = await readNumberOnce(frame, roi, set, { ...opts, binarize: false })
    if (plain.text != null && plain.confident) return plain
    const flat = await readNumberOnce(frame, roi, set, { ...opts, binarize: true })
    if (flat.text != null && (plain.text == null || flat.confident)) return flat
    return plain
  }
  return readNumberOnce(frame, roi, set, opts)
}

async function readNumberOnce(
  frame: PreparedFrame,
  roi: Rect,
  set: GlyphSet,
  opts: ReadOptions
): Promise<ReadResult> {
  if (frame.shrink !== 1) {
    throw new AppError(
      'INVALID_ARGUMENT',
      `读数字要求 shrink=1 的帧，当前帧是 shrink=${frame.shrink}。` +
        '请另外做一次 prepareFrame(raw, { shrink: 1 })（全屏约 8ms，为读几个数字完全值得）。',
      { shrink: frame.shrink }
    )
  }

  const minScore = opts.minScore ?? 0.7
  const confidentScore = opts.confidentScore ?? 0.78
  const minMargin = opts.minMargin ?? 0.06
  const confidentMargin = opts.confidentMargin ?? 0.15
  const minSegW = opts.minSegW ?? 3

  const rect = clampRect(frame, roi)
  if (!rect) {
    return { text: null, confident: false, reason: `${set.label}：识别区域超出画面范围`, detail: [] }
  }

  const lv = levelsOf(frame, rect)

  // 阶梯：优先用最严的（只认字芯），切不出东西再放宽。
  // 极性写错是最常见的低级错误（描边字尤其难判），所以主极性全阶梯落空后自动试反极性。
  let segs: Segment[] = []
  let usedFactor = 0
  let usedPolarity: 'dark' | 'light' = set.polarity
  let usedCut = 0
  const flipped: 'dark' | 'light' = set.polarity === 'dark' ? 'light' : 'dark'
  outer: for (const polarity of [set.polarity, flipped]) {
    for (const factor of FG_FACTORS) {
      const cut = cutOf(lv, polarity, factor)
      const s = segmentColumns(frame, rect, polarity, cut, minSegW)
      if (s.length === 0) continue
      segs = s
      usedFactor = factor
      usedPolarity = polarity
      usedCut = cut
      // 字符数对上了就别再放宽了，放宽只会把描边毛刺也切进来。
      if (opts.expectChars == null || s.length === opts.expectChars) break outer
    }
    if (segs.length > 0) break
  }

  // ★ 载重条的绿/灰边界有一条亮的竖线；它落在两个数字的缝里时会把两个字形黏成一段
  //   （实测「01:44:06」的「44」黏成 35px 一段，只认出一个 4 → 读成「01:4:06」）。
  //   单个字形不可能比集里最宽的字形宽太多，宽到 1.35 倍以上就在前景最少的那一列劈开。
  segs = splitWideSegments(frame, rect, usedPolarity, usedCut, segs, set.maxTplW)

  if (segs.length === 0) {
    return {
      text: null,
      confident: false,
      reason:
        `${set.label}：识别区域 (${rect.x},${rect.y} ${rect.w}x${rect.h}) 内没有找到任何字形。` +
        `背景灰度 ${lv.bg}（暗端 ${lv.lo} / 亮端 ${lv.hi}），极性 ${set.polarity === 'dark' ? '浅底深字' : '深底浅字'}。` +
        '多半是界面还没画完、ROI 偏了，或者这一行本来就是空的。',
      detail: []
    }
  }
  // 一串数字不可能有几十个字形，多半是把边框/图标切进来了。
  if (segs.length > 16) {
    return {
      text: null,
      confident: false,
      reason: `${set.label}：切出了 ${segs.length} 个字形段，明显超出合理范围，识别区域里混进了别的元素。`,
      detail: []
    }
  }

  // ★ 不是硬二值化（0/255 会把描边的灰阶全丢掉，8/3、6/5 反而分不开），而是「压平背景」：
  //   深底浅字把所有低于 floor 的像素抬到 floor —— 绿(≈115)灰(≈138)都被抬成同一个值，边界消失，
  //   字芯和描边的灰阶原样保留。floor 取背景中位数往亮端走 35%。字形按同口径处理。
  const binarize = opts.binarize ?? false
  const flatLevel =
    set.polarity === 'light'
      ? Math.round(lv.bg + FLATTEN_FACTOR * (lv.hi - lv.bg))
      : Math.round(lv.bg - FLATTEN_FACTOR * (lv.bg - lv.lo))
  const band = binarize ? flattenedBand(frame, rect, set, flatLevel) : null
  const glyphs = band ? flattenedGlyphs(set) : set.glyphs

  const detail: ReadResult['detail'] = []
  const chars: string[] = []
  let lowConfidence = false

  for (const s of segs) {
    // ROI 必须比集里最宽的字形还宽，否则窄字位（冒号）上所有模板都塞不下，得分恒为 0。
    const segW = s.x1 - s.x0 + 1
    const pad = Math.max(4, Math.ceil((set.maxTplW - segW) / 2) + 3)
    const padY = Math.max(4, Math.ceil((set.maxTplH - rect.h) / 2) + 3)
    const cellRoi: Rect = {
      x: rect.x + s.x0 - pad,
      y: rect.y - padY,
      w: segW + pad * 2,
      h: rect.h + padY * 2
    }

    let bestChar = '?'
    let best = -1
    let second = -1
    const cellFrame = band ? band.frame : frame
    const cellRoiIn = band
      ? { x: cellRoi.x - band.dx, y: cellRoi.y - band.dy, w: cellRoi.w, h: cellRoi.h }
      : cellRoi
    for (const g of glyphs) {
      // threshold 压到最低：这里要的是**分数排序**，不是命中与否。
      const m = await matchIn(cellFrame, g.tpl, { roi: cellRoiIn, threshold: 0.01 })
      if (m.score > best) {
        second = best
        best = m.score
        bestChar = g.char
      } else if (m.score > second) {
        second = m.score
      }
    }

    const margin = second < 0 ? best : best - second
    const ok = best >= minScore && margin >= minMargin
    const ch = ok ? bestChar : '?'
    if (!ok || (best < confidentScore && margin < confidentMargin)) lowConfidence = true
    chars.push(ch)
    detail.push({
      x: rect.x + s.x0,
      w: segW,
      char: ch,
      score: Math.round(best * 10000) / 10000,
      margin: Math.round(margin * 10000) / 10000
    })
  }

  const text = chars.join('')

  if (text.includes('?')) {
    return {
      text: null,
      confident: false,
      reason:
        `${set.label}：有 ${chars.filter((c) => c === '?').length} 个字位认不出来（读到「${text}」）。` +
        `本套字形只有 ${glyphChars(set)}，缺字或界面变了都会这样。`,
      detail
    }
  }
  if (opts.pattern && !opts.pattern.test(text)) {
    return {
      text: null,
      confident: false,
      reason: `${set.label}：读到「${text}」，不符合预期格式 ${String(opts.pattern)}，按识别失败处理。`,
      detail
    }
  }
  if (opts.expectChars != null && text.length !== opts.expectChars) {
    return {
      text: null,
      confident: false,
      reason: `${set.label}：读到「${text}」共 ${text.length} 位，与预期的 ${opts.expectChars} 位不符。`,
      detail
    }
  }

  return {
    text,
    confident: !lowConfidence,
    reason: lowConfidence
      ? `${set.label}：读到「${text}」，但部分字位得分偏低（切分收紧度 ${usedFactor}），建议重截一帧复核。`
      : undefined,
    detail
  }
}
