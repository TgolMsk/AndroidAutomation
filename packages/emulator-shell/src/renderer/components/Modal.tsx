import { useEffect, useRef, type ReactNode } from 'react';
import { Icon } from './Icon';

export interface ModalProps {
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  /** While busy, Esc / backdrop / × do not close the dialog. */
  busy?: boolean;
  className?: string;
}

export function Modal({ title, subtitle, onClose, children, footer, width = 540, busy = false, className }: ModalProps) {
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busyRef.current) {
        e.stopPropagation();
        closeRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    // Focus the first field for keyboard users.
    const first = panel.current?.querySelector<HTMLElement>('input:not([type=checkbox]):not([disabled]), select, textarea');
    (first ?? panel.current)?.focus({ preventScroll: true });
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        ref={panel}
        className={`modal ${className ?? ''}`}
        style={{ width }}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
      >
        <div className="modal-header">
          <div className="modal-titles">
            <h2>{title}</h2>
            {subtitle && <div className="modal-subtitle">{subtitle}</div>}
          </div>
          <button className="icon-btn" onClick={onClose} disabled={busy} title="关闭" aria-label="关闭">
            <Icon name="close" />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}
