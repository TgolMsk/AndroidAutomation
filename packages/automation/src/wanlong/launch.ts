/**
 * 「把游戏拉到前台」的冷启动恢复。
 *
 * 解决的场景：**模拟器刚开机、游戏还没跑**（也包括游戏被系统杀掉、用户手动退到了 Android 桌面）。
 * 这时画面是桌面，任何界面模板都匹配不上；采样器与采集流程如果只会「等一等 / 点弹窗 × / 按 BACK」，
 * 就会一路失败到被告警中心暂停 —— 而这其实是**唯一能自己救回来**的一类故障：把游戏拉起来就行。
 *
 * ★ 两条真机实测铁则，改代码前先读：
 *   1. **《万龙觉醒》只能用 monkey 拉起。** `am start -n <组件>` 会返回成功但进程根本起不来
 *      （旧版面板真机实测；MuMu 的 open_app 接口也不可用）。所以 `io.launch` 的实现**必须**是 monkey：
 *      目标仓库里就是 `@avdm/core` 的 `AdbDevice.startApp(pkg)` **不带 activity**
 *      （= `monkey -p <pkg> -c android.intent.category.LAUNCHER 1`），绝不能传 activity 走 am start。
 *   2. **拉起 ≠ 能用。** monkey 返回后窗口约 10s 才到前台；真正进到城内 / 世界地图，
 *      模拟器冷启动实测要 90s 以上。所以本函数只负责把**前台**等到游戏，
 *      「等到能识别的界面」交给调用方按帧轮询 —— 它手里有模板，判得准。
 *
 * 纯逻辑 + 注入能力，不 import electron / adb，便于离线自检（packages/automation/test/wanlong-launch.test.ts）。
 */

/** 本次做了什么。调用方据此决定要不要加时等加载。 */
export type GamePresence =
  /** 游戏本来就在前台，什么都没做（界面认不出是别的原因：弹窗 / 加载 / 二级页）。 */
  | 'foreground'
  /** 刚把游戏拉到前台，**画面多半还在加载**，调用方要给足时间再判界面。 */
  | 'launched'
  /** 拉起失败或等不到前台。调用方按原来的失败阶梯继续。 */
  | 'failed'

export interface GameLaunchIo {
  /** 当前前台包名；查不出来给 null。 */
  foreground(): Promise<string | null>
  /** 拉起游戏。★ 实现必须是 monkey（见文件头铁则 1）。 */
  launch(): Promise<void>
  /** 游戏进程在不在（可选，只用于把日志写准：是「没启动」还是「退到后台了」；实现见 DevicePort.isAppRunning = pidof）。 */
  isRunning?(): Promise<boolean>
  /**
   * 中止检查（可选）：每次查询 / 等待之前调一次，抛出的中止错误**原样上抛**。
   * ★ 这是「不抛异常」约定的唯一例外 —— 否则停止任务要白等到 60s 超时才生效（查询类异常都被 quiet() 吞了）。
   */
  checkAlive?(): void
  log?(level: 'debug' | 'info' | 'warn', message: string): void
  /** 可注入，便于离线自检。 */
  sleep?(ms: number): Promise<void>
  now?(): number
}

export interface GameLaunchOptions {
  packageName: string
  /** 等前台变成游戏的最长时间。冷启动实测约 10s 就能看到窗口，给 60s 足够宽松。 */
  foregroundTimeoutMs?: number
  /** 轮询前台的间隔。 */
  pollMs?: number
}

export const DEFAULT_FOREGROUND_TIMEOUT_MS = 60_000
export const DEFAULT_FOREGROUND_POLL_MS = 2_000

/**
 * 确认游戏在前台，不在就拉起来并等到它到前台为止。**任何情况下都不抛异常**
 * （调用方通常在采样 / 采集的兜底阶梯里调它，它自己炸掉只会把问题变复杂）。
 * 唯一例外：`io.checkAlive` 抛出的中止错误（任务被停止）原样上抛。
 */
export async function ensureGameForeground(
  io: GameLaunchIo,
  opts: GameLaunchOptions
): Promise<GamePresence> {
  const pkg = opts.packageName
  const timeoutMs = Math.max(0, opts.foregroundTimeoutMs ?? DEFAULT_FOREGROUND_TIMEOUT_MS)
  const pollMs = Math.max(200, opts.pollMs ?? DEFAULT_FOREGROUND_POLL_MS)
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const now = io.now ?? (() => Date.now())
  const alive = (): void => io.checkAlive?.()

  alive()
  const fg = await quiet(() => io.foreground(), null)
  if (fg === pkg) {
    io.log?.('debug', `游戏已经在前台（${pkg}），不需要拉起。`)
    return 'foreground'
  }

  // 进程在不在只影响日志措辞，查不出来也照样拉。
  const running = io.isRunning ? await quiet(() => io.isRunning!(), null) : null
  io.log?.(
    'info',
    running === false
      ? `游戏进程不在（当前前台：${describe(fg)}），正在用 monkey 拉起游戏……`
      : `游戏不在前台（当前前台：${describe(fg)}${running === true ? '，进程还在' : ''}），正在把它切到前台……`
  )

  alive()
  try {
    await io.launch()
  } catch (e) {
    io.log?.('warn', `拉起游戏失败：${errText(e)}`)
    return 'failed'
  }

  const deadline = now() + timeoutMs
  for (;;) {
    alive()
    await sleep(pollMs)
    alive()
    const cur = await quiet(() => io.foreground(), null)
    if (cur === pkg) {
      io.log?.('info', '游戏已经到前台，接下来要等它把主界面加载出来。')
      return 'launched'
    }
    if (now() >= deadline) {
      io.log?.(
        'warn',
        `拉起游戏后等了 ${Math.round(timeoutMs / 1000)}s，前台仍然是「${describe(cur)}」，放弃。`
      )
      return 'failed'
    }
  }
}

function describe(pkg: string | null): string {
  return pkg ?? '未知'
}

function errText(e: unknown): string {
  return (e as Error)?.message ?? String(e)
}

/** 查询类调用失败不该让恢复流程中断，统一吞掉给默认值。 */
async function quiet<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn()
  } catch {
    return fallback
  }
}
