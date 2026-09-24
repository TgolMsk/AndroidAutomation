/**
 * The install gate's busy aggregation (the original `instanceAccess.anyBusy()`): gather runs, script plans, login
 * wizards and the SDK install hold the assistant; an enabled schedule on its own does not.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRuntimeState, wanlongPlugin, type GatherCycleResult } from '@avdm/automation/wanlong';
import { AutomationHost } from '../src/main/automation/host';
import { loginActive, type LoginPhase } from '../src/main/automation/accounts/types';
import type { ManagerHost } from '../src/main/manager-host';
import {
  BusyGate, INSTANCE_SLOTS, formatBusyReason, gatherRunProbe, loginProbe, planRunProbe, sdkInstallProbe,
} from '../src/main/update/busy';

const { broadcast } = vi.hoisted(() => ({ broadcast: vi.fn() }));
vi.mock('../src/main/events', () => ({ broadcast }));

describe('BusyGate', () => {
  it('没有任何占用时为 null', () => {
    const gate = new BusyGate();
    expect(gate.reason()).toBeNull();
    gate.register('空', () => []);
    gate.register('空2', () => null);
    expect(gate.reason()).toBeNull();
  });

  it('点名是谁占着，全局任务排在前面，最多列三项', () => {
    expect(formatBusyReason([{ index: 0, activity: '运行采集' }])).toBe('实例 #0 正在运行采集。');
    const gate = new BusyGate();
    gate.register('采集', () => [{ index: 3, activity: '运行采集' }, { index: 1, activity: '运行采集' }]);
    gate.register('SDK', () => [{ index: null, activity: '安装 SDK 组件' }]);
    expect(gate.reason()).toBe('正在安装 SDK 组件；实例 #1 正在运行采集；实例 #3 正在运行采集。');
    gate.register('登录', () => [{ index: 5, activity: '登录账号' }]);
    expect(gate.reason()).toBe('正在安装 SDK 组件；实例 #1 正在运行采集；实例 #3 正在运行采集等 4 项任务。');
    expect(gate.holdersOf(5)).toEqual([{ index: 5, activity: '登录账号' }]);
  });

  it('★ 探针出错按占用处理（绝不因为读不到状态就放行安装）', () => {
    const gate = new BusyGate();
    gate.register('脚本计划', () => { throw new Error('boom'); });
    expect(gate.reason()).toContain('脚本计划');
  });

  it('重复登记报错；注销后不再参与', () => {
    const gate = new BusyGate();
    const off = gate.register('采集', () => [{ index: 0, activity: '运行采集' }]);
    expect(() => gate.register('采集', () => [])).toThrow('重复登记');
    off();
    expect(gate.reason()).toBeNull();
  });

  it('重复的占用只算一次', () => {
    const gate = new BusyGate();
    gate.register('a', () => [{ index: 0, activity: '运行采集' }]);
    gate.register('b', () => [{ index: 0, activity: '运行采集' }]);
    expect(gate.holders()).toHaveLength(1);
  });
});

describe('现有服务的探针', () => {
  it('脚本计划：执行中或排队中的实例', () => {
    const active = new Set([2]);
    const probe = planRunProbe({ isActiveForInstance: (index) => active.has(index) });
    expect([...probe()!]).toEqual([{ index: 2, activity: '运行脚本计划' }]);
    active.clear();
    expect([...probe()!]).toEqual([]);
  });

  it('账号登录：只算进行中的阶段（准备 / 启动 / 等待登录 / 验证）', () => {
    const phases = new Map<number, LoginPhase>([[1, 'awaitingLogin'], [4, 'failed'], [6, 'succeeded'], [7, 'preparing']]);
    const probe = loginProbe({ loginSession: (index) => (phases.has(index) ? { phase: phases.get(index)! } : null) }, loginActive);
    expect([...probe()!]).toEqual([{ index: 1, activity: '登录账号' }, { index: 7, activity: '登录账号' }]);
  });

  it('SDK 安装：只在进行中时算', () => {
    const sdk = { active: false };
    const probe = sdkInstallProbe(sdk);
    expect([...probe()!]).toEqual([]);
    sdk.active = true;
    expect([...probe()!]).toEqual([{ index: null, activity: '安装 SDK 组件' }]);
  });

  it('探针覆盖全部 64 个实例序号', () => {
    const probe = planRunProbe({ isActiveForInstance: (index) => index === INSTANCE_SLOTS - 1 });
    expect([...probe()!]).toEqual([{ index: 63, activity: '运行脚本计划' }]);
  });
});

function result(outcome: GatherCycleResult['outcome'], message: string): GatherCycleResult {
  return {
    outcome, message, dispatched: [], queue: null, nextWakeAt: Date.now() + 60_000,
    nextWakeReason: '建议一分钟后检查', captures: 1, state: createRuntimeState(), warnings: [],
  };
}

describe('采集运行探针（AutomationHost.activeRunIndices）', () => {
  let home: string;
  let host: AutomationHost;
  let resolveRun!: (value: GatherCycleResult) => void;
  let releaseStop!: () => void;

  beforeEach(async () => {
    broadcast.mockReset();
    home = await mkdtemp(path.join(tmpdir(), 'avdm-update-busy-'));
    const pending = new Promise<GatherCycleResult>((resolve) => { resolveRun = resolve; });
    const stopGate = new Promise<void>((resolve) => { releaseStop = resolve; });
    const runner = {
      runOnce: vi.fn(() => pending),
      stop: vi.fn(async () => { await stopGate; resolveRun(result('cancelled', '采集已取消')); }),
      dispose: vi.fn(async () => { resolveRun(result('cancelled', '采集已取消')); }),
      isRunning: vi.fn(() => false),
    };
    const manager = {
      getState: async () => ({ status: 'running', record: { createdAt: '2026-09-23T00:00:00Z' } }),
      device: async () => ({ foregroundPackage: async () => wanlongPlugin.packageName }),
    };
    host = new AutomationHost({ get: async () => manager } as unknown as ManagerHost, home, runner);
    await host.saveSettings('wanlong', 1, { templateDir: home, config: { version: 2, enabled: true } });
  });

  afterEach(async () => {
    releaseStop();
    await host.dispose();
    await rm(home, { recursive: true, force: true });
  });

  it('运行中与停止中都算占用，结束后不算', async () => {
    const gate = new BusyGate();
    gate.register('采集运行', gatherRunProbe(host));
    expect(gate.reason()).toBeNull();
    const run = await host.run('wanlong', 'gather-once', 1);
    expect(gate.reason()).toBe('实例 #1 正在运行采集。');
    const stopping = host.stop(run.runId);
    await vi.waitFor(async () => expect((await host.runs())[0]?.status).toBe('stopping'));
    expect(host.activeRunIndices()).toEqual([1]);
    releaseStop();
    await stopping;
    expect((await host.runs())[0]?.status).toBe('cancelled');
    expect(gate.reason()).toBeNull();
  });

  it('跑完的一轮不算占用', async () => {
    const gate = new BusyGate();
    gate.register('采集运行', gatherRunProbe(host));
    await host.run('wanlong', 'gather-once', 1);
    resolveRun(result('dispatched', '已完成本轮采集'));
    await vi.waitFor(async () => expect((await host.runs())[0]?.status).toBe('succeeded'));
    expect(gate.reason()).toBeNull();
  });

  it('★ 只开着自动续跑（两轮之间没有在跑的一轮）不算忙', () => {
    // The schedule on its own is a timer; the assistant restores it from disk when it is opened again. The probe
    // only reads runs in flight, so an enabled schedule between cycles never blocks an install.
    const between = { activeRunIndices: () => [], schedules: async () => [{ gameId: 'wanlong', index: 1, enabled: true }] };
    const gate = new BusyGate();
    gate.register('采集运行', gatherRunProbe(between));
    expect(gate.reason()).toBeNull();
  });
});
