import { useId, useState, type ReactNode } from 'react';
import type { GatherResourceType, InstanceQueueState } from '@avdm/automation/wanlong/pure';
import { freeQueueSlots } from '@avdm/automation/wanlong/pure';
import { Spinner } from '../../components/StatusBadge';
import { GATHER_RESOURCE_META } from './resources';
import './gather.css';

/** On/off switch (`role="switch"`), the target's replacement of antd Switch. `title` explains a disabled state. */
export function GatherSwitch({ checked, onChange, disabled = false, busy = false, label, title, size = 'md' }: {
  checked: boolean;
  onChange(next: boolean): void;
  disabled?: boolean;
  busy?: boolean;
  /** Accessible name. */
  label: string;
  title?: string;
  size?: 'sm' | 'md';
}) {
  return (
    <span className="gather-switch-hit" title={title}>
      <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled || busy}
        className={`gather-switch${size === 'sm' ? ' is-sm' : ''}`} onClick={() => onChange(!checked)}>
        {busy ? <Spinner size={12} /> : <span />}
      </button>
    </span>
  );
}

/**
 * The 「!」 hint of a row (original antd Tooltip with hover + click, max 440 px): a focusable button whose text shows
 * on hover, keyboard focus or click, announced through `aria-describedby`.
 */
export function HintBubble({ text, level, label = '查看说明' }: { text: string; level: 'error' | 'warning'; label?: string }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <span className="gather-hint-wrap">
      <button type="button" className={`gather-row-hint is-${level}`} aria-label={label} aria-describedby={id}
        aria-expanded={open} onClick={() => setOpen((value) => !value)} onBlur={() => setOpen(false)}>!</button>
      <span id={id} role="tooltip" className={`gather-hint-pop${open ? ' is-open' : ''}`}>{text}</span>
    </span>
  );
}

/**
 * Resource badge: a glyph on the resource's token colour (original ResourceBadge's text fallback — the game art is
 * never committed). Shared by march rows and the config form.
 */
export function ResourceBadge({ type, size = 26, title }: { type: GatherResourceType; size?: number; title?: string }) {
  const meta = GATHER_RESOURCE_META[type];
  return (
    <span className="gather-res" role="img" aria-label={meta.resource} title={title ?? meta.resource}
      style={{ width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.5)), background: meta.colorVar }}>
      {meta.glyph}
    </span>
  );
}

/** Unknown resource: 「?」 with the reason why it is unknown. */
export function UnknownResourceBadge({ size = 26 }: { size?: number }) {
  return (
    <span className="gather-res is-unknown" role="img" aria-label="资源类型未知" style={{ width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.5)) }}
      title="资源类型未知：采集中的行按左侧资源点缩略图自动识别（木材/金币/魔水已有模板，铁矿石待补）；行军中/返回中的行缩略图是部队图，认不出，只有面板自己派的队才能按坐标从派兵记录里查到。">?</span>
  );
}

/**
 * Queue badge: the troop panel's N/M (e.g. 4/5). Unknown shows 「?/?」 — never 0 or infinity. Shared by the card
 * header and the instance table's 自动采集 column.
 */
export function QueueBadge({ state }: { state: Pick<InstanceQueueState, 'queueUsed' | 'queueTotal'> }) {
  const free = freeQueueSlots(state);
  if (state.queueUsed == null || state.queueTotal == null || free == null) {
    return (
      <span className="gather-queue" title="队列占用未能识别。派兵的硬前置之一就是「队列有空位」，读不出来时调度会保守地不派兵，绝不当成 0 或无限。">
        <span className="gather-queue-used">?</span><span className="gather-queue-total">/?</span>
      </span>
    );
  }
  return (
    <span className={`gather-queue ${free === 0 ? 'is-full' : 'is-free'}`}
      title={free === 0
        ? `行军队列已满（${state.queueUsed}/${state.queueTotal}）。必须等队伍回城释放队列才能再派。`
        : `行军队列 ${state.queueUsed}/${state.queueTotal}，还有 ${free} 个空位可以派兵。`}>
      <span className="gather-queue-used">{state.queueUsed}</span><span className="gather-queue-total">/{state.queueTotal}</span>
    </span>
  );
}

/** A count pill on a button (original antd Badge): a number, or a dot when `dot`. */
export function CountPill({ count, tone = 'warning', dot = false }: { count?: number; tone?: 'warning' | 'danger'; dot?: boolean }): ReactNode {
  if (dot) return <span className={`gather-pill is-dot is-${tone}`} aria-hidden="true" />;
  if (!count) return null;
  return <span className={`gather-pill is-${tone}`}>{count}</span>;
}
