import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { InstanceState } from '@avdm/core';
import type { AccountDetails, AccountLoginCommand, AccountLoginSession,
  GameAccount } from '../../../main/automation/accounts/types';
import { avdm, errMsg } from '../../api';
import { beijingTime } from '../../format';
import { Icon } from '../../components/Icon';
import { useToast } from '../../components/Toasts';
import './AccountPanel.css';

const emptyDetails: AccountDetails = { name: '', server: '', role: '', note: '' };

function phaseBusy(session: AccountLoginSession | null): boolean {
  return !!session && ['preparing', 'starting', 'awaitingLogin', 'verifying'].includes(session.phase);
}

function accountStatus(account: GameAccount, instance: InstanceState | undefined): string {
  if (!account.binding) return '未绑定';
  if (instance && account.binding.index === instance.record.index &&
    account.binding.instanceCreatedAt !== instance.record.createdAt) return '实例已替换';
  if (account.login.status !== 'ready') return '待登录验证';
  return account.enabled ? '已启用' : '已停用';
}

export function AccountPanel({ gameId, index, instance }: {
  gameId: string;
  index: number | null;
  instance?: InstanceState;
}) {
  const toast = useToast();
  const [accounts, setAccounts] = useState<GameAccount[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<AccountDetails>(emptyDetails);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const [busy, setBusy] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [session, setSession] = useState<AccountLoginSession | null>(null);
  const [sessionError, setSessionError] = useState<string>();
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [identityConfirmed, setIdentityConfirmed] = useState(false);
  const inspected = useRef<string | null>(null);

  const loadAccounts = useCallback(async () => {
    try {
      const values = await avdm.accountList(gameId);
      setAccounts(values);
      setSelectedId((current) => current && values.some((account) => account.id === current)
        ? current : values[0]?.id ?? null);
      setLoadError(undefined);
    } catch (error) { setLoadError(errMsg(error)); }
    finally { setLoaded(true); }
  }, [gameId]);

  useEffect(() => {
    setLoaded(false);
    setCreating(false);
    setEditing(false);
    setSelectedId(null);
    void loadAccounts();
  }, [loadAccounts]);

  const refreshSession = useCallback(async () => {
    if (index === null) { setSession(null); return; }
    try {
      const current = await avdm.accountLoginSession(index);
      setSession(current?.gameId === gameId ? current : null);
      setSessionError(undefined);
    } catch (error) { setSessionError(errMsg(error)); }
  }, [gameId, index]);

  useEffect(() => {
    void refreshSession();
    if (index === null) return;
    const timer = window.setInterval(() => void refreshSession(), 1500);
    return () => window.clearInterval(timer);
  }, [refreshSession, index]);

  useEffect(() => {
    if (session?.phase === 'completed') void loadAccounts();
  }, [session?.phase, session?.id, loadAccounts]);

  useEffect(() => {
    if (!session || session.phase !== 'awaitingLogin' || session.screen || inspected.current === session.id) return;
    inspected.current = session.id;
    void avdm.accountLoginCommand(session.id, { requestId: crypto.randomUUID(), action: 'inspect' })
      .then(setSession).catch(() => undefined);
  }, [session]);

  const selected = useMemo(() => accounts.find((account) => account.id === selectedId) ?? null,
    [accounts, selectedId]);
  const targetBound = selected?.binding?.index === index &&
    selected.binding.instanceCreatedAt === instance?.record.createdAt;
  const targetOwnedByOther = accounts.find((account) => account.id !== selectedId &&
    account.binding?.index === index);
  const staleBinding = Boolean(selected?.binding && selected.binding.index === index &&
    selected.binding.instanceCreatedAt !== instance?.record.createdAt);
  const loginForSelection = session?.accountId === selectedId ? session : null;
  const activeLogin = phaseBusy(loginForSelection);
  const isPending = selected?.login.status !== 'ready';

  async function action(label: string, work: () => Promise<void>): Promise<void> {
    if (busy) return;
    setBusy(label);
    try { await work(); }
    catch (error) { toast.error(`${label}失败`, error); }
    finally { setBusy(null); }
  }

  function selectAccount(account: GameAccount): void {
    setSelectedId(account.id);
    setCreating(false);
    setEditing(false);
    setDeleteConfirm(false);
    setDraft({ name: account.name, server: account.server, role: account.role, note: account.note });
  }

  function submitDetails(event: FormEvent): void {
    event.preventDefault();
    void action(creating ? '创建账号' : '保存账号', async () => {
      const next = creating ? await avdm.accountCreate(gameId, draft)
        : await avdm.accountUpdate(selected!.id, draft);
      await loadAccounts();
      setSelectedId(next.id);
      setCreating(false);
      setEditing(false);
      toast.push({ kind: 'success', title: creating ? '账号已创建' : '账号资料已保存' });
    });
  }

  function loginCommand(command: AccountLoginCommand): void {
    if (!loginForSelection) return;
    void action('登录操作', async () => {
      if (command.action === 'submitCode') setCode('');
      const result = await avdm.accountLoginCommand(loginForSelection.id, command);
      setSession(result);
      if (command.action === 'requestSms') setPhone('');
    });
  }

  return (
    <section className="account-panel" aria-label="游戏账号管理">
      <div className="account-heading">
        <div>
          <h2>账号</h2>
          <p>账号只保存名称、角色资料和实例绑定。手机号与验证码仅在本次登录时使用。</p>
        </div>
        <button className="btn sm" onClick={() => {
          setCreating(true); setEditing(false); setSelectedId(null); setDraft(emptyDetails); setDeleteConfirm(false);
        }} disabled={!!busy}>
          <Icon name="plus" size={15} /> 新建账号
        </button>
      </div>

      {loadError && <div className="account-error" role="alert">{loadError} <button className="link-btn" onClick={() => void loadAccounts()}>重试</button></div>}
      {sessionError && <div className="account-error" role="alert">登录状态读取失败：{sessionError}</div>}
      <div className="account-layout">
        <div className="account-roster" aria-label="账号列表">
          {!loaded && <p className="account-muted">正在读取账号…</p>}
          {loaded && accounts.length === 0 && !creating && (
            <div className="account-empty"><Icon name="devices" size={22} /><strong>还没有游戏账号</strong><span>先新建账号，再绑定实例完成登录。</span></div>
          )}
          {accounts.map((account) => (
            <button key={account.id} type="button" className={`account-row ${selectedId === account.id && !creating ? 'is-active' : ''}`}
              onClick={() => selectAccount(account)}>
              <span className="account-avatar" aria-hidden="true">{account.name.slice(0, 1)}</span>
              <span className="account-row-text"><strong>{account.name}</strong><small>
                {account.binding ? `#${account.binding.index} · ` : ''}{accountStatus(account, instance)}
              </small></span>
              {account.enabled && <span className="account-dot" title="已启用" />}
            </button>
          ))}
        </div>

        <div className="account-detail">
          {(creating || editing) && (
            <form className="account-form" onSubmit={submitDetails}>
              <div className="account-form-head"><h3>{creating ? '新建账号' : '编辑账号资料'}</h3>
                <p>填写便于区分的名称。密码、验证码和私密凭据不保存在这里。</p></div>
              <div className="account-fields">
                <label>账号名称<input type="text" autoFocus value={draft.name} maxLength={100} required
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="例如：一区 · 采集号" /></label>
                <label>服务器<input type="text" value={draft.server ?? ''} maxLength={100}
                  onChange={(event) => setDraft({ ...draft, server: event.target.value })} placeholder="可选" /></label>
                <label>角色名称<input type="text" value={draft.role ?? ''} maxLength={100}
                  onChange={(event) => setDraft({ ...draft, role: event.target.value })} placeholder="可选" /></label>
                <label className="account-wide">备注<textarea value={draft.note ?? ''} maxLength={1000} rows={3}
                  onChange={(event) => setDraft({ ...draft, note: event.target.value })} placeholder="可选，例如角色用途或大区" /></label>
              </div>
              <div className="account-actions"><button className="btn primary" disabled={!!busy || !draft.name.trim()} type="submit">
                {busy ?? (creating ? '创建账号' : '保存资料')}</button>
                <button className="btn ghost" type="button" onClick={() => { setCreating(false); setEditing(false); }}>取消</button></div>
            </form>
          )}

          {!creating && !editing && selected && (
            <>
              <div className="account-detail-head">
                <div><h3>{selected.name}</h3><p>{[selected.server, selected.role].filter(Boolean).join(' · ') || '尚未填写服务器与角色'}</p></div>
                <span className={`account-status ${selected.enabled ? 'ready' : isPending ? 'pending' : ''}`}>
                  {accountStatus(selected, instance)}
                </span>
              </div>
              {selected.note && <p className="account-note">{selected.note}</p>}
              <div className="account-facts">
                <span>所属游戏<strong>{selected.gameId}</strong></span>
                <span>绑定实例<strong>{selected.binding ? `#${selected.binding.index}` : '未绑定'}</strong></span>
                <span>上次验证<strong>{selected.login.verifiedAt ? `${beijingTime(selected.login.verifiedAt, 'full')}（北京）` : '尚未验证'}</strong></span>
              </div>
              {staleBinding && <div className="account-warning" role="alert">实例编号已被新设备占用。请解除绑定后重新登录。</div>}
              {targetOwnedByOther && <div className="account-warning">当前实例已绑定「{targetOwnedByOther.name}」。先解除其绑定，再绑定此账号。</div>}
              <div className="account-actions account-actions-wrap">
                <button className="btn sm" onClick={() => {
                  setDraft({ name: selected.name, server: selected.server, role: selected.role, note: selected.note });
                  setEditing(true);
                }} disabled={!!busy || activeLogin}><Icon name="edit" size={14} /> 编辑资料</button>
                {selected.binding ? (
                  <button className="btn sm" disabled={!!busy || activeLogin} onClick={() => void action('解除绑定', async () => {
                    await avdm.accountBind(selected.id, null); await loadAccounts();
                  })}>解除绑定</button>
                ) : (
                  <button className="btn sm" disabled={!!busy || index === null || !instance || !!targetOwnedByOther}
                    onClick={() => void action('绑定实例', async () => {
                      await avdm.accountBind(selected.id, index!); await loadAccounts();
                    })}>绑定到当前实例{index === null ? '' : ` #${index}`}</button>
                )}
                <button className="btn sm" disabled={!!busy || activeLogin || selected.login.status !== 'ready' || staleBinding}
                  onClick={() => void action(selected.enabled ? '停用账号' : '启用账号', async () => {
                    await avdm.accountSetEnabled(selected.id, !selected.enabled); await loadAccounts();
                  })}>{selected.enabled ? '停用账号' : '启用账号'}</button>
              </div>

              <div className="account-login">
                <div className="account-login-head"><div><h4>登录与验证</h4>
                  <p>使用当前实例登录该游戏账号。完成后检查城内或世界地图，再启用自动任务。</p></div>
                  <span className="account-step">{loginForSelection?.phase === 'completed' ? '已验证' : activeLogin ? '进行中' : '待操作'}</span>
                </div>
                {!targetBound && <p className="account-muted">先将该账号绑定到当前实例，再开始登录。</p>}
                {targetBound && !activeLogin && (
                  <button className="btn primary" disabled={!!busy || !!targetOwnedByOther}
                    onClick={() => void action('启动登录', async () => {
                      setIdentityConfirmed(false); setCode(''); setPhone(''); setAgreed(false);
                      const next = await avdm.accountBeginLogin(gameId, index!, selected.id);
                      setSession(next);
                    })}><Icon name="play" size={15} /> 启动登录</button>
                )}
                {loginForSelection && <p className={`account-session-message ${loginForSelection.phase === 'failed' ? 'is-error' : ''}`}
                  role="status">{loginForSelection.message}</p>}
                {activeLogin && loginForSelection && (
                  <div className="account-login-flow">
                    <div className="account-actions">
                      <button className="btn sm" disabled={!!busy || loginForSelection.phase !== 'awaitingLogin'}
                        onClick={() => loginCommand({ requestId: crypto.randomUUID(), action: 'inspect' })}>刷新登录步骤</button>
                      <button className="btn sm" disabled={!!busy || instance?.status !== 'running'}
                        onClick={() => void action('打开实时画面', async () => avdm.openLiveView(index!))}>打开实时画面</button>
                    </div>
                    {loginForSelection.screen?.step === 'phone' && (
                      <div className="account-login-inputs"><label>手机号<input type="tel" inputMode="tel" autoComplete="off"
                        value={phone} maxLength={11} onChange={(event) => setPhone(event.target.value.replace(/\D/g, ''))}
                        placeholder="11 位手机号" /></label>
                        <label className="account-check"><input type="checkbox" checked={agreed}
                          onChange={(event) => setAgreed(event.target.checked)} />
                          我已阅读并同意游戏画面中的用户协议和隐私条款</label>
                        <button className="btn primary sm" disabled={!!busy || !/^1[3-9]\d{9}$/.test(phone) || !agreed}
                          onClick={() => loginCommand({ requestId: crypto.randomUUID(), action: 'requestSms',
                            phone, agreementAccepted: true })}>发送验证码</button></div>
                    )}
                    {loginForSelection.screen?.step === 'code' && (
                      <div className="account-login-inputs"><label>{loginForSelection.screen.phoneMasked ?? '手机号'} 的验证码
                        <input type="password" inputMode="numeric" autoComplete="one-time-code" value={code} maxLength={6}
                          onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))} placeholder="6 位验证码" /></label>
                        <div className="account-actions"><button className="btn primary sm" disabled={!!busy || !/^\d{6}$/.test(code)}
                          onClick={() => loginCommand({ requestId: crypto.randomUUID(), action: 'submitCode', code })}>提交验证码</button>
                          <button className="btn sm" disabled={!!busy || !!loginForSelection.screen?.retryAt && loginForSelection.screen.retryAt > Date.now()}
                            onClick={() => loginCommand({ requestId: crypto.randomUUID(), action: 'resendCode' })}>重新发送</button></div></div>
                    )}
                    <p className="account-muted">遇到额外验证或未识别的登录界面，请使用实时画面手动完成。验证码不会保存到本地。</p>
                    <label className="account-check"><input type="checkbox" checked={identityConfirmed}
                      onChange={(event) => setIdentityConfirmed(event.target.checked)} />
                      我已确认游戏中的账号、服务器和角色正确</label>
                    <div className="account-actions"><button className="btn success" disabled={!!busy || !identityConfirmed || loginForSelection.phase !== 'awaitingLogin'}
                      onClick={() => void action('验证登录', async () => {
                        const next = await avdm.accountVerifyLogin(loginForSelection.id, true);
                        setSession(next); await loadAccounts();
                      })}>检查主界面并启用</button>
                      <button className="btn ghost" disabled={!!busy || loginForSelection.phase === 'verifying'}
                        onClick={() => void action('结束登录', async () => {
                          await avdm.accountCancelLogin(loginForSelection.id); await refreshSession();
                        })}>结束向导</button></div>
                  </div>
                )}
              </div>

              <div className="account-delete">
                {deleteConfirm ? <><span>删除此账号的本地资料？</span>
                  <button className="btn sm danger" disabled={!!busy || activeLogin}
                    onClick={() => void action('删除账号', async () => {
                      await avdm.accountDelete(selected.id); await loadAccounts(); setDeleteConfirm(false);
                    })}>确认删除</button>
                  <button className="btn sm ghost" onClick={() => setDeleteConfirm(false)}>取消</button></>
                  : <button className="btn sm danger-ghost" disabled={!!busy || activeLogin}
                    onClick={() => setDeleteConfirm(true)}><Icon name="trash" size={14} /> 删除账号</button>}
              </div>
            </>
          )}
          {!creating && !editing && !selected && accounts.length > 0 && <p className="account-muted">从左侧选择一个账号。</p>}
        </div>
      </div>
    </section>
  );
}
