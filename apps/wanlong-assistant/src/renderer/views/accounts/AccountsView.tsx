import { useEffect, useState, type FormEvent } from 'react';
import type { GameAccount } from '../../../main/automation/accounts/types';
import type { ScriptMeta } from '../../../main/plans/types';
import { avdm, errMsg, errorCodeOf } from '../../api';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/Modal';
import { Spinner } from '../../components/StatusBadge';
import { useToast } from '../../components/Toasts';
import { beijingTime } from '../../format';
import { useSelection } from '../../state/selection';
import type { ViewProps } from '../types';
import { accountStatus, defaultScriptLabel, instanceOptions, loginCheck, loginIsActive } from './account-model';
import { AccountLoginDrawer } from './AccountLoginDrawer';
import { BaseInstanceCard } from './BaseInstanceCard';
import { useAccounts, useBaseInstance, useLoginSessions } from './useAccounts';
import './AccountsView.css';

interface Draft {
  name: string;
  server: string;
  role: string;
  note: string;
  defaultScriptId: string;
  index: number | '';
}

const emptyDraft: Draft = { name: '', server: '', role: '', note: '', defaultScriptId: '', index: '' };

/**
 * 账号管理 (original AccountsView): every account of the game with its login check, instance binding (any
 * instance, running or not), default script and enable switch; the login wizard per row; the base instance.
 */
export function AccountsView(_props: ViewProps) {
  const toast = useToast();
  const { game, gameId, instances } = useSelection();
  const { accounts, loaded, error, reload } = useAccounts(gameId || undefined);
  const sessions = useLoginSessions();
  const base = useBaseInstance(gameId || undefined, (view) => {
    if (view.cleared) toast.push({ kind: 'warn', title: '基础实例已失效', detail: `#${view.cleared.index}「${view.cleared.name}」：${view.cleared.reason}，已自动取消。` });
  });
  const [scripts, setScripts] = useState<ScriptMeta[]>([]);
  const [editing, setEditing] = useState<GameAccount | 'new' | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [removing, setRemoving] = useState<GameAccount | null>(null);
  const [takeover, setTakeover] = useState<{ account: GameAccount; index: number; ownerName: string } | null>(null);
  const [loginTargets, setLoginTargets] = useState<number[] | null>(null);

  useEffect(() => {
    if (!gameId) return;
    let active = true;
    void avdm.scriptList(gameId).then((list) => { if (active) setScripts(list); }).catch(() => undefined);
    return () => { active = false; };
  }, [gameId]);

  if (!game) return null;

  async function action(label: string, work: () => Promise<void>): Promise<void> {
    if (busy) return;
    setBusy(label);
    try { await work(); }
    catch (cause) { toast.error(`${label}失败`, errMsg(cause)); }
    finally { setBusy(null); }
  }

  async function bind(account: GameAccount, index: number | null, takeOver = false): Promise<void> {
    setBusy('绑定实例');
    try {
      const result = await avdm.accountBind(account.id, index, { takeOver });
      if (index === null) toast.push({ kind: 'success', title: `已解除「${account.name}」的绑定`, detail: result.notice });
      else toast.push({ kind: 'success', title: `已绑定到实例 #${index}`, detail: [
        result.displaced ? `「${result.displaced.name}」已解除绑定，需重新登录。` : '', result.notice ?? '',
      ].filter(Boolean).join('') || undefined });
    } catch (cause) {
      if (errorCodeOf(cause) === 'ACCOUNT_SLOT_TAKEN' && index !== null && !takeOver) {
        const owner = accounts.find((item) => item.id !== account.id && item.binding?.index === index);
        setTakeover({ account, index, ownerName: owner?.name ?? '原账号' });
      } else toast.error('绑定未完成', errMsg(cause));
    } finally {
      setBusy(null);
    }
  }

  function openEdit(account: GameAccount | 'new'): void {
    setEditing(account);
    setDraft(account === 'new' ? emptyDraft : {
      name: account.name, server: account.server, role: account.role, note: account.note,
      defaultScriptId: account.defaultScriptId ?? '', index: account.binding?.index ?? '',
    });
  }

  function submit(event: FormEvent): void {
    event.preventDefault();
    const target = editing;
    if (!target) return;
    void action(target === 'new' ? '创建账号' : '保存账号', async () => {
      const details = { name: draft.name, server: draft.server, role: draft.role, note: draft.note,
        defaultScriptId: draft.defaultScriptId || null };
      const saved = target === 'new' ? await avdm.accountCreate(gameId, details) : await avdm.accountUpdate(target.id, details);
      setEditing(null);
      toast.push({ kind: 'success', title: `账号「${saved.name}」已保存` });
      const wanted = draft.index === '' ? null : draft.index;
      if ((saved.binding?.index ?? null) !== wanted) await bind(saved, wanted);
    });
  }

  async function refresh(): Promise<void> {
    setRefreshing(true);
    await Promise.all([reload(), base.reload()]);
    setRefreshing(false);
  }

  const baseIndex = base.view?.base?.index;

  return (
    <section className="accounts-view" aria-labelledby="accounts-title">
      <header className="accounts-head">
        <div>
          <h2 id="accounts-title">账号管理 <span className="tag">{accounts.length} 个</span></h2>
          <p>账号只保存名称、角色资料、实例绑定和脚本参数。手机号与验证码仅在登录时使用，不会保存。</p>
        </div>
        <div className="accounts-head-actions">
          <button type="button" className="btn sm" onClick={() => void refresh()} disabled={refreshing}>
            {refreshing ? <Spinner size={12} /> : <Icon name="refresh" size={14} />} 刷新
          </button>
          <button type="button" className="btn sm primary" onClick={() => openEdit('new')}><Icon name="plus" size={14} /> 新建账号</button>
        </div>
      </header>

      <div className="notice info"><Icon name="info" />
        <span><strong>一个实例同时只能绑一个账号。</strong>把已被占用的实例绑给另一个账号时需要确认，原账号会解除绑定并需重新登录。账号通过登录检查（进入城内或世界地图）后才能启用。</span>
      </div>

      <BaseInstanceCard gameId={gameId} base={base.view} baseError={base.error} instances={instances}
        onCloned={(indices, login) => { if (login && indices.length) setLoginTargets(indices); }} />

      {error && <div className="notice bad" role="alert"><Icon name="alert" />账号读取失败：{error} <button className="link-btn" onClick={() => void reload()}>重试</button></div>}
      {!loaded ? <p className="accounts-dim"><Spinner size={12} /> 正在读取账号…</p>
        : accounts.length === 0 ? (
          <div className="accounts-empty"><Icon name="devices" size={22} /><strong>还没有账号</strong>
            <span>点右上角「新建账号」然后绑定实例，或从基础实例克隆副本后在登录向导里直接新建。</span></div>
        ) : (
          <div className="table-wrap accounts-scroll">
            <table className="inst-table accounts-table">
              <thead><tr><th>账号</th><th>登录检查</th><th>绑定实例</th><th>默认脚本</th><th>启用</th><th aria-label="操作" /></tr></thead>
              <tbody>
                {accounts.map((account) => {
                  const status = accountStatus(account, instances);
                  const check = loginCheck(account);
                  const script = defaultScriptLabel(account, scripts);
                  const session = account.binding ? sessions.get(account.binding.index) : undefined;
                  const loggingIn = Boolean(session && session.accountId === account.id && loginIsActive(session.phase));
                  const options = instanceOptions(instances, accounts, account.id, base.view);
                  const bindingMissing = account.binding && !options.some((option) => option.value === account.binding!.index);
                  return (
                    <tr key={account.id}>
                      <td>
                        <div className="accounts-name">
                          <strong>{account.name}</strong>
                          {status.tone !== 'ok' && <span className={`tag ${status.tone === 'warn' ? 'warn' : ''}`}>{status.label}</span>}
                          {loggingIn && <span className="tag warn">登录中</span>}
                        </div>
                        {(account.server || account.role || account.note) && (
                          <div className="accounts-dim accounts-sub">{[account.server, account.role, account.note].filter(Boolean).join(' · ')}</div>
                        )}
                      </td>
                      <td title={check.verifiedAt ? `检查于 ${beijingTime(check.verifiedAt, 'full')}（北京时间）` : undefined}>
                        {check.label === '已检查' ? <span className="tag ok">已检查</span> : <span className="accounts-dim">{check.label}</span>}
                      </td>
                      <td>
                        <select value={account.binding?.index ?? ''} disabled={Boolean(busy) || loggingIn} aria-label={`${account.name} 绑定的实例`}
                          onChange={(event) => {
                            const value = event.target.value === '' ? null : Number(event.target.value);
                            const option = options.find((item) => item.value === value);
                            if (value !== null && option?.owner) setTakeover({ account, index: value, ownerName: option.owner.name });
                            else void bind(account, value);
                          }}>
                          <option value="">{account.binding ? '解除绑定' : '未绑定'}</option>
                          {bindingMissing && <option value={account.binding!.index}>#{account.binding!.index}（实例已删除）</option>}
                          {options.map((option) => (
                            <option key={option.value} value={option.value} disabled={option.disabled && option.value !== account.binding?.index}>{option.label}</option>
                          ))}
                        </select>
                      </td>
                      <td>
                        {!script ? <span className="accounts-dim">未设置</span>
                          : script.missing ? <span className="tag warn" title="这个脚本已经不存在了，请重新选一个">{script.label}</span>
                            : <span className="tag">{script.label}</span>}
                      </td>
                      <td>
                        <button type="button" role="switch" aria-checked={account.enabled} aria-label={`启用 ${account.name}`}
                          className={`accounts-switch ${account.enabled ? 'is-on' : ''}`}
                          disabled={Boolean(busy) || loggingIn || account.login.status !== 'ready' || status.label === '实例已替换'}
                          title={account.login.status !== 'ready' ? '请先完成登录向导，再启用该账号' : undefined}
                          onClick={() => void action(account.enabled ? '停用账号' : '启用账号', async () => {
                            await avdm.accountSetEnabled(account.id, !account.enabled);
                          })}><span /></button>
                      </td>
                      <td><div className="accounts-actions">
                        <button type="button" className="btn xs" disabled={account.binding === null || account.binding.index === baseIndex}
                          title={account.binding === null ? '先绑定一个实例，再登录' : undefined}
                          onClick={() => setLoginTargets([account.binding!.index])}>
                          {loggingIn || (account.login.status !== 'ready' && account.login.attemptId) ? '继续登录' : '登录'}
                        </button>
                        <button type="button" className="btn xs" onClick={() => openEdit(account)} disabled={Boolean(busy)}><Icon name="edit" size={13} /> 编辑</button>
                        <button type="button" className="btn xs danger-ghost" onClick={() => setRemoving(account)} disabled={Boolean(busy) || loggingIn}>
                          <Icon name="trash" size={13} /> 删除
                        </button>
                      </div></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

      {editing && (
        <Modal title={editing === 'new' ? '新建账号' : `编辑账号：${editing.name}`} onClose={() => setEditing(null)} busy={Boolean(busy)} width={560}
          footer={<>
            <button type="button" className="btn" onClick={() => setEditing(null)} disabled={Boolean(busy)}>取消</button>
            <button type="submit" form="accounts-edit-form" className="btn primary" disabled={Boolean(busy) || !draft.name.trim()}>
              {busy && <Spinner size={12} />}保存
            </button>
          </>}>
          <form id="accounts-edit-form" className="form-grid" onSubmit={submit}>
            <label className="field span-2"><span className="field-label">账号名称</span>
              <input type="text" value={draft.name} maxLength={100} required placeholder="例如：主号-王朝A区"
                onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
            <label className="field"><span className="field-label">服务器（可选）</span>
              <input type="text" value={draft.server} maxLength={100} onChange={(event) => setDraft({ ...draft, server: event.target.value })} /></label>
            <label className="field"><span className="field-label">角色名称（可选）</span>
              <input type="text" value={draft.role} maxLength={100} onChange={(event) => setDraft({ ...draft, role: event.target.value })} /></label>
            <label className="field"><span className="field-label">绑定实例（可选）</span>
              <select value={draft.index} onChange={(event) => setDraft({ ...draft, index: event.target.value === '' ? '' : Number(event.target.value) })}>
                <option value="">暂不绑定</option>
                {instanceOptions(instances, accounts, editing === 'new' ? null : editing.id, base.view).map((option) => (
                  <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>
                ))}
              </select></label>
            <label className="field"><span className="field-label">默认脚本（可选）</span>
              <select value={draft.defaultScriptId} onChange={(event) => setDraft({ ...draft, defaultScriptId: event.target.value })}>
                <option value="">不设置</option>
                {draft.defaultScriptId && !scripts.some((script) => script.id === draft.defaultScriptId) && (
                  <option value={draft.defaultScriptId}>{draft.defaultScriptId}（已丢失）</option>
                )}
                {scripts.map((script) => <option key={script.id} value={script.id}>{script.name} v{script.version}</option>)}
              </select></label>
            <label className="field span-2"><span className="field-label">备注（服务器、角色用途等）</span>
              <textarea rows={2} value={draft.note} maxLength={1000} onChange={(event) => setDraft({ ...draft, note: event.target.value })} /></label>
            <p className="hint accounts-span-2">启用开关在列表中切换：账号需先在登录向导中通过登录检查。改绑到其他实例后需要重新登录；目标实例已被占用时会先请你确认。</p>
          </form>
        </Modal>
      )}

      {removing && (
        <ConfirmDialog title={`删除账号「${removing.name}」？`} confirmLabel="删除" danger
          message="只删除助手里的账号资料，不会影响模拟器里的游戏数据。该账号绑定实例的自动采集会被关闭。"
          onClose={() => setRemoving(null)}
          onConfirm={async () => {
            try {
              await avdm.accountDelete(removing.id);
              toast.push({ kind: 'success', title: `账号「${removing.name}」已删除` });
            } catch (cause) {
              toast.error('删除账号失败', errMsg(cause));
              throw cause;
            }
          }} />
      )}

      {takeover && (
        <ConfirmDialog title="改绑实例" confirmLabel="确认改绑" danger
          message={`实例 #${takeover.index} 已绑定「${takeover.ownerName}」。改绑给「${takeover.account.name}」后，「${takeover.ownerName}」将解除绑定、停用并需要重新登录，该实例的自动采集也会关闭。`}
          onClose={() => setTakeover(null)}
          onConfirm={async () => { const target = takeover; setTakeover(null); await bind(target.account, target.index, true); }} />
      )}

      {loginTargets && (
        <AccountLoginDrawer gameId={gameId} indices={loginTargets} onClose={() => { setLoginTargets(null); void reload(); }} />
      )}
    </section>
  );
}
