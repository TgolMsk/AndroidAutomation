import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRuntimeState, wanlongPlugin, type GatherCycleResult } from '@avdm/automation/wanlong';
import { AutomationHost } from '../src/main/automation/host';
import type { ManagerHost } from '../src/main/manager-host';

const { broadcast } = vi.hoisted(() => ({ broadcast: vi.fn() }));
vi.mock('../src/main/events', () => ({ broadcast }));

function result(outcome: GatherCycleResult['outcome'], message: string): GatherCycleResult {
  return {
    outcome, message, dispatched: [], queue: null, nextWakeAt: Date.now() + 60_000,
    nextWakeReason: '建议一分钟后检查', captures: 1, state: createRuntimeState(), warnings: [],
  };
}

function controlledRunner() {
  let resolve!: (value: GatherCycleResult) => void;
  let reject!: (error: Error) => void;
  const pending = new Promise<GatherCycleResult>((yes, no) => { resolve = yes; reject = no; });
  return {
    runOnce: vi.fn(() => pending),
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
    foreground = 'another.app';
    await expect(host.run('wanlong', 'gather-once', 1)).rejects.toThrow('未处于前台');
    expect(await host.runs()).toEqual([]);
    foreground = wanlongPlugin.packageName;
    const started = await host.run('wanlong', 'gather-once', 1);
    await expect(host.run('wanlong', 'gather-once', 1)).rejects.toThrow('已有自动化任务');
    await expect(host.run('wanlong', 'unknown', 1)).rejects.toThrow('未知自动化任务');
    expect(runner.runOnce).toHaveBeenCalledTimes(1);
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

  it('persists an explicitly enabled schedule and uses one finished cycle to set the next wake', async () => {
    await enable();
    vi.spyOn(host, 'probe').mockResolvedValue({
      gameId: 'wanlong', packageName: wanlongPlugin.packageName, foregroundPackage: wanlongPlugin.packageName,
      deviceWidth: 960, deviceHeight: 540, capturedAt: Date.now(), matches: [],
      launchReady: true, launchReason: 'known scene', timingsMs: {},
    });
    expect((await host.setSchedule('wanlong', 1, true)).enabled).toBe(true);
    await vi.waitFor(() => expect(runner.runOnce).toHaveBeenCalledTimes(1));
    runner.resolve(result('queueFull', '队列已满'));
    await vi.waitFor(async () => {
      expect((await host.schedules())[0]).toMatchObject({ enabled: true, nextWakeAt: expect.any(Number) });
      expect((await host.runs())[0]).toMatchObject({ status: 'succeeded', message: '队列已满' });
    });
    await expect(host.run('wanlong', 'gather-once', 1)).rejects.toThrow('已启用自动续跑');
    expect((await host.setSchedule('wanlong', 1, false)).enabled).toBe(false);
    const scheduleFile = path.join(home, 'automation', 'scheduler', 'wanlong', '1.json');
    expect(JSON.parse(await readFile(scheduleFile, 'utf8'))).toMatchObject({ enabled: false, nextWakeAt: null });
  });

  it('serializes a slow schedule probe with a following configuration edit', async () => {
    await enable();
    runner.runOnce.mockResolvedValue(result('noResourceWanted', '没有启用的资源'));
    let releaseProbe!: (report: Awaited<ReturnType<typeof host.probe>>) => void;
    const probeGate = new Promise<Awaited<ReturnType<typeof host.probe>>>((resolve) => { releaseProbe = resolve; });
    const probe = vi.spyOn(host, 'probe').mockReturnValue(probeGate);
    const enabling = host.setSchedule('wanlong', 1, true);
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1));
    const editing = host.saveSettings('wanlong', 1, { config: { version: 2, enabled: false } });
    releaseProbe({
      gameId: 'wanlong', packageName: wanlongPlugin.packageName, foregroundPackage: wanlongPlugin.packageName,
      deviceWidth: 960, deviceHeight: 540, capturedAt: Date.now(), matches: [],
      launchReady: true, launchReason: 'known scene', timingsMs: {},
    });
    await enabling;
    await editing;
    expect((await host.schedules())[0]?.enabled).toBe(false);
    expect((await host.settings('wanlong', 1)).config['enabled']).toBe(false);
  });

  it('does not enable automatic scheduling while a manual start is in preflight', async () => {
    await enable();
    let releaseForeground!: (value: string) => void;
    const firstForeground = new Promise<string>((resolve) => { releaseForeground = resolve; });
    let reads = 0;
    manager.device = async () => ({
      foregroundPackage: async () => ++reads === 1 ? firstForeground : wanlongPlugin.packageName,
      screencapRaw,
    });
    vi.spyOn(host, 'probe').mockResolvedValue({
      gameId: 'wanlong', packageName: wanlongPlugin.packageName, foregroundPackage: wanlongPlugin.packageName,
      deviceWidth: 960, deviceHeight: 540, capturedAt: Date.now(), matches: [],
      launchReady: true, launchReason: 'known scene', timingsMs: {},
    });
    const manual = host.run('wanlong', 'gather-once', 1);
    await vi.waitFor(() => expect(reads).toBe(1));
    const enabling = host.setSchedule('wanlong', 1, true);
    releaseForeground(wanlongPlugin.packageName);
    const started = await manual;
    await expect(enabling).rejects.toThrow('已有自动化任务');
    expect((await host.schedules()).some((schedule) => schedule.enabled)).toBe(false);
    await host.stop(started.runId);
  });
});
