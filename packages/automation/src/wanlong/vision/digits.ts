/**
 * 数字识别：0-9 逐字形模板匹配（**不引入中文 OCR**）。
 *
 * 游戏里的数字是等宽位图字体，模板匹配比 tesseract 快一到两个数量级且更准；
 * 为了认几个数字引一个 OCR 引擎不划算（ARCHITECTURE.md 第 7 节的明确建议）。
 *
 * 流程（与 gather-flow.json 的 digitRecognition.pipeline 一致）：
 *   1. 按 ROI 从裸帧裁一块 **shrink=1** 的灰度（数字只有 18~25px 宽，shrink=2 会掉到 9~12px，1/7、3/8 极易混）
 *   2. 该字形集里每个字形做一次 matchAll（多峰），阈值默认 0.78（低于全局 0.85：数字模板小、纹理少）
 *   3. 跨字形做一次贪心 NMS（抑制半径按两者中较**窄**的字形算，否则逗号会被相邻数字吃掉）
 *   4. 按 x 升序拼串；相邻峰间距 > 1.6 * 字形中位宽 ⇒ 中间漏识别，插 '?'
 *   5. 由调用方用正则做整串校验，不通过就换一帧重读（绝不「猜一个值」继续）
 *
 * ★ 字号或前景/背景极性不同的数字**必须**是不同的字形集：
 *   TM_CCOEFF_NORMED 既没有尺度不变性，跨极性还会给出强负相关（黑字模板打白字一个都打不中）。
 */

import { AppError } from '../errors.js'
import type { PreparedTemplate, RawFrame, Rect } from '../../contracts.js'
import { matchAllInCrop, type Peak } from './matchAll.js'
import { grayCropRef } from './raster.js'

/** 一个字形：一个字符对应一张按 shrink=1 编译的小模板。 */
export interface Glyph {
  char: string
  tpl: PreparedTemplate
}

/** 一套字形（同字号 + 同极性）。跨套复用必然失配，见文件头。 */
export interface GlyphSet {
  /** 字形集名，如 dig_dark20 / dig_light16。 */
  name: string
  glyphs: Glyph[]
  /** 字形宽度中位数（参考像素），用于判断「相邻两个峰之间是否漏了字」。 */
  medianGlyphW: number
}

/** 识别到的单个字符。 */
export interface DigitChar {
  char: string
  x: number
  y: number
  score: number
}

export interface DigitReading {
  /** 拼出来的串。含 '?' 表示中间有漏识别的位置。 */
  text: string
  chars: DigitChar[]
  /** 各字形里最低的那个分数（没有字符时为 0）。 */
  minScore: number
  /** 是否存在 '?' 占位。 */
  hasGap: boolean
  /** 实际使用的 ROI（已夹进画面）。null 表示 ROI 完全落在画外。 */
  roi: Rect | null
}

export interface ReadDigitsOptions {
  /** 单字形最低分。默认 0.78。 */
  minScore?: number
  /** 一个 ROI 里最多认多少个字符。默认 16。 */
  maxChars?: number
}

/** 单字形接受阈值。低于全局 0.85 是有意为之：数字模板小、纹理少。 */
export const GLYPH_MIN_SCORE = 0.78
/** 低置信区间下界：落在 [LOW, GLYPH_MIN_SCORE) 的读数需要换一帧复核。 */
export const GLYPH_LOW_CONFIDENCE = 0.7

/**
 * 读一个 ROI 里的数字串。
 *
 * @param rect 参考坐标空间的矩形
 */
export async function readDigits(
  raw: RawFrame,
  rect: Rect,
  set: GlyphSet,
  refW: number,
  refH: number,
  opts: ReadDigitsOptions = {}
): Promise<DigitReading> {
  if (set.glyphs.length === 0) {
    throw new AppError(
      'TEMPLATE_NOT_FOUND',
      `字形集「${set.name}」里一个字形都没有，无法识别数字。请先在模板管理里裁出 0-9 字形。`,
      { glyphSet: set.name }
    )
  }
  const crop = grayCropRef(raw, rect, refW, refH)
  if (!crop) {
    return { text: '', chars: [], minScore: 0, hasGap: false, roi: null }
  }

  const minScore = opts.minScore ?? GLYPH_MIN_SCORE
  const maxChars = opts.maxChars ?? 16

  // 每个字形单独取峰，先各自 NMS 一次（同字形的相邻高分点压成一个）。
  const tagged: { peak: Peak; glyph: Glyph }[] = []
  for (const g of set.glyphs) {
    const peaks = await matchAllInCrop(crop, g.tpl, { minScore, maxCount: maxChars })
    for (const p of peaks) tagged.push({ peak: p, glyph: g })
  }
  if (tagged.length === 0) {
    return { text: '', chars: [], minScore: 0, hasGap: false, roi: crop }
  }

  // 跨字形 NMS：同一个位置只能是一个字符。抑制半径按两者中**较窄**的字形算 ——
  // 逗号/冒号只有数字宽度的 0.4~0.6 倍，用较宽的那个当半径会把它整个吃掉。
  tagged.sort((a, b) => b.peak.score - a.peak.score)
  const kept: { peak: Peak; glyph: Glyph }[] = []
  for (const cand of tagged) {
    if (kept.length >= maxChars) break
    let suppressed = false
    for (const k of kept) {
      const radX = 0.55 * Math.min(cand.glyph.tpl.refW, k.glyph.tpl.refW)
      const radY = 0.6 * Math.min(cand.glyph.tpl.refH, k.glyph.tpl.refH)
      if (Math.abs(cand.peak.x - k.peak.x) < radX && Math.abs(cand.peak.y - k.peak.y) < radY) {
        suppressed = true
        break
      }
    }
    if (!suppressed) kept.push(cand)
  }

  kept.sort((a, b) => a.peak.x - b.peak.x)

  const chars: DigitChar[] = kept.map((k) => ({
    char: k.glyph.char,
    x: k.peak.x,
    y: k.peak.y,
    score: k.peak.score
  }))

  // 拼串：相邻两个峰的间距明显大于一个字宽 ⇒ 中间漏了字，插 '?' 让整串校验失败，
  // 而不是悄悄拼出一个短了一位的错值。
  const gapLimit = 1.6 * set.medianGlyphW
  let text = ''
  let hasGap = false
  for (let i = 0; i < chars.length; i++) {
    text += chars[i]!.char
    const next = chars[i + 1]
    if (next && next.x - chars[i]!.x > gapLimit) {
      text += '?'
      hasGap = true
    }
  }

  const minFound = chars.reduce((m, c) => Math.min(m, c.score), 1)
  return { text, chars, minScore: chars.length ? minFound : 0, hasGap, roi: crop }
}

// ── 各字段的整串校验与解析 ────────────────────────────────────────────────
// 一律「校验不过 = 识别失败」，绝不猜值。

/** `123` / `12` —— 等级。 */
export function parseLevel(text: string, hardCap: number): number | null {
  if (!/^\d{1,2}$/.test(text)) return null
  const v = Number(text)
  if (!Number.isFinite(v) || v < 1 || v > hardCap) return null
  return v
}

/** `1,260,000` —— 千分位分组的整数。 */
export function parseGrouped(text: string): number | null {
  if (!/^\d{1,3}(,\d{3})*$/.test(text)) return null
  const v = Number(text.replace(/,/g, ''))
  if (!Number.isFinite(v) || v < 0 || v > 100_000_000) return null
  return v
}

/** `00:01:04` -> 64 秒。 */
export function parseHms(text: string): number | null {
  const m = /^(\d{2}):(\d{2}):(\d{2})$/.exec(text)
  if (!m) return null
  const hh = Number(m[1])
  const mm = Number(m[2])
  const ss = Number(m[3])
  if (mm > 59 || ss > 59) return null
  const total = hh * 3600 + mm * 60 + ss
  if (total > 72 * 3600) return null
  return total
}

/** `4/5` 或 `105/105` -> [当前, 上限]。 */
export function parseRatio(text: string, max: number): [number, number] | null {
  const m = /^(\d{1,3})\/(\d{1,3})$/.exec(text)
  if (!m) return null
  const a = Number(m[1])
  const b = Number(m[2])
  if (a > b || b > max) return null
  return [a, b]
}

/** `36,995/253,125` -> [当前, 上限]（创建部队页的兵力）。 */
export function parseGroupedRatio(text: string): [number, number] | null {
  const m = /^(\d{1,3}(?:,\d{3})*)\/(\d{1,3}(?:,\d{3})*)$/.exec(text)
  if (!m) return null
  const a = parseGrouped(m[1]!)
  const b = parseGrouped(m[2]!)
  if (a === null || b === null) return null
  return [a, b]
}

/** `615,535` -> 规范化的坐标串（用于目标去重）。 */
export function parseCoord(text: string): string | null {
  const m = /^(\d{1,4}),(\d{1,4})$/.exec(text)
  if (!m) return null
  return `${Number(m[1])},${Number(m[2])}`
}
