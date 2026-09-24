import { describe, expect, it } from 'vitest';
import type { InstanceState } from '@avdm/core';
import type { GameAccount } from '../src/main/automation/accounts/types';
import type { AutomationProbeReport, SchedulerQueueState } from '../src/shared/ipc';
import { countUp, filterInstances, frameResolutionHint, resolutionWarning, scriptRunProgress } from '../src/renderer/views/instances/instance-model';
import { describeGatherStatus, sampleBlockedReason } from '../src/renderer/views/gather/InstanceGatherControls';
import { onlineState, resumeMessage } from '../src/renderer/views/gather/InstanceMarchCard';
import { probeVerdict } from '../src/renderer/views/gather/EnableAutoDialog';
import { probeReady } from '../src/renderer/views/gather/InstanceRunDrawer';
import { scriptOccupancyOf } from '../src/renderer/views/gather/occupancy';
import { emptyPauseState, makeAlertEvent, pauseStateFromEvent } from '../src/shared/alerts';
import type { ScriptRunSnapshot } from '../src/main/plans/types';

const notPaused = emptyPauseState;

const NOW = 1_800_000_000_000;
const PKG = 'com.lilithgames.samo.android.cn';

function instance(index: number, status: InstanceState['status'], name = `实例 ${index}`, spec = { width: 2560, height: 1440 }): InstanceState {
  return { record: { index, name, createdAt: `c${index}`, spec }, status, ports: { serial: `emulator-${5554 + index * 2}` } } as unknown as InstanceState;
}

function account(name: string, index: number): GameAccount {
  return { id: name, name, binding: { index, instanceCreatedAt: `c${index}` } } as unknown as GameAccount;
}

function state(patch: Partial<SchedulerQueueState> = {}): SchedulerQueueState {
  return {
    instanceIndex: 1, accountId: null, queueUsed: null, queueTotal: null, marches: [], lastSampledAt: 0, lastSampleOk: false,
    error: null, warnings: [], auto: false, sampling: false, nextWakeAt: null, nextWakeReason: null, backoffStep: 0,
    gameId: 'wanlong', failureCount: 0, pause: null, ...patch,
  };
}

function report(patch: Partial<AutomationProbeReport> = {}): AutomationProbeReport {
  return {
    gameId: 'wanlong', packageName: PKG, foregroundPackage: PKG, deviceWidth: 2560, deviceHeight: 1440, capturedAt: NOW, matches: [],
    launchReady: true, launchReason: '已确认世界地图画面，匹配分数 0.950', timingsMs: {}, ...patch,
  };
}

describe('instance list: search, status filter, running count', () => {
  const list = [instance(3, 'stopped', '副本'), instance(0, 'running', '主号机'), instance(1, 'booting', '备用')];
  const accounts = [account('王朝A区', 3)];

  it('searches name, index or bound account and filters by up / stopped, sorted by index', () => {
    expect(filterInstances(list, accounts, '', 'all').map((i) => i.record.index)).toEqual([0, 1, 3]);
    expect(filterInstances(list, accounts, '王朝', 'all').map((i) => i.record.index)).toEqual([3]);
    expect(filterInstances(list, accounts, '1', 'all').map((i) => i.record.index)).toEqual([1]);
    expect(filterInstances(list, accounts, '', 'up').map((i) => i.record.index)).toEqual([0, 1]);
    expect(filterInstances(list, accounts, '', 'stopped').map((i) => i.record.index)).toEqual([3]);
    expect(countUp(list)).toBe(2);
  });

  it('resolution warning: not 16:9, or below 1920×1080 (portrait counts too); 2560×1440 and 1920×1080 are fine', () => {
    expect(resolutionWarning({ width: 2560, height: 1440 })).toBeNull();
    expect(resolutionWarning({ width: 1080, height: 1920 })).toBeNull();
    expect(resolutionWarning({ width: 960, height: 540 })?.label).toBe('分辨率偏低');
    expect(resolutionWarning({ width: 1280, height: 800 })?.label).toBe('比例不是 16:9');
    expect(resolutionWarning(undefined)).toBeNull();
  });

  it('the probe result warns about a low-resolution frame too (DECISIONS C「设备分辨率」)', () => {
    expect(frameResolutionHint(2560, 1440)).toBeNull();
    expect(frameResolutionHint(1280, 720)).toMatch(/^分辨率偏低：当前分辨率 1280×720 低于 1920×1080/);
    expect(frameResolutionHint(0, 0)).toBeNull();
  });
});

describe('auto-gather cell status line (priority order, original describeStatus)', () => {
  it('paused > sampling > finishing > failed > next wake > last sample > never', () => {
    // The pause is the alerts module's record (never derived from the queue state or `!auto`).
    const paused = pauseStateFromEvent(makeAlertEvent({ type: 'deviceOffline', instanceIndex: 1, reason: 'x', at: NOW }), { notified: true, notifyError: null });
    expect(describeGatherStatus(state({ sampling: true, error: 'e' }), paused, false, NOW)).toMatchObject({ text: '已暂停 · 模拟器或游戏掉线', tone: 'danger' });
    expect(describeGatherStatus(state({ pause: { reason: 'x', at: NOW, kind: 'deviceOffline' } }), notPaused(1), false, NOW).text).toBe('未采样');
    expect(describeGatherStatus(state({ error: 'e' }), notPaused(1), true, NOW)).toMatchObject({ text: '正在读「部队管理」面板…', tone: 'info' });
    expect(describeGatherStatus(state({ operating: true, error: 'e' }), notPaused(1), false, NOW)).toMatchObject({ text: '设备操作收尾中', tone: 'warning' });
    expect(describeGatherStatus(state({ error: '游戏不在前台' }), notPaused(1), false, NOW)).toMatchObject({ text: '一直没能采样成功', tone: 'danger' });
    expect(describeGatherStatus(state({ error: 'e', lastSampledAt: NOW - 120_000 }), notPaused(1), false, NOW).text).toBe('上次采样失败（2 分钟前）');
    const wake = describeGatherStatus(state({ auto: true, lastSampleOk: true, lastSampledAt: NOW - 5_000, nextWakeAt: Date.UTC(2026, 8, 24, 4, 0, 0), nextWakeReason: '队列释放校验', backoffStep: 2 }), notPaused(1), false, NOW);
    expect(wake).toMatchObject({ text: '下次唤醒 12:00:00', tone: null, tip: '队列释放校验（已退避 2 次）（北京时间）' });
    expect(describeGatherStatus(state({ lastSampleOk: true, lastSampledAt: NOW - 30_000 }), notPaused(1), false, NOW).text).toBe('上次采样 30 秒前');
    expect(describeGatherStatus(state(), notPaused(1), false, NOW).text).toBe('未采样');
  });

  it('a script holding the instance shows as yielding while auto is on (plans pre-emption), below a pause', () => {
    const script = scriptOccupancyOf(1, { runId: 'r1', instanceIndex: 1, scriptName: '日常领取', status: 'running', source: 'plan' } as ScriptRunSnapshot, []);
    const auto = state({ auto: true, lastSampleOk: true, lastSampledAt: NOW - 5_000, nextWakeAt: null, nextWakeReason: '为脚本让路：计划任务' });
    expect(describeGatherStatus(auto, notPaused(1), false, NOW, script)).toMatchObject({ text: '为脚本让路', tone: 'info' });
    expect(describeGatherStatus(auto, notPaused(1), false, NOW, script).tip).toContain('「日常领取」（计划任务）');
    // Auto off: the 当前执行 column already names the script; the gather line keeps its own story.
    expect(describeGatherStatus(state({ lastSampleOk: true, lastSampledAt: NOW - 30_000 }), notPaused(1), false, NOW, script).text).toBe('上次采样 30 秒前');
    const paused = pauseStateFromEvent(makeAlertEvent({ type: 'suspectedKicked', instanceIndex: 1, reason: 'x', at: NOW }), { notified: null, notifyError: null });
    expect(describeGatherStatus(auto, paused, false, NOW, script).text).toBe('已暂停 · 疑似被顶号');
  });
});

describe('auto-gather cell actions (a disabled action always says why)', () => {
  it('采样 is blocked with its real reason: booting, stopping, error, stopped, sampling, operating', () => {
    expect(sampleBlockedReason('running', false, false)).toBeNull();
    expect(sampleBlockedReason('booting', false, false)).toContain('正在启动');
    expect(sampleBlockedReason('starting', false, false)).toContain('正在启动');
    expect(sampleBlockedReason('stopping', false, false)).toContain('正在关机');
    expect(sampleBlockedReason('error', false, false)).toContain('错误状态');
    expect(sampleBlockedReason('stopped', false, false)).toBe('实例未开机，无法采样。');
    expect(sampleBlockedReason('running', true, true)).toContain('等这次采样完成');
    expect(sampleBlockedReason('running', false, true)).toContain('设备操作');
    // Scripts pre-empt gathering: the scheduler refuses a sample while one holds the instance, so say so up front.
    const script = scriptOccupancyOf(1, { runId: 'r1', instanceIndex: 1, scriptName: '日常领取', status: 'paused', source: 'manual' } as ScriptRunSnapshot, []);
    expect(sampleBlockedReason('running', false, false, script)).toBe('脚本「日常领取」正在这个实例上运行（脚本优先），等它结束再操作。');
    expect(sampleBlockedReason('running', false, false, scriptOccupancyOf(1, undefined, [{ runId: 'q', instanceIndex: 1, status: 'queued' }]))).toBeNull();
  });

  it('当前执行 shows step progress, or rounds and steps in loop mode (original)', () => {
    expect(scriptRunProgress({ stepDone: 3, stepTotal: 12, iteration: 0 })).toEqual({ percent: 25, text: '已完成 3 / 12 步' });
    expect(scriptRunProgress({ stepDone: 14, stepTotal: 12, iteration: 0 }).percent).toBe(100);
    expect(scriptRunProgress({ stepDone: 7, stepTotal: null, iteration: 2 })).toEqual({ percent: null, text: '第 2 轮｜已执行 7 步' });
    expect(scriptRunProgress({ stepDone: 0, stepTotal: 0, iteration: 0 }).percent).toBeNull();
  });
});

describe('card and dialogs', () => {
  it('online state maps AVD states (no adb connection state on AVDs)', () => {
    expect(onlineState(instance(0, 'running')).text).toBe('在线');
    expect(onlineState(instance(0, 'booting'))).toEqual({ dot: 'busy', text: '启动中' });
    expect(onlineState(instance(0, 'error')).dot).toBe('error');
    expect(onlineState(instance(0, 'stopped')).text).toBe('未开机');
    expect(onlineState(undefined).text).toBe('实例已删除');
    expect(resumeMessage(2, '副本')).toContain('恢复会重新打开实例 #2（副本）的自动调度');
  });

  it('the enable dialog verdict: foreground, launch check, and a low-resolution note', () => {
    expect(probeVerdict(report(), PKG)).toEqual({ ready: true, reason: '已确认世界地图画面，匹配分数 0.950' });
    expect(probeVerdict(report({ foregroundPackage: 'com.android.launcher3', launchReady: false, launchReason: '前台不是游戏' }), PKG).ready).toBe(false);
    expect(probeVerdict(report({ launchReady: false, launchReason: '没有命中任何已知场景锚点' }), PKG)).toEqual({ ready: false, reason: '没有命中任何已知场景锚点' });
    expect(probeVerdict(report({ deviceWidth: 960, deviceHeight: 540 }), PKG).reason).toContain('低于 1920×1080');
    expect(probeReady(report(), { id: 'wanlong', packageName: PKG })).toBe(true);
    expect(probeReady(report({ deviceWidth: 0 }), { id: 'wanlong', packageName: PKG })).toBe(false);
    expect(probeReady(null, { id: 'wanlong', packageName: PKG })).toBe(false);
  });
});
