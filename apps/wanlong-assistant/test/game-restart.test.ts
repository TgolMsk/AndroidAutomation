/**
 * 「异常时自动重启游戏（顶号除外）」 — GameRestartController: the preconditions (switch, wiring, pause, running
 * instance), the restart inside `exclusive()`, the 「游戏异常已自动重启」 warning, a kicked / maintenance screen handed
 * back as a verdict (never restarted over, not counted), failures with a note, the budget window, aborting, and the
 * @avdm/core adapter. Virtual clock, fake ports: no emulator, no adb.
 */
import { describe, expect, it, vi } from 'vitest';
import type { RawFrame } from '@avdm/automation';
import type { GameRestartIo, GameRestartResult, restartStuckGame } from '@avdm/automation/wanlong';
import { defaultAlertsConfig, type AlertDetectConfig, type AlertEvent } from '../src/shared/alerts';
import {
  createGameRestartIo, GameRestartController, type GameRestartControllerPorts, type GameRestartDevice,
} from '../src/main/alerts/game-restart';

const MIN = 60_000;
const PKG = 'com.lilithgames.samo.android.cn';

function frame(): RawFrame {
  return { width: 4, height: 4, format: 1, data: new Uint8Array(64), capturedAt: 0 };
}

function result(p: Partial<GameRestartResult> = {}): GameRestartResult {
  return {
    ok: true, loaded: true, stage: 'done', reason: null, verdict: null, steps: ['强制停止游戏', '已用 monkey 拉起游戏', '主界面已认出'],
    elapsedMs: 72_000, frame: null, before: frame(), ...p,
  };
}

interface World {
  controller: GameRestartController;
  cfg: AlertDetectConfig;
  alive: { alive: boolean; status: string; identity?: string | null };
  paused: Set<number>;
  raised: AlertEvent[];
  shots: string[];
  exclusive: Array<{ index: number; what: string }>;
  resets: number[];
  restart: ReturnType<typeof vi.fn>;
  clock: { now: number };
  logs: string[];
}

function makeWorld(over: Partial<GameRestartControllerPorts> = {}, cfg: Partial<AlertDetectConfig> = {}): World {
  const world = {
    cfg: { ...defaultAlertsConfig().detect, ...cfg }, alive: { alive: true, status: 'running', identity: 'avd-a' as string | null },
    paused: new Set<number>(), raised: [] as AlertEvent[], shots: [] as string[], exclusive: [] as Array<{ index: number; what: string }>,
    resets: [] as number[], clock: { now: 10 * MIN }, logs: [] as string[], restart: vi.fn(async () => result()),
  } as Omit<World, 'controller'>;
  const controller = new GameRestartController({
    config: () => world.cfg,
    isPaused: (index) => world.paused.has(index),
    instanceAlive: async () => world.alive,
    exclusive: async (index, what, fn, signal) => {
      world.exclusive.push({ index, what });
      return fn({ signal: signal ?? new AbortController().signal });
    },
    restartIo: () => ({}) as GameRestartIo,
    saveShot: async (index, label) => { const shot = `automation/wanlong/shots/inst${index}-${label}-1.jpg`; world.shots.push(shot); return shot; },
    raise: async (event) => { world.raised.push(event); },
    resetEvidence: (index) => world.resets.push(index),
    log: (level, message) => world.logs.push(`[${level}] ${message}`),
    gamePackage: PKG,
    now: () => world.clock.now,
    restart: world.restart as unknown as typeof restartStuckGame,
    ...over,
  });
  return Object.assign(world, { controller });
}

describe('GameRestartController', () => {
  it('★ restarts inside exclusive(), raises one 「游戏异常已自动重启」 warning (no pause) and resets the evidence', async () => {
    const world = makeWorld();
    const attempt = await world.controller.tryRestart(0, '系统弹出「应用无响应」（ANR），游戏已经卡死', undefined);
    expect(attempt).toEqual({ outcome: 'recovered' });
    expect(world.exclusive).toEqual([{ index: 0, what: '重启游戏' }]);
    expect(world.restart).toHaveBeenCalledWith(expect.anything(), { gamePackage: PKG });
    expect(world.resets).toEqual([0]);
    expect(world.raised).toHaveLength(1);
    expect(world.raised[0]).toMatchObject({
      type: 'gameRestarted', severity: 'warning', shotPath: 'automation/wanlong/shots/inst0-game-restart-1.jpg',
      detail: { 触发: '系统弹出「应用无响应」（ANR），游戏已经卡死', 主界面: '已认出', 本窗口重启次数: '1/3' },
    });
    expect(world.raised[0]!.reason).toContain('确认不是顶号后已强制重启游戏');
    expect(world.raised[0]!.reason).toContain('耗时 72s');
    expect(world.controller.budget(0)).toMatchObject({ used: 1, limit: 3, allowed: true });
    expect(world.controller.isRestarting(0)).toBe(false);
  });

  it('skips when switched off, not wired, paused, or the emulator is not running (Android not up)', async () => {
    const off = makeWorld({}, { gameRestartEnabled: false });
    expect(off.controller.enabled()).toBe(false);
    expect(await off.controller.tryRestart(0, 't', undefined)).toEqual({ outcome: 'skipped' });
    const unwired = makeWorld({ restartIo: undefined });
    expect(unwired.controller.enabled()).toBe(false);
    expect(await unwired.controller.tryRestart(0, 't', undefined)).toEqual({ outcome: 'skipped' });
    const paused = makeWorld();
    paused.paused.add(0);
    expect(await paused.controller.tryRestart(0, 't', undefined)).toEqual({ outcome: 'skipped' });
    const booting = makeWorld();
    booting.alive = { alive: true, status: 'booting', identity: 'avd-a' };
    expect(await booting.controller.tryRestart(0, '连续采样失败', undefined)).toEqual({ outcome: 'skipped' });
    expect(booting.logs.some((line) => line.includes('「booting」'))).toBe(true);
    for (const world of [off, unwired, paused, booting]) {
      expect(world.restart).not.toHaveBeenCalled();
      expect(world.raised).toEqual([]);
    }
  });

  it('★ a kicked screen before the restart: handed back as a verdict, nothing restarted, not counted', async () => {
    const world = makeWorld();
    world.restart.mockImplementation(async () => result({
      ok: false, stage: 'check', reason: '账号在其他设备登录', steps: [], frame: frame(),
      verdict: { type: 'suspectedKicked', reason: '账号在其他设备登录', templateId: 'tpl_dlg_kicked', score: 0.97 },
    }));
    const attempt = await world.controller.tryRestart(0, '连续采样失败', undefined);
    expect(attempt).toEqual({
      outcome: 'verdict', before: true, shotPath: 'automation/wanlong/shots/inst0-kicked-1.jpg',
      verdict: { type: 'suspectedKicked', reason: '账号在其他设备登录', templateId: 'tpl_dlg_kicked', score: 0.97 },
    });
    expect(world.controller.budget(0).used).toBe(0);
    expect(world.raised).toEqual([]);
    expect(world.resets).toEqual([]);
  });

  it('the game came back to a maintenance notice after the restart: a verdict (after), counted', async () => {
    const world = makeWorld();
    world.restart.mockImplementation(async () => result({
      ok: false, stage: 'load', reason: '维护公告', frame: frame(),
      verdict: { type: 'needsAttention', reason: '维护公告', templateId: 'tpl_dlg_maintenance' },
    }));
    expect(await world.controller.tryRestart(0, '连续采样失败', undefined)).toMatchObject({ outcome: 'verdict', before: false });
    expect(world.controller.budget(0).used).toBe(1);
  });

  it('a failed restart: note with the stage for the pause, the failure scene kept, counted, no warning', async () => {
    const world = makeWorld();
    world.restart.mockImplementation(async () => result({ ok: false, loaded: false, stage: 'launch', reason: '两次都没能把游戏拉到前台。', frame: null }));
    const attempt = await world.controller.tryRestart(0, '连续采样失败', undefined);
    expect(attempt).toMatchObject({ outcome: 'failed', shotPath: 'automation/wanlong/shots/inst0-game-restart-1.jpg' });
    expect(attempt.outcome === 'failed' && attempt.note).toContain('卡在：拉起游戏');
    expect(world.controller.budget(0).used).toBe(1);
    expect(world.raised).toEqual([]);
    // A thrown error is a failure too (and counted).
    world.restart.mockImplementation(async () => { throw new Error('adb: device offline'); });
    const thrown = await world.controller.tryRestart(0, '连续采样失败', undefined);
    expect(thrown).toMatchObject({ outcome: 'failed', note: '自动重启游戏时出错：adb: device offline' });
    expect(world.controller.budget(0).used).toBe(2);
  });

  it('★ the budget: beyond the limit in the window no restart, a note for the pause; the window rolls on', async () => {
    const world = makeWorld({}, { gameRestartLimit: 2, gameRestartWindowMin: 60 });
    expect((await world.controller.tryRestart(0, 'a', undefined)).outcome).toBe('recovered');
    world.clock.now += 10 * MIN;
    expect((await world.controller.tryRestart(0, 'b', undefined)).outcome).toBe('recovered');
    world.clock.now += 10 * MIN;
    const over = await world.controller.tryRestart(0, 'c', undefined);
    expect(over).toEqual({ outcome: 'failed', note: '60 分钟内已自动重启游戏 2 次（上限 2），这次不再重启。', shotPath: null });
    expect(world.restart).toHaveBeenCalledTimes(2);
    // Other instances have their own budget.
    expect((await world.controller.tryRestart(1, 'd', undefined)).outcome).toBe('recovered');
    // The first restart leaves the window.
    world.clock.now += 41 * MIN;
    expect((await world.controller.tryRestart(0, 'e', undefined)).outcome).toBe('recovered');
    expect(world.raised.at(-1)?.detail).toMatchObject({ 本窗口重启次数: '2/2' });
  });

  it('a replaced AVD starts with a clean budget', async () => {
    const world = makeWorld({}, { gameRestartLimit: 1 });
    expect((await world.controller.tryRestart(0, 'a', undefined)).outcome).toBe('recovered');
    expect((await world.controller.tryRestart(0, 'b', undefined)).outcome).toBe('failed');
    world.alive = { alive: true, status: 'running', identity: 'avd-b' };
    expect((await world.controller.tryRestart(0, 'c', undefined)).outcome).toBe('recovered');
  });

  it('aborting (auto switched off / quitting) is skipped, not counted, and never raises', async () => {
    const world = makeWorld();
    const controller = new AbortController();
    world.restart.mockImplementation(async () => {
      controller.abort();
      throw Object.assign(new Error('游戏自动重启已中止。'), { code: 'RUN_ABORTED' });
    });
    expect(await world.controller.tryRestart(0, 't', controller.signal)).toEqual({ outcome: 'skipped' });
    expect(world.controller.budget(0).used).toBe(0);
    expect(world.raised).toEqual([]);
    // dispose() aborts restarts in flight.
    const quitting = makeWorld();
    quitting.restart.mockImplementation(async (io: GameRestartIo) => {
      quitting.controller.dispose();
      if (io.signal?.aborted) throw Object.assign(new Error('游戏自动重启已中止。'), { code: 'RUN_ABORTED' });
      return result();
    });
    quitting.controller = new GameRestartController({
      config: () => quitting.cfg, isPaused: () => false, instanceAlive: async () => quitting.alive,
      exclusive: async (_index, _what, fn, signal) => fn({ signal: signal ?? new AbortController().signal }),
      restartIo: (_index, signal) => ({ signal }) as GameRestartIo,
      saveShot: async () => null, raise: async (event) => { quitting.raised.push(event); }, resetEvidence: () => undefined,
      log: () => undefined, gamePackage: PKG, restart: quitting.restart as unknown as typeof restartStuckGame,
    });
    expect(await quitting.controller.tryRestart(0, 't', undefined)).toEqual({ outcome: 'skipped' });
    expect(quitting.raised).toEqual([]);
  });

  it('one restart per instance at a time', async () => {
    const world = makeWorld();
    let release!: () => void;
    world.restart.mockImplementation(() => new Promise<GameRestartResult>((resolve) => { release = () => resolve(result()); }));
    const first = world.controller.tryRestart(0, 'a', undefined);
    await vi.waitFor(() => expect(world.controller.isRestarting(0)).toBe(true));
    expect(await world.controller.tryRestart(0, 'b', undefined)).toEqual({ outcome: 'skipped' });
    release();
    expect(await first).toEqual({ outcome: 'recovered' });
  });
});

describe('createGameRestartIo (@avdm/core adapter)', () => {
  function device(): GameRestartDevice & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      screencapRaw: async () => { calls.push('screencap'); return frame(); },
      stopApp: async (pkg) => { calls.push(`stop:${pkg}`); },
      startApp: async (pkg) => { calls.push(`start:${pkg}`); },
      foregroundPackage: async () => { calls.push('fg'); return undefined; },
      isAppRunning: async (pkg) => { calls.push(`running:${pkg}`); return true; },
    };
  }

  it('stops and launches only the game package, one device lookup, a failed lookup asked again', async () => {
    const dev = device();
    let lookups = 0;
    const io = createGameRestartIo({
      device: async () => { lookups += 1; if (lookups === 1) throw new Error('adb 还没连上'); return dev; },
      signal: new AbortController().signal, gamePackage: PKG,
      recognize: async () => true, kicked: async () => null, log: () => undefined,
    });
    await expect(io.stopGame()).rejects.toThrow('adb 还没连上');
    await io.stopGame();
    await io.launchGame();
    expect(await io.foreground()).toBeNull();
    expect(await io.isGameRunning!()).toBe(true);
    await io.capture();
    expect(lookups).toBe(2);
    expect(dev.calls).toEqual([`stop:${PKG}`, `start:${PKG}`, 'fg', `running:${PKG}`, 'screencap']);
    expect(() => createGameRestartIo({
      device: async () => dev, signal: new AbortController().signal, gamePackage: 'x; rm -rf /',
      recognize: async () => true, kicked: async () => null, log: () => undefined,
    })).toThrow('游戏包名无效');
  });
});
