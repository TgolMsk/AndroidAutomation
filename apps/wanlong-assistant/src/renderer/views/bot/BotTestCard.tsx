/**
 * Settings → 「Telegram 机器人 · 在助手内测试动作」 (original `features/bot/BotTestCard.tsx`), mounted as the `bot`
 * entry of the settings card registry.
 *
 * Runs `botPerform`, the same `BotActionPort` a phone button runs, so what works here works on the phone. Shown like
 * the channel sends it: the photo first (caption under it), then the text, then the inline buttons, which run again
 * through `parseCallbackData` when clicked.
 * ★ Screenshot / resources / relaunch take the instance lock and confirm first; pause / resume confirm too. A script or
 *   login holding the instance refuses them in Chinese, shown as is.
 * ★ The local tester is not gated by the phone switches (they guard remote access); each action says what the phone
 *   would still need. No token reaches this card (`BotActionResult` carries no settings).
 */
import { useEffect, useState } from 'react';
import {
  BOT_ACTIONS, BOT_ACTION_SPECS, parseCallbackData, type BotAction, type BotActionResult, type BotInstanceRef, type BotStatusView,
} from '../../../shared/bot';
import { avdm, errMsg } from '../../api';
import { Card } from '../../components/Card';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Icon } from '../../components/Icon';
import { SemanticTag } from '../../components/SemanticTag';
import { Spinner } from '../../components/StatusBadge';
import { useToast } from '../../components/Toasts';
import { useAvdmEvent } from '../../hooks/useAvdmEvent';
import type { SettingsCardProps } from '../settings/cards';
import {
  QUICK_ACTIONS, actionOptionLabel, botStatusText, confirmOf, instanceLabel, keepSelection, phoneHint, photoMeta, resultEmpty,
  resultHeader, runIndex,
} from './bot-tester';
import './BotTestCard.css';

interface LastRun {
  action: BotAction;
  index: number | null;
  at: number;
  result: BotActionResult;
}

/** Screenshot on screen: bytes → blob URL, revoked when the picture changes or the card unmounts. */
function useObjectUrl(bytes: Uint8Array | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!bytes) { setUrl(null); return; }
    const next = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }));
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [bytes]);
  return url;
}

export function BotTestCard({ visible }: SettingsCardProps) {
  const toast = useToast();
  const [action, setAction] = useState<BotAction>('accounts');
  const [index, setIndex] = useState<number | null>(null);
  const [instances, setInstances] = useState<BotInstanceRef[]>([]);
  const [instancesError, setInstancesError] = useState<string | null>(null);
  const [status, setStatus] = useState<BotStatusView | null>(null);
  const [running, setRunning] = useState<BotAction | null>(null);
  const [last, setLast] = useState<LastRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ action: BotAction; index: number | null } | null>(null);
  const photoUrl = useObjectUrl(last?.result.photo?.jpeg);

  async function loadInstances(): Promise<void> {
    try {
      const list = await avdm.botInstances();
      setInstances(list);
      setInstancesError(null);
      setIndex((current) => keepSelection(current, list));
    } catch (cause) {
      setInstancesError(errMsg(cause));
    }
  }

  useEffect(() => {
    if (!visible) return;
    void loadInstances();
    let active = true;
    avdm.botStatus().then((next) => { if (active) setStatus(next); }, () => undefined);
    return () => { active = false; };
  }, [visible]);
  useAvdmEvent('bot-status', (next) => setStatus(next));

  const spec = BOT_ACTION_SPECS[action];

  /** Run once. The instance follows the action's need (none → null, optional → the selection or every instance). */
  async function run(nextAction: BotAction, selected: number | null): Promise<void> {
    const { index: sent, blocked } = runIndex(nextAction, selected);
    if (blocked) { toast.push({ kind: 'warn', title: blocked }); return; }
    if (running) { toast.push({ kind: 'warn', title: '上一个动作还没跑完，等它结束再点。' }); return; }
    setRunning(nextAction);
    setError(null);
    try {
      const result = await avdm.botPerform(nextAction, sent);
      setLast({ action: nextAction, index: sent, at: Date.now(), result });
    } catch (cause) {
      const message = errMsg(cause);
      setError(message);
      toast.error(`机器人动作「${BOT_ACTION_SPECS[nextAction].description}」失败`, message);
    } finally {
      setRunning(null);
    }
  }

  /** Confirm first where the phone would change something; otherwise run at once. */
  function request(nextAction: BotAction, selected: number | null): void {
    const { index: sent, blocked } = runIndex(nextAction, selected);
    if (blocked) { toast.push({ kind: 'warn', title: blocked }); return; }
    if (confirmOf(nextAction, sent)) setConfirm({ action: nextAction, index: sent });
    else void run(nextAction, selected);
  }

  function runCallback(data: string): void {
    const parsed = parseCallbackData(data);
    if (!parsed) { toast.push({ kind: 'error', title: `看不懂这个按钮的回调数据：${data}` }); return; }
    setAction(parsed.action);
    if (parsed.instanceIndex !== null) setIndex(parsed.instanceIndex);
    request(parsed.action, parsed.instanceIndex ?? (BOT_ACTION_SPECS[parsed.action].instance === 'required' ? index : null));
  }

  const state = status ? botStatusText(status) : null;
  const hint = status ? phoneHint(action, status) : null;
  const pending = confirm ? confirmOf(confirm.action, confirm.index) : null;

  return (
    <Card
      title="Telegram 机器人 · 在助手内测试动作" icon="terminal"
      extra={<button type="button" className="btn sm" aria-label="重新拉取可选实例" onClick={() => void loadInstances()}><Icon name="refresh" size={14} />刷新实例</button>}
    >
      <div className="bot-card">
        <p className="bot-note">
          走的是机器人真正会跑的那条路（与手机上点按钮是同一个动作执行器），这里通了手机上就通。文本原样显示，截图显示缩略图，内联按钮可以直接点。
          在助手里测试不受手机开关限制；机器人的开关、Chat ID 与授权用户 ID 在上面「通知与推送」卡片的「手机机器人」一节。
        </p>
        {state && (
          <p className="bot-state" role="status" aria-live="polite">
            <SemanticTag tone={state.tone}>机器人{state.label}</SemanticTag>
            <span>{state.detail}</span>
          </p>
        )}
        {instancesError && <p className="notice warn" role="alert">可选实例列表没能拉到：{instancesError}</p>}

        <div className="bot-quick" role="group" aria-label="快捷动作">
          {QUICK_ACTIONS.map((quick) => (
            <button
              key={quick.action} type="button" className="btn sm"
              disabled={running !== null || (BOT_ACTION_SPECS[quick.action].instance === 'required' && index === null)}
              onClick={() => { setAction(quick.action); request(quick.action, index); }}
            >
              {running === quick.action && <Spinner size={12} />}{quick.label}
            </button>
          ))}
        </div>

        <div className="bot-form">
          <label className="bot-field">
            <span>动作</span>
            <select value={action} onChange={(event) => setAction(event.target.value as BotAction)}>
              {BOT_ACTIONS.map((item) => <option key={item} value={item}>{actionOptionLabel(item)}</option>)}
            </select>
          </label>
          <label className="bot-field">
            <span>实例</span>
            <select
              value={spec.instance === 'none' || index === null ? '' : String(index)} disabled={spec.instance === 'none'}
              onChange={(event) => setIndex(event.target.value === '' ? null : Number(event.target.value))}
            >
              {spec.instance === 'none' && <option value="">此动作不需要实例</option>}
              {spec.instance === 'optional' && <option value="">全部实例</option>}
              {spec.instance === 'required' && index === null && <option value="" disabled>选择实例</option>}
              {instances.map((item) => <option key={item.index} value={item.index}>{instanceLabel(item)}</option>)}
            </select>
          </label>
          <button
            type="button" className="btn sm primary" disabled={running !== null || (spec.instance === 'required' && index === null)}
            onClick={() => request(action, index)}
          >
            {running === action ? <Spinner size={12} /> : <Icon name="play" size={14} />}执行
          </button>
          <span className="bot-tags">
            {spec.touchesDevice && <SemanticTag tone="warning">会操作模拟器</SemanticTag>}
            {spec.instance === 'optional' && <span className="bot-muted">不选实例 = 全部实例</span>}
            {hint && <span className="bot-muted">{hint}</span>}
          </span>
        </div>
        {spec.instance === 'required' && instances.length === 0 && !instancesError && (
          <p className="bot-muted">还没有可操作的实例：先在「设备与账号」页创建实例并绑定账号。</p>
        )}

        {error && <p className="bot-error" role="alert">操作失败：{error}</p>}

        {last && (
          <section className="bot-result" aria-label="机器人回复" aria-live="polite">
            <header className="bot-result-head">
              <span className="mono">{resultHeader(last.action, last.index, last.at)}</span>
              {last.result.showMenu && <SemanticTag tone="info">会附带菜单键盘</SemanticTag>}
            </header>
            {last.result.photo && (
              <figure className="bot-photo">
                {photoUrl ? <img className="bot-photo-img" src={photoUrl} alt="机器人截图" /> : <span className="bot-muted">图片解码中…</span>}
                <figcaption>
                  <pre className="bot-caption">{last.result.photo.caption}</pre>
                  <span className="bot-muted">{photoMeta(last.result.photo)}</span>
                </figcaption>
              </figure>
            )}
            {last.result.text.trim() !== '' && <pre className="bot-text">{last.result.text}</pre>}
            {last.result.keyboard && last.result.keyboard.inline_keyboard.length > 0 && (
              <div className="bot-keyboard" role="group" aria-label="内联按钮">
                {last.result.keyboard.inline_keyboard.map((row, rowIndex) => (
                  <div className="bot-keyboard-row" key={rowIndex}>
                    {row.map((button) => (
                      <button key={button.callback_data} type="button" className="btn sm" disabled={running !== null} onClick={() => runCallback(button.callback_data)}>
                        {button.text}
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            )}
            {resultEmpty(last.result) && <span className="bot-muted">这个动作没有返回任何内容。</span>}
          </section>
        )}
      </div>
      {confirm && pending && (
        <ConfirmDialog
          title={pending.title} confirmLabel="执行" message={pending.message}
          onConfirm={() => { void run(confirm.action, confirm.index); }}
          onClose={() => setConfirm(null)}
        />
      )}
    </Card>
  );
}
