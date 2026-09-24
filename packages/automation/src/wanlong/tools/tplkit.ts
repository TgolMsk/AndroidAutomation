/**
 * 模板裁剪工具箱（tplkit）的纯计算部分：区域分析、字形切分、OCR 字位、验收判据。
 *
 * 命令行入口在 apps/wanlong-assistant/scripts/tplkit.ts（抓帧 / 读写 PNG / 模板库都在那边）；
 * 这里只收 {w,h,gray} 灰度块，方便离线自检（test/tplkit.test.ts）。
 *
 * ★ 字形 id 后缀必须能被 loadGatherTemplates 解析（glyphCharOf）：数字直接用 `0`~`9`，
 *   标点用 colon / comma / slash / dot / percent。原版 tplkit 生成的 `d0` / `pct` 加载器认不出，
 *   会被当成缺失 —— 真实模板集（dig_dark20_0 …）用的一直是裸数字，这里与它对齐。
 */

import type { MatchResult, Rect } from '../../contracts.js'

/** 一块灰度（参考像素，shrink=1）。 */
export interface GrayRegion {
  w: number
  h: number
  gray: Uint8Array
}

export type Polarity = 'light' | 'dark' | 'abs'

/** tplkit save 作业（JSON 数组）。 */
export interface SaveJob {
  id: string
  name: string
  frame: string
  crop: Rect
  defaultRoi?: Rect
  threshold?: number
  tags?: string[]
  note?: string
  /** 透明底：几张「同一控件、同一位置、不同背景」的整帧，与 frame 做多帧差分去底。 */
  diffFrames?: string[]
  /** 差分容差，默认 24。 */
  diffTolerance?: number
}

/** tplkit verify 作业。 */
export interface VerifyJob {
  id: string
  /** 正样本帧（应当命中）+ 期望命中的位置（模板 bounds 的 x,y） */
  pos: { frame: string; expect?: [number, number]; roi?: Rect }
  /** 负样本：帧 + ROI（必须落空） */
  neg: Array<{ frame: string; roi?: Rect; label?: string }>
  threshold?: number
}

/** verify 的正样本门槛：分数 ≥ 0.95、位置偏差 ≤ 2 像素。 */
export const VERIFY_MIN_SCORE = 0.95
export const VERIFY_MAX_OFFSET = 2
/** glyphs 生成的字形模板阈值。 */
export const GLYPH_THRESHOLD = 0.78

const CHAR_NAME: Record<string, string> = {
  ':': 'colon',
  ',': 'comma',
  '/': 'slash',
  '.': 'dot',
  '%': 'percent'
}

/** 字符 -> 模板 id 后缀（数字直接用本身，与 glyphCharOf 往返一致）。 */
export function charSuffix(c: string): string {
  if (c.length === 1 && c >= '0' && c <= '9') return c
  const n = CHAR_NAME[c]
  if (!n) throw new Error(`未支持的字符：${c}`)
  return n
}

/** 字形模板的固定 id：`<字形集前缀>_<后缀>`，例如 dig_panel_level_9。 */
export function glyphTemplateId(prefix: string, c: string): string {
  return `${prefix}_${charSuffix(c)}`
}

/** 背景 = 四条边像素的中位数。 */
export function edgeMedian(g: GrayRegion): number {
  const edge: number[] = []
  for (let i = 0; i < g.w; i++) edge.push(g.gray[i]!, g.gray[(g.h - 1) * g.w + i]!)
  for (let j = 0; j < g.h; j++) edge.push(g.gray[j * g.w]!, g.gray[j * g.w + g.w - 1]!)
  edge.sort((a, b) => a - b)
  return edge[Math.floor(edge.length / 2)] ?? 0
}

function foreground(polarity: string | undefined, thr: number, bg: number): (v: number) => boolean {
  return polarity === 'light'
    ? (v) => v - bg > thr
    : polarity === 'dark'
      ? (v) => bg - v > thr
      : (v) => Math.abs(v - bg) > thr
}

/** 与原版相同的单遍标准差（stdDev 的口径）。 */
function std(d: Uint8Array): number {
  if (d.length === 0) return 0
  let sum = 0
  let sq = 0
  for (const v of d) {
    sum += v
    sq += v * v
  }
  const mean = sum / d.length
  return Math.sqrt(Math.max(0, sq / d.length - mean * mean))
}

/** 连续的非零列为一段；窄于 minSegW 的段丢掉（抗噪点）。 */
function columnSegments(colCount: number[], minSegW: number): Array<{ x0: number; x1: number }> {
  const segs: Array<{ x0: number; x1: number }> = []
  let cur: { x0: number; x1: number } | null = null
  for (let i = 0; i < colCount.length; i++) {
    if (colCount[i]! > 0) {
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

export interface RegionAnalysis {
  rect: Rect
  mean: number
  bg: number
  stdFull: number
  /** 按 shrink 点采样后的 std —— 方差守卫真正看的口径（守卫下限 12）。 */
  stdShrink2: number
  tight: Rect | null
  colSegs: Array<{ x: number; w: number }>
  rowFirstLast: [number, number] | null
}

/**
 * 区域分析：std / 均值 / 背景 / 前景紧致外接框 / 列投影分段。
 * 前景 = 与背景差 > thr（默认 45），极性 light / dark / 其它（绝对值）。
 */
export function analyzeRegion(g: GrayRegion, rect: Rect, polarity?: string, thr = 45, shrink = 2): RegionAnalysis {
  const { w, h } = g
  let sum = 0
  for (const v of g.gray) sum += v
  const bg = edgeMedian(g)
  const isFg = foreground(polarity, thr, bg)
  let minX = w
  let maxX = -1
  let minY = h
  let maxY = -1
  const colCount = new Array<number>(w).fill(0)
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      if (!isFg(g.gray[j * w + i]!)) continue
      colCount[i]!++
      if (i < minX) minX = i
      if (i > maxX) maxX = i
      if (j < minY) minY = j
      if (j > maxY) maxY = j
    }
  }
  const segs = columnSegments(colCount, 1)
  const s = Math.max(1, Math.floor(shrink))
  const sw = Math.max(1, Math.floor(w / s))
  const sh = Math.max(1, Math.floor(h / s))
  const small = new Uint8Array(sw * sh)
  for (let j = 0; j < sh; j++) for (let i = 0; i < sw; i++) small[j * sw + i] = g.gray[j * s * w + i * s]!
  return {
    rect,
    mean: Number((sum / g.gray.length).toFixed(1)),
    bg,
    stdFull: Number(std(g.gray).toFixed(1)),
    stdShrink2: Number(std(small).toFixed(1)),
    tight: maxX < 0 ? null : { x: rect.x + minX, y: rect.y + minY, w: maxX - minX + 1, h: maxY - minY + 1 },
    colSegs: segs.map((seg) => ({ x: rect.x + seg.x0, w: seg.x1 - seg.x0 + 1 })),
    rowFirstLast: maxY < 0 ? null : [rect.y + minY, rect.y + maxY]
  }
}

export interface GlyphSegmentation {
  bg: number
  segs: Array<{ x0: number; x1: number }>
  /** 前景行范围（区域内坐标）；没有前景时 maxY = -1。 */
  minY: number
  maxY: number
}

/** 按列投影把一串数字切成单字。 */
export function segmentGlyphs(g: GrayRegion, polarity: string, thr: number, minSegW: number): GlyphSegmentation {
  const bg = edgeMedian(g)
  const isFg = foreground(polarity, thr, bg)
  const colCount = new Array<number>(g.w).fill(0)
  let minY = g.h
  let maxY = -1
  for (let j = 0; j < g.h; j++) {
    for (let i = 0; i < g.w; i++) {
      if (!isFg(g.gray[j * g.w + i]!)) continue
      colCount[i]!++
      if (j < minY) minY = j
      if (j > maxY) maxY = j
    }
  }
  return { bg, segs: columnSegments(colCount, minSegW), minY, maxY }
}

export interface GlyphCutOptions {
  /** 帧文件路径（写进作业，save 时读它）。 */
  frame: string
  rect: Rect
  polarity: string
  thr: number
  chars: string
  prefix: string
  /** 每个字形四周多留的同色背景像素，默认 2。 */
  pad?: number
  /** 最窄字形段，默认 2。 */
  minSegW?: number
}

export type GlyphCutResult =
  | { ok: true; jobs: SaveJob[]; glyphRow: [number, number]; glyphH: number; widths: number[]; ids: string[] }
  | { ok: false; warn: string; segs: Array<{ x: number; w: number }>; chars: number; rows: [number, number] | null }

/**
 * 字形切分：统一用整串的行范围（同一套字形等高），逐字加 pad；重复字符只取第一个。
 * 段数与字符数对不上时返回 ok:false（请调 ROI / 阈值 / minSegW），不生成半套作业。
 */
export function cutGlyphJobs(g: GrayRegion, opts: GlyphCutOptions): GlyphCutResult {
  const pad = opts.pad ?? 2
  const seg = segmentGlyphs(g, opts.polarity, opts.thr, opts.minSegW ?? 2)
  if (seg.maxY < 0) throw new Error('ROI 内没有前景像素，检查极性/阈值/坐标')
  const { x, y } = opts.rect
  const list = [...opts.chars]
  if (seg.segs.length !== list.length) {
    return {
      ok: false,
      warn: '切出的字形段数与给定字符数不符，请调整 ROI/阈值/minSegW',
      segs: seg.segs.map((s) => ({ x: x + s.x0, w: s.x1 - s.x0 + 1 })),
      chars: list.length,
      rows: [y + seg.minY, y + seg.maxY]
    }
  }
  const top = y + seg.minY - pad
  const height = seg.maxY - seg.minY + 1 + pad * 2
  const jobs: SaveJob[] = []
  const seen = new Set<string>()
  const frameName = opts.frame.split(/[\\/]/).pop()
  for (let k = 0; k < seg.segs.length; k++) {
    const c = list[k]!
    const id = glyphTemplateId(opts.prefix, c)
    if (seen.has(id)) continue
    seen.add(id)
    const s = seg.segs[k]!
    jobs.push({
      id,
      name: `${opts.prefix} 字形 ${c}`,
      frame: opts.frame,
      crop: { x: x + s.x0 - pad, y: top, w: s.x1 - s.x0 + 1 + pad * 2, h: height },
      threshold: GLYPH_THRESHOLD,
      tags: ['digit', opts.prefix],
      note: `从 ${frameName} 的 ${x},${y},${opts.rect.w},${opts.rect.h} 切出；字形 ${c}`
    })
  }
  return {
    ok: true,
    jobs,
    glyphRow: [top, top + height - 1],
    glyphH: height,
    widths: jobs.map((j) => j.crop.w),
    ids: jobs.map((j) => j.id)
  }
}

/**
 * OCR 字位的搜索区：必须比最宽的字形还宽，否则窄字位（冒号）上所有模板都塞不下、分数恒为 0。
 */
export function ocrSegmentRoi(seg: { x0: number; x1: number }, rect: Rect, maxTplW: number): Rect {
  const segW = seg.x1 - seg.x0 + 1
  const pad = Math.max(4, Math.ceil((maxTplW - segW) / 2) + 3)
  return { x: rect.x + seg.x0 - pad, y: rect.y - 4, w: segW + pad * 2, h: rect.h + 8 }
}

/** 字形模板 id → 字符（ocr 的回显用；与 glyphCharOf 同口径）。 */
export function glyphIdToChar(id: string, prefix: string): string {
  const suffix = id.startsWith(`${prefix}_`) ? id.slice(prefix.length + 1) : (id.split('_').pop() ?? '')
  const named = Object.entries(CHAR_NAME).find(([, name]) => name === suffix)
  return named ? named[0] : suffix
}

/** 一个字位上的 argmax：最佳 / 次佳 / 余量。 */
export function pickBest(scores: ReadonlyArray<{ id: string; score: number }>): { id: string; score: number; second: number; margin: number } {
  let best = { id: '', score: -1 }
  let second = -1
  for (const s of scores) {
    if (s.score > best.score) {
      second = best.score
      best = { id: s.id, score: s.score }
    } else if (s.score > second) second = s.score
  }
  return { ...best, second, margin: best.score - second }
}

/** verify 判据：正样本命中且 ≥ 0.95、位置偏差 ≤ 2；负样本一个都不能命中。 */
export function verifyVerdict(
  hit: Pick<MatchResult, 'found' | 'score' | 'x' | 'y'>,
  expect: [number, number] | undefined,
  negatives: ReadonlyArray<Pick<MatchResult, 'found'>>
): { ok: boolean; posOk: boolean; negOk: boolean; dx: number | null; dy: number | null } {
  const dx = expect ? Math.abs(hit.x - expect[0]) : null
  const dy = expect ? Math.abs(hit.y - expect[1]) : null
  const posOk = hit.found && hit.score >= VERIFY_MIN_SCORE && (dx === null || (dx <= VERIFY_MAX_OFFSET && dy! <= VERIFY_MAX_OFFSET))
  const negOk = negatives.every((n) => !n.found)
  return { ok: posOk && negOk, posOk, negOk, dx, dy }
}
