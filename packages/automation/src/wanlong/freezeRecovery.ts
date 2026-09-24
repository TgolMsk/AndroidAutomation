/**
 * 卡死恢复流程：重启模拟器实例 → 等 Android 起来 → 重连 adb → 等开机完成 → monkey 拉起游戏 → 等主界面。
 * 移植自原版 src/main/alerts/freezeRecovery.ts（离线自检见 packages/automation/test/wanlong-freeze.test.ts）。
 *
 * 只负责「按顺序把这几步做完并说清楚卡在哪」，**不判定卡不卡死、不发通知、不改调度器状态** ——
 * 判定在 freeze.ts（FreezeGuard），接线在助手 src/main/alerts/freeze-controller.ts 的 tryFreezeRecovery()。
 *
 * ★ 调用方必须在调度器的实例锁内调（EtaScheduler.exclusive）：重启期间绝不能有采样 / 派遣去点同一个模拟器。
 * ★ 目标仓库里模拟器是 Android Emulator（@avdm/core 的 AvdManager）：
 *     「重启」= stop({ force: true }) + start()：强杀后冷启动，**不能**用优雅关机 —— 那会把卡死的客体存进
 *     Quick Boot 快照，下次启动又卡在同一个画面；
 *     冷启动约 13~20s 到 Android 就绪；serial 是 emulator-<console>，每次都从发现文件现读（端口可能变）；
 *     monkey 拉起后窗口约 10s 到前台，冷启动到城内 90~150s，加载完常压着一张活动弹窗。
 * ★ 不抛业务异常，一切失败都体现在返回值的 stage / reason 里；只有 AbortSignal 中止时抛 RUN_ABORTED
 *   （助手退出 / 用户关掉自动调度时要能立刻停手，别让退出等上五分钟）。
 *
 * 纯逻辑 + 注入能力，不 import electron / adb。
 */

import type { RawFrame } from '../contracts.js'
import { AppError } from '../errors.js'
import { frameDigest, framesLookIdentical, type FrameDigest } from './freeze.js'
import { ensureGameForeground } from './launch.js'

/** 驱动层能看到的实例状态（AvdManager.getState 映射过来）。 */
export interface InstanceProbe {
  /** 模拟器进程在不在（starting / booting / running 且有 pid）。 */
  processStarted: boolean
  /** Android 启动完成没有（status === 'running'：gRPC booted + sys.boot_completed）。 */
  androidStarted: boolean
  pid: number | null
}

export interface FreezeRecoveryIo {
  /** 重启实例（强杀 + 冷启动）。只代表命令已下发 / 进程已拉起。 */
  restartInstance(): Promise<void>
  /** 读实例当前状态；读不到（管理器正忙 / 实例列表暂时拿不到）返回 null。 */
  instanceState(): Promise<InstanceProbe | null>
  /** 丢掉旧的设备对象与车道缓存 —— 重启后 serial 可能变了。失败也别抛。 */
  dropDevice(): Promise<void>
  /** 按发现文件现读的端口重新拿设备，返回 serial。连不上就抛（会重试到超时）。 */
  attachDevice(): Promise<string>
  /** sys.boot_completed === 1 */
  isBooted(serial: string): Promise<boolean>
  foreground(serial: string): Promise<string | null>
  /** ★ 必须是 monkey：am start 对本游戏返回成功但进程起不来（AdbDevice.startApp 不带 activity）。 */
  launchGame(serial: string): Promise<void>
  isGameRunning?(serial: string): Promise<boolean>
  capture(serial: string): Promise<RawFrame>
  /** 这一帧是不是已知界面（世界地图 / 城内 / 部队面板）。 */
  recognize(raw: RawFrame): Promise<boolean>
  log(level: 'debug' | 'info' | 'warn', message: string): void
  /** 可注入，便于离线自检（虚拟时钟）。 */
  sleep?(ms: number): Promise<void>
  now?(): number
  /** 助手退出 / 自动调度被关掉时中止。 */
  signal?: AbortSignal
}

export interface FreezeRecoveryOptions {
  gamePackage: string
  /** 等「重启真的生效」（pid 变化 / 状态回落）的最长时间；观察不到就当它重启得太快，继续。 */
  restartObserveMs?: number
  /** 等 Android 启动完成。 */
  androidReadyTimeoutMs?: number
  /** 重启后 adb 一直连不上的最长等待。 */
  attachTimeoutMs?: number
  /** 等 sys.boot_completed。 */
  bootTimeoutMs?: number
  /** 开机完成后先缓一缓再 monkey（系统服务还没就绪时 monkey 会失败）。 */
  settleMs?: number
  /** 拉起后等前台变成游戏。 */
  foregroundTimeoutMs?: number
  /** 游戏到前台后等主界面（只看不点）。 */
  loadTimeoutMs?: number
  /** 各轮询的间隔。 */
  pollMs?: number
}

export const FREEZE_RECOVERY_DEFAULTS = {
  restartObserveMs: 30_000,
  androidReadyTimeoutMs: 180_000,
  attachTimeoutMs: 90_000,
  bootTimeoutMs: 120_000,
  settleMs: 8_000,
  foregroundTimeoutMs: 60_000,
  loadTimeoutMs: 180_000,
  pollMs: 3_000
} as const

export type FreezeRecoveryStage = 'restart' | 'androidReady' | 'adb' | 'boot' | 'launch' | 'load'

export const FREEZE_STAGE_TEXT: Record<FreezeRecoveryStage, string> = {
  restart: '下发重启命令',
  androidReady: '等模拟器启动完成',
  adb: '重新连接 adb',
  boot: '等 Android 开机完成',
  launch: '拉起游戏',
  load: '等游戏加载出主界面'
}

export interface FreezeRecoveryResult {
  ok: boolean
  /**
   * 成功时：主界面是否已经认出。false = 游戏在前台、但等满时限仍没到已知界面（多半压着活动弹窗），
   * 交给调度器采样时的弹窗阶梯去处理，不算失败。
   */
  loaded: boolean
  /** 失败卡在哪一步；成功为 'done'。 */
  stage: FreezeRecoveryStage | 'done'
  /** 失败原因（中文）；成功为 null。 */
  reason: string | null
  /** 做过的步骤，拼进通知正文。 */
  steps: string[]
  elapsedMs: number
  /** 重连后的 serial；没连上为 null。 */
  serial: string | null
}

function errText(e: unknown): string {
  return AppError.from(e).message
}

function describeState(s: InstanceProbe | null): string {
  if (!s) return '读不到实例状态'
  if (!s.processStarted) return '进程未启动'
  return s.androidStarted ? 'Android 已启动' : '进程已起、Android 尚未启动完成'
}

/** 查询类调用失败不该让恢复流程中断，统一吞掉给默认值。 */
async function quiet<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn()
  } catch {
    return fallback
  }
}

export async function recoverFrozenInstance(
  io: FreezeRecoveryIo,
  opts: FreezeRecoveryOptions
): Promise<FreezeRecoveryResult> {
  const o = { ...FREEZE_RECOVERY_DEFAULTS, ...stripUndefined(opts) }
  const now = io.now ?? (() => Date.now())
  const rawSleep = io.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const checkAbort = (): void => {
    if (io.signal?.aborted) throw new AppError('RUN_ABORTED', '卡死恢复流程已中止。')
  }
  const sleep = async (ms: number): Promise<void> => {
    checkAbort()
    await rawSleep(ms)
    checkAbort()
  }
  const pollMs = Math.max(200, o.pollMs)
  const t0 = now()
  const steps: string[] = []
  let serial: string | null = null
  const fail = (stage: FreezeRecoveryStage, reason: string): FreezeRecoveryResult => {
    io.log('warn', `卡死恢复失败（${FREEZE_STAGE_TEXT[stage]}）：${reason}`)
    return { ok: false, loaded: false, stage, reason, steps, elapsedMs: now() - t0, serial }
  }

  // ① 重启实例
  checkAbort()
  const before = await quiet(() => io.instanceState(), null)
  io.log(
    'info',
    `正在重启模拟器实例（重启前：${describeState(before)}，pid ${before?.pid ?? '?'}）……`
  )
  try {
    await io.restartInstance()
  } catch (e) {
    checkAbort()
    return fail('restart', errText(e))
  }
  steps.push('重启模拟器')

  // ② 等重启真的生效：pid 变了 / Android 状态回落 / 进程消失。观察不到就当它重启得太快，继续往下等。
  //    ★ 少了这一步会拿重启前的旧状态（仍是 running）误判「已经好了」，然后在旧的 serial 上白等。
  {
    const deadline = now() + Math.max(0, o.restartObserveMs)
    let observed = false
    while (now() < deadline) {
      await sleep(Math.min(1000, pollMs))
      const s = await quiet(() => io.instanceState(), null)
      if (
        s &&
        (!s.processStarted || !s.androidStarted || (before?.pid != null && s.pid !== before.pid))
      ) {
        observed = true
        break
      }
    }
    if (!observed) {
      io.log(
        'warn',
        `${Math.round(o.restartObserveMs / 1000)}s 内没观察到实例状态变化，可能重启已经很快完成了，继续等 Android 就绪。`
      )
    }
  }

  // ③ 等 Android 启动完成
  {
    const deadline = now() + Math.max(0, o.androidReadyTimeoutMs)
    let last: InstanceProbe | null = null
    for (;;) {
      last = await quiet(() => io.instanceState(), null)
      if (last?.processStarted && last.androidStarted) break
      if (now() >= deadline) {
        return fail(
          'androidReady',
          `等了 ${Math.round(o.androidReadyTimeoutMs / 1000)}s 模拟器仍未启动完成（当前：${describeState(last)}）。`
        )
      }
      await sleep(pollMs)
    }
    steps.push('模拟器已启动')
    io.log('info', 'Android 已启动，重新连接 adb（serial 可能变了）。')
  }

  // ④ 重连 adb：先把旧设备扔掉（serial 可能变），连不上就重试到超时
  await quiet(() => io.dropDevice(), undefined)
  {
    const deadline = now() + Math.max(0, o.attachTimeoutMs)
    let lastErr = ''
    for (;;) {
      checkAbort()
      try {
        serial = await io.attachDevice()
        break
      } catch (e) {
        lastErr = errText(e)
      }
      if (now() >= deadline) return fail('adb', `重启后 adb 一直连不上：${lastErr || '原因未知'}`)
      await sleep(pollMs)
    }
    steps.push(`adb 已连接 ${serial}`)
  }

  // ⑤ 等开机完成，再缓一缓（系统服务没就绪时 monkey 会失败）
  {
    const deadline = now() + Math.max(0, o.bootTimeoutMs)
    for (;;) {
      if (await quiet(() => io.isBooted(serial!), false)) break
      if (now() >= deadline) {
        return fail(
          'boot',
          `adb 连上了，但 ${Math.round(o.bootTimeoutMs / 1000)}s 内 sys.boot_completed 一直不是 1。`
        )
      }
      await sleep(pollMs)
    }
    await sleep(Math.max(0, o.settleMs))
    steps.push('开机完成')
  }

  // ⑥ 拉起游戏（monkey），失败再试一次 —— 刚开机时 package manager 偶尔还没就绪
  {
    const launchIo = {
      foreground: () => io.foreground(serial!),
      launch: () => io.launchGame(serial!),
      isRunning: io.isGameRunning ? () => io.isGameRunning!(serial!) : undefined,
      checkAlive: checkAbort,
      log: io.log,
      sleep,
      now
    }
    const launchOpts = { packageName: opts.gamePackage, foregroundTimeoutMs: o.foregroundTimeoutMs }
    let presence = await ensureGameForeground(launchIo, launchOpts)
    if (presence === 'failed') {
      io.log('warn', '第一次拉起游戏没成功，10s 后再试一次。')
      await sleep(10_000)
      presence = await ensureGameForeground(launchIo, launchOpts)
    }
    if (presence === 'failed') return fail('launch', '重启后两次都没能把游戏拉到前台。')
    steps.push(presence === 'launched' ? '已用 monkey 拉起游戏' : '游戏已在前台')
  }

  // ⑦ 等主界面出现（只看不点）。等满时限仍认不出：游戏还在前台就算成功（loaded=false），
  //    交给调度器采样时的弹窗阶梯；前台都不是游戏了才算失败。
  {
    const deadline = now() + Math.max(0, o.loadTimeoutMs)
    let prev: FrameDigest | null = null
    let frames = 0
    let moving = false
    for (;;) {
      checkAbort()
      let raw: RawFrame | null = null
      try {
        raw = await io.capture(serial!)
      } catch (e) {
        io.log('debug', `等主界面时截图失败（继续等）：${errText(e)}`)
      }
      if (raw) {
        frames += 1
        if (await quiet(() => io.recognize(raw!), false)) {
          steps.push('主界面已认出')
          io.log('info', `游戏已加载出已知界面（看了 ${frames} 帧），卡死恢复完成。`)
          return {
            ok: true,
            loaded: true,
            stage: 'done',
            reason: null,
            steps,
            elapsedMs: now() - t0,
            serial
          }
        }
        const d = frameDigest(raw)
        if (prev && !framesLookIdentical(prev, d)) moving = true
        prev = d
      }
      if (now() >= deadline) break
      await sleep(pollMs)
    }
    const fg = await quiet(() => io.foreground(serial!), null)
    if (fg !== opts.gamePackage) {
      return fail(
        'load',
        `拉起后 ${Math.round(o.loadTimeoutMs / 1000)}s 内没加载出主界面，且前台已经不是游戏（当前：${fg ?? '未知'}）。`
      )
    }
    steps.push(
      moving
        ? '主界面未认出但画面在动，交给调度器处理'
        : '主界面未认出（画面也没变化），交给调度器处理'
    )
    io.log(
      'warn',
      `拉起后 ${Math.round(o.loadTimeoutMs / 1000)}s 内没认出主界面（${moving ? '画面在动，多半是活动弹窗' : '画面没有变化'}），游戏仍在前台，交给调度器的弹窗阶梯继续。`
    )
    return {
      ok: true,
      loaded: false,
      stage: 'done',
      reason: null,
      steps,
      elapsedMs: now() - t0,
      serial
    }
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {}
  for (const [k, v] of Object.entries(o)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v
  }
  return out
}
