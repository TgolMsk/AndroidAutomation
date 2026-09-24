import { useId, type ReactNode } from 'react';
import type { ConfigIssue } from '@avdm/automation/wanlong/pure';

/**
 * One config field (original ConfigField): Chinese name + schema path on the left; the control, a hint, the 「代价」
 * (what raising or lowering it costs) and this path's validation issues on the right. The users are players, not
 * schema readers: every tunable says what it costs.
 */
export function ConfigField({ name, path, hint, cost, issues, children }: {
  name: string;
  /** Schema path such as `schedule.slackSeconds`; also selects the issues shown here. */
  path: string;
  hint?: ReactNode;
  cost?: ReactNode;
  issues?: readonly ConfigIssue[];
  children: ReactNode;
}) {
  const mine = (issues ?? []).filter((issue) => issue.path === path);
  const id = useId();
  return (
    <div className="gather-field" role="group" aria-labelledby={id}>
      <div className="gather-field-label">
        <span id={id} className="gather-field-name">{name}</span>
        <span className="gather-field-key">{path}</span>
      </div>
      <div className="gather-field-control">
        <div className="gather-inline">{children}</div>
        {hint && <div className="gather-field-hint">{hint}</div>}
        {cost && <div className="gather-field-cost">{cost}</div>}
        <IssueList issues={mine} />
      </div>
    </div>
  );
}

/** Validation issues as 「错误：」 / 「提醒：」 lines. */
export function IssueList({ issues }: { issues: readonly ConfigIssue[] }) {
  return (
    <>
      {issues.map((issue, k) => (
        <div key={k} className={issue.level === 'error' ? 'gather-field-err' : 'gather-field-warn'} role={issue.level === 'error' ? 'alert' : undefined}>
          {issue.level === 'error' ? '错误：' : '提醒：'}{issue.message}
        </div>
      ))}
    </>
  );
}

/** A titled block of fields (original ConfigSection over GlassCard). */
export function ConfigSection({ title, desc, extra, children }: { title: string; desc?: ReactNode; extra?: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <section className="gather-cfg-section" aria-labelledby={id}>
      <header className="gather-cfg-section-head">
        <h3 id={id}>{title}</h3>
        {extra && <div className="gather-inline">{extra}</div>}
      </header>
      {desc && <div className="gather-cfg-section-desc">{desc}</div>}
      <div>{children}</div>
    </section>
  );
}

/**
 * Number input that keeps what the user typed (validation reports out-of-range values instead of clamping them).
 * An emptied box becomes `emptyAs` (the original InputNumber fallbacks).
 */
export function NumberInput({ value, onChange, min, max, step = 1, emptyAs, disabled, label, width = 120 }: {
  value: number;
  onChange(next: number): void;
  min?: number;
  max?: number;
  step?: number;
  emptyAs: number;
  disabled?: boolean;
  label: string;
  width?: number;
}) {
  return (
    <input type="number" className="gather-number" style={{ width }} value={Number.isFinite(value) ? value : ''} min={min} max={max} step={step}
      disabled={disabled} aria-label={label}
      onChange={(event) => onChange(event.target.value === '' ? emptyAs : Number(event.target.value))} />
  );
}
