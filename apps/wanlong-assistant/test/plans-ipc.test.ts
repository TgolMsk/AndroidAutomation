import { describe, expect, it, vi } from 'vitest';
import { plansHandlers } from '../src/main/ipc/plans';
import type { PlanService } from '../src/main/plans';
import { PLANS_EVENTS, PLANS_METHODS } from '../src/shared/ipc';

const ACCOUNT = '00000000-0000-4000-8000-000000000001';

function context() {
  const plans = {
    overview: vi.fn(async () => ({ tasks: [] })),
    getPlan: vi.fn(async () => ({ accountId: ACCOUNT, enabled: false, tasks: [], updatedAt: 0 })),
    setTaskEnabled: vi.fn(async () => ({ tasks: [] })),
    setAccountEnabled: vi.fn(async () => ({ tasks: [] })),
    cancelTask: vi.fn(async () => ({ tasks: [] })),
    removeTask: vi.fn(async () => ({ tasks: [] })),
    runNow: vi.fn(async () => ({ runId: 'r' })),
    config: vi.fn(async () => ({ enabled: false })),
    saveConfig: vi.fn(async () => ({ enabled: true })),
  };
  return { plans, ctx: { plans: plans as unknown as PlanService, sender: {} as never } };
}

describe('plans IPC domain (original plan:* channels)', () => {
  it('declares the plan methods and the plan-changed / plan-config-changed events', () => {
    expect(PLANS_METHODS).toEqual(expect.arrayContaining([
      'planOverview', 'planGet', 'planSave', 'planSetTaskEnabled', 'planSetAccountEnabled', 'planRunNow', 'planCancel',
      'planCancelRun', 'planRemoveTask', 'planConfig', 'planSaveConfig',
    ]));
    expect([...PLANS_EVENTS]).toEqual(['plan-changed', 'plan-config-changed']);
  });

  it('validates switches and ids before they reach the planner', async () => {
    const { plans, ctx } = context();
    await plansHandlers.planSetTaskEnabled(ctx, 'wanlong', ACCOUNT, ' task_1 ', false);
    expect(plans.setTaskEnabled).toHaveBeenCalledWith('wanlong', ACCOUNT, 'task_1', false);
    await expect(plansHandlers.planSetTaskEnabled(ctx, 'wanlong', ACCOUNT, 'task_1', 'no' as never)).rejects.toThrow('任务开关无效');
    await expect(plansHandlers.planSetAccountEnabled(ctx, 'wanlong', 'not-a-uuid', true)).rejects.toThrow('账号 ID无效');
    await plansHandlers.planSetAccountEnabled(ctx, 'wanlong', ACCOUNT, true);
    expect(plans.setAccountEnabled).toHaveBeenCalledWith('wanlong', ACCOUNT, true);
    await plansHandlers.planCancel(ctx, 'wanlong', ACCOUNT, 'task_1');
    expect(plans.cancelTask).toHaveBeenCalledWith('wanlong', ACCOUNT, 'task_1');
    await plansHandlers.planRemoveTask(ctx, 'wanlong', ACCOUNT, 'task_1');
    expect(plans.removeTask).toHaveBeenCalledWith('wanlong', ACCOUNT, 'task_1');
    await expect(plansHandlers.planRunNow(ctx, 'wanlong', ACCOUNT, '')).rejects.toThrow('任务 ID无效');
    await expect(plansHandlers.planGet(ctx, 'unknown-game', ACCOUNT)).rejects.toThrow();
    await plansHandlers.planGet(ctx, 'wanlong', ACCOUNT);
    expect(plans.getPlan).toHaveBeenCalledWith('wanlong', ACCOUNT);
    await plansHandlers.planConfig(ctx, 'wanlong');
    expect(plans.config).toHaveBeenCalledWith('wanlong');
    await expect(plansHandlers.planSaveConfig(ctx, 'wanlong', [] as never)).rejects.toThrow('计划配置无效');
  });
});
