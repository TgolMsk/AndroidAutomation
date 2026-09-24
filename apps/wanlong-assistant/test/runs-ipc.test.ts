import { describe, expect, it, vi } from 'vitest';
import { runsHandlers } from '../src/main/ipc/runs';
import type { PlanService } from '../src/main/plans';
import { RUNS_EVENTS, RUNS_METHODS } from '../src/shared/ipc';

const RUN = '00000000-0000-4000-8000-000000000001';

function context() {
  const plans = {
    runScript: vi.fn(async () => ({ runId: RUN })),
    runLogs: vi.fn(async () => []),
    runShot: vi.fn(async () => new Uint8Array([1])),
    setRunDebugMatches: vi.fn(),
    cancelRun: vi.fn(async () => undefined),
    imeStatus: vi.fn(async () => ({ available: false })),
  };
  return { plans, ctx: { plans: plans as unknown as PlanService, sender: {} as never } };
}

describe('runs IPC domain', () => {
  it('declares the monitor methods and the plan-run / run-logs / run-matches events', () => {
    expect(RUNS_METHODS).toEqual(expect.arrayContaining(['scriptRun', 'runList', 'runPause', 'runResume', 'runStop', 'runLogs', 'runShot', 'imeStatus', 'imeSetup']));
    expect([...RUNS_EVENTS]).toEqual(['plan-run', 'run-logs', 'run-matches']);
  });

  it('validates a manual run request before it reaches the service', async () => {
    const { plans, ctx } = context();
    await runsHandlers.scriptRun(ctx, 'wanlong', 1, ' daily ', { accountId: '', shotPolicy: 'always', maxRunMinutes: 0, params: { n: 1 } });
    expect(plans.runScript).toHaveBeenCalledWith('wanlong', 1, 'daily', { shotPolicy: 'always', maxRunMinutes: 0, params: { n: 1 } });
    await expect(runsHandlers.scriptRun(ctx, 'wanlong', 1, 'daily', { shotPolicy: 'sometimes' as never })).rejects.toThrow('截图留痕策略无效');
    await expect(runsHandlers.scriptRun(ctx, 'wanlong', 99, 'daily')).rejects.toThrow();
    await expect(runsHandlers.scriptRun(ctx, 'unknown-game', 1, 'daily')).rejects.toThrow();
  });

  it('validates log queries and passes shots and debug toggles through', async () => {
    const { plans, ctx } = context();
    await runsHandlers.runLogs(ctx, 'wanlong', { runId: RUN, minLevel: 'warn', limit: 2000 });
    expect(plans.runLogs).toHaveBeenCalledWith('wanlong', { runId: RUN, minLevel: 'warn', limit: 2000 });
    await expect(runsHandlers.runLogs(ctx, 'wanlong', { runId: RUN, minLevel: 'loud' as never })).rejects.toThrow('日志级别无效');
    await expect(runsHandlers.runLogs(ctx, 'wanlong', { runId: RUN, limit: 0 })).rejects.toThrow('条数上限无效');
    await runsHandlers.runShot(ctx, 'wanlong', RUN, `${RUN}/0001-a.jpg`);
    expect(plans.runShot).toHaveBeenCalledWith('wanlong', RUN, `${RUN}/0001-a.jpg`);
    await expect(runsHandlers.runDebugMatches(ctx, 'wanlong', RUN, 'yes' as never)).rejects.toThrow('匹配调试开关无效');
    await runsHandlers.runStop(ctx, 'wanlong', RUN);
    expect(plans.cancelRun).toHaveBeenCalledWith('wanlong', RUN);
  });
});
