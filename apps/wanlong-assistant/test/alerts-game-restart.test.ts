/**
 * 「异常时自动重启游戏（顶号除外）」 end to end: the REAL EtaScheduler + AlertsService with the game restart wired to a
 * fake game (the real `restartStuckGame` flow on a virtual clock). Every trigger — the ANR dialog on a failed sample,
 * the sample-failure threshold, failed cycles and the exhausted ladder, the exited process and the frozen picture on
 * the health probe — restarts the game instead of pausing; a kicked screen is never restarted over (pause + close);
 * maintenance, a failed restart, the budget and the switch still pause as before. No adb, no network.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { wanlongPlugin, type GatherCycleFact } from '@avdm/automation/wanlong';
import type { PanelSample } from '@avdm/automation/wanlong/pure';
import type { MatchResult, RawFrame } from '@avdm/automation';
import type { AlertRecord } from '../src/shared/alerts';
import { AlertsService } from '../src/main/alerts';
import type { SecretCodec } from '../src/main/alerts/store';
import type { FetchLike } from '../src/main/alerts/telegram';
import { SchedulerError } from '../src/main/scheduler/errors';
import { InstanceLocks } from '../src/main/scheduler/instance-lock';
import { EtaScheduler } from '../src/main/scheduler/service';
import type { EtaSchedulerPorts, SampleRequest } from '../src/main/scheduler/types';

const PACKAGE = wanlongPlugin.packageName;
const LAUNCHER = 'com.android.launcher3';
const START = Date.parse('2026-09-24T12:00:00.000Z');
const CREATED_AT = '2026-09-01T00:00:00.000Z';
// ★ Test data, not a credential.
const FAKE_TOKEN = '999888777:AAFakeTokenForOfflineCheckOnly_0123456789';
const MIN = 60_000;

const codec: SecretCodec = {
  encrypt: async (plain) => `enc:${Buffer.from(plain).toString('base64')}`,
  decrypt: async (ciphertext) => Buffer.from(ciphertext.replace(/^enc:/, ''), 'base64').toString(),
};

/** A frame big enough for the freeze watchdog's digest; `seed` changes the picture. */
function frame(seed = 1): RawFrame {
  const W = 192;
  const H = 108;
  const data = new Uint8Array(W * H * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = (i * 7 + seed * 17) & 255;
    data[i + 1] = (i * 3 + seed * 31) & 255;
    data[i + 2] = (i + seed * 7) & 255;
    data[i + 3] = 255;
  }
  return { width: W, height: H, format: 1, data, capturedAt: Date.now() };
}

function factOf(p: Partial<GatherCycleFact> = {}): GatherCycleFact {
  return { outcome: 'error', message: '第 G7 步失败：找不到「创建部队」页', step: null, errorCode: 'STEP_FAILED', dispatched: 0, captures: 1, shotPath: null, kicked: null, ...p };
}

type Screen = 'stuck' | 'anr' | 'kicked' | 'maintenance' | 'city' | 'desktop';

interface Game {
  screen: Screen;
  running: boolean;
  dialog: { kind: 'anr' | 'crash'; packageName: string } | null;
  /** What the game shows once launched again. */
  after: Screen;
  launchFails: boolean;
  stops: number;
  launches: number;
}

async function until(check: () => boolean | Promise<boolean>, what: string, budgetMs = 5_000): Promise<void> {
  const deadline = performance.now() + budgetMs;
  while (performance.now() < deadline) {
    if (await check()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  if (await check()) return;
  throw new Error(`等待超时：${what}`);
}

describe('「异常时自动重启游戏」 with the real scheduler', () => {
  let home: string;
  let samples: Array<(req: SampleRequest) => Promise<PanelSample>>;
  let ports: EtaSchedulerPorts;
  let scheduler: EtaScheduler;
  let alerts: AlertsService;
  let game: Game;
  let clock: number;
  let calls: string[];
  let stopped: number[];
  let raised: AlertRecord[];
  let logs: string[];
  const signal = new AbortController().signal;
  const pushed = (text: string) => calls.some((call) => call.includes(text));
  const failSample = () => samples.push(async () => { throw new SchedulerError('TIMEOUT', '无法确认模拟器当前的界面，不敢盲点打开部队管理面板'); });

  const fetch: FetchLike = async (_url, init) => {
    calls.push(typeof init.body === 'string' ? String((JSON.parse(init.body) as { text: string }).text) : '[FormData]');
    return { status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: 1 } }) };
  };

  /** The layer-2 templates see what the game shows (only the kicked dialog and the maintenance notice exist). */
  const match = async (ids: string[]): Promise<MatchResult[]> => ids.map((templateId) => {
    const found = (templateId === 'tpl_dlg_kicked' && game.screen === 'kicked') || (templateId === 'tpl_dlg_maintenance' && game.screen === 'maintenance');
    return { templateId, found, score: found ? 0.97 : 0, x: 0, y: 0, w: 0, h: 0, centerX: 0, centerY: 0, threshold: 0.9, elapsedMs: 0, ...(found ? {} : { reason: '模板缺失' }) };
  });

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(START);
    home = await mkdtemp(path.join(tmpdir(), 'avdm-game-restart-'));
    samples = [];
    calls = [];
    stopped = [];
    raised = [];
    logs = [];
    clock = 0;
    game = { screen: 'stuck', running: true, dialog: null, after: 'city', launchFails: false, stops: 0, launches: 0 };
    ports = {
      sample: vi.fn(async (_index: number, req: SampleRequest) => (samples.shift() ?? (async () => ({ sampledAt: Date.now(), queueUsed: 5, queueTotal: 5, rows: [], warnings: [] })))(req)),
      healthFrame: vi.fn(async () => ({ raw: frame(), foreground: game.running ? PACKAGE : LAUNCHER, running: game.running })),
      instance: vi.fn(async () => ({ status: 'running', createdAt: CREATED_AT })),
    };
    scheduler = new EtaScheduler(home, ports, {
      ownerLease: false, locks: new InstanceLocks(home, { fileLock: async (_path, fn) => fn() }), random: () => 0, log: () => undefined,
    });
    await scheduler.restore();
    await scheduler.saveConfig({ healthProbeIntervalMin: 0 });
    alerts = new AlertsService(home, {
      setAuto: (index, enabled, reason) => scheduler.setAuto(index, enabled, reason),
      exclusive: (index, what, fn, sig) => scheduler.exclusive(index, what, fn, sig),
      accountOf: async () => ({ id: 'acc-1', name: '主号' }),
      identityOf: async () => CREATED_AT,
      instanceAlive: async () => ({ alive: true, status: 'running', identity: CREATED_AT }),
      recoveryIo: () => { throw new Error('离线自检不该重启模拟器'); },
      matchTemplates: async (_index, _raw, ids) => match(ids),
      saveShot: async (index, label) => `automation/wanlong/shots/inst${index}-${label}-1.jpg`,
      log: (level, message) => logs.push(`[${level}] ${message}`),
      refreshSchedulerView: (index) => scheduler.refreshView(index),
      onRaised: (record) => raised.push(record),
      stopInstance: async (index) => { stopped.push(index); },
      // The real restart flow on a fake game (virtual clock: sleeps take no wall time).
      gameRestartIo: (_index, sig, kicked) => ({
        capture: async () => frame(game.screen === 'city' ? 2 : 1),
        recognize: async () => game.screen === 'city',
        kicked,
        stopGame: async () => { game.stops += 1; game.running = false; game.dialog = null; game.screen = 'desktop'; },
        launchGame: async () => {
          if (game.launchFails) throw new Error('monkey: No activities found to run');
          game.launches += 1;
          game.running = true;
          game.screen = game.after;
        },
        foreground: async () => (game.running ? PACKAGE : LAUNCHER),
        isGameRunning: async () => game.running,
        log: () => undefined,
        signal: sig,
        sleep: async (ms) => { clock += ms; },
        now: () => clock,
      }),
      appDialogOf: async () => game.dialog,
      codec, fetch, sleep: async () => undefined, gamePackage: PACKAGE,
    });
    scheduler.setHooks(alerts.schedulerHooks());
    await alerts.hub.saveConfig({ telegram: { enabled: true, botToken: FAKE_TOKEN, chatId: '123456789', retryCount: 0 } });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await alerts.dispose();
    await scheduler.dispose();
    await rm(home, { recursive: true, force: true });
  });

  it('★ the ANR dialog on the first failed sample: the game is restarted at once, auto stays on, one warning pushed', async () => {
    game.screen = 'anr';
    game.dialog = { kind: 'anr', packageName: PACKAGE };
    failSample();
    await scheduler.setAuto(0, true);
    expect(game.stops).toBe(1);
    expect(game.launches).toBe(1);
    expect(alerts.center.isPaused(0)).toBe(false);
    expect(scheduler.getState(0).auto).toBe(true);
    // No threshold was needed and the counters start afresh.
    expect(alerts.failures.peek(0)).toBeNull();
    await alerts.center.whenIdle();
    const record = raised.find((item) => item.event.type === 'gameRestarted');
    expect(record?.event).toMatchObject({ severity: 'warning', detail: { 主界面: '已认出', 本窗口重启次数: '1/3' } });
    expect(record?.event.reason).toContain('应用无响应');
    expect(record?.pausedNow).toBe(false);
    expect(pushed('游戏异常已自动重启')).toBe(true);
  });

  it('a crash dialog of another app is not the game: counted like any failed sample', async () => {
    game.dialog = { kind: 'anr', packageName: 'com.android.systemui' };
    failSample();
    await scheduler.setAuto(0, true);
    expect(game.stops).toBe(0);
    expect(alerts.failures.peek(0)?.sampleFail).toBe(1);
  });

  it('★ consecutive failed samples reach the threshold: the game is restarted instead of the offline pause', async () => {
    await alerts.hub.saveConfig({ detect: { sampleFailThreshold: 2 } });
    const hooks = alerts.schedulerHooks();
    await hooks.onSampleResult!(0, false, '无法确认模拟器当前的界面', { signal });
    expect(game.stops).toBe(0);
    await hooks.onSampleResult!(0, false, '无法确认模拟器当前的界面', { signal });
    expect(game.stops).toBe(1);
    expect(alerts.center.isPaused(0)).toBe(false);
    await alerts.center.whenIdle();
    expect(raised.map((item) => item.event.type)).toEqual(['gameRestarted']);
    expect(raised[0]!.event.detail).toMatchObject({ 触发: '连续采样失败，打不开部队管理面板' });
  });

  it('★ never over a kicked dialog: paused as kicked, the emulator closed, the game untouched', async () => {
    await alerts.hub.saveConfig({ detect: { sampleFailThreshold: 1 } });
    game.screen = 'kicked';
    await alerts.schedulerHooks().onSampleResult!(0, false, '无法确认模拟器当前的界面', { signal });
    expect(game.stops).toBe(0);
    expect(game.launches).toBe(0);
    expect(alerts.center.getPause(0)).toMatchObject({ paused: true, type: 'suspectedKicked', detail: { 阶段: '自动重启游戏前', 命中模板: 'tpl_dlg_kicked' } });
    await until(() => stopped.length === 1, '关闭模拟器');
    expect(stopped).toEqual([0]);
    // Nothing was restarted, so nothing was counted.
    expect(alerts.gameRestart.budget(0).used).toBe(0);
  });

  it('back on the maintenance notice after the restart: 「需要人工介入」, the emulator stays on', async () => {
    await alerts.hub.saveConfig({ detect: { sampleFailThreshold: 1 } });
    game.after = 'maintenance';
    await alerts.schedulerHooks().onSampleResult!(0, false, '无法确认模拟器当前的界面', { signal });
    expect(game.launches).toBe(1);
    expect(alerts.center.getPause(0)).toMatchObject({ paused: true, type: 'needsAttention', detail: { 阶段: '自动重启游戏后' } });
    await alerts.center.whenIdle();
    expect(stopped).toEqual([]);
  });

  it('a restart that fails pauses as before, the failure in the reason', async () => {
    await alerts.hub.saveConfig({ detect: { sampleFailThreshold: 1 } });
    game.launchFails = true;
    await alerts.schedulerHooks().onSampleResult!(0, false, '无法确认模拟器当前的界面', { signal });
    const pause = alerts.center.getPause(0);
    expect(pause).toMatchObject({ paused: true, type: 'deviceOffline' });
    expect(pause.reason).toContain('已自动重启游戏，但没能恢复（卡在：拉起游戏）');
  });

  it('★ the budget: beyond the limit the verdict pauses with a note (no restart loop)', async () => {
    await alerts.hub.saveConfig({ detect: { sampleFailThreshold: 1, gameRestartLimit: 1 } });
    const hooks = alerts.schedulerHooks();
    await hooks.onSampleResult!(0, false, '第一次', { signal });
    expect(game.stops).toBe(1);
    expect(alerts.center.isPaused(0)).toBe(false);
    game.screen = 'stuck';
    vi.setSystemTime(START + 20 * MIN);
    await hooks.onSampleResult!(0, false, '又卡住了', { signal });
    expect(game.stops).toBe(1);
    expect(alerts.center.getPause(0)).toMatchObject({ paused: true, type: 'deviceOffline' });
    expect(alerts.center.getPause(0).reason).toContain('60 分钟内已自动重启游戏 1 次（上限 1），这次不再重启。');
  });

  it('switched off: the old behaviour (offline pause, the game untouched)', async () => {
    await alerts.hub.saveConfig({ detect: { sampleFailThreshold: 1, gameRestartEnabled: false } });
    game.dialog = { kind: 'anr', packageName: PACKAGE };
    await alerts.schedulerHooks().onSampleResult!(0, false, '无法确认模拟器当前的界面', { signal });
    expect(game.stops).toBe(0);
    expect(alerts.center.getPause(0)).toMatchObject({ paused: true, type: 'deviceOffline' });
  });

  it('the health probe: an exited game is launched again instead of the offline pause', async () => {
    game.running = false;
    game.screen = 'desktop';
    await alerts.schedulerHooks().onHealthProbe!(0, frame(), { signal, foreground: LAUNCHER, running: false });
    expect(game.launches).toBe(1);
    expect(alerts.center.isPaused(0)).toBe(false);
    await alerts.center.whenIdle();
    expect(raised[0]?.event).toMatchObject({ type: 'gameRestarted' });
    expect(raised[0]!.event.reason).toContain('游戏进程已退出');
  });

  it('the health probe: an ANR dialog restarts at once; a frozen picture restarts the game instead of 「疑似模拟器卡死」', async () => {
    const hooks = alerts.schedulerHooks();
    game.dialog = { kind: 'anr', packageName: PACKAGE };
    await hooks.onHealthProbe!(0, frame(), { signal, foreground: PACKAGE, running: true });
    expect(game.stops).toBe(1);
    // Frozen: the same picture for 6 minutes (emulator restart off by default → the game restart goes first).
    game.screen = 'stuck';
    const still = frame(9);
    for (let i = 0; i < 3; i += 1) {
      if (i > 0) vi.setSystemTime(Date.now() + 3 * MIN);
      hooks.onFrameCaptured!(1, still);
    }
    await hooks.onHealthProbe!(1, still, { signal, foreground: PACKAGE, running: true });
    expect(game.stops).toBe(2);
    await alerts.center.whenIdle();
    expect(raised.map((item) => item.event.type)).toEqual(['gameRestarted', 'gameRestarted']);
    expect(raised[1]!.event.reason).toContain('画面长时间不动');
    expect(alerts.center.isPaused(1)).toBe(false);
  });

  it('failed cycles and the exhausted ladder restart the game; a maintenance screen on the cycle still pauses', async () => {
    for (let round = 1; round <= 3; round += 1) await alerts.onCycleResult(0, factOf({ message: `第 ${round} 轮失败` }), 'scheduled');
    expect(game.stops).toBe(1);
    expect(alerts.center.isPaused(0)).toBe(false);
    for (let round = 1; round <= 2; round += 1) await alerts.onCycleResult(1, factOf({ step: 'G0', message: '回不到世界地图' }), 'scheduled');
    expect(game.stops).toBe(2);
    expect(alerts.center.isPaused(1)).toBe(false);
    // A layer-2 maintenance hit is a human's job: paused, no restart.
    await alerts.onCycleResult(2, factOf({ kicked: { type: 'needsAttention', reason: '维护公告', templateId: 'tpl_dlg_maintenance' } }), 'scheduled');
    expect(game.stops).toBe(2);
    expect(alerts.center.getPause(2)).toMatchObject({ paused: true, type: 'needsAttention' });
    // Manual rounds are watched by the user: never restarted.
    for (let round = 1; round <= 3; round += 1) await alerts.onCycleResult(3, factOf(), 'manual');
    expect(game.stops).toBe(2);
    await alerts.center.whenIdle();
    const restarts = raised.filter((item) => item.event.type === 'gameRestarted');
    expect(restarts.map((item) => item.event.detail?.['触发'])).toEqual([
      '连续多轮采集失败（第 3 轮失败）', '未知界面恢复阶梯连续用尽，回不到世界地图',
    ]);
  });
});
