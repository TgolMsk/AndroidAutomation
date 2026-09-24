/**
 * Port of the original `scripts/freeze-offline-check.ts` section 四 (wiring with the real scheduler) and of the
 * freeze branch of `tryFreezeRecovery()` in the original `src/main/index.ts`: the two triggers, the opt-in restart
 * (DECISIONS A.3), the circuit breaker, `exclusive()` re-entry from inside the lock, aborting, and the @avdm/core
 * adapter. Virtual clock, fake ports: no emulator, no adb.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawFrame } from '@avdm/automation';
import type { FreezeRecoveryResult, recoverFrozenInstance } from '@avdm/automation/wanlong';
import { defaultAlertsConfig, type AlertDetectConfig, type AlertEvent } from '../src/shared/alerts';
import { FreezeController, type FreezeControllerPorts } from '../src/main/alerts/freeze-controller';
import { createAvdFreezeRecoveryIo, type FreezeDevice, type FreezeManager } from '../src/main/alerts/freeze-io';
import { SchedulerError } from '../src/main/scheduler/errors';
import { InstanceLocks } from '../src/main/scheduler/instance-lock';
import { EtaScheduler } from '../src/main/scheduler/service';

const MIN = 60_000;
const PKG = 'com.lilithgames.samo.android.cn';
const W = 192;
const H = 108;

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

function okResult(p: Partial<FreezeRecoveryResult> = {}): FreezeRecoveryResult {
  return { ok: true, loaded: true, stage: 'done', reason: null, steps: ['重启实例', '重连 adb', 'monkey 拉起游戏', '主界面已认出'], elapsedMs: 95_000, serial: 'emulator-5554', ...p } as FreezeRecoveryResult;
}

interface World {
  controller: FreezeController;
  raised: AlertEvent[];
  shots: string[];
  exclusive: Array<{ index: number; what: string }>;
  resetFailures: number[];
  recover: ReturnType<typeof vi.fn>;
  cfg: AlertDetectConfig;
  alive: { alive: boolean; status: string; identity?: string | null };
  paused: Set<number>;
  clock: { now: number };
  logs: string[];
}

function makeWorld(over: Partial<FreezeControllerPorts> = {}, cfg: Partial<AlertDetectConfig> = {}): World {
  const world = {
    raised: [] as AlertEvent[], shots: [] as string[], exclusive: [] as Array<{ index: number; what: string }>,
    resetFailures: [] as number[], cfg: { ...defaultAlertsConfig().detect, ...cfg },
    alive: { alive: true, status: 'running', identity: 'avd-a' as string | null }, paused: new Set<number>(),
    clock: { now: 10 * MIN }, logs: [] as string[],
    recover: vi.fn(async () => okResult()),
  } as Omit<World, 'controller'>;
  const controller = new FreezeController({
    config: () => world.cfg,
    isPaused: (index) => world.paused.has(index),
    instanceAlive: async () => world.alive,
    exclusive: async (index, what, fn, signal) => {
      world.exclusive.push({ index, what });
      return fn({ signal: signal ?? new AbortController().signal });
    },
    recoveryIo: () => ({}) as never,
    saveShot: async (index, label) => { const shot = `automation/wanlong/shots/inst${index}-${label}-1.jpg`; world.shots.push(shot); return shot; },
    raise: async (event) => { world.raised.push(event); },
    resetFailures: (index) => world.resetFailures.push(index),
    log: (level, message) => world.logs.push(`[${level}] ${message}`),
    gamePackage: PKG,
    now: () => world.clock.now,
    recover: world.recover as unknown as typeof recoverFrozenInstance,
    ...over,
  });
  // The same object the ports read (tests reassign `alive` / `cfg` on it).
  return Object.assign(world, { controller });
}

/** Feed identical frames every 3 minutes: after the third one the picture stood still for 6 minutes. */
function freeze(world: World, index = 0, frames = 3): void {
  const frame = makeFrame(1);
  for (let i = 0; i < frames; i += 1) {
    if (i > 0) world.clock.now += 3 * MIN;
    world.controller.onFrame(index, frame);
  }
}

describe('FreezeController: the health-probe trigger (full threshold)', () => {
  it('does nothing while the picture moves or the threshold is not reached', async () => {
    const world = makeWorld();
    world.controller.onFrame(0, makeFrame(1));
    world.clock.now += 3 * MIN;
    world.controller.onFrame(0, makeFrame(1));
    expect(await world.controller.tryRecover(0, '健康探针', undefined, true)).toEqual({ outcome: 'skipped' });
    world.clock.now += 3 * MIN;
    world.controller.onFrame(0, makeFrame(2));
    expect(await world.controller.tryRecover(0, '健康探针', undefined, true)).toEqual({ outcome: 'skipped' });
    expect(world.raised).toEqual([]);
  });

  it('★ auto restart off (default, DECISIONS A.3): 「疑似模拟器卡死」 once per frozen stretch, the emulator untouched', async () => {
    const world = makeWorld();
    expect(world.cfg.freezeRestartEnabled).toBe(false);
    freeze(world);
    const first = await world.controller.tryRecover(0, '健康探针', undefined, true);
    expect(first.outcome).toBe('detected');
    expect(world.raised).toHaveLength(1);
    expect(world.raised[0]).toMatchObject({ type: 'suspectedFreeze', severity: 'warning', shotPath: 'automation/wanlong/shots/inst0-frozen-1.jpg' });
    expect(world.raised[0]!.reason).toContain('纹丝不动');
    world.clock.now += 3 * MIN;
    world.controller.onFrame(0, makeFrame(1));
    await world.controller.tryRecover(0, '健康探针', undefined, true);
    expect(world.raised).toHaveLength(1);
    expect(world.recover).not.toHaveBeenCalled();
    expect(world.exclusive).toEqual([]);
  });

  it('auto restart on: restarts inside exclusive(), counts the restart, raises 「已自动重启」 and resets the counters', async () => {
    const world = makeWorld({}, { freezeRestartEnabled: true });
    freeze(world);
    const attempt = await world.controller.tryRecover(0, '健康探针', undefined, true);
    expect(attempt).toEqual({ outcome: 'recovered' });
    expect(world.exclusive).toEqual([{ index: 0, what: '卡死重启' }]);
    expect(world.recover).toHaveBeenCalledWith(expect.anything(), { gamePackage: PKG });
    expect(world.resetFailures).toEqual([0]);
    expect(world.raised).toHaveLength(1);
    expect(world.raised[0]).toMatchObject({ type: 'emulatorFrozen', detail: { 触发: '健康探针', 主界面: '已认出', 本窗口重启次数: '1/3' } });
    expect(world.raised[0]!.reason).toContain('耗时 95s');
    expect(world.shots).toEqual(['automation/wanlong/shots/inst0-frozen-1.jpg']);
    expect(world.controller.status()[0]).toMatchObject({ index: 0, restartsUsed: 1, restartLimit: 3, recovering: false });
    // The picture timing starts over after a restart.
    expect(await world.controller.tryRecover(0, '健康探针', undefined, true)).toEqual({ outcome: 'skipped' });
  });

  it('a failed restart still counts, pauses as offline naming the stage, and the breaker stops the next one', async () => {
    const world = makeWorld({}, { freezeRestartEnabled: true, freezeRestartLimit: 1 });
    world.recover.mockResolvedValueOnce(okResult({ ok: false, loaded: false, stage: 'launch', reason: '游戏拉不起来' }));
    freeze(world);
    const attempt = await world.controller.tryRecover(0, '健康探针', undefined, true);
    expect(attempt.outcome).toBe('failed');
    expect(world.raised.at(-1)).toMatchObject({ type: 'deviceOffline', detail: { 判定: '卡死' } });
    expect(world.raised.at(-1)!.reason).toContain('游戏拉不起来');
    expect(world.controller.status()[0]?.restartsUsed).toBe(1);

    freeze(world, 0, 3);
    const tripped = await world.controller.tryRecover(0, '健康探针', undefined, true);
    expect(tripped.outcome).toBe('failed');
    expect(tripped.outcome === 'failed' && tripped.note).toContain('上限 1');
    expect(world.recover).toHaveBeenCalledTimes(1);
    expect(world.raised.filter((event) => event.type === 'deviceOffline')).toHaveLength(2);
  });

  it('a thrown recovery error is a failure too; an abort (auto off / quitting) is not', async () => {
    const world = makeWorld({}, { freezeRestartEnabled: true });
    world.recover.mockRejectedValueOnce(new Error('管理器没响应'));
    freeze(world);
    const failed = await world.controller.tryRecover(0, '健康探针', undefined, true);
    expect(failed.outcome === 'failed' && failed.note).toContain('管理器没响应');

    freeze(world, 1);
    world.recover.mockRejectedValueOnce(new SchedulerError('RUN_ABORTED', '已中止'));
    expect(await world.controller.tryRecover(1, '健康探针', undefined, true)).toEqual({ outcome: 'skipped' });
    expect(world.raised.filter((event) => event.instanceIndex === 1)).toEqual([]);
  });

  it('dispose() aborts a recovery in flight (quitting never waits minutes); the restart still counts', async () => {
    let seen: AbortSignal | undefined;
    const world = makeWorld({
      exclusive: async (_index, _what, fn, signal) => { seen = signal; return fn({ signal: signal ?? new AbortController().signal }); },
    }, { freezeRestartEnabled: true });
    world.recover.mockImplementationOnce(() => new Promise<FreezeRecoveryResult>((_resolve, reject) => {
      seen?.addEventListener('abort', () => reject(new SchedulerError('RUN_ABORTED', '助手正在退出')));
    }));
    freeze(world);
    const pending = world.controller.tryRecover(0, '健康探针', undefined, true);
    await vi.waitFor(() => expect(world.controller.isRecovering(0)).toBe(true));
    world.controller.dispose();
    expect(await pending).toEqual({ outcome: 'skipped' });
    expect(world.controller.isRecovering(0)).toBe(false);
    expect(world.controller.status()[0]?.restartsUsed).toBe(1);
    expect(world.raised).toEqual([]);
  });

  it('skips a paused instance, a dead emulator and a recreated AVD (whose restart history is forgotten)', async () => {
    const world = makeWorld({}, { freezeRestartEnabled: true });
    freeze(world);
    world.paused.add(0);
    expect(await world.controller.tryRecover(0, '健康探针', undefined, true)).toEqual({ outcome: 'skipped' });
    world.paused.clear();
    world.alive = { alive: false, status: 'stopped', identity: 'avd-a' };
    expect(await world.controller.tryRecover(0, '健康探针', undefined, true)).toEqual({ outcome: 'skipped' });
    world.alive = { alive: true, status: 'running', identity: 'avd-b' };
    expect(await world.controller.tryRecover(0, '健康探针', undefined, true)).toEqual({ outcome: 'skipped' });
    expect(world.controller.status()).toEqual([]);
    expect(world.recover).not.toHaveBeenCalled();
  });
});

describe('FreezeController: the 「samples keep failing」 trigger (degraded gate)', () => {
  it('two capture failures 30 s apart are enough; auto restart off returns a note for the offline alert without raising', async () => {
    const world = makeWorld();
    world.controller.onCaptureFailed(0, 'adb 命令超时');
    world.clock.now += 30_000;
    world.controller.onCaptureFailed(0, 'adb 命令超时（已超过 30000ms）');
    const attempt = await world.controller.tryRecover(0, '连续采样失败', undefined, false);
    expect(attempt.outcome).toBe('detected');
    expect(attempt.outcome === 'detected' && attempt.note).toContain('没有开启「卡死自动重启」');
    expect(world.raised).toEqual([]);
  });

  it('with auto restart on, a failed restart leaves the offline alert to the caller (no double alert)', async () => {
    const world = makeWorld({}, { freezeRestartEnabled: true });
    world.recover.mockResolvedValueOnce(okResult({ ok: false, stage: 'boot', reason: '一直没开机' }));
    world.controller.onCaptureFailed(0, 'adb 命令超时');
    world.clock.now += 30_000;
    world.controller.onCaptureFailed(0, 'adb 命令超时');
    const attempt = await world.controller.tryRecover(0, '连续采样失败', undefined, false);
    expect(attempt.outcome === 'failed' && attempt.note).toContain('一直没开机');
    expect(world.raised).toEqual([]);
  });
});

describe('with the real scheduler (original section 四)', () => {
  let home: string;
  beforeEach(async () => { home = await mkdtemp(path.join(tmpdir(), 'avdm-freeze-')); });
  afterEach(async () => { await rm(home, { recursive: true, force: true }); });

  it('★ a recovery started inside the instance lock re-enters exclusive() instead of deadlocking', async () => {
    const scheduler = new EtaScheduler(home, {
      sample: async () => { throw new SchedulerError('TIMEOUT', 'ADB 截图超时'); },
      healthFrame: async () => { throw new SchedulerError('TIMEOUT', 'ADB 截图超时'); },
      instance: async () => ({ status: 'running', createdAt: '2026-09-01T00:00:00.000Z' }),
    }, { ownerLease: false, locks: new InstanceLocks(home, { fileLock: async (_path, fn) => fn() }), log: () => undefined });
    await scheduler.restore();
    const world = makeWorld({ exclusive: (index, what, fn, signal) => scheduler.exclusive(index, what, fn, signal) }, { freezeRestartEnabled: true });
    freeze(world);
    try {
      const attempt = await scheduler.exclusive(0, '健康探针', async () => {
        expect(scheduler.locks.held(0)).toBe(true);
        return world.controller.tryRecover(0, '健康探针', undefined, true);
      });
      expect(attempt).toEqual({ outcome: 'recovered' });
      expect(world.recover).toHaveBeenCalledTimes(1);
    } finally {
      await scheduler.dispose();
    }
  });
});

describe('createAvdFreezeRecoveryIo (@avdm/core adapter)', () => {
  function fakeManager() {
    const events: string[] = [];
    let status = 'running';
    let pid = 100;
    const device: FreezeDevice = {
      serial: 'emulator-5554',
      getState: async () => 'device',
      isBootCompleted: async () => true,
      foregroundPackage: async () => PKG,
      startApp: async (pkg) => { events.push(`startApp ${pkg}`); },
      isAppRunning: async () => true,
      screencapRaw: async () => makeFrame(1),
    };
    const manager: FreezeManager = {
      getState: async () => ({ status, pid }),
      stop: async (_index, opts) => { events.push(`stop force=${String(opts?.force)}`); status = 'stopped'; },
      start: async () => { events.push('start'); status = 'booting'; pid = 200; await new Promise(() => undefined); },
      device: async () => device,
    };
    return { manager, events, setStatus: (next: string) => { status = next; } };
  }

  it('restarts with a forced stop (cold boot) and does not wait for start() to finish booting', async () => {
    const { manager, events } = fakeManager();
    const dropped: number[] = [];
    const io = createAvdFreezeRecoveryIo({
      manager: async () => manager, index: 3, signal: new AbortController().signal, gamePackage: PKG,
      recognize: async () => true, dropLane: (index) => dropped.push(index), log: () => undefined, sleep: async () => undefined,
    });
    await io.restartInstance();
    expect(events).toEqual(['stop force=true', 'start']);
    expect(dropped).toEqual([3]);
    expect(await io.instanceState()).toEqual({ processStarted: true, androidStarted: false, pid: 200 });
    const serial = await io.attachDevice();
    expect(serial).toBe('emulator-5554');
    await io.launchGame(serial);
    expect(events.at(-1)).toBe(`startApp ${PKG}`);
    expect(await io.foreground(serial)).toBe(PKG);
    await io.dropDevice();
    await expect(io.isBooted(serial)).rejects.toThrow('已不可用');
  });

  it('surfaces a start() failure and refuses a bad package name', async () => {
    const { manager } = fakeManager();
    manager.start = async () => { throw new Error('端口冲突'); };
    const io = createAvdFreezeRecoveryIo({
      manager: async () => manager, index: 0, signal: new AbortController().signal, gamePackage: 'not a package',
      recognize: async () => true, log: () => undefined, sleep: async () => undefined,
    });
    await expect(io.restartInstance()).rejects.toThrow('端口冲突');
    const serial = await io.attachDevice();
    await expect(io.launchGame(serial)).rejects.toThrow('游戏包名无效');
  });
});
