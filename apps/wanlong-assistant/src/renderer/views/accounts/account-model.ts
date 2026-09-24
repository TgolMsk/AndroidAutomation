/**
 * Pure helpers of the accounts page, the login drawer and the instance account cell (testable in Node). Labels
 * follow the original AccountsView / InstanceAccountCell / AccountLoginDrawer wording.
 */
import type { InstanceState } from '@avdm/core';
import type { AccountLoginSession, GameAccount, LoginPhase } from '../../../main/automation/accounts/types';
import type { BaseInstanceView } from '../../../main/instances/types';

/** Reference space of login preview coordinates. */
export const LOGIN_REF_WIDTH = 2560;
export const LOGIN_REF_HEIGHT = 1440;
/** A drag longer than this (reference pixels) is a swipe, otherwise a tap. */
export const SWIPE_THRESHOLD_REF = 40;
export const NEW_ACCOUNT = '__new__';

export function isInstanceUp(instance: InstanceState | undefined): boolean {
  return Boolean(instance && (instance.status === 'running' || instance.status === 'booting' || instance.status === 'starting'));
}

export function loginIsActive(phase: LoginPhase | undefined): boolean {
  return phase === 'preparing' || phase === 'starting' || phase === 'awaitingLogin' || phase === 'verifying';
}

/** The base instance of the current view, when it is still valid. */
export function isBaseInstance(base: BaseInstanceView | null | undefined, instance: InstanceState | undefined): boolean {
  return Boolean(base?.base && instance && base.base.index === instance.record.index &&
    base.base.createdAt === instance.record.createdAt);
}

/** Whether the account's binding points at this AVD (index and creation identity). */
export function boundTo(account: GameAccount, instance: InstanceState | undefined): boolean {
  return Boolean(instance && account.binding?.index === instance.record.index &&
    account.binding.instanceCreatedAt === instance.record.createdAt);
}

/** Account of the instance row: bound to its index (possibly with a stale identity, which the UI flags). */
export function accountOfIndex(accounts: readonly GameAccount[], index: number): GameAccount | undefined {
  return accounts.find((account) => account.binding?.index === index);
}

export function accountStatus(account: GameAccount, instances: readonly InstanceState[]): { label: string; tone: 'ok' | 'warn' | 'dim' } {
  if (!account.binding) return { label: '未绑定', tone: 'dim' };
  const instance = instances.find((item) => item.record.index === account.binding!.index);
  if (instance && instance.record.createdAt !== account.binding.instanceCreatedAt) return { label: '实例已替换', tone: 'warn' };
  if (!instance && instances.length > 0) return { label: '实例已删除', tone: 'warn' };
  if (account.login.status !== 'ready') return { label: '待登录', tone: 'warn' };
  return account.enabled ? { label: '已启用', tone: 'ok' } : { label: '已停用', tone: 'dim' };
}

/** 登录检查 column: checked (with time), waiting for a started login, or never checked. */
export function loginCheck(account: GameAccount): { label: string; verifiedAt: number | null } {
  if (account.login.status === 'ready') return { label: '已检查', verifiedAt: account.login.verifiedAt };
  return { label: account.login.attemptId ? '等待登录' : '未检查', verifiedAt: null };
}

/** Binding options over every instance: 「#i · name（未开机，已绑定「X」，选中将改绑）」. */
export function instanceOptions(
  instances: readonly InstanceState[], accounts: readonly GameAccount[], selfId: string | null,
  base: BaseInstanceView | null | undefined,
): Array<{ value: number; label: string; disabled: boolean; owner: GameAccount | null }> {
  return instances.map((instance) => {
    const index = instance.record.index;
    const owner = accounts.find((account) => account.binding?.index === index && account.id !== selfId) ?? null;
    const parts: string[] = [];
    const baseRow = isBaseInstance(base, instance);
    if (baseRow) parts.push('基础实例，不可绑定');
    if (instance.record.provisioning) parts.push('创建中');
    else if (!isInstanceUp(instance)) parts.push('未开机');
    if (owner) parts.push(`已绑定「${owner.name}」，选中将改绑`);
    const head = `#${index} · ${instance.record.name}`;
    return {
      value: index,
      label: parts.length ? `${head}（${parts.join('，')}）` : head,
      disabled: baseRow || Boolean(instance.record.provisioning) || instance.status === 'error',
      owner,
    };
  });
}

/** Options of the instance row's account select (original InstanceAccountCell). */
export function accountCellOptions(
  accounts: readonly GameAccount[], index: number, instances: readonly InstanceState[],
): Array<{ value: string; label: string }> {
  return accounts.map((account) => {
    const parts: string[] = [];
    if (account.login.status !== 'ready') parts.push('待登录');
    else if (!account.enabled) parts.push('已停用');
    if (account.binding && account.binding.index !== index) {
      const other = instances.find((item) => item.record.index === account.binding!.index);
      parts.push(`已绑定 #${account.binding.index}${other ? ` ${other.record.name}` : ''}，选中将改绑`);
    }
    return { value: account.id, label: parts.length ? `${account.name}（${parts.join('，')}）` : account.name };
  });
}

/**
 * Accounts the login wizard may use on an instance: only the owner when the instance is bound; otherwise unbound
 * accounts (and those bound to this index), plus 「新建账号」.
 */
export function loginAccountChoices(accounts: readonly GameAccount[], index: number): Array<{ value: string; label: string }> {
  const owner = accountOfIndex(accounts, index);
  if (owner) return [{ value: owner.id, label: owner.name }];
  return [
    { value: NEW_ACCOUNT, label: '新建账号' },
    ...accounts.filter((account) => account.binding === null).map((account) => ({ value: account.id, label: account.name })),
  ];
}

/** Step of the four-step bar: 设置账号 / 启动游戏 / 登录与检查 / 完成. */
export function loginStep(session: AccountLoginSession | null): number {
  if (!session) return 0;
  if (session.phase === 'completed') return 3;
  if (session.phase === 'awaitingLogin' || session.phase === 'verifying') return 2;
  if (session.phase === 'preparing' || session.phase === 'starting') return 1;
  return 0;
}

/** Push events and replies can arrive out of order: keep the snapshot with the newest `updatedAt`. */
export function acceptSession(current: AccountLoginSession | null, next: AccountLoginSession | null): AccountLoginSession | null {
  if (!next) return current && loginIsActive(current.phase) ? current : null;
  if (current && current.id === next.id && next.updatedAt < current.updatedAt) return current;
  return next;
}

/**
 * Whether a rejected 「检查登录」 already shows its reason: main puts a failed home check into a newer snapshot of
 * the same session (back to awaitingLogin, carrying the message). Any other rejection needs a toast.
 */
export function verifyReasonShown(fresh: AccountLoginSession | null, sessionId: string, before: number, message: string): boolean {
  return Boolean(fresh && fresh.id === sessionId && fresh.updatedAt > before && fresh.phase === 'awaitingLogin' &&
    fresh.message === message);
}

export function defaultScriptLabel(account: GameAccount, scripts: ReadonlyArray<{ id: string; name: string }>): { label: string; missing: boolean } | null {
  if (!account.defaultScriptId) return null;
  const script = scripts.find((item) => item.id === account.defaultScriptId);
  return script ? { label: script.name, missing: false } : { label: `${account.defaultScriptId}（已丢失）`, missing: true };
}

/** Pointer position inside the displayed frame → reference coordinates (clamped). */
export function toRefPoint(rect: { left: number; top: number; width: number; height: number }, clientX: number, clientY: number): { x: number; y: number } | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  const rx = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  const ry = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
  return { x: Math.round(rx * LOGIN_REF_WIDTH), y: Math.round(ry * LOGIN_REF_HEIGHT) };
}

/** A pointer gesture in reference space → the login input to send. */
export function gestureInput(start: { x: number; y: number; t: number }, end: { x: number; y: number; t: number }, mode: 'tap' | 'swipe'):
  | { kind: 'tap'; at: { x: number; y: number } }
  | { kind: 'swipe'; at: { x: number; y: number }; to: { x: number; y: number }; durationMs: number } {
  const distance = Math.hypot(end.x - start.x, end.y - start.y);
  if (mode === 'swipe' || distance > SWIPE_THRESHOLD_REF) {
    return { kind: 'swipe', at: { x: start.x, y: start.y }, to: { x: end.x, y: end.y },
      durationMs: Math.max(120, Math.min(1200, Math.round(end.t - start.t))) };
  }
  return { kind: 'tap', at: { x: end.x, y: end.y } };
}

/** Why the instance row's account cell is disabled (null = editable). */
export function accountCellDisabledReason(options: {
  base: boolean; bound: boolean; running: boolean; loginActive: boolean;
}): string | null {
  if (options.loginActive) return '该实例正在登录，请在登录向导中完成或结束后再改绑';
  if (options.running) return '该实例正在运行自动采集，请结束后再改绑';
  if (options.base && !options.bound) return '基础实例只用于克隆，不需要绑定账号';
  return null;
}

export function newRequestId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
