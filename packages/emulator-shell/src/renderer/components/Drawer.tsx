import { useEffect, useRef, type ReactNode } from 'react';
import { pushEscapeLayer } from './escape-layers';
import { Icon } from './Icon';

export interface DrawerProps {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  /** Extra buttons in the header, left of the close button. */
  actions?: ReactNode;
  footer?: ReactNode;
  /** Accessible name of the drawer region. */
  label: string;
  /** Width in px; capped by the viewport. */
  width?: number;
  /** While busy, Esc and × do not close the drawer. */
  busy?: boolean;
  /** `log` keeps the dense monospace log body; `panel` (default) is a regular form/content body. */
  variant?: 'panel' | 'log';
  className?: string;
}

/** Side panel anchored to the right edge (shell `.drawer*` styles). Esc closes it and focus moves inside on open. */
export function Drawer({ title, onClose, children, actions, footer, label, width, busy = false, variant = 'panel', className }: DrawerProps) {
  const panel = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  useEffect(() => {
    // Only the topmost layer reacts to Esc (a dialog opened from a drawer closes alone).
    const pop = pushEscapeLayer(() => {
      if (!busyRef.current) closeRef.current();
    });
    const first = panel.current?.querySelector<HTMLElement>('input:not([type=checkbox]):not([disabled]), select, textarea');
    (first ?? panel.current)?.focus({ preventScroll: true });
    return pop;
  }, []);

  return (
    <aside
      ref={panel}
      className={`drawer${variant === 'panel' ? ' drawer-panel' : ''}${className ? ` ${className}` : ''}`}
      style={width ? { width: `min(${width}px, 92vw)` } : undefined}
      role="complementary"
      aria-label={label}
      tabIndex={-1}
    >
      <div className="drawer-head">
        <div className="drawer-title">{typeof title === 'string' ? <span>{title}</span> : title}</div>
        <div className="drawer-actions">
          {actions}
          <button className="icon-btn" onClick={onClose} disabled={busy} title="关闭" aria-label="关闭">
            <Icon name="close" />
          </button>
        </div>
      </div>
      <div className={`drawer-body${variant === 'log' ? ' mono' : ''}`}>{children}</div>
      {footer && <div className="drawer-foot">{footer}</div>}
    </aside>
  );
}
