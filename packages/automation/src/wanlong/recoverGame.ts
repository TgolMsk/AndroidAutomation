/**
 * 顶号 / 断线之后的游戏恢复序列（机器人「🔁 重启游戏并恢复」、告警消息下面的同名按钮）。
 * 移植自原版 src/main/index.ts 的 recoverGame()（原版没有离线自检，这里的测试见 packages/automation/test/wanlong-recover-game.test.ts）。
 *
 * 实测链路：顶号弹窗 →点确定→ 游戏进程退出 →monkey 重启→「网络不稳定」弹窗 →点确定→ 自动回主城
 *
 *   ① 顶号弹窗还挂着 → 点「确定」（游戏会随之退出），等 6 秒
 *   ② 游戏进程不在 → monkey 拉起（★ am start 对本游戏无效），轮询前台最多 30×2 秒，再等 20 秒加载
 *      （进程在但不在前台 → 同一条 monkey 切回前台；原版这种情况会直接在第 ④ 步报「没有回到前台」）
 *   ③ 「网络不稳定，连接已断开」→ 点「确定」重连，最多两轮，每轮等 15 秒
 *   ④ 校验：前台必须是游戏，顶号弹窗不能再出现；任何一步校验不过都抛中文错误
 *
 * ★ 绝不盲点：弹窗都要**模板命中**才点。模板集里没有 tpl_dlg_kicked / tpl_dlg_network_lost（仓库不带模板，要用户自己裁或导入旧版）
 *   时对应的一步直接跳过，只剩「进程不在就 monkey 拉起 + 前台校验」。
 * ★ 与原版的差异：原版第二层识别命中任何一张预留模板（顶号框 / 登录页 / 维护 / 更新）都点顶号框的「确定」坐标；
 *   这里只在 tpl_dlg_kicked 命中时点 —— 那个坐标是按顶号框校准的，点在登录页或维护公告上后果不可知。
 * ★ 调用方必须在调度器的实例锁内调（EtaScheduler.exclusive）：恢复期间不能有采样 / 派遣去点同一个模拟器。
 *   恢复自动调度（会采样、要抢锁）是**锁外**的另一步，不在这里做。
 * ★ 坐标是参考分辨率（2560×1440）下的，换算到设备坐标、点之前复核前台是游戏，都由 io.tapRef 负责。
 *
 * 纯逻辑 + 注入能力，不 import electron / adb。
 */

import type { RawFrame } from '../contracts.js'
import { AppError } from '../errors.js'

/** 参考坐标（2560×1440）上的一个点。 */
export interface RefPoint {
  x: number
  y: number
}

/** 第二层识别（顶号 / 登录页 / 维护 / 更新）在一帧上的命中。没命中或模板缺失为 null。 */
export interface RecoverKickedHit {
  templateId: string
  /** suspectedKicked = 顶号类（顶号框 / 登录页）；needsAttention = 维护 / 更新这类要人处理的 */
  type: 'suspectedKicked' | 'needsAttention'
  reason: string
}

export interface GameRecoveryIo {
  /** 截一帧。 */
  capture(): Promise<RawFrame>
  /** 第二层识别。★ 模板缺失 / 识别失败都返回 null，绝不抛。 */
  kicked(raw: RawFrame): Promise<RecoverKickedHit | null>
  /** 某张模板在这一帧上命中没有。★ 模板缺失返回 false，绝不抛。 */
  seen(templateId: string, raw: RawFrame): Promise<boolean>
  /** 按参考坐标点一下（换算设备坐标、点之前复核前台是游戏都在这里做；前台不是游戏就抛中文错误）。 */
  tapRef(point: RefPoint): Promise<void>
  /** 游戏进程在不在（pidof）。 */
  isGameRunning(): Promise<boolean>
  /** 拉起游戏。★ 必须是 monkey（AdbDevice.startApp 不带 activity）。 */
  launchGame(): Promise<void>
  /** 当前前台包名；查不出来为 null。 */
  foreground(): Promise<string | null>
  /** 等一会儿（可注入，离线自检用虚拟时钟）。中止时应当抛出。 */
  sleep(ms: number): Promise<void>
  gamePackage: string
  log?(level: 'debug' | 'info' | 'warn', message: string): void
  /** 中止信号（助手退出 / 实例锁被收回）。 */
  signal?: AbortSignal
}

/** 实测参数（原版常量原样搬过来）。 */
export const RECOVER_GAME_DEFAULTS = {
  /** 顶号弹窗「确定」（参考分辨率 2560x1440） */
  kickConfirmRef: { x: 1275, y: 965 } as RefPoint,
  /** 网络断开弹窗「确定」 */
  networkConfirmRef: { x: 1272, y: 899 } as RefPoint,
  /** 点掉顶号弹窗后等游戏退出 */
  afterKickMs: 6_000,
  /** monkey 之后轮询前台的次数与间隔 */
  foregroundPolls: 30,
  foregroundPollMs: 2_000,
  /** 到前台之后再等它加载 */
  afterLaunchMs: 20_000,
  /** 网络重连提示最多点几轮 */
  networkRounds: 2,
  afterNetworkMs: 15_000
}

export type RecoverGameOptions = Partial<typeof RECOVER_GAME_DEFAULTS>

/** 顶号弹窗的模板 id（与告警模块的预留模板同名）。 */
export const RECOVER_KICKED_DIALOG = 'tpl_dlg_kicked'
/** 「网络不稳定，连接已断开」弹窗的模板 id。 */
export const RECOVER_NETWORK_LOST = 'tpl_dlg_network_lost'

/** 什么都不用做时的返回文案。 */
export const RECOVER_NOTHING_TO_DO = '游戏本来就在正常运行，没有需要处理的弹窗'

function checkAbort(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return
  const reason: unknown = signal.reason
  if (reason instanceof Error) throw reason
  throw new AppError('RUN_ABORTED', '重启游戏已中止')
}

/**
 * 跑一遍恢复序列。返回做了哪些步骤的中文描述（用「 → 」连接），什么都没做时返回 RECOVER_NOTHING_TO_DO。
 * 校验不过抛 AppError('NOT_FOUND', 中文原因)；中止时抛中止原因。
 */
export async function recoverGame(io: GameRecoveryIo, options: RecoverGameOptions = {}): Promise<string> {
  const o = { ...RECOVER_GAME_DEFAULTS, ...options }
  const steps: string[] = []
  const log = (level: 'debug' | 'info' | 'warn', message: string): void => {
    try {
      io.log?.(level, message)
    } catch {
      // 日志出口坏了不影响恢复。
    }
  }
  const wait = async (ms: number): Promise<void> => {
    checkAbort(io.signal)
    await io.sleep(ms)
    checkAbort(io.signal)
  }

  // ① 顶号弹窗还挂着 → 点确定（游戏会随之退出）
  checkAbort(io.signal)
  let raw = await io.capture()
  const kickedAtStart = await io.kicked(raw)
  if (kickedAtStart?.templateId === RECOVER_KICKED_DIALOG) {
    log('info', `看到顶号弹窗（${kickedAtStart.templateId}），点「确定」。`)
    await io.tapRef(o.kickConfirmRef)
    steps.push('点掉顶号弹窗')
    await wait(o.afterKickMs)
  } else if (kickedAtStart) {
    log('info', `第二层识别命中 ${kickedAtStart.templateId}（${kickedAtStart.reason}），不是顶号弹窗，不点。`)
  }

  // ② 进程不在 → monkey 拉起（am start 对本游戏无效）。
  //    ★ 本仓库补的一条：进程还在但被切到了后台（Android 桌面 / 别的应用）→ 同一条 monkey 把它切回前台，不用等加载。
  checkAbort(io.signal)
  const running = await io.isGameRunning()
  if (!running || (await io.foreground()) !== io.gamePackage) {
    await io.launchGame()
    steps.push(running ? '把游戏切回前台' : '用 monkey 重启游戏')
    for (let i = 0; i < o.foregroundPolls; i += 1) {
      checkAbort(io.signal)
      if ((await io.foreground()) === io.gamePackage) break
      await wait(o.foregroundPollMs)
    }
    if (!running) await wait(o.afterLaunchMs)
  }

  // ③ 「网络不稳定，连接已断开」→ 点确定重连（最多两轮）
  for (let i = 0; i < o.networkRounds; i += 1) {
    checkAbort(io.signal)
    raw = await io.capture()
    if (!(await io.seen(RECOVER_NETWORK_LOST, raw))) break
    await io.tapRef(o.networkConfirmRef)
    steps.push('点掉网络重连提示')
    await wait(o.afterNetworkMs)
  }

  // ④ 校验：前台是游戏、且顶号弹窗没有再次出现
  checkAbort(io.signal)
  raw = await io.capture()
  const fg = await io.foreground()
  if (fg !== io.gamePackage) {
    throw new AppError('NOT_FOUND', `游戏没有回到前台（当前前台：${fg ?? '未知'}），未恢复调度。`)
  }
  const kickedAtEnd = await io.kicked(raw)
  if (kickedAtEnd) {
    if (kickedAtEnd.type === 'suspectedKicked') {
      throw new AppError('NOT_FOUND', '重启后顶号弹窗又出现了 —— 对方设备可能还在线。请先退出另一台设备再试。')
    }
    throw new AppError('NOT_FOUND', `重启后画面仍然不对：${kickedAtEnd.reason}需要人工处理，未恢复调度。`)
  }
  return steps.length > 0 ? steps.join(' → ') : RECOVER_NOTHING_TO_DO
}
