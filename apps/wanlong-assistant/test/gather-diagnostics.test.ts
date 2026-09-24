import { describe, expect, it } from 'vitest';
import type { MarchState } from '@avdm/automation/wanlong/pure';
import type { SchedulerQueueState } from '../src/shared/ipc';
import { attentionCount, collectDiagnostics, diagnosticsTip, worstLevel } from '../src/renderer/views/gather/diagnostics';
import { notPaused, pauseInfoOf, pausedIndexes } from '../src/renderer/views/gather/pause-port';

const NOW = 1_800_000_000_000;

function state(patch: Partial<SchedulerQueueState> = {}): SchedulerQueueState {
  return {
    instanceIndex: 2, accountId: null, queueUsed: null, queueTotal: null, marches: [], lastSampledAt: 0, lastSampleOk: false,
    error: null, warnings: [], auto: false, sampling: false, nextWakeAt: null, nextWakeReason: null, backoffStep: 0,
    gameId: 'wanlong', failureCount: 0, pause: null, ...patch,
  };
}

function row(slot: number, patch: Partial<MarchState> = {}): MarchState {
  return {
    slot, status: 'unknown', statusText: '', targetCoord: null, troopCount: null, commanders: [], remainingMs: null,
    timerEndsAt: null, gatherDoneAt: null, freeAt: null, travelTimeMs: null, travelTimeSource: 'fallback', sampledAt: NOW, ...patch,
  };
}

describe('pause port (reads the queue state pause until the alerts module plugs in)', () => {
  it('an alerts pause record wins, with the original alert title and advice', () => {
    const pause = pauseInfoOf(state({ pause: { reason: '账号在其他设备登录', at: NOW, kind: 'suspectedKicked' } }));
    expect(pause).toMatchObject({ paused: true, kind: 'suspectedKicked', title: '疑似被顶号', reason: '账号在其他设备登录', at: NOW, source: 'alerts' });
    expect(pause.advice).toContain('确认安全后重新登录游戏');
    expect(pauseInfoOf(state({ pause: { reason: '', at: NOW } }))).toMatchObject({ paused: true, title: '已暂停', reason: null });
  });

  it('the scheduler\'s own safety pause comes from the queue state (no mirrored threshold); a user switch-off is not a pause', () => {
    const live = { reason: '连续 8 次失败，自动调度已暂停：截图超时', at: NOW, kind: 'consecutiveFailures', source: 'scheduler' as const };
    expect(pauseInfoOf(state({ auto: false, failureCount: 8, error: '截图超时', pause: live }))).toMatchObject({
      paused: true, kind: 'consecutiveFailures', title: '连续失败熔断', reason: live.reason, at: NOW, source: 'scheduler',
    });
    // Restored after a restart: no time, the latest sampling error completes the reason.
    const restored = { reason: '连续 8 次失败，自动调度已暂停。', at: 0, kind: 'consecutiveFailures', source: 'scheduler' as const };
    expect(pauseInfoOf(state({ auto: false, failureCount: 8, error: 'ADB 截图失败', pause: restored }))).toMatchObject({
      reason: '连续 8 次失败，自动调度已暂停：ADB 截图失败', at: null,
    });
    // Failure counts alone never make a pause here: only the scheduler knows its (configurable) threshold.
    expect(pauseInfoOf(state({ auto: false, failureCount: 12 })).paused).toBe(false);
    expect(pauseInfoOf(state({ auto: true, failureCount: 9 })).paused).toBe(false);
    expect(pauseInfoOf(null, 4)).toEqual(notPaused(4));
    expect(pausedIndexes([pauseInfoOf(state({ instanceIndex: 5, pause: { reason: 'x', at: 1 } })), notPaused(1),
      pauseInfoOf(state({ instanceIndex: 0, pause: { reason: 'y', at: 1 } }))])).toEqual([0, 5]);
  });
});

describe('collectDiagnostics', () => {
  it('orders pause, then sampling failure, then warnings, then row reasons', () => {
    const s = state({
      lastSampledAt: NOW - 60_000, error: 'ADB 截图失败', warnings: ['行数对不上：面板 3 行，队列 4/5'],
      marches: [row(1, { status: 'gathering', statusText: '采集中', remainingMs: null })],
    });
    const pause = pauseInfoOf(state({ pause: { reason: '需要人工处理：游戏更新', at: NOW, kind: 'needsAttention' } }));
    const items = collectDiagnostics({ state: s, pause, rowReasons: true, now: NOW });
    expect(items.map((item) => [item.level, item.title])).toEqual([
      ['error', '需要人工介入'], ['error', '上次采样失败'], ['warning', '本轮采样告警'], ['error', '第 1 行'],
    ]);
    expect(items[1]!.text).toBe('ADB 截图失败');
    expect(worstLevel(items)).toBe('error');
    expect(attentionCount(items)).toBe(4);
    expect(diagnosticsTip(items, true)).toBe('4 条需要处理：需要人工介入。点开查看原因与处置建议。');
  });

  it('an instance that never sampled successfully but has an error is still reported (no lastSampledAt precondition)', () => {
    const items = collectDiagnostics({ state: state({ error: '游戏不在前台' }), pause: notPaused(2), now: NOW });
    expect(items).toEqual([{ level: 'error', title: '一直没能采样成功', text: '游戏不在前台' }]);
  });

  it('row reasons only when asked (the cards show them on the rows); warnings alone are amber; nothing → null', () => {
    const s = state({ lastSampleOk: true, lastSampledAt: NOW, marches: [row(2)] });
    expect(collectDiagnostics({ state: s, pause: notPaused(2), now: NOW })).toEqual([]);
    const rows = collectDiagnostics({ state: s, pause: notPaused(2), now: NOW, rowReasons: true });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ level: 'error', title: '第 2 行' });
    const warn = collectDiagnostics({ state: state({ lastSampleOk: true, warnings: ['识别不确定'] }), pause: notPaused(2), now: NOW });
    expect(worstLevel(warn)).toBe('warning');
    expect(diagnosticsTip(warn, false)).toBe('1 条需要处理：本轮采样告警。点开查看完整原因。');
    expect(worstLevel([])).toBeNull();
    expect(attentionCount([{ level: 'info', title: 'i', text: 't' }])).toBe(0);
    expect(worstLevel([{ level: 'info', title: 'i', text: 't' }])).toBe('info');
  });
});
