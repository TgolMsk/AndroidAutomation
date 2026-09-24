import { describe, expect, it } from 'vitest';
import type { InstanceQueueState, MarchState } from '@avdm/automation/wanlong/pure';
import {
  countdownWindows, formatAgo, formatClock, formatShort, presentMarch, summarizeQueues,
} from '../src/renderer/views/gather/present';

const NOW = Date.UTC(2026, 8, 24, 4, 0, 0); // 12:00:00 Beijing
const OPTS = { imminentMs: 120_000, staleAfterMs: 15 * 60_000 };

function march(patch: Partial<MarchState> = {}): MarchState {
  return {
    slot: 1, status: 'gathering', statusText: '采集中', targetCoord: '615,535', troopCount: 31500, commanders: [],
    remainingMs: 3_600_000, timerEndsAt: NOW + 3_600_000, gatherDoneAt: NOW + 3_600_000, freeAt: NOW + 3_700_000,
    travelTimeMs: 100_000, travelTimeSource: 'dispatch', sampledAt: NOW, ...patch,
  };
}

function queue(patch: Partial<InstanceQueueState> = {}): InstanceQueueState {
  return {
    instanceIndex: 0, accountId: null, queueUsed: null, queueTotal: null, marches: [], lastSampledAt: 0, lastSampleOk: false,
    error: null, warnings: [], auto: false, sampling: false, nextWakeAt: null, nextWakeReason: null, backoffStep: 0, ...patch,
  };
}

describe('presentMarch (row presentation, original present.ts)', () => {
  it('an unreadable row is danger 「倒计时不可用」 with an error reason, never idle or 0', () => {
    const unknown = presentMarch(march({ status: 'unknown', statusText: '驻扎中', remainingMs: null }), NOW, OPTS);
    expect(unknown).toMatchObject({ tone: 'danger', text: '倒计时不可用', reasonLevel: 'error' });
    expect(unknown.reason).toBe('状态词「驻扎中」没有命中任何已知模板，无法判断这支队伍在做什么。调度会按「倒计时识别失败时的保守 ETA」重排，不会提前派兵。');
    // remainingMs null is unreadable even when the scheduler filled freeAt / etaAt with its fallback.
    const noDigits = presentMarch(march({ remainingMs: null, gatherDoneAt: NOW + 600_000, freeAt: NOW + 700_000 }), NOW, OPTS);
    expect(noDigits).toMatchObject({ tone: 'danger', text: '倒计时不可用', imminent: false });
    expect(noDigits.reason).toBe('这一行读不到倒计时（数字未命中模板）。调度会按保守 ETA 重排，不会提前派兵。');
    expect(presentMarch(march({ status: 'unknown', statusText: '', remainingMs: null, warning: '行数对不上' }), NOW, OPTS).reason).toBe('行数对不上');
  });

  it('gathering uses HH:MM:SS; marches and returns use MM:SS; due is 「待校准」; idle is 「空闲」', () => {
    expect(presentMarch(march(), NOW, OPTS).text).toBe('01:00:00');
    expect(presentMarch(march({ status: 'returning', remainingMs: 90_000, freeAt: NOW + 90_000 }), NOW, OPTS)).toMatchObject({ text: '01:30' });
    const marching = presentMarch(march({ status: 'gatherMarching', remainingMs: 45_000, timerEndsAt: NOW + 45_000, gatherDoneAt: null, freeAt: null }), NOW, OPTS);
    expect(marching).toMatchObject({ text: '00:45', tone: 'neutral' });
    const arrived = presentMarch(march({ status: 'gatherMarching', remainingMs: 45_000, timerEndsAt: NOW - 1, gatherDoneAt: null, freeAt: null }), NOW, OPTS);
    expect(arrived).toMatchObject({ text: '待校准', tone: 'accent' });
    expect(arrived.view).toMatchObject({ phase: 'due', phaseText: '已抵达，待校准', remainingMs: null, progress: null });
    expect(presentMarch(march({ status: 'idle', remainingMs: null }), NOW, OPTS)).toMatchObject({ text: '空闲', tone: 'neutral', reason: null });
  });

  it('imminent within (0, imminentMs] turns the tone to warning; locally flips gathering → returning', () => {
    const soon = presentMarch(march({ status: 'returning', remainingMs: 60_000, freeAt: NOW + 60_000 }), NOW, OPTS);
    expect(soon).toMatchObject({ imminent: true, tone: 'warning' });
    const flipped = presentMarch(march({ gatherDoneAt: NOW - 1000, freeAt: NOW + 30_000 }), NOW, OPTS);
    expect(flipped.view.phase).toBe('returning');
    expect(flipped.text).toBe('00:30');
    expect(presentMarch(march(), NOW, OPTS).imminent).toBe(false);
  });

  it('stale beyond the calibration window, with staleForMs', () => {
    const old = presentMarch(march({ sampledAt: NOW - 16 * 60_000 }), NOW, OPTS);
    expect(old).toMatchObject({ stale: true, staleForMs: 60_000 });
    expect(presentMarch(march({ sampledAt: NOW - 60_000 }), NOW, OPTS).stale).toBe(false);
  });

  it('fallback / unrecorded travel time explain the estimate only when no other reason exists', () => {
    expect(presentMarch(march({ travelTimeSource: 'fallback' }), NOW, OPTS).reason).toContain('单程行军耗时没有从「创建部队」页读到');
    expect(presentMarch(march({ travelTimeSource: 'unrecorded' }), NOW, OPTS).reason).toContain('没有这支队的派兵记录');
    expect(presentMarch(march({ travelTimeSource: 'unrecorded', warning: '坐标读不出' }), NOW, OPTS).reason).toBe('坐标读不出');
    expect(presentMarch(march({ travelTimeSource: 'fallback', freeAt: null }), NOW, OPTS).reason).toBeNull();
  });
});

describe('formatters', () => {
  it('formatShort / formatAgo / formatClock (Beijing)', () => {
    expect(formatShort(null)).toBe('--:--');
    expect(formatShort(Number.NaN)).toBe('--:--');
    expect(formatShort(65_000)).toBe('01:05');
    expect(formatShort(3_600_000)).toBe('01:00:00');
    expect(formatAgo(-5)).toBe('刚刚');
    expect(formatAgo(42_000)).toBe('42 秒前');
    expect(formatAgo(5 * 60_000)).toBe('5 分钟前');
    expect(formatAgo(125 * 60_000)).toBe('2 小时 5 分前');
    expect(formatClock(NOW + 5_000)).toBe('12:00:05');
  });

  it('countdown windows follow the original formulas', () => {
    expect(countdownWindows({ slackSeconds: 60, calibrateIntervalMin: 15 })).toEqual({ imminentMs: 120_000, staleAfterMs: 900_000 });
    expect(countdownWindows({ slackSeconds: 10, calibrateIntervalMin: 0 })).toEqual({ imminentMs: 60_000, staleAfterMs: 60_000 });
  });
});

describe('summarizeQueues (global KPIs)', () => {
  it('aggregates queues, marches, wakes and keeps the original failedInstances formula', () => {
    const sum = summarizeQueues([
      queue({ instanceIndex: 0, auto: true, queueUsed: 3, queueTotal: 5, lastSampleOk: true, lastSampledAt: NOW - 60_000,
        marches: [march({ freeAt: NOW + 500_000 }), march({ slot: 2, status: 'idle', remainingMs: null }), march({ slot: 3, remainingMs: null })],
        nextWakeAt: NOW + 600_000, nextWakeReason: '队列释放校验' }),
      queue({ instanceIndex: 1, queueUsed: 5, queueTotal: 5, lastSampleOk: false, lastSampledAt: NOW - 120_000, error: '截图失败',
        marches: [march({ freeAt: NOW + 200_000 }), march({ slot: 2, status: 'unknown', remainingMs: null })],
        nextWakeAt: NOW + 30_000, nextWakeReason: '退避重试 30s' }),
      // Never sampled successfully but failing: NOT counted in failedInstances (diagnostics still reports it).
      queue({ instanceIndex: 2, lastSampleOk: false, lastSampledAt: 0, error: '游戏不在前台' }),
      // Last sample ok but an error set (e.g. a cycle error afterwards): counted.
      queue({ instanceIndex: 3, lastSampleOk: true, lastSampledAt: NOW - 10_000, error: '派遣失败' }),
    ]);
    expect(sum).toEqual({
      instanceCount: 2, queueUsed: 8, queueTotal: 10, activeMarches: 2, unreadableMarches: 2, failedInstances: 2,
      autoInstances: 1, nextFreeAt: NOW + 200_000, nextFreeInstance: 1, nextWakeAt: NOW + 30_000, nextWakeInstance: 1,
      nextWakeReason: '退避重试 30s', oldestSampledAt: NOW - 120_000,
    });
    expect(summarizeQueues([]).oldestSampledAt).toBeNull();
  });
});
