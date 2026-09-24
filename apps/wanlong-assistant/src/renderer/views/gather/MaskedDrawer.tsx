import { Drawer, type DrawerProps } from '../../components/Drawer';
import './gather.css';

/**
 * The shell Drawer with a click-to-close mask behind it (antd Drawer's mask in the original). The mask calls the same
 * `onClose` as Esc and ×, so an unsaved-changes guard in `onClose` covers all three.
 */
export function MaskedDrawer(props: DrawerProps) {
  const { onClose, busy } = props;
  return (
    <>
      <div className="gather-drawer-mask" aria-hidden="true" onMouseDown={() => { if (!busy) onClose(); }} />
      <Drawer {...props} className={`gather-drawer${props.className ? ` ${props.className}` : ''}`} />
    </>
  );
}
