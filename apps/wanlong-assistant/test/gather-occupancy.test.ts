import { describe, expect, it } from 'vitest';
import type { ScriptRunSnapshot } from '../src/main/plans/types';
import type { PlanRun } from '../src/shared/plan';
import { batchTargets, type BatchCandidate } from '../src/renderer/views/gather/batch';
import {
  configSaveBlockedReason, describeScriptOccupancy, scriptHoldReason, scriptOccupancyOf,
} from '../src/renderer/views/gather/occupancy';

function run(patch: Partial<ScriptRunSnapshot> = {}): ScriptRunSnapshot {
  return { runId: 'run-1', instanceIndex: 1, scriptName: '日常领取', status: 'running', source: 'plan', ...patch } as ScriptRunSnapshot;
}

function planRun(runId: string, instanceIndex: number, status: PlanRun['status']): Pick<PlanRun, 'runId' | 'instanceIndex' | 'status'> {
  return { runId, instanceIndex, status };
}

describe('script occupancy of an instance (plans module × gather: scripts pre-empt gathering)', () => {
  it('a live script run and the plan rounds still queued for the same instance; other instances and ended rounds ignored', () => {
    const planRuns = [planRun('run-1', 1, 'running'), planRun('q1', 1, 'queued'), planRun('q2', 1, 'queued'), planRun('q3', 2, 'queued'), planRun('d', 1, 'succeeded')];
    expect(scriptOccupancyOf(1, run(), planRuns)).toEqual({
      running: { runId: 'run-1', scriptName: '日常领取', status: 'running', source: 'plan' }, queued: 2,
    });
    // The queue record of the round that is running now is not counted as waiting.
    expect(scriptOccupancyOf(1, run(), [planRun('run-1', 1, 'queued')])?.queued).toBe(0);
    expect(scriptOccupancyOf(2, undefined, planRuns)).toEqual({ running: null, queued: 1 });
    expect(scriptOccupancyOf(3, undefined, planRuns)).toBeNull();
    // A snapshot of another instance never counts for this one.
    expect(scriptOccupancyOf(3, run({ instanceIndex: 1 }), [])).toBeNull();
  });

  it('the card line says the scheduler yields while auto is on, and what is refused while it is off', () => {
    const holding = scriptOccupancyOf(1, run(), [planRun('q1', 1, 'queued')]);
    const on = describeScriptOccupancy(holding, true)!;
    expect(on).toMatchObject({ text: '脚本运行中：日常领取', tone: 'accent', note: '自动采集已为脚本让路' });
    expect(on.tip).toContain('脚本优先：自动采集已为「日常领取」（计划任务）让路');
    expect(on.tip).toContain('后面还有 1 个计划任务排队');
    const off = describeScriptOccupancy(scriptOccupancyOf(1, run({ source: 'manual', status: 'paused' }), []), false)!;
    expect(off).toMatchObject({ text: '脚本已暂停：日常领取', tone: 'warning', note: '脚本占用期间不能采样' });
    expect(off.tip).toContain('「日常领取」（临时运行）正占用这个实例');
    const waiting = describeScriptOccupancy(scriptOccupancyOf(1, undefined, [planRun('q1', 1, 'queued')]), true)!;
    expect(waiting).toMatchObject({ text: '1 个计划任务排队中', tone: 'info', note: '轮到时自动采集会先让路' });
    expect(describeScriptOccupancy(scriptOccupancyOf(1, undefined, [planRun('q1', 1, 'queued')]), false)?.note).toBeNull();
    expect(describeScriptOccupancy(null, true)).toBeNull();
  });

  it('device actions and config saves are refused only while a script holds the instance (queued rounds do not)', () => {
    const holding = scriptOccupancyOf(1, run(), []);
    expect(scriptHoldReason(holding)).toBe('脚本「日常领取」正在这个实例上运行（脚本优先），等它结束再操作。');
    expect(configSaveBlockedReason(holding)).toContain('保存采集配置要等它结束');
    const queuedOnly = scriptOccupancyOf(1, undefined, [planRun('q1', 1, 'queued')]);
    expect(scriptHoldReason(queuedOnly)).toBeNull();
    expect(configSaveBlockedReason(queuedOnly)).toBeNull();
    expect(scriptHoldReason(null)).toBeNull();
  });

  it('a batch sample skips instances a script holds instead of collecting refusals; switching off still works', () => {
    const c = (index: number, patch: Partial<BatchCandidate> = {}): BatchCandidate => ({
      index, up: true, paused: false, isBase: false, auto: true, autoBusy: false, sampling: false, operating: false, ...patch,
    });
    const list = [c(0), c(1, { scriptRunning: true })];
    expect(batchTargets('sample', list)).toEqual({ targets: [0], skipped: ['脚本运行中（脚本优先）：#1'] });
    expect(batchTargets('off', list)).toEqual({ targets: [0, 1], skipped: [] });
  });
});
