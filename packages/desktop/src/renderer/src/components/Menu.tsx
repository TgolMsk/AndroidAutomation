import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

export interface MenuItem {
  label: string;
  icon?: IconName;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  /** Draw a divider above this item. */
  divider?: boolean;
  hint?: string;
}

/** Small dropdown menu anchored to a trigger button. */
export function DropdownMenu({
  trigger,
  items,
  title,
  align = 'right',
  className = 'icon-btn',
}: {
  trigger: ReactNode;
  items: MenuItem[];
  title?: string;
  align?: 'left' | 'right';
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  const toggle = () => {
    if (!open && root.current) {
      // Open upwards when there is not enough room below the trigger.
      const rect = root.current.getBoundingClientRect();
      const needed = 34 * items.length + 24;
      setUp(window.innerHeight - rect.bottom < needed && rect.top > needed);
    }
    setOpen((o) => !o);
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="dropdown" ref={root} onClick={(e) => e.stopPropagation()}>
      <button className={`${className}${open ? ' active' : ''}`} title={title} aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
        {trigger}
      </button>
      {open && (
        <div className={`dropdown-menu align-${align}${up ? ' up' : ''}`} role="menu">
          {items.map((item) => (
            <div key={item.label}>
              {item.divider && <div className="dropdown-divider" />}
              <button
                role="menuitem"
                className={`dropdown-item${item.danger ? ' danger' : ''}`}
                disabled={item.disabled}
                title={item.hint}
                onClick={() => {
                  setOpen(false);
                  item.onClick();
                }}
              >
                {item.icon ? <Icon name={item.icon} size={15} /> : <span className="dropdown-icon-spacer" />}
                <span>{item.label}</span>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
