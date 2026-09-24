import { describe, expect, it } from 'vitest';
import type { GameAccount } from '../src/main/automation/accounts/types';
import {
  capacityNote, dispatchSkipReason, dispatchSummary, runAccountOf, selectBlockReason, toggleIndex,
} from '../src/renderer/views/console/console-model';
import { restartGameBlockReason, restartGameOutcome } from '../src/renderer/views/instances/instance-model';

const account: GameAccount = {
  id: '00000000-0000-4000-8000-000000000001', gameId: 'wanlong', packageName: 'com.lilithgames.samo.android.cn', name: '主号', server: '',
  role: '', note: '', enabled: true, binding: { index: 1, instanceCreatedAt: 'id-1' }, login: { status: 'ready', attemptId: null, verifiedAt: 1 },
  createdAt: 1, updatedAt: 1,
};

describe('脚本控制台 model', () => {
  it('ticks any running instance; a dispatch skips the busy ones with a reason', () => {
    expect(selectBlockReason({ running: false })).toBe('未开机');
    expect(selectBlockReason({ running: true })).toBeNull();
    expect(dispatchSkipReason({ running: true, scriptRunning: null, loginActive: false })).toBeNull();
    expect(dispatchSkipReason({ running: true, scriptRunning: '日常', loginActive: false })).toBe('正在跑「日常」');
    expect(dispatchSkipReason({ running: true, scriptRunning: null, loginActive: true })).toBe('账号登录向导正在用');
  });

  it('carries the bound, enabled, logged-in account only (anything else runs without one, with a warning)', () => {
    const here = { index: 1, createdAt: 'id-1' };
    expect(runAccountOf(undefined, here, true)).toEqual({ label: '未绑定账号' });
    expect(runAccountOf(account, here, true)).toEqual({ accountId: account.id, label: '主号' });
    expect(runAccountOf(account, here, false)).toEqual({ label: '主号（不带账号运行）' });
    expect(runAccountOf(account, { index: 1, createdAt: 'id-2' }, true).warning).toContain('已被替换');
    expect(runAccountOf({ ...account, enabled: false }, here, true)).toMatchObject({ warning: expect.stringContaining('已停用') });
    expect(runAccountOf({ ...account, login: { ...account.login, status: 'pending' } }, here, true).accountId).toBeUndefined();
  });

  it('tells how many runs the global cap still admits', () => {
    expect(capacityNote(null, 0, 3)).toBeNull();
    expect(capacityNote(4, 1, 0)).toBeNull();
    expect(capacityNote(4, 1, 3)).toMatchObject({ over: 0 });
    const over = capacityNote(4, 2, 5)!;
    expect(over.over).toBe(3);
    expect(over.text).toContain('最多再启动 2 个');
  });

  it('summarizes a dispatch', () => {
    const at = 1;
    expect(dispatchSummary([{ index: 0, ok: true, runId: 'r0', at }, { index: 1, ok: true, runId: 'r1', at }], '日常')).toEqual({ kind: 'success', title: '「日常」已在 2 个实例上启动' });
    expect(dispatchSummary([{ index: 0, ok: true, runId: 'r0', at }, { index: 1, ok: false, error: '上限', at }], '日常'))
      .toMatchObject({ kind: 'warn', detail: expect.stringContaining('1 个失败') });
    expect(dispatchSummary([{ index: 1, ok: false, error: '未开机', at, skipped: true }], '日常')).toMatchObject({ kind: 'warn', title: '「日常」没有启动' });
    expect(dispatchSummary([{ index: 1, ok: false, error: 'x', at }], '日常').kind).toBe('error');
    expect(toggleIndex([3, 1], 2, true)).toEqual([1, 2, 3]);
    expect(toggleIndex([1, 2, 3], 2, false)).toEqual([1, 3]);
  });
});

describe('「重启游戏」 in the instance list', () => {
  const idle = { gameLoaded: true, running: true, scriptRunning: false, loginActive: false, gatherRunning: false };
  it('is offered only when nothing else holds the instance', () => {
    expect(restartGameBlockReason(idle)).toBeNull();
    expect(restartGameBlockReason({ ...idle, running: false })).toContain('先启动实例');
    expect(restartGameBlockReason({ ...idle, scriptRunning: true })).toContain('脚本正在执行');
    expect(restartGameBlockReason({ ...idle, loginActive: true })).toContain('登录');
    expect(restartGameBlockReason({ ...idle, gatherRunning: true })).toContain('采集');
    expect(restartGameBlockReason({ ...idle, gameLoaded: false })).toContain('游戏模块');
  });

  it('reports the outcome and what a paused instance still needs', () => {
    expect(restartGameOutcome(2, { foreground: true, elapsedMs: 8_400 }, null)).toEqual({ kind: 'success', title: '实例 #2 的游戏已重新拉起', detail: '用时 8 秒。' });
    const paused = restartGameOutcome(2, { foreground: true, elapsedMs: 100 }, { paused: true, title: '需要人工介入' });
    expect(paused.detail).toContain('点「恢复」');
    expect(restartGameOutcome(2, { foreground: false, elapsedMs: 60_000 }, null)).toMatchObject({ kind: 'warn', title: expect.stringContaining('60 秒内没回到前台') });
  });
});
