import { useCallback, useEffect, useRef, useState } from 'react';
import type { AccountLoginCommand, AccountLoginSession } from '../../../main/automation/accounts/types';
import { avdm, errMsg } from '../../api';
import { Drawer } from '../../components/Drawer';
import { Icon } from '../../components/Icon';
import { Spinner } from '../../components/StatusBadge';
import { useToast } from '../../components/Toasts';
import { useAvdmEvent } from '../../hooks/useAvdmEvent';
import { useSelection } from '../../state/selection';
import {
  NEW_ACCOUNT, acceptSession, accountOfIndex, isBaseInstance, loginAccountChoices, loginIsActive, loginStep, newRequestId,
} from './account-model';
import { LoginPreview } from './LoginPreview';
import { useAccounts, useBaseInstance } from './useAccounts';
import './AccountsView.css';

const STEPS = ['设置账号', '启动游戏', '登录与检查', '完成'];

/**
 * The login wizard (original AccountLoginDrawer): one or several instances logged in one after another, e.g.
 * right after cloning from the base. Closing or leaving the page cancels an active session; the account and the
 * instance are kept and the wizard can be continued later.
 */
export function AccountLoginDrawer({ gameId, indices, onClose }: {
  gameId: string;
  /** Instances to log in, in order (a batch of new copies, or a single instance). */
  indices: number[];
  onClose(): void;
}) {
  const { instances } = useSelection();
  const [position, setPosition] = useState(0);
  const [locked, setLocked] = useState(false);
  const closeRef = useRef<() => Promise<void>>(async () => onClose());
  const index = indices[Math.min(position, indices.length - 1)]!;
  return (
    <Drawer label="账号登录" title="账号登录" width={1040} busy={locked} className="accounts-login-drawer"
      onClose={() => void closeRef.current()}>
      {indices.length > 1 && (
        <div className="accounts-login-position">
          <span>本次共 {indices.length} 个实例 · 逐个登录</span>
          <select value={position} disabled={locked} onChange={(event) => setPosition(Number(event.target.value))} aria-label="选择要登录的实例">
            {indices.map((item, i) => (
              <option key={item} value={i}>#{item} {instances.find((instance) => instance.record.index === item)?.record.name ?? ''}</option>
            ))}
          </select>
        </div>
      )}
      <LoginContent key={index} gameId={gameId} index={index} setLocked={setLocked} closeRef={closeRef} onClose={onClose}
        onNext={position < indices.length - 1 ? () => setPosition(position + 1) : undefined} />
    </Drawer>
  );
}

function LoginContent({ gameId, index, setLocked, closeRef, onClose, onNext }: {
  gameId: string;
  index: number;
  setLocked(value: boolean): void;
  closeRef: { current: () => Promise<void> };
  onClose(): void;
  onNext?: () => void;
}) {
  const toast = useToast();
  const { instances, game } = useSelection();
  const { accounts } = useAccounts(gameId);
  const { view: base } = useBaseInstance(gameId);
  const instance = instances.find((item) => item.record.index === index);
  const owner = accountOfIndex(accounts, index);
  const [picked, setPicked] = useState<string | null>(null);
  const [name, setName] = useState('');
  // Generated once: retries and 「继续登录」 after a failure reuse the same new account.
  const newId = useRef('');
  if (!newId.current) newId.current = crypto.randomUUID();
  const [session, setSession] = useState<AccountLoginSession | null>(null);
  const sessionRef = useRef<AccountLoginSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [agreement, setAgreement] = useState(false);
  const commandBusy = useRef(false);
  const selected = picked ?? owner?.id ?? NEW_ACCOUNT;
  const active = !!session && loginIsActive(session.phase);
  const waiting = session?.phase === 'awaitingLogin';
  const verifying = session?.phase === 'verifying';
  const finished = session?.phase === 'completed';
  const preparing = session?.phase === 'preparing' || session?.phase === 'starting';
  const baseRow = isBaseInstance(base, instance);

  const accept = useCallback((value: AccountLoginSession | null) => {
    const next = acceptSession(sessionRef.current, value);
    sessionRef.current = next;
    setSession(next);
  }, []);

  useAvdmEvent('login-changed', (value) => {
    if (value.index === index && value.gameId === gameId) accept(value);
  });

  useEffect(() => {
    let mounted = true;
    const load = (first: boolean) => void avdm.accountLoginSession(index)
      .then((value) => { if (mounted) accept(value?.gameId === gameId ? value : null); })
      .catch(() => { if (mounted && first) setLoadError(true); })
      .finally(() => { if (mounted && first) setLoading(false); });
    load(true);
    // Safety poll next to the push events.
    const timer = window.setInterval(() => load(false), 5000);
    return () => {
      mounted = false;
      window.clearInterval(timer);
      const value = sessionRef.current;
      if (value && loginIsActive(value.phase)) void avdm.accountCancelLogin(value.id).catch(() => undefined);
    };
  }, [index, gameId, accept]);

  // While a session is active the instance cannot be switched and the drawer only closes through 「稍后继续」.
  useEffect(() => { setLocked(busy || loading || active); }, [busy, loading, active, setLocked]);
  closeRef.current = async () => {
    if (busy || loading || verifying) return;
    setBusy(true);
    try {
      const current = sessionRef.current;
      if (current && loginIsActive(current.phase)) await avdm.accountCancelLogin(current.id);
      onClose();
    } catch (error) {
      toast.error('结束登录向导失败', errMsg(error));
    } finally {
      setBusy(false);
    }
  };

  async function begin(): Promise<void> {
    setBusy(true);
    setConfirmed(false);
    try {
      const accountId = session && !finished ? session.accountId : selected === NEW_ACCOUNT ? newId.current : selected;
      const newName = selected === NEW_ACCOUNT ? (name.trim() || session?.accountName || undefined) : undefined;
      accept(await avdm.accountBeginLogin(gameId, index, accountId, newName));
    } catch (error) {
      toast.error('无法开始登录', errMsg(error));
    } finally {
      setBusy(false);
    }
  }

  async function verify(): Promise<void> {
    if (!session) return;
    setBusy(true);
    try {
      accept(await avdm.accountVerifyLogin(session.id, confirmed));
      toast.push({ kind: 'success', title: '账号已检查并启用', detail: '自动采集不会自动开启，可前往采集总览设置。' });
    } catch {
      /* The session message keeps the reason (pushed through login-changed). */
    } finally {
      setBusy(false);
    }
  }

  const command = useCallback(async (input: AccountLoginCommand, quiet = false): Promise<void> => {
    const current = sessionRef.current;
    if (!current || commandBusy.current) return;
    commandBusy.current = true;
    setBusy(true);
    if (input.action === 'submitCode') setCode('');
    try {
      accept(await avdm.accountLoginCommand(current.id, input));
      if (input.action === 'requestSms') setPhone('');
    } catch (error) {
      if (!quiet) toast.error('登录操作未完成', errMsg(error));
    } finally {
      commandBusy.current = false;
      setBusy(false);
    }
  }, [accept, toast]);

  // Entering the login phase inspects the page once so the phone / code form appears by itself.
  useEffect(() => {
    if (!waiting || session?.screen || commandBusy.current) return;
    void command({ requestId: newRequestId(), action: 'inspect' }, true);
  }, [waiting, session?.id, session?.screen, command]);

  const choices = loginAccountChoices(accounts, index);
  const screen = session?.screen;

  return (
    <div className="accounts-login">
      <div className="accounts-login-head">
        <h3>#{index} · {instance?.record.name ?? '实例'}</h3>
        <p>绑定账号 → 手机号与验证码 → 进入游戏</p>
      </div>
      <ol className="accounts-steps" aria-label="登录步骤">
        {STEPS.map((label, i) => {
          const step = loginStep(session);
          return <li key={label} className={i < step || finished ? 'is-done' : i === step ? 'is-current' : ''} aria-current={i === step ? 'step' : undefined}>
            <span>{i < step || finished ? <Icon name="check" size={12} /> : i + 1}</span>{label}
          </li>;
        })}
      </ol>
      {loading ? <p className="accounts-dim"><Spinner size={12} /> 读取登录状态…</p>
        : loadError ? <div className="notice bad" role="alert"><Icon name="alert" />读取登录状态失败，请关闭后重新打开。</div>
          : <>
            {baseRow && !active && (
              <div className="notice warn"><Icon name="alert" />这是基础实例，请先克隆副本，再在副本中登录账号。</div>
            )}
            {!active && !finished && (
              <>
                <div className="notice info"><Icon name="info" />
                  <span>在副本中登录自己的游戏账号。若副本继承了登录状态，请先在游戏中切换为目标账号；已有角色通常会自动进入游戏。无需填写密码，手机号与验证码只在本次操作中使用、不会保存。</span></div>
                <label className="field">
                  <span className="field-label">助手账号</span>
                  <select value={selected} disabled={!!session && !finished}
                    onChange={(event) => setPicked(event.target.value)}>
                    {choices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
                  </select>
                </label>
                {selected === NEW_ACCOUNT && (
                  <label className="field">
                    <span className="field-label">新账号名称</span>
                    <input type="text" value={name} maxLength={100} onChange={(event) => setName(event.target.value)}
                      placeholder="账号备注名，例如：一区·采集号02（无需填写密码）" />
                  </label>
                )}
              </>
            )}
            {session && (
              <div className={`notice ${finished ? 'info accounts-notice-ok' : session.phase === 'failed' ? 'bad' : 'info'}`} role="status">
                <Icon name={finished ? 'check' : session.phase === 'failed' ? 'alert' : 'info'} />
                <span><strong>{session.accountName ? `账号：${session.accountName}` : '账号登录'}</strong><br />{session.message}</span>
              </div>
            )}
            {preparing && <p className="accounts-dim"><Spinner size={12} /> 正在准备，首次启动可能需要一两分钟…</p>}
            {(waiting || verifying) && session && (
              <div className="accounts-login-flow">
                <div className="accounts-login-row">
                  <strong>{screen?.step === 'code' ? '输入验证码' : screen?.step === 'phone' ? '手机号登录' : '等待游戏画面'}</strong>
                  <button type="button" className="btn xs" disabled={busy} onClick={() => void command({ requestId: newRequestId(), action: 'inspect' })}>
                    <Icon name="refresh" size={13} /> 刷新登录步骤
                  </button>
                </div>
                {screen?.step === 'phone' && (
                  <div className="accounts-login-form">
                    <input type="tel" inputMode="tel" autoComplete="off" value={phone} maxLength={11} placeholder="请输入 11 位手机号"
                      onChange={(event) => setPhone(event.target.value.replace(/\D/g, ''))} aria-label="手机号" />
                    <label className="check"><input type="checkbox" checked={agreement} onChange={(event) => setAgreement(event.target.checked)} />
                      我已阅读并同意游戏画面中的用户协议与隐私条款</label>
                    <button type="button" className="btn primary sm" disabled={busy || !/^1[3-9]\d{9}$/.test(phone) || !agreement}
                      onClick={() => void command({ requestId: newRequestId(), action: 'requestSms', phone, agreementAccepted: agreement })}>发送验证码</button>
                  </div>
                )}
                {screen?.step === 'code' && (
                  <div className="accounts-login-form">
                    <span>{screen.phoneMasked ?? '手机'} 的验证码</span>
                    <input type="password" inputMode="numeric" autoComplete="off" value={code} maxLength={6} placeholder="6 位验证码"
                      onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))} aria-label="验证码" />
                    <button type="button" className="btn primary sm" disabled={busy || !/^\d{6}$/.test(code)}
                      onClick={() => void command({ requestId: newRequestId(), action: 'submitCode', code })}>提交验证码</button>
                    <button type="button" className="btn sm" disabled={busy || (!!screen.retryAt && screen.retryAt > Date.now())}
                      onClick={() => void command({ requestId: newRequestId(), action: 'resendCode' })}>重新发送</button>
                  </div>
                )}
                {(screen?.step === 'game' || screen?.step === 'manual') && (
                  <p className="accounts-dim">已经登录？确认下方画面是目标账号的角色后，直接勾选确认并检查主界面即可。</p>
                )}
                <p className="accounts-dim">登录后关闭公告，回到城内或世界地图，再检查登录结果。若出现额外验证，可在下方画面手动处理。</p>
                <LoginPreview key={session.id} sessionId={session.id} index={index} packageName={game?.packageName ?? ''} disabled={busy} />
                <label className="check"><input type="checkbox" checked={confirmed} disabled={busy}
                  onChange={(event) => setConfirmed(event.target.checked)} />我已确认进入了目标账号的游戏角色</label>
              </div>
            )}
            <div className="accounts-login-actions">
              {!active && !finished && (
                <button type="button" className="btn primary" onClick={() => void begin()}
                  disabled={busy || baseRow || (selected === NEW_ACCOUNT && !name.trim() && !session?.accountName)}>
                  {busy ? <Spinner size={12} /> : <Icon name="play" size={14} />} {session ? '继续登录' : '绑定账号并启动游戏'}
                </button>
              )}
              {(waiting || verifying) && (
                <button type="button" className="btn success" disabled={busy || !confirmed || verifying} onClick={() => void verify()}>
                  {verifying ? <Spinner size={12} /> : <Icon name="check" size={14} />} 检查登录并启用账号
                </button>
              )}
              {finished && onNext && <button type="button" className="btn primary" onClick={onNext}>登录下一个实例</button>}
              <button type="button" className="btn ghost" disabled={busy || verifying} onClick={() => void closeRef.current()}>
                {finished ? '完成' : '稍后继续'}
              </button>
            </div>
          </>}
    </div>
  );
}
