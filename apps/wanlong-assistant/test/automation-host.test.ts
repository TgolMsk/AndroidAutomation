import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRuntimeState, wanlongPlugin, type GatherCycleResult, type PanelSample } from '@avdm/automation/wanlong';
import { AutomationHost, type AutomationHostHooks } from '../src/main/automation/host';
import type { TemplateJob, TemplateJobOutput } from '../src/main/automation/template-jobs';
import { InstanceLocks } from '../src/main/scheduler/instance-lock';
import type { ManagerHost } from '../src/main/manager-host';
import type { AutomationProbeReport } from '../src/shared/ipc';

const { broadcast } = vi.hoisted(() => ({ broadcast: vi.fn() }));
vi.mock('../src/main/events', () => ({ broadcast }));

function result(outcome: GatherCycleResult['outcome'], message: string): GatherCycleResult {
  return {
    outcome, message, dispatched: [], queue: null, nextWakeAt: Date.now() + 60_000,
    nextWakeReason: '建议一分钟后检查', captures: 1, state: createRuntimeState(), warnings: [],
  };
}

function panel(used: number, total: number): PanelSample {
  return { sampledAt: Date.now(), queueUsed: used, queueTotal: total, rows: [], warnings: [] };
}

function probeReport(launchReady = true): AutomationProbeReport {
  return {
    gameId: 'wanlong', packageName: wanlongPlugin.packageName, foregroundPackage: wanlongPlugin.packageName,
    deviceWidth: 2560, deviceHeight: 1440, capturedAt: Date.now(), matches: [],
    launchReady, launchReason: launchReady ? '已确认世界地图画面，匹配分数 0.950' : '没有命中任何已知场景锚点',
    timingsMs: { adb: 1, prepare: 1, match: 1, worker: 1, total: 4 },
  };
}

/** The first user enable runs the read-only probe (a real worker in production); tests answer it directly. */
function allowProbe(host: AutomationHost, launchReady = true) {
  return vi.spyOn(host, 'probe').mockImplementation(async () => probeReport(launchReady));
}

function controlledRunner() {
  let resolve!: (value: GatherCycleResult) => void;
  let reject!: (error: Error) => void;
  const pending = new Promise<GatherCycleResult>((yes, no) => { resolve = yes; reject = no; });
  return {
    runOnce: vi.fn((_index: number, _options: Record<string, unknown>) => pending),
    sample: vi.fn(async () => panel(2, 5)),
    stop: vi.fn(async () => { resolve(result('cancelled', '采集已取消')); }),
    dispose: vi.fn(async () => { resolve(result('cancelled', '采集已取消')); }),
    isRunning: vi.fn(() => false),
    resolve,
    reject,
  };
}

describe('AutomationHost single-cycle gathering', () => {
  let home: string;
  let host: AutomationHost;
  let runner: ReturnType<typeof controlledRunner>;
  let foreground: string | undefined;
  let foregroundReads: (string | undefined)[];
  let manager: { getState: typeof getState; device: () => Promise<{ foregroundPackage: () => Promise<string | undefined>; screencapRaw: () => Promise<{ width: number; height: number; data: Uint8Array }> }> };
  const screencapRaw = vi.fn(async () => ({ width: 1, height: 1, data: new Uint8Array(4) }));
  const getState = vi.fn(async () => ({ status: 'running', record: { createdAt: '2026-09-23T00:00:00Z' } }));

  beforeEach(async () => {
    broadcast.mockReset();
    getState.mockClear();
    screencapRaw.mockClear();
    home = await mkdtemp(path.join(tmpdir(), 'avdm-automation-host-'));
    foreground = wanlongPlugin.packageName;
    foregroundReads = [];
    manager = {
      getState,
      device: async () => ({ foregroundPackage: async () => foregroundReads.shift() ?? foreground, screencapRaw }),
    };
    runner = controlledRunner();
    host = new AutomationHost({ get: async () => manager } as unknown as ManagerHost, home, runner);
  });

  afterEach(async () => {
    await host.dispose();
    await rm(home, { recursive: true, force: true });
  });

  async function enable(): Promise<void> {
    await host.saveSettings('wanlong', 1, { templateDir: home, config: { version: 2, enabled: true } });
  }

  it('publishes a single-cycle task and terminal IPC record without scheduling another run', async () => {
    await enable();
    expect(host.games()[0]?.tasks.map((task) => task.id)).toEqual(['gather-once']);
    const started = await host.run('wanlong', 'gather-once', 1);
    expect(started.status).toBe('running');
    expect(runner.runOnce).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith('automation-run', expect.objectContaining({ runId: started.runId, status: 'running' }));

    runner.resolve(result('dispatched', '已完成本轮采集'));
    await vi.waitFor(async () => expect((await host.runs())[0]?.status).toBe('succeeded'));
    expect((await host.runs())[0]).toMatchObject({ runId: started.runId, message: '已完成本轮采集', nextWakeAt: null });
    expect((await host.runs())[0]?.endedAt).toEqual(expect.any(Number));
    expect(runner.runOnce).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(broadcast).toHaveBeenCalledWith('automation-run', expect.objectContaining({ runId: started.runId, status: 'succeeded' })));
  });

  it('cancels the active instance and keeps a cancelled run record', async () => {
    await enable();
    const started = await host.run('wanlong', 'gather-once', 1);
    await host.stop(started.runId);
    expect(runner.stop).toHaveBeenCalledWith(1);
    expect((await host.runs())[0]?.status).toBe('cancelled');
    expect(broadcast).toHaveBeenCalledWith('automation-run', expect.objectContaining({ runId: started.runId, status: 'stopping' }));
    expect(broadcast).toHaveBeenCalledWith('automation-run', expect.objectContaining({ runId: started.runId, status: 'cancelled' }));
  });

  it('rejects an unready target and duplicate task before a second runner call', async () => {
    await enable();
    getState.mockResolvedValueOnce({ status: 'stopped', record: { createdAt: '2026-09-23T00:00:00Z' } });
    await expect(host.run('wanlong', 'gather-once', 1)).rejects.toThrow('尚未就绪');
    expect(await host.runs()).toEqual([]);
    // ★ The game need not be in front: the cycle cold-starts it (DECISIONS C).
    foreground = 'com.android.launcher3';
    const started = await host.run('wanlong', 'gather-once', 1);
    await expect(host.run('wanlong', 'gather-once', 1)).rejects.toThrow('已有自动化任务');
    await expect(host.run('wanlong', 'unknown', 1)).rejects.toThrow('未知自动化任务');
    expect(runner.runOnce).toHaveBeenCalledTimes(1);
    expect(runner.runOnce.mock.calls[0]?.[1]).toMatchObject({ templateDir: home, allowColdStart: true, saveShot: expect.any(Function) });
    await host.stop(started.runId);
  });

  it('records worker failures without reporting success', async () => {
    await enable();
    const started = await host.run('wanlong', 'gather-once', 1);
    runner.reject(new Error('模板编译失败'));
    await vi.waitFor(async () => expect((await host.runs())[0]?.status).toBe('failed'));
    expect((await host.runs())[0]).toMatchObject({ runId: started.runId, message: '模板编译失败' });
  });

  it('rejects a screenshot whose foreground app changed during capture', async () => {
    await enable();
    foregroundReads = [wanlongPlugin.packageName, 'another.app'];
    await expect(host.probe('wanlong', 1)).rejects.toThrow('截图时前台应用发生切换');
    expect(screencapRaw).toHaveBeenCalledTimes(1);
  });

  it('persists completed runs privately and loads them on restart', async () => {
    await enable();
    const started = await host.run('wanlong', 'gather-once', 1);
    runner.resolve(result('dispatched', '已完成本轮采集'));
    await vi.waitFor(async () => expect((await host.runs())[0]?.status).toBe('succeeded'));
    await host.dispose();

    const file = path.join(home, 'automation', 'runs.json');
    const stored = JSON.parse(await readFile(file, 'utf8'));
    expect(stored).toMatchObject({ version: 1, runs: [expect.objectContaining({ runId: started.runId, status: 'succeeded' })] });
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);

    runner = controlledRunner();
    host = new AutomationHost({ get: async () => manager } as unknown as ManagerHost, home, runner);
    expect((await host.runs())[0]).toMatchObject({ runId: started.runId, status: 'succeeded' });
  });

  it('marks an unfinished prior run failed before exposing history', async () => {
    await host.dispose();
    const file = path.join(home, 'automation', 'runs.json');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ version: 1, runs: [{
      runId: 'previous', gameId: 'wanlong', taskId: 'gather-once', index: 1,
      status: 'running', startedAt: Date.now() - 1000, endedAt: null, message: '正在执行采集一轮', nextWakeAt: null,
    }] }));
    runner = controlledRunner();
    host = new AutomationHost({ get: async () => manager } as unknown as ManagerHost, home, runner);
    expect((await host.runs())[0]).toMatchObject({ runId: 'previous', status: 'failed', message: expect.stringContaining('中断') });
    expect(JSON.parse(await readFile(file, 'utf8')).runs[0]).toMatchObject({ runId: 'previous', status: 'failed', endedAt: expect.any(Number) });
  });

  it('enables the ETA schedule with one read-only sample and runs the cycle when a wake finds a free slot', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      await host.dispose();
      const facts: unknown[] = [];
      const hooks: AutomationHostHooks = { onCycleResult: async (index, fact, source) => { facts.push({ index, fact, source }); } };
      runner = controlledRunner();
      host = new AutomationHost({ get: async () => manager } as unknown as ManagerHost, home, runner, undefined, hooks, {
        locks: new InstanceLocks(home, { fileLock: async (_path, fn) => fn() }),
        scheduler: { ownerLease: false, random: () => 0 },
      });
      allowProbe(host);
      await enable();
      foreground = 'com.android.launcher3';
      const enabled = await host.setSchedule('wanlong', 1, true);
      expect(enabled).toMatchObject({ enabled: true, nextWakeAt: Date.now() + 30_000 });
      expect(runner.sample).toHaveBeenCalledTimes(1);
      expect(runner.sample.mock.calls[0]?.[1]).toMatchObject({ templateDir: home, allowColdStart: true });
      expect(runner.runOnce).not.toHaveBeenCalled();
      expect(broadcast).toHaveBeenCalledWith('scheduler-changed', expect.objectContaining({ instanceIndex: 1, auto: true, queueUsed: 2 }));
      expect(broadcast).toHaveBeenCalledWith('automation-schedule', expect.objectContaining({ index: 1, enabled: true }));

      await vi.advanceTimersByTimeAsync(30_000);
      await vi.waitFor(() => expect(runner.runOnce).toHaveBeenCalledTimes(1));
      runner.resolve(result('queueFull', '队列已满'));
      await vi.waitFor(async () => {
        expect((await host.runs())[0]).toMatchObject({ status: 'succeeded', message: '队列已满' });
        expect((await host.schedules())[0]).toMatchObject({ enabled: true, nextWakeAt: expect.any(Number) });
        expect(host.eta.getState(1).operating).toBe(false);
      });
      expect(facts).toEqual([{ index: 1, source: 'scheduled', fact: expect.objectContaining({ outcome: 'queueFull' }) }]);
      await expect(host.run('wanlong', 'gather-once', 1)).rejects.toThrow('已启用自动续跑');
      expect((await host.setSchedule('wanlong', 1, false)).enabled).toBe(false);
      const file = path.join(home, 'automation', 'games', 'wanlong', 'scheduler', 'instances', '1.json');
      expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ auto: false, instanceCreatedAt: '2026-09-23T00:00:00Z' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a failed scheduled cycle with its step before the scheduler counts it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      await host.dispose();
      const order: string[] = [];
      const hooks: AutomationHostHooks = {
        onCycleResult: async (_index, fact) => { order.push(`fact:${fact.step}`); },
      };
      runner = controlledRunner();
      host = new AutomationHost({ get: async () => manager } as unknown as ManagerHost, home, runner, undefined, hooks, {
        locks: new InstanceLocks(home, { fileLock: async (_path, fn) => fn() }),
        scheduler: { ownerLease: false, random: () => 0 },
      });
      allowProbe(host);
      host.eta.setHooks({ log: (_level, message) => { if (message.includes('派遣流程报错')) order.push('scheduler'); } });
      await enable();
      await host.setSchedule('wanlong', 1, true);
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.waitFor(() => expect(runner.runOnce).toHaveBeenCalledTimes(1));
      runner.resolve({ ...result('error', '回不到世界地图'), error: { code: 'STEP_FAILED', message: '回不到世界地图', detail: { step: 'G0' } } } as GatherCycleResult);
      await vi.waitFor(() => expect(host.eta.getState(1).failureCount).toBe(1));
      expect(order).toEqual(['fact:G0', 'scheduler']);
      expect(host.eta.getState(1).nextWakeReason).toContain('退避重试');
    } finally {
      vi.useRealTimers();
    }
  });

  it('counts a scheduled cycle that its own timeout cancelled as a failure, not a stop', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      await host.dispose();
      runner = controlledRunner();
      host = new AutomationHost({ get: async () => manager } as unknown as ManagerHost, home, runner, undefined, {}, {
        locks: new InstanceLocks(home, { fileLock: async (_path, fn) => fn() }),
        scheduler: { ownerLease: false, random: () => 0 },
      });
      allowProbe(host);
      await enable();
      await host.setSchedule('wanlong', 1, true);
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.waitFor(() => expect(runner.runOnce).toHaveBeenCalledTimes(1));
      runner.resolve(result('cancelled', '视觉任务超时'));
      await vi.waitFor(() => expect(host.eta.getState(1).failureCount).toBe(1));
      expect(host.eta.getState(1)).toMatchObject({ auto: true, nextWakeAt: expect.any(Number) });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports facts and dispatches of a manual cycle and teaches the queue its travel times', async () => {
    await host.dispose();
    const facts: string[] = [];
    const dispatched: number[] = [];
    runner = controlledRunner();
    host = new AutomationHost({ get: async () => manager } as unknown as ManagerHost, home, runner, undefined, {
      onCycleResult: async (_index, fact, source) => { facts.push(`${source}:${fact.outcome}:${fact.dispatched}`); },
      onDispatched: async (_index, records) => { dispatched.push(records.length); },
    }, { scheduler: { ownerLease: false } });
    const noteDispatches = vi.spyOn(host.eta, 'noteDispatches');
    await enable();
    await host.run('wanlong', 'gather-once', 1);
    runner.resolve({
      ...result('dispatched', '派出 1 支'),
      dispatched: [{ at: Date.now(), resource: 'wood', coord: '100,200', level: 8, searchFloor: 7, storage: 1_200_000, travelTimeSec: 42, troops: 1000 }],
    });
    await vi.waitFor(async () => expect((await host.runs())[0]?.status).toBe('succeeded'));
    expect(facts).toEqual(['manual:dispatched:1']);
    expect(dispatched).toEqual([1]);
    expect(noteDispatches).toHaveBeenCalledWith(1, [{ travelTimeMs: 42_000, coord: '100,200', resourceType: 'wood' }], { resample: false });
  });

  it('serializes a slow first sample with a following configuration edit', async () => {
    allowProbe(host);
    await enable();
    let releaseSample!: (sample: PanelSample) => void;
    runner.sample.mockReturnValueOnce(new Promise<PanelSample>((resolve) => { releaseSample = resolve; }));
    const enabling = host.setSchedule('wanlong', 1, true);
    await vi.waitFor(() => expect(runner.sample).toHaveBeenCalledTimes(1));
    const editing = host.saveSettings('wanlong', 1, { config: { version: 2, enabled: false } });
    releaseSample(panel(5, 5));
    await enabling;
    await editing;
    expect((await host.schedules())[0]?.enabled).toBe(false);
    expect((await host.settings('wanlong', 1)).config['enabled']).toBe(false);
  });

  it('requires a passing read-only probe for the first enable and again after a template or policy edit', async () => {
    await enable();
    const probe = allowProbe(host, false);
    await expect(host.setSchedule('wanlong', 1, true)).rejects.toThrow('只读探针通过');
    expect(runner.sample).not.toHaveBeenCalled();
    expect(host.eta.list()).toEqual([]);
    probe.mockImplementation(async () => probeReport(true));
    expect((await host.setSchedule('wanlong', 1, true)).enabled).toBe(true);
    await host.setSchedule('wanlong', 1, false);
    // Same AVD, same templates: re-enabling needs no new probe (samples may cold-start the game).
    foreground = 'com.android.launcher3';
    expect((await host.setSchedule('wanlong', 1, true)).enabled).toBe(true);
    expect(probe).toHaveBeenCalledTimes(2);
    await host.saveSettings('wanlong', 1, { config: { version: 2, enabled: true } });
    expect((await host.schedules())[0]?.enabled).toBe(false);
    await host.setSchedule('wanlong', 1, true);
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it('lets a disable supersede an enable still cold-starting in its first sample', async () => {
    allowProbe(host);
    await enable();
    let sampleSignal: AbortSignal | undefined;
    runner.sample.mockImplementationOnce((_index: number, options: { signal: AbortSignal }) => new Promise<PanelSample>((_resolve, reject) => {
      sampleSignal = options.signal;
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    }) as never);
    const enabling = host.setSchedule('wanlong', 1, true);
    await vi.waitFor(() => expect(sampleSignal).toBeDefined());
    expect((await host.setSchedule('wanlong', 1, false)).enabled).toBe(false);
    expect(sampleSignal!.aborted).toBe(true);
    expect((await enabling).enabled).toBe(false);
    expect(host.eta.listWakes()).toEqual([]);
  });

  it('lets a disable supersede an enable still in its probe', async () => {
    await enable();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const probe = allowProbe(host).mockImplementation(async () => { await gate; return probeReport(true); });
    const enabling = host.setSchedule('wanlong', 1, true);
    await vi.waitFor(() => expect(probe).toHaveBeenCalled());
    expect((await host.setSchedule('wanlong', 1, false)).enabled).toBe(false);
    release();
    expect((await enabling).enabled).toBe(false);
    expect(runner.sample).not.toHaveBeenCalled();
  });

  it('does not hang shutdown behind a manual cycle that holds the instance lock', async () => {
    await host.dispose();
    const locks = new InstanceLocks(home, { fileLock: async (_path, fn) => fn() });
    let holding!: () => void;
    const held = new Promise<void>((resolve) => { holding = resolve; });
    const lockRunner = {
      ...controlledRunner(),
      // Like the real runner: the cycle holds the shared instance lock until it is aborted.
      runOnce: vi.fn((index: number, options: { signal?: AbortSignal }) => locks.run(index, '自动采集', () =>
        new Promise<GatherCycleResult>((resolve) => {
          holding();
          options.signal!.addEventListener('abort', () => resolve(result('cancelled', '采集已取消')), { once: true });
        }))),
      dispose: vi.fn(async () => undefined),
    };
    host = new AutomationHost({ get: async () => manager } as unknown as ManagerHost, home, lockRunner as never, undefined, {}, {
      locks, scheduler: { ownerLease: false },
    });
    await enable();
    // The instance is a known scheduler runtime (its lock is drained on shutdown).
    await host.eta.noteDispatch(1, { travelTimeMs: 1000 }, { resample: false });
    const started = await host.run('wanlong', 'gather-once', 1);
    await held;
    const t0 = performance.now();
    await host.dispose();
    expect(performance.now() - t0).toBeLessThan(2_000);
    host = new AutomationHost({ get: async () => manager } as unknown as ManagerHost, home, controlledRunner());
    expect((await host.runs())[0]).toMatchObject({ runId: started.runId, status: 'cancelled' });
  });

  it('treats a scheduled circuitBroken cycle as a designed stop, not a failure', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      await host.dispose();
      const failures = vi.fn();
      runner = controlledRunner();
      host = new AutomationHost({ get: async () => manager } as unknown as ManagerHost, home, runner, undefined, { onFailure: failures }, {
        locks: new InstanceLocks(home, { fileLock: async (_path, fn) => fn() }),
        scheduler: { ownerLease: false, random: () => 0 },
      });
      allowProbe(host);
      await enable();
      await host.setSchedule('wanlong', 1, true);
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.waitFor(() => expect(runner.runOnce).toHaveBeenCalledTimes(1));
      const tripped = Date.now();
      runner.resolve(result('circuitBroken', '最近一小时已派兵 12 次，达到熔断上限'));
      await vi.waitFor(async () => {
        expect((await host.runs())[0]).toMatchObject({ status: 'succeeded' });
        expect(host.eta.getState(1).operating).toBe(false);
        expect(host.eta.getState(1).nextWakeAt).not.toBeNull();
      });
      expect(failures).not.toHaveBeenCalled();
      expect(host.eta.getState(1)).toMatchObject({ auto: true, failureCount: 0 });
      // Within the 10-minute cooldown only the health probe may wake.
      const wake = host.eta.listWakes()[0]!;
      expect(wake.reason === '健康探针' || wake.dueAt >= tripped + 10 * 60_000).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not enable automatic scheduling while a manual start is in preflight', async () => {
    allowProbe(host);
    await enable();
    let releaseState!: () => void;
    const gate = new Promise<void>((resolve) => { releaseState = resolve; });
    getState.mockImplementationOnce(async () => { await gate; return { status: 'running', record: { createdAt: '2026-09-23T00:00:00Z' } }; });
    const manual = host.run('wanlong', 'gather-once', 1);
    await vi.waitFor(() => expect(getState).toHaveBeenCalledTimes(1));
    const enabling = host.setSchedule('wanlong', 1, true);
    releaseState();
    const started = await manual;
    await expect(enabling).rejects.toThrow('已有自动化任务');
    expect((await host.schedules()).some((schedule) => schedule.enabled)).toBe(false);
    expect(runner.sample).not.toHaveBeenCalled();
    await host.stop(started.runId);
  });

  it('tests a template with the app settings threshold and shrink the script engine uses (original matchOnce)', async () => {
    const defaults = { threshold: 0.9, shrink: 3 };
    const tuned = new AutomationHost({ get: async () => manager } as unknown as ManagerHost, home, controlledRunner(), undefined,
      { matchDefaults: () => defaults });
    const match = { templateId: 'plain', found: true, score: 0.95, x: 0, y: 0, w: 10, h: 10, centerX: 5, centerY: 5, threshold: 0.9, elapsedMs: 1 };
    try {
      const set = { id: 'set', name: '模板集', refWidth: 2560, refHeight: 1440, directory: home, templates: [
        { id: 'plain', bounds: { x: 0, y: 0, w: 10, h: 10 } },
        { id: 'own', bounds: { x: 0, y: 0, w: 10, h: 10 }, threshold: 0.8 },
      ] } as unknown as Awaited<ReturnType<AutomationHost['templateSet']>>;
      vi.spyOn(tuned, 'templateSet').mockResolvedValue(set);
      vi.spyOn((tuned as unknown as { templates: { image: () => Promise<Uint8Array> } }).templates, 'image').mockResolvedValue(new Uint8Array(8));
      const jobs = vi.fn(async (_job: TemplateJob): Promise<TemplateJobOutput> => ({ ok: true, kind: 'test', match }));
      tuned.templateJobRunner = jobs;
      await tuned.testTemplate('wanlong', 1, 'plain');
      expect(jobs.mock.calls[0]![0]).toMatchObject({ kind: 'test', shrink: 3, definition: { id: 'plain', threshold: 0.9 } });
      // A template's own threshold still wins; the shrink follows the setting; a threshold typed into the test is kept.
      defaults.shrink = 1;
      await tuned.testTemplate('wanlong', 1, 'own', { threshold: 0.7 });
      expect(jobs.mock.calls[1]![0]).toMatchObject({ kind: 'test', shrink: 1, threshold: 0.7, definition: { id: 'own', threshold: 0.8 } });
      // Without the hook the vision defaults apply.
      vi.spyOn(host, 'templateSet').mockResolvedValue(set);
      vi.spyOn((host as unknown as { templates: { image: () => Promise<Uint8Array> } }).templates, 'image').mockResolvedValue(new Uint8Array(8));
      const plain = vi.fn(async (_job: TemplateJob): Promise<TemplateJobOutput> => ({ ok: true, kind: 'test', match }));
      host.templateJobRunner = plain;
      await host.testTemplate('wanlong', 1, 'plain');
      expect(plain.mock.calls[0]![0]).not.toHaveProperty('shrink');
      expect((plain.mock.calls[0]![0] as { definition: { threshold?: number } }).definition.threshold).toBeUndefined();
    } finally {
      await tuned.dispose();
    }
  });
});
