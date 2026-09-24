/**
 * 采集流程的执行上下文：一帧的生命周期、模板匹配、点击/滑动重试、数字读取、熔断与中止。
 *
 * 设计要点：
 *   · **端口化**：所有设备操作走 GatherIo 接口，实现放在 adbIo.ts。
 *     这样整套流程既能在主进程里跑，也能塞进 utilityProcess，甚至能用假 IO 做离线回放。
 *   · **一帧多用**：截图是全链路最贵的一步（游戏在前台实测约 750ms/帧），
 *     所以一帧要同时喂给「模板匹配（shrink=2 的 PreparedFrame）」和「数字识别（裸帧上的 ROI 灰度块）」，
 *     裸帧必须留到本步结束 —— 拿到 PreparedFrame 就把 RawFrame 丢掉的话，勾选框取色和读数字都做不了。
 *   · **熔断**：单轮截图数超过 safety.maxCapturesPerCycle 直接停，避免识别出错时无限刷帧。
 */

import { DEFAULT_SHRINK, REF_HEIGHT, REF_WIDTH } from '../constants.js'
import { AppError } from '../errors.js'
import type { AndroidKey, LogLevel } from '../script-types.js'
import type {
  MatchResult,
  Point,
  PreparedFrame,
  PreparedTemplate,
  RawFrame,
  Rect
} from '../../contracts.js'
import { matchIn, prepareFrame } from '../../vision.js'
import {
  GLYPH_LOW_CONFIDENCE,
  GLYPH_MIN_SCORE,
  readDigits,
  type DigitReading
} from '../vision/digits.js'
import { sampleRgb, type Rgb } from '../vision/raster.js'
import type { GamePresence } from '../launch.js'
import type { GatherConfig } from '../config.js'
import type { GatherTemplates } from './templates.js'
import type { GatherOutcome } from './types.js'

/** 设备操作端口。坐标一律是**参考分辨率**空间，换算到设备像素是实现方的事。 */
export interface GatherIo {
  capture(): Promise<RawFrame>
  tap(x: number, y: number): Promise<void>
  tapMany(points: [number, number][], gapMs?: number): Promise<void>
  swipe(x1: number, y1: number, x2: number, y2: number, durationMs: number): Promise<void>
  key(k: AndroidKey): Promise<void>
  launchApp(packageName: string, cold?: boolean): Promise<void>
  foregroundPackage(): Promise<string | null>
  /**
   * 冷启动恢复：确认游戏在前台，不在就拉起来并等到它到前台
   * （实现见 `packages/automation/src/wanlong/launch.ts` 的 ensureGameForeground；`io.ts` 的 createGatherIo 已接好）。
   * ★ 《万龙觉醒》只能用 monkey 拉起（`am start -n` 会返回成功但进程根本起不来）：
   *   目标里 `launchApp` 落到 `@avdm/core` 的 `AdbDevice.startApp(pkg)` **不带 activity** = monkey，与 DevicePort.launchApp 的约定一致。
   *   模拟器刚开机 / 游戏被系统杀掉时仍优先走本方法 —— 它会等前台、带诊断措辞与中止检查，`launchApp` 只管发命令。
   *   可选是为了让离线自检里的假 io 不必实现。
   */
  ensureGameForeground?(packageName: string): Promise<GamePresence>
}

export type GatherLogger = (
  level: LogLevel,
  message: string,
  data?: Record<string, unknown>
) => void

/**
 * 「认不出界面」时的外部顾问（主进程接的是 AI 视觉大模型，见 src/main/ai/recover.ts）。
 * gather 模块不认识它的实现，只在 ensureWorldMap 的兜底阶梯里、盲按 BACK 之前调一次。
 * 返回 true = 顾问改变了画面（点掉了弹窗），调用方应重新截图再判；false = 什么都没做，按原阶梯继续。
 * ★ 实现方只允许执行「点关闭 / 点取消」这类动作并自行复验；BACK 等安全敏感动作必须交回调用方。
 */
export interface UnknownScreenAdvisor {
  handleUnknownScreen(ctx: UnknownScreenContext): Promise<boolean>
}

export interface UnknownScreenContext {
  checkAlive?: () => void
  instanceIndex: number | null
  /** 认不出的那一帧。 */
  raw: RawFrame
  /** 兜底阶梯的第几次尝试。 */
  attempt: number
  io: GatherIo
  /** 当前模板集 id（顾问自学模板时往这里存）。 */
  setId: string
  refWidth: number
  refHeight: number
  /** 用本地模板判断一帧是不是已知界面（世界地图 / 城内 / 面板…）。 */
  recognize: (raw: RawFrame) => Promise<boolean>
  /** 模板集里已有的弹窗关闭模板（顾问去重用，避免同一个 × 被裁多次）。 */
  existingCloseTemplates: PreparedTemplate[]
  log: GatherLogger
}

/**
 * 需要立刻结束本轮、且**不是**代码 bug 的情况（中止、熔断）。
 * 流程层捕获它并翻译成对应的 GatherOutcome，不当异常往外抛。
 */
export class GatherHalt extends AppError {
  readonly outcome: GatherOutcome

  constructor(outcome: GatherOutcome, message: string, detail?: Record<string, unknown>) {
    super(outcome === 'cancelled' ? 'CANCELLED' : 'TIMEOUT', message, detail)
    this.name = 'GatherHalt'
    this.outcome = outcome
  }
}

export interface GatherSessionOptions {
  io: GatherIo
  templates: GatherTemplates
  config: GatherConfig
  log?: GatherLogger
  /** 留痕钩子。给的是裸帧，编码与落盘由调用方决定（本模块不碰 shots 目录）。 */
  onShot?: (label: string, raw: RawFrame) => void | Promise<void>
  signal?: AbortSignal
  refWidth?: number
  refHeight?: number
  shrink?: number
  now?: () => number
  /** 认不出界面时的外部顾问（可选）。 */
  advisor?: UnknownScreenAdvisor
  /** 本会话跑在哪个实例上（只用于顾问的记录与限频）。 */
  instanceIndex?: number | null
}

export interface Frame {
  raw: RawFrame
  prepared: PreparedFrame
}

/** waitFor 的结果：命中的模板 id + 匹配结果。 */
export interface Hit {
  id: string
  match: MatchResult
}

export class GatherSession {
  readonly io: GatherIo
  readonly templates: GatherTemplates
  readonly config: GatherConfig
  readonly refWidth: number
  readonly refHeight: number
  readonly shrink: number
  readonly warnings: string[] = []
  readonly advisor?: UnknownScreenAdvisor
  readonly instanceIndex: number | null

  private readonly logFn: GatherLogger
  private readonly onShot?: (label: string, raw: RawFrame) => void | Promise<void>
  private readonly signal?: AbortSignal
  private readonly nowFn: () => number
  private current: Frame | null = null
  private inFlight: Promise<Frame> | null = null
  private captureCount = 0

  constructor(opts: GatherSessionOptions) {
    const guard = async <T>(fn: () => Promise<T>): Promise<T> => {
      this.ensureAlive()
      return fn()
    }
    const io = opts.io
    this.io = {
      capture: () => guard(() => io.capture()),
      tap: (x, y) => guard(() => io.tap(x, y)),
      tapMany: (points, gap) => guard(() => io.tapMany(points, gap)),
      swipe: (x1, y1, x2, y2, ms) => guard(() => io.swipe(x1, y1, x2, y2, ms)),
      key: (k) => guard(() => io.key(k)),
      launchApp: (pkg, cold) => guard(() => io.launchApp(pkg, cold)),
      foregroundPackage: () => guard(() => io.foregroundPackage()),
      ensureGameForeground: io.ensureGameForeground
        ? (pkg) => guard(() => io.ensureGameForeground!(pkg))
        : undefined
    }
    this.templates = opts.templates
    this.config = opts.config
    this.refWidth = opts.refWidth ?? opts.templates.refWidth ?? REF_WIDTH
    this.refHeight = opts.refHeight ?? opts.templates.refHeight ?? REF_HEIGHT
    this.shrink = opts.shrink ?? DEFAULT_SHRINK
    this.logFn = opts.log ?? ((): void => undefined)
    this.onShot = opts.onShot
    this.signal = opts.signal
    this.nowFn = opts.now ?? ((): number => Date.now())
    this.advisor = opts.advisor
    this.instanceIndex = opts.instanceIndex ?? null
  }

  // ── 基础设施 ────────────────────────────────────────────────────────────

  now(): number {
    return this.nowFn()
  }

  get captures(): number {
    return this.captureCount
  }

  log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    this.logFn(level, message, data)
  }

  /** 记一条告警，同时收进 warnings 供面板汇总。 */
  warn(message: string, data?: Record<string, unknown>): void {
    this.warnings.push(message)
    this.logFn('warn', message, data)
  }

  ensureAlive(): void {
    if (this.signal?.aborted) {
      throw new GatherHalt('cancelled', '自动采集已被中止。')
    }
  }

  async sleep(ms: number): Promise<void> {
    const end = this.now() + Math.max(0, ms)
    // 100ms 粒度轮询，中止时立刻返回（长 sleep 不应该拖着停止操作等下去）。
    while (this.now() < end) {
      this.ensureAlive()
      await new Promise<void>((r) => setTimeout(r, Math.min(100, end - this.now())))
    }
    this.ensureAlive()
  }

  /** 留痕一张当前帧。没有 onShot 钩子时什么都不做。 */
  async shot(label: string): Promise<void> {
    if (!this.onShot) return
    const f = this.current
    if (!f) return
    try {
      await this.onShot(label, f.raw)
    } catch (e) {
      this.logFn('warn', `留痕「${label}」失败：${errMsg(e)}`)
    }
  }

  // ── 取帧 ────────────────────────────────────────────────────────────────

  /** 丢弃当前帧，下次 frame() 会重新截。点击/滑动之后必须调。 */
  invalidate(): void {
    this.current = null
  }

  /**
   * 取当前帧。默认复用上一次的（同一步里多个 ROI 应该共用一帧）；
   * 传 force=true 或调过 invalidate() 才会真的去截图。
   */
  async frame(force = false): Promise<Frame> {
    this.ensureAlive()
    if (!force && this.current) return this.current
    if (this.inFlight) return this.inFlight

    this.inFlight = (async (): Promise<Frame> => {
      const budget = this.config.safety.maxCapturesPerCycle
      if (this.captureCount >= budget) {
        throw new GatherHalt(
          'circuitBroken',
          `本轮截图数已达上限 ${budget} 张仍未走完流程，判定为卡住并中止。` +
            '（游戏在前台时单张截图约 750ms，正常一次派兵只要 9~12 张。' +
            '若确实需要更多，请调大 safety.maxCapturesPerCycle。）',
          { captures: this.captureCount, budget }
        )
      }
      this.captureCount++
      const raw = await this.io.capture()
      const prepared = await prepareFrame(raw, {
        refW: this.refWidth,
        refH: this.refHeight,
        shrink: this.shrink
      })
      const f: Frame = { raw, prepared }
      this.current = f
      return f
    })()

    try {
      return await this.inFlight
    } finally {
      this.inFlight = null
    }
  }

  // ── 模板匹配 ────────────────────────────────────────────────────────────

  /** 匹配一个必需模板。模板缺失会抛中文错误。 */
  async match(id: string, roi?: Rect, threshold?: number): Promise<MatchResult> {
    const tpl = this.templates.require(id)
    const f = await this.frame()
    return matchIn(f.prepared, tpl, { roi, threshold })
  }

  /** 匹配一个可选模板。模板不存在时返回 null（调用方按「判据不可用」降级）。 */
  async matchOptional(id: string, roi?: Rect, threshold?: number): Promise<MatchResult | null> {
    const tpl = this.templates.get(id)
    if (!tpl) return null
    const f = await this.frame()
    return matchIn(f.prepared, tpl, { roi, threshold })
  }

  /** 在同一帧里比若干模板，返回分数最高的命中。都没命中返回 null。 */
  async bestOf(ids: string[], roi?: Rect, threshold?: number): Promise<Hit | null> {
    let best: Hit | null = null
    for (const id of ids) {
      const m = await this.matchOptional(id, roi, threshold)
      if (!m || !m.found) continue
      if (!best || m.score > best.match.score) best = { id, match: m }
    }
    return best
  }

  /**
   * 轮询等待某个（或某几个之一）模板出现。
   * @returns 命中；超时返回 null（由调用方决定是重试还是报错，别在这里替它决定）
   */
  async waitFor(
    ids: string | string[],
    opts: { roi?: Rect; waitMs: number; pollMs?: number; threshold?: number }
  ): Promise<Hit | null> {
    const list = Array.isArray(ids) ? ids : [ids]
    const poll = Math.max(150, opts.pollMs ?? 600)
    const deadline = this.now() + Math.max(0, opts.waitMs)
    for (;;) {
      this.invalidate()
      const hit = await this.bestOf(list, opts.roi, opts.threshold)
      if (hit) return hit
      if (this.now() >= deadline) return null
      await this.sleep(poll)
    }
  }

  // ── 输入 ────────────────────────────────────────────────────────────────

  /** 点一个参考坐标点。点完必然使当前帧作废。 */
  async tapAt(p: Point, afterMs = 400): Promise<void> {
    this.ensureAlive()
    await this.io.tap(Math.round(p.x), Math.round(p.y))
    this.invalidate()
    if (afterMs > 0) await this.sleep(afterMs)
  }

  /** 连点同一个点若干次（合并成一次 adb shell，实测 5 次分开 103ms、合并 34ms）。 */
  async tapRepeat(p: Point, times: number, gapMs = 120, afterMs = 600): Promise<void> {
    if (times <= 0) return
    this.ensureAlive()
    const pts: [number, number][] = []
    for (let i = 0; i < times; i++) pts.push([Math.round(p.x), Math.round(p.y)])
    await this.io.tapMany(pts, gapMs)
    this.invalidate()
    if (afterMs > 0) await this.sleep(afterMs)
  }

  /**
   * 滑动，带重试。
   * ★ `adb input swipe` 偶发 `SecurityException: INJECT_EVENTS`，实测重试即成功；
   *   adb 层本身不重试，重试必须由调用方做。
   */
  async swipe(from: Point, to: Point, durationMs: number, afterMs = 600): Promise<void> {
    const retries = this.config.safety.swipeRetry
    let lastErr: unknown = null
    for (let attempt = 0; attempt <= retries; attempt++) {
      this.ensureAlive()
      try {
        await this.io.swipe(
          Math.round(from.x),
          Math.round(from.y),
          Math.round(to.x),
          Math.round(to.y),
          durationMs
        )
        this.invalidate()
        if (afterMs > 0) await this.sleep(afterMs)
        return
      } catch (e) {
        lastErr = e
        this.logFn('warn', `滑动失败（第 ${attempt + 1} 次）：${errMsg(e)}，准备重试`, {
          from,
          to,
          durationMs
        })
        await this.sleep(300)
      }
    }
    throw AppError.from(lastErr, 'ADB_COMMAND_FAILED')
  }

  async key(k: AndroidKey, afterMs = 700): Promise<void> {
    this.ensureAlive()
    await this.io.key(k)
    this.invalidate()
    if (afterMs > 0) await this.sleep(afterMs)
  }

  // ── 取色 ────────────────────────────────────────────────────────────────

  /** 在**当前帧的裸像素**上取一个点的邻域 RGB 均值（勾选框判定必须用彩色）。 */
  async sample(at: Point, radius = 3): Promise<Rgb> {
    const f = await this.frame()
    return sampleRgb(f.raw, at, this.refWidth, this.refHeight, radius)
  }

  // ── 数字识别 ────────────────────────────────────────────────────────────

  /** 直接读一次（不重试）。ROI 由调用方给。 */
  async readDigitsOnce(
    glyphSetName: string,
    roi: Rect,
    minScore = GLYPH_MIN_SCORE
  ): Promise<DigitReading> {
    const set = this.templates.requireGlyphs(glyphSetName)
    const f = await this.frame()
    return readDigits(f.raw, roi, set, this.refWidth, this.refHeight, { minScore })
  }

  /**
   * 读一个数字字段：读 -> 正则校验 -> 不通过就换一帧重读，最多 tries 次。
   *
   * 置信度规则（gather-flow.json 的 digitRecognition.confidence）：
   *   · 所有字形 >= minScore（默认 0.78）且整串通过校验 ⇒ 直接采信
   *   · 任一字形落在 [0.70, minScore) ⇒ 标为低置信，必须换一帧复核，两帧读数一致才采信
   *   · 出现 '?' 占位 / 校验不过 / 三次读不一致 ⇒ 判失败（返回 null，绝不猜值）
   *
   * ★★ 什么时候该调高 minScore（真机实测教训，2026-09-09）：
   *    当**字形集缺字**时，逐字位 argmax 不会输出 '?'，而是挑一个「最像的现有字形」顶上，
   *    于是读出来的是一个**格式完全合法、值却是错的**串 —— 正则拦不住它。
   *    实测：`dig_card_coord` 当时缺 0 和 4（2026-09-10 已补齐），部队管理面板行内的真值 `607,560`
   *    被读成 `697,566`（minScore 0.787），真值 `661,556` 被读成 `691,556`（minScore 0.789）；
   *    而同一套字形在资源点卡片上读对时分数是 0.967~0.980。
   *    ⇒ 坐标这种「错了不会被下游发现、还会污染配额记账与去重」的字段，
   *      必须把 minScore 抬到 0.90，宁可判成「读不出」也不要拿到一个假坐标。
   *
   * @param resolveRoi 每次重试都会重算 —— ROI 往往依赖当前帧里某个模板的命中位置。
   */
  async readNumberField<T>(opts: {
    /** 中文字段名，只用于日志。 */
    field: string
    glyphSet: string
    resolveRoi: () => Promise<Rect | null>
    parse: (text: string) => T | null
    tries?: number
    /** 单字形接受阈值。默认 GLYPH_MIN_SCORE（0.78）。见上面的「什么时候该调高」。 */
    minScore?: number
  }): Promise<T | null> {
    if (!this.templates.hasGlyphs(opts.glyphSet)) {
      this.warn(`字形集「${opts.glyphSet}」缺失，读不了「${opts.field}」，按识别失败处理`, {
        field: opts.field,
        glyphSet: opts.glyphSet
      })
      return null
    }
    const tries = Math.max(1, opts.tries ?? 3)
    const minScore = opts.minScore ?? GLYPH_MIN_SCORE
    let lastLowText: string | null = null
    let lastText = ''
    let lastRoi: Rect | null = null

    for (let i = 0; i < tries; i++) {
      this.ensureAlive()
      if (i > 0) {
        // 可能截到了动画中间帧，换一帧再来。
        this.invalidate()
        await this.sleep(400)
      }
      const roi = await opts.resolveRoi()
      lastRoi = roi
      if (!roi) continue

      // 用 0.70 的下界收峰，好把「低置信」的情况识别出来并走复核，而不是直接当没读到。
      const reading = await this.readDigitsOnce(opts.glyphSet, roi, GLYPH_LOW_CONFIDENCE)
      lastText = reading.text
      if (reading.hasGap || reading.text.length === 0) continue

      const value = opts.parse(reading.text)
      if (value === null) continue

      if (reading.minScore >= minScore) {
        this.logFn('debug', `读到「${opts.field}」= ${reading.text}`, {
          field: opts.field,
          text: reading.text,
          minScore: reading.minScore
        })
        return value
      }
      // 低置信：要求连续两帧读到同一串。
      if (lastLowText === reading.text) {
        this.logFn('debug', `「${opts.field}」低置信但两帧一致，采信 ${reading.text}`, {
          field: opts.field,
          minScore: reading.minScore
        })
        return value
      }
      lastLowText = reading.text
    }

    this.warn(
      `「${opts.field}」识别失败：连续 ${tries} 次都读不出可信的值` +
        `（最后一次读到「${lastText}」，接受阈值 ${minScore}）`,
      { field: opts.field, glyphSet: opts.glyphSet, roi: lastRoi, lastText, minScore }
    )
    return null
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
