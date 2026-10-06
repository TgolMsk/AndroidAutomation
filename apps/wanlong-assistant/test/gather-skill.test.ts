import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { blockedVerdict, readyVerdict } from '@avdm/automation';
import { createRuntimeState, wanlongPlugin, type GatherCycleResult, type GatherRuntimeState, type PanelSample } from '@avdm/automation/wanlong';
import { AutomationHost } from '../src/main/automation/host';
import { SkillShadow, createGatherSkill, toQueueFreeResult, type GatherHandoff } from '../src/main/automation/skills';
import { InstanceLocks } from '../src/main/scheduler/instance-lock';
import type { ManagerHost } from '../src/main/manager-host';
import type { AutomationProbeReport } from '../src/shared/ipc';

const { broadcast } = vi.hoisted(() => ({ broadcast: vi.fn() }));
vi.mock('../src/main/events', () => ({ broadcast }));

const signal = new AbortController().signal;

describe('gather skill glue', () => {
  it('runs the scheduler hand-off and gives the scheduler back exactly what the hand-off returned', async () => {
    const handoffs: GatherHandoff[] = [
      { dispatched: 2, outcome: 'dispatched', message: '本轮已派出 2 支队伍。' },
      { dispatched: 0, outcome: 'noResourceWanted', message: '每种资源的队列配额都已满足，本轮无需派兵。' },
      { dispatched: 0, notBefore: 1_000, reason: '熔断中，10 分钟后复查', outcome: 'circuitBroken', message: '最近一小时已派兵 30 次' },
    ];
    for (const handoff of handoffs) {
      const skill = createGatherSkill(async (index, s) => {
        expect([index, s]).toEqual([4, signal]);
        return handoff;
      });
      const result = await skill.run({ index: 4, signal });
      const { outcome: _outcome, message: _message, ...queueFree } = handoff;
      expect(toQueueFreeResult(result)).toEqual(queueFree);
    }
    const skill = createGatherSkill(async () => handoffs[2]!);
    expect(await skill.run({ index: 4, signal })).toEqual({
      skillId: 'gather', outcome: 'deferred', message: '熔断中，10 分钟后复查', count: 0, notBefore: 1_000,
    });
    expect(skill).toMatchObject({ id: 'gather', title: '自动采集' });
  });

  it('passes a failed cycle through as the same error', async () => {
    const error = new Error('回不到世界地图');
    const skill = createGatherSkill(async () => { throw error; });
    await expect(skill.run({ index: 1, signal })).rejects.toBe(error);
  });

  it('logs a shadow disagreement once until the verdict and the result agree again', () => {
    const shadow = new SkillShadow();
    const skill = { id: 'gather', title: '自动采集' };
    const idle = { skillId: 'gather', outcome: 'idle' as const, message: '队列已满', count: 0, notBefore: null };
    const done = { skillId: 'gather', outcome: 'done' as const, message: '本轮已派出 1 支队伍。', count: 1, notBefore: null };

    expect(shadow.note(1, skill, readyVerdict('可派 1 支'), idle)).toBe('[影子模式] 技能「自动采集」预判可做（可派 1 支），实际没做成：队列已满');
    expect(shadow.note(1, skill, readyVerdict('可派 1 支'), idle)).toBeNull();
    expect(shadow.note(2, skill, readyVerdict('可派 1 支'), idle)).not.toBeNull();
    expect(shadow.note(1, skill, readyVerdict('可派 1 支'), done)).toBeNull();
    expect(shadow.note(1, skill, readyVerdict('可派 1 支'), idle)).not.toBeNull();
    expect(shadow.note(1, skill, blockedVerdict('冷却中'), done)).toBe('[影子模式] 技能「自动采集」预判不可做（冷却中），实际做成了：本轮已派出 1 支队伍。');
  });
});

function result(outcome: GatherCycleResult['outcome'], message: string): GatherCycleResult {
  return {
    outcome, message, dispatched: [], queue: null, nextWakeAt: Date.now() + 60_000,
    nextWakeReason: '建议一分钟后检查', captures: 1, state: createRuntimeState(), warnings: [],
  };
}

function panel(used: number, total: number): PanelSample {
  return { sampledAt: Date.now(), queueUsed: used, queueTotal: total, rows: [], warnings: [] };
}

function probeReport(): AutomationProbeReport {
  return {
    gameId: 'wanlong', packageName: wanlongPlugin.packageName, foregroundPackage: wanlongPlugin.packageName,
    deviceWidth: 2560, deviceHeight: 1440, capturedAt: Date.now(), matches: [],
    launchReady: true, launchReason: '已确认世界地图画面', timingsMs: { adb: 1, prepare: 1, match: 1, worker: 1, total: 4 },
  };
}

describe('the scheduled hand-off as the gather skill (shadow mode)', () => {
  let home: string;
  let host: AutomationHost;
  let outcome: GatherCycleResult;
  let runtime: GatherRuntimeState;
  const manager = {
    getState: async () => ({ status: 'running', record: { createdAt: '2026-09-23T00:00:00Z' } }),
    device: async () => ({ foregroundPackage: async () => wanlongPlugin.packageName }),
  };
  const runner = {
    runOnce: vi.fn(async () => outcome),
    sample: vi.fn(async () => panel(2, 5)),
    runtimeState: vi.fn(async () => runtime),
    stop: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
    isRunning: vi.fn(() => false),
  };
  const shadowLines = () => broadcast.mock.calls
    .filter(([channel, payload]) => channel === 'log' && String((payload as { message: string }).message).includes('影子模式'))
    .map(([, payload]) => (payload as { message: string }).message);

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    broadcast.mockReset();
    for (const fn of Object.values(runner)) fn.mockClear();
    runtime = createRuntimeState();
    home = await mkdtemp(path.join(tmpdir(), 'avdm-gather-skill-'));
    host = new AutomationHost({ get: async () => manager } as unknown as ManagerHost, home, runner, undefined, {}, {
      locks: new InstanceLocks(home, { fileLock: async (_path, fn) => fn() }),
      scheduler: { ownerLease: false, random: () => 0 },
    });
    vi.spyOn(host, 'probe').mockImplementation(async () => probeReport());
    await host.saveSettings('wanlong', 1, { templateDir: home, config: { version: 2, enabled: true } });
  });

  afterEach(async () => {
    await host.dispose();
    vi.useRealTimers();
    await rm(home, { recursive: true, force: true });
  });

  it('logs a check that said ready while the cycle found nothing to do, once for a steady state', async () => {
    outcome = result('noResourceWanted', '每种资源的队列配额都已满足，本轮无需派兵。');
    await host.setSchedule('wanlong', 1, true);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(runner.runOnce).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(shadowLines()).toEqual([
      '[万龙] [实例 #1] [影子模式] 技能「自动采集」预判可做（可派 3 支，还欠：木材、金币、铁矿石），' +
        '实际没做成：每种资源的队列配额都已满足，本轮无需派兵。',
    ]));
    expect(runner.runtimeState).toHaveBeenCalledWith(1);

    // The next backoff wake finds the same situation: nothing new is logged.
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    await vi.waitFor(() => expect(runner.runOnce.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(shadowLines()).toHaveLength(1);
  });

  it('stays quiet when the check and the cycle agree, and still hands the circuit breaker cooldown to the scheduler', async () => {
    // 30 dispatches within the hour: the check predicts the cycle's circuit breaker.
    runtime = { ...createRuntimeState(), dispatchTimestamps: Array.from({ length: 30 }, (_, i) => Date.now() - (i + 1) * 60_000) };
    outcome = result('circuitBroken', '最近一小时已派兵 30 次，达到熔断上限 30 次');
    await host.setSchedule('wanlong', 1, true);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(runner.runOnce).toHaveBeenCalledTimes(1));
    // The breaker's 10-minute notBefore reached the scheduler: only health probes until it ends, no sample, no cycle.
    const samples = runner.sample.mock.calls.length;
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    expect(runner.sample).toHaveBeenCalledTimes(samples);
    expect(runner.runOnce).toHaveBeenCalledTimes(1);
    expect(shadowLines()).toEqual([]);
  });
});
