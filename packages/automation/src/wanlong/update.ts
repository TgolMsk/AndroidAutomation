/**
 * 游戏内「资源更新」弹窗的处理器：识别 → 单击确认（点前重新识别）→ 等下载完成（最长 15 分钟，可中止，绝不重复点）。
 *
 * ★ 只处理**已校准**的资源下载弹窗（「当前游戏版本需要更新，本次更新文件大小约为 …」+ 蓝色「确定」）。
 *   不开放任何通用「确定」点击：普通确认框、退出确认、购买弹窗都不可能只凭按钮命中就被点。
 *   判据是两张模板**同时**命中，且两者的相对位置与校准时一致（同一个弹窗），外加前台包名是游戏。
 *
 * ★ 模板来自用户自己的模板集（不进仓库、不进安装包），id 与旧版面板一致：
 *     game-update-message / game-update-confirm / game-update-downloading / game-update-checking
 *   缺哪张就静默停用哪部分判据（detect 返回 null / progress 返回 false），绝不抛。
 *   阈值以原版校准值为**下限**（确认按钮 0.96、其余 0.94）：模板集里写的 threshold 只有更严时才生效，
 *   放宽（包括模板库默认写的 0.85）一律按校准值算 —— 双模板 + 相对位置 + 校准阈值这道闸始终保留。
 *   低分辨率 AVD 的做法是在当前分辨率重裁（同分辨率约 0.99），而不是放宽阈值。
 *
 * ★ 运行位置：采集 worker / 采样 worker（重活不上主线程）。设备操作只用 UpdateContext.io 给的三个能力。
 *
 * 使用与规格说明：docs/wanlong/游戏资源更新.md。
 */

import { realpath } from 'node:fs/promises'
import sharp from 'sharp'
import { AppError } from './errors.js'
import type { PreparedFrame, PreparedTemplate, RawFrame, Rect, TemplateSet } from '../contracts.js'
import type { TemplateLibrary } from '../template-library.js'
import { loadTemplateSet, readTemplatePng } from '../templates.js'
import { matchIn, prepareFrame, prepareTemplate } from '../vision.js'
import { GAME_PACKAGE } from './gather/geometry.js'
import {
  AI_RISK_BLOCKED,
  GAME_UPDATE_DEFAULT_THRESHOLD,
  GAME_UPDATE_GEOMETRY,
  GAME_UPDATE_LEGACY_ORIGIN,
  GAME_UPDATE_REQUIRED,
  GAME_UPDATE_ROI,
  GAME_UPDATE_TPL,
  isNeedsAttentionError,
  type UpdateTemplateKey
} from './update-ids.js'
import type { GatherIo, UnknownScreenAdvisor, UnknownScreenContext } from './gather/session.js'

/** 校准时的参考分辨率（所有 ROI 与偏移都在这个空间里）。 */
const W = 2560
const H = 1440
/** 默认最长等待（15 分钟）。 */
export const GAME_UPDATE_MAX_WAIT_MS = 15 * 60_000
const POLL_MS = 3000
/** 更新提示在点完确认之后仍持续这么久 ⇒ 确认没生效，交给人处理（绝不再点）。 */
const PROMPT_STUCK_MS = 20_000
/** 等待期间 AI 处理公告 / 进度日志的最小间隔。 */
const OVERLAY_INTERVAL_MS = 30_000
const LOG_INTERVAL_MS = 30_000

export interface UpdateContext {
  /** 触发这次处理的那一帧（认不出的画面）。 */
  raw: RawFrame
  /** io.tap 使用的参考坐标空间（GatherIo 的 refWidth/refHeight）。 */
  refWidth: number
  refHeight: number
  io: {
    capture(): Promise<RawFrame>
    foregroundPackage(): Promise<string | null>
    tap(x: number, y: number): Promise<void>
  }
  /** 中止检查（抛出中止错误）。每一步前后都会调。 */
  check?: () => void
  /** 用本地模板判断是否已回到已知界面（世界地图 / 城内 / 面板…）。 */
  recognize(raw: RawFrame): Promise<boolean>
  /** 更新后出现未知公告时，交给 AI 评估操作风险并处理（可选；ai 模块接线，★不得确认更新）。 */
  recoverOverlay?: (raw: RawFrame) => Promise<boolean>
  log(message: string): void
}

export interface GameUpdateRecoveryOptions {
  /** 当前模板集目录；返回空 = 没配模板集，处理器静默停用。 */
  templateDir: () => string | null | undefined
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** 最长等待（测试可调小）。 */
  maxWaitMs?: number
  /** 模板集里缺了哪些更新模板（每次重新加载时最多报一次，不刷屏）。 */
  onTemplatesMissing?: (missing: string[]) => void
}

type UpdateTemplates = Partial<Record<UpdateTemplateKey, PreparedTemplate>>

/** 仅处理已校准的资源下载弹窗；不开放通用“确定”点击。 */
export class GameUpdateRecovery {
  private cache?: { key: string; templates: Promise<UpdateTemplates> }
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly maxWaitMs: number

  constructor(private readonly opts: GameUpdateRecoveryOptions) {
    this.now = opts.now ?? Date.now
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.maxWaitMs = Math.max(0, opts.maxWaitMs ?? GAME_UPDATE_MAX_WAIT_MS)
  }

  /** 模板集变了（导入 / 重裁 / 换集）时调一次。 */
  invalidate(): void {
    this.cache = undefined
  }

  /** 识别所需的两张模板（文案 + 确认按钮）是否齐全。 */
  async available(): Promise<boolean> {
    const t = await this.load()
    return Boolean(t.message && t.confirm)
  }

  /** 诊断用（模板页 / 日志）：哪几张缺、实际生效的阈值是多少。 */
  async status(): Promise<{ available: boolean; missing: string[]; thresholds: Partial<Record<UpdateTemplateKey, number>> }> {
    const t = await this.load()
    const keys = Object.keys(GAME_UPDATE_TPL) as UpdateTemplateKey[]
    const thresholds: Partial<Record<UpdateTemplateKey, number>> = {}
    for (const k of keys) if (t[k]) thresholds[k] = t[k]!.threshold
    return {
      available: Boolean(t.message && t.confirm),
      missing: keys.filter((k) => !t[k]).map((k) => GAME_UPDATE_TPL[k]),
      thresholds
    }
  }

  private async load(): Promise<UpdateTemplates> {
    const dir = this.opts.templateDir()
    if (!dir) return {}
    let key: string
    let set: TemplateSet
    try {
      const root = await realpath(dir)
      set = await loadTemplateSet(root)
      const defs = (Object.keys(GAME_UPDATE_TPL) as UpdateTemplateKey[]).map(
        (k) => set.templates.find((t) => t.id === GAME_UPDATE_TPL[k]) ?? null
      )
      // 文件名每次保存都会变：定义一变缓存自动失效。
      key = JSON.stringify([root, set.id, defs])
    } catch {
      this.cache = undefined
      return {}
    }
    if (this.cache?.key === key) return this.cache.templates
    const templates = this.compile(set)
    this.cache = { key, templates }
    templates.catch(() => {
      if (this.cache?.key === key) this.cache = undefined
    })
    return templates.catch(() => ({}))
  }

  private async compile(set: TemplateSet): Promise<UpdateTemplates> {
    // ROI 与相对几何都在 2560×1440 空间：模板统一按这个参考画布编译，与模板集自己的参考尺寸无关。
    const ref: TemplateSet = { ...set, refWidth: W, refHeight: H }
    const out: UpdateTemplates = {}
    const missing: string[] = []
    for (const k of Object.keys(GAME_UPDATE_TPL) as UpdateTemplateKey[]) {
      const id = GAME_UPDATE_TPL[k]
      const def = set.templates.find((t) => t.id === id)
      if (!def) {
        missing.push(id)
        continue
      }
      try {
        // 校准值是下限：模板集只能收紧，不能放宽（模板库没填阈值时默认写 0.85，不能让它生效）。
        const threshold = Math.max(GAME_UPDATE_DEFAULT_THRESHOLD[k], def.threshold ?? 0)
        out[k] = await prepareTemplate(await readTemplatePng(set, id), { ...def, threshold }, ref, 2)
      } catch {
        missing.push(id)
      }
    }
    if (missing.length) this.opts.onTemplatesMissing?.(missing)
    return out
  }

  private async frame(raw: RawFrame): Promise<PreparedFrame | null> {
    if (Math.abs(raw.width / raw.height - W / H) > 0.03) return null
    return prepareFrame(raw, { refW: W, refH: H, shrink: 2 })
  }

  /**
   * 识别「需要更新」弹窗。两张模板同时命中且相对位置一致才算；返回确认按钮中心（2560×1440 参考坐标）。
   * 模板缺失 / 非 16:9 画面 → null。
   */
  async detect(raw: RawFrame): Promise<{ x: number; y: number } | null> {
    if (Math.abs(raw.width / raw.height - W / H) > 0.03) return null
    const { message, confirm } = await this.load()
    if (!message || !confirm) return null
    const frame = await this.frame(raw)
    if (!frame) return null
    const text = await matchIn(frame, message, { roi: GAME_UPDATE_ROI.message })
    if (!text.found) return null
    const button = await matchIn(frame, confirm, { roi: GAME_UPDATE_ROI.confirm })
    if (!button.found) return null
    // 两个控件必须属于同一个、相对位置一致的弹窗。
    if (
      Math.abs(button.centerX - text.centerX - GAME_UPDATE_GEOMETRY.dx) > GAME_UPDATE_GEOMETRY.tolerance ||
      Math.abs(button.centerY - text.centerY - GAME_UPDATE_GEOMETRY.dy) > GAME_UPDATE_GEOMETRY.tolerance
    )
      return null
    return { x: button.centerX, y: button.centerY }
  }

  /** 下载数字和百分比不断变化，只匹配稳定的进度文案。 */
  async progress(raw: RawFrame, includeChecking: boolean): Promise<boolean> {
    if (Math.abs(raw.width / raw.height - W / H) > 0.03) return false
    const { downloading, checking } = await this.load()
    if (!downloading && !(includeChecking && checking)) return false
    const frame = await this.frame(raw)
    if (!frame) return false
    const roi = GAME_UPDATE_ROI.progress
    if (downloading && (await matchIn(frame, downloading, { roi })).found) return true
    return Boolean(includeChecking && checking && (await matchIn(frame, checking, { roi })).found)
  }

  /**
   * 认不出界面时先问它。不是更新画面返回 false（调用方按原阶梯继续）；
   * 是更新画面就点一次确认（或接续已在进行的下载）并等到回到已知界面，返回 true。
   * @throws AppError(GAME_UPDATE_REQUIRED) 前台变了 / 确认没生效 / 等超时 —— 需要人处理
   */
  async handle(ctx: UpdateContext): Promise<boolean> {
    ctx.check?.()
    if (!(await this.detect(ctx.raw)) && !(await this.progress(ctx.raw, false))) return false
    const assertForeground = async (): Promise<void> => {
      ctx.check?.()
      if ((await ctx.io.foregroundPackage()) !== GAME_PACKAGE) {
        throw new AppError(
          GAME_UPDATE_REQUIRED,
          '游戏更新期间前台应用发生变化，已停止操作，请回到游戏后恢复。'
        )
      }
      ctx.check?.()
    }
    await assertForeground()
    // 截图和点击之间可能被人工切屏：点击前必须重新识别，不能沿用旧坐标。
    const fresh = await ctx.io.capture()
    const target = await this.detect(fresh)
    ctx.check?.()
    if (!target && !(await this.progress(fresh, true))) return true
    await assertForeground()
    if (target) {
      ctx.log('识别到游戏资源更新，确认下载；等待更新完成，期间不执行采集或返回键。')
      await ctx.io.tap((target.x * ctx.refWidth) / W, (target.y * ctx.refHeight) / H)
    } else {
      ctx.log('游戏资源正在下载，接续等待更新完成，不重复点击。')
    }

    return this.wait(ctx)
  }

  /** AI 已确认其它布局的低风险更新后，复用下载等待，不再次点击。 */
  async wait(ctx: UpdateContext): Promise<boolean> {
    const assertForeground = async (): Promise<void> => {
      ctx.check?.()
      if ((await ctx.io.foregroundPackage()) !== GAME_PACKAGE) {
        throw new AppError(GAME_UPDATE_REQUIRED, '更新期间前台发生变化，请回到游戏后恢复。')
      }
      ctx.check?.()
    }
    const started = this.now()
    let nextOverlayAt = started + OVERLAY_INTERVAL_MS
    let nextLogAt = started + LOG_INTERVAL_MS
    while (this.now() - started < this.maxWaitMs) {
      // 小步等待使关闭自动/停止任务立即生效；已经开始的游戏下载由游戏继续。
      const until = Math.min(this.now() + POLL_MS, started + this.maxWaitMs)
      while (this.now() < until) {
        ctx.check?.()
        await this.sleep(Math.min(100, until - this.now()))
      }
      await assertForeground()
      const raw = await ctx.io.capture()
      ctx.check?.()
      if (await ctx.recognize(raw)) {
        ctx.log('游戏更新已结束，已识别到游戏界面，继续原任务。')
        return true
      }
      if (await this.detect(raw)) {
        if (this.now() - started >= PROMPT_STUCK_MS) {
          throw new AppError(
            GAME_UPDATE_REQUIRED,
            '已点击更新确认，但更新提示持续未消失。请检查游戏下载或网络状态后恢复；不会重复点击。'
          )
        }
        continue
      }
      if (this.now() >= nextOverlayAt && ctx.recoverOverlay && !(await this.progress(raw, true))) {
        nextOverlayAt = this.now() + OVERLAY_INTERVAL_MS
        if (await ctx.recoverOverlay(raw)) {
          ctx.check?.()
          // 公告被关闭仍需重新检查，不能把一次点击等同于更新完成。
          if (await ctx.recognize(await ctx.io.capture())) {
            ctx.log('更新后的公告已处理，已回到游戏界面，继续原任务。')
            return true
          }
        }
      }
      if (this.now() >= nextLogAt) {
        nextLogAt = this.now() + LOG_INTERVAL_MS
        ctx.log(`等待游戏更新/加载完成（已等待 ${Math.round((this.now() - started) / 1000)} 秒）。`)
      }
    }
    throw new AppError(
      GAME_UPDATE_REQUIRED,
      `等待游戏更新/加载超过 ${Math.round(this.maxWaitMs / 60_000)} 分钟，尚未进入已知界面。请检查下载进度或处理当前提示后恢复。`
    )
  }
}

// ══════════════════════════════════════════════════════════════════════════
// 认不出界面时的统一路由：先问更新处理器，再问 AI（可选），需要人处理的错误走专门告警
// ══════════════════════════════════════════════════════════════════════════

/** 认不出界面之后的结果：false = 什么都没做；recovered = 画面被处理过、请重新判断；updated = 走完了更新流程。 */
export type UnknownScreenRecovery = false | 'recovered' | 'updated'

/**
 * AI 顾问问询结果里本模块关心的字段（ai 模块把自己的结果映射成这个形状）。
 * ★ 本模块不认识 AI 的实现：它只决定「要不要转入下载等待」「要不要当成需要人处理」。
 */
export interface OverlayConsultResult {
  /** 顾问是否真的动了手（点了关闭 / 取消）。 */
  handled: boolean
  /** 动手后的复验结论（'applied' 画面变了 / 'verified' 回到已知界面 / 其它）。 */
  outcome?: string | null
  /** 顾问建议的动作（'none' / 'back' / 'tap_close' …）。 */
  action?: string | null
  /** 风险评估里的「点下去的后果」；'download_update' 表示这是一个低风险的资源更新确认。 */
  riskEffect?: string | null
  /** 风险过高、需要人处理（→ AI_RISK_BLOCKED）。 */
  requiresAttention?: boolean
  message?: string
}

/**
 * AI 问询端口。
 * @param waiting true = 更新等待期间处理公告：实现方**必须**禁止确认更新（allowUpdateConfirm=false），AI 永远不能二次确认。
 * @returns 没启用 AI 时返回 null
 */
export type OverlayConsult = (raw: RawFrame, waiting: boolean) => Promise<OverlayConsultResult | null>

export interface RecoverUnknownWithUpdateOptions {
  updater: GameUpdateRecovery
  /** 认不出的那一帧。 */
  raw: RawFrame
  refWidth: number
  refHeight: number
  io: { capture(): Promise<RawFrame>; tap(x: number, y: number): Promise<void> }
  foregroundPackage: () => Promise<string | null>
  /** 中止检查（抛出中止错误）。 */
  check: () => void
  /** 已知界面判据；不给则永远认为「还没回到已知界面」。 */
  recognize?: (raw: RawFrame) => Promise<boolean>
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void
  consult?: OverlayConsult
  /**
   * 需要人处理时的告警钩子（暂停 + 推送由调用方实现：先暂停、再推送）。
   * 钩子自己抛错会被吞掉（记 warn），**绝不影响**原错误继续上抛。
   */
  onNeedsAttention?: (error: AppError) => void | Promise<void>
}

/**
 * 两条自动化链路（采集 G0 兜底 / 调度器采样）与脚本执行共用的「认不出界面」处理：
 *   ① 先交给更新处理器（AI 关着也跑）：是更新弹窗 / 正在下载 ⇒ 'updated'
 *   ② 再问 AI（若接了）：AI 判定是低风险更新确认（download_update）且已点或建议不动 ⇒ 复用下载等待，'updated'
 *   ③ AI 动过手 ⇒ 'recovered'；什么都没做 ⇒ false（调用方按自己的 BACK 阶梯继续）
 * GAME_UPDATE_REQUIRED / AI_RISK_BLOCKED：先调 onNeedsAttention，再原样上抛（调用方不得再按 BACK）。
 */
export async function recoverUnknownWithUpdate(opts: RecoverUnknownWithUpdateOptions): Promise<UnknownScreenRecovery> {
  const { check } = opts
  const consult = async (raw: RawFrame, waiting = false): Promise<OverlayConsultResult | null> => {
    check()
    if (!opts.consult) return null
    const r = await opts.consult(raw, waiting)
    check()
    if (r?.requiresAttention) {
      throw new AppError(AI_RISK_BLOCKED, r.message || 'AI 风险评估认为这一步需要人工处理，已停止自动操作。')
    }
    return r
  }
  const updateContext: UpdateContext = {
    raw: opts.raw,
    refWidth: opts.refWidth,
    refHeight: opts.refHeight,
    io: {
      capture: () => opts.io.capture(),
      tap: (x, y) => opts.io.tap(x, y),
      foregroundPackage: opts.foregroundPackage
    },
    check,
    recognize: opts.recognize ?? (async () => false),
    recoverOverlay: opts.consult ? async (raw) => (await consult(raw, true))?.handled ?? false : undefined,
    log: (message) => opts.log('info', `[游戏更新] ${message}`)
  }
  try {
    if (await opts.updater.handle(updateContext)) return 'updated'
    const r = await consult(opts.raw)
    if (
      r?.riskEffect === 'download_update' &&
      ((r.handled && (r.outcome === 'applied' || r.outcome === 'verified')) || r.action === 'none')
    ) {
      await opts.updater.wait(updateContext)
      return 'updated'
    }
    return r?.handled ? 'recovered' : false
  } catch (e) {
    check()
    if (isNeedsAttentionError(e) && opts.onNeedsAttention) {
      try {
        await opts.onNeedsAttention(e)
      } catch (hookError) {
        opts.log('warn', `需要人工处理的告警没能发出：${hookError instanceof Error ? hookError.message : String(hookError)}`)
      }
    }
    throw e
  }
}

export interface UpdateAwareAdvisorOptions {
  updater: GameUpdateRecovery
  /** AI 问询（可选）；拿到 G0 的上下文（模板集 id、已有关闭模板、第几次尝试…）自行组装请求。 */
  consult?: (ctx: UnknownScreenContext, raw: RawFrame, waiting: boolean) => Promise<OverlayConsultResult | null>
  onNeedsAttention?: (error: AppError, ctx: UnknownScreenContext) => void | Promise<void>
}

/**
 * 给采集流程 G0 兜底阶梯用的顾问（注入 runGatherCycle 的 advisor）：
 * 盲按 BACK 之前先走 recoverUnknownWithUpdate。返回 true = 画面被处理过（含更新完成），让 G0 重新判断。
 * ★ 更新处理只需要视觉 + 设备端口，AI 没开也照样生效。
 */
export function createUpdateAwareAdvisor(opts: UpdateAwareAdvisorOptions): UnknownScreenAdvisor {
  return {
    handleUnknownScreen: async (ctx) => {
      const io: GatherIo = ctx.io
      const r = await recoverUnknownWithUpdate({
        updater: opts.updater,
        raw: ctx.raw,
        refWidth: ctx.refWidth,
        refHeight: ctx.refHeight,
        io: { capture: () => io.capture(), tap: (x, y) => io.tap(x, y) },
        foregroundPackage: () => io.foregroundPackage(),
        check: () => ctx.checkAlive?.(),
        recognize: ctx.recognize,
        log: (level, message) => ctx.log(level, message),
        consult: opts.consult ? (raw, waiting) => opts.consult!(ctx, raw, waiting) : undefined,
        onNeedsAttention: opts.onNeedsAttention ? (e) => opts.onNeedsAttention!(e, ctx) : undefined
      })
      return r !== false
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════
// 导入旧版面板的四张更新模板（只进用户自己的模板集）
// ══════════════════════════════════════════════════════════════════════════

const GAME_UPDATE_NAME: Readonly<Record<UpdateTemplateKey, string>> = {
  message: '游戏资源更新-提示文案',
  confirm: '游戏资源更新-确定按钮',
  downloading: '游戏资源更新-下载中文案',
  checking: '游戏资源更新-校验中文案'
}

export interface ImportGameUpdateTemplatesOptions {
  library: Pick<TemplateLibrary, 'save'>
  /** 目标模板集目录（用户选定）。 */
  templateDir: string
  /** 旧版的四张裁剪 PNG（2560×1440 画面上的原尺寸）；缺哪张跳过哪张。 */
  crops: Partial<Record<UpdateTemplateKey, Uint8Array>>
}

/**
 * 把旧版面板的更新模板（小块裁剪图）导入用户模板集：按原位置贴回一张 2560×1440 的画布，
 * 再走 TemplateLibrary.save（原子写、std 守卫），阈值与搜索范围沿用原版校准值。
 * @returns 已导入与失败（附中文原因）的 id
 */
export async function importGameUpdateTemplates(
  opts: ImportGameUpdateTemplatesOptions
): Promise<{ saved: string[]; failed: Array<{ id: string; reason: string }> }> {
  const set = await loadTemplateSet(opts.templateDir)
  const saved: string[] = []
  const failed: Array<{ id: string; reason: string }> = []
  const roiOf: Record<UpdateTemplateKey, Rect> = {
    message: GAME_UPDATE_ROI.message,
    confirm: GAME_UPDATE_ROI.confirm,
    downloading: GAME_UPDATE_ROI.progress,
    checking: GAME_UPDATE_ROI.progress
  }
  for (const k of Object.keys(GAME_UPDATE_TPL) as UpdateTemplateKey[]) {
    const png = opts.crops[k]
    if (!png) continue
    const id = GAME_UPDATE_TPL[k]
    try {
      const input = Buffer.from(png.buffer, png.byteOffset, png.byteLength)
      const meta = await sharp(input).metadata()
      const w = meta.width ?? 0
      const h = meta.height ?? 0
      const at = GAME_UPDATE_LEGACY_ORIGIN[k]
      if (!w || !h || at.x + w > W || at.y + h > H) {
        throw new Error(`图片尺寸 ${w}×${h} 与旧版模板不符，请确认选的是旧版面板 resources/game-update 目录`)
      }
      const canvas = await sharp({ create: { width: W, height: H, channels: 3, background: '#808080' } })
        .composite([{ input, left: at.x, top: at.y }])
        .png()
        .toBuffer()
      const roi = roiOf[k]
      await opts.library.save(set.directory, {
        id,
        name: GAME_UPDATE_NAME[k],
        image: canvas,
        authoredWidth: W,
        authoredHeight: H,
        crop: { x: at.x, y: at.y, w, h },
        defaultRoi: {
          x: Math.round((roi.x * set.refWidth) / W),
          y: Math.round((roi.y * set.refHeight) / H),
          w: Math.round((roi.w * set.refWidth) / W),
          h: Math.round((roi.h * set.refHeight) / H)
        },
        threshold: GAME_UPDATE_DEFAULT_THRESHOLD[k],
        tags: ['game_update'],
        note: '游戏资源更新弹窗（从旧版面板导入）。只在文案与按钮同时命中、相对位置一致时才会确认下载。'
      })
      saved.push(id)
    } catch (e) {
      failed.push({ id, reason: e instanceof Error ? e.message : String(e) })
    }
  }
  return { saved, failed }
}
