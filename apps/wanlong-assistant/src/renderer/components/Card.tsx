import { useId, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import './ui.css';

export type CardVariant = 'panel' | 'solid' | 'sunken';

export interface CardProps {
  title?: ReactNode;
  icon?: IconName;
  /** Actions on the right of the title. */
  extra?: ReactNode;
  /** Supplementary line under a divider. */
  footer?: ReactNode;
  /** `panel` (default) for page sections, `solid` inside overlays, `sunken` for log / picture wells. */
  variant?: CardVariant;
  /** `sm` for dense pages (tables). */
  padding?: 'lg' | 'sm';
  className?: string;
  children?: ReactNode;
}

/** Section container used by every page (original GlassCard), labelled by its title for screen readers. */
export function Card({ title, icon, extra, footer, variant = 'panel', padding = 'lg', className, children }: CardProps) {
  const titleId = useId();
  const classes = ['wl-ui-card', variant !== 'panel' ? `is-${variant}` : '', padding === 'sm' ? 'is-sm' : '', className ?? ''].filter(Boolean).join(' ');
  return (
    <section className={classes} aria-labelledby={title ? titleId : undefined}>
      {(title || extra) && (
        <header className="wl-ui-card-head">
          {title ? <h2 id={titleId} className="wl-ui-card-title">{icon && <Icon name={icon} />}{title}</h2> : <span />}
          {extra && <div className="wl-ui-card-extra">{extra}</div>}
        </header>
      )}
      <div className="wl-ui-card-body">{children}</div>
      {footer !== undefined && footer !== null && <footer className="wl-ui-card-foot">{footer}</footer>}
    </section>
  );
}
