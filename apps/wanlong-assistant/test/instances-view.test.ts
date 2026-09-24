import { describe, expect, it } from 'vitest';
import type { InstanceState } from '@avdm/core';
import type { GameAccount } from '../src/main/automation/accounts/types';
import type { AutomationProbeReport, SchedulerQueueState } from '../src/shared/ipc';
import { countUp, filterInstances, resolutionWarning } from '../src/renderer/views/instances/instance-model';
import { describeGatherStatus } from '../src/renderer/views/gather/InstanceGatherControls';
import { onlineState, resumeMessage } from '../src/renderer/views/gather/InstanceMarchCard';
import { probeVerdict } from '../src/renderer/views/gather/EnableAutoDialog';
import { probeReady } from '../src/renderer/views/gather/InstanceRunDrawer';
import { notPaused, pauseInfoOf } from '../src/renderer/views/gather/pause-port';

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
});

describe('auto-gather cell status line (priority order, original describeStatus)', () => {
  it('paused > sampling > finishing > failed > next wake > last sample > never', () => {
    const paused = pauseInfoOf(state({ pause: { reason: 'x', at: NOW, kind: 'deviceOffline' } }));
    expect(describeGatherStatus(state({ sampling: true, error: 'e' }), paused, false, NOW)).toMatchObject({ text: '已暂停 · 模拟器或游戏掉线', tone: 'danger' });
    expect(describeGatherStatus(state({ error: 'e' }), notPaused(1), true, NOW)).toMatchObject({ text: '正在读「部队管理」面板…', tone: 'info' });
    expect(describeGatherStatus(state({ operating: true, error: 'e' }), notPaused(1), false, NOW)).toMatchObject({ text: '设备操作收尾中', tone: 'warning' });
    expect(describeGatherStatus(state({ error: '游戏不在前台' }), notPaused(1), false, NOW)).toMatchObject({ text: '一直没能采样成功', tone: 'danger' });
    expect(describeGatherStatus(state({ error: 'e', lastSampledAt: NOW - 120_000 }), notPaused(1), false, NOW).text).toBe('上次采样失败（2 分钟前）');
    const wake = describeGatherStatus(state({ auto: true, lastSampleOk: true, lastSampledAt: NOW - 5_000, nextWakeAt: Date.UTC(2026, 8, 24, 4, 0, 0), nextWakeReason: '队列释放校验', backoffStep: 2 }), notPaused(1), false, NOW);
    expect(wake).toMatchObject({ text: '下次唤醒 12:00:00', tone: null, tip: '队列释放校验（已退避 2 次）（北京时间）' });
    expect(describeGatherStatus(state({ lastSampleOk: true, lastSampledAt: NOW - 30_000 }), notPaused(1), false, NOW).text).toBe('上次采样 30 秒前');
    expect(describeGatherStatus(state(), notPaused(1), false, NOW).text).toBe('未采样');
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
