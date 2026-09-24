import { memo } from 'react';
import { MARCH_STATUS_TEXT, type MarchState } from '@avdm/automation/wanlong/pure';
import { formatClock, formatShort, presentMarch, type MarchTone } from './present';
import { GATHER_RESOURCE_META, readResourceType } from './resources';
import { HintBubble, ResourceBadge, UnknownResourceBadge } from './widgets';

/** Thin progress bar. `progress === null` draws the indeterminate stripes: a ratio is never invented. */
function MarchProgressBar({ progress, tone }: { progress: number | null; tone: MarchTone }) {
  if (progress === null) {
    return <div className="gather-bar" role="progressbar" aria-label="进度未知"><div className="gather-bar-indeterminate" /></div>;
  }
  const pct = Math.round(Math.min(1, Math.max(0, progress)) * 100);
  return (
    <div className="gather-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="队伍进度">
      <div className={`gather-bar-fill is-${tone}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export interface MarchRowProps {
  march: MarchState;
  /** The shared `useCountdownTick` time, so every row on screen shows the same second. */
  now: number;
  imminentMs: number;
  staleAfterMs: number;
}

/**
 * One march out (original MarchRow): resource badge + target + countdown bar. Re-renders every second, so it is
 * kept light: one pure computation (present.ts → the shared deriveMarchView), countdowns from the local clock only.
 */
function MarchRowInner({ march, now, imminentMs, staleAfterMs }: MarchRowProps) {
  const p = presentMarch(march, now, { imminentMs, staleAfterMs });
  const resource = readResourceType(march);
  const meta = resource ? GATHER_RESOURCE_META[resource] : null;
  const rowClass = [
    'gather-row',
    p.reasonLevel === 'error' && p.reason ? 'is-error' : '',
    p.imminent && p.tone === 'warning' ? 'is-imminent' : '',
    p.stale ? 'is-stale' : '',
  ].filter(Boolean).join(' ');
  // Only a real number gets the large monospace style; 「待校准」「倒计时不可用」 stay regular text.
  const timerIsNumber = p.view.remainingMs != null && p.view.remainingMs > 0;

  return (
    <div className={rowClass}>
      {meta && resource
        ? <ResourceBadge type={resource} size={28} title={`${meta.resource}（搜索面板分类「${meta.category}」）`} />
        : <UnknownResourceBadge size={28} />}

      <div className="gather-row-main">
        <div className="gather-row-line">
          <span className="gather-row-phase">{p.view.phase === 'unknown' ? MARCH_STATUS_TEXT[march.status] : p.view.phaseText}</span>
          <span className="mono gather-row-coord">{march.targetCoord ? `坐标 ${march.targetCoord}` : '坐标未识别'}</span>
          {march.troopCount != null && <span className="gather-row-badge">{march.troopCount.toLocaleString('zh-CN')} 兵</span>}
          {march.travelTimeSource === 'fallback' && march.status !== 'idle' && (
            <span className="gather-row-badge is-warn" title="单程行军耗时没有从「创建部队」页读到，用的是配置里的兜底估计，释放时刻只是估算值。">行军时长为估算</span>
          )}
          {march.travelTimeSource === 'unrecorded' && march.status !== 'idle' && (
            <span className="gather-row-badge" title="没有这支队的派兵记录（手动派出的，或记录已丢失）：行军耗时按配置兜底值估算，释放时刻只是估算值。采完回城后由面板接管派兵即可。">非面板派出</span>
          )}
          {p.stale && (
            <span className="gather-row-badge is-warn" title={`距上次读「部队管理」面板已超过校准间隔 ${formatShort(p.staleForMs)}，倒计时可能有漂移，等下一次校准纠正。`}>待校准</span>
          )}
          {p.reason && <HintBubble text={`第 ${march.slot} 行：${p.reason}`} level={p.reasonLevel} />}
        </div>
        <MarchProgressBar progress={p.view.progress} tone={p.tone} />
      </div>

      <div className="gather-row-timer">
        <div className={`gather-timer-text is-${p.tone}${timerIsNumber ? '' : ' is-plain'}`}>{p.text}</div>
        {p.freeAt != null && march.status !== 'idle' && (
          <span className="gather-micro" title={`队列预计在 ${formatClock(p.freeAt)}（北京时间）释放。调度器的唤醒时刻还会在此之上再加「唤醒冗余」，宁晚勿早。`}>
            释放 {formatClock(p.freeAt)}
          </span>
        )}
      </div>
    </div>
  );
}

/** Re-render only when the march object changes or `now` crosses a whole second (original comparator). */
export const MarchRow = memo(MarchRowInner, (a, b) => (
  a.march === b.march && Math.floor(a.now / 1000) === Math.floor(b.now / 1000) &&
  a.imminentMs === b.imminentMs && a.staleAfterMs === b.staleAfterMs
));
