/**
 * 「这个实例已被异常暂停」 banner (original `features/alerts/PauseBanner.tsx`).
 *
 * Shown only when `pause.paused === true` — ★ never for `!auto` (the user switching auto off by hand is normal).
 * It says what happened (title + reason), when (Beijing time), what to do (the spec's advice), shows the scene
 * screenshot on demand and offers 「恢复」 after a confirmation. Colours come from design tokens only (alerts.css).
 */
import { useEffect, useState } from 'react';
import { ALERT_SEVERITY_TONE, alertSpec, type InstancePauseState } from '../../../shared/alerts';
import { avdm, errMsg } from '../../api';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/Modal';
import { Spinner } from '../../components/StatusBadge';
import { useToast } from '../../components/Toasts';
import { beijingTime } from '../../format';
import { resumePause, useAlerts, usePause } from '../../state/alerts';
import './alerts.css';

export interface PauseBannerProps {
  /** The instance to show; nothing renders while it is not paused. */
  index: number | null;
  instanceName?: string | null;
  /** Rounded and bordered as its own block (true) or flush inside a card. */
  standalone?: boolean;
  /** Hide 「恢复」 where the surrounding view offers it already. */
  showResume?: boolean;
}

/** The tone class of a pause (danger / warning / info), from the spec's severity. */
export function pauseTone(pause: Pick<InstancePauseState, 'severity'>): 'danger' | 'warning' | 'info' {
  return pause.severity ? ALERT_SEVERITY_TONE[pause.severity] : 'danger';
}

/** The meta line: Beijing pause time and the push outcome. */
export function pauseMeta(pause: InstancePauseState): string[] {
  const lines = [`暂停于 ${pause.pausedAt ? beijingTime(pause.pausedAt, 'full') : '--'}（北京时间）`];
  if (pause.notified === true) lines.push('已推送');
  else if (pause.notified === null) lines.push(pause.notifyError ? '推送未完成' : '未配置推送或正在推送');
  return lines;
}

/** Object-URL lifecycle of the screenshot preview (revoked on replace, close and unmount). */
export function useObjectUrl(): [string | null, (bytes: Uint8Array | null, type?: string) => void] {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  const set = (bytes: Uint8Array | null, type = 'image/jpeg') => {
    setUrl(bytes ? URL.createObjectURL(new Blob([Uint8Array.from(bytes)], { type })) : null);
  };
  return [url, set];
}

export function PauseBanner({ index, instanceName, standalone = true, showResume = true }: PauseBannerProps) {
  const pause = usePause(index);
  const { resuming } = useAlerts();
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [shotUrl, setShot] = useObjectUrl();
  const [shotLoading, setShotLoading] = useState(false);
  if (!pause?.paused) return null;

  const spec = pause.type ? alertSpec(pause.type) : null;
  const tone = pauseTone(pause);
  const who = instanceName ? `实例 #${pause.instanceIndex}（${instanceName}）` : `实例 #${pause.instanceIndex}`;
  const detail = Object.entries(pause.detail ?? {}).filter(([, value]) => value !== null && value !== '');
  const busy = resuming[pause.instanceIndex] === true;

  async function openShot(): Promise<void> {
    if (!pause?.shotPath || shotLoading) return;
    setShotLoading(true);
    try {
      const bytes = await avdm.alertScreenshot(pause.shotPath);
      setShot(bytes, pause.shotPath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg');
    } catch (error) {
      toast.error('读取现场截图失败', errMsg(error));
    } finally {
      setShotLoading(false);
    }
  }

  return (
    <div className={`alerts-banner is-${tone}${standalone ? ' is-standalone' : ''}`} role="alert">
      <div className="alerts-banner-head">
        <span className="alerts-banner-title"><Icon name="alert" size={16} />{spec?.title ?? '已暂停'}</span>
        <span className="alerts-banner-who">{who}{pause.accountName ? ` · ${pause.accountName}` : ''}</span>
        <span className="alerts-banner-note">自动调度已关闭，不会再排唤醒</span>
      </div>
      <details className="alerts-banner-details">
        <summary>查看暂停原因与诊断详情</summary>
        <p className="alerts-banner-reason">{pause.reason ?? '没有记录原因。'}</p>
        {detail.length > 0 && <div className="alerts-chips">{detail.map(([key, value]) => <span key={key} className="alerts-chip">{key}={String(value)}</span>)}</div>}
      </details>
      {pause.advice && <p className="alerts-banner-advice">处置：{pause.advice}</p>}
      <div className="alerts-banner-meta">{pauseMeta(pause).map((line) => <span key={line}>{line}</span>)}</div>
      {pause.notifyError && <p className="alerts-banner-notify-error">推送失败：{pause.notifyError}（暂停本身已经生效，推送失败不影响它）</p>}
      <div className="alerts-banner-actions">
        {showResume && (
          <button type="button" className="btn sm primary" onClick={() => setConfirming(true)} disabled={busy}>
            {busy ? <Spinner size={12} /> : <Icon name="play" size={14} />}恢复
          </button>
        )}
        {pause.shotPath
          ? <button type="button" className="btn sm" onClick={() => void openShot()} disabled={shotLoading} title={`留痕文件：${pause.shotPath}`}>
              {shotLoading ? <Spinner size={12} /> : <Icon name="camera" size={14} />}查看现场截图
            </button>
          : <span className="alerts-muted" title="留痕策略为「不留痕」，或者出事时截图本身也失败了。">无现场截图</span>}
      </div>
      {confirming && (
        <ConfirmDialog
          title="确认已经处理好现场了吗？"
          confirmLabel="确认恢复"
          message={<>恢复会重新打开 {who} 的自动调度，并立刻去读一次「部队管理」面板。如果游戏还停在异常界面（登录页 / 公告框），多半会马上再次暂停。</>}
          onConfirm={async () => {
            try {
              await resumePause(pause.instanceIndex);
              toast.push({ kind: 'success', title: `${who} 已恢复自动调度` });
            } catch (error) {
              toast.error('恢复失败', errMsg(error));
              throw error;
            }
          }}
          onClose={() => setConfirming(false)}
        />
      )}
      {shotUrl && (
        <Modal title={`${who} 暂停现场`} subtitle={`${pause.pausedAt ? beijingTime(pause.pausedAt, 'full') : '--'}（北京时间）`} onClose={() => setShot(null)} width={960}>
          <img className="alerts-shot" src={shotUrl} alt="暂停现场截图" />
        </Modal>
      )}
    </div>
  );
}

/**
 * The paused instances as clickable chips (「N 个实例已被暂停」); clicking one selects it. Renders nothing while none
 * is paused. For the gather overview and the instance list.
 */
export function PausedInstancesStrip({ onSelect, current }: { onSelect(index: number): void; current?: number | null }) {
  const { pauses } = useAlerts();
  const paused = Object.values(pauses).filter((pause) => pause.paused).sort((a, b) => a.instanceIndex - b.instanceIndex);
  if (paused.length === 0) return null;
  return (
    <div className="alerts-strip" role="status">
      <span className="alerts-strip-label"><Icon name="alert" size={14} />{paused.length} 个实例已被异常暂停</span>
      {paused.map((pause) => (
        <button
          key={pause.instanceIndex} type="button" className={`alerts-strip-chip${pause.instanceIndex === current ? ' is-current' : ''}`}
          title={pause.reason ?? ''} onClick={() => onSelect(pause.instanceIndex)}
        >
          #{pause.instanceIndex} {pause.type ? alertSpec(pause.type).title : '已暂停'}
        </button>
      ))}
    </div>
  );
}
