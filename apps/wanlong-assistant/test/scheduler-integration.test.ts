/**
 * The ETA scheduler wired into the modules merged before it: the app shell's labelled instance leases, occupancy table
 * and device lanes; the accounts readiness gate and gather config; script preemption (DECISIONS A.4); the app settings'
 * shot policy; and the template-change feed that drops compiled templates in the vision workers.
 */
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProbeReport, RawFrame } from '@avdm/automation';
import { createRuntimeState, wanlongPlugin, type GatherCycleResult } from '@avdm/automation/wanlong';
import {
  InstanceAccess, InstanceBusyError, readLeaseOwner, withInstanceLease, withLabelledLease,
} from '../src/main/app/instance-access';
import { InstanceOccupancy } from '../src/main/app/occupancy';
import { registerServiceOccupancy } from '../src/main/app/service-occupancy';
import { AccountManager } from '../src/main/automation/accounts';
import { WanlongGatherRunner, type GatherAdbDevice, type GatherManager } from '../src/main/automation/gather-runner';
import { AutomationHost } from '../src/main/automation/host';
import { DeviceLanes } from '../src/main/device/lane';
import type { ManagerHost } from '../src/main/manager-host';
import { PlanService, ScriptRunner } from '../src/main/plans';
import type { PlanHostPort, ScriptDef } from '../src/main/plans/types';
import { InstanceLocks } from '../src/main/scheduler/instance-lock';
import type { MainToWorker, VisionRequest, WorkerToMain } from '../src/main/scheduler/vision-protocol';
import { FAST_PACING, eventually, fakeScriptDevice, fakeVision, inProcessWorkers } from './helpers/script-worker';

const { broadcast } = vi.hoisted(() => ({ broadcast: vi.fn() }));
vi.mock('../src/main/events', () => ({ broadcast }));

const PKG = wanlongPlugin.packageName;
const CREATED_AT = '2026-09-24T00:00:00.000Z';

let home: string;
beforeEach(async () => {
  broadcast.mockReset();
  home = await mkdtemp(path.join(tmpdir(), 'avdm-scheduler-integration-'));
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

function frame(width = 1, height = 1): RawFrame {
  return { width, height, format: 1, capturedAt: Date.now(), data: new Uint8Array(width * height * 4) };
}

function cycle(outcome: GatherCycleResult['outcome'] = 'queueFull'): GatherCycleResult {
  return {
    outcome, message: outcome, dispatched: [], queue: { used: 5, total: 5 }, nextWakeAt: null, nextWakeReason: 'test',
    captures: 1, state: createRuntimeState(), warnings: [],
  };
}

function knownScene(): ProbeReport {
  return {
    gameId: 'wanlong', packageName: PKG, foregroundPackage: PKG, foregroundMatches: true,
    templateSet: { id: 'set', name: 'set', refWidth: 2560, refHeight: 1440 }, frame: { width: 960, height: 540, capturedAt: 1 },
    matches: [
      ['tpl_world_search_icon', false, 0.2], ['tpl_nav_map_toggle', true, 0.94], ['tpl_nav_map_toggle_b', false, 0.25], ['tpl_panel_title_troop', false, 0.22],
    ].map(([templateId, found, score]) => ({
      templateId: templateId as string, found: found as boolean, score: score as number, threshold: 0.8,
      x: 1, y: 1, w: 1, h: 1, centerX: 1, centerY: 1, elapsedMs: 1,
    })),
    timingMs: { capture: 1, prepare: 1, match: 1, total: 3 },
  };
}

type Script = (message: MainToWorker, worker: FakeWorker) => void;

/** The vision-worker protocol from the worker side; `script` reacts to what main sends. */
class FakeWorker extends EventEmitter {
  readonly sent: MainToWorker[] = [];
  jobId = 0;
  private nextId = 1;
  constructor(private readonly script: Script) { super(); }
  postMessage(message: MainToWorker): void {
    this.sent.push(message);
    if (message.type === 'job') this.jobId = message.jobId;
    queueMicrotask(() => this.script(message, this));
  }
  ready(): void { this.emit('message', { type: 'ready', jobId: this.jobId, probe: knownScene() } satisfies WorkerToMain); }
  request(request: VisionRequest): void { this.emit('message', { type: 'request', jobId: this.jobId, id: this.nextId++, ...request } as WorkerToMain); }
  shot(label: string): void { this.emit('message', { type: 'shot', jobId: this.jobId, label, raw: frame(8, 8) } satisfies WorkerToMain); }
  finish(value = cycle()): void { this.emit('message', { type: 'result', jobId: this.jobId, result: { kind: 'gather', result: value } } satisfies WorkerToMain); }
  async terminate(): Promise<number> { this.emit('exit', 0); return 0; }
}

function fakeAdb(overrides: Partial<GatherAdbDevice> = {}): GatherAdbDevice & { taps: Array<[number, number]> } {
  const taps: Array<[number, number]> = [];
  return {
    taps,
    screencapRaw: async () => frame(),
    foregroundPackage: async () => PKG,
    tap: async (x, y) => { taps.push([x, y]); },
    swipe: async () => undefined,
    keyevent: async () => undefined,
    startApp: async () => undefined,
    stopApp: async () => undefined,
    ...overrides,
  };
}

const running = async () => ({ status: 'running', record: { createdAt: CREATED_AT } });
/** The instance lease faked (an in-process lock): the scheduler runs, the file layer is tested on its own below. */
const fastLocks = () => new InstanceLocks(home, { fileLock: async (_path, fn) => fn() });

describe('scheduler instance lock = the app shell lease system (labels and occupancy)', () => {
  it('labels the lease and lists the holder in the occupancy table while it holds the instance', async () => {
    const access = new InstanceAccess();
    const locks = new InstanceLocks(home, { access });
    let seen: unknown[] = [];
    await locks.run(3, '读取部队管理面板', async () => {
      seen = [await readLeaseOwner(home, 3), access.holderOf(3), locks.holderList()];
    });
    expect(seen[0]).toMatchObject({ label: '读取部队管理面板', pid: process.pid });
    expect(seen[1]).toBe('读取部队管理面板');
    expect(seen[2]).toEqual([expect.objectContaining({ index: 3, label: '读取部队管理面板' })]);
    // Released on exit: the table and the lease are free again.
    expect(access.holderOf(3)).toBeNull();
    expect(locks.holderList()).toEqual([]);
    expect(await readLeaseOwner(home, 3)).toBeNull();
  });

  it('refuses at once, by name, while another writer of this process holds the instance', async () => {
    const access = new InstanceAccess();
    const locks = new InstanceLocks(home, { access });
    const release = access.acquire(2, '进行账号登录');
    const fn = vi.fn(async () => 'ran');
    try {
      await expect(locks.run(2, '做健康探针', fn)).rejects.toMatchObject({
        code: 'CONCURRENCY_LIMIT', message: '实例 #2 正在进行账号登录，做健康探针稍后再试。',
      });
      expect(fn).not.toHaveBeenCalled();
    } finally {
      release();
    }
    await expect(locks.run(2, '做健康探针', fn)).resolves.toBe('ran');
  });

  it('names the holder of a lease held elsewhere when the lease times out', async () => {
    // Another process's writer: it holds the file lease with its label, our table does not know it.
    let exit!: () => void;
    const held = new Promise<void>((resolve) => { exit = resolve; });
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    const other = withLabelledLease(home, 4, '运行脚本计划', async () => { entered(); await held; }, { access: new InstanceAccess() });
    await inside;
    const locks = new InstanceLocks(home, { access: new InstanceAccess(), leaseTimeoutMs: 60 });
    try {
      await expect(locks.run(4, '读取部队管理面板', async () => undefined)).rejects.toMatchObject({
        code: 'CONCURRENCY_LIMIT', message: '实例 #4 正在运行脚本计划，读取部队管理面板稍后再试。',
      });
    } finally {
      exit();
      await other;
    }
  });

  it('a withInstanceLease writer is refused naming the scheduler holder', async () => {
    const access = new InstanceAccess();
    const locks = new InstanceLocks(home, { access });
    await locks.run(5, '自动采集派遣', async () => {
      const error = await withInstanceLease(home, 5, '读资源统计', async () => undefined, { access }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(InstanceBusyError);
      expect(error).toMatchObject({ code: 'CONCURRENCY_LIMIT', owner: '自动采集派遣', message: '实例 #5 正在自动采集派遣，请等待结束后再试。' });
    });
  });

  it('registers sample / exclusive holders as occupancy sources: blocking while held, gone afterwards', async () => {
    const runner = { runOnce: vi.fn(), sample: vi.fn(), stop: vi.fn(async () => undefined), dispose: vi.fn(async () => undefined), isRunning: () => false };
    const host = new AutomationHost({ get: async () => ({ getState: running, device: async () => fakeAdb() }) } as unknown as ManagerHost,
      home, runner as never, undefined, {}, { locks: fastLocks(), scheduler: { ownerLease: false } });
    const occupancy = new InstanceOccupancy();
    registerServiceOccupancy(occupancy, {
      instanceIndices: async () => [1],
      automation: host,
      plans: { isActiveForInstance: () => false, hasEnabledPlanForInstance: async () => false },
      accounts: { loginActiveOn: () => false },
      scheduler: host.locks,
      gameId: 'wanlong',
    });
    try {
      let during: unknown;
      let busy: string | null = null;
      await host.eta.exclusive(1, '截图', async () => {
        during = await occupancy.holders(1);
        busy = await occupancy.anyBusy();
      });
      expect(during).toEqual([{ index: 1, label: '截图', source: 'scheduler', blocking: true }]);
      expect(busy).toBe('实例 #1 正在截图。');
      expect(await occupancy.holders(1)).toEqual([]);
      expect(await occupancy.anyBusy()).toBeNull();
    } finally {
      await host.dispose();
    }
  });
});

describe('device lane: check-then-act sequences stay whole', () => {
  it('captureReadOnly keeps foreground → screencap → foreground together on the lane', async () => {
    const lanes = new DeviceLanes();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let first = true;
    const started = new Promise<void>((resolve) => {
      const device = fakeAdb({
        foregroundPackage: async () => {
          order.push('fg');
          if (first) { first = false; resolve(); await gate; }
          return PKG;
        },
        screencapRaw: async () => { order.push('cap'); return frame(); },
      });
      const host = new AutomationHost(lanes.host({ get: async () => ({ getState: running, device: async () => device }) }) as unknown as ManagerHost,
        home, { runOnce: vi.fn(), stop: vi.fn(), dispose: vi.fn(async () => undefined), isRunning: () => false } as never, undefined, {},
        { deviceLane: (index, work) => lanes.run(index, work), scheduler: { ownerLease: false } });
      void (async () => {
        await host.captureReadOnly('wanlong', 1);
        await host.dispose();
      })();
    });
    await started;
    // Another user of the same instance's lane (a bot screenshot, the advisor) arrives in the middle.
    const other = lanes.run(1, async () => { order.push('other'); });
    release();
    await other;
    expect(order).toEqual(['fg', 'cap', 'fg', 'other']);
  });

  it('a gather tap re-checks the foreground and taps without another lane task in between', async () => {
    const lanes = new DeviceLanes();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let checks = 0;
    let inCheck!: () => void;
    const checking = new Promise<void>((resolve) => { inCheck = resolve; });
    const adb = fakeAdb({
      foregroundPackage: async () => {
        checks++;
        // The second foreground read is the tap's own pre-input check (the first one is the approval).
        if (checks === 2) { order.push('check'); inCheck(); await gate; }
        return PKG;
      },
      tap: async () => { order.push('tap'); },
    });
    const manager: GatherManager = { getState: running, device: async () => lanes.device(1, adb) };
    const templateDir = path.join(home, 'set');
    await mkdir(templateDir);
    const runner = new WanlongGatherRunner(manager, home, {
      locks: fastLocks(), lane: (index, work) => lanes.run(index, work),
      workerFactory: () => new FakeWorker((message, worker) => {
        if (message.type === 'job') worker.ready();
        if (message.type === 'approved') worker.request({ op: 'tap', args: [100, 100] } as VisionRequest);
        if (message.type === 'response') worker.finish();
      }) as never,
    });
    const run = runner.runOnce(1, { templateDir, config: { enabled: true } });
    await checking;
    const other = lanes.run(1, async () => { order.push('other'); });
    release();
    await run;
    await other;
    await runner.dispose();
    expect(order).toEqual(['check', 'tap', 'other']);
  });
});

describe('accounts: readiness gate and gather config', () => {
  it('refuses auto and runs on the base instance through the real accounts gate (provisioner base)', async () => {
    const manager = { getState: running, device: async () => fakeAdb() };
    const managerHost = { get: async () => manager } as unknown as ManagerHost;
    const runner = { runOnce: vi.fn(), sample: vi.fn(), stop: vi.fn(async () => undefined), dispose: vi.fn(async () => undefined), isRunning: () => false };
    let accounts!: AccountManager;
    const host = new AutomationHost(managerHost, home, runner as never, undefined,
      { automationReadiness: (gameId, index) => accounts.readiness(gameId, index) }, { locks: fastLocks(), scheduler: { ownerLease: false } });
    accounts = new AccountManager(managerHost, host, home, { base: async () => ({ index: 1, createdAt: CREATED_AT }) });
    try {
      await host.saveSettings('wanlong', 1, { templateDir: home, config: { version: 2, enabled: true } });
      await expect(host.setSchedule('wanlong', 1, true)).rejects.toThrow('基础实例用于克隆');
      await expect(host.eta.setAuto(1, true)).rejects.toThrow('基础实例用于克隆');
      await expect(host.run('wanlong', 'gather-once', 1)).rejects.toThrow('基础实例用于克隆');
      expect(runner.sample).not.toHaveBeenCalled();
      expect(runner.runOnce).not.toHaveBeenCalled();
      // A copy of the base (another index) is allowed through the same gate.
      await host.saveSettings('wanlong', 2, { templateDir: home, config: { version: 2, enabled: true } });
      expect(await accounts.readiness('wanlong', 2)).toEqual({ ready: true });
    } finally {
      await accounts.shutdown();
      await host.dispose();
    }
  });

  it('reads and saves the gather config on the bound account, the instance file only without one', async () => {
    const manager = { getState: running, device: async () => fakeAdb() };
    const managerHost = { get: async () => manager } as unknown as ManagerHost;
    const runner = {
      runOnce: vi.fn(async () => cycle()), sample: vi.fn(), stop: vi.fn(async () => undefined), dispose: vi.fn(async () => undefined), isRunning: () => false,
    };
    const host = new AutomationHost(managerHost, home, runner as never, undefined, {}, { locks: fastLocks(), scheduler: { ownerLease: false } });
    const accounts = new AccountManager(managerHost, host, home, {
      instanceGatherConfig: (gameId, index) => host.instanceGatherConfig(gameId, index),
    });
    // Wired exactly as main/index.ts does.
    host.setPorts({
      accountIdOf: async (index) => (await accounts.accountForInstance('wanlong', index))?.id ?? null,
      accountGatherConfig: (index) => accounts.gatherConfigFor('wanlong', index),
      saveAccountGatherConfig: async (accountId, config) => { await accounts.saveGatherConfig(accountId, config); },
    });
    try {
      // Unbound: the instance's own file.
      await host.saveSettings('wanlong', 1, { templateDir: home, config: { version: 2, enabled: true, safety: { maxCapturesPerCycle: 60 } } });
      expect((await host.settings('wanlong', 1)).configAccount).toBeUndefined();
      const account = await accounts.create('wanlong', { name: '主号' });
      // Binding moves the instance's config into the account (original afterAccountBind).
      const bound = await accounts.bind(account.id, 1);
      expect(bound.notice).toContain('采集配置已搬到账号「主号」');
      const view = await host.settings('wanlong', 1);
      expect(view.configAccount).toEqual({ id: account.id, name: '主号' });
      expect(view.config).toMatchObject({ enabled: true });
      // Saving now writes the account's copy; the instance file keeps the old one.
      const saved = await host.saveSettings('wanlong', 1, { config: { version: 2, enabled: true, safety: { maxCapturesPerCycle: 45 } } });
      expect(saved.configAccount).toEqual({ id: account.id, name: '主号' });
      expect((await accounts.gatherConfigFor('wanlong', 1))?.config).toMatchObject({ safety: { maxCapturesPerCycle: 45 } });
      expect(await host.instanceGatherConfig('wanlong', 1)).toMatchObject({ safety: { maxCapturesPerCycle: 60 } });
      // A run uses the account's copy.
      await host.run('wanlong', 'gather-once', 1);
      await vi.waitFor(async () => expect((await host.runs())[0]?.status).toBe('succeeded'));
      expect((runner.runOnce.mock.calls[0] as unknown as [number, { config: { safety: { maxCapturesPerCycle: number } } }])[1].config.safety.maxCapturesPerCycle).toBe(45);
      // Unbinding: the instance file applies again (the account keeps its copy for a later bind).
      await accounts.bind(account.id, null);
      expect((await host.settings('wanlong', 1)).configAccount).toBeUndefined();
      expect((await host.settings('wanlong', 1)).config).toMatchObject({ safety: { maxCapturesPerCycle: 60 } });
    } finally {
      await accounts.shutdown();
      await host.dispose();
    }
  });
});

describe('scripts preempt gathering (DECISIONS A.4)', () => {
  it('a manual script run makes an in-flight gather sample yield, runs, then gives the instance back', async () => {
    const lanes = new DeviceLanes();
    const events: string[] = [];
    const device = fakeScriptDevice({ tap: async (x, y) => { events.push(`script-tap:${x},${y}`); } });
    const managerHost = { get: async () => ({ getState: running, device: async () => fakeAdb() }) } as unknown as ManagerHost;
    let sampleSignal: AbortSignal | undefined;
    const runner = {
      runOnce: vi.fn(), stop: vi.fn(async () => undefined), dispose: vi.fn(async () => undefined), isRunning: () => false,
      // The first sample (enabling auto) is slow: still reading the troop panel when the script arrives.
      sample: vi.fn((_index: number, options: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
        sampleSignal = options.signal;
        events.push('sample-start');
        options.signal.addEventListener('abort', () => { events.push('sample-aborted'); reject(options.signal.reason); }, { once: true });
      })),
    };
    // The real instance lease (file lock + labels): the script and the scheduler contend for the same lock.
    const host = new AutomationHost(managerHost, home, runner as never, undefined, {}, { scheduler: { ownerLease: false } });
    vi.spyOn(host, 'probe').mockResolvedValue({
      gameId: 'wanlong', packageName: PKG, foregroundPackage: PKG, deviceWidth: 2560, deviceHeight: 1440, capturedAt: Date.now(),
      matches: [], launchReady: true, launchReason: '已确认世界地图画面', timingsMs: {},
    });
    const port: PlanHostPort = {
      accounts: async () => [],
      instance: running,
      device: async () => lanes.device(1, device),
      templateDir: async () => '',
      suspendForScript: (_gameId, index, reason) => {
        events.push('suspend');
        return host.eta.suspendForScript(index, 50, reason);
      },
    };
    const scripts = new ScriptRunner(home, port, { workerFactory: inProcessWorkers({ vision: fakeVision() }).factory, pacing: FAST_PACING, foregroundPollMs: 5 });
    const plans = new PlanService(home, port, scripts);
    const script: ScriptDef = { id: 'tap-once', name: '点击一次', version: '1.0.0', packageName: PKG, refWidth: 100, refHeight: 100,
      updatedAt: 0, steps: [{ id: 'tap-1', kind: 'tap', at: { x: 50, y: 50 } }] };
    try {
      await plans.start('wanlong');
      await plans.saveScript('wanlong', script);
      await host.saveSettings('wanlong', 1, { templateDir: home, config: { version: 2, enabled: true } });
      const enabling = host.setSchedule('wanlong', 1, true);
      await vi.waitFor(() => expect(sampleSignal).toBeDefined());
      const run = await plans.runScript('wanlong', 1, script.id);
      await eventually(() => plans.listRuns('wanlong').find((item) => item.runId === run.runId)?.status === 'succeeded');
      // Polite wait, then the in-flight sample was aborted before the script touched the device.
      expect(events.slice(0, 4)).toEqual(['sample-start', 'suspend', 'sample-aborted', 'script-tap:100,50']);
      // Gathering stays on and gets the instance back: the queue is re-read 15 s after the script.
      expect((await enabling).enabled).toBe(true);
      await eventually(() => host.eta.listWakes().some((wake) => wake.reason === '脚本执行结束，重读队列校验'));
      expect(host.eta.isAuto(1)).toBe(true);
    } finally {
      await plans.shutdown();
      await host.dispose();
    }
  });
});

describe('app settings: gather failure shots follow the shot policy', () => {
  it('saves nothing under never, failure scenes under onFail, every scene under always; the kicked probe always sees the failure', async () => {
    const templateDir = path.join(home, 'set');
    await mkdir(templateDir);
    const manager: GatherManager = { getState: running, device: async () => fakeAdb() };
    const locks = fastLocks();
    const runner = new WanlongGatherRunner(manager, home, {
      locks,
      workerFactory: () => new FakeWorker((message, worker) => {
        if (message.type === 'job') worker.ready();
        if (message.type === 'approved') {
          worker.shot('g0-unknown-1');
          worker.shot('cycle-error');
          worker.finish(cycle('error'));
        }
      }) as never,
    });
    let policy: 'never' | 'onFail' | 'always' = 'never';
    const host = new AutomationHost({ get: async () => manager } as unknown as ManagerHost, home, runner, undefined,
      { shotPolicy: () => policy }, { locks, scheduler: { ownerLease: false } });
    const kicked = vi.fn(async () => null);
    host.setPorts({ probeKicked: kicked });
    const shotsDir = path.join(home, 'automation', 'wanlong', 'shots');
    const shots = async () => (await readdir(shotsDir).catch(() => [] as string[])).map((name) => name.replace(/-\d+\.jpg$/, '')).sort();
    const runOnce = async () => {
      const before = (await host.runs()).length;
      await host.run('wanlong', 'gather-once', 1);
      await vi.waitFor(async () => {
        const runs = await host.runs();
        expect(runs.length).toBe(before + 1);
        expect(runs[0]?.status).toBe('failed');
      });
    };
    try {
      await host.saveSettings('wanlong', 1, { templateDir, config: { version: 2, enabled: true } });
      await runOnce();
      expect(await shots()).toEqual([]);
      expect(kicked).toHaveBeenCalledTimes(1);
      policy = 'onFail';
      await runOnce();
      expect(await shots()).toEqual(['inst1-cycle-error']);
      policy = 'always';
      await runOnce();
      expect(await shots()).toEqual(['inst1-cycle-error', 'inst1-cycle-error', 'inst1-g0-unknown-1']);
      expect(kicked).toHaveBeenCalledTimes(3);
    } finally {
      await host.dispose();
    }
  });
});

describe('templates: a change drops the compiled sets in the vision workers at once', () => {
  it('invalidates the long-lived worker on a template save (the manifest stamp stays the fallback)', async () => {
    const created: FakeWorker[] = [];
    const manager: GatherManager = { getState: running, device: async () => fakeAdb() };
    const locks = fastLocks();
    const runner = new WanlongGatherRunner(manager, home, {
      locks,
      workerFactory: () => {
        const worker = new FakeWorker((message, w) => {
          if (message.type === 'job') w.ready();
          if (message.type === 'approved') w.finish();
        });
        created.push(worker);
        return worker as never;
      },
    });
    const host = new AutomationHost({ get: async () => manager } as unknown as ManagerHost, home, runner, undefined, {}, { locks, scheduler: { ownerLease: false } });
    try {
      await host.createTemplateSet('wanlong', 1, '模板集');
      await host.saveSettings('wanlong', 1, { config: { version: 2, enabled: true } });
      await host.run('wanlong', 'gather-once', 1);
      await vi.waitFor(async () => expect((await host.runs())[0]?.status).toBe('succeeded'));
      expect(created).toHaveLength(1);
      expect(created[0]!.sent.some((message) => message.type === 'invalidate')).toBe(false);
      const noise = new Uint8Array(64 * 48 * 4);
      let seed = 7;
      for (let i = 0; i < noise.length; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        noise[i] = i % 4 === 3 ? 255 : seed >>> 24;
      }
      const png = await sharp(Buffer.from(noise), { raw: { width: 64, height: 48, channels: 4 } }).png().toBuffer();
      await host.saveTemplate('wanlong', 1, { id: 'tpl_extra', name: '新模板', image: png, authoredWidth: 2560, authoredHeight: 1440 });
      expect(created[0]!.sent.filter((message) => message.type === 'invalidate')).toHaveLength(1);
    } finally {
      await host.dispose();
    }
  });
});
