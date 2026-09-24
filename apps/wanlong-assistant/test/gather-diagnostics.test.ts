import { describe, expect, it } from 'vitest';
import type { MarchState } from '@avdm/automation/wanlong/pure';
import {
  ATTENTION_STAGE, attentionStageOf, emptyPauseState, isAiAttentionPause, makeAlertEvent, pauseStateFromEvent, pauseTitle,
  type AlertDetail, type AlertType, type InstancePauseState,
} from '../src/shared/alerts';
import type { SchedulerQueueState } from '../src/shared/ipc';
import { attentionCount, collectDiagnostics, diagnosticsTip, worstLevel } from '../src/renderer/views/gather/diagnostics';
import { pauseOf, pausedIndexes } from '../src/renderer/state/alerts';

const NOW = 1_800_000_000_000;

function state(patch: Partial<SchedulerQueueState> = {}): SchedulerQueueState {
  return {
    instanceIndex: 2, accountId: null, queueUsed: null, queueTotal: null, marches: [], lastSampledAt: 0, lastSampleOk: false,
    error: null, warnings: [], auto: false, sampling: false, nextWakeAt: null, nextWakeReason: null, backoffStep: 0,
    gameId: 'wanlong', failureCount: 0, pause: null, ...patch,
  };
}

/** An alerts pause record, built the way the alert center builds it. */
function paused(type: AlertType, reason: string, detail?: AlertDetail, index = 2): InstancePauseState {
  return pauseStateFromEvent(makeAlertEvent({ type, instanceIndex: index, reason, at: NOW, ...(detail ? { detail } : {}) }), { notified: null, notifyError: null });
}

function row(slot: number, patch: Partial<MarchState> = {}): MarchState {
  return {
    slot, status: 'unknown', statusText: '', targetCoord: null, troopCount: null, commanders: [], remainingMs: null,
    timerEndsAt: null, gatherDoneAt: null, freeAt: null, travelTimeMs: null, travelTimeSource: 'fallback', sampledAt: NOW, ...patch,
  };
}

describe('pauses come from the alerts module\'s records only', () => {
  it('the title is the alert type\'s, with the stage of a needs-attention pause (AI risk / game update)', () => {
    expect(pauseTitle(paused('suspectedKicked', '账号在其他设备登录'))).toBe('疑似被顶号');
    expect(pauseTitle(paused('schedulePaused', '账号还没完成登录检查'))).toBe('自动调度已暂停');
    const ai = paused('needsAttention', '确认框风险过高', { 阶段: attentionStageOf('AI_RISK_BLOCKED'), 自动操作: '已停止，处理后可恢复' });
    expect(pauseTitle(ai)).toBe('需要人工介入（AI 操作风险评估）');
    expect(isAiAttentionPause(ai)).toBe(true);
    const update = paused('needsAttention', '游戏需要更新', { 阶段: attentionStageOf('GAME_UPDATE_REQUIRED') });
    expect(pauseTitle(update)).toBe(`需要人工介入（${ATTENTION_STAGE.gameUpdate}）`);
    expect(isAiAttentionPause(update)).toBe(false);
    expect(pauseTitle(emptyPauseState(2))).toBe('');
    expect(isAiAttentionPause({ ...ai, paused: false })).toBe(false);
  });

  it('a user switch-off or a failure count is never a pause: no record, not paused', () => {
    expect(pauseOf({}, 4)).toEqual(emptyPauseState(4));
    expect(pausedIndexes({ 5: paused('deviceOffline', 'x', undefined, 5), 1: emptyPauseState(1), 0: paused('consecutiveFailures', 'y', undefined, 0) }))
      .toEqual([0, 5]);
  });
});

describe('collectDiagnostics', () => {
  it('orders pause, then sampling failure, then warnings, then row reasons', () => {
    const s = state({
      lastSampledAt: NOW - 60_000, error: 'ADB 截图失败', warnings: ['行数对不上：面板 3 行，队列 4/5'],
      marches: [row(1, { status: 'gathering', statusText: '采集中', remainingMs: null })],
    });
    const pause = paused('needsAttention', '游戏需要更新', { 阶段: ATTENTION_STAGE.gameUpdate });
    const items = collectDiagnostics({ state: s, pause, rowReasons: true, now: NOW });
    expect(items.map((item) => [item.level, item.title])).toEqual([
      ['error', '需要人工介入（游戏资源更新）'], ['error', '上次采样失败'], ['warning', '本轮采样告警'], ['error', '第 1 行'],
    ]);
    expect(items[0]!.text).toBe('游戏需要更新');
    expect(items[1]!.text).toBe('ADB 截图失败');
    expect(worstLevel(items)).toBe('error');
    expect(attentionCount(items)).toBe(4);
    expect(diagnosticsTip(items, true)).toBe('4 条需要处理：需要人工介入（游戏资源更新）。点开查看原因与处置建议。');
  });

  it('an instance that never sampled successfully but has an error is still reported (no lastSampledAt precondition)', () => {
    const items = collectDiagnostics({ state: state({ error: '游戏不在前台' }), pause: emptyPauseState(2), now: NOW });
    expect(items).toEqual([{ level: 'error', title: '一直没能采样成功', text: '游戏不在前台' }]);
  });

  it('row reasons only when asked (the cards show them on the rows); warnings alone are amber; nothing → null', () => {
    const s = state({ lastSampleOk: true, lastSampledAt: NOW, marches: [row(2)] });
    expect(collectDiagnostics({ state: s, pause: emptyPauseState(2), now: NOW })).toEqual([]);
    const rows = collectDiagnostics({ state: s, pause: emptyPauseState(2), now: NOW, rowReasons: true });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ level: 'error', title: '第 2 行' });
    const warn = collectDiagnostics({ state: state({ lastSampleOk: true, warnings: ['识别不确定'] }), pause: emptyPauseState(2), now: NOW });
    expect(worstLevel(warn)).toBe('warning');
    expect(diagnosticsTip(warn, false)).toBe('1 条需要处理：本轮采样告警。点开查看完整原因。');
    expect(worstLevel([])).toBeNull();
    expect(attentionCount([{ level: 'info', title: 'i', text: 't' }])).toBe(0);
    expect(worstLevel([{ level: 'info', title: 'i', text: 't' }])).toBe('info');
  });
});
