import type { ReactNode } from 'react';
import './ui.css';

/** A wrapping row of StatTiles; only arranges, never styles the tiles. */
export function MetricStrip({ children, className, label }: { children?: ReactNode; className?: string; label?: string }) {
  return <div className={`wl-ui-metrics${className ? ` ${className}` : ''}`} role={label ? 'group' : undefined} aria-label={label}>{children}</div>;
}
