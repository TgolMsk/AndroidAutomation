/**
 * Update panel body: check → new version with notes → download (with progress) → open the installer and quit.
 * Ported from wanlong-panel `features/update/UpdatePanel.tsx`.
 *
 * One body for two places: the 「版本与更新」 settings card (full, with the footer) and the sidebar popover
 * (compact). Every decision is made in the main process (`src/main/update/`); this only lays out the state —
 * including "cannot install now": the disabled button is a hint, the main process is what refuses.
 */
import { useState } from 'react';
import { UNSUPPORTED_TEXT, UPDATE_PHASE_TEXT, UPDATE_REPOSITORY, formatBytes, formatSpeed, type UpdateState } from '../../../shared/update';
import { avdm } from '../../api';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Icon } from '../../components/Icon';
import { Spinner } from '../../components/StatusBadge';
import { useToast } from '../../components/Toasts';
import { beijingTime } from '../../format';
import { UPDATE_TONE, updateStore, useUpdateStore } from './update-store';
import './UpdatePanel.css';

/** Phase tag (tone from `UPDATE_TONE`, text from `UPDATE_PHASE_TEXT`). */
export function UpdatePhaseTag({ state }: { state: UpdateState }) {
  return <span className={`tag update-tag is-${UPDATE_TONE[state.phase]}`}>{UPDATE_PHASE_TEXT[state.phase]}</span>;
}

/** 「检查更新」. The card puts it in its header, the popover in its button row; the behaviour exists once. */
export function CheckUpdateButton({ size = 'sm' }: { size?: 'sm' | 'xs' }) {
  const { state, busy } = useUpdateStore();
  const toast = useToast();
  const downloading = state?.phase === 'downloading';
  // The download call stays in flight (busy) until it finishes; that is not a check.
  const checking = state?.phase === 'checking' || (busy && !downloading);
  return (
    <button
      type="button" className={`btn ${size}`} disabled={checking || downloading}
      title={state?.phase === 'downloading' ? '正在下载，完成或取消后再检查' : undefined}
      onClick={() => void updateStore.run(() => avdm.updateCheck(), (error) => toast.error('检查更新失败', error))}
    >
      {checking ? <Spinner size={12} /> : <Icon name="refresh" size={14} />}检查更新
    </button>
  );
}

/** The release notes are plain text (the Release body); React escapes it, nothing is rendered as HTML. */
function Notes({ text, compact }: { text: string; compact: boolean }) {
  return <pre className={`update-notes${compact ? ' is-compact' : ''}`} tabIndex={0} aria-label="更新说明">{text}</pre>;
}

export interface UpdatePanelProps {
  /** Compact form (sidebar popover): narrower, no long footer, 「检查更新」 joins the button row. */
  compact?: boolean;
}

export function UpdatePanel({ compact = false }: UpdatePanelProps) {
  const { state, busy, loadError } = useUpdateStore();
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);

  if (!state) {
    return loadError
      ? <p className="update-error" role="alert">读取更新状态失败：{loadError}</p>
      : <p className="update-muted"><Spinner size={12} /> 正在读取…</p>;
  }

  const progress = state.progress;
  const size = compact ? 'xs' : 'sm';
  const act = (label: string, action: () => Promise<UpdateState | void>) =>
    void updateStore.run(action, (error) => toast.error(`${label}失败`, error));
  // Not through run(): the download itself holds the busy flag until it ends, and these must still work meanwhile.
  const direct = (label: string, action: () => Promise<unknown>) => () => {
    action().catch((error: unknown) => toast.error(`${label}失败`, error));
  };
  const cancel = direct('取消下载', () => avdm.updateCancelDownload());
  const install = () => updateStore.run(async () => {
    await avdm.updateInstall();
    toast.push({
      kind: 'info', title: '安装包已打开，助手即将退出',
      detail: '在打开的窗口里把「万龙助手」拖到「应用程序」并选择替换，然后重新打开助手。', duration: 12_000,
    });
  }, (error) => toast.error('无法安装更新', error));

  return (
    <div className={`update-panel${compact ? ' is-compact' : ''}`}>
      <div className="update-meta">
        <span>当前版本 <b className="mono">v{state.currentVersion}</b></span>
        {state.latestVersion && <span>
          最新版本 <b className="mono">v{state.latestVersion}</b>{state.prerelease && <span className="tag">预览版</span>}
        </span>}
        {state.publishedAt && !compact && <span>发布于 {beijingTime(state.publishedAt, 'minute')}</span>}
        {state.checkedAt && <span>上次检查 {beijingTime(state.checkedAt, 'minute')}</span>}
      </div>

      {state.phase === 'unsupported' && state.unsupportedReason && <div className="notice info update-notice">
        <Icon name="info" size={15} />
        <div><strong>{UNSUPPORTED_TEXT[state.unsupportedReason].title}</strong><p>{UNSUPPORTED_TEXT[state.unsupportedReason].detail}</p></div>
      </div>}

      {state.phase === 'error' && state.error && <div className="notice bad update-notice" role="alert">
        <Icon name="alert" size={15} />
        <div><strong>检查失败</strong><p>{state.error}</p></div>
      </div>}

      {state.phase === 'available' && <div className="notice warn update-notice">
        <Icon name="download" size={15} />
        <div className="update-notice-body">
          <strong>有新版本 v{state.latestVersion}{state.assetSize ? `（${formatBytes(state.assetSize)}）` : ''}</strong>
          {state.error && <p className="update-error" role="alert">上次下载没成功：{state.error}</p>}
          {state.releaseNotes
            ? <Notes text={state.releaseNotes} compact={compact} />
            : <p>点「下载更新」开始下载，下完再决定什么时候安装。</p>}
        </div>
      </div>}

      {state.phase === 'downloading' && <div className="update-progress" aria-live="polite">
        <progress max={100} value={progress?.percent ?? 0} aria-label="下载进度">{progress?.percent ?? 0}%</progress>
        <span className="update-muted">
          {progress
            ? `${progress.percent}% · ${formatBytes(progress.transferred)} / ${formatBytes(progress.total)} · ${formatSpeed(progress.bytesPerSecond)}`
            : '正在开始…'}
          {' · 中断后再点「下载更新」会从断点继续'}
        </span>
      </div>}

      {state.phase === 'downloaded' && <div className={`notice ${state.installable ? 'info' : 'warn'} update-notice`}>
        <Icon name={state.installable ? 'check' : 'alert'} size={15} />
        <div>
          <strong>v{state.latestVersion} 已下载并校验通过</strong>
          <p>{state.installable
            ? '点「退出并打开安装包」：助手退出后，在打开的窗口里把「万龙助手」拖到「应用程序」替换旧版，再重新打开即可。账号、模板与统计（~/.avdm）不受影响，开着的自动续跑会按原设置恢复。'
            : `${state.busyReason ?? ''}安装要先退出助手，等它结束、或先手动停掉再装。`}</p>
          {state.downloadedFile && !compact && <p className="update-file mono" title={state.downloadedFile}>{state.downloadedFile}</p>}
        </div>
      </div>}

      <div className="update-actions">
        {compact && <CheckUpdateButton size="xs" />}
        {state.phase === 'available' && <button type="button" className={`btn ${size} primary`} disabled={busy} onClick={() => act('下载更新', () => avdm.updateDownload())}>
          {busy ? <Spinner size={12} /> : <Icon name="download" size={14} />}下载更新
        </button>}
        {state.phase === 'downloading' && <button type="button" className={`btn ${size}`} onClick={cancel}>
          <Icon name="close" size={14} />取消下载
        </button>}
        {state.phase === 'downloaded' && <>
          <button
            type="button" className={`btn ${size} primary`} disabled={busy || !state.installable}
            title={state.installable ? '退出助手 → 打开安装包 → 拖入「应用程序」替换' : state.busyReason ?? undefined}
            onClick={() => setConfirming(true)}
          >
            <Icon name="rocket" size={14} />退出并打开安装包
          </button>
          <button type="button" className={`btn ${size}`} onClick={direct('在访达中显示', () => avdm.updateRevealDownload())}>
            <Icon name="folder" size={14} />在访达中显示
          </button>
        </>}
        <button type="button" className="link-btn update-link" onClick={direct('打开 Release 页面', () => avdm.updateOpenReleasePage())}>
          打开 Release 页面<Icon name="external" size={12} />
        </button>
      </div>

      {!compact && <p className="update-footnote">
        更新来自 GitHub 公开仓库 {UPDATE_REPOSITORY} 的发布页（含预览版），检查不需要登录，下载后按发布页的 SHA256SUMS 校验。
        下载和安装都要你点——助手不会自己重启，免得把正在跑的挂机任务掐断。安装包没有 Apple 开发者签名，无法像其他应用那样自己替换，需要你拖一次。
      </p>}
      {compact && state.phase !== 'unsupported' && <p className="update-footnote">{UPDATE_PHASE_TEXT[state.phase]} · 助手不会自己重启，装不装由你点。</p>}

      {confirming && <ConfirmDialog
        title="退出并打开安装包？"
        message={<>
          <p>助手会打开 v{state.latestVersion} 的安装包并退出。在打开的窗口里把「万龙助手」拖到「应用程序」，选择「替换」，再重新打开助手即可。</p>
          <p>模拟器实例会继续运行；已开启的自动续跑在重新打开助手后按原设置恢复。</p>
        </>}
        confirmLabel="退出并打开安装包"
        onConfirm={install}
        onClose={() => setConfirming(false)}
      />}
    </div>
  );
}
