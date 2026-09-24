/**
 * The install gate's busy check (the original `busy: () => instanceAccess.anyBusy()`): the SDK install in front of the
 * app shell's instance occupancy table, which is the only source of "who holds an instance". Gather runs, script plans,
 * login wizards, labelled leases and another process's lease block; an enabled schedule or enabled plans do not; a
 * source that cannot be read fails closed.
 * Every section builds the table as `main/index.ts` does (`InstanceOccupancy` + `registerServiceOccupancy()`); the last
 * one runs it over a real `AutomationHost` with a real schedule.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRuntimeState, wanlongPlugin, type GatherCycleResult } from '@avdm/automation/wanlong';
import { AutomationHost } from '../src/main/automation/host';
import { loginActive, type LoginPhase } from '../src/main/automation/accounts/types';
import { InstanceAccess, instanceAccess, instanceLeasePath, readLeaseOwner, readLeaseOwners, withLabelledLease } from '../src/main/app/instance-access';
import { InstanceOccupancy, OccupancyUnknownError } from '../src/main/app/occupancy';
import { registerServiceOccupancy, type ServiceOccupancyDeps } from '../src/main/app/service-occupancy';
import type { ManagerHost } from '../src/main/manager-host';
import { SDK_INSTALL_BUSY, updateBusyCheck } from '../src/main/update/busy';
import { BUSY_UNKNOWN, UpdateCenter } from '../src/main/update/center';

const { broadcast } = vi.hoisted(() => ({ broadcast: vi.fn() }));
vi.mock('../src/main/events', () => ({ broadcast }));

type Run = { index: number; status: string };

let home: string;
beforeEach(async () => {
  broadcast.mockReset();
  home = await mkdtemp(path.join(tmpdir(), 'avdm-update-busy-'));
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

/** The occupancy table exactly as `main/index.ts` builds it (in-process table, leases under `home`, service sources). */
function occupancyTable(services: Omit<ServiceOccupancyDeps, 'gameId'>, access: InstanceAccess = instanceAccess, pid?: number) {
  const occupancy = new InstanceOccupancy({
    access,
    leaseOwner: (index) => readLeaseOwner(home, index),
    leaseOwners: () => readLeaseOwners(home),
    ...(pid !== undefined ? { pid } : {}),
  });
  registerServiceOccupancy(occupancy, { ...services, gameId: 'wanlong' });
  return occupancy;
}

/** Idle fake services on instances 0–7; `extra` overrides one of them. */
function services(extra: Partial<Omit<ServiceOccupancyDeps, 'gameId'>> = {}, runs: Run[] = []): Omit<ServiceOccupancyDeps, 'gameId'> {
  return {
    instanceIndices: async () => [0, 1, 2, 3, 4, 5, 6, 7],
    automation: { runs: async () => runs, schedules: async () => [] },
    plans: { isActiveForInstance: () => false, hasEnabledPlanForInstance: async () => false },
    accounts: { loginActiveOn: () => false },
    ...extra,
  };
}

describe('updateBusyCheck', () => {
  it('SDK 安装排在最前（它不属于任何实例）；否则问实例占用表；都闲为 null', async () => {
    const sdk = { active: false };
    let answer: string | null = null;
    const check = updateBusyCheck({ occupancy: { anyBusy: async () => answer }, sdkInstall: sdk });
    expect(await check()).toBeNull();
    answer = '实例 #2 正在运行采集。';
    expect(await check()).toBe('实例 #2 正在运行采集。');
    sdk.active = true;
    expect(await check()).toBe(SDK_INSTALL_BUSY);
    sdk.active = false;
    answer = '';
    expect(await check()).toBeNull();
  });

  it('占用表读不出来时把错误交给更新中心（由它按占用处理）', async () => {
    const check = updateBusyCheck({ occupancy: { anyBusy: async () => { throw new Error('占用表坏了'); } }, sdkInstall: { active: false } });
    await expect(check()).rejects.toThrow('占用表坏了');
  });
});

describe('闸门问的是实例占用表（与 main/index.ts 同样的登记）', () => {
  const gateOver = (occupancy: InstanceOccupancy) => updateBusyCheck({ occupancy, sdkInstall: { active: false } });

  it('采集：运行中与停止中算占用，结束的不算', async () => {
    const runs: Run[] = [
      { index: 4, status: 'succeeded' }, { index: 5, status: 'failed' }, { index: 6, status: 'cancelled' },
      { index: 3, status: 'stopping' }, { index: 1, status: 'running' },
    ];
    expect(await gateOver(occupancyTable(services({}, runs), new InstanceAccess()))()).toBe('实例 #1 正在运行采集。');
    expect(await gateOver(occupancyTable(services({}, runs.filter((run) => run.index !== 1)), new InstanceAccess()))())
      .toBe('实例 #3 正在停止采集。');
  });

  it('脚本计划：执行中或排队中的实例（管理器知道的每个实例都问到）', async () => {
    const active = new Set([2, 7]);
    const check = gateOver(occupancyTable(services({
      plans: { isActiveForInstance: (index) => active.has(index), hasEnabledPlanForInstance: async () => false },
    }), new InstanceAccess()));
    expect(await check()).toBe('实例 #2 正在运行脚本计划。');
    active.delete(2);
    expect(await check()).toBe('实例 #7 正在运行脚本计划。');
    active.clear();
    expect(await check()).toBeNull();
  });

  it('账号登录：只算进行中的阶段（准备 / 启动 / 等待登录 / 验证）', async () => {
    const phases = new Map<number, LoginPhase>([[1, 'failed'], [4, 'completed'], [5, 'awaitingLogin'], [6, 'cancelled']]);
    const occupancy = occupancyTable(services({
      accounts: { loginActiveOn: (index) => phases.has(index) && loginActive(phases.get(index)!) },
    }), new InstanceAccess());
    expect(await gateOver(occupancy)()).toBe('实例 #5 正在进行账号登录。');
    phases.set(5, 'verifying');
    phases.set(3, 'preparing');
    expect(await gateOver(occupancy)()).toBe('实例 #3 正在进行账号登录。');
    phases.delete(3);
    phases.delete(5);
    expect(await gateOver(occupancy)()).toBeNull();
  });

  it('★ 开着的自动化（自动续跑、已启用的脚本计划）不算忙，但仍登记在表里（停止实例前要确认）', async () => {
    const occupancy = occupancyTable(services({
      automation: { runs: async () => [], schedules: async () => [{ index: 3, enabled: true }, { index: 4, enabled: false }] },
      plans: { isActiveForInstance: () => false, hasEnabledPlanForInstance: async (gameId, index) => gameId === 'wanlong' && index === 6 },
    }), new InstanceAccess());
    expect(await gateOver(occupancy)()).toBeNull();
    expect(await occupancy.holders(3)).toEqual([{ index: 3, label: '自动采集已开启', source: 'schedule', blocking: false }]);
    expect(await occupancy.holders(6)).toEqual([{ index: 6, label: '已启用脚本计划', source: 'plans', blocking: false }]);
  });

  it('带标签的租约（改模板、克隆、之后移植的调度器 / 卡死恢复……）持有期间算忙，释放后不算', async () => {
    const occupancy = occupancyTable(services(), new InstanceAccess());
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    const lease = withLabelledLease(home, 2, '修改模板或采集配置', async () => { entered(); await held; }, { timeoutMs: 200 });
    await inside;
    // The occupancy table of main/index.ts reads the process-wide in-process table, which the lease registers in.
    expect(await gateOver(occupancyTable(services()))()).toBe('实例 #2 正在修改模板或采集配置。');
    // Without that table the lease file alone still blocks (as it would for another assistant process).
    expect(await gateOver(occupancy)()).toBe('实例 #2 正在修改模板或采集配置。');
    release();
    await lease;
    expect(await gateOver(occupancyTable(services()))()).toBeNull();
  });

  it('另一个助手进程持有的租约算忙', async () => {
    const lock = instanceLeasePath(home, 9);
    await mkdir(lock, { recursive: true });
    await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ label: '运行采集', pid: 1, at: Date.now() }));
    expect(await gateOver(occupancyTable(services(), new InstanceAccess(), 99))()).toBe('实例 #9 正在运行采集（另一个助手进程）。');
  });

  it('★ 读不出的来源从严：没有已知的占用者时按「无法确认」拒绝安装；已知有人占用时照常说是谁', async () => {
    const onSourceError = vi.fn();
    const occupancy = new InstanceOccupancy({ access: new InstanceAccess(), leaseOwners: () => readLeaseOwners(home), onSourceError });
    registerServiceOccupancy(occupancy, {
      ...services(), gameId: 'wanlong',
      automation: { runs: async () => { throw new Error('运行记录读不出'); }, schedules: async () => [] },
    });
    const check = gateOver(occupancy);
    await expect(check()).rejects.toBeInstanceOf(OccupancyUnknownError);
    await expect(check()).rejects.toThrow('占用来源 gather 读取失败');
    expect(onSourceError).toHaveBeenCalledWith('gather', expect.any(Error));
    // The update center turns that into 「无法确认是否有任务在运行。」 and refuses.
    const center = new UpdateCenter();
    center.init({
      currentVersion: () => '0.3.0', packaged: () => true, supportedPlatform: () => true, busy: check,
      releasePageUrl: () => 'https://github.com/TgolMsk/AndroidAutomation/releases/latest',
      openExternal: async () => undefined,
      updater: () => { throw new Error('不应构造更新器'); },
      quit: () => undefined, publish: () => undefined, log: () => undefined,
    });
    expect(await center.refreshBusy()).toMatchObject({ installable: false, busyReason: BUSY_UNKNOWN });
    // A known blocking holder is still named (it is busy either way).
    occupancy.register('login', async () => [{ index: 1, label: '进行账号登录', source: 'login', blocking: true }]);
    expect(await check()).toBe('实例 #1 正在进行账号登录。');
    // The lifecycle guard keeps answering with what it could read.
    expect(await occupancy.holders(1)).toEqual([{ index: 1, label: '进行账号登录', source: 'login', blocking: true }]);
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
  let host: AutomationHost;
  let releaseStop!: () => void;
  let runner: ReturnType<typeof controlledRunner>;
  let gate: () => Promise<string | null>;
  const sdkInstall = { active: false };

  beforeEach(async () => {
    const stopGate = new Promise<void>((resolve) => { releaseStop = resolve; });
    runner = controlledRunner(stopGate);
    const manager = {
      getState: async () => ({ status: 'running', record: { createdAt: '2026-09-23T00:00:00Z' } }),
      device: async () => ({ foregroundPackage: async () => wanlongPlugin.packageName }),
    };
    host = new AutomationHost({ get: async () => manager } as unknown as ManagerHost, home, runner);
    await host.saveSettings('wanlong', 1, { templateDir: home, config: { version: 2, enabled: true } });
    // Idle plans and login wizards, as in a fresh assistant; the automation side and the occupancy table are real.
    const occupancy = occupancyTable({
      instanceIndices: async () => [0, 1],
      automation: host,
      plans: { isActiveForInstance: () => false, hasEnabledPlanForInstance: async () => false },
      accounts: { loginActiveOn: () => false },
    });
    gate = updateBusyCheck({ occupancy, sdkInstall });
  });

  afterEach(async () => {
    releaseStop();
    await host.dispose();
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
