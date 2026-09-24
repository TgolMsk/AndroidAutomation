import { useState } from 'react';
import type { InstanceState } from '@avdm/core';
import type { SchedulerQueueState } from '../../../shared/ipc';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Icon } from '../../components/Icon';
import { SemanticTag, type SemanticTone } from '../../components/SemanticTag';
import { Spinner } from '../../components/StatusBadge';
import { InstanceDiagnosticsBadge } from './InstanceDiagnosticsBadge';
import { resumeMessage } from './InstanceMarchCard';
import type { ConfigSwitchState } from './config-model';
import type { GatherPauseInfo } from './pause-port';
import { formatAgo, formatClock } from './present';
import { GatherSwitch, QueueBadge } from './widgets';

export interface StatusLine {
  text: string;
  tone: SemanticTone | null;
  /** Hover explanation. */
  tip: string | null;
}

/**
 * The second line of the 自动采集 cell, highest priority first (original describeStatus, verbatim): paused > sampling >
 * finishing a device operation > last sample failed > next wake > last sample > never sampled. Pure.
 */
export function describeGatherStatus(state: SchedulerQueueState, pause: GatherPauseInfo, sampling: boolean, now: number): StatusLine {
  if (pause.paused) return { text: `已暂停 · ${pause.title || '已暂停'}`, tone: 'danger', tip: '点旁边的角标查看暂停原因与处置建议。' };
  if (sampling || state.sampling) return { text: '正在读「部队管理」面板…', tone: 'info', tip: null };
  if (!state.auto && state.operating) return { text: '设备操作收尾中', tone: 'warning', tip: '自动采集已关闭，正在等最后一次设备操作结束。' };
  const sampled = state.lastSampledAt > 0;
  // ★ No `sampled` precondition: an instance that never sampled successfully keeps lastSampledAt 0, and with it this
  //   line would say 「未采样」 — calling "failing over and over" "not started yet".
  if (!state.lastSampleOk && state.error) {
    return { text: sampled ? `上次采样失败（${formatAgo(now - state.lastSampledAt)}）` : '一直没能采样成功', tone: 'danger', tip: '点旁边的角标查看完整错误原因。' };
  }
  if (state.auto && state.nextWakeAt != null) {
    return {
      text: `下次唤醒 ${formatClock(state.nextWakeAt)}`, tone: null,
      tip: (state.nextWakeReason ?? '已排定唤醒') + (state.backoffStep > 0 ? `（已退避 ${state.backoffStep} 次）` : '') + '（北京时间）',
    };
  }
  if (sampled) return { text: `上次采样 ${formatAgo(now - state.lastSampledAt)}`, tone: null, tip: null };
  return { text: '未采样', tone: null, tip: '还没读过这个实例的「部队管理」面板。' };
}

/** Why 采样 is disabled, or null when it can run. Pure (the same reason the tooltip shows). */
export function sampleBlockedReason(status: string, sampling: boolean, operating: boolean): string | null {
  if (status === 'starting' || status === 'booting') return '实例正在启动，等 Android 启动完成后才能采样。';
  if (status === 'stopping') return '实例正在关机，无法采样。';
  if (status === 'error') return '实例处于错误状态，请先重启实例再采样。';
  if (status !== 'running') return '实例未开机，无法采样。';
  if (sampling) return '正在读「部队管理」面板，等这次采样完成再点。';
  if (operating) return '这个实例正在进行设备操作（派兵或收尾），等它结束再采样。';
  return null;
}

export interface InstanceGatherControlsProps {
  instance: InstanceState;
  state: SchedulerQueueState;
  pause: GatherPauseInfo;
  /** Coarse clock (the table ticks every 10 s). */
  now: number;
  sampling: boolean;
  toggling: boolean;
  resuming: boolean;
  /** The config master switch (「启用自动采集」): nothing is said while it loads; an unreadable copy says so. */
  config: ConfigSwitchState;
  /** The config badge sentence (why it is unreadable), for the 「配置读不出」 tag. */
  configTip?: string;
  hasAccount: boolean;
  isBase: boolean;
  onToggleAuto(index: number, enabled: boolean): void;
  onSample(index: number): void;
  onResume(index: number): Promise<void>;
  onOpenConfig(index: number): void;
  onOpenAccounts(): void;
}

/**
 * The instance table's 自动采集 cell (original InstanceGatherControls): switch + 「已开启/未开启」 + queue N/M + 采样 on
 * the first line; the status line, the diagnostics badge (with row reasons, since the table has no march rows),
 * 恢复, and the 「配置未启用」 / 「未绑定账号」 hints on the second. Same switch and same calls as the overview cards.
 */
export function InstanceGatherControls(props: InstanceGatherControlsProps) {
  const { instance, state, pause, now, sampling, toggling, resuming, config, configTip, hasAccount, isBase } = props;
  const [confirmResume, setConfirmResume] = useState(false);
  const index = instance.record.index;
  const paused = pause.paused;
  const up = instance.status === 'running' || instance.status === 'starting' || instance.status === 'booting';
  const running = instance.status === 'running';
  const busySampling = sampling || state.sampling;
  // A base instance is refused by the main process, but one that is already on can still be switched off.
  const switchLocked = paused || (isBase && !state.auto) || (!state.auto && !running);
  const switchTip = paused
    ? '这个实例被异常暂停了，自动调度已经关掉。请用旁边的「恢复」按钮重新开启 —— 那条路会同时清掉暂停记录，直接扳开关不会。'
    : isBase && !state.auto ? '基础实例只用于克隆，不参与自动采集。请在克隆出来的副本上开启。'
      : !state.auto && !running ? (up ? '实例正在启动，等 Android 启动完成后再开启自动采集。' : '实例未开机，先启动实例再开启自动采集。')
        : state.auto ? '关闭后只保留倒计时展示，不再主动操作这个模拟器（与「采集总览」页的「自动调度」是同一个开关）。'
          : '开启前先做一次只读探测并确认，之后先读一次「部队管理」面板，队列释放时自动唤醒去派下一轮采集队（与「采集总览」页的「自动调度」是同一个开关）。';
  // ★ One predicate for both the disabled state and its reason (a disabled button always says why).
  const sampleBlocked = sampleBlockedReason(instance.status, busySampling, state.operating === true);
  const sampleTip = sampleBlocked
    ?? (paused ? '注意：这个实例已被异常暂停，但「采样」仍然会真的去操作模拟器读一次面板。游戏若还停在异常界面，这次多半也会失败。'
      : '真的去开一次「部队管理」面板读当前队列状态，不派兵。一次采样十几张截图、几秒钟，请不要连点。');
  const status = describeGatherStatus(state, pause, sampling, now);

  return (
    <div className="gather-cell">
      <div className="gather-inline">
        <GatherSwitch checked={state.auto} busy={toggling} disabled={switchLocked} size="sm" label={`实例 ${index} 自动采集开关`} title={switchTip}
          onChange={(next) => props.onToggleAuto(index, next)} />
        <span className="gather-label">{state.auto ? '已开启' : '未开启'}</span>
        <QueueBadge state={state} />
        <button type="button" className="btn xs" title={sampleTip} disabled={sampleBlocked !== null}
          onClick={() => props.onSample(index)}>
          {busySampling ? <Spinner size={11} /> : <Icon name="refresh" size={12} />}采样
        </button>
      </div>
      <div className="gather-inline">
        {status.tone ? <SemanticTag tone={status.tone} title={status.tip ?? undefined}>{status.text}</SemanticTag>
          : <span className="gather-micro" title={status.tip ?? undefined}>{status.text}</span>}
        <InstanceDiagnosticsBadge index={index} name={instance.record.name} state={state} pause={pause} rowReasons />
        {paused && (
          <button type="button" className="btn xs primary" disabled={resuming} onClick={() => setConfirmResume(true)}>
            {resuming ? <Spinner size={11} /> : <Icon name="play" size={12} />}恢复
          </button>
        )}
        {!paused && !hasAccount && !isBase && (
          <SemanticTag tone="neutral" onClick={props.onOpenAccounts}
            title="这个实例还没绑账号：采集配置存在实例自己的设置里（换实例不会跟着走），脚本计划也用不了它。请在本行「绑定账号」列直接选一个账号（也可以新建）；点这里去「账号管理」页做更完整的设置。">
            未绑定账号
          </SemanticTag>
        )}
        {!paused && config === 'unreadable' && (
          <SemanticTag tone="danger" onClick={() => props.onOpenConfig(index)}
            title={configTip ?? '这个实例的采集配置读不出来，采集在修好之前不会开跑。点击就地展开采集配置，核对后点「保存」即可修复。'}>
            配置读不出
          </SemanticTag>
        )}
        {!paused && config === 'off' && (hasAccount || state.auto) && (
          <SemanticTag tone="warning" onClick={() => props.onOpenConfig(index)}
            title="这个实例的采集配置里「启用自动采集」是关的：开了自动采集也只会定时读面板，不会派兵。点击就地展开采集配置，打开总开关并保存。">
            配置未启用
          </SemanticTag>
        )}
      </div>
      {confirmResume && (
        <ConfirmDialog title="确认已经处理好现场了吗？" confirmLabel="确认恢复" message={resumeMessage(index, instance.record.name)}
          onClose={() => setConfirmResume(false)} onConfirm={() => props.onResume(index)} />
      )}
    </div>
  );
}
