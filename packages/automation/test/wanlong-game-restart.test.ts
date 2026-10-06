/**
 * The non-kicked game restart (`restartStuckGame`): look for a kicked / login / maintenance screen first and never
 * restart over one, force-stop → monkey → foreground → main screen, the 「foreground but not recognized」 success,
 * the verdict on the last frame, every failure stage in Chinese, and aborting. A fake world where sleep only advances
 * a virtual clock; no emulator, no adb.
 */
import { describe, expect, it } from 'vitest';
import type { RawFrame } from '../src/index.js';
import { AppError } from '../src/errors.js';
import {
  GAME_RESTART_DEFAULTS, restartStuckGame, type GameRestartIo, type KickedProbeResult,
} from '../src/wanlong/index.js';

const PKG = 'com.lilithgames.samo.android.cn';
const LAUNCHER = 'com.android.launcher3';

type Screen = 'anr' | 'kicked' | 'login' | 'loading' | 'city' | 'desktop';

interface World {
  screen: Screen;
  running: boolean;
  /** Frames the game shows after a launch before the city; Infinity = it never gets there. */
  loadFrames: number;
  /** What the game settles on when loading ends (kicked back to the login screen, or the city). */
  after: 'city' | 'login';
  /** Foreground polls after a monkey launch before the game window shows. */
  foregroundAfterPolls: number;
  launchFailures: number;
  stopThrows: boolean;
  kickedThrows: boolean;
  /** The game leaves the foreground by itself while loading. */
  losesForeground: boolean;
  clock: number;
  launches: number;
  stops: number;
  framesSinceLaunch: number;
  fgPolls: number;
  trace: string[];
  logs: string[];
}

function frame(): RawFrame {
  return { width: 64, height: 36, format: 1, data: new Uint8Array(64 * 36 * 4), capturedAt: 0 };
}

function world(patch: Partial<World> = {}): World {
  return {
    screen: 'anr', running: true, loadFrames: 3, after: 'city', foregroundAfterPolls: 2, launchFailures: 0, stopThrows: false,
    kickedThrows: false, losesForeground: false, clock: 0, launches: 0, stops: 0, framesSinceLaunch: 0, fgPolls: 0, trace: [], logs: [],
    ...patch,
  };
}

function ioOf(w: World, signal?: AbortSignal): GameRestartIo {
  const shown = new WeakMap<RawFrame, Screen>();
  return {
    capture: async () => {
      if (w.launches > 0 && w.screen === 'loading') {
        w.framesSinceLaunch += 1;
        if (w.framesSinceLaunch > w.loadFrames) w.screen = w.after;
      }
      const raw = frame();
      shown.set(raw, w.screen);
      w.trace.push(`capture:${w.screen}`);
      return raw;
    },
    recognize: async (raw) => shown.get(raw) === 'city',
    kicked: async (raw): Promise<KickedProbeResult | null> => {
      if (w.kickedThrows) throw new Error('视觉进程不可用');
      const screen = shown.get(raw);
      if (screen === 'kicked') return { type: 'suspectedKicked', reason: '画面上是「账号在其他设备登录」提示框。', templateId: 'tpl_dlg_kicked', score: 0.97 };
      if (screen === 'login') return { type: 'suspectedKicked', reason: '游戏停在登录界面。', templateId: 'tpl_login_screen', score: 0.95 };
      return null;
    },
    stopGame: async () => {
      w.trace.push('stop');
      if (w.stopThrows) throw new AppError('ADB_COMMAND_FAILED', 'adb: device offline');
      w.stops += 1;
      w.running = false;
      w.screen = 'desktop';
    },
    launchGame: async () => {
      w.trace.push('launch');
      w.launches += 1;
      if (w.launches <= w.launchFailures) throw new AppError('ADB_COMMAND_FAILED', 'monkey: No activities found to run');
      w.running = true;
      w.fgPolls = 0;
      w.framesSinceLaunch = 0;
      w.screen = 'loading';
    },
    foreground: async () => {
      if (!w.running) return LAUNCHER;
      if (w.losesForeground && w.framesSinceLaunch > 0) return LAUNCHER;
      w.fgPolls += 1;
      return w.fgPolls >= w.foregroundAfterPolls ? PKG : LAUNCHER;
    },
    isGameRunning: async () => w.running,
    log: (level, message) => w.logs.push(`${level}:${message}`),
    sleep: async (ms) => { w.clock += ms; },
    now: () => w.clock,
    ...(signal ? { signal } : {}),
  };
}

describe('restartStuckGame', () => {
  it('★ a hung game (ANR): force-stop, then monkey, then the main screen — in that order', async () => {
    const w = world();
    const r = await restartStuckGame(ioOf(w), { gamePackage: PKG });
    expect(r).toMatchObject({ ok: true, loaded: true, stage: 'done', reason: null, verdict: null });
    expect(r.steps).toEqual(['强制停止游戏', '已用 monkey 拉起游戏', '主界面已认出']);
    expect(r.before).not.toBeNull();
    expect(w.trace.slice(0, 3)).toEqual(['capture:anr', 'stop', 'launch']);
    expect(w.stops).toBe(1);
    expect(w.launches).toBe(1);
    // The gap between force-stop and monkey is kept.
    expect(w.clock).toBeGreaterThanOrEqual(GAME_RESTART_DEFAULTS.stopGapMs);
  });

  it('★ never restarts over a kicked dialog: the verdict goes back to the caller with its frame', async () => {
    const w = world({ screen: 'kicked' });
    const r = await restartStuckGame(ioOf(w), { gamePackage: PKG });
    expect(r).toMatchObject({ ok: false, stage: 'check', verdict: { type: 'suspectedKicked', templateId: 'tpl_dlg_kicked' } });
    expect(r.frame).not.toBeNull();
    expect(w.trace).toEqual(['capture:kicked']);
    expect(w.stops).toBe(0);
    expect(w.launches).toBe(0);
  });

  it('a crashed game (process gone) is launched again; the step says it was already gone', async () => {
    const w = world({ screen: 'desktop', running: false });
    const r = await restartStuckGame(ioOf(w), { gamePackage: PKG });
    expect(r).toMatchObject({ ok: true, loaded: true });
    expect(r.steps[0]).toBe('游戏进程已不在');
    expect(w.launches).toBe(1);
  });

  it('foreground but never recognized: still a success (loaded=false), handed to the scheduler', async () => {
    const w = world({ loadFrames: Infinity });
    const r = await restartStuckGame(ioOf(w), { gamePackage: PKG, loadTimeoutMs: 30_000 });
    expect(r).toMatchObject({ ok: true, loaded: false, stage: 'done', verdict: null });
    expect(r.steps.at(-1)).toBe('主界面未认出，交给调度器处理');
  });

  it('★ ends on the login screen after the restart: a verdict (stage load), not a success', async () => {
    const w = world({ loadFrames: 2, after: 'login' });
    const r = await restartStuckGame(ioOf(w), { gamePackage: PKG, loadTimeoutMs: 30_000 });
    expect(r).toMatchObject({ ok: false, stage: 'load', verdict: { templateId: 'tpl_login_screen' } });
    expect(r.frame).not.toBeNull();
  });

  it('the game left the foreground while loading: fails at load', async () => {
    const w = world({ loadFrames: Infinity, losesForeground: true });
    const r = await restartStuckGame(ioOf(w), { gamePackage: PKG, loadTimeoutMs: 30_000 });
    expect(r).toMatchObject({ ok: false, stage: 'load' });
    expect(r.reason).toContain(LAUNCHER);
  });

  it('force-stop fails: stage stop with the adb error, nothing launched', async () => {
    const w = world({ stopThrows: true });
    const r = await restartStuckGame(ioOf(w), { gamePackage: PKG });
    expect(r).toMatchObject({ ok: false, stage: 'stop', reason: 'adb: device offline' });
    expect(w.launches).toBe(0);
  });

  it('launch retried once, then fails at launch', async () => {
    const once = world({ launchFailures: 1 });
    expect(await restartStuckGame(ioOf(once), { gamePackage: PKG })).toMatchObject({ ok: true, loaded: true });
    expect(once.launches).toBe(2);
    const twice = world({ launchFailures: 99 });
    const r = await restartStuckGame(ioOf(twice), { gamePackage: PKG });
    expect(r).toMatchObject({ ok: false, stage: 'launch' });
    expect(twice.launches).toBe(2);
  });

  it('a broken kicked probe is no conclusion (the restart goes on)', async () => {
    const w = world({ kickedThrows: true });
    expect(await restartStuckGame(ioOf(w), { gamePackage: PKG })).toMatchObject({ ok: true, loaded: true });
  });

  it('aborting stops at once with RUN_ABORTED', async () => {
    const controller = new AbortController();
    const w = world({ loadFrames: Infinity });
    const io = ioOf(w, controller.signal);
    const sleep = io.sleep!;
    io.sleep = async (ms) => { await sleep(ms); if (w.launches > 0) controller.abort(); };
    await expect(restartStuckGame(io, { gamePackage: PKG })).rejects.toMatchObject({ code: 'RUN_ABORTED' });
    controller.abort();
    await expect(restartStuckGame(ioOf(world(), controller.signal), { gamePackage: PKG })).rejects.toMatchObject({ code: 'RUN_ABORTED' });
  });
});
