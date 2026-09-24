import { useEffect, useId, useRef, useState } from 'react';
import type { HealthItem, HealthReport } from '../../shared/ipc';
import { beijingTime } from '../format';
import { healthBadgeText, recheckAppHealth, useAppHealth } from '../hooks/useAppHealth';
import { Icon } from './Icon';
import { SemanticTag } from './SemanticTag';
import { Spinner } from './StatusBadge';
import './ui.css';

const GROUP_LABEL: Record<HealthItem['group'], string> = { environment: '模拟器与主机', assistant: '助手' };

function HealthItemRow({ item }: { item: HealthItem }) {
  return (
    <li className={`wl-ui-health-item is-${item.level}`}>
      <span className="wl-ui-health-mark" aria-hidden="true"><Icon name={item.level === 'ok' ? 'check' : 'alert'} size={14} /></span>
      <div>
        <div className="wl-ui-health-label">{item.label}<span className="wl-ui-sr-only">{item.level === 'ok' ? '（正常）' : item.level === 'warn' ? '（提醒）' : '（异常）'}</span></div>
        <p className="wl-ui-health-detail">{item.detail}</p>
        {item.hint && item.level !== 'ok' && <p className="wl-ui-health-hint">→ {item.hint}</p>}
      </div>
    </li>
  );
}

/** Report body: problems first within each group, then the time of the last check and 「重新自检」. */
export function HealthReportView({ report, checking, error, onRecheck }: {
  report: HealthReport | null;
  checking: boolean;
  error: string | null;
  onRecheck: () => void;
}) {
  const order = { fail: 0, warn: 1, ok: 2 } as const;
  const groups = (['environment', 'assistant'] as const).map((group) => ({
    group,
    items: (report?.items ?? []).filter((item) => item.group === group).sort((a, b) => order[a.level] - order[b.level]),
  })).filter((entry) => entry.items.length > 0);
  return (
    <div aria-live="polite">
      {error && <p className="wl-ui-empty" role="alert">自检失败：{error}</p>}
      {!report ? (
        <p className="wl-ui-empty">{checking ? '正在自检…' : '尚未拿到自检结果，启动后会自动检查一次'}</p>
      ) : groups.map(({ group, items }) => (
        <div key={group}>
          <div className="wl-ui-health-group">{GROUP_LABEL[group]}</div>
          <ul className="wl-ui-health-list">{items.map((item) => <HealthItemRow key={item.key} item={item} />)}</ul>
        </div>
      ))}
      <div className="wl-ui-health-foot">
        <span>最近自检：{report ? beijingTime(report.checkedAt, 'clock') : '—'}{report ? `（${(report.durationMs / 1000).toFixed(1)} 秒）` : ''}</span>
        <button type="button" className="btn xs" onClick={onRecheck} disabled={checking}>
          {checking ? <Spinner size={11} /> : <Icon name="refresh" size={13} />}重新自检
        </button>
      </div>
    </div>
  );
}

/**
 * Environment self-check badge (original HealthBadge): 「自检未完成 / 环境正常 / N 项异常」 in the top bar with a
 * popover listing every item and its fix; `compact={false}` lays the report out in full (settings page).
 */
export function HealthBadge({ compact = true }: { compact?: boolean }) {
  const { report, checking, error } = useAppHealth();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const popId = useId();

  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event: PointerEvent) => { if (root.current && !root.current.contains(event.target as Node)) setOpen(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onPointer); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const recheck = () => { void recheckAppHealth(); };
  if (!compact) return <HealthReportView report={report} checking={checking} error={error} onRecheck={recheck} />;

  const text = healthBadgeText(report);
  const icon = checking ? <Spinner size={11} /> : <Icon name={text.tone === 'success' ? 'check' : text.tone === 'neutral' ? 'info' : 'alert'} size={13} />;
  return (
    <div className="wl-ui-health" ref={root}>
      <SemanticTag tone={text.tone} icon={icon} title="环境自检：点击查看每一项与修复建议" onClick={() => setOpen((value) => !value)} ariaExpanded={open}>
        {text.label}
      </SemanticTag>
      {open && (
        <div className="wl-ui-health-pop" id={popId} role="dialog" aria-label="环境自检">
          <h3>环境自检</h3>
          <HealthReportView report={report} checking={checking} error={error} onRecheck={recheck} />
        </div>
      )}
    </div>
  );
}
