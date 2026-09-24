import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { wanlongPlugin } from '@avdm/automation/wanlong';
import type { PanelSample, RowSample } from '@avdm/automation/wanlong/pure';
import type { RawFrame } from '@avdm/automation';
import { SchedulerError } from '../src/main/scheduler/errors';
import { InstanceLocks } from '../src/main/scheduler/instance-lock';
import { EtaScheduler, type EtaSchedulerOptions } from '../src/main/scheduler/service';
import type { EtaSchedulerPorts, SampleRequest } from '../src/main/scheduler/types';

const PACKAGE = wanlongPlugin.packageName;
/** 12:00 Beijing time: far from the fatigue boundaries. */
const START = Date.parse('2026-09-24T04:00:00.000Z');
const CREATED_AT = '2026-09-01T00:00:00.000Z';

const frame = (): RawFrame => ({ width: 2, height: 2, data: new Uint8Array(16), capturedAt: Date.now() });

function panel(used: number | null, total: number | null, rows: RowSample[] = []): PanelSample {
  return { sampledAt: Date.now(), queueUsed: used, queueTotal: total, rows, warnings: [] };
}

function gatheringRow(slot: number, remainingMs: number): RowSample {
  return {
    slot, status: 'gathering', statusText: '采集中', remainingMs, targetCoord: '100,200', troopCount: null,
    commanders: [], fillRatio: 0.5, resourceType: 'wood',
  };
}

/** Let real I/O (atomic writes) and promise chains settle while setTimeout is faked. */
async function until(check: () => boolean, what: string, budgetMs = 5_000): Promise<void> {
  const deadline = performance.now() + budgetMs;
  while (performance.now() < deadline) {
    if (check()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  if (check()) return;
  throw new Error(`等待超时：${what}`);
}

/** Give pending I/O a moment (used to show that something did NOT happen yet). */
const settle = () => until(() => false, '', 100).catch(() => undefined);

describe('EtaScheduler', () => {
  let home: string;
  let samples: Array<(req: SampleRequest) => Promise<PanelSample>>;
  let sampleCalls: SampleRequest[];
  let instance: { status: string; createdAt: string } | null;
  let ports: EtaSchedulerPorts;
  let schedulers: EtaScheduler[];
  let logs: string[];

  const locks = () => new InstanceLocks(home, { fileLock: async (_path, fn) => fn() });

  function make(options: EtaSchedulerOptions = {}, overrides: Partial<EtaSchedulerPorts> = {}): EtaScheduler {
    const scheduler = new EtaScheduler(home, { ...ports, ...overrides }, {
      ownerLease: false, locks: locks(), random: () => 0, log: (level, message) => logs.push(`${level} ${message}`), ...options,
    });
    schedulers.push(scheduler);
    return scheduler;
  }

  /** A restored scheduler with the health probe off (it would be the earliest wake in most tests). */
  async function ready(options: EtaSchedulerOptions = {}, overrides: Partial<EtaSchedulerPorts> = {}): Promise<EtaScheduler> {
    const scheduler = make(options, overrides);
    await scheduler.restore();
    await scheduler.saveConfig({ healthProbeIntervalMin: 0 });
    return scheduler;
  }

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(START);
    home = await mkdtemp(path.join(tmpdir(), 'avdm-eta-'));
    samples = [];
    sampleCalls = [];
    instance = { status: 'running', createdAt: CREATED_AT };
    logs = [];
    schedulers = [];
    ports = {
      sample: vi.fn(async (_index: number, req: SampleRequest) => {
        sampleCalls.push(req);
        const next = samples.shift();
        return next ? next(req) : panel(5, 5);
      }),
      healthFrame: vi.fn(async () => ({ raw: frame(), foreground: PACKAGE, running: true })),
      instance: vi.fn(async () => instance),
    };
  });

  afterEach(async () => {
    vi.useRealTimers();
    await Promise.allSettled(schedulers.map((scheduler) => scheduler.dispose()));
    await rm(home, { recursive: true, force: true });
  });

  it('enables through the readiness gate, samples once and arms a wake; onAutoChanged fires only on flips', async () => {
    const changes: Array<[number, boolean, string | undefined]> = [];
    const ensureReady = vi.fn(async () => undefined);
    const scheduler = await ready({}, { ensureReady });
    scheduler.setHooks({ onAutoChanged: (index, enabled, _at, reason) => changes.push([index, enabled, reason]) });
    samples.push(async () => panel(2, 5));
    const state = await scheduler.setAuto(1, true);
    expect(ensureReady).toHaveBeenCalledWith(1);
    expect(state).toMatchObject({ auto: true, queueUsed: 2, queueTotal: 5, lastSampleOk: true, nextWakeAt: START + 30_000 });
    expect(sampleCalls[0]).toMatchObject({ allowColdStart: true, reason: '开启自动调度后的首次采样' });
    await scheduler.setAuto(1, true);
    await scheduler.setAuto(1, false, '手动暂停');
    await scheduler.setAuto(1, false);
    expect(changes).toEqual([[1, true, undefined], [1, false, '手动暂停']]);
    expect(scheduler.getState(1)).toMatchObject({ auto: false, nextWakeAt: null });
    expect(scheduler.listWakes()).toEqual([]);
  });

  it('refuses to enable an unready target without sampling', async () => {
    const scheduler = await ready({}, { ensureReady: async () => { throw new Error('账号尚未登录'); } });
    await expect(scheduler.setAuto(1, true)).rejects.toThrow('账号尚未登录');
    instance = { status: 'stopped', createdAt: CREATED_AT };
    const plain = await ready();
    await expect(plain.setAuto(2, true)).rejects.toThrow('尚未就绪');
    expect(ports.sample).not.toHaveBeenCalled();
    expect(scheduler.getState(1).auto).toBe(false);
  });

  it('lets a later disable cancel an enable still in its readiness check (generation counter)', async () => {
    let releaseReady!: () => void;
    const gate = new Promise<void>((resolve) => { releaseReady = resolve; });
    const scheduler = await ready({}, { ensureReady: () => gate });
    const enabling = scheduler.setAuto(1, true);
    await scheduler.setAuto(1, false);
    releaseReady();
    expect((await enabling).auto).toBe(false);
    expect(ports.sample).not.toHaveBeenCalled();
    expect(scheduler.listWakes()).toEqual([]);
  });

  it('still arms a wake when the first sample is throttled', async () => {
    const scheduler = await ready();
    await scheduler.setAuto(1, true);
    await scheduler.setAuto(1, false);
    vi.setSystemTime(START + 2_000);
    const state = await scheduler.setAuto(1, true);
    expect(ports.sample).toHaveBeenCalledTimes(1);
    expect(state.nextWakeAt).toEqual(expect.any(Number));
    expect(scheduler.listWakes()).toHaveLength(1);
  });

  it('hands a free slot to the queue-free hook inside the lock and records the dispatch with one re-sample', async () => {
    const scheduler = await ready();
    const held: boolean[] = [];
    scheduler.setQueueFreeHook(async (state, ctx) => {
      held.push(scheduler.locks.held(state.instanceIndex));
      // Nested exclusive() (e.g. a bot screenshot from a hook) re-enters instead of deadlocking.
      await scheduler.exclusive(state.instanceIndex, '截图', async () => { held.push(scheduler.locks.held(1)); });
      samples.push(async () => panel(5, 5, [gatheringRow(1, 600_000)]));
      await scheduler.noteDispatches(1, [{ travelTimeMs: 42_000, coord: '100,200', resourceType: 'wood' }], { signal: ctx.signal });
      return { dispatched: 1 };
    });
    samples.push(async () => panel(4, 5));
    await scheduler.setAuto(1, true);
    samples.push(async () => panel(4, 5));
    await vi.advanceTimersByTimeAsync(30_000);
    await until(() => sampleCalls.length === 3 && !scheduler.getState(1).operating, '派兵后校准');
    expect(held).toEqual([true, true]);
    expect(sampleCalls.map((call) => call.reason)).toEqual([
      '开启自动调度后的首次采样', expect.stringContaining('到点唤醒'), '派兵后校准',
    ]);
    expect(sampleCalls[2].allowColdStart).toBe(false);
    const state = scheduler.getState(1);
    expect(state.marches[0]).toMatchObject({ slot: 1, travelTimeMs: 42_000, travelTimeSource: 'dispatch' });
    // freeAt = sampledAt + 10 min + 42 s; the wake is freeAt + 60 s slack (no jitter), before the 15 min calibration.
    expect(state.marches[0]!.freeAt).toBe(state.lastSampledAt + 600_000 + 42_000);
    expect(state.nextWakeAt).toBe(state.marches[0]!.freeAt! + 60_000);
    expect(state.failureCount).toBe(0);
  });

  it('backs off on a full or unreadable queue along the original ladder', async () => {
    const scheduler = await ready();
    scheduler.setQueueFreeHook(async () => { throw new Error('should not dispatch'); });
    samples.push(async () => panel(3, 5));
    await scheduler.setAuto(1, true);
    samples.push(async () => panel(5, 5));
    await vi.advanceTimersByTimeAsync(30_000);
    await until(() => (scheduler.getState(1).nextWakeReason ?? '').includes('第 1 次'), '第一次退避');
    expect(scheduler.getState(1).nextWakeAt).toBe(Date.now() + 30_000);
    samples.push(async () => panel(null, null));
    await vi.advanceTimersByTimeAsync(30_000);
    await until(() => (scheduler.getState(1).nextWakeReason ?? '').includes('第 2 次'), '第二次退避');
    expect(scheduler.getState(1).nextWakeAt).toBe(Date.now() + 60_000);
    expect(scheduler.getState(1).nextWakeReason).toContain('队列占用没读出来');
    expect(scheduler.getState(1).failureCount).toBe(0);
  });

  it('counts real sample failures and pauses after the safety limit', async () => {
    const paused = vi.fn();
    const scheduler = await ready({ maxConsecutiveFailures: 2, onSafetyPause: paused });
    await scheduler.setAuto(1, true);
    samples.push(async () => { throw new SchedulerError('TIMEOUT', 'ADB 截图超时'); });
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    await until(() => scheduler.getState(1).failureCount === 1 && scheduler.getState(1).nextWakeAt !== null, '第一次失败');
    expect(scheduler.getState(1).nextWakeReason).toContain('退避重试（第 1 次');
    samples.push(async () => { throw new SchedulerError('TIMEOUT', 'ADB 截图超时'); });
    await vi.advanceTimersByTimeAsync(30_000);
    await until(() => !scheduler.getState(1).auto, '安全暂停');
    expect(paused).toHaveBeenCalledWith(1, 2, expect.stringContaining('连续 2 次失败'));
    expect(scheduler.listWakes()).toEqual([]);
    // ★ One source of truth: the queue view never invents a pause of its own; the alerts module's record (raised from
    //   onSafetyPause → onScheduleStop) is what `pause` shows, through the pauseOf hook.
    expect(scheduler.getState(1).pause).toBeNull();
    scheduler.setHooks({ pauseOf: () => ({ reason: '告警记录', at: 1, kind: 'consecutiveFailures' }) });
    expect(scheduler.getState(1).pause).toEqual({ reason: '告警记录', at: 1, kind: 'consecutiveFailures' });
    scheduler.setHooks({ pauseOf: undefined });
    // Switching auto on again (the alerts resume path) resets the failure count.
    samples.push(async () => panel(2, 5));
    await scheduler.setAuto(1, true);
    expect(scheduler.getState(1)).toMatchObject({ auto: true, failureCount: 0, pause: null });
  });

  it('never leaves auto on without a wake when a sample is aborted by something else', async () => {
    const scheduler = await ready();
    samples.push(async () => { throw new SchedulerError('RUN_ABORTED', '视觉工作线程被中止'); });
    const state = await scheduler.setAuto(1, true);
    expect(state).toMatchObject({ auto: true, nextWakeAt: Date.now() + 30_000 });
    samples.push(async () => { throw new SchedulerError('CANCELLED', '被别处中止'); });
    await vi.advanceTimersByTimeAsync(30_000);
    await until(() => (scheduler.getState(1).nextWakeReason ?? '').includes('第 2 次'), '中止后退避');
    expect(scheduler.getState(1)).toMatchObject({ auto: true, failureCount: 0 });
  });

  it('treats circuitBroken as not a failure and wakes no earlier than its cooldown', async () => {
    const scheduler = await ready();
    const cooldown = START + 30_000 + 10 * 60_000;
    scheduler.setQueueFreeHook(async () => ({ dispatched: 0, notBefore: cooldown, reason: '熔断冷却' }));
    samples.push(async () => panel(2, 5));
    await scheduler.setAuto(1, true);
    samples.push(async () => panel(2, 5));
    await vi.advanceTimersByTimeAsync(30_000);
    await until(() => scheduler.getState(1).nextWakeAt === cooldown, '熔断冷却唤醒');
    expect(scheduler.getState(1)).toMatchObject({ auto: true, failureCount: 0 });
    expect(scheduler.getState(1).nextWakeReason).toContain('最早');
  });

  it('keeps health probes running through the 10-minute circuit-breaker cooldown, then looks again', async () => {
    const scheduler = make();
    await scheduler.restore();
    const probes: number[] = [];
    scheduler.setHooks({ onHealthProbe: async () => { probes.push(Date.now()); } });
    let rounds = 0;
    scheduler.setQueueFreeHook(async () => {
      rounds++;
      return { dispatched: 0, notBefore: Date.now() + 10 * 60_000, reason: '熔断中，10 分钟后复查' };
    });
    samples.push(async () => panel(2, 5));
    await scheduler.setAuto(1, true);
    samples.push(async () => panel(2, 5));
    await vi.advanceTimersByTimeAsync(30_000);
    const cooldownEnd = START + 30_000 + 10 * 60_000;
    await until(() => rounds === 1 && scheduler.getState(1).nextWakeReason === '健康探针', '熔断后先排健康探针');
    expect(scheduler.getState(1)).toMatchObject({ auto: true, failureCount: 0, nextWakeAt: START + 30_000 + 3 * 60_000 });
    for (const [n, next] of [[1, START + 30_000 + 6 * 60_000], [2, START + 30_000 + 9 * 60_000], [3, cooldownEnd]] as const) {
      await vi.advanceTimersByTimeAsync(3 * 60_000);
      await until(() => probes.length === n && scheduler.getState(1).nextWakeAt === next, `冷却期内第 ${n} 次健康探针`);
    }
    // No panel read and no dispatch hand-off inside the cooldown; the wake at its end is a normal sample.
    expect(sampleCalls).toHaveLength(2);
    expect(scheduler.getState(1).nextWakeReason).toContain('最早');
    samples.push(async () => panel(2, 5));
    await vi.advanceTimersByTimeAsync(60_000);
    await until(() => rounds === 2, '冷却结束后复查');
    expect(sampleCalls).toHaveLength(3);
    expect(scheduler.getState(1).failureCount).toBe(0);
  });

  it('pauses without counting a failure when the cycle needs a human', async () => {
    const attention = vi.fn();
    const scheduler = await ready();
    scheduler.setHooks({ onNeedsAttention: attention });
    scheduler.setQueueFreeHook(async () => { throw new SchedulerError('GAME_UPDATE_REQUIRED', '游戏需要更新'); });
    samples.push(async () => panel(2, 5));
    await scheduler.setAuto(1, true);
    samples.push(async () => panel(2, 5));
    await vi.advanceTimersByTimeAsync(30_000);
    await until(() => !scheduler.getState(1).auto, '人工处理暂停');
    // Pause first, then the alert (it follows the persisted pause).
    await until(() => attention.mock.calls.length > 0, '人工处理告警');
    expect(attention).toHaveBeenCalledWith(1, { code: 'GAME_UPDATE_REQUIRED', message: '游戏需要更新' });
    expect(scheduler.getState(1).failureCount).toBe(0);
    // The pause itself is the alerts module's record (the hook above); without one the queue view invents none.
    expect(scheduler.getState(1).pause).toBeNull();
  });

  it('raises the host fallback alert for a human-needed pause while no module handles it', async () => {
    const fallback = vi.fn();
    const scheduler = await ready({ onAttentionPause: fallback });
    scheduler.setQueueFreeHook(async () => { throw new SchedulerError('AI_RISK_BLOCKED', '确认框风险过高'); });
    samples.push(async () => panel(2, 5));
    await scheduler.setAuto(1, true);
    samples.push(async () => panel(2, 5));
    await vi.advanceTimersByTimeAsync(30_000);
    await until(() => !scheduler.getState(1).auto, '人工处理暂停');
    await until(() => fallback.mock.calls.length > 0, '兜底告警');
    expect(fallback).toHaveBeenCalledWith(1, { code: 'AI_RISK_BLOCKED', message: '确认框风险过高' });
  });

  // ── original reliability-offline-check (scheduler parts) ──

  it('keeps the old wake cancelled when auto is re-enabled while its sample is in flight; a new wake dispatches once', async () => {
    const scheduler = await ready();
    let dispatches = 0;
    scheduler.setQueueFreeHook(async () => { dispatches++; return { dispatched: 0 }; });
    samples.push(async () => panel(4, 5));
    await scheduler.setAuto(1, true);
    let entered = false;
    let releaseOld!: () => void;
    const oldGate = new Promise<void>((resolve) => { releaseOld = resolve; });
    // The old sample ignores the abort (ADB already in flight) and then reports a free slot.
    samples.push(async () => { entered = true; await oldGate; return panel(0, 5); });
    await vi.advanceTimersByTimeAsync(30_000);
    await until(() => entered, '旧唤醒的采样开始');
    await scheduler.setAuto(1, false);
    samples.push(async () => panel(0, 5));
    const reenabling = scheduler.setAuto(1, true);
    await settle();
    releaseOld();
    expect(await reenabling).toMatchObject({ auto: true, queueUsed: 0 });
    await settle();
    expect(dispatches).toBe(0);
    samples.push(async () => panel(0, 5));
    await vi.advanceTimersByTimeAsync(30_000);
    await until(() => dispatches === 1, '新唤醒派遣');
    await settle();
    expect(dispatches).toBe(1);
  });

  it('never dispatches when paused while the dispatch hand-off waits for the instance lock', async () => {
    const scheduler = await ready();
    let dispatches = 0;
    scheduler.setQueueFreeHook(async () => { dispatches++; return { dispatched: 1 }; });
    samples.push(async () => panel(4, 5));
    await scheduler.setAuto(1, true);
    let sampling = false;
    let finishSample!: () => void;
    const sampleGate = new Promise<void>((resolve) => { finishSample = resolve; });
    samples.push(async () => { sampling = true; await sampleGate; return panel(0, 5); });
    await vi.advanceTimersByTimeAsync(30_000);
    await until(() => sampling, '唤醒采样开始');
    // Another holder queues while the sample runs, so the hand-off after it queues behind this holder.
    let holderIn = false;
    let releaseHolder!: () => void;
    const holderGate = new Promise<void>((resolve) => { releaseHolder = resolve; });
    const holder = scheduler.locks.run(1, '测试占用', async () => { holderIn = true; await holderGate; });
    finishSample();
    await until(() => holderIn, '占用方拿到实例锁');
    await scheduler.setAuto(1, false);
    releaseHolder();
    await holder;
    await until(() => !scheduler.locks.busy(1), '实例锁排空');
    expect(dispatches).toBe(0);
    expect(scheduler.listWakes()).toEqual([]);
  });

  // ── original freeze-offline-check section 4 (wiring to the real scheduler) ──

  it('reports a device failure to onCaptureFailed with its code and awaits a re-entrant onSampleResult', async () => {
    const captureFailures: string[] = [];
    const results: Array<{ ok: boolean; hasSignal: boolean }> = [];
    let exclusiveRan = false;
    let awaited = false;
    let calls = 0;
    const scheduler = await ready({}, {
      // Ready for the enable gate, then the device cannot be resolved inside the sample (original resolveDevice).
      instance: async () => {
        if (++calls > 1) throw new SchedulerError('ADB_TIMEOUT', '离线自检：adb 命令超时');
        return instance;
      },
    });
    scheduler.setHooks({
      onCaptureFailed: (_index, error) => { captureFailures.push(error.code); },
      onSampleResult: async (index, ok, _message, ctx) => {
        results.push({ ok, hasSignal: ctx.signal instanceof AbortSignal });
        if (ok) return;
        // Freeze recovery calls exclusive() from here, inside the lock: it must re-enter, not deadlock.
        await scheduler.exclusive(index, '卡死重启', async () => { exclusiveRan = scheduler.locks.held(index); });
        awaited = true;
      },
    });
    await scheduler.setAuto(1, true);
    expect(captureFailures).toContain('ADB_TIMEOUT');
    expect(results).toEqual([{ ok: false, hasSignal: true }]);
    expect(awaited).toBe(true);
    expect(exclusiveRan).toBe(true);
    expect(ports.sample).not.toHaveBeenCalled();
    // Failed first sample: still a backoff wake, never auto without a timer.
    expect(scheduler.listWakes().map((wake) => wake.instanceIndex)).toEqual([1]);
  });

  it('never registers an instance on a read and ignores a disable of an unknown one', async () => {
    const scheduler = await ready();
    expect(scheduler.getState(7)).toMatchObject({ instanceIndex: 7, auto: false, queueUsed: null });
    expect((await scheduler.setAuto(7, false)).auto).toBe(false);
    expect(scheduler.list()).toEqual([]);
    await expect(stat(path.join(home, 'automation', 'games', 'wanlong', 'scheduler', 'instances', '7.json'))).rejects.toThrow();
    expect(() => scheduler.getState(64)).toThrow('实例编号非法');
  });

  it('re-arms a restored auto instance on the backoff ladder when its state cannot be read at startup', async () => {
    const first = await ready();
    samples.push(async () => panel(5, 5));
    await first.setAuto(1, true);
    await first.dispose();
    const second = make({}, { instance: async () => { throw new Error('模拟器管理器还没就绪'); } });
    await second.restore();
    expect(second.getState(1)).toMatchObject({ auto: true, nextWakeAt: Date.now() + 30_000 });
    expect(second.getState(1).nextWakeReason).toContain('退避重试（第 1 次');
  });

  it('awaits onSampleResult inside the lock with the run signal', async () => {
    const scheduler = await ready();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const seen: Array<[boolean, boolean]> = [];
    scheduler.setHooks({
      onSampleResult: async (index, ok, _message, ctx) => {
        seen.push([ok, scheduler.locks.held(index)]);
        expect(ctx.signal.aborted).toBe(false);
        await gate;
      },
    });
    let done = false;
    const enabling = scheduler.setAuto(1, true).then(() => { done = true; });
    await until(() => seen.length === 1, '采样结果回调');
    await settle();
    expect(done).toBe(false);
    release();
    await enabling;
    expect(seen).toEqual([[true, true]]);
  });

  it('runs a health probe inside the lock without opening the panel', async () => {
    const scheduler = make();
    await scheduler.restore();
    const probes: Array<{ foreground: string | null; running: boolean | null; held: boolean }> = [];
    scheduler.setHooks({
      onHealthProbe: async (index, _raw, ctx) => { probes.push({ foreground: ctx.foreground, running: ctx.running, held: scheduler.locks.held(index) }); },
    });
    samples.push(async () => panel(5, 5, [gatheringRow(1, 2 * 3_600_000)]));
    await scheduler.setAuto(1, true);
    expect(scheduler.getState(1).nextWakeReason).toBe('健康探针');
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    await until(() => probes.length === 1 && scheduler.getState(1).nextWakeAt !== null, '健康探针');
    expect(probes[0]).toEqual({ foreground: PACKAGE, running: true, held: true });
    expect(ports.sample).toHaveBeenCalledTimes(1);
    expect(scheduler.getState(1).nextWakeAt).toBe(Date.now() + 3 * 60_000);
  });

  it('suspends for a script: polite wait, then abort; release re-reads the queue 15 s later with a fresh signal', async () => {
    const scheduler = await ready();
    await scheduler.setAuto(1, true);
    let inflight: SampleRequest | null = null;
    samples.push((req) => new Promise<PanelSample>((_resolve, reject) => {
      inflight = req;
      req.signal.addEventListener('abort', () => reject(req.signal.reason), { once: true });
    }));
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    await until(() => inflight !== null, '唤醒采样开始');
    const suspending = scheduler.suspendForScript(1, 100, '日常脚本');
    await settle();
    expect(inflight!.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    const release = await suspending;
    expect(inflight!.signal.aborted).toBe(true);
    expect(scheduler.getState(1)).toMatchObject({ auto: true, nextWakeAt: null, operating: false });
    await expect(scheduler.exclusive(1, '截图', async () => 'shot')).rejects.toMatchObject({ code: 'CONCURRENCY_LIMIT' });
    release();
    release();
    expect(scheduler.getState(1)).toMatchObject({ nextWakeAt: Date.now() + 15_000, nextWakeReason: '脚本执行结束，重读队列校验' });
    await vi.advanceTimersByTimeAsync(15_000);
    await until(() => sampleCalls.length === 3, '脚本后重读');
    expect(sampleCalls[2].signal.aborted).toBe(false);
    expect(sampleCalls[2].reason).toContain('脚本执行结束');
  });

  it('refuses exclusive() while another writer owns the instance and queues behind a sample', async () => {
    let busy: string | null = '账号登录';
    const scheduler = await ready({}, { externalBusy: () => busy });
    await expect(scheduler.exclusive(1, '读资源统计', async () => 1)).rejects.toThrow('上正有账号登录，读资源统计稍后再试');
    busy = null;
    let finishSample!: () => void;
    const order: string[] = [];
    samples.push(() => new Promise<PanelSample>((resolve) => { finishSample = () => { order.push('sample'); resolve(panel(5, 5)); }; }));
    const enabling = scheduler.setAuto(1, true);
    await until(() => sampleCalls.length === 1, '采样开始');
    const exclusive = scheduler.exclusive(1, '截图', async () => { order.push('exclusive'); return 7; });
    await settle();
    expect(order).toEqual([]);
    finishSample();
    expect(await exclusive).toBe(7);
    await enabling;
    expect(order).toEqual(['sample', 'exclusive']);
  });

  it('persists absolute times and restores auto instances without sampling', async () => {
    const first = await ready();
    samples.push(async () => panel(5, 5, [gatheringRow(1, 3_600_000)]));
    await first.setAuto(1, true);
    await first.noteDispatches(1, Array.from({ length: 12 }, (_, i) => ({ travelTimeMs: 1000 * i, coord: `${i},1` })), { resample: false });
    const wakeAt = first.getState(1).nextWakeAt;
    await first.dispose();
    const file = path.join(home, 'automation', 'games', 'wanlong', 'scheduler', 'instances', '1.json');
    const stored = JSON.parse(await readFile(file, 'utf8'));
    expect(stored).toMatchObject({ version: 1, auto: true, instanceCreatedAt: CREATED_AT, queueUsed: 5 });
    expect(stored.travelHints).toHaveLength(8);
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);

    const calls = (ports.sample as ReturnType<typeof vi.fn>).mock.calls.length;
    const second = make();
    await second.restore();
    expect(ports.sample).toHaveBeenCalledTimes(calls);
    expect(second.getState(1)).toMatchObject({ auto: true, queueUsed: 5, lastSampleOk: true });
    expect(second.getState(1).marches[0]?.freeAt).toEqual(expect.any(Number));
    expect(second.getState(1).nextWakeAt).toBe(wakeAt);
  });

  it('turns auto off and clears bookkeeping when another AVD now lives at the index', async () => {
    const first = await ready();
    samples.push(async () => panel(5, 5, [gatheringRow(1, 3_600_000)]));
    await first.setAuto(1, true);
    await first.dispose();
    instance = { status: 'running', createdAt: 'replaced-avd' };
    const second = make();
    await second.restore();
    expect(second.getState(1)).toMatchObject({ auto: false, marches: [], queueUsed: null });
    expect(second.listWakes()).toEqual([]);
  });

  it('migrates an enabled legacy schedule once and keeps the old file aside', async () => {
    const dir = path.join(home, 'automation', 'scheduler', 'wanlong');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, '2.json'), JSON.stringify({ gameId: 'wanlong', index: 2, enabled: true, nextWakeAt: 1, failureCount: 3 }));
    await writeFile(path.join(dir, '3.json'), JSON.stringify({ gameId: 'wanlong', index: 3, enabled: false, nextWakeAt: null, failureCount: 0 }));
    const scheduler = make();
    await scheduler.restore();
    expect(scheduler.isAuto(2)).toBe(true);
    expect(scheduler.isAuto(3)).toBe(false);
    expect(scheduler.getState(2).nextWakeAt).toEqual(expect.any(Number));
    expect((await readdir(dir)).sort()).toEqual(['2.json.migrated', '3.json.migrated']);
    expect(ports.sample).not.toHaveBeenCalled();
  });

  it('validates dispatch notes, forgets an instance and cancels a wake without turning auto off', async () => {
    const scheduler = await ready();
    await scheduler.setAuto(1, true);
    await expect(scheduler.noteDispatch(1, { travelTimeMs: -5 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    scheduler.cancelWake(1);
    expect(scheduler.getState(1)).toMatchObject({ auto: true, nextWakeAt: null });
    await scheduler.forget(1);
    expect(scheduler.getState(1)).toMatchObject({ auto: false, queueUsed: null, lastSampledAt: 0 });
    await expect(stat(path.join(home, 'automation', 'games', 'wanlong', 'scheduler', 'instances', '1.json'))).rejects.toThrow();
  });

  it('clamps and persists config changes and re-plans auto instances', async () => {
    const published: unknown[] = [];
    const scheduler = make({ publishConfig: (config) => published.push(config) });
    await scheduler.restore();
    const saved = await scheduler.saveConfig({ slackSeconds: 99_999, retryBackoffSeconds: [10, -1, 20], healthProbeIntervalMin: 0 });
    expect(saved).toMatchObject({ slackSeconds: 3600, retryBackoffSeconds: [10, 20], healthProbeIntervalMin: 0 });
    expect(published).toHaveLength(1);
    const reloaded = make();
    await reloaded.restore();
    expect(reloaded.getConfig()).toMatchObject({ slackSeconds: 3600, retryBackoffSeconds: [10, 20] });
  });

  it('keeps a second process read-only through the owner lease: it never writes the owner\'s files', async () => {
    vi.useRealTimers();
    const owner = make({ ownerLease: true });
    await owner.restore();
    samples.push(async () => panel(5, 5));
    await owner.setAuto(1, true);
    const file = path.join(home, 'automation', 'games', 'wanlong', 'scheduler', 'instances', '1.json');
    const before = await readFile(file, 'utf8');
    const viewer = make({ ownerLease: true });
    await viewer.restore();
    expect(viewer.getState(1)).toMatchObject({ auto: true, readOnly: true, nextWakeAt: null });
    expect(viewer.listWakes()).toEqual([]);
    await expect(viewer.setAuto(2, true)).rejects.toMatchObject({ code: 'CONCURRENCY_LIMIT' });
    await expect(viewer.setAuto(1, false)).rejects.toMatchObject({ code: 'CONCURRENCY_LIMIT' });
    await expect(viewer.forget(1)).rejects.toMatchObject({ code: 'CONCURRENCY_LIMIT' });
    await expect(viewer.saveConfig({ slackSeconds: 5 })).rejects.toMatchObject({ code: 'CONCURRENCY_LIMIT' });
    await expect(viewer.sampleNow(1)).rejects.toMatchObject({ code: 'CONCURRENCY_LIMIT' });
    expect((await viewer.setAuto(3, false)).auto).toBe(false);
    await viewer.noteDispatches(1, [{ travelTimeMs: 1000 }], { resample: false });
    await viewer.dispose();
    expect(await readFile(file, 'utf8')).toBe(before);
    expect(owner.getState(1).readOnly).toBeUndefined();
    await owner.dispose();
  });

  it('takes the scheduler over once the owning process quits and re-arms its auto instances', async () => {
    vi.useRealTimers();
    const owner = make({ ownerLease: true });
    await owner.restore();
    samples.push(async () => panel(5, 5));
    await owner.setAuto(1, true);
    const statuses: Array<{ owner: boolean; message: string | null }> = [];
    const viewer = make({ ownerLease: true, ownerRetryMs: 20, publishStatus: (status) => statuses.push(status) });
    await viewer.restore();
    expect(viewer.status()).toMatchObject({ gameId: 'wanlong', owner: false, message: expect.stringContaining('30 秒内自动接管') });
    expect(statuses).toEqual([expect.objectContaining({ owner: false })]);
    await expect(viewer.setAuto(1, false)).rejects.toThrow('自动接管');
    await owner.dispose();
    await until(() => statuses.at(-1)?.owner === true, '接管调度');
    expect(statuses.at(-1)).toMatchObject({ owner: true, message: null });
    expect(viewer.getState(1).readOnly).toBeUndefined();
    expect(viewer.getState(1)).toMatchObject({ auto: true, nextWakeAt: expect.any(Number) });
    expect(viewer.listWakes()).toHaveLength(1);
    expect((await viewer.setAuto(1, false)).auto).toBe(false);
  });

  it('takes over a scheduler lease left behind by a crash once it goes stale (no read-only lifetime)', async () => {
    const first = await ready();
    samples.push(async () => panel(5, 5));
    await first.setAuto(1, true);
    await first.dispose();
    vi.useRealTimers();
    // A crashed owner: the lease directory exists and was refreshed moments ago, then nobody refreshes it.
    const lease = path.join(home, 'automation', 'games', 'wanlong', 'eta-scheduler.lock');
    await mkdir(lease, { recursive: true });
    const restarted = make({ ownerLease: true, ownerRetryMs: 20 });
    await restarted.restore();
    expect(restarted.status().owner).toBe(false);
    expect(restarted.listWakes()).toEqual([]);
    // 30 s later the heartbeat is stale; the next retry breaks it.
    const past = new Date(Date.now() - 60_000);
    await utimes(lease, past, past);
    await until(() => restarted.listWakes().length === 1, '接管过期租约');
    expect(restarted.status().owner).toBe(true);
    expect(restarted.getState(1)).toMatchObject({ auto: true, nextWakeAt: expect.any(Number) });
    expect(logs.join('\n')).toContain('已接管自动采集调度');
  });

  it('lets an operation that arrives during restore wait for it instead of being overwritten by the file', async () => {
    const first = await ready();
    samples.push(async () => panel(5, 5, [gatheringRow(1, 3_600_000)]));
    await first.setAuto(1, true);
    samples.push(async () => panel(2, 5));
    await first.setAuto(2, true);
    await first.setAuto(1, false);
    await first.dispose();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const second = make({}, {
      // Instance 2 is re-armed at restore; its state read is slow.
      instance: vi.fn(async (index: number) => { if (index === 2) await gate; return instance; }),
    });
    const restoring = second.restore();
    const enabling = second.setAuto(1, true);
    await settle();
    expect(ports.sample).toHaveBeenCalledTimes(2);
    release();
    await restoring;
    const state = await enabling;
    // The persisted march survived and the enable took effect (its first sample is throttled right after restart).
    expect(state).toMatchObject({ auto: true, queueUsed: 5 });
    expect(state.marches).toHaveLength(1);
    expect(second.isAuto(2)).toBe(true);
    expect(second.listWakes().map((wake) => wake.instanceIndex).sort()).toEqual([1, 2]);
  });
});
