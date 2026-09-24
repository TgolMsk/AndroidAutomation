/**
 * The bot's 「重启游戏并恢复」 sequence (original src/main/index.ts recoverGame(); the original had no offline check, so
 * these cases follow its behaviour): kicked dialog → tap, process gone → monkey, network-lost dialog → at most two
 * taps, verification failures in Chinese, nothing to do, and ★ never a blind tap when a template is missing.
 * A fake world where sleep only advances a virtual clock; no emulator, no adb.
 */
import { describe, expect, it } from 'vitest';
import type { RawFrame } from '../src/index.js';
import { AppError } from '../src/errors.js';
import {
  RECOVER_GAME_DEFAULTS, RECOVER_KICKED_DIALOG, RECOVER_NETWORK_LOST, RECOVER_NOTHING_TO_DO, recoverGame,
  type GameRecoveryIo, type RecoverKickedHit, type RefPoint,
} from '../src/wanlong/index.js';

const PKG = 'com.lilithgames.samo.android.cn';
const LAUNCHER = 'com.android.launcher3';

type Screen = 'kicked' | 'login' | 'maintenance' | 'network' | 'city' | 'desktop';

interface World {
  screen: Screen;
  running: boolean;
  foreground: string;
  /** Templates the user has authored (missing ones never match). */
  templates: Set<string>;
  /** After this many network taps the dialog stays (simulates a network that never comes back). */
  networkSticky: boolean;
  /** The kick dialog comes back after relaunch (the other device is still online). */
  kickReturns: boolean;
  taps: RefPoint[];
  launches: number;
  clock: number;
  trace: string[];
}

function frame(): RawFrame {
  return { width: 64, height: 36, format: 1, data: new Uint8Array(64 * 36 * 4), capturedAt: 0 };
}

function world(patch: Partial<World> = {}): World {
  return {
    screen: 'city', running: true, foreground: PKG,
    templates: new Set([RECOVER_KICKED_DIALOG, RECOVER_NETWORK_LOST, 'tpl_login_screen', 'tpl_dlg_maintenance']),
    networkSticky: false, kickReturns: false, taps: [], launches: 0, clock: 0, trace: [], ...patch,
  };
}

const HITS: Partial<Record<Screen, RecoverKickedHit & { needs: string }>> = {
  kicked: { templateId: RECOVER_KICKED_DIALOG, type: 'suspectedKicked', reason: '顶号框', needs: RECOVER_KICKED_DIALOG },
  login: { templateId: 'tpl_login_screen', type: 'suspectedKicked', reason: '登录页', needs: 'tpl_login_screen' },
  maintenance: { templateId: 'tpl_dlg_maintenance', type: 'needsAttention', reason: '服务器维护中。', needs: 'tpl_dlg_maintenance' },
};

function io(w: World, signal?: AbortSignal): GameRecoveryIo {
  return {
    gamePackage: PKG,
    ...(signal ? { signal } : {}),
    capture: async () => { w.trace.push(`capture:${w.screen}`); return frame(); },
    kicked: async () => {
      const hit = HITS[w.screen];
      return hit && w.templates.has(hit.needs) ? { templateId: hit.templateId, type: hit.type, reason: hit.reason } : null;
    },
    seen: async (id) => id === RECOVER_NETWORK_LOST && w.templates.has(id) && w.screen === 'network',
    tapRef: async (p) => {
      if (w.foreground !== PKG) throw new Error('前台不是游戏，不点');
      w.taps.push(p);
      w.trace.push(`tap:${p.x},${p.y}`);
      if (w.screen === 'kicked' && p.x === RECOVER_GAME_DEFAULTS.kickConfirmRef.x) {
        // Confirming the kick dialog quits the game.
        w.running = false;
        w.foreground = LAUNCHER;
        w.screen = 'desktop';
      } else if (w.screen === 'network' && !w.networkSticky) {
        w.screen = 'city';
      }
    },
    isGameRunning: async () => w.running,
    launchGame: async () => {
      w.launches++;
      w.trace.push('monkey');
      w.running = true;
      w.foreground = PKG;
      w.screen = w.kickReturns ? 'kicked' : w.screen === 'desktop' ? 'network' : w.screen;
    },
    foreground: async () => w.foreground,
    sleep: async (ms) => { w.clock += ms; },
  };
}

async function failure(run: () => Promise<unknown>): Promise<AppError> {
  try { await run(); } catch (error) { return error as AppError; }
  throw new Error('应当失败');
}

describe('recoverGame: the kicked → monkey → network-lost chain', () => {
  it('taps the kick dialog at the reference point, relaunches with monkey, then clears the network prompt', async () => {
    const w = world({ screen: 'kicked' });
    const done = await recoverGame(io(w));
    expect(done).toBe('点掉顶号弹窗 → 用 monkey 重启游戏 → 点掉网络重连提示');
    expect(w.taps).toEqual([RECOVER_GAME_DEFAULTS.kickConfirmRef, RECOVER_GAME_DEFAULTS.networkConfirmRef]);
    expect(w.launches).toBe(1);
    // 6 s after the kick tap, 20 s of loading after monkey, 15 s after the network tap (the game was in front at once).
    expect(w.clock).toBe(RECOVER_GAME_DEFAULTS.afterKickMs + RECOVER_GAME_DEFAULTS.afterLaunchMs + RECOVER_GAME_DEFAULTS.afterNetworkMs);
    expect(w.trace.indexOf('tap:1275,965')).toBeLessThan(w.trace.indexOf('monkey'));
  });

  it('taps the network prompt at most twice', async () => {
    const w = world({ screen: 'network', networkSticky: true });
    await recoverGame(io(w));
    expect(w.taps).toEqual([RECOVER_GAME_DEFAULTS.networkConfirmRef, RECOVER_GAME_DEFAULTS.networkConfirmRef]);
  });

  it('does nothing when the game is running normally', async () => {
    const w = world();
    await expect(recoverGame(io(w))).resolves.toBe(RECOVER_NOTHING_TO_DO);
    expect(w.taps).toEqual([]);
    expect(w.launches).toBe(0);
  });

  it('brings a running game that fell into the background back to the front without waiting for a load', async () => {
    const w = world({ foreground: LAUNCHER });
    await expect(recoverGame(io(w))).resolves.toBe('把游戏切回前台');
    expect(w.launches).toBe(1);
    expect(w.clock).toBe(0);
  });
});

describe('recoverGame: never a blind tap', () => {
  it('skips the kick tap when tpl_dlg_kicked is missing (and fails the verification instead of guessing)', async () => {
    const w = world({ screen: 'kicked', templates: new Set() });
    const done = await recoverGame(io(w));
    expect(w.taps).toEqual([]);
    expect(done).toBe(RECOVER_NOTHING_TO_DO);
  });

  it('skips the network tap when tpl_dlg_network_lost is missing', async () => {
    const w = world({ screen: 'network', templates: new Set([RECOVER_KICKED_DIALOG]) });
    await recoverGame(io(w));
    expect(w.taps).toEqual([]);
  });

  it('does not tap the kick-dialog point on a login screen or a maintenance notice', async () => {
    const login = world({ screen: 'login' });
    const error = await failure(() => recoverGame(io(login)));
    expect(login.taps).toEqual([]);
    expect(error.message).toContain('顶号弹窗又出现了');
    const maintenance = world({ screen: 'maintenance' });
    const notice = await failure(() => recoverGame(io(maintenance)));
    expect(maintenance.taps).toEqual([]);
    expect(notice.code).toBe('NOT_FOUND');
    expect(notice.message).toContain('服务器维护中');
  });
});

describe('recoverGame: verification', () => {
  it('throws in Chinese when the game never comes to the front', async () => {
    const w = world({ running: false, foreground: LAUNCHER, screen: 'desktop' });
    const stubborn = io(w);
    stubborn.launchGame = async () => { w.launches++; };
    const error = await failure(() => recoverGame(stubborn));
    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe('NOT_FOUND');
    expect(error.message).toBe(`游戏没有回到前台（当前前台：${LAUNCHER}），未恢复调度。`);
    // Polled the foreground 30 × 2 s, then waited for the load.
    expect(w.clock).toBe(RECOVER_GAME_DEFAULTS.foregroundPolls * RECOVER_GAME_DEFAULTS.foregroundPollMs + RECOVER_GAME_DEFAULTS.afterLaunchMs);
  });

  it('throws when the kick dialog is back after the relaunch', async () => {
    const w = world({ screen: 'kicked', kickReturns: true });
    const error = await failure(() => recoverGame(io(w)));
    expect(error.message).toBe('重启后顶号弹窗又出现了 —— 对方设备可能还在线。请先退出另一台设备再试。');
  });

  it('stops at once when aborted', async () => {
    const controller = new AbortController();
    const w = world({ screen: 'kicked' });
    const aborting = io(w, controller.signal);
    aborting.sleep = async () => { controller.abort(new AppError('RUN_ABORTED', '助手正在退出')); };
    const error = await failure(() => recoverGame(aborting));
    expect(error.code).toBe('RUN_ABORTED');
    expect(w.launches).toBe(0);
  });
});
