/**
 * 卡死看门狗（FreezeGuard）：判断「模拟器是不是卡死了」。移植自原版 src/main/alerts/freeze.ts
 * （离线自检见 packages/automation/test/wanlong-freeze.test.ts）。
 *
 * 用户诉求原话：「有时候模拟器会卡死在游戏页面不动，基于游戏主界面时间做一个判断，
 * 长时间不动表示卡死，做一个重启恢复」。
 *
 * 判据只有两条，都是**事实**不是猜测：
 *   ① 画面纹丝不动：连续多张截图**一模一样**，且跨度超过阈值（默认 5 分钟）。
 *      活着的游戏世界地图上水面、云、倒计时、行军队伍随时在动，几分钟内不可能一个点都不变；
 *      卡死时每张截图都是同一块缓冲区的拷贝，采样点的差异恒为 0。
 *   ② 截图一直失败：adb screencap 连续超时 / 离线，持续超过阈值。这是 Android 整个挂住的形态。
 *   两条都要配合「模拟器进程还在」这个前提（由接线层查 AvdManager），进程都没了不叫卡死，走原来的掉线暂停。
 *
 * 帧从哪来：调度器每截一帧（采样 / 健康探针）都通报进来（SchedulerHooks.onFrameCaptured），
 * 本模块只做比对与计时，**不截图、不重启、不写盘、不发通知** —— 那些是 freezeRecovery.ts 与接线层的事。
 *
 * 两档判定（同一份计时，不同门槛）：
 *   · assess()               健康探针路径：队列满着、几小时不采样时，只有探针在看画面，按完整阈值判。
 *   · assessAfterFailures()  采样已经连续失败、马上要按「掉线」暂停时：只要失败期间画面一直没变
 *                            （≥ 3 帧、≥ 60s）或截图连续失败 ≥ 2 次，就认定是卡死而不是掉线，先重启一次再说。
 *
 * 熔断：每实例在窗口期内最多重启 N 次（默认 60 分钟 3 次），超过就不再重启、交回掉线暂停 ——
 * 防止「重启 → 又卡 → 再重启」无限循环把用户的号折腾坏。
 *
 * 纯逻辑 + 注入时钟，不 import electron / adb。
 */

import type { RawFrame } from '../contracts.js'

// ── 帧指纹 ────────────────────────────────────────────────────────────────

/** 指纹网格：2560×1440 → 96×54 = 5184 个采样点，纯 JS 几十微秒，不用 OpenCV。 */
export const DIGEST_COLS = 96
export const DIGEST_ROWS = 54
/** 两个采样点灰度差超过这个数才算「这个点变了」（防个别像素抖动 / 抗锯齿差异）。 */
export const CELL_DIFF_TOLERANCE = 8
/**
 * 变了的采样点不超过这个数就算「纹丝不动」。
 * 卡死时差异恒为 0，这 2 个点的余量只是留给「系统偶尔画一个光标 / 一个像素的闪烁」。
 * 任何真的动画（转圈、数字跳动、水面）都会一次改掉几十上百个点。
 */
export const STATIC_MAX_CHANGED_CELLS = 2

export interface FrameDigest {
  width: number
  height: number
  /** 长度 DIGEST_COLS × DIGEST_ROWS 的灰度采样。 */
  cells: Uint8Array
}

/**
 * 把一帧压成指纹：按固定网格点采样灰度（不做滤波，卡死判定要的就是「像素级一模一样」）。
 * ★ 缓冲区短了 / 尺寸非法时返回全 0 指纹，**绝不抛异常** —— 它在调度器的同步钩子里跑，抛了会连累采样。
 */
export function frameDigest(raw: RawFrame): FrameDigest {
  const cells = new Uint8Array(DIGEST_COLS * DIGEST_ROWS)
  const { width, height, data } = raw
  if (!(width > 0) || !(height > 0) || !data || data.byteLength < width * height * 4) {
    return { width, height, cells }
  }
  for (let j = 0; j < DIGEST_ROWS; j++) {
    const y = Math.min(height - 1, Math.floor(((j + 0.5) * height) / DIGEST_ROWS))
    for (let i = 0; i < DIGEST_COLS; i++) {
      const x = Math.min(width - 1, Math.floor(((i + 0.5) * width) / DIGEST_COLS))
      const o = (y * width + x) * 4
      // BT.601 整数近似：(77R + 150G + 29B) / 256
      cells[j * DIGEST_COLS + i] = (data[o]! * 77 + data[o + 1]! * 150 + data[o + 2]! * 29) >> 8
    }
  }
  return { width, height, cells }
}

/** 两个指纹之间「变了」的采样点数。尺寸不同（分辨率变了）视为全变。 */
export function digestDelta(a: FrameDigest, b: FrameDigest): number {
  if (a.width !== b.width || a.height !== b.height) return a.cells.length
  let changed = 0
  for (let i = 0; i < a.cells.length; i++) {
    const d = a.cells[i]! - b.cells[i]!
    if (d > CELL_DIFF_TOLERANCE || d < -CELL_DIFF_TOLERANCE) changed++
  }
  return changed
}

/** 两帧是不是「纹丝不动」。恢复流程等主界面时也用它判画面有没有在动。 */
export function framesLookIdentical(a: FrameDigest, b: FrameDigest): boolean {
  return digestDelta(a, b) <= STATIC_MAX_CHANGED_CELLS
}

// ── 判定 ──────────────────────────────────────────────────────────────────

/** 采样已连续失败时的「降档」门槛：失败期间画面一直没变就够了，不用等满 freezeMinutes。 */
export const SAMPLE_FAIL_MIN_STATIC_MS = 60_000
export const SAMPLE_FAIL_MIN_STATIC_FRAMES = 3
export const SAMPLE_FAIL_MIN_CAPTURE_FAILURES = 2
/** 完整阈值路径至少要看到几帧相同（一帧说明不了任何事）。 */
export const FULL_MIN_STATIC_FRAMES = 2
export const FULL_MIN_CAPTURE_FAILURES = 2

/** 看门狗要的那几个阈值（告警配置 AlertDetectConfig 的子集，单一默认值在助手的 shared/alerts.ts）。 */
export interface FreezeGuardConfig {
  /** 画面连续多少分钟纹丝不动判定为卡死。 */
  freezeMinutes: number
  /** 窗口期内最多自动重启几次。 */
  freezeRestartLimit: number
  /** 上一条的统计窗口（分钟）。 */
  freezeRestartWindowMin: number
}

export interface FreezeVerdict {
  /** static = 画面纹丝不动；capture = 截图一直失败。 */
  kind: 'static' | 'capture'
  /** 这种状态持续了多久。 */
  sinceMs: number
  /** 相同的帧数 / 连续失败次数。 */
  count: number
  /** 中文原因，直接进告警 reason。 */
  reason: string
}

export interface FreezeEvidence {
  /** 当前静止段持续了多久（还没看到第二帧时为 0）。 */
  staticForMs: number
  staticFrames: number
  lastFrameAt: number | null
  lastChangeAt: number | null
  captureFailures: number
  captureFailingForMs: number
  lastCaptureError: string | null
}

export interface RestartBudget {
  allowed: boolean
  /** 窗口期内已经重启过几次。 */
  used: number
  limit: number
  windowMin: number
}

export interface FreezeGuardDeps {
  /** 现取阈值 —— 用户在设置页改完立刻生效。 */
  config(): FreezeGuardConfig
  log?(level: 'debug' | 'info' | 'warn' | 'error', message: string): void
  /** 可注入的时钟，便于离线自检。 */
  now?(): number
}

interface Track {
  digest: FrameDigest | null
  /** 当前静止段的起点（这一段里每一帧都与上一帧相同）。 */
  staticSince: number
  staticFrames: number
  lastFrameAt: number | null
  lastChangeAt: number | null
  /** 连续截图失败次数与首次失败时刻；截到一帧就清零。 */
  failStreak: number
  failingSince: number | null
  lastFailure: string | null
  /** 自动重启的时刻，滑动窗口熔断用。 */
  restarts: number[]
}

function emptyTrack(): Track {
  return {
    digest: null,
    staticSince: 0,
    staticFrames: 0,
    lastFrameAt: null,
    lastChangeAt: null,
    failStreak: 0,
    failingSince: null,
    lastFailure: null,
    restarts: []
  }
}

function minutes(ms: number): string {
  const m = ms / 60_000
  return m >= 10 ? String(Math.round(m)) : m.toFixed(1).replace(/\.0$/, '')
}

/** 按实例编号（整台模拟器，而不是某个游戏）记账：重启影响的是整台模拟器。 */
export class FreezeGuard {
  private readonly tracks = new Map<number, Track>()

  constructor(private readonly deps: FreezeGuardDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  private of(index: number): Track {
    let t = this.tracks.get(index)
    if (!t) {
      t = emptyTrack()
      this.tracks.set(index, t)
    }
    return t
  }

  /**
   * 通报一帧。返回这一帧相对上一帧有没有变化，以及静止段的长度。
   * ★ 只比对上一帧：中间隔了多久不重要，只要两帧不同就说明画面活着。
   */
  observe(
    index: number,
    raw: RawFrame,
    at: number = this.now()
  ): { changed: boolean; staticForMs: number } {
    const t = this.of(index)
    const digest = frameDigest(raw)
    // 截到帧了，「截图失败」那条线就断了。
    t.failStreak = 0
    t.failingSince = null
    t.lastFrameAt = at

    if (!t.digest) {
      t.digest = digest
      t.staticSince = at
      t.staticFrames = 1
      return { changed: true, staticForMs: 0 }
    }
    const changed = !framesLookIdentical(t.digest, digest)
    t.digest = digest
    if (changed) {
      t.staticSince = at
      t.staticFrames = 1
      t.lastChangeAt = at
      return { changed: true, staticForMs: 0 }
    }
    t.staticFrames += 1
    return { changed: false, staticForMs: at - t.staticSince }
  }

  /** 截图失败（超时 / 设备离线 / 取不到设备）。不碰画面计时 —— 截不到不代表变了。 */
  noteCaptureFailed(index: number, message: string, at: number = this.now()): void {
    const t = this.of(index)
    t.failStreak += 1
    t.failingSince ??= at
    t.lastFailure = message
  }

  /** 排障 / 自检用：当前攒到的证据。 */
  evidence(index: number, at: number = this.now()): FreezeEvidence {
    const t = this.tracks.get(index)
    if (!t) {
      return {
        staticForMs: 0,
        staticFrames: 0,
        lastFrameAt: null,
        lastChangeAt: null,
        captureFailures: 0,
        captureFailingForMs: 0,
        lastCaptureError: null
      }
    }
    return {
      staticForMs: t.digest && t.staticFrames >= 2 ? at - t.staticSince : 0,
      staticFrames: t.staticFrames,
      lastFrameAt: t.lastFrameAt,
      lastChangeAt: t.lastChangeAt,
      captureFailures: t.failStreak,
      captureFailingForMs: t.failingSince === null ? 0 : at - t.failingSince,
      lastCaptureError: t.lastFailure
    }
  }

  /**
   * 完整阈值判定（健康探针路径）：
   *   画面相同 ≥ 2 帧且跨度 ≥ freezeMinutes，或截图连续失败 ≥ 2 次且持续 ≥ freezeMinutes。
   */
  assess(index: number, at: number = this.now()): FreezeVerdict | null {
    const thresholdMs = Math.max(1, this.deps.config().freezeMinutes) * 60_000
    return this.judge(index, at, {
      staticMs: thresholdMs,
      staticFrames: FULL_MIN_STATIC_FRAMES,
      captureMs: thresholdMs,
      captureFailures: FULL_MIN_CAPTURE_FAILURES
    })
  }

  /**
   * 降档判定（采样已连续失败、马上要按「掉线」暂停时）：
   *   失败期间画面一直没变（≥ 3 帧、≥ 60s），或截图连续失败 ≥ 2 次 —— 这不是掉线，是卡死。
   */
  assessAfterFailures(index: number, at: number = this.now()): FreezeVerdict | null {
    return this.judge(index, at, {
      staticMs: SAMPLE_FAIL_MIN_STATIC_MS,
      staticFrames: SAMPLE_FAIL_MIN_STATIC_FRAMES,
      captureMs: 0,
      captureFailures: SAMPLE_FAIL_MIN_CAPTURE_FAILURES
    })
  }

  private judge(
    index: number,
    at: number,
    gate: { staticMs: number; staticFrames: number; captureMs: number; captureFailures: number }
  ): FreezeVerdict | null {
    const t = this.tracks.get(index)
    if (!t) return null
    if (t.digest && t.staticFrames >= gate.staticFrames) {
      const sinceMs = at - t.staticSince
      if (sinceMs >= gate.staticMs) {
        return {
          kind: 'static',
          sinceMs,
          count: t.staticFrames,
          reason: `画面已 ${minutes(sinceMs)} 分钟纹丝不动（期间截的 ${t.staticFrames} 张图一模一样）`
        }
      }
    }
    if (t.failStreak >= gate.captureFailures && t.failingSince !== null) {
      const sinceMs = at - t.failingSince
      if (sinceMs >= gate.captureMs) {
        return {
          kind: 'capture',
          sinceMs,
          count: t.failStreak,
          reason:
            `截图已连续失败 ${t.failStreak} 次、持续 ${minutes(sinceMs)} 分钟` +
            `（最后一次：${t.lastFailure ?? '原因未知'}）`
        }
      }
    }
    return null
  }

  // ── 重启熔断 ─────────────────────────────────────────────────────────────

  restartBudget(index: number, at: number = this.now()): RestartBudget {
    const cfg = this.deps.config()
    const limit = Math.max(1, cfg.freezeRestartLimit)
    const windowMin = Math.max(1, cfg.freezeRestartWindowMin)
    const t = this.of(index)
    const floor = at - windowMin * 60_000
    t.restarts = t.restarts.filter((x) => x > floor)
    return { allowed: t.restarts.length < limit, used: t.restarts.length, limit, windowMin }
  }

  /** 真的下发了一次重启之后调用（不管成没成功都算一次，失败的重启更该计数）。 */
  noteRestart(index: number, at: number = this.now()): void {
    this.of(index).restarts.push(at)
  }

  /** 恢复流程结束（或人工点「恢复」）后清掉画面计时与失败计数；重启记录**保留**，熔断要跨恢复生效。 */
  reset(index: number): void {
    const t = this.tracks.get(index)
    if (!t) return
    t.digest = null
    t.staticSince = 0
    t.staticFrames = 0
    t.lastFrameAt = null
    t.lastChangeAt = null
    t.failStreak = 0
    t.failingSince = null
    t.lastFailure = null
    this.deps.log?.('debug', `[卡死] 实例 ${index} 的画面计时已清零。`)
  }

  /** 实例被删 / 被替换（record.createdAt 变了）时整个忘掉，包括重启记录。 */
  forget(index: number): void {
    this.tracks.delete(index)
  }

  /** 见过的实例编号（面板展示证据用）。 */
  indices(): number[] {
    return [...this.tracks.keys()].sort((a, b) => a - b)
  }
}
