import { useState } from 'react';
import type { InstanceState } from '@avdm/core';
import type { AccountLoginSession, GameAccount } from '../../../main/automation/accounts/types';
import { avdm, errMsg, errorCodeOf } from '../../api';
import { useSelection } from '../../state/selection';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Modal } from '../../components/Modal';
import { Spinner } from '../../components/StatusBadge';
import { useToast } from '../../components/Toasts';
import { accountCellOptions, accountOfIndex, boundTo, loginIsActive } from './account-model';
import './AccountsView.css';

const NONE = '__none__';
const CREATE = '__create__';

export interface InstanceAccountCellProps {
  gameId: string;
  instance: InstanceState;
  /** Every instance, to name the one an account would be moved from; defaults to the selection's list. */
  instances?: readonly InstanceState[];
  /** Accounts of the game (from `useAccounts`), shared by every row of the table. */
  accounts: GameAccount[];
  /** Chinese reason the cell is read-only (e.g. from `accountCellDisabledReason`), or null. */
  disabledReason?: string | null;
  /** The instance's latest login session, to show 「登录中」. */
  loginSession?: AccountLoginSession | null;
  /** Called after a bind, unbind or create-and-bind (e.g. to refresh gather config badges). */
  onChanged?(index: number): void;
  /** Opens the login wizard for this instance (shown for a pending account). */
  onLogin?(index: number): void;
  /** True once gather settings read the bound account first (DECISIONS B「调度器」); only changes the hint. */
  gatherFollowsAccount?: boolean;
}

/**
 * The instance row's account select (original InstanceAccountCell): bind, unbind, move an account from another
 * instance, or create one and bind it on the spot. Taking an instance from its current account is confirmed
 * explicitly; whether an edit is allowed right now (login, gather, plans) is decided by the main process.
 */
export function InstanceAccountCell({
  gameId, instance, instances, accounts, disabledReason = null, loginSession, onChanged, onLogin, gatherFollowsAccount = false,
}: InstanceAccountCellProps) {
  const toast = useToast();
  const selection = useSelection();
  const allInstances = instances ?? selection.instances;
  const index = instance.record.index;
  const account = accountOfIndex(accounts, index) ?? null;
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  /** Client id of the account being created, kept across retries so a lost reply never creates a second one. */
  const [pendingId, setPendingId] = useState('');
  const [takeover, setTakeover] = useState<{ accountId: string; ownerName: string } | null>(null);
  const loggingIn = loginIsActive(loginSession?.phase);
  const stale = account && !boundTo(account, instance);

  async function bind(accountId: string, target: number | null, takeOver = false): Promise<void> {
    setBusy(true);
    try {
      const result = await avdm.accountBind(accountId, target, { takeOver });
      if (target === null) toast.push({ kind: 'success', title: '已解除绑定', detail: result.notice });
      else toast.push({ kind: 'success', title: `已绑定到实例 #${target}`, detail: [
        result.displaced ? `「${result.displaced.name}」已解除绑定，需重新登录。` : '', result.notice ?? '',
      ].filter(Boolean).join('') || undefined });
      onChanged?.(index);
    } catch (error) {
      if (errorCodeOf(error) === 'ACCOUNT_SLOT_TAKEN' && !takeOver && target !== null) {
        setTakeover({ accountId, ownerName: account?.name ?? '原账号' });
        return;
      }
      toast.error('绑定未完成', errMsg(error));
    } finally {
      setBusy(false);
    }
  }

  function onSelect(value: string): void {
    if (value === NONE) {
      if (account) void bind(account.id, null);
      return;
    }
    if (value === CREATE) {
      setNewName('');
      setPendingId(crypto.randomUUID());
      setCreating(true);
      return;
    }
    if (account && account.id !== value) setTakeover({ accountId: value, ownerName: account.name });
    else void bind(value, index);
  }

  async function createAndBind(): Promise<void> {
    if (busy || !pendingId) return;
    const name = newName.trim();
    if (!name) {
      toast.push({ kind: 'warn', title: '给账号起个名字，比如「主号-王朝A区」。' });
      return;
    }
    setBusy(true);
    try {
      // One transaction under a stable client id: a refused bind creates nothing, a retry never duplicates.
      // The user saw the current owner in the dialog, so creating here is the confirmed takeover.
      const result = await avdm.accountCreateAndBind(gameId, index, pendingId, { name }, { takeOver: Boolean(account) });
      setCreating(false);
      setPendingId('');
      toast.push({ kind: 'success', title: `账号「${result.account.name}」已创建并绑定到实例 #${index}`,
        detail: [
          result.displaced ? `「${result.displaced.name}」已解除绑定，需重新登录。` : '', result.notice ?? '',
          '接下来可点「登录」完成游戏登录检查。',
        ].filter(Boolean).join('') });
      onChanged?.(index);
    } catch (error) {
      toast.error('新建账号未完成', errMsg(error));
    } finally {
      setBusy(false);
    }
  }

  const reason = disabledReason ?? (loggingIn ? '该实例正在登录，请在登录向导中完成或结束后再改绑' : null);
  const hint = reason ?? (account
    ? `${gatherFollowsAccount ? `采集配置跟随账号「${account.name}」。` : `已绑定账号「${account.name}」。`}${instance.status === 'stopped' ? '实例没开机也能改绑。' : ''}`
    : `${gatherFollowsAccount ? '未绑定账号的实例使用实例上保存的采集配置；' : ''}账号需通过登录检查后才能用于脚本计划。`);

  return (
    <div className="accounts-cell" title={hint}>
      <select value={account ? account.id : NONE} disabled={reason !== null || busy} aria-label={`实例 #${index} 的账号`}
        onChange={(event) => onSelect(event.target.value)}>
        <option value={NONE}>{account ? '解除绑定' : '未绑定'}</option>
        {accountCellOptions(accounts, index, allInstances).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        <option value={CREATE}>＋ 新建账号并绑定…</option>
      </select>
      {busy && <Spinner size={12} />}
      {loggingIn && <span className="tag warn">登录中</span>}
      {!loggingIn && stale && <span className="tag warn">实例已替换</span>}
      {!loggingIn && !stale && account && account.login.status !== 'ready' && (
        onLogin ? <button type="button" className="link-btn" onClick={() => onLogin(index)}>待登录 · 登录</button>
          : <span className="tag warn">待登录</span>
      )}
      {creating && (
        <Modal title={`新建账号并绑定到实例 #${index}`} onClose={() => setCreating(false)} busy={busy} width={440}
          footer={<>
            <button type="button" className="btn" onClick={() => setCreating(false)} disabled={busy}>取消</button>
            <button type="button" className="btn primary" onClick={() => void createAndBind()} disabled={busy || !newName.trim() || !pendingId}>
              {busy && <Spinner size={12} />}创建并绑定
            </button>
          </>}>
          <p className="accounts-dim">只需要一个名字。服务器、备注、默认脚本到「设备与账号 → 账号管理」页再补。</p>
          {account && <div className="notice warn">实例当前绑定「{account.name}」，创建后它将解除绑定并需要重新登录。</div>}
          <input type="text" autoFocus value={newName} maxLength={40} placeholder="例如 主号-王朝A区"
            onChange={(event) => setNewName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void createAndBind(); }}
            aria-label="新账号名称" className="accounts-wide-input" />
        </Modal>
      )}
      {takeover && (
        <ConfirmDialog title="改绑实例" confirmLabel="确认改绑" danger
          message={`实例 #${index} 已绑定「${takeover.ownerName}」。改绑后「${takeover.ownerName}」将解除绑定、停用并需要重新登录，该实例的自动采集也会关闭。`}
          onClose={() => setTakeover(null)}
          onConfirm={async () => { const target = takeover; setTakeover(null); await bind(target.accountId, index, true); }} />
      )}
    </div>
  );
}
