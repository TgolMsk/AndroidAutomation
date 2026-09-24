/**
 * Status tags. Every one-word status in the assistant (run, instance, health …) uses the same pill and the same
 * semantic palette, so no page invents its own colours. The Chinese run labels are the original panel's and are
 * shared by gather runs, script runs and the monitor: do not change a single character.
 */
import type { ReactNode } from 'react';
import { displayStatusLabel, type DisplayStatus } from '@avdm/emulator-shell/renderer/format';
import './ui.css';

/** Semantic colour keys (success = green, warning = amber, danger = red, info / accent = blue, neutral = grey). */
export type SemanticTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'accent';

export interface StatusText {
  label: string;
  tone: SemanticTone;
}

/**
 * Run states: the original RunStatus set (pending … aborted) plus the target's names for the same states
 * (`queued` = pending, `cancelled` = a user stop = aborted) and `skipped` for plan runs that could not wait.
 */
export const RUN_STATUS_TEXT: Readonly<Record<string, StatusText>> = {
  pending: { label: '排队中', tone: 'neutral' },
  queued: { label: '排队中', tone: 'neutral' },
  starting: { label: '启动中', tone: 'info' },
  running: { label: '执行中', tone: 'accent' },
  paused: { label: '已暂停', tone: 'warning' },
  stopping: { label: '停止中', tone: 'warning' },
  succeeded: { label: '已完成', tone: 'success' },
  failed: { label: '失败', tone: 'danger' },
  aborted: { label: '已中止', tone: 'danger' },
  cancelled: { label: '已中止', tone: 'danger' },
  skipped: { label: '已跳过', tone: 'neutral' },
};

/** Instance states keep the shell's labels (AVD states differ from the original MuMu ones); only the tone is added. */
export const INSTANCE_STATUS_TONE: Readonly<Record<DisplayStatus, SemanticTone>> = {
  running: 'success',
  starting: 'info',
  booting: 'info',
  provisioning: 'info',
  stopping: 'warning',
  stopped: 'neutral',
  error: 'danger',
};

export function runStatusText(status: string): StatusText {
  return RUN_STATUS_TEXT[status] ?? { label: status || '未知', tone: 'neutral' };
}

/** A pill tag. `onClick` turns it into a button (e.g. the health badge). */
export function SemanticTag({ tone = 'neutral', icon, children, title, onClick, ariaExpanded }: {
  tone?: SemanticTone;
  icon?: ReactNode;
  children: ReactNode;
  title?: string;
  onClick?: () => void;
  ariaExpanded?: boolean;
}) {
  const className = `wl-ui-tag is-${tone}`;
  if (onClick) {
    return <button type="button" className={className} title={title} onClick={onClick} aria-expanded={ariaExpanded}>{icon}{children}</button>;
  }
  return <span className={className} title={title}>{icon}{children}</span>;
}

export function RunStatusTag({ status }: { status: string }) {
  const text = runStatusText(status);
  return <SemanticTag tone={text.tone}>{text.label}</SemanticTag>;
}

/** Compact dot + label for tight places such as title bars. */
export function RunStatusDot({ status }: { status: string }) {
  const running = status === 'running' || status === 'starting';
  const bad = status === 'failed' || status === 'aborted' || status === 'cancelled';
  const tone = running ? 'is-running' : bad ? 'is-bad' : status === 'succeeded' ? 'is-good' : '';
  return <span className={`wl-ui-dot ${tone}`}>{runStatusText(status).label}</span>;
}

export function InstanceStateTag({ status }: { status: DisplayStatus }) {
  return <SemanticTag tone={INSTANCE_STATUS_TONE[status] ?? 'neutral'}>{displayStatusLabel(status)}</SemanticTag>;
}

export type StatusKind = 'instance' | 'run';

/** Generic entry: `<StatusTag kind="run" value={run.status} />`. */
export function StatusTag({ kind, value }: { kind: StatusKind; value: string }) {
  if (kind === 'run') return <RunStatusTag status={value} />;
  return <InstanceStateTag status={value as DisplayStatus} />;
}
