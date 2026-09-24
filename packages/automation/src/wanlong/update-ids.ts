/**
 * 游戏资源更新处理器的**纯**常量：模板 id、校准阈值、搜索范围、相对几何、旧版裁剪位置、需要人处理的错误码。
 *
 * ★ 纯模块（只依赖 errors.ts），由 `@avdm/automation/wanlong/pure` 转出：模板页的「关键模板」清单、
 *   告警 / 统计里判断「需要人处理」都用它，不必拉进 sharp / opencv。处理逻辑见 update.ts。
 */

import { AppError } from './errors.js'
import type { Rect } from '../contracts.js'

/** 需要人处理的两种错误码（不是设备 / 周期失败，不累计掉线次数；处理后由用户恢复）。 */
export const GAME_UPDATE_REQUIRED = 'GAME_UPDATE_REQUIRED'
export const AI_RISK_BLOCKED = 'AI_RISK_BLOCKED'
export const NEEDS_ATTENTION_CODES: readonly string[] = [GAME_UPDATE_REQUIRED, AI_RISK_BLOCKED]

/** 这个错误是不是「需要人处理」（游戏更新未完成 / AI 风险拦截）。调用方据此跳过失败计数、改走专门告警。 */
export function isNeedsAttentionError(e: unknown): e is AppError {
  return e instanceof AppError && NEEDS_ATTENTION_CODES.includes(e.code)
}

/** 四张模板的 id（旧版面板同名）。 */
export const GAME_UPDATE_TPL = {
  message: 'game-update-message',
  confirm: 'game-update-confirm',
  downloading: 'game-update-downloading',
  checking: 'game-update-checking'
} as const

export type UpdateTemplateKey = keyof typeof GAME_UPDATE_TPL

/**
 * 原版校准阈值（MuMu 2560×1440 无损裁剪），同时是**下限**：模板集里的 threshold 只能比它更严，放宽一律不生效。
 * ★ 模板页 / TemplateLibrary.save 没填阈值时会写默认 0.85 —— 若让它生效，唯一会自动点「确定」的这道闸就比原版松了。
 *   在当前 AVD 分辨率上重裁的模板同分辨率匹配约 0.99，不需要放宽。
 */
export const GAME_UPDATE_DEFAULT_THRESHOLD: Readonly<Record<UpdateTemplateKey, number>> = {
  message: 0.94,
  confirm: 0.96,
  downloading: 0.94,
  checking: 0.94
}

/** 搜索范围（2560×1440 参考坐标）。 */
export const GAME_UPDATE_ROI: Readonly<Record<'message' | 'confirm' | 'progress', Rect>> = {
  message: { x: 700, y: 480, w: 1200, h: 250 },
  confirm: { x: 1150, y: 720, w: 750, h: 400 },
  progress: { x: 700, y: 1150, w: 1100, h: 140 }
}

/** 同一弹窗的相对几何：按钮中心 − 文案中心 ≈ (266, 308.5)，容差 ±20 参考像素。 */
export const GAME_UPDATE_GEOMETRY = { dx: 266, dy: 308.5, tolerance: 20 } as const

/**
 * 旧版面板那四张无损裁剪在 2560×1440 画面里的左上角（原版离线自检合成帧用的就是这组位置，
 * 文案与按钮的相对位置恰好等于 GAME_UPDATE_GEOMETRY）。
 */
export const GAME_UPDATE_LEGACY_ORIGIN: Readonly<Record<UpdateTemplateKey, { x: number; y: number }>> = {
  message: { x: 844, y: 570 },
  confirm: { x: 1320, y: 827 },
  downloading: { x: 1010, y: 1207 },
  checking: { x: 1010, y: 1207 }
}

/** 旧版面板 resources/game-update/ 里的文件名（导入向导按名认图）。 */
export const GAME_UPDATE_LEGACY_FILES: Readonly<Record<UpdateTemplateKey, string>> = {
  message: 'message.png',
  confirm: 'confirm.png',
  downloading: 'downloading.png',
  checking: 'checking.png'
}
