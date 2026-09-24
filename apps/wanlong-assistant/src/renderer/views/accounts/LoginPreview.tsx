import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import { LOGIN_INPUT_KEYS, type LoginInput, type LoginInputKey } from '../../../main/automation/accounts/types';
import { avdm, errMsg } from '../../api';
import { Icon } from '../../components/Icon';
import { Spinner } from '../../components/StatusBadge';
import { useToast } from '../../components/Toasts';
import { gestureInput, toRefPoint } from './account-model';

const POLL_MS = 1200;

const KEY_LABELS: Record<LoginInputKey, string> = {
  BACK: '返回', HOME: '主屏幕', ENTER: '回车', MENU: '菜单', APP_SWITCH: '最近任务', DEL: '删除',
  ESCAPE: 'Esc', VOLUME_UP: '音量 +', VOLUME_DOWN: '音量 −',
};

/**
 * The embedded login preview (original PreviewPane in login mode): polls read-only frames of the session's
 * instance and sends taps, swipes, keys and digits through the login session, serialized with the wizard's own
 * commands. Frames stay in memory only.
 */
export function LoginPreview({ sessionId, index, packageName, disabled, height = 430 }: {
  sessionId: string;
  index: number;
  /** The game package: another foreground app gets a warning (main refuses taps and digits there). */
  packageName: string;
  /** A wizard command is running; input waits for it. */
  disabled?: boolean;
  height?: number;
}) {
  const toast = useToast();
  const [url, setUrl] = useState<string | null>(null);
  const [info, setInfo] = useState<{ deviceWidth: number; deviceHeight: number; foreground: string | null } | null>(null);
  const [autoPoll, setAutoPoll] = useState(true);
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'tap' | 'swipe'>('tap');
  const [key, setKey] = useState<LoginInputKey>('BACK');
  const [digits, setDigits] = useState('');
  const [sending, setSending] = useState(false);
  const polling = useRef(false);
  const alive = useRef(true);
  const drag = useRef<{ x: number; y: number; t: number } | null>(null);
  const image = useRef<HTMLImageElement>(null);

  // Set in the body too: StrictMode (dev) runs this cleanup once right after mount, then mounts again.
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);

  const capture = useCallback(async () => {
    if (polling.current) return;
    polling.current = true;
    setCapturing(true);
    try {
      const frame = await avdm.accountLoginFrame(sessionId);
      if (!alive.current) return;
      setUrl(URL.createObjectURL(new Blob([frame.jpeg as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' })));
      setInfo({ deviceWidth: frame.deviceWidth, deviceHeight: frame.deviceHeight, foreground: frame.foregroundPackage });
      setError(null);
    } catch (cause) {
      if (!alive.current) return;
      setAutoPoll(false);
      setError(`${errMsg(cause)} 已停止自动刷新。`);
    } finally {
      polling.current = false;
      if (alive.current) setCapturing(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void capture();
  }, [capture]);

  useEffect(() => {
    if (!autoPoll) return;
    const timer = window.setInterval(() => void capture(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [autoPoll, capture]);

  async function send(input: LoginInput, success?: string): Promise<void> {
    try {
      await avdm.accountLoginInput(sessionId, input);
      if (success) toast.push({ kind: 'success', title: success });
      window.setTimeout(() => void capture(), 350);
    } catch (cause) {
      toast.error('登录输入未完成', errMsg(cause));
    }
  }

  function onPointerDown(event: PointerEvent<HTMLImageElement>): void {
    if (disabled) return;
    const rect = image.current?.getBoundingClientRect();
    const at = rect ? toRefPoint(rect, event.clientX, event.clientY) : null;
    drag.current = at ? { ...at, t: Date.now() } : null;
  }

  function onPointerUp(event: PointerEvent<HTMLImageElement>): void {
    const start = drag.current;
    drag.current = null;
    const rect = image.current?.getBoundingClientRect();
    const end = rect ? toRefPoint(rect, event.clientX, event.clientY) : null;
    if (!start || !end || disabled) return;
    void send(gestureInput(start, { ...end, t: Date.now() }, mode));
  }

  async function sendDigits(): Promise<void> {
    if (!/^\d{1,32}$/.test(digits) || sending) return;
    const text = digits;
    setDigits('');
    setSending(true);
    try { await send({ kind: 'text', text }, '数字已发送'); }
    finally { setSending(false); }
  }

  const foreignForeground = info?.foreground && info.foreground !== packageName ? info.foreground : null;

  return (
    <div className="accounts-preview" aria-label={`实例 #${index} 的登录画面`}>
      <div className="accounts-preview-bar">
        <span className="tag">轮询画面</span>
        {info && <span className="accounts-dim">画面 {info.deviceWidth}×{info.deviceHeight}</span>}
        <button type="button" className="btn xs" onClick={() => void capture()} disabled={capturing}>
          {capturing ? <Spinner size={11} /> : <Icon name="camera" size={13} />} 抓一帧
        </button>
        <label className="check small"><input type="checkbox" checked={autoPoll} onChange={(event) => setAutoPoll(event.target.checked)} />自动刷新</label>
        <div className="segmented" role="group" aria-label="画面操作方式">
          <button type="button" className={mode === 'tap' ? 'active' : ''} onClick={() => setMode('tap')}>点击</button>
          <button type="button" className={mode === 'swipe' ? 'active' : ''} onClick={() => setMode('swipe')}>滑动</button>
        </div>
        <button type="button" className="link-btn accounts-preview-live" onClick={() => void avdm.openLiveView(index).catch((cause: unknown) => toast.error('无法打开实时画面', errMsg(cause)))}
          title="实时画面窗口里的操作不经过登录会话，也不校验前台应用；请勿与下方画面同时操作。">
          <Icon name="external" size={13} /> 打开实时画面（备用）
        </button>
      </div>
      {error && <p className="accounts-inline-error" role="alert">{error}</p>}
      {foreignForeground && (
        <p className="accounts-inline-warn" role="status">当前前台是 {foreignForeground}，点击和数字输入会被拒绝；可发送「返回」键回到游戏。</p>
      )}
      <div className={`accounts-preview-frame ${disabled ? 'is-busy' : ''}`} style={{ height }}>
        {url ? (
          <img ref={image} src={url} alt="实例登录画面" draggable={false}
            className={mode === 'swipe' ? 'is-swipe' : undefined}
            onPointerDown={onPointerDown} onPointerUp={onPointerUp} onPointerCancel={() => { drag.current = null; }} />
        ) : (
          <span className="accounts-dim">{capturing ? <><Spinner size={12} /> 正在读取画面…</> : '还没有画面'}</span>
        )}
      </div>
      <p className="accounts-dim accounts-preview-hint">在画面上点一下即为点击；按住拖动即为滑动。遇到额外验证、选服或建角时在这里手动处理。</p>
      <div className="accounts-preview-bar">
        <select value={key} onChange={(event) => setKey(event.target.value as LoginInputKey)} aria-label="按键">
          {LOGIN_INPUT_KEYS.map((item) => <option key={item} value={item}>{KEY_LABELS[item]}</option>)}
        </select>
        <button type="button" className="btn xs" disabled={disabled} onClick={() => void send({ kind: 'key', key })}>发送按键</button>
        <input type="password" inputMode="numeric" autoComplete="off" maxLength={32} value={digits}
          className="accounts-preview-digits" placeholder="先点游戏输入框，再填写手机号／验证码"
          onChange={(event) => setDigits(event.target.value.replace(/\D/g, ''))}
          onKeyDown={(event) => { if (event.key === 'Enter') void sendDigits(); }} aria-label="要输入的数字" />
        <button type="button" className="btn xs" disabled={disabled || sending || !digits} onClick={() => void sendDigits()}>发送数字</button>
        <span className="accounts-dim">仅发送数字，不保存验证码</span>
      </div>
    </div>
  );
}
