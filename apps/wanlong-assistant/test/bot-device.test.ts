/**
 * The bot's device side and composition: screenshot and 「重启游戏」 on fake AVDs (never a blind tap, foreground
 * re-read before every tap, reference → device scaling), audit copies under the shot policy, and late wiring of the
 * statistics / resources ports.
 */
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MatchResult, RawFrame } from '@avdm/automation';
import { emptyInstanceState } from '@avdm/automation/wanlong/pure';
import type { ShotPolicy } from '../src/shared/app-settings';
import { BotDevice, BotService, BotShotStore, type BotDevicePort, type BotManagerPort } from '../src/main/bot';

const GAME = 'com.lilithgames.samo.android.cn';
const LAUNCHER = 'com.android.launcher3';
const NOW = Date.UTC(2026, 8, 9, 13, 22, 33);

function frame(): RawFrame {
  return { width: 1280, height: 720, data: new Uint8Array(1280 * 720 * 4), capturedAt: NOW };
}

interface FakeAvd {
  status: string;
  foreground: string;
  running: boolean;
  /** What the reserved / dialog templates see right now. */
  screen: 'kicked' | 'network' | 'city';
  taps: Array<[number, number]>;
  launches: number;
  lanes: number[];
}

function avd(patch: Partial<FakeAvd> = {}): FakeAvd {
  return { status: 'running', foreground: GAME, running: true, screen: 'city', taps: [], launches: 0, lanes: [], ...patch };
}

function manager(world: FakeAvd): BotManagerPort {
  const device: BotDevicePort = {
    screencapRaw: async () => frame(),
    foregroundPackage: async () => world.foreground,
    isAppRunning: async () => world.running,
    startApp: async (pkg) => {
      expect(pkg).toBe(GAME);
      world.launches++;
      world.running = true;
      world.foreground = GAME;
      world.screen = 'city';
    },
    tap: async (x, y) => {
      world.taps.push([x, y]);
      if (world.screen === 'kicked') { world.running = false; world.foreground = LAUNCHER; world.screen = 'city'; }
    },
  };
  return { getState: async () => ({ status: world.status }), device: async () => device };
}

function match(world: FakeAvd, available = true) {
  return async (_index: number, _raw: RawFrame, ids: string[]): Promise<MatchResult[]> => {
    if (!available) throw new Error('请先选择本地模板集目录');
    return ids.map((templateId) => {
      const found = (templateId === 'tpl_dlg_kicked' && world.screen === 'kicked') || (templateId === 'tpl_dlg_network_lost' && world.screen === 'network');
      return { templateId, found, score: found ? 0.97 : 0.2, threshold: 0.9, x: 0, y: 0, w: 1, h: 1, centerX: 0, centerY: 0, elapsedMs: 1 };
    });
  };
}

function botDevice(world: FakeAvd, templates = true): { device: BotDevice; encoded: RawFrame[] } {
  const encoded: RawFrame[] = [];
  const device = new BotDevice({
    manager: async () => manager(world),
    gamePackage: GAME,
    referenceSize: { width: 2560, height: 1440 },
    lane: async (index, work) => { world.lanes.push(index); return work(); },
    encode: async (raw) => { encoded.push(raw); return { jpeg: new Uint8Array([0xff, 0xd8, 1, 2]) }; },
    matchTemplates: match(world, templates),
    log: () => undefined,
    sleep: async () => undefined,
  });
  return { device, encoded };
}

describe('BotDevice.captureShot', () => {
  it('captures whatever is in front and reports it (no refusal for a desktop)', async () => {
    const world = avd({ foreground: LAUNCHER, running: false });
    const { device, encoded } = botDevice(world);
    const shot = await device.captureShot(0);
    expect(shot).toMatchObject({ foreground: LAUNCHER, gameRunning: false, at: NOW });
    expect(shot.jpeg.byteLength).toBe(4);
    expect(encoded).toHaveLength(1);
    expect(world.taps).toEqual([]);
  });

  it('refuses a stopped emulator in Chinese', async () => {
    const { device } = botDevice(avd({ status: 'stopped' }));
    await expect(device.captureShot(1)).rejects.toMatchObject({ code: 'DEVICE_NOT_READY', message: expect.stringContaining('尚未就绪') });
  });
});

describe('BotDevice.recoverGame', () => {
  it('taps the kick dialog at the scaled reference point on the lane, then relaunches with monkey', async () => {
    const world = avd({ screen: 'kicked' });
    const { device } = botDevice(world);
    await expect(device.recoverGame(0)).resolves.toBe('点掉顶号弹窗 → 用 monkey 重启游戏');
    // 1275 × 1280 / 2560, 965 × 720 / 1440
    expect(world.taps).toEqual([[638, 483]]);
    expect(world.lanes).toEqual([0]);
    expect(world.launches).toBe(1);
  });

  it('★ never taps when the templates are missing (no template set) — only the process / foreground checks run', async () => {
    const world = avd({ screen: 'kicked' });
    const { device } = botDevice(world, false);
    await expect(device.recoverGame(0)).resolves.toBe('游戏本来就在正常运行，没有需要处理的弹窗');
    expect(world.taps).toEqual([]);
  });

  it('★ refuses to tap when the foreground is not the game at the moment of the tap', async () => {
    const world = avd({ screen: 'network' });
    const m = manager(world);
    const dev = await m.device(0);
    // Read 1 (before relaunch decision) sees the game; read 2 is the tap's own check on the lane: someone switched apps.
    let reads = 0;
    const switching: BotManagerPort = {
      getState: m.getState,
      device: async () => ({ ...dev, foregroundPackage: async () => (++reads >= 2 ? 'com.tencent.mm' : GAME) }),
    };
    const guarded = new BotDevice({
      manager: async () => switching, gamePackage: GAME, referenceSize: { width: 2560, height: 1440 },
      lane: async (index, work) => { world.lanes.push(index); return work(); }, encode: async () => ({ jpeg: new Uint8Array(1) }),
      matchTemplates: match(world), log: () => undefined, sleep: async () => undefined,
    });
    await expect(guarded.recoverGame(0)).rejects.toMatchObject({ message: expect.stringContaining('前台不是游戏（com.tencent.mm）') });
    expect(world.taps).toEqual([]);
    expect(world.lanes).toEqual([0]);
  });
});

describe('BotShotStore and BotService', () => {
  let home: string;
  beforeEach(async () => { home = await mkdtemp(path.join(tmpdir(), 'avdm-bot-')); });
  afterEach(async () => { await rm(home, { recursive: true, force: true }); });

  it('writes private audit copies named in Beijing time', async () => {
    const store = new BotShotStore(home, () => NOW);
    const rel = await store.save(3, new Uint8Array([1, 2, 3]), NOW);
    expect(rel).toBe('automation/wanlong/bot-shots/inst3-20260909-212233.jpg');
    const info = await stat(path.join(home, rel));
    if (process.platform !== 'win32') expect(info.mode & 0o777).toBe(0o600);
    await expect(store.save(64, new Uint8Array([1]), NOW)).rejects.toThrow('实例编号无效');
  });

  function service(policy: { value: ShotPolicy }) {
    const world = avd();
    const bot = new BotService({
      home, gamePackage: GAME, referenceSize: { width: 2560, height: 1440 }, now: () => NOW,
      config: async () => { throw new Error('not used'); },
      accounts: async () => [{ name: '主号', enabled: true, binding: { index: 0, instanceCreatedAt: 'avd-0' }, loginReady: true }],
      instances: async () => [{ index: 0, name: 'Pixel-0', status: 'running', createdAt: 'avd-0', base: false }],
      schedulerState: (index) => emptyInstanceState(index),
      pauseOf: () => ({ paused: false, reason: null }),
      pauseInstance: async () => undefined,
      resumeInstance: async () => undefined,
      exclusive: (_i, _what, fn) => fn({ signal: new AbortController().signal }),
      manager: async () => manager(world),
      lane: async (_i, work) => work(),
      matchTemplates: match(world),
      shotPolicy: () => policy.value,
      log: () => undefined,
      encode: async () => ({ jpeg: new Uint8Array([0xff, 0xd8, 9]) }),
    });
    return bot;
  }

  it('keeps an audit copy unless the shot policy is 「不留痕」', async () => {
    const policy = { value: 'never' as ShotPolicy };
    const bot = service(policy);
    const first = await bot.actions.perform('shot', 0);
    expect(first.photo?.filename).toBe('inst0-20260909-212233.jpg');
    await expect(readdir(path.join(home, 'automation', 'wanlong', 'bot-shots'))).rejects.toThrow();
    policy.value = 'onFail';
    await bot.actions.perform('shot', 0);
    expect(await readdir(path.join(home, 'automation', 'wanlong', 'bot-shots'))).toEqual(['inst0-20260909-212233.jpg']);
    await bot.dispose();
  });

  it('answers 「not wired yet」 until the statistics / resources module plugs its ports in', async () => {
    const bot = service({ value: 'onFail' });
    expect((await bot.actions.perform('stats', null)).text).toContain('还没有接入');
    expect((await bot.actions.perform('resources', 0)).text).toContain('还没有接入');
    const snapshot = { at: NOW, instanceIndex: 0, source: 'panel' as const, rows: [], warnings: [] };
    bot.setPorts({ dailyStatsText: async () => '【今日统计】2026-09-09', readResources: async () => snapshot });
    expect((await bot.actions.perform('stats', null)).text).toBe('【今日统计】2026-09-09');
    expect((await bot.actions.perform('resources', 0)).text).toContain('实例 0「主号」资源统计');
    expect(bot.status()).toMatchObject({ running: false });
    await bot.dispose();
  });
});
