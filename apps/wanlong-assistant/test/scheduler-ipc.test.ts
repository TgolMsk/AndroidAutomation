import { describe, expect, it, vi } from 'vitest';
import { schedulerHandlers } from '../src/main/ipc/scheduler';
import type { AutomationHost } from '../src/main/automation/host';

function fakeAutomation() {
  const state = { instanceIndex: 1, auto: true, gameId: 'wanlong' };
  const eta = {
    list: vi.fn(() => [state]),
    getState: vi.fn(() => state),
    sampleNow: vi.fn(async () => state),
    getConfig: vi.fn(() => ({ slackSeconds: 60 })),
    saveConfig: vi.fn(async (patch: object) => ({ slackSeconds: 60, ...patch })),
    listWakes: vi.fn(() => []),
    cancelWake: vi.fn(),
    forget: vi.fn(async () => undefined),
    status: vi.fn(() => ({ gameId: 'wanlong', owner: false, message: '另一个万龙助手进程正在管理自动采集调度', since: 1 })),
  };
  const automation = { eta, setSchedule: vi.fn(async () => ({ enabled: true })) };
  return { automation, eta, ctx: { automation: automation as unknown as AutomationHost, sender: {} as never } };
}

describe('scheduler IPC handlers', () => {
  it('routes queue reads and edits to the ETA scheduler after validating arguments', async () => {
    const { ctx, eta } = fakeAutomation();
    await expect(schedulerHandlers.schedulerStates(ctx, 'wanlong')).resolves.toHaveLength(1);
    await expect(schedulerHandlers.schedulerState(ctx, 'wanlong', 1)).resolves.toMatchObject({ instanceIndex: 1 });
    await schedulerHandlers.schedulerSample(ctx, 'wanlong', 1);
    expect(eta.sampleNow).toHaveBeenCalledWith(1);
    await expect(schedulerHandlers.saveSchedulerConfig(ctx, 'wanlong', { slackSeconds: 30 })).resolves.toEqual({ slackSeconds: 30 });
    await expect(schedulerHandlers.saveSchedulerConfig(ctx, 'wanlong', null as never)).rejects.toThrow('调度参数无效');
    await expect(schedulerHandlers.schedulerCancelWake(ctx, 'wanlong', 1)).resolves.toBeUndefined();
    await schedulerHandlers.schedulerForget(ctx, 'wanlong', 1);
    expect(eta.forget).toHaveBeenCalledWith(1);
    await expect(schedulerHandlers.schedulerStatus(ctx, 'wanlong')).resolves.toMatchObject({ owner: false, message: expect.stringContaining('另一个') });
    await expect(schedulerHandlers.schedulerStatus(ctx, 'other')).rejects.toThrow();
    await expect(schedulerHandlers.schedulerState(ctx, 'wanlong', -1)).rejects.toThrow();
    await expect(schedulerHandlers.schedulerStates(ctx, 'unknown-game')).rejects.toThrow();
  });

  it('switches auto through the same guarded path as setAutomationSchedule', async () => {
    const { ctx, automation } = fakeAutomation();
    await expect(schedulerHandlers.schedulerSetAuto(ctx, 'wanlong', 1, true)).resolves.toMatchObject({ instanceIndex: 1, auto: true });
    expect(automation.setSchedule).toHaveBeenCalledWith('wanlong', 1, true);
    await expect(schedulerHandlers.schedulerSetAuto(ctx, 'wanlong', 1, 'yes' as never)).rejects.toThrow('自动续跑开关无效');
    expect(automation.setSchedule).toHaveBeenCalledTimes(1);
    // The probe the user just confirmed in the enable dialog is handed through; a malformed id is refused.
    await schedulerHandlers.schedulerSetAuto(ctx, 'wanlong', 1, true, { probeCapturedAt: 1234 });
    expect(automation.setSchedule).toHaveBeenLastCalledWith('wanlong', 1, true, { probeCapturedAt: 1234 });
    await expect(schedulerHandlers.schedulerSetAuto(ctx, 'wanlong', 1, true, { probeCapturedAt: 'x' } as never)).rejects.toThrow('探针编号无效');
    await expect(schedulerHandlers.schedulerSetAuto(ctx, 'wanlong', 1, true, [] as never)).rejects.toThrow('开启选项无效');
    expect(automation.setSchedule).toHaveBeenCalledTimes(2);
  });
});
