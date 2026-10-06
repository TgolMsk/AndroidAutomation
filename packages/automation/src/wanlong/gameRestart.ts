/**
 * 游戏异常自动重启：截一帧先查顶号 → 强制停止游戏 → monkey 拉起 → 等前台 → 等主界面（只看不点）。
 * 接线在助手 src/main/alerts/game-restart.ts 的 GameRestartController（离线自检见 test/wanlong-game-restart.test.ts）。
 *
 * 场景：模拟器本身是好的，游戏却卡在认不出的界面、弹了系统的「应用无响应」（ANR）、或者闪退了。
 * 只重启游戏比重启整个模拟器（freezeRecovery.ts）轻得多：约 1~2 分钟，不动 Quick Boot 快照。
 *
 * ★ 顶号不在这里处理（用户诉求「当出现非挤号情况自动重启应用」）：动手前先截一帧跑第二层识别，
 *   命中顶号框 / 登录页 / 维护 / 更新公告就**不重启**，把命中交回调用方 —— 顶号走告警模块的「暂停 + 关闭模拟器」，
 *   维护 / 更新走「需要人工介入」。重启后等满时限仍认不出主界面时，也在最后一帧上再看一次同一件事。
 * ★ 调用方必须在调度器的实例锁内调（EtaScheduler.exclusive）：重启期间不能有采样 / 派遣去点同一个模拟器。
 * ★ 不判定该不该重启、不发通知、不改调度器状态；不抛业务异常，一切失败都在返回值的 stage / reason 里，
 *   只有中止（AbortSignal）时抛 RUN_ABORTED。
 *
 * 纯逻辑 + 注入能力，不 import electron / adb。
 */

import type { RawFrame } from '../contracts.js'
import { AppError } from '../errors.js'
import type { KickedProbeResult } from './gather/facts.js'
import { ensureGameForeground } from './launch.js'

export interface GameRestartIo {
  /** 截一帧（前台是什么就截什么）。 */
  capture(): Promise<RawFrame>
  /** 这一帧是不是已知界面（世界地图 / 城内 / 部队面板）。 */
  recognize(raw: RawFrame): Promise<boolean>
  /** 第二层识别（顶号框 / 登录页 / 维护 / 更新）。★ 模板缺失、识别失败都返回 null，绝不抛。 */
  kicked(raw: RawFrame): Promise<KickedProbeResult | null>
  /** 强制停止游戏（am force-stop）。 */
  stopGame(): Promise<void>
  /** ★ 必须是 monkey：am start 对本游戏返回成功但进程起不来（AdbDevice.startApp 不带 activity）。 */
  launchGame(): Promise<void>
  /** 当前前台包名；查不出来为 null。 */
  foreground(): Promise<string | null>
  /** 游戏进程在不在（可选，只让日志写得准）。 */
  isGameRunning?(): Promise<boolean>
  log(level: 'debug' | 'info' | 'warn', message: string): void
  /** 可注入，便于离线自检（虚拟时钟）。 */
  sleep?(ms: number): Promise<void>
  now?(): number
  /** 助手退出 / 自动调度被关掉时中止。 */
  signal?: AbortSignal
}

export interface GameRestartOptions {
  gamePackage: string
  /** force-stop 之后缓一缓再 monkey（同脚本引擎的 RESTART_GAP_MS）。 */
  stopGapMs?: number
  /** 拉起后等前台变成游戏。 */
  foregroundTimeoutMs?: number
  /** 游戏到前台后等主界面（只看不点）。热启动到城内实测 60~150s，加载完常压着一张活动弹窗。 */
  loadTimeoutMs?: number
  /** 等主界面时的截图间隔。 */
  pollMs?: number
}

export const GAME_RESTART_DEFAULTS = {
  stopGapMs: 2_000,
  foregroundTimeoutMs: 60_000,
  loadTimeoutMs: 180_000,
  pollMs: 3_000
} as const

export type GameRestartStage = 'check' | 'stop' | 'launch' | 'load'

export const GAME_RESTART_STAGE_TEXT: Record<GameRestartStage, string> = {
  check: '重启前的顶号检查',
  stop: '强制停止游戏',
  launch: '拉起游戏',
  load: '等游戏加载出主界面'
}

export interface GameRestartResult {
  ok: boolean
  /**
   * 成功时：主界面是否已经认出。false = 游戏在前台、但等满时限仍没到已知界面（多半压着活动弹窗），
   * 交给调度器采样时的弹窗阶梯去处理，不算失败（与卡死恢复同一口径）。
   */
  loaded: boolean
  /** 失败 / 命中卡在哪一步；成功为 'done'。 */
  stage: GameRestartStage | 'done'
  /** 失败原因（中文）；成功为 null。 */
  reason: string | null
  /**
   * 第二层识别命中：stage 'check' = 画面上本来就是它，**没有重启**；stage 'load' = 重启后停在它上面。
   * 顶号类交给告警模块的顶号结论，维护 / 更新交给「需要人工介入」。
   */
  verdict: KickedProbeResult | null
  /** 做过的步骤，拼进通知正文。 */
  steps: string[]
  elapsedMs: number
  /** 命中 verdict 或加载失败时的那一帧（留现场截图用），没有则为 null。 */
  frame: RawFrame | null
  /** 重启前截到的那一帧（卡住时的画面，成功时留作现场截图），没截到为 null。 */
  before: RawFrame | null
}

function errText(e: unknown): string {
  return AppError.from(e).message
}

/** 查询类调用失败不该让流程中断，统一吞掉给默认值。 */
async function quiet<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn()
  } catch {
    return fallback
  }
}

export async function restartStuckGame(
  io: GameRestartIo,
  opts: GameRestartOptions
): Promise<GameRestartResult> {
  const o = { ...GAME_RESTART_DEFAULTS, ...stripUndefined(opts) }
  const now = io.now ?? (() => Date.now())
  const rawSleep = io.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const checkAbort = (): void => {
    if (io.signal?.aborted) throw new AppError('RUN_ABORTED', '游戏自动重启已中止。')
  }
  const sleep = async (ms: number): Promise<void> => {
    checkAbort()
    await rawSleep(ms)
    checkAbort()
  }
  const pollMs = Math.max(200, o.pollMs)
  const t0 = now()
  const steps: string[] = []
  let before: RawFrame | null = null
  const done = (
    p: Pick<GameRestartResult, 'ok' | 'loaded' | 'stage' | 'reason'> & Partial<Pick<GameRestartResult, 'verdict' | 'frame'>>
  ): GameRestartResult => ({ verdict: null, frame: null, ...p, steps, elapsedMs: now() - t0, before })
  const fail = (stage: GameRestartStage, reason: string, frame: RawFrame | null = null): GameRestartResult => {
    io.log('warn', `游戏自动重启失败（${GAME_RESTART_STAGE_TEXT[stage]}）：${reason}`)
    return done({ ok: false, loaded: false, stage, reason, frame })
  }
  const hit = (stage: GameRestartStage, verdict: KickedProbeResult, frame: RawFrame): GameRestartResult => {
    io.log('warn', `${stage === 'check' ? '重启前' : '重启后'}的画面命中第二层识别（${verdict.templateId ?? verdict.type}）：${verdict.reason}`)
    return done({ ok: false, loaded: false, stage, reason: verdict.reason, verdict, frame })
  }

  // ① 动手前先看一眼：顶号 / 登录页 / 维护 / 更新 → 不重启（重启后自动登录会把另一台设备挤下线）。
  //    截不到图不拦着（ANR 时截图照样能截；截不到多半是 adb 的问题，下面的 force-stop 会给出准确的失败原因）。
  checkAbort()
  let raw: RawFrame | null = null
  try {
    raw = await io.capture()
  } catch (e) {
    io.log('debug', `重启前截图失败（不影响重启）：${errText(e)}`)
  }
  before = raw
  if (raw) {
    const verdict = await quiet(() => io.kicked(raw!), null)
    if (verdict) return hit('check', verdict, raw)
  }

  // ② 强制停止。进程本来就不在（闪退）时 force-stop 是空操作，照样下发。
  checkAbort()
  const wasRunning = io.isGameRunning ? await quiet(() => io.isGameRunning!(), null) : null
  io.log('info', `强制停止游戏${wasRunning === false ? '（进程本来就不在）' : ''}，${Math.round(o.stopGapMs / 1000)}s 后重新拉起。`)
  try {
    await io.stopGame()
  } catch (e) {
    checkAbort()
    return fail('stop', errText(e), raw)
  }
  steps.push(wasRunning === false ? '游戏进程已不在' : '强制停止游戏')
  await sleep(Math.max(0, o.stopGapMs))

  // ③ monkey 拉起并等到前台；失败隔 5s 再试一次（monkey 偶尔在 package manager 忙时失败）。
  {
    const launchIo = {
      foreground: () => io.foreground(),
      launch: () => io.launchGame(),
      isRunning: io.isGameRunning ? () => io.isGameRunning!() : undefined,
      checkAlive: checkAbort,
      log: io.log,
      sleep,
      now
    }
    const launchOpts = { packageName: opts.gamePackage, foregroundTimeoutMs: o.foregroundTimeoutMs }
    let presence = await ensureGameForeground(launchIo, launchOpts)
    if (presence === 'failed') {
      io.log('warn', '第一次拉起游戏没成功，5s 后再试一次。')
      await sleep(5_000)
      presence = await ensureGameForeground(launchIo, launchOpts)
    }
    if (presence === 'failed') return fail('launch', '两次都没能把游戏拉到前台。')
    steps.push('已用 monkey 拉起游戏')
  }

  // ④ 等主界面（只看不点）。等满时限仍认不出：先在最后一帧上查顶号，再看前台 —— 游戏还在前台就算成功（loaded=false），
  //    交给调度器采样时的弹窗阶梯；前台都不是游戏了才算失败。
  const deadline = now() + Math.max(0, o.loadTimeoutMs)
  let last: RawFrame | null = null
  let frames = 0
  for (;;) {
    checkAbort()
    let frame: RawFrame | null = null
    try {
      frame = await io.capture()
    } catch (e) {
      io.log('debug', `等主界面时截图失败（继续等）：${errText(e)}`)
    }
    if (frame) {
      frames += 1
      last = frame
      if (await quiet(() => io.recognize(frame!), false)) {
        steps.push('主界面已认出')
        io.log('info', `游戏已加载出已知界面（看了 ${frames} 帧），自动重启完成。`)
        return done({ ok: true, loaded: true, stage: 'done', reason: null })
      }
    }
    if (now() >= deadline) break
    await sleep(pollMs)
  }
  if (last) {
    const verdict = await quiet(() => io.kicked(last!), null)
    if (verdict) return hit('load', verdict, last)
  }
  const fg = await quiet(() => io.foreground(), null)
  if (fg !== opts.gamePackage) {
    return fail(
      'load',
      `拉起后 ${Math.round(o.loadTimeoutMs / 1000)}s 内没加载出主界面，且前台已经不是游戏（当前：${fg ?? '未知'}）。`,
      last
    )
  }
  steps.push('主界面未认出，交给调度器处理')
  io.log(
    'warn',
    `拉起后 ${Math.round(o.loadTimeoutMs / 1000)}s 内没认出主界面，游戏仍在前台，交给调度器的弹窗阶梯继续。`
  )
  return done({ ok: true, loaded: false, stage: 'done', reason: null })
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {}
  for (const [k, v] of Object.entries(o)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v
  }
  return out
}
