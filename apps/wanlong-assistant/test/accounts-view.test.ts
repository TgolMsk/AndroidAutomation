/** Pure helpers of 账号管理, the login drawer and the instance account cell (original AccountsView / drawer / cell). */
import { describe, expect, it } from 'vitest';
import type { InstanceState } from '@avdm/core';
import type { AccountLoginSession, GameAccount } from '../src/main/automation/accounts/types';
import type { BaseInstanceView } from '../src/main/instances/types';
import {
  NEW_ACCOUNT, acceptSession, accountCellDisabledReason, accountCellOptions, accountStatus, defaultScriptLabel,
  gestureInput, instanceOptions, isBaseInstance, loginAccountChoices, loginCheck, loginStep, toRefPoint, verifyReasonShown,
} from '../src/renderer/views/accounts/account-model';

const instance = (index: number, status = 'running', createdAt = `c${index}`, extra: Partial<InstanceState['record']> = {}) =>
  ({ status, record: { index, name: `实例 ${index}`, createdAt, ...extra } }) as unknown as InstanceState;

function account(name: string, extra: Partial<GameAccount> = {}): GameAccount {
  return {
    id: `${name}-id`, gameId: 'wanlong', packageName: 'pkg', name, server: '', role: '', note: '', enabled: false,
    binding: null, login: { status: 'pending', attemptId: null, verifiedAt: null }, createdAt: 1, updatedAt: 1, ...extra,
  };
}

const ready = (index: number, createdAt = `c${index}`) => ({
  binding: { index, instanceCreatedAt: createdAt }, enabled: true,
  login: { status: 'ready' as const, attemptId: null, verifiedAt: 1_700_000_000_000 },
});

const session = (phase: AccountLoginSession['phase'], updatedAt: number, id = 's1'): AccountLoginSession =>
  ({ id, accountId: 'a', accountName: '甲', gameId: 'wanlong', index: 1, phase, message: phase, updatedAt });

describe('accounts page model', () => {
  const instances = [instance(0, 'stopped'), instance(1), instance(2)];
  const base: BaseInstanceView = { gameId: 'wanlong', base: { index: 0, name: '实例 0', createdAt: 'c0', setAt: 1 }, status: 'stopped', cloneBlocked: null };

  it('labels every instance for binding: stopped, owned (takeover), base', () => {
    const accounts = [account('甲', ready(1)), account('乙')];
    const options = instanceOptions(instances, accounts, '乙-id', base);
    expect(options.map((option) => option.label)).toEqual([
      '#0 · 实例 0（基础实例，不可绑定，未开机）',
      '#1 · 实例 1（已绑定「甲」，选中将改绑）',
      '#2 · 实例 2',
    ]);
    expect(options[0]?.disabled).toBe(true);
    expect(options[1]?.owner?.name).toBe('甲');
    // An account's own binding is not "owned by another".
    expect(instanceOptions(instances, accounts, '甲-id', null)[1]?.label).toBe('#1 · 实例 1');
  });

  it('derives status, login check and default script labels', () => {
    expect(accountStatus(account('甲'), instances)).toEqual({ label: '未绑定', tone: 'dim' });
    expect(accountStatus(account('甲', ready(1)), instances)).toEqual({ label: '已启用', tone: 'ok' });
    expect(accountStatus(account('甲', { ...ready(1), enabled: false }), instances).label).toBe('已停用');
    expect(accountStatus(account('甲', ready(1, 'old')), instances).label).toBe('实例已替换');
    expect(accountStatus(account('甲', ready(9)), instances).label).toBe('实例已删除');
    expect(accountStatus(account('甲', { binding: { index: 1, instanceCreatedAt: 'c1' } }), instances).label).toBe('待登录');
    expect(loginCheck(account('甲', ready(1)))).toEqual({ label: '已检查', verifiedAt: 1_700_000_000_000 });
    expect(loginCheck(account('甲', { login: { status: 'pending', attemptId: 'x', verifiedAt: null } })).label).toBe('等待登录');
    expect(loginCheck(account('甲')).label).toBe('未检查');
    const scripts = [{ id: 'daily', name: '日常' }];
    expect(defaultScriptLabel(account('甲'), scripts)).toBeNull();
    expect(defaultScriptLabel(account('甲', { defaultScriptId: 'daily' }), scripts)).toEqual({ label: '日常', missing: false });
    expect(defaultScriptLabel(account('甲', { defaultScriptId: 'gone' }), scripts)).toEqual({ label: 'gone（已丢失）', missing: true });
  });

  it('offers the instance owner only, or unbound accounts plus 新建账号, in the login wizard', () => {
    const accounts = [account('甲', ready(1)), account('乙'), account('丙', ready(2))];
    expect(loginAccountChoices(accounts, 1)).toEqual([{ value: '甲-id', label: '甲' }]);
    expect(loginAccountChoices(accounts, 5)).toEqual([{ value: NEW_ACCOUNT, label: '新建账号' }, { value: '乙-id', label: '乙' }]);
  });

  it('labels the instance cell options and disables it with a reason', () => {
    const accounts = [account('甲', ready(2)), account('乙', { enabled: false, login: { status: 'ready', attemptId: null, verifiedAt: 1 }, binding: { index: 3, instanceCreatedAt: 'c3' } }), account('丙')];
    expect(accountCellOptions(accounts, 3, instances).map((option) => option.label)).toEqual([
      '甲（已绑定 #2 实例 2，选中将改绑）', '乙（已停用）', '丙（待登录）',
    ]);
    expect(accountCellDisabledReason({ base: true, bound: false, running: false, loginActive: false })).toContain('基础实例');
    expect(accountCellDisabledReason({ base: true, bound: true, running: false, loginActive: false })).toBeNull();
    expect(accountCellDisabledReason({ base: false, bound: true, running: true, loginActive: false })).toContain('自动采集');
    expect(accountCellDisabledReason({ base: false, bound: true, running: false, loginActive: true })).toContain('正在登录');
    // Any active run blocks rebinding (original hasRun), a script as much as a gather cycle.
    expect(accountCellDisabledReason({ base: false, bound: true, running: false, loginActive: false, scriptRunning: true })).toContain('脚本在执行');
    expect(accountCellDisabledReason({ base: true, bound: false, running: false, loginActive: false, scriptRunning: true })).toContain('脚本在执行');
    expect(isBaseInstance(base, instances[0])).toBe(true);
    expect(isBaseInstance(base, instance(0, 'stopped', 'recycled'))).toBe(false);
  });
});

describe('login drawer model', () => {
  it('maps phases to the four-step bar', () => {
    expect(loginStep(null)).toBe(0);
    expect(loginStep(session('preparing', 1))).toBe(1);
    expect(loginStep(session('starting', 1))).toBe(1);
    expect(loginStep(session('awaitingLogin', 1))).toBe(2);
    expect(loginStep(session('verifying', 1))).toBe(2);
    expect(loginStep(session('completed', 1))).toBe(3);
    expect(loginStep(session('failed', 1))).toBe(0);
  });

  it('keeps the newest snapshot when replies and pushes arrive out of order', () => {
    const newer = session('awaitingLogin', 20);
    expect(acceptSession(newer, session('starting', 10))).toBe(newer);
    expect(acceptSession(newer, session('verifying', 21))?.phase).toBe('verifying');
    expect(acceptSession(newer, session('preparing', 5, 's2'))?.id).toBe('s2'); // a new session always replaces
    expect(acceptSession(newer, null)).toBe(newer);
    expect(acceptSession(session('cancelled', 20), null)).toBeNull();
  });

  it('toasts a rejected login check unless a newer snapshot of the session carries the reason', () => {
    const failed = { ...session('awaitingLogin', 30), message: '尚未识别到游戏主界面' };
    expect(verifyReasonShown(failed, failed.id, 20, '尚未识别到游戏主界面')).toBe(true);
    // The wizard ended, the phase was wrong or the IPC call failed: nothing on screen explains it.
    expect(verifyReasonShown(failed, failed.id, 30, '尚未识别到游戏主界面')).toBe(false);
    expect(verifyReasonShown(failed, failed.id, 20, '登录向导已结束，请重新打开')).toBe(false);
    expect(verifyReasonShown({ ...failed, phase: 'cancelled' }, failed.id, 20, '尚未识别到游戏主界面')).toBe(false);
    expect(verifyReasonShown(failed, 'other', 20, '尚未识别到游戏主界面')).toBe(false);
    expect(verifyReasonShown(null, failed.id, 20, '主进程未响应')).toBe(false);
  });

  it('turns pointer gestures into reference-space taps and swipes', () => {
    const rect = { left: 10, top: 20, width: 640, height: 360 };
    expect(toRefPoint(rect, 330, 200)).toEqual({ x: 1280, y: 720 });
    expect(toRefPoint(rect, -50, 999)).toEqual({ x: 0, y: 1440 });
    expect(toRefPoint({ ...rect, width: 0 }, 1, 1)).toBeNull();
    expect(gestureInput({ x: 100, y: 100, t: 0 }, { x: 110, y: 105, t: 90 }, 'tap')).toEqual({ kind: 'tap', at: { x: 110, y: 105 } });
    expect(gestureInput({ x: 100, y: 100, t: 0 }, { x: 400, y: 100, t: 5000 }, 'tap')).toEqual({
      kind: 'swipe', at: { x: 100, y: 100 }, to: { x: 400, y: 100 }, durationMs: 1200,
    });
    expect(gestureInput({ x: 100, y: 100, t: 0 }, { x: 101, y: 100, t: 10 }, 'swipe')).toMatchObject({ kind: 'swipe', durationMs: 120 });
  });
});
