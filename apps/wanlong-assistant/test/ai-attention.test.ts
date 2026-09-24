/**
 * 「需要人处理」 (GAME_UPDATE_REQUIRED / AI_RISK_BLOCKED) raised by the AI chain on every path: the composition root's
 * AI hook is `automation.eta.raiseAttention(index, info)` (original recoverUnknownWithUpdate → alertCenter.raise).
 * It pauses first (awaited, persisted), then alerts once through the scheduler's own attention path — also on the
 * paths the wake loop never sees (the re-sample after a dispatch, a manual refresh, a script run) — and the aborted
 * wake of a scheduled chain stays silent instead of alerting twice.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PanelSample } from '@avdm/automation/wanlong/pure';
import { SchedulerError } from '../src/main/scheduler/errors';
import { InstanceLocks } from '../src/main/scheduler/instance-lock';
import { EtaScheduler, type EtaSchedulerOptions } from '../src/main/scheduler/service';
import type { EtaSchedulerPorts, SampleRequest } from '../src/main/scheduler/types';

const START = Date.parse('2026-09-24T04:00:00.000Z');
const CREATED_AT = '2026-09-01T00:00:00.000Z';
const RISK = { code: 'AI_RISK_BLOCKED', message: 'AI 判断这个确认框会花费钻石，已停止自动操作' };

function panel(used: number | null, total: number | null): PanelSample {
  return { sampledAt: Date.now(), queueUsed: used, queueTotal: total, rows: [], warnings: [] };
}

async function until(check: () => boolean, what: string, budgetMs = 5_000): Promise<void> {
  const deadline = performance.now() + budgetMs;
  while (performance.now() < deadline) {
    if (check()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  if (check()) return;
  throw new Error(`等待超时：${what}`);
}

const settle = () => until(() => false, '', 100).catch(() => undefined);

describe('AI「需要人处理」 → EtaScheduler.raiseAttention', () => {
  let home: string;
  let samples: Array<(req: SampleRequest) => Promise<PanelSample>>;
  let ports: EtaSchedulerPorts;
  let schedulers: EtaScheduler[];
  let alerts: Array<{ index: number; code: string; autoAtAlert: boolean }>;

  function make(options: EtaSchedulerOptions = {}): EtaScheduler {
    const scheduler = new EtaScheduler(home, ports, {
      ownerLease: false, random: () => 0, log: () => undefined,
      locks: new InstanceLocks(home, { fileLock: async (_path, fn) => fn() }), ...options,
    });
    schedulers.push(scheduler);
    return scheduler;
  }

  /** Auto on for instance 1 (first sample: a free slot, so the first wake is 30 s later), the attention hook recording what it saw. */
  async function autoOn(): Promise<EtaScheduler> {
    const scheduler = make();
    await scheduler.restore();
    await scheduler.saveConfig({ healthProbeIntervalMin: 0 });
    scheduler.setHooks({
      onNeedsAttention: (index, info) => { alerts.push({ index, code: info.code, autoAtAlert: scheduler.isAuto(index) }); },
    });
    samples.push(async () => panel(2, 5));
    await scheduler.setAuto(1, true);
    expect(scheduler.isAuto(1)).toBe(true);
    return scheduler;
  }

  /** What the AI hook does inside a sample / cycle: raise (pause + alert), then the chain rethrows the code. */
  function aiBlocks(scheduler: EtaScheduler): () => Promise<never> {
    return async () => {
      await scheduler.raiseAttention(1, RISK);
      throw new SchedulerError('AI_RISK_BLOCKED', RISK.message);
    };
  }

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(START);
    home = await mkdtemp(path.join(tmpdir(), 'avdm-ai-attention-'));
    samples = [];
    schedulers = [];
    alerts = [];
    ports = {
      sample: vi.fn(async (_index: number, req: SampleRequest) => (samples.shift() ?? (async () => panel(5, 5)))(req)),
      healthFrame: vi.fn(async () => ({ raw: { width: 2, height: 2, data: new Uint8Array(16), capturedAt: Date.now() }, foreground: null, running: true })),
      instance: vi.fn(async () => ({ status: 'running', createdAt: CREATED_AT })),
    };
  });

  afterEach(async () => {
    vi.useRealTimers();
    await Promise.allSettled(schedulers.map((scheduler) => scheduler.dispose()));
    await rm(home, { recursive: true, force: true });
  });

  it('pauses first (persisted), then alerts once; an instance already paused by an alert is not alerted again', async () => {
    const scheduler = await autoOn();
    await scheduler.raiseAttention(1, RISK);
    expect(alerts).toEqual([{ index: 1, code: 'AI_RISK_BLOCKED', autoAtAlert: false }]);
    expect(scheduler.getState(1)).toMatchObject({ auto: false, nextWakeAt: null });
    expect(scheduler.listWakes()).toEqual([]);
    // Persisted before the alert: a fresh process restores the instance paused.
    const reloaded = make();
    await reloaded.restore();
    expect(reloaded.getState(1).auto).toBe(false);

    // The alerts module's pause record is there and auto is off: no second alert, still no throw.
    scheduler.setHooks({ pauseOf: () => ({ reason: RISK.message, at: START }) });
    await scheduler.raiseAttention(1, RISK);
    expect(alerts).toHaveLength(1);
  });

  it('alerts even when auto is off (a manual cycle or a script run on an instance without auto scheduling)', async () => {
    const fallback: Array<[number, string]> = [];
    const plain = make({ onAttentionPause: (index, info) => { fallback.push([index, info.code]); } });
    await plain.restore();
    await plain.raiseAttention(2, { code: 'GAME_UPDATE_REQUIRED', message: '游戏需要更新资源' });
    expect(fallback).toEqual([[2, 'GAME_UPDATE_REQUIRED']]);
    expect(plain.isAuto(2)).toBe(false);
  });

  it('the re-sample after a dispatch meets the risk: paused and alerted once, nothing re-armed', async () => {
    const scheduler = await autoOn();
    samples.push(aiBlocks(scheduler));
    await scheduler.noteDispatches(1, [{ travelTimeMs: 60_000, coord: '100,200', resourceType: 'wood' }]);
    await settle();
    expect(alerts).toEqual([{ index: 1, code: 'AI_RISK_BLOCKED', autoAtAlert: false }]);
    expect(scheduler.getState(1)).toMatchObject({ auto: false, nextWakeAt: null });
    expect(scheduler.listWakes()).toEqual([]);
  });

  it('a manual refresh meets the risk: paused and alerted, the caller still sees the error', async () => {
    const scheduler = await autoOn();
    // Past the minimum sample interval, before the first wake.
    vi.setSystemTime(START + 20_000);
    samples.push(aiBlocks(scheduler));
    await expect(scheduler.sampleNow(1)).rejects.toMatchObject({ code: 'AI_RISK_BLOCKED' });
    expect(alerts).toEqual([{ index: 1, code: 'AI_RISK_BLOCKED', autoAtAlert: false }]);
    expect(scheduler.isAuto(1)).toBe(false);
    expect(scheduler.listWakes()).toEqual([]);
  });

  it('a scheduled gather cycle meets the risk: one alert, not a second one from the aborted wake', async () => {
    const scheduler = await autoOn();
    scheduler.setQueueFreeHook(aiBlocks(scheduler));
    samples.push(async () => panel(2, 5));
    await vi.advanceTimersByTimeAsync(30_000);
    await until(() => alerts.length > 0, '人工处理告警');
    await settle();
    expect(alerts).toEqual([{ index: 1, code: 'AI_RISK_BLOCKED', autoAtAlert: false }]);
    expect(scheduler.getState(1)).toMatchObject({ auto: false, failureCount: 0 });
    expect(scheduler.listWakes()).toEqual([]);
  });
});
