/**
 * App side of wanlong-panel scripts/resources-offline-check.ts: the resource-table read wired into the assistant
 * (the flow itself is covered in packages/automation/test/wanlong-resources-*.test.ts).
 *   · the vision-worker job: no input before the resources gate approves (world map / city only, never an open troop
 *     panel), one whitelisted popup × at most, foreground re-checked before input, failure shots per shot policy;
 *   · the host: inside the instance lock (`eta.exclusive`), busy = CONCURRENCY_LIMIT (retry later), templates first;
 *   · ResourcesService: one read per instance, every read recorded as a snapshot;
 *   · snapshot storage in the day ledger (48 per day, idempotent, pushed).
 */
import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProbeReport, RawFrame } from '@avdm/automation';
import { createRuntimeState, wanlongPlugin, type GatherCycleResult } from '@avdm/automation/wanlong';
import { emptyResourceSnapshot, type ResourceSnapshot } from '@avdm/automation/wanlong/pure';
import { WanlongGatherRunner, type GatherAdbDevice, type GatherManager } from '../src/main/automation/gather-runner';
import { AutomationHost } from '../src/main/automation/host';
import type { ManagerHost } from '../src/main/manager-host';
import { inspectResourceProbe } from '../src/main/resources/probe';
import { ResourcesService } from '../src/main/resources/service';
import { SchedulerError } from '../src/main/scheduler/errors';
import { InstanceLocks } from '../src/main/scheduler/instance-lock';
import type { MainToWorker, VisionJobSpec, VisionRequest, WorkerToMain } from '../src/main/scheduler/vision-protocol';
import { StatsService } from '../src/main/stats/service';
import type { StatsSnapshotPush } from '../src/shared/ipc/stats';
import { dateKeyToDayStart } from '../src/shared/time';

vi.mock('../src/main/events', () => ({ broadcast: vi.fn() }));

const PACKAGE = wanlongPlugin.packageName;
const CREATED_AT = '2026-09-23T00:00:00.000Z';
const homes: string[] = [];
async function tempHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), 'avdm-resources-app-'));
  homes.push(home);
  return home;
}
afterAll(async () => { await Promise.all(homes.map((home) => rm(home, { recursive: true, force: true }))); });

type Scene = 'world' | 'city' | 'troop' | 'none';
const ANCHOR: Record<Exclude<Scene, 'none'>, string> = { world: 'tpl_world_search_icon', city: 'tpl_nav_map_toggle', troop: 'tpl_panel_title_troop' };

function probe(scene: Scene): ProbeReport {
  const hit = scene === 'none' ? null : ANCHOR[scene];
  return {
    gameId: 'wanlong', packageName: PACKAGE, foregroundPackage: PACKAGE, foregroundMatches: true,
    templateSet: { id: 'private-set', name: 'private', refWidth: 2560, refHeight: 1440 },
    frame: { width: 960, height: 540, capturedAt: 1 },
    matches: ['tpl_world_search_icon', 'tpl_nav_map_toggle', 'tpl_nav_map_toggle_b', 'tpl_panel_title_troop'].map((templateId) => ({
      templateId, found: templateId === hit, score: templateId === hit ? 0.97 : 0.2,
      threshold: 0.8, x: 1, y: 1, w: 1, h: 1, centerX: 1, centerY: 1, elapsedMs: 1,
    })),
    timingMs: { capture: 1, prepare: 1, match: 1, total: 3 },
  };
}

function frame(): RawFrame {
  return { width: 1, height: 1, format: 1, capturedAt: Date.now(), data: new Uint8Array(4) };
}

function snapshot(index: number, at = Date.now()): ResourceSnapshot {
  const snap = emptyResourceSnapshot(index, at);
  return { ...snap, rows: snap.rows.map((row) => ({ ...row, total: 1_110_000_000, rawTotal: '11.1亿', itemTotal: 290_000_000, rawItem: '2.9亿' })) };
}

type Script = (message: MainToWorker, worker: FakeWorker) => void;

/** Speaks the vision-worker protocol from the worker side. */
class FakeWorker extends EventEmitter {
  readonly sent: MainToWorker[] = [];
  jobId = 0;
  spec: VisionJobSpec | null = null;
  private nextId = 1;
  responses = new Map<number, Extract<MainToWorker, { type: 'response' }>>();

  constructor(private readonly script: Script) { super(); }

  postMessage(message: MainToWorker): void {
    this.sent.push(message);
    if (message.type === 'job') { this.jobId = message.jobId; this.spec = message.spec; }
    if (message.type === 'response') this.responses.set(message.id, message);
    queueMicrotask(() => this.script(message, this));
  }

  ready(scene: Scene): void { this.emit('message', { type: 'ready', jobId: this.jobId, probe: probe(scene) } satisfies WorkerToMain); }
  request(request: VisionRequest): number {
    const id = this.nextId++;
    this.emit('message', { type: 'request', jobId: this.jobId, id, ...request } as WorkerToMain);
    return id;
  }
  finish(snap = snapshot(0)): void { this.emit('message', { type: 'result', jobId: this.jobId, result: { kind: 'resources', snapshot: snap } } satisfies WorkerToMain); }
  fail(message: string, code = 'STEP_FAILED'): void { this.emit('message', { type: 'failed', jobId: this.jobId, error: { code, message } } as WorkerToMain); }
  shot(label: string): void { this.emit('message', { type: 'shot', jobId: this.jobId, label, raw: frame() } satisfies WorkerToMain); }
  sentOf<T extends MainToWorker['type']>(type: T): Extract<MainToWorker, { type: T }>[] {
    return this.sent.filter((message): message is Extract<MainToWorker, { type: T }> => message.type === type);
  }
  async terminate(): Promise<number> { this.emit('exit', 0); return 0; }
}

describe('resources gate', () => {
  it('approves the world map and the city, never an open troop panel or an unknown screen', () => {
    expect(inspectResourceProbe(probe('world'))).toMatchObject({ ok: true, scene: 'world-map' });
    expect(inspectResourceProbe(probe('city'))).toMatchObject({ ok: true, scene: 'city-a' });
    expect(inspectResourceProbe(probe('troop'))).toMatchObject({ ok: false, reason: expect.stringContaining('部队管理面板开着') });
    expect(inspectResourceProbe(probe('none'))).toMatchObject({ ok: false });
  });
});

describe('WanlongGatherRunner.readResources (vision-worker job)', { timeout: 30_000 }, () => {
  let home: string;
  let foreground: string | undefined;
  let taps: Array<[number, number]>;
  let keys: string[];
  let launches: number;
  let manager: GatherManager;
  let saved: string[];

  beforeEach(async () => {
    home = await tempHome();
    foreground = PACKAGE;
    taps = [];
    keys = [];
    launches = 0;
    saved = [];
    const adb: GatherAdbDevice = {
      screencapRaw: async () => frame(),
      foregroundPackage: async () => foreground,
      tap: async (x, y) => { taps.push([x, y]); },
      swipe: async () => undefined,
      keyevent: async (key) => { keys.push(key); },
      startApp: async () => { launches++; },
      stopApp: async () => undefined,
    };
    manager = { getState: async () => ({ status: 'running', record: { createdAt: CREATED_AT } }), device: async () => adb };
  });

  const runnerWith = (script: Script, created: FakeWorker[] = []) => new WanlongGatherRunner(manager, home, {
    locks: new InstanceLocks(home, { fileLock: async (_path, fn) => fn() }),
    workerFactory: () => { const worker = new FakeWorker(script); created.push(worker); return worker; },
  });
  const read = (runner: WanlongGatherRunner, extra: Record<string, unknown> = {}) => runner.readResources(0, {
    templateDir: home, signal: new AbortController().signal,
    saveShot: async (label) => { saved.push(label); return `shots/${label}.jpg`; },
    ...extra,
  });

  it('reads on the world map: gate first, then the dialog taps and BACKs, and returns the snapshot', async () => {
    const created: FakeWorker[] = [];
    let step = 0;
    const runner = runnerWith((message, worker) => {
      if (message.type === 'job') worker.ready('world');
      if (message.type === 'approved') { step = 1; worker.request({ op: 'tap', args: [100, 200] }); }
      if (message.type === 'response' && step === 1) { step = 2; worker.request({ op: 'key', args: ['BACK'] }); }
      else if (message.type === 'response' && step === 2) { step = 3; worker.finish(snapshot(0, 42)); }
    }, created);
    const snap = await read(runner);
    expect(snap).toMatchObject({ instanceIndex: 0, at: 42 });
    expect(created[0]!.spec).toEqual({ kind: 'resources', instanceIndex: 0, templateDir: expect.any(String) });
    expect(taps).toEqual([[100, 200]]);
    expect(keys).toEqual(['BACK']);
    expect(runner.locks.held(0)).toBe(false);
  });

  it('refuses an open troop panel without any input and saves the precheck shot per shot policy', async () => {
    const created: FakeWorker[] = [];
    const runner = runnerWith((message, worker) => {
      if (message.type === 'job') { worker.shot('res-precheck-not-main'); worker.ready('troop'); }
      if (message.type === 'denied') worker.fail(message.reason, 'PROBE_REJECTED');
    }, created);
    await expect(read(runner)).rejects.toMatchObject({ code: 'PROBE_REJECTED', message: expect.stringContaining('部队管理面板开着') });
    expect(created[0]!.sentOf('approved')).toHaveLength(0);
    expect(taps).toHaveLength(0);
    expect(keys).toHaveLength(0);
    expect(saved).toEqual(['res-precheck-not-main']);

    saved = [];
    const quiet = runnerWith((message, worker) => {
      if (message.type === 'job') { worker.shot('res-cell-unreadable'); worker.fail('读不出', 'STEP_FAILED'); }
    });
    await expect(read(quiet, { shotPolicy: 'never' })).rejects.toThrow('读不出');
    expect(saved).toEqual([]);
  });

  it('allows one popup × before the gate, refuses any other input, and never cold-starts the game', async () => {
    const created: FakeWorker[] = [];
    const ids: Record<string, number> = {};
    const runner = runnerWith((message, worker) => {
      if (message.type === 'job') {
        ids['popup'] = worker.request({ op: 'tap', args: [5, 6, 'closePopup'] });
        ids['popup2'] = worker.request({ op: 'tap', args: [5, 6, 'closePopup'] });
        ids['plain'] = worker.request({ op: 'tap', args: [7, 8] });
        ids['back'] = worker.request({ op: 'key', args: ['BACK'] });
        // The whitelisted recovery actions of samples / cycles are not open to a resources read (main enforces it).
        ids['probeBack'] = worker.request({ op: 'key', args: ['BACK', 'probeBack'] });
        ids['exitCancel'] = worker.request({ op: 'tap', args: [9, 9, 'exitCancel'] });
        ids['advise'] = worker.request({ op: 'advise', args: [frame(), 1] });
        ids['launch'] = worker.request({ op: 'ensureGame', args: [] });
      }
      if (message.type === 'response' && message.id === ids['launch']) worker.fail('不在主界面', 'STEP_FAILED');
    }, created);
    await expect(read(runner)).rejects.toThrow('不在主界面');
    const worker = created[0]!;
    expect(worker.responses.get(ids['popup']!)).toMatchObject({ ok: true });
    expect(worker.responses.get(ids['popup2']!)).toMatchObject({ ok: false, error: { code: 'PROBE_REJECTED' } });
    expect(worker.responses.get(ids['plain']!)).toMatchObject({ ok: false, error: { message: expect.stringContaining('探针通过前禁止注入设备输入') } });
    expect(worker.responses.get(ids['back']!)).toMatchObject({ ok: false });
    for (const id of ['probeBack', 'exitCancel', 'advise']) {
      expect(worker.responses.get(ids[id]!)).toMatchObject({ ok: false, error: { code: 'PROBE_REJECTED', message: expect.stringContaining('探针通过前禁止注入设备输入') } });
    }
    expect(worker.responses.get(ids['launch']!)).toMatchObject({ ok: true, value: 'failed' });
    expect(taps).toEqual([[5, 6]]);
    expect(keys).toEqual([]);
    expect(launches).toBe(0);
  });

  it('rejects a result that skipped the gate and input once the game left the foreground', async () => {
    const skipped = runnerWith((message, worker) => { if (message.type === 'job') worker.finish(); });
    await expect(read(skipped)).rejects.toMatchObject({ code: 'PROBE_REJECTED', message: expect.stringContaining('越过探针门槛') });

    const created: FakeWorker[] = [];
    let tapId = -1;
    const runner = runnerWith((message, worker) => {
      if (message.type === 'job') worker.ready('city');
      if (message.type === 'approved') { foreground = 'com.android.launcher3'; tapId = worker.request({ op: 'tap', args: [1, 1] }); }
      if (message.type === 'response' && message.id === tapId) worker.fail('停止');
    }, created);
    await expect(read(runner)).rejects.toThrow('停止');
    expect(created[0]!.responses.get(tapId)).toMatchObject({ ok: false, error: { message: expect.stringContaining('已离开前台') } });
    expect(taps).toHaveLength(0);
  });
});

describe('AutomationHost.restartGame (「重启游戏」 in the instance list)', { timeout: 30_000 }, () => {
  const runner = { runOnce: vi.fn(), stop: vi.fn(async () => undefined), dispose: vi.fn(async () => undefined), isRunning: vi.fn(() => false) };

  it('force-stops the game and launches it again inside the instance lock; refuses a stopped instance and a script holder', async () => {
    const home = await tempHome();
    const calls: string[] = [];
    let foreground: string | null = 'com.android.launcher3';
    let status = 'running';
    let host!: AutomationHost;
    const manager = {
      getState: async () => ({ status, record: { createdAt: CREATED_AT } }),
      device: async () => ({
        stopApp: async (pkg: string) => { calls.push(`stop:${pkg}:${host.locks.holder(1)}`); foreground = null; },
        startApp: async (pkg: string) => { calls.push(`start:${pkg}`); foreground = pkg; },
        foregroundPackage: async () => foreground,
      }),
    };
    host = new AutomationHost({ get: async () => manager } as unknown as ManagerHost, home, runner as never, undefined, {},
      { locks: new InstanceLocks(home, { fileLock: async (_path, fn) => fn() }), scheduler: { ownerLease: false } });
    try {
      const result = await host.restartGame('wanlong', 1);
      expect(result.foreground).toBe(true);
      expect(calls).toEqual([`stop:${PACKAGE}:重启游戏`, `start:${PACKAGE}`]);
      expect(host.locks.holder(1)).toBeNull();

      host.setPorts({ externalBusy: () => '脚本计划' });
      await expect(host.restartGame('wanlong', 1)).rejects.toMatchObject({ code: 'CONCURRENCY_LIMIT', message: expect.stringContaining('脚本计划') });
      host.setPorts({ externalBusy: () => null });
      status = 'stopped';
      await expect(host.restartGame('wanlong', 1)).rejects.toThrow('没有在运行');
      expect(calls).toHaveLength(2);
    } finally {
      await host.dispose();
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe('AutomationHost.readResourceStats', { timeout: 30_000 }, () => {
  let home: string;
  let host: AutomationHost;
  const readResources = vi.fn(async (index: number, _options: Record<string, unknown>) => snapshot(index));
  const runner = {
    runOnce: vi.fn(),
    stop: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
    isRunning: vi.fn(() => false),
    readResources,
  };
  const manager = {
    getState: async () => ({ status: 'running', record: { createdAt: CREATED_AT } }),
    device: async () => ({ foregroundPackage: async () => PACKAGE }),
  };

  beforeEach(async () => {
    home = await tempHome();
    readResources.mockClear();
    host = new AutomationHost({ get: async () => manager } as unknown as ManagerHost, home, runner as never, undefined,
      { shotPolicy: () => 'never' },
      { locks: new InstanceLocks(home, { fileLock: async (_path, fn) => fn() }), scheduler: { ownerLease: false } });
  });
  afterEach(async () => { vi.useRealTimers(); await host.dispose(); });

  it('needs a template set, then reads inside the instance lock with the app shot policy', async () => {
    await expect(host.readResourceStats(1)).rejects.toMatchObject({ code: 'TEMPLATE_NOT_FOUND' });
    expect(readResources).not.toHaveBeenCalled();
    await host.saveSettings('wanlong', 1, { templateDir: home });
    let holder: string | null = null;
    readResources.mockImplementationOnce(async (index) => { holder = host.locks.holder(index); return snapshot(index); });
    await expect(host.readResourceStats(1)).resolves.toMatchObject({ instanceIndex: 1 });
    expect(holder).toBe('读资源统计');
    expect(readResources.mock.calls[0]![1]).toMatchObject({ templateDir: home, shotPolicy: 'never', saveShot: expect.any(Function) });
    expect(host.locks.holder(1)).toBeNull();
  });

  it('answers busy (retry later) instead of queueing behind a long sample, and refuses while a script holds the instance', async () => {
    await host.saveSettings('wanlong', 1, { templateDir: home });
    let release!: () => void;
    const holding = host.locks.run(1, '读取部队管理面板', () => new Promise<void>((resolve) => { release = resolve; }));
    await vi.waitFor(() => expect(host.locks.holder(1)).toBe('读取部队管理面板'));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const reading = host.readResourceStats(1);
    const outcome = expect(reading).rejects.toMatchObject({ code: 'CONCURRENCY_LIMIT', message: '实例 #1 正在读取部队管理面板，读资源统计稍后再试。' });
    // The host first reads the instance settings (real I/O), then waits up to 5 s for the holder to finish.
    // Date is not faked: poll on real time so a slow disk under load cannot outrun the wait.
    const until = Date.now() + 15_000;
    while (vi.getTimerCount() === 0 && Date.now() < until) await new Promise((resolve) => setImmediate(resolve));
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(5_000);
    await outcome;
    vi.useRealTimers();
    release();
    await holding;
    expect(readResources).not.toHaveBeenCalled();

    host.setPorts({ externalBusy: () => '脚本计划' });
    await expect(host.readResourceStats(1)).rejects.toMatchObject({ code: 'CONCURRENCY_LIMIT', message: expect.stringContaining('脚本计划') });
    expect(readResources).not.toHaveBeenCalled();
  });

  it('lets observers see cycle facts and dispatches next to the primary hooks', async () => {
    await host.dispose();
    let resolveCycle!: (result: GatherCycleResult) => void;
    const cycleRunner = { ...runner, runOnce: vi.fn(() => new Promise<GatherCycleResult>((resolve) => { resolveCycle = resolve; })) };
    const primary: string[] = [];
    const observed: string[] = [];
    host = new AutomationHost({ get: async () => manager } as unknown as ManagerHost, home, cycleRunner as never, undefined, {
      onCycleResult: async (_index, fact) => { primary.push(fact.outcome); },
    }, { scheduler: { ownerLease: false } });
    const remove = host.observe({
      onCycleResult: async (_index, fact) => { observed.push(`fact:${fact.outcome}`); throw new Error('观察者坏了'); },
      onDispatched: (_index, records) => { observed.push(`dispatch:${records.length}`); },
    });
    await host.saveSettings('wanlong', 1, { templateDir: home, config: { version: 2, enabled: true } });
    await host.run('wanlong', 'gather-once', 1);
    resolveCycle({
      outcome: 'dispatched', message: '派出 1 支', queue: null, nextWakeAt: null, nextWakeReason: 't', captures: 1,
      state: createRuntimeState(), warnings: [],
      dispatched: [{ at: Date.now(), resource: 'wood', coord: '1,2', level: 5, searchFloor: 4, storage: 100, travelTimeSec: 30, troops: null }],
    });
    await vi.waitFor(async () => expect((await host.runs())[0]?.status).toBe('succeeded'));
    expect(primary).toEqual(['dispatched']);
    expect(observed).toEqual(['fact:dispatched', 'dispatch:1']);
    remove();
  });
});

describe('ResourcesService', () => {
  it('reads one instance at a time, records every read and reports busy state', async () => {
    let release!: (snap: ResourceSnapshot) => void;
    const recorded: ResourceSnapshot[] = [];
    const reading: Array<[number, boolean]> = [];
    const service = new ResourcesService('wanlong', {
      read: vi.fn(() => new Promise<ResourceSnapshot>((resolve) => { release = resolve; })),
      record: async (snap) => { recorded.push(snap); },
      onReading: (index, value) => reading.push([index, value]),
    });
    const first = service.read(2);
    expect(service.readingList()).toEqual([2]);
    await expect(service.read(2)).rejects.toMatchObject({ code: 'CONCURRENCY_LIMIT', message: expect.stringContaining('正在读资源统计') });
    release(snapshot(2, 7));
    await expect(first).resolves.toMatchObject({ instanceIndex: 2, at: 7 });
    expect(recorded).toHaveLength(1);
    expect(reading).toEqual([[2, true], [2, false]]);
    expect(service.readingList()).toEqual([]);
    await expect(service.read(64)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('keeps a successful read when recording fails, and refuses a malformed result', async () => {
    const logs: string[] = [];
    const ok = new ResourcesService('wanlong', {
      read: async (index) => snapshot(index),
      record: async () => { throw new Error('磁盘满了'); },
      log: (level, message) => logs.push(`[${level}] ${message}`),
    });
    await expect(ok.read(0)).resolves.toMatchObject({ instanceIndex: 0 });
    expect(logs.some((line) => line.includes('没能记入统计'))).toBe(true);
    const bad = new ResourcesService('wanlong', { read: async () => ({ at: 1, instanceIndex: 5, rows: [] }) as unknown as ResourceSnapshot });
    await expect(bad.read(0)).rejects.toThrow('无效的结果');
    const busy = new ResourcesService('wanlong', { read: async () => { throw new SchedulerError('CONCURRENCY_LIMIT', '实例 #0 正在运行脚本，读资源统计稍后再试。'); } });
    await expect(busy.read(0)).rejects.toMatchObject({ code: 'CONCURRENCY_LIMIT' });
  });
});

describe('snapshot storage in the day ledger', { timeout: 30_000 }, () => {
  it('stores snapshots in their Beijing day, idempotently, at most 48 a day (newest kept), and pushes each', async () => {
    const home = await tempHome();
    const day = dateKeyToDayStart('2026-09-09');
    let now = day + 20 * 3_600_000;
    const pushes: StatsSnapshotPush[] = [];
    const stats = new StatsService(home, { now: () => now, onSnapshot: (push) => pushes.push(push) });
    await stats.start();
    const first = snapshot(0, day + 60_000);
    await stats.recordSnapshot(first);
    await stats.recordSnapshot(first);
    expect(stats.today().snapshots).toHaveLength(1);
    for (let i = 0; i < 60; i++) await stats.recordSnapshot(snapshot(i % 3, day + 3_600_000 + i * 60_000));
    const today = stats.today();
    expect(today.snapshots).toHaveLength(48);
    expect(today.snapshots.at(-1)!.at).toBe(day + 3_600_000 + 59 * 60_000);
    expect(pushes.at(-1)).toMatchObject({ gameId: 'wanlong', dateKey: '2026-09-09' });
    await stats.recordSnapshot({ at: 'x' } as unknown as ResourceSnapshot);
    expect(stats.today().snapshots).toHaveLength(48);
    await stats.stop();
    // Persisted: a fresh service reads the same 48.
    now += 60_000;
    const again = new StatsService(home, { now: () => now });
    await again.start();
    expect(again.today().snapshots).toHaveLength(48);
    await again.stop();
    expect((await readdir(path.join(home, 'automation', 'games', 'wanlong', 'stats', 'days')))).toContain('2026-09-09.json');
  });
});
