/**
 * Version entry at the bottom of the sidebar (ported from wanlong-panel `features/update/SidebarUpdate.tsx`).
 *
 * Normally just an unobtrusive `v<version>`; a red dot appears when a new version exists, and clicking opens the
 * compact update panel (the same body as the settings card). Expanded sidebar: a text button; collapsed: an icon
 * button with the version in its tooltip. ★ The dot only means "a new version exists" (see `hasPendingUpdate`).
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { Icon } from '../../components/Icon';
import { UpdatePanel, UpdatePhaseTag } from './UpdatePanel';
import { hasPendingUpdate, useUpdateFeed, useUpdateStore } from './update-store';

const GAP = 8;
const MARGIN = 12;

export function SidebarUpdate({ collapsed }: { collapsed: boolean }) {
  useUpdateFeed();
  const { state } = useUpdateStore();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({ visibility: 'hidden' });
  const anchor = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);

  const version = state ? `v${state.currentVersion}` : '读取中…';
  const pending = hasPendingUpdate(state);
  const hint = pending ? `有新版本 v${state?.latestVersion ?? ''}，点开看更新说明` : `${version} · 点开检查更新`;

  // Anchored with fixed coordinates: the sidebar clips overflow and the popover must stay on screen.
  const place = useCallback(() => {
    const rect = anchor.current?.getBoundingClientRect();
    if (!rect) return;
    // Collapsed: open beside the (narrow) sidebar instead of over it.
    const edge = anchor.current?.closest('.wl-shell-sidebar')?.getBoundingClientRect().right ?? rect.right;
    const bottom = collapsed ? window.innerHeight - rect.bottom : window.innerHeight - rect.top + GAP;
    const left = collapsed ? edge + GAP : rect.left;
    setPosition({ left: Math.max(MARGIN, left), bottom: Math.max(MARGIN, bottom) });
  }, [collapsed]);

  useLayoutEffect(() => { if (open) place(); }, [open, place]);
  // Move focus into the popover so keyboard users land on its buttons (Escape returns it to the version button).
  useEffect(() => { if (open) popover.current?.focus({ preventScroll: true }); }, [open]);

  useEffect(() => {
    if (!open) return;
    const inside = (target: EventTarget | null) =>
      target instanceof Node && Boolean(popover.current?.contains(target) || anchor.current?.contains(target));
    const onPointer = (event: MouseEvent) => { if (!inside(event.target)) setOpen(false); };
    const onKey = (event: KeyboardEvent) => {
      // A confirmation dialog opened from the panel handles its own Escape.
      if (event.key !== 'Escape' || popover.current?.querySelector('.modal-backdrop')) return;
      setOpen(false);
      anchor.current?.focus();
    };
    document.addEventListener('mousedown', onPointer);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', place);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', place);
    };
  }, [open, place]);

  return (
    <div className="update-sidebar">
      {collapsed
        ? <button
            ref={anchor} type="button" className="icon-btn small update-sidebar-icon" aria-label={hint} title={open ? undefined : hint}
            aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((value) => !value)}
          >
            <Icon name={pending ? 'download' : 'info'} size={16} />
            {pending && <span className="update-sidebar-dot" aria-hidden="true" />}
          </button>
        : <button
            ref={anchor} type="button" className="update-sidebar-version" aria-label={hint} title={open ? undefined : hint}
            aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((value) => !value)}
          >
            <span className="mono">{version}</span>
            {pending && <span className="update-sidebar-dot" aria-hidden="true" />}
          </button>}
      {open && <div ref={popover} className="update-popover" style={position} role="dialog" aria-label="版本与更新" tabIndex={-1}>
        <div className="update-popover-head">
          <h2>版本与更新</h2>
          {state && <UpdatePhaseTag state={state} />}
          <button type="button" className="icon-btn small" aria-label="关闭" title="关闭" onClick={() => { setOpen(false); anchor.current?.focus(); }}>
            <Icon name="close" size={14} />
          </button>
        </div>
        <UpdatePanel compact />
      </div>}
    </div>
  );
}
