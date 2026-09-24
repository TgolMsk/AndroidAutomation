import type { ReactNode } from 'react';
import './ui.css';

export type StatTone = 'accent' | 'neutral' | 'danger';

export interface StatTileProps {
  label: string;
  /** The number itself (a number or a string such as `12/40`). */
  value: ReactNode;
  /** Unit after the number, smaller and dimmer. */
  unit?: string;
  tone?: StatTone;
  /** One Chinese sentence under the number: when this number is not normal. */
  hint?: string;
}

/**
 * A key-number tile: the middle of the three type sizes (title > key number > label). Keep the three sizes apart:
 * do not restyle the font size at the call site.
 */
export function StatTile({ label, value, unit, tone = 'neutral', hint }: StatTileProps) {
  return (
    <div className={`wl-ui-stat${tone !== 'neutral' ? ` is-${tone}` : ''}`}>
      <span className="wl-ui-stat-label">{label}</span>
      <span className="wl-ui-stat-line">
        <span className="wl-ui-stat-value">{value}</span>
        {unit && <span className="wl-ui-stat-unit">{unit}</span>}
      </span>
      {hint && <span className="wl-ui-stat-hint">{hint}</span>}
    </div>
  );
}
