/**
 * 多峰模板匹配（通用视觉扩展）。
 *
 * 为什么需要它：现有 `matchIn` 用 `cv.minMaxLoc` 只取**单个**最高峰，
 * 认不出 `00:01:04` 里的三个 `0`。数字识别必须能在一个 ROI 里拿到同一字形的全部出现位置。
 *
 * 实现：matchTemplate 得到 dst 后不走 minMaxLoc，直接遍历 dst 取所有 >= minScore 的点，
 * 按分数降序做非极大值抑制（NMS）。本场景 dst 最大约 210x50 = 10500 个 float，遍历成本可忽略。
 *
 * ★ 与 matchIn 一样，算法只能是 TM_CCOEFF_NORMED；★ 所有 Mat 走 withMats 释放。
 */

import { AppError } from '../errors.js'
import type { PreparedTemplate } from '../../contracts.js'
import { getCv, withMats } from '../../vision.js'
import type { GrayCrop } from './raster.js'

/** 一个峰值。x/y 是模板左上角在**参考坐标系**里的位置（已加上 crop 的偏移）。 */
export interface Peak {
  x: number
  y: number
  score: number
}

export interface MatchAllOptions {
  /** 低于此分数的峰直接丢弃。数字模板小、纹理少，实测 0.78 是合适的门槛。 */
  minScore?: number
  /** 最多返回几个峰（按分数降序）。 */
  maxCount?: number
  /** 水平抑制半径（参考像素）。默认 0.55 * 模板宽。 */
  nmsRadiusX?: number
  /** 垂直抑制半径（参考像素）。默认 0.6 * 模板高。 */
  nmsRadiusY?: number
}

const DEFAULT_MIN_SCORE = 0.78
const DEFAULT_MAX_COUNT = 32

/**
 * 在一个 shrink=1 的灰度块里找出某个模板的**全部**出现位置。
 *
 * @param crop 必须是 shrink=1（参考尺度）的灰度块，来自 grayCropRef
 * @param tpl  必须是按 shrink=1 编译的模板，否则尺度对不上
 */
export async function matchAllInCrop(
  crop: GrayCrop,
  tpl: PreparedTemplate,
  opts: MatchAllOptions = {}
): Promise<Peak[]> {
  if (tpl.shrink !== 1) {
    throw new AppError(
      'INVALID_ARGUMENT',
      `字形模板「${tpl.name}」必须按 shrink=1 编译（当前 shrink=${tpl.shrink}）。` +
        '数字只有 18~25 像素宽，降采样后 1/7、3/8 极易混淆。',
      { templateId: tpl.id, shrink: tpl.shrink }
    )
  }
  if (tpl.gray.length !== tpl.w * tpl.h) {
    throw new AppError(
      'INVALID_ARGUMENT',
      `字形模板「${tpl.name}」像素长度 ${tpl.gray.length} 与声明尺寸 ${tpl.w}x${tpl.h} 不符`,
      { templateId: tpl.id }
    )
  }
  // ROI 比模板还小时不是错误，是「这块地方装不下这个字形」，返回空即可。
  if (tpl.mask && tpl.mask.length !== tpl.w * tpl.h) {
    throw new AppError('INVALID_ARGUMENT', `字形模板「${tpl.name}」掩码尺寸不符`, {
      templateId: tpl.id
    })
  }
  if (tpl.mask && !tpl.mask.some((value) => value !== 0)) {
    throw new AppError('TEMPLATE_LOW_VARIANCE', `字形模板「${tpl.name}」掩码没有有效像素`)
  }
  if (crop.w < tpl.w || crop.h < tpl.h) return []

  const minScore = clamp01(opts.minScore ?? DEFAULT_MIN_SCORE)
  const maxCount = Math.max(1, opts.maxCount ?? DEFAULT_MAX_COUNT)
  const radX = opts.nmsRadiusX ?? Math.max(1, tpl.w * 0.55)
  const radY = opts.nmsRadiusY ?? Math.max(1, tpl.h * 0.6)

  const cv = await getCv()
  const raw: Peak[] = await withMats(async (keep) => {
    const src = keep(new cv.Mat(crop.h, crop.w, cv.CV_8UC1))
    ;(src.data as Uint8Array).set(crop.gray)
    const tplMat = keep(new cv.Mat(tpl.h, tpl.w, cv.CV_8UC1))
    ;(tplMat.data as Uint8Array).set(tpl.gray)
    const dst = keep(new cv.Mat())
    if (tpl.mask) {
      const maskMat = keep(new cv.Mat(tpl.h, tpl.w, cv.CV_8UC1))
      ;(maskMat.data as Uint8Array).set(tpl.mask)
      cv.matchTemplate(src, tplMat, dst, cv.TM_CCOEFF_NORMED, maskMat)
    } else {
      cv.matchTemplate(src, tplMat, dst, cv.TM_CCOEFF_NORMED)
    }

    const dw = dst.cols as number
    const dh = dst.rows as number
    const data = dst.data32F as Float32Array
    const found: Peak[] = []
    for (let y = 0; y < dh; y++) {
      const base = y * dw
      for (let x = 0; x < dw; x++) {
        const v = data[base + x]!
        // 纯色区域相关系数分母为 0，OpenCV 会给 NaN/Inf —— 那不是命中。
        if (!Number.isFinite(v) || v > 1.01 || v < minScore) continue
        found.push({
          x: crop.x + x,
          y: crop.y + y,
          score: Math.round(Math.min(1, v) * 10000) / 10000
        })
      }
    }
    return found
  })

  return nms(raw, radX, radY, maxCount)
}

/** 按分数降序贪心抑制。同一个字形的相邻像素会产生一大片高分点，必须压成一个峰。 */
export function nms(peaks: Peak[], radX: number, radY: number, maxCount: number): Peak[] {
  const sorted = peaks.slice().sort((a, b) => b.score - a.score)
  const kept: Peak[] = []
  for (const p of sorted) {
    if (kept.length >= maxCount) break
    let suppressed = false
    for (const k of kept) {
      if (Math.abs(p.x - k.x) < radX && Math.abs(p.y - k.y) < radY) {
        suppressed = true
        break
      }
    }
    if (!suppressed) kept.push(p)
  }
  return kept
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return DEFAULT_MIN_SCORE
  return Math.min(1, Math.max(0, v))
}
