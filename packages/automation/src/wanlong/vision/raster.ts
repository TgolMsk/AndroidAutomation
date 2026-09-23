/**
 * 裸帧上的像素级取样工具（游戏流程专用的通用视觉扩展）。
 *
 * 为什么不放进 src/vision/：
 *   本次并行改造里 src/vision/ 归别的模块所有，为避免越界改动，这里先落在 src/main/game/vision/。
 *   这三个函数本身是**通用能力**（不含任何游戏特化逻辑），将来可以整体上提到 src/vision/ 而无需改调用方。
 *
 * 两件 PreparedFrame 做不到、但本流程必须做的事：
 *   ① 读数字需要 **shrink=1** 的灰度块。matchIn 强制 `tpl.shrink === frame.shrink`
 *      （见 src/vision/matcher.ts），而全屏 shrink=1 预处理要 ~8ms；数字 ROI 最大也就
 *      230x52 ≈ 12k 像素，只裁 ROI 是微秒级，别为几个数字把整帧重做一遍。
 *   ② 勾选框/开关的判定必须用**彩色**（「自动采集至清空」勾选态是饱和亮黄 255,255,103，
 *      未勾选是深灰 83,83,83，灰度化后差异会被压扁）。PreparedFrame 只有灰度，只能回到 RawFrame。
 */

import { AppError } from '../errors.js'
import type { Point, RawFrame, Rect } from '../../contracts.js'

/** 参考分辨率尺度、shrink=1 的灰度小块。x/y 是它在参考坐标系里的左上角。 */
export interface GrayCrop {
  gray: Uint8Array
  w: number
  h: number
  x: number
  y: number
}

/** 灰度公式与 src/vision/preprocess.ts 保持一致（BT.601 整数近似），否则模板与帧的灰阶对不上。 */
function gray(r: number, g: number, b: number): number {
  return (r * 77 + g * 151 + b * 28) >> 8
}

function assertRgba(raw: RawFrame): void {
  const need = raw.width * raw.height * 4
  if (!Number.isFinite(raw.width) || !Number.isFinite(raw.height) || raw.width <= 0) {
    throw new AppError('CAPTURE_BAD_FRAME', `裸帧尺寸非法：${raw.width}x${raw.height}`)
  }
  if (raw.data.length < need) {
    throw new AppError(
      'CAPTURE_BAD_FRAME',
      `裸帧数据长度 ${raw.data.length} 少于 ${raw.width}x${raw.height}x4 = ${need}，无法取像素`,
      { width: raw.width, height: raw.height, byteLength: raw.data.length }
    )
  }
}

/** 把参考坐标的矩形夹进画面内，并取整。返回 null 表示完全落在画外。 */
export function clampRect(rect: Rect, refW: number, refH: number): Rect | null {
  const x0 = Math.max(0, Math.min(refW, Math.floor(rect.x)))
  const y0 = Math.max(0, Math.min(refH, Math.floor(rect.y)))
  const x1 = Math.max(0, Math.min(refW, Math.ceil(rect.x + rect.w)))
  const y1 = Math.max(0, Math.min(refH, Math.ceil(rect.y + rect.h)))
  const w = x1 - x0
  const h = y1 - y0
  if (w <= 0 || h <= 0) return null
  return { x: x0, y: y0, w, h }
}

/**
 * 从裸帧里裁一块 ROI，输出**参考分辨率尺度、shrink=1** 的灰度。
 *
 * 设备分辨率 == 参考分辨率（MuMu 默认实例就是 2560x1440）时是逐像素直拷；
 * 异分辨率时按最近邻取样（数字这种高频细节不适合插值，插值反而会糊掉笔画）。
 *
 * @param rect 参考坐标空间的矩形
 * @returns 落在画外时返回 null（调用方应按「ROI 越界」处理，不要当成识别失败）
 */
export function grayCropRef(raw: RawFrame, rect: Rect, refW: number, refH: number): GrayCrop | null {
  assertRgba(raw)
  const r = clampRect(rect, refW, refH)
  if (!r) return null

  const W = raw.width
  const H = raw.height
  const px = raw.data
  const out = new Uint8Array(r.w * r.h)

  // 预先算好每一列对应的设备像素 x，避免内层循环里重复做乘除。
  const srcX = new Int32Array(r.w)
  for (let i = 0; i < r.w; i++) {
    srcX[i] = Math.max(0, Math.min(W - 1, Math.round(((r.x + i) * W) / refW)))
  }

  let o = 0
  for (let j = 0; j < r.h; j++) {
    const sy = Math.max(0, Math.min(H - 1, Math.round(((r.y + j) * H) / refH)))
    const rowBase = sy * W * 4
    for (let i = 0; i < r.w; i++) {
      const k = rowBase + srcX[i]! * 4
      out[o++] = gray(px[k]!, px[k + 1]!, px[k + 2]!)
    }
  }
  return { gray: out, w: r.w, h: r.h, x: r.x, y: r.y }
}

/** RGB 取色结果。 */
export interface Rgb {
  r: number
  g: number
  b: number
}

/**
 * 在裸帧上取一个点的邻域 RGB 均值（勾选框 / 开关判定用）。
 *
 * @param at     参考坐标空间的点
 * @param radius 邻域半径，默认 3（即 7x7 —— 与 checkboxRule 标定时用的窗口一致）
 */
export function sampleRgb(
  raw: RawFrame,
  at: Point,
  refW: number,
  refH: number,
  radius = 3
): Rgb {
  assertRgba(raw)
  const W = raw.width
  const H = raw.height
  const cx = Math.max(0, Math.min(W - 1, Math.round((at.x * W) / refW)))
  const cy = Math.max(0, Math.min(H - 1, Math.round((at.y * H) / refH)))
  const rad = Math.max(0, Math.floor(radius))

  let sr = 0
  let sg = 0
  let sb = 0
  let n = 0
  for (let y = cy - rad; y <= cy + rad; y++) {
    if (y < 0 || y >= H) continue
    for (let x = cx - rad; x <= cx + rad; x++) {
      if (x < 0 || x >= W) continue
      const k = (y * W + x) * 4
      sr += raw.data[k]!
      sg += raw.data[k + 1]!
      sb += raw.data[k + 2]!
      n++
    }
  }
  if (n === 0) return { r: 0, g: 0, b: 0 }
  return { r: Math.round(sr / n), g: Math.round(sg / n), b: Math.round(sb / n) }
}
