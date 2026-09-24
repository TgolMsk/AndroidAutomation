import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SchedulerQueueState } from '../src/shared/ipc';

const { avdm } = vi.hoisted(() => ({
  avdm: {
    schedulerStates: vi.fn(),
    schedulerConfig: vi.fn(),
    schedulerStatus: vi.fn(),
    schedulerSample: vi.fn(),
    schedulerSetAuto: vi.fn(),
    saveSchedulerConfig: vi.fn(),
    alertsConfig: vi.fn(),
    alertPauses: vi.fn(),
    alertHistory: vi.fn(),
    resumeAlertPause: vi.fn(),
    on: vi.fn(() => () => undefined),
  },
}));
vi.mock('../src/renderer/api', () => ({
  avdm,
  errMsg: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

const store = await import('../src/renderer/views/gather/queue-store');
const alerts = await import('../src/renderer/state/alerts');

function state(index: number, patch: Partial<SchedulerQueueState> = {}): SchedulerQueueState {
  return { ...store.emptyQueueState(index, null, 'wanlong'), ...patch };
}

beforeEach(() => {
  store.resetGatherQueuesForTest();
  for (const fn of Object.values(avdm)) fn.mockReset();
  avdm.on.mockImplementation(() => () => undefined);
  avdm.schedulerConfig.mockResolvedValue({ slackSeconds: 60, calibrateIntervalMin: 15 });
  avdm.schedulerStatus.mockResolvedValue({ gameId: 'wanlong', owner: true, message: null, since: null });
});

describe('queue store (original marchStore semantics)', () => {
  it('translates a missing channel into Chinese and keeps the message of any other failure', () => {
    expect(store.describeSchedulerError(new Error("Error invoking remote method 'x': Error: No handler registered for 'x'")))
      .toBe('主进程还没有注册调度器通道。ETA 调度模块接线之后本页会自动可用，在此之前显示的是占位数据。');
    expect(store.describeSchedulerError(new Error('Error: 该游戏尚未接入自动续跑'))).toBe('该游戏尚未接入自动续跑');
  });

  it('refuses a double click while the same instance is sampling, and returns Chinese reasons instead of throwing', async () => {
    let release!: (value: SchedulerQueueState) => void;
    avdm.schedulerSample.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    const first = store.sampleQueue('wanlong', 1);
    expect(await store.sampleQueue('wanlong', 1)).toBe('这个实例正在采样，等它完成再点。');
    release(state(1, { queueUsed: 2, queueTotal: 5, lastSampleOk: true, lastSampledAt: 1 }));
    expect(await first).toBeNull();
    avdm.schedulerSample.mockRejectedValueOnce(new Error('实例 #1 尚未就绪'));
    expect(await store.sampleQueue('wanlong', 1)).toBe('实例 #1 尚未就绪');
    expect(avdm.schedulerSample).toHaveBeenCalledTimes(2);
  });

  it('switching auto is guarded per instance, and a failed load keeps the reason and still marks loaded', async () => {
    let release!: (value: SchedulerQueueState) => void;
    avdm.schedulerSetAuto.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    const on = store.setQueueAuto('wanlong', 2, true);
    expect(await store.setQueueAuto('wanlong', 2, false)).toBe('这个实例的开关正在切换，等它完成再点。');
    release(state(2, { auto: true }));
    expect(await on).toBeNull();

    avdm.schedulerStates.mockRejectedValueOnce(new Error('No handler registered'));
    await store.loadQueues('wanlong');
    expect(store.gatherQueuesSnapshot()).toMatchObject({
      gameId: 'wanlong', loaded: true, error: '主进程还没有注册调度器通道。ETA 调度模块接线之后本页会自动可用，在此之前显示的是占位数据。',
    });
    expect(store.gatherQueuesSnapshot().autoBusy).toEqual({});
  });

  it('upserts pushes of the current game only and builds placeholders for unknown instances', async () => {
    avdm.schedulerStates.mockResolvedValueOnce([state(0, { auto: true })]);
    await store.loadQueues('wanlong');
    store.upsertQueueState(state(3, { queueUsed: 1, queueTotal: 5 }));
    store.upsertQueueState({ ...state(4), gameId: 'other' });
    const current = store.gatherQueuesSnapshot();
    expect(Object.keys(current.byInstance).map(Number)).toEqual([0, 3]);
    expect(current).toMatchObject({ error: null, loaded: true, status: { owner: true } });
    const placeholder = store.emptyQueueState(9, 'acc', 'wanlong');
    expect(placeholder).toMatchObject({ instanceIndex: 9, accountId: 'acc', queueUsed: null, queueTotal: null, lastSampledAt: 0, auto: false, pause: null });
  });

  it('saving the scheduler config returns the Chinese reason of a refusal', async () => {
    avdm.saveSchedulerConfig.mockRejectedValueOnce(new Error('另一个万龙助手进程正在管理调度'));
    expect(await store.saveQueueConfig('wanlong', { slackSeconds: 90 })).toBe('另一个万龙助手进程正在管理调度');
  });

  it('resume is the alerts module\'s (resumeAlertPause, no probe gate), never the user\'s auto switch; double clicks refused', async () => {
    // The queue store has no resume of its own any more: one path, one source of truth for pauses.
    expect('resumeQueue' in store).toBe(false);
    let finish!: (value: unknown) => void;
    avdm.resumeAlertPause.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const first = alerts.resumePause(5);
    await expect(alerts.resumePause(5)).rejects.toThrow('这个实例正在恢复，等它完成再点。');
    finish({ instanceIndex: 5, paused: false });
    await expect(first).resolves.toMatchObject({ instanceIndex: 5, paused: false });
    expect(avdm.resumeAlertPause).toHaveBeenCalledTimes(1);
    expect(avdm.resumeAlertPause).toHaveBeenCalledWith(5);
    expect(avdm.schedulerSetAuto).not.toHaveBeenCalled();
  });
});
