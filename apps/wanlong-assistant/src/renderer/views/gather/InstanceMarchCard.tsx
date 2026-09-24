import { useState } from 'react';
import type { InstanceState } from '@avdm/core';
import type { InstancePauseState } from '../../../shared/alerts';
import type { SchedulerQueueState } from '../../../shared/ipc';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Icon } from '../../components/Icon';
import { SemanticTag } from '../../components/SemanticTag';
import { Spinner } from '../../components/StatusBadge';
import type { GatherConfigBadge } from './config-model';
import { InstanceDiagnosticsBadge } from './InstanceDiagnosticsBadge';
import { MarchRow } from './MarchRow';
import { describeScriptOccupancy, scriptHoldReason, type ScriptOccupancy } from './occupancy';
import { formatAgo, formatClock, formatShort } from './present';
import { CountPill, GatherSwitch, QueueBadge } from './widgets';

/** Online state of an AVD as the card shows it (the original's MuMu + adb states mapped onto AVD states). */
export function onlineState(instance: InstanceState | undefined): { dot: 'online' | 'busy' | 'error' | 'off'; text: string } {
  if (!instance) return { dot: 'off', text: '实例已删除' };
  if (instance.record.provisioning) return { dot: 'busy', text: '创建中' };
  switch (instance.status) {
    case 'running': return { dot: 'online', text: '在线' };
    case 'starting':
    case 'booting': return { dot: 'busy', text: '启动中' };
    case 'stopping': return { dot: 'busy', text: '停止中' };
    case 'error': return { dot: 'error', text: '模拟器异常' };
    default: return { dot: 'off', text: '未开机' };
  }
}

/** DOM id of an instance's card (the paused-instances strip scrolls to it). */
export function gatherCardId(index: number): string {
  return `gather-card-${index}`;
}

/** Resume confirmation text (original Popconfirm). */
export function resumeMessage(index: number, name: string): string {
  return `恢复会重新打开实例 #${index}（${name}）的自动调度，并立刻去读一次「部队管理」面板。如果游戏还停在异常界面（登录页 / 公告框），多半会马上再次暂停。`;
}

export interface InstanceMarchCardProps {
  index: number;
  name: string;
  instance: InstanceState | undefined;
  /** Bound account name, or a Chinese placeholder (未绑定账号 / 实例已替换). */
  accountLabel: string;
  state: SchedulerQueueState;
  now: number;
  imminentMs: number;
  staleAfterMs: number;
  sampling: boolean;
  toggling: boolean;
  resuming: boolean;
  /**
   * The alerts module's pause record of the instance. ★ The red frame is judged by `pause.paused`, never by `!auto`:
   * switching auto off by hand is normal and must not look alarming.
   */
  pause: InstancePauseState;
  /** Script runs holding or waiting for the instance (plans module): the pre-emption note and the refused actions. */
  script?: ScriptOccupancy | null;
  isBase: boolean;
  badge: GatherConfigBadge | null;
  onToggleAuto(index: number, enabled: boolean): void;
  onSample(index: number): void;
  onResume(index: number): Promise<void>;
  onOpenConfig(index: number): void;
  onOpenRun(index: number): void;
}

/**
 * One card per instance (original InstanceMarchCard): header with online dot, account, queue N/M and the diagnostics
 * badge; body with one row per march; footer with the auto switch, sample freshness, next wake and actions.
 * ★ Errors, reminders and pause reasons are not permanent strips: they are behind the badge. Only the red frame and
 *   the 「恢复」 button stay outside.
 */
export function InstanceMarchCard(props: InstanceMarchCardProps) {
  const { index, name, instance, accountLabel, state, now, imminentMs, staleAfterMs, sampling, toggling, resuming, pause, isBase, badge, script = null } = props;
  const [confirmResume, setConfirmResume] = useState(false);
  const paused = pause.paused;
  const online = onlineState(instance);
  const running = instance?.status === 'running';
  const rows = state.marches.filter((m) => m.status !== 'idle');
  const neverSampled = state.lastSampledAt === 0;
  const busySampling = sampling || state.sampling;
  const enableBlocked: string | null = state.auto ? null
    : isBase ? '基础实例只用于克隆，不参与自动采集。请在克隆出来的副本上开启。' : !running ? '实例未开机，先启动实例。' : null;
  const switchTitle = paused
    ? '这个实例被异常暂停了，自动调度已经关掉。请用旁边的「恢复」按钮重新开启 —— 那条路会同时清掉暂停记录，直接扳这个开关不会。暂停原因点卡头右上角的角标看。'
    : enableBlocked ?? '打开后，这个实例会在队列释放时自动被唤醒去派下一轮。关掉只保留倒计时展示，不会主动操作模拟器。';
  const scriptHold = scriptHoldReason(script);
  const occupancy = describeScriptOccupancy(script, state.auto);
  const sampleTitle = !running ? '实例未开机，无法采样。'
    : scriptHold ?? (paused ? '注意：这个实例已被异常暂停，但「立即采样」仍然会真的去操作模拟器读一次面板。游戏若还停在异常界面（登录页 / 公告框），这次采样多半也会失败。'
      : '真的去开一次「部队管理」面板读当前状态，不派兵。一次采样要十几张截图，请不要连点。');

  return (
    <section id={gatherCardId(index)} className={`gather-card${paused ? ' is-paused' : ''}`} aria-label={`实例 #${index} ${name}`}>
      <header className="gather-card-head">
        <span className={`gather-dot is-${online.dot}`} aria-hidden="true" />
        <div className="gather-card-title">
          <div className="gather-card-name">#{index} {name}</div>
          <div className="gather-card-sub"><span>{accountLabel}</span><span className="gather-micro">·</span><span className="gather-micro">{online.text}</span></div>
        </div>
        <QueueBadge state={state} />
        <InstanceDiagnosticsBadge index={index} name={name} state={state} pause={pause} imminentMs={imminentMs} staleAfterMs={staleAfterMs} />
      </header>

      <div className="gather-card-body">
        {!state.auto && state.operating && <div className="gather-micro" role="status">设备操作正在收尾，自动派遣已关闭。</div>}
        {occupancy && (
          <div className="gather-occupancy" role="status" title={occupancy.tip}>
            <SemanticTag tone={occupancy.tone}>{occupancy.text}</SemanticTag>
            {occupancy.note && <span className="gather-micro">{occupancy.note}</span>}
          </div>
        )}
        {rows.length > 0
          ? rows.map((m) => <MarchRow key={`${index}:${m.slot}`} march={m} now={now} imminentMs={imminentMs} staleAfterMs={staleAfterMs} />)
          : neverSampled ? (
            <div className="gather-empty"><div className="gather-empty-title">尚未采样</div><div className="gather-empty-desc">点击「立即采样」读取队伍进度，或开启自动调度。</div></div>
          ) : !state.error ? (
            <div className="gather-empty"><div className="gather-empty-title">当前没有在途队伍</div><div className="gather-empty-desc">队列空着。打开自动调度后，调度器会在下一次唤醒时派出队伍。</div></div>
          ) : null}
      </div>

      <footer className="gather-card-foot">
        <div className="gather-inline">
          <span className="gather-label" title={switchTitle}>自动调度</span>
          <GatherSwitch checked={state.auto} busy={toggling} disabled={paused || Boolean(enableBlocked)} label={`实例 #${index} 自动调度`}
            title={switchTitle} size="sm" onChange={(next) => props.onToggleAuto(index, next)} />
          <span className="gather-micro">
            {neverSampled ? '未采样' : state.lastSampleOk ? `上次读面板 ${formatAgo(now - state.lastSampledAt)}` : `上次采样失败（${formatAgo(now - state.lastSampledAt)}）`}
          </span>
          {state.nextWakeAt != null && (
            <span className="gather-micro" title={`${state.nextWakeReason ?? '已排定唤醒'}${state.backoffStep > 0 ? `（已退避 ${state.backoffStep} 次）` : ''}`}>
              下次唤醒 {formatClock(state.nextWakeAt)}{state.nextWakeAt > now ? `（${formatShort(state.nextWakeAt - now)} 后）` : ''}
            </span>
          )}
        </div>
        <div className="gather-inline">
          {paused && (
            <button type="button" className="btn xs primary" disabled={resuming} onClick={() => setConfirmResume(true)}>
              {resuming ? <Spinner size={12} /> : <Icon name="play" size={13} />}恢复
            </button>
          )}
          <button type="button" className="btn xs" title={sampleTitle} disabled={!running || busySampling || state.operating === true || scriptHold !== null}
            onClick={() => props.onSample(index)}>
            {busySampling ? <Spinner size={12} /> : <Icon name="refresh" size={13} />}立即采样
          </button>
          <button type="button" className="btn xs gather-pill-host" title={badge?.text ?? '就地展开这个实例的采集配置（改完要点保存）。'} onClick={() => props.onOpenConfig(index)}>
            <Icon name="settings" size={13} />配置{badge?.tone && <CountPill dot tone={badge.tone} />}
          </button>
          <button type="button" className="btn xs" title="模板集、只读探测、手动采集一轮与最近运行" onClick={() => props.onOpenRun(index)}>
            <Icon name="workflow" size={13} />运行
          </button>
        </div>
      </footer>

      {confirmResume && (
        <ConfirmDialog title="确认已经处理好现场了吗？" confirmLabel="确认恢复" message={resumeMessage(index, name)}
          onClose={() => setConfirmResume(false)} onConfirm={() => props.onResume(index)} />
      )}
    </section>
  );
}
