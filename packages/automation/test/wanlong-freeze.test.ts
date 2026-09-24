/**
 * Port of scripts/freeze-offline-check.ts sections 一 (frame fingerprint), 二 (watchdog gates on a virtual clock) and
 * 三 (the recovery flow in a fake world where sleep only advances time). Section 四 (scheduler wiring) lives in the
 * assistant's tests (eta-scheduler.test.ts and freeze-controller.test.ts). No emulator, no adb.
 */
import { describe, expect, it } from 'vitest';
import type { RawFrame } from '../src/index.js';
import { AppError } from '../src/errors.js';
import {
  DIGEST_COLS, DIGEST_ROWS, FREEZE_RECOVERY_DEFAULTS, FreezeGuard, SAMPLE_FAIL_MIN_STATIC_MS, STATIC_MAX_CHANGED_CELLS,
  digestDelta, frameDigest, framesLookIdentical, recoverFrozenInstance,
  type FreezeGuardConfig, type FreezeRecoveryIo, type FreezeRecoveryResult, type InstanceProbe,
} from '../src/wanlong/index.js';

const MIN = 60_000;
const W = 640;
const H = 360;
const PKG = 'com.lilithgames.samo.android.cn';
const LAUNCHER = 'com.android.launcher3';
/** The assistant's defaults (shared/alerts.ts defaultAlertDetectConfig): 5 minutes, 3 restarts per 60 minutes. */
const defaults = (): FreezeGuardConfig => ({ freezeMinutes: 5, freezeRestartLimit: 3, freezeRestartWindowMin: 60 });

function makeFrame(seed = 1): RawFrame {
  const data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      data[o] = (x * 3 + seed * 17) & 255;
      data[o + 1] = (y * 5 + seed * 31) & 255;
      data[o + 2] = ((x ^ y) + seed * 7) & 255;
      data[o + 3] = 255;
    }
  }
  return { width: W, height: H, format: 1, data, capturedAt: 0 };
}

function cloneFrame(f: RawFrame): RawFrame {
  return { ...f, data: new Uint8Array(f.data) };
}

/** Change a block's colour (a widget that moves). */
function paint(f: RawFrame, x0: number, y0: number, w: number, h: number, delta: number): RawFrame {
  const g = cloneFrame(f);
  for (let y = y0; y < Math.min(H, y0 + h); y++) {
    for (let x = x0; x < Math.min(W, x0 + w); x++) {
      const o = (y * W + x) * 4;
      g.data[o] = Math.min(255, g.data[o]! + delta);
      g.data[o + 1] = Math.min(255, g.data[o + 1]! + delta);
      g.data[o + 2] = Math.min(255, g.data[o + 2]! + delta);
    }
  }
  return g;
}

function samplePoint(i: number, j: number): { x: number; y: number } {
  return { x: Math.floor(((i + 0.5) * W) / DIGEST_COLS), y: Math.floor(((j + 0.5) * H) / DIGEST_ROWS) };
}

describe('一、帧指纹：一模一样才算「纹丝不动」', () => {
  const A = makeFrame(1);
  const dA = frameDigest(A);

  it('is a 96×54 grey grid and a copy of the same frame changes nothing', () => {
    expect(dA.cells.length).toBe(DIGEST_COLS * DIGEST_ROWS);
    expect(digestDelta(dA, frameDigest(cloneFrame(A)))).toBe(0);
  });

  it('★ a 60×40 ticking digit block counts as moving', () => {
    const ticking = frameDigest(paint(A, 100, 100, 60, 40, 90));
    expect(digestDelta(dA, ticking)).toBeGreaterThan(STATIC_MAX_CHANGED_CELLS);
    expect(framesLookIdentical(dA, ticking)).toBe(false);
  });

  it('one sampled pixel jitter is still static (tolerance of 2 cells)', () => {
    const p = samplePoint(48, 27);
    const onePixel = frameDigest(paint(A, p.x, p.y, 1, 1, 200));
    expect(digestDelta(dA, onePixel)).toBe(1);
    expect(framesLookIdentical(dA, onePixel)).toBe(true);
  });

  it('a whole-screen +4 shade is still static; +20 changes almost every cell', () => {
    expect(digestDelta(dA, frameDigest(paint(A, 0, 0, W, H, 4)))).toBe(0);
    expect(digestDelta(dA, frameDigest(paint(A, 0, 0, W, H, 20)))).toBeGreaterThan(dA.cells.length * 0.9);
  });

  it('two different frames differ; a resolution change counts as every cell changed', () => {
    expect(framesLookIdentical(dA, frameDigest(makeFrame(2)))).toBe(false);
    const small: RawFrame = { ...makeFrame(1), width: 320, height: 180, data: makeFrame(1).data.subarray(0, 320 * 180 * 4) };
    expect(digestDelta(dA, frameDigest(small))).toBe(dA.cells.length);
  });

  it('never throws on a short or malformed buffer (the hook is synchronous and must not break sampling)', () => {
    const broken = { width: 100, height: 100, data: new Uint8Array(10), capturedAt: 0 } as RawFrame;
    expect(() => frameDigest(broken)).not.toThrow();
    expect(frameDigest(broken).cells.every((v) => v === 0)).toBe(true);
    expect(() => frameDigest({ width: 0, height: 0, data: new Uint8Array(0), capturedAt: 0 })).not.toThrow();
  });
});

describe('二、看门狗判定（虚拟时钟，默认 5 分钟 / 60 分钟内最多 3 次）', () => {
  let clock = 10 * MIN;
  const cfg = defaults();
  const logs: string[] = [];
  const guard = new FreezeGuard({ config: () => cfg, log: (_l, m) => logs.push(m), now: () => clock });
  const F = makeFrame(1);
  const G = makeFrame(2);

  it('full gate: health probe every 3 minutes, 2+ identical frames spanning ≥ 5 minutes', () => {
    expect(guard.observe(0, F).changed).toBe(true);
    expect(guard.assess(0)).toBeNull();
    clock += 3 * MIN;
    expect(guard.observe(0, F)).toEqual({ changed: false, staticForMs: 3 * MIN });
    expect(guard.assess(0)).toBeNull();
    clock += 3 * MIN;
    guard.observe(0, F);
    const v = guard.assess(0);
    expect(v?.kind).toBe('static');
    expect(v?.count).toBe(3);
    expect(v?.reason).toContain('分钟纹丝不动');
    expect(v?.reason).toContain('3 张图');
  });

  it('a change resets the static segment; evidence shows duration and the last change', () => {
    clock += MIN;
    expect(guard.observe(0, G).changed).toBe(true);
    expect(guard.assess(0)).toBeNull();
    clock += 3 * MIN;
    guard.observe(0, G);
    expect(guard.assess(0)).toBeNull();
    expect(guard.evidence(0).staticForMs).toBe(3 * MIN);
    expect(guard.evidence(0).lastChangeAt).toBe(clock - 3 * MIN);
  });

  it('degraded gate (samples already failing): 3 identical frames over 80 s is enough, the full gate is not', () => {
    clock = 100 * MIN;
    guard.observe(1, F);
    clock += 20_000;
    guard.observe(1, F);
    expect(guard.assessAfterFailures(1)).toBeNull();
    clock += SAMPLE_FAIL_MIN_STATIC_MS;
    guard.observe(1, F);
    const v1 = guard.assessAfterFailures(1);
    expect(v1?.kind).toBe('static');
    expect(v1?.count).toBe(3);
    expect(guard.assess(1)).toBeNull();
  });

  it('capture failures: 2 in a row trip the degraded gate with the last error; the full gate needs 5 minutes', () => {
    clock = 200 * MIN;
    guard.noteCaptureFailed(2, 'adb 命令超时');
    expect(guard.assessAfterFailures(2)).toBeNull();
    clock += 30_000;
    guard.noteCaptureFailed(2, 'adb 命令超时（已超过 30000ms）');
    const v2 = guard.assessAfterFailures(2);
    expect(v2?.kind).toBe('capture');
    expect(v2?.count).toBe(2);
    expect(v2?.reason).toContain('30000ms');
    expect(guard.assess(2)).toBeNull();
    clock += 5 * MIN;
    guard.noteCaptureFailed(2, 'adb 命令超时');
    expect(guard.assess(2)?.kind).toBe('capture');
    expect(guard.evidence(2).lastCaptureError).toBe('adb 命令超时');
    guard.observe(2, F);
    expect(guard.evidence(2).captureFailures).toBe(0);
    expect(guard.assessAfterFailures(2)).toBeNull();
  });

  it('★ restart circuit breaker: 3 restarts in 60 minutes trip it; the oldest slides out after 61 minutes', () => {
    clock = 300 * MIN;
    let b = guard.restartBudget(3);
    expect(b).toEqual({ allowed: true, used: 0, limit: 3, windowMin: 60 });
    guard.noteRestart(3);
    clock += 5 * MIN;
    guard.noteRestart(3);
    clock += 5 * MIN;
    guard.noteRestart(3);
    b = guard.restartBudget(3);
    expect(b.allowed).toBe(false);
    expect(b.used).toBe(3);
    clock += 51 * MIN;
    b = guard.restartBudget(3);
    expect(b.allowed).toBe(true);
    expect(b.used).toBe(2);
  });

  it('reset clears picture timing and failures but keeps the restart history', () => {
    guard.observe(3, F);
    clock += 6 * MIN;
    guard.observe(3, F);
    guard.noteCaptureFailed(3, 'x');
    expect(guard.evidence(3).staticFrames).toBe(2);
    guard.reset(3);
    const e3 = guard.evidence(3);
    expect(e3.staticFrames).toBe(0);
    expect(e3.captureFailures).toBe(0);
    expect(guard.assess(3)).toBeNull();
    // Six more minutes passed: only the last of the three restarts (minute 310) is still inside the window.
    expect(guard.restartBudget(3).used).toBe(1);
    expect(logs.some((line) => line.includes('画面计时已清零'))).toBe(true);
  });

  it('★ config is read live: 5 → 2 minutes decides at once, a limit of 1 trips after one restart', () => {
    clock = 400 * MIN;
    guard.observe(4, F);
    clock += 3 * MIN;
    guard.observe(4, F);
    expect(guard.assess(4)).toBeNull();
    cfg.freezeMinutes = 2;
    expect(guard.assess(4)?.kind).toBe('static');
    cfg.freezeMinutes = 5;
    cfg.freezeRestartLimit = 1;
    guard.noteRestart(4);
    expect(guard.restartBudget(4).allowed).toBe(false);
    cfg.freezeRestartLimit = 3;
  });

  it('an unknown instance has no verdict and a full budget; forget drops the restart history too', () => {
    expect(guard.assess(99)).toBeNull();
    expect(guard.restartBudget(99).allowed).toBe(true);
    guard.noteRestart(5);
    guard.forget(5);
    expect(guard.restartBudget(5).used).toBe(0);
  });
});

interface WorldOpts {
  restartThrows?: boolean;
  readyAfterMs?: number;
  silentRestart?: boolean;
  attachFailures?: number;
  bootAfterMs?: number;
  launchThrows?: boolean | number;
  foregroundAfterPolls?: number;
  recognizeAtFrame?: number;
  framesChange?: boolean;
  finalForegroundIsGame?: boolean;
  abortAfterSleeps?: number;
  abortBeforeStart?: boolean;
}

interface World {
  io: FreezeRecoveryIo;
  logs: string[];
  counters: { restarts: number; drops: number; attaches: number; launches: number; frames: number; sleeps: number };
  elapsedMs(): number;
}

function makeWorld(o: WorldOpts = {}): World {
  const opt = {
    readyAfterMs: 8_000, attachFailures: 1, bootAfterMs: 3_000, foregroundAfterPolls: 2, recognizeAtFrame: 3,
    framesChange: true, finalForegroundIsGame: true, ...o,
  };
  const t0 = 1_000_000;
  let clock = t0;
  let pid = 100;
  let androidStarted = true;
  let readyAt = -1;
  let attachedAt = -1;
  let launched = false;
  let fgPolls = 0;
  const base = makeFrame(1);
  const counters = { restarts: 0, drops: 0, attaches: 0, launches: 0, frames: 0, sleeps: 0 };
  const logs: string[] = [];
  const controller = new AbortController();
  if (opt.abortBeforeStart) controller.abort();
  const io: FreezeRecoveryIo = {
    restartInstance: async () => {
      if (opt.restartThrows) throw new AppError('ADMISSION_DENIED', '内存不足，拒绝启动实例（errcode 模拟）');
      counters.restarts += 1;
      if (opt.silentRestart) return;
      pid += 1;
      androidStarted = false;
      readyAt = opt.readyAfterMs === Infinity ? Infinity : clock + opt.readyAfterMs;
    },
    instanceState: async (): Promise<InstanceProbe | null> => {
      if (!opt.silentRestart && readyAt >= 0 && clock >= readyAt) androidStarted = true;
      return { processStarted: true, androidStarted, pid };
    },
    dropDevice: async () => { counters.drops += 1; },
    attachDevice: async () => {
      counters.attaches += 1;
      if (counters.attaches <= opt.attachFailures) throw new AppError('ADB_CONNECT_FAILED', '连接模拟器失败：connection refused');
      attachedAt = clock;
      return 'emulator-5556';
    },
    isBooted: async () => opt.bootAfterMs !== Infinity && attachedAt >= 0 && clock >= attachedAt + opt.bootAfterMs,
    foreground: async () => {
      if (!launched) return LAUNCHER;
      fgPolls += 1;
      if (fgPolls < opt.foregroundAfterPolls) return LAUNCHER;
      if (!opt.finalForegroundIsGame && counters.frames > 0) return LAUNCHER;
      return PKG;
    },
    launchGame: async () => {
      counters.launches += 1;
      const throws = opt.launchThrows === true || (typeof opt.launchThrows === 'number' && counters.launches <= opt.launchThrows);
      if (throws) throw new AppError('ADB_COMMAND_FAILED', 'monkey: No activities found to run');
      launched = true;
    },
    isGameRunning: async () => launched,
    capture: async () => {
      counters.frames += 1;
      return opt.framesChange ? makeFrame(counters.frames) : base;
    },
    recognize: async () => counters.frames >= opt.recognizeAtFrame,
    log: (level, message) => logs.push(`${level}:${message}`),
    sleep: async (ms) => {
      counters.sleeps += 1;
      clock += ms;
      if (opt.abortAfterSleeps !== undefined && counters.sleeps >= opt.abortAfterSleeps) controller.abort();
    },
    now: () => clock,
    signal: controller.signal,
  };
  return { io, logs, counters, elapsedMs: () => clock - t0 };
}

async function recover(o: WorldOpts = {}): Promise<{ r: FreezeRecoveryResult; w: World }> {
  const w = makeWorld(o);
  const r = await recoverFrozenInstance(w.io, { gamePackage: PKG });
  return { r, w };
}

describe('三、恢复流程：重启 → 等 Android → 重连 adb → 等开机 → monkey 拉起 → 等主界面（虚拟时钟）', () => {
  it('★ the normal chain recovers with the main screen recognised', async () => {
    const { r, w } = await recover();
    expect(r).toMatchObject({ ok: true, loaded: true, stage: 'done', reason: null });
    expect(r.steps).toHaveLength(6);
    expect(r.steps[0]).toBe('重启模拟器');
    expect(r.steps.at(-1)).toBe('主界面已认出');
    expect(w.counters.restarts).toBe(1);
    expect(w.counters.drops).toBe(1);
    expect(w.counters.attaches).toBe(2);
    expect(w.counters.launches).toBe(1);
    expect(r.steps).toContain('已用 monkey 拉起游戏');
    expect(r.serial).toBe('emulator-5556');
    expect(r.elapsedMs).toBeLessThan(120_000);
    expect(w.elapsedMs()).toBe(r.elapsedMs);
    expect(w.logs.some((line) => line.includes('没观察到实例状态变化'))).toBe(false);
  });

  it('a failing restart fails at stage restart with the Chinese reason', async () => {
    const { r } = await recover({ restartThrows: true });
    expect(r.ok).toBe(false);
    expect(r.stage).toBe('restart');
    expect(r.reason).toContain('errcode');
  });

  it('Android never ready → androidReady after the full timeout, naming the state', async () => {
    const { r, w } = await recover({ readyAfterMs: Infinity });
    expect(r.ok).toBe(false);
    expect(r.stage).toBe('androidReady');
    expect(w.elapsedMs()).toBeGreaterThanOrEqual(FREEZE_RECOVERY_DEFAULTS.androidReadyTimeoutMs);
    expect(r.reason).toContain('尚未启动完成');
  });

  it('adb never attaches → stage adb after retries, with the last error', async () => {
    const { r, w } = await recover({ attachFailures: Infinity });
    expect(r.ok).toBe(false);
    expect(r.stage).toBe('adb');
    expect(w.counters.attaches).toBeGreaterThan(5);
    expect(r.reason).toContain('connection refused');
  });

  it('boot never completes → stage boot', async () => {
    const { r } = await recover({ bootAfterMs: Infinity });
    expect(r.ok).toBe(false);
    expect(r.stage).toBe('boot');
  });

  it('launch always failing retries once then fails at launch; the second launch succeeding still recovers', async () => {
    const failing = await recover({ launchThrows: true });
    expect(failing.r).toMatchObject({ ok: false, stage: 'launch' });
    expect(failing.w.counters.launches).toBe(2);
    const second = await recover({ launchThrows: 1 });
    expect(second.r).toMatchObject({ ok: true, loaded: true });
    expect(second.w.counters.launches).toBe(2);
  });

  it('the foreground never becoming the game fails at launch', async () => {
    const { r } = await recover({ foregroundAfterPolls: Infinity });
    expect(r).toMatchObject({ ok: false, stage: 'launch' });
  });

  it('★ UI not recognised but the game in front: ok with loaded=false (moving / not moving noted)', async () => {
    const moving = await recover({ recognizeAtFrame: Infinity, framesChange: true });
    expect(moving.r).toMatchObject({ ok: true, loaded: false });
    expect(moving.r.steps.some((s) => s.includes('画面在动'))).toBe(true);
    const still = await recover({ recognizeAtFrame: Infinity, framesChange: false });
    expect(still.r).toMatchObject({ ok: true, loaded: false });
    expect(still.r.steps.some((s) => s.includes('没变化'))).toBe(true);
  });

  it('UI not recognised and the foreground no longer the game: fails at load naming the launcher', async () => {
    const { r } = await recover({ recognizeAtFrame: Infinity, finalForegroundIsGame: false });
    expect(r).toMatchObject({ ok: false, stage: 'load' });
    expect(r.reason).toContain(LAUNCHER);
  });

  it('a silent restart logs a warning after the observe window and still recovers', async () => {
    const { r, w } = await recover({ silentRestart: true });
    expect(r.ok).toBe(true);
    expect(w.logs.some((line) => line.includes('没观察到实例状态变化'))).toBe(true);
    expect(w.elapsedMs()).toBeGreaterThanOrEqual(FREEZE_RECOVERY_DEFAULTS.restartObserveMs);
  });

  it('aborted before the start throws RUN_ABORTED without doing anything', async () => {
    const w = makeWorld({ abortBeforeStart: true });
    await expect(recoverFrozenInstance(w.io, { gamePackage: PKG })).rejects.toMatchObject({ code: 'RUN_ABORTED' });
    expect(w.counters.restarts).toBe(0);
  });

  it('★ aborted midway (app quitting) throws RUN_ABORTED at once instead of waiting on', async () => {
    const w = makeWorld({ abortAfterSleeps: 3 });
    await expect(recoverFrozenInstance(w.io, { gamePackage: PKG })).rejects.toMatchObject({ code: 'RUN_ABORTED' });
    expect(w.counters.sleeps).toBe(3);
  });
});
