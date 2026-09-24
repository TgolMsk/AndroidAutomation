/**
 * Port of wanlong-panel scripts/bot-offline-check.ts (check:bot): the bot's action layer and the `bot` IPC domain.
 * No emulator, no adb, no network: accounts / AVDs / scheduler / alerts / capture / resource reads are fakes; the
 * lock (`exclusive`) only counts and can play 「a script holds the instance」.
 *
 *   一、账号列表   二、状态   三、截图   四、资源统计   五、暂停 / 恢复 / 重启 / 菜单 / 统计   六、错误   七、bot IPC
 */
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => import('../../../packages/emulator-shell/test/helpers/electron-mock'));

import { emptyInstanceState, emptyResourceSnapshot, type InstanceQueueState, type ResourceSnapshot } from '@avdm/automation/wanlong/pure';
import { handlers } from '../../../packages/emulator-shell/test/helpers/electron-mock';
import { parseCallbackData } from '../src/shared/bot';
import { formatCst } from '../src/shared/time';
import {
  BotActionError, buildAccountRows, createBotActions, describeInstanceText, type BotAccountInfo, type BotActionDeps,
  type BotInstanceInfo, type BotPauseInfo,
} from '../src/main/bot';
import { registerWanlongIpcHandlers, type WanlongServices } from '../src/main/ipc-handlers';
import { WANLONG_INVOKE_METHODS, wanlongInvokeChannel, BOT_METHODS } from '../src/shared/ipc';
import { INVOKE_METHODS } from '@avdm/emulator-shell/shared/ipc';

/** Fixed 「now」: 2026-09-09 21:22:33 Beijing time. */
const NOW = Date.UTC(2026, 8, 9, 13, 22, 33);
const GAME = 'com.lilithgames.samo.android.cn';

function account(name: string, index: number | null, enabled = true, createdAt = `avd-${index}`): BotAccountInfo {
  return { name, enabled, binding: index === null ? null : { index, instanceCreatedAt: createdAt }, loginReady: true };
}

function instance(index: number, name: string, status: string, base = false): BotInstanceInfo {
  return { index, name, status, createdAt: `avd-${index}`, base };
}

interface World {
  accounts: BotAccountInfo[];
  instances: BotInstanceInfo[];
  states: Map<number, InstanceQueueState>;
  pauses: Map<number, BotPauseInfo>;
  exclusiveCalls: Array<{ index: number; what: string }>;
  /** true → exclusive plays 「a script holds the instance」. */
  busy: boolean;
  /** Order of recover / resume / pause / capture / lock. */
  trace: string[];
  snapshots: ResourceSnapshot[];
  savedShots: string[];
  logs: string[];
}

function makeWorld(): World {
  const s0 = emptyInstanceState(0);
  s0.auto = true;
  s0.queueUsed = 4;
  s0.queueTotal = 5;
  s0.lastSampledAt = NOW - 120_000;
  s0.lastSampleOk = true;
  s0.nextWakeAt = NOW + 8 * 60_000;
  s0.nextWakeReason = '队列释放校验';
  s0.marches = [{
    slot: 1, status: 'gathering', statusText: '采集中', targetCoord: '615,535', troopCount: 31500, commanders: [],
    remainingMs: 600_000, timerEndsAt: NOW + 600_000, gatherDoneAt: NOW + 600_000, freeAt: NOW + 660_000,
    travelTimeMs: 60_000, travelTimeSource: 'dispatch', sampledAt: NOW - 120_000,
  } as InstanceQueueState['marches'][number]];
  const s2 = emptyInstanceState(2);
  s2.auto = false;
  return {
    accounts: [account('主号', 0), account('小号', null, false), account('三号', 2)],
    instances: [instance(0, 'Pixel-0', 'running'), instance(2, 'Pixel-2', 'stopped'), instance(5, '基础实例', 'stopped', true)],
    states: new Map([[0, s0], [2, s2]]),
    pauses: new Map([[2, { paused: true, reason: '疑似被顶号' }]]),
    exclusiveCalls: [], busy: false, trace: [], snapshots: [], savedShots: [], logs: [],
  };
}

function fakeJpeg(bytes: number): Uint8Array {
  const out = new Uint8Array(bytes);
  out[0] = 0xff;
  out[1] = 0xd8;
  for (let i = 2; i < bytes; i += 1) out[i] = i & 0xff;
  return out;
}

function fakeSnapshot(index: number): ResourceSnapshot {
  const snap = emptyResourceSnapshot(index, NOW, 'panel');
  const values: Record<string, [number, number, string, string]> = {
    gold: [290_000_000, 1_110_000_000, '2.9亿', '11.1亿'],
    wood: [320_000_000, 410_000_000, '3.2亿', '4.1亿'],
    iron: [200_000_000, 2_240_000_000, '2.0亿', '22.4亿'],
    mana: [620_000_000, 720_000_000, '6.2亿', '7.2亿'],
  };
  for (const row of snap.rows) {
    const v = values[row.type]!;
    row.itemTotal = v[0];
    row.total = v[1];
    row.rawItem = v[2];
    row.rawTotal = v[3];
  }
  return snap;
}

function depsOf(w: World): BotActionDeps {
  return {
    now: () => NOW,
    gamePackage: GAME,
    accounts: async () => w.accounts,
    instances: async () => w.instances,
    schedulerState: (i) => w.states.get(i) ?? emptyInstanceState(i),
    pauseOf: (i) => w.pauses.get(i) ?? { paused: false, reason: null },
    pauseInstance: async (i) => {
      w.trace.push(`pause:${i}`);
      const state = w.states.get(i) ?? emptyInstanceState(i);
      state.auto = false;
      w.states.set(i, state);
    },
    resumeInstance: async (i) => {
      w.trace.push(`resume:${i}`);
      w.pauses.delete(i);
      const state = w.states.get(i) ?? emptyInstanceState(i);
      state.auto = true;
      w.states.set(i, state);
    },
    recoverGame: async (i) => {
      w.trace.push(`recover:${i}`);
      return '点掉顶号弹窗 → 用 monkey 重启游戏';
    },
    exclusive: async (i, what, fn) => {
      w.exclusiveCalls.push({ index: i, what });
      if (w.busy) throw new BotActionError('CONCURRENCY_LIMIT', `实例 #${i} 正在运行脚本，${what}稍后再试。`);
      w.trace.push(`lock:${i}:${what}`);
      try { return await fn({ signal: new AbortController().signal }); } finally { w.trace.push(`unlock:${i}:${what}`); }
    },
    captureShot: async (i) => {
      w.trace.push(`capture:${i}`);
      return { jpeg: fakeJpeg(2048), at: NOW, foreground: GAME, gameRunning: true };
    },
    readResources: async (i) => {
      w.trace.push(`readres:${i}`);
      return fakeSnapshot(i);
    },
    recordSnapshot: (_i, snapshot) => { w.snapshots.push(snapshot); },
    dailyStatsText: async (now) => `【今日统计】2026-09-09（北京时间，截至 ${formatCst(now).slice(11)}）\n派兵 0 次｜完成 0 趟`,
    saveShot: async (i, jpeg, at) => {
      const rel = `automation/wanlong/bot-shots/inst${i}-${at}.jpg`;
      w.savedShots.push(`${rel}:${jpeg.byteLength}`);
      return rel;
    },
    log: (level, message) => { w.logs.push(`[${level}] ${message}`); },
  };
}

async function rejects(fn: () => Promise<unknown>): Promise<Error & { code?: string }> {
  try { await fn(); } catch (error) { return error as Error & { code?: string }; }
  throw new Error('应当失败');
}

describe('一、账号列表', () => {
  it('builds one row per account with binding, AVD state, queue, auto and pause reason', async () => {
    const w = makeWorld();
    const rows = buildAccountRows(w.accounts, w.instances, (i) => w.states.get(i) ?? emptyInstanceState(i), (i) => w.pauses.get(i) ?? { paused: false, reason: null });
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ instanceName: 'Pixel-0', instanceState: 'running', queueUsed: 4, queueTotal: 5, auto: true });
    expect(rows[1]).toMatchObject({ instanceIndex: null, auto: null, lastSampledAt: null });
    expect(rows[2]).toMatchObject({ pausedReason: '疑似被顶号', lastSampledAt: null, lastSampleOk: null });
  });

  it('renders names, 未绑定实例, 运行中 / 未运行, the pause reason and the Beijing clock', async () => {
    const w = makeWorld();
    const r = await createBotActions(depsOf(w)).perform('accounts', null);
    for (const part of ['主号', '小号', '未绑定实例', '运行中', '未运行', '疑似被顶号']) expect(r.text).toContain(part);
    expect(r.text.split('\n')[0]).toContain('21:22:33');
    expect(r.photo).toBeUndefined();
    expect(r.showMenu).toBeFalsy();
  });

  it('flags a binding whose AVD was recreated instead of inheriting it by index', async () => {
    const w = makeWorld();
    w.accounts = [account('旧号', 0, true, 'avd-old')];
    const rows = buildAccountRows(w.accounts, w.instances, () => emptyInstanceState(0), () => ({ paused: false, reason: null }));
    expect(rows[0]).toMatchObject({ instanceIndex: 0, bindingStale: true, auto: null, instanceName: null });
    const r = await createBotActions(depsOf(w)).perform('accounts', null);
    expect(r.text).toContain('绑定已失效');
  });

  it('lists bound instances only, sorted, with account names; with nothing bound every non-base AVD', async () => {
    const w = makeWorld();
    expect(await createBotActions(depsOf(w)).listInstances()).toEqual([{ index: 0, name: '主号' }, { index: 2, name: '三号' }]);
    const empty = createBotActions({ ...depsOf(w), accounts: async () => [] });
    expect(await empty.listInstances()).toEqual([{ index: 0, name: null }, { index: 2, name: null }]);
    const none = createBotActions({ ...depsOf(w), accounts: async () => [], instances: async () => [] });
    expect(await none.listInstances()).toEqual([]);
  });
});

describe('二、状态', () => {
  it('status:all covers every instance with queue, marches, next wake, last read, pause and the Beijing clock', async () => {
    const w = makeWorld();
    const all = await createBotActions(depsOf(w)).perform('status', null);
    expect(all.text).toContain('实例 0「主号」');
    expect(all.text).toContain('实例 2「三号」');
    expect(all.text).toContain('队列 4/5，在途 1 支');
    expect(all.text).toContain('下次唤醒：21:30:33（约 8 分钟后）');
    expect(all.text).toContain('上次读面板：21:20:33');
    expect(all.text).toContain('⛔ 已暂停：疑似被顶号');
    expect(all.text.endsWith('（北京时间 21:22:33）')).toBe(true);
  });

  it('one instance, an unknown instance, and a text without an account name', async () => {
    const w = makeWorld();
    const port = createBotActions(depsOf(w));
    const one = await port.perform('status', 2);
    expect(one.text).toContain('实例 2');
    expect(one.text).not.toContain('实例 0');
    const error = await rejects(() => port.perform('status', 7));
    expect(error.message).toContain('没有这个实例，可用：0, 2');
    expect(describeInstanceText(0, w.states.get(0)!, { paused: false, reason: null }, null, NOW).startsWith('实例 0\n')).toBe(true);
  });
});

describe('三、截图', () => {
  it('captures inside the lock and returns a photo named in Beijing time with a full caption', async () => {
    const w = makeWorld();
    const r = await createBotActions(depsOf(w)).perform('shot', 0);
    expect(w.exclusiveCalls).toContainEqual({ index: 0, what: '截图' });
    expect(w.trace.indexOf('lock:0:截图')).toBeLessThan(w.trace.indexOf('capture:0'));
    expect(w.trace.indexOf('capture:0')).toBeLessThan(w.trace.indexOf('unlock:0:截图'));
    expect(r.text).toBe('');
    expect(r.photo?.jpeg.byteLength).toBe(2048);
    expect(r.photo?.filename).toMatch(/^inst0-20260909-212233\.jpg$/);
    const caption = r.photo!.caption;
    expect(caption).toContain('实例 0「主号」截图');
    expect(caption).toContain(formatCst(NOW));
    expect(caption).toContain('前台：游戏（');
    expect(caption).toContain('游戏进程：存活');
    expect(caption).toContain('队列 4/5｜自动调度 开');
    expect(caption.length).toBeLessThanOrEqual(1024);
    expect(w.savedShots).toHaveLength(1);
    expect(w.savedShots[0]!.endsWith(':2048')).toBe(true);
  });

  it('a failed audit copy still returns the photo and only warns', async () => {
    const w = makeWorld();
    const port = createBotActions({ ...depsOf(w), saveShot: async () => { throw new Error('磁盘满了'); } });
    const r = await port.perform('shot', 0);
    expect(r.photo).toBeDefined();
    expect(w.logs.some((line) => line.startsWith('[warn]') && line.includes('磁盘满了'))).toBe(true);
  });

  it('a paused instance carries the ⛔ line; a foreground that is not the game is flagged, not refused', async () => {
    const w = makeWorld();
    w.instances[1] = instance(2, 'Pixel-2', 'running');
    const port = createBotActions({ ...depsOf(w), captureShot: async () => ({ jpeg: fakeJpeg(64), at: NOW, foreground: 'com.android.launcher3', gameRunning: false }) });
    const r = await port.perform('shot', 2);
    expect(r.photo?.caption).toContain('⛔ 已暂停：疑似被顶号');
    expect(r.photo?.caption).toContain('★ 不是游戏：com.android.launcher3');
    expect(r.photo?.caption).toContain('游戏进程：★ 不在');
  });

  it('refuses before the lock when the emulator is not running', async () => {
    const w = makeWorld();
    const error = await rejects(() => createBotActions(depsOf(w)).perform('shot', 2));
    expect(error.code).toBe('DEVICE_NOT_READY');
    expect(error.message).toContain('没有在运行');
    expect(w.exclusiveCalls).toEqual([]);
  });
});

describe('四、资源统计', () => {
  it('reads inside the lock, records one snapshot and renders four resources with the precision note', async () => {
    const w = makeWorld();
    const r = await createBotActions(depsOf(w)).perform('resources', 0);
    expect(w.exclusiveCalls).toContainEqual({ index: 0, what: '读资源统计' });
    expect(w.trace.indexOf('lock:0:读资源统计')).toBeLessThan(w.trace.indexOf('readres:0'));
    expect(w.trace.indexOf('readres:0')).toBeLessThan(w.trace.indexOf('unlock:0:读资源统计'));
    expect(w.snapshots).toHaveLength(1);
    expect(w.snapshots[0]).toMatchObject({ instanceIndex: 0, at: NOW });
    for (const name of ['金币', '木材', '铁矿石', '魔水']) expect(r.text).toContain(name);
    expect(r.text).toContain('11.1亿');
    expect(r.text).toContain('22.4亿');
    expect(r.text).toContain('「主号」');
    expect(r.text).toContain(formatCst(NOW));
    expect(r.text).toContain('精度 0.1亿');
  });

  it('a failing statistics record only warns; no record port and no reader port are fine', async () => {
    const w = makeWorld();
    const r = await createBotActions({ ...depsOf(w), recordSnapshot: () => { throw new Error('统计炸了'); } }).perform('resources', 0);
    expect(r.text).toContain('金币');
    expect(w.logs.some((line) => line.includes('统计炸了'))).toBe(true);
    const w3 = makeWorld();
    expect((await createBotActions({ ...depsOf(w3), recordSnapshot: undefined }).perform('resources', 0)).text).toContain('魔水');
    const w4 = makeWorld();
    const unavailable = await createBotActions({ ...depsOf(w4), readResources: undefined }).perform('resources', 0);
    expect(unavailable.text).toContain('还没有接入');
    expect(w4.exclusiveCalls).toEqual([]);
  });
});

describe('五、暂停 / 恢复 / 重启 / 菜单 / 统计', () => {
  it('pause switches auto off without the lock and records no statistics event itself', async () => {
    const w = makeWorld();
    const p = await createBotActions(depsOf(w)).perform('pause', 0);
    expect(w.trace).toContain('pause:0');
    expect(w.exclusiveCalls).toEqual([]);
    expect(p.text).toContain('/resume 0');
  });

  it('resume runs outside the lock and answers with the new status', async () => {
    const w = makeWorld();
    const r = await createBotActions(depsOf(w)).perform('resume', 2);
    expect(w.trace).toContain('resume:2');
    expect(w.exclusiveCalls).toEqual([]);
    expect(r.text).toContain('已恢复实例 2');
    expect(r.text).toContain('自动调度：开');
  });

  it('relaunch: recover inside the lock, resume after the unlock', async () => {
    const w = makeWorld();
    const rl = await createBotActions(depsOf(w)).perform('relaunch', 0);
    const at = (step: string): number => w.trace.indexOf(step);
    expect(at('lock:0:重启游戏')).toBeLessThan(at('recover:0'));
    expect(at('recover:0')).toBeLessThan(at('unlock:0:重启游戏'));
    expect(at('unlock:0:重启游戏')).toBeLessThan(at('resume:0'));
    expect(rl.text).toContain('点掉顶号弹窗');
    expect(rl.text).toContain('已恢复实例 0');
  });

  it('relaunch reports the done steps when only the resume fails', async () => {
    const w = makeWorld();
    const port = createBotActions({ ...depsOf(w), resumeInstance: async () => { throw new Error('首次开启自动续跑前需要只读探针通过'); } });
    const rl = await port.perform('relaunch', 0);
    expect(rl.text).toContain('已处理：点掉顶号弹窗');
    expect(rl.text).toContain('恢复自动调度没有成功：首次开启自动续跑前需要只读探针通过');
  });

  it('menu shows the keyboard; stats answers today in Beijing time, or says it is not wired yet', async () => {
    const w = makeWorld();
    const port = createBotActions(depsOf(w));
    const m = await port.perform('menu', null);
    expect(m.showMenu).toBe(true);
    expect(m.text.length).toBeGreaterThan(0);
    const s = await port.perform('stats', null);
    expect(s.text).toContain('派兵 0 次');
    expect(s.text).toContain('2026-09-09');
    const missing = await createBotActions({ ...depsOf(w), dailyStatsText: undefined }).perform('stats', null);
    expect(missing.text).toContain('还没有接入');
    expect(missing.text).toContain('21:22:33');
  });
});

describe('六、错误', () => {
  it('a required action without an index asks for a selection (INVALID_ARGUMENT)', async () => {
    const port = createBotActions(depsOf(makeWorld()));
    for (const action of ['shot', 'resources', 'resume', 'relaunch', 'pause'] as const) {
      const error = await rejects(() => port.perform(action, null));
      expect(error.message).toContain('请先选择');
      expect(error.code).toBe('INVALID_ARGUMENT');
    }
  });

  it('an unknown instance is refused before any lock or capture', async () => {
    const w = makeWorld();
    const error = await rejects(() => createBotActions(depsOf(w)).perform('shot', 5));
    expect(error.message).toContain('没有这个实例，可用：0, 2');
    expect(error.code).toBe('NOT_FOUND');
    expect(w.exclusiveCalls).toEqual([]);
    expect(w.trace.some((step) => step.startsWith('capture'))).toBe(false);
  });

  it('a busy instance refusal reaches the user unchanged, with its code and no capture', async () => {
    const w = makeWorld();
    w.busy = true;
    const port = createBotActions(depsOf(w));
    const busy = await rejects(() => port.perform('shot', 0));
    expect(busy.message).toContain('稍后再试');
    expect(busy.code).toBe('CONCURRENCY_LIMIT');
    expect(w.trace.some((step) => step.startsWith('capture'))).toBe(false);
    expect((await rejects(() => port.perform('resources', 0))).message).toContain('读资源统计稍后再试');
  });

  it('callback data res:2 runs resources on instance 2', async () => {
    const w = makeWorld();
    w.instances[1] = instance(2, 'Pixel-2', 'running');
    const cb = parseCallbackData('res:2');
    expect(cb).toEqual({ action: 'resources', instanceIndex: 2 });
    const r = await createBotActions(depsOf(w)).perform(cb!.action, cb!.instanceIndex);
    expect(r.text).toContain('实例 2「三号」资源统计');
  });
});

describe('七、bot IPC domain', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const appUrl = `${pathToFileURL(join(here, '..', '..', '..', 'packages', 'emulator-shell', 'src', 'renderer', 'index.html')).href}#/`;
  const w = makeWorld();
  const port = createBotActions(depsOf(w));
  const remoteBot = { actions: port, status: () => ({ running: false, readEnabled: false, controlEnabled: false, problem: null, since: null }) };
  const invoke = (method: string, ...args: unknown[]): Promise<unknown> => {
    const handler = handlers.get(wanlongInvokeChannel(method as never)) as ((event: unknown, ...rest: unknown[]) => Promise<unknown>) | undefined;
    if (!handler) throw new Error(`未注册 ${method}`);
    return handler({ sender: { id: 1 }, senderFrame: { url: appUrl } }, ...args);
  };

  beforeAll(() => {
    registerWanlongIpcHandlers({ remoteBot, windows: { kindOf: () => 'main' } } as unknown as WanlongServices);
  });

  it('declares botPerform / botInstances / botStatus in the assistant contract, not the shell one', () => {
    for (const method of ['botPerform', 'botInstances', 'botStatus']) {
      expect(BOT_METHODS).toContain(method);
      expect(WANLONG_INVOKE_METHODS).toContain(method);
      expect((INVOKE_METHODS as readonly string[]).includes(method)).toBe(false);
      expect(handlers.has(`wanlong:${method}`)).toBe(true);
    }
  });

  it('runs the same action port and keeps the photo bytes as a Uint8Array', async () => {
    expect(await invoke('botInstances')).toEqual({ ok: true, value: [{ index: 0, name: '主号' }, { index: 2, name: '三号' }] });
    const accounts = await invoke('botPerform', 'accounts', null) as { ok: true; value: { text: string } };
    expect(accounts.value.text).toContain('主号');
    const shot = await invoke('botPerform', 'shot', 0) as { ok: true; value: { photo?: { jpeg: Uint8Array } } };
    expect(shot.value.photo?.jpeg).toBeInstanceOf(Uint8Array);
    expect(shot.value.photo?.jpeg.byteLength).toBe(2048);
    expect(await invoke('botStatus')).toMatchObject({ ok: true, value: { running: false } });
  });

  it('returns failures as an envelope with the code and the Chinese message; validates arguments first', async () => {
    expect(await invoke('botPerform', 'shot', null)).toEqual({ ok: false, error: { message: '请先选择账号/实例。', code: 'INVALID_ARGUMENT' } });
    expect(await invoke('botPerform', 'reboot', 0)).toEqual({ ok: false, error: { message: '机器人动作无效' } });
    expect(await invoke('botPerform', 'status', 99)).toMatchObject({ ok: false });
  });
});
