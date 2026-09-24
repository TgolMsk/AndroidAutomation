/**
 * The install gate's busy check (the original `busy: () => instanceAccess.anyBusy()`): the SDK install in front of
 * the instance answer; gather runs, script plans and login wizards hold an instance, an enabled schedule does not.
 * The last section builds the gate exactly as `main/index.ts` does, over a real `AutomationHost` with a real schedule.
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
  INSTANCE_SLOTS, SDK_INSTALL_BUSY, instanceHolders, interimInstanceBusy, updateBusyCheck, type InstanceBusyServices,
} from '../src/main/update/busy';
import { UpdateCenter } from '../src/main/update/center';

const { broadcast } = vi.hoisted(() => ({ broadcast: vi.fn() }));
vi.mock('../src/main/events', () => ({ broadcast }));

type Run = { index: number; status: string };

function services(extra: Partial<InstanceBusyServices<LoginPhase>> = {}, runs: Run[] = []): InstanceBusyServices<LoginPhase> {
  return {
    automation: { runs: async () => runs },
    plans: { isActiveForInstance: () => false },
    accounts: { loginSession: () => null },
    loginActive,
    ...extra,
  };
}

describe('updateBusyCheck', () => {
  it('SDK 安装排在最前（它不属于任何实例）；否则问实例占用；都闲为 null', async () => {
    const sdk = { active: false };
    let instances: string | null = null;
    const check = updateBusyCheck({ instances: async () => instances, sdkInstall: sdk });
    expect(await check()).toBeNull();
    instances = '实例 #2 正在运行采集。';
    expect(await check()).toBe('实例 #2 正在运行采集。');
    sdk.active = true;
    expect(await check()).toBe(SDK_INSTALL_BUSY);
    sdk.active = false;
    instances = '';
    expect(await check()).toBeNull();
  });

  it('实例占用读不出来时把错误交给更新中心（由它按占用处理）', async () => {
    const check = updateBusyCheck({ instances: async () => { throw new Error('占用表坏了'); }, sdkInstall: { active: false } });
    await expect(check()).rejects.toThrow('占用表坏了');
  });
});

describe('实例占用（占用表的替身，与占用表同样的措辞）', () => {
  it('采集：运行中与停止中算占用，结束的不算', async () => {
    const runs: Run[] = [
      { index: 4, status: 'succeeded' }, { index: 5, status: 'failed' }, { index: 6, status: 'cancelled' },
      { index: 3, status: 'stopping' }, { index: 1, status: 'running' },
    ];
    expect(await instanceHolders(services({}, runs))).toEqual([
      { index: 1, label: '运行采集' }, { index: 3, label: '停止采集' },
    ]);
    expect(await interimInstanceBusy(services({}, runs))()).toBe('实例 #1 正在运行采集。');
  });

  it('脚本计划：执行中或排队中的实例；覆盖全部 64 个序号', async () => {
    const active = new Set([2, INSTANCE_SLOTS - 1]);
    const check = interimInstanceBusy(services({ plans: { isActiveForInstance: (index) => active.has(index) } }));
    expect(await check()).toBe('实例 #2 正在运行脚本计划。');
    active.delete(2);
    expect(await check()).toBe('实例 #63 正在运行脚本计划。');
    active.clear();
    expect(await check()).toBeNull();
  });

  it('账号登录：只算进行中的阶段（准备 / 启动 / 等待登录 / 验证）', async () => {
    const phases = new Map<number, LoginPhase>([[1, 'awaitingLogin'], [4, 'failed'], [6, 'completed'], [7, 'preparing'], [8, 'cancelled']]);
    const holders = await instanceHolders(services({
      accounts: { loginSession: (index) => (phases.has(index) ? { phase: phases.get(index)! } : null) },
    }));
    expect(holders).toEqual([{ index: 1, label: '进行账号登录' }, { index: 7, label: '进行账号登录' }]);
  });
});

// ── The gate as main/index.ts builds it, over a real AutomationHost ────────────────────────────────────────

function result(outcome: GatherCycleResult['outcome'], message: string): GatherCycleResult {
  return {
    outcome, message, dispatched: [], queue: null, nextWakeAt: Date.now() + 60_000,
    nextWakeReason: '建议一分钟后检查', captures: 1, state: createRuntimeState(), warnings: [],
  };
}

/** Each cycle waits for `finish()`; a stop waits for `stopGate` (to observe the 'stopping' state). */
function controlledRunner(stopGate: Promise<void>) {
  let resolve: ((value: GatherCycleResult) => void) | null = null;
  const finish = (value: GatherCycleResult) => { resolve?.(value); resolve = null; };
  return {
    runOnce: vi.fn((_index: number) => new Promise<GatherCycleResult>((yes) => { resolve = yes; })),
    stop: vi.fn(async (_index: number) => { await stopGate; finish(result('cancelled', '采集已取消')); }),
    dispose: vi.fn(async () => { finish(result('cancelled', '采集已取消')); }),
    isRunning: vi.fn((_index: number) => false),
    finish,
  };
}

describe('安装闸门接在真实的 AutomationHost 上（与 main/index.ts 同样的接法）', () => {
  let home: string;
  let host: AutomationHost;
  let releaseStop!: () => void;
  let runner: ReturnType<typeof controlledRunner>;
  let gate: () => Promise<string | null>;
  const sdkInstall = { active: false };

  beforeEach(async () => {
    broadcast.mockReset();
    home = await mkdtemp(path.join(tmpdir(), 'avdm-update-busy-'));
    const stopGate = new Promise<void>((resolve) => { releaseStop = resolve; });
    runner = controlledRunner(stopGate);
    const manager = {
      getState: async () => ({ status: 'running', record: { createdAt: '2026-09-23T00:00:00Z' } }),
      device: async () => ({ foregroundPackage: async () => wanlongPlugin.packageName }),
    };
    host = new AutomationHost({ get: async () => manager } as unknown as ManagerHost, home, runner);
    await host.saveSettings('wanlong', 1, { templateDir: home, config: { version: 2, enabled: true } });
    // Idle plans and login wizards, as in a fresh assistant; the automation side is the real one.
    const plans = { isActiveForInstance: () => false };
    const accounts = { loginSession: (): { phase: LoginPhase } | null => null };
    gate = updateBusyCheck({ instances: interimInstanceBusy({ automation: host, plans, accounts, loginActive }), sdkInstall });
  });

  afterEach(async () => {
    releaseStop();
    await host.dispose();
    await rm(home, { recursive: true, force: true });
  });

  it('★ 只开着自动续跑（两轮之间没有在跑的一轮）不算忙；正在跑的那一轮算', async () => {
    vi.spyOn(host, 'probe').mockResolvedValue({
      gameId: 'wanlong', packageName: wanlongPlugin.packageName, foregroundPackage: wanlongPlugin.packageName,
      deviceWidth: 960, deviceHeight: 540, capturedAt: Date.now(), matches: [],
      launchReady: true, launchReason: 'known scene', timingsMs: {},
    });
    expect((await host.setSchedule('wanlong', 1, true)).enabled).toBe(true);
    // The first scheduled cycle holds the device while it runs.
    await vi.waitFor(() => expect(runner.runOnce).toHaveBeenCalledTimes(1));
    expect(await gate()).toBe('实例 #1 正在运行采集。');
    runner.finish(result('queueFull', '队列已满'));
    await vi.waitFor(async () => {
      expect((await host.schedules())[0]).toMatchObject({ gameId: 'wanlong', index: 1, enabled: true, nextWakeAt: expect.any(Number) });
      expect((await host.runs())[0]).toMatchObject({ status: 'succeeded' });
    });
    // Between cycles: the schedule is still on, nothing holds the device, installing is allowed.
    expect(await gate()).toBeNull();
    const center = new UpdateCenter();
    center.init({
      currentVersion: () => '0.3.0', packaged: () => true, supportedPlatform: () => true, busy: gate,
      releasePageUrl: () => 'https://github.com/TgolMsk/AndroidAutomation/releases/latest',
      openExternal: async () => undefined,
      updater: () => { throw new Error('不应构造更新器'); },
      quit: () => undefined, publish: () => undefined, log: () => undefined,
    });
    expect(await center.refreshBusy()).toMatchObject({ installable: true, busyReason: null });
    // The SDK install still blocks on top of it.
    sdkInstall.active = true;
    expect(await gate()).toBe(SDK_INSTALL_BUSY);
    sdkInstall.active = false;
  });

  it('手动采集：运行中与停止中都算占用，结束后不算', async () => {
    expect(await gate()).toBeNull();
    const run = await host.run('wanlong', 'gather-once', 1);
    expect(await gate()).toBe('实例 #1 正在运行采集。');
    const stopping = host.stop(run.runId);
    await vi.waitFor(async () => expect((await host.runs())[0]?.status).toBe('stopping'));
    expect(await gate()).toBe('实例 #1 正在停止采集。');
    releaseStop();
    await stopping;
    expect((await host.runs())[0]?.status).toBe('cancelled');
    expect(await gate()).toBeNull();
  });

  it('跑完的一轮不算占用', async () => {
    await host.run('wanlong', 'gather-once', 1);
    runner.finish(result('dispatched', '已完成本轮采集'));
    await vi.waitFor(async () => expect((await host.runs())[0]?.status).toBe('succeeded'));
    expect(await gate()).toBeNull();
  });
});
