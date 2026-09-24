/**
 * Esc closes only the topmost layer (antd Drawer / Modal behaviour). Drawers, dialogs and open menus register here
 * instead of each listening on `window`: listeners on one target all run (stopPropagation does not stop them), and the
 * drawer that opened a dialog registered first, so Esc used to close the dialog and the drawer under it together.
 * A layer that is busy still swallows Esc (it just ignores it): Esc never falls through to the layer underneath.
 */
type EscapeHandler = (event: KeyboardEvent) => void;

const layers: EscapeHandler[] = [];

function onKeyDown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return;
  const top = layers[layers.length - 1];
  if (!top) return;
  event.stopPropagation();
  top(event);
}

/** Register a layer on top of the stack; the returned function removes it (idempotent). */
export function pushEscapeLayer(handler: EscapeHandler): () => void {
  if (layers.length === 0) window.addEventListener('keydown', onKeyDown);
  layers.push(handler);
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    const at = layers.lastIndexOf(handler);
    if (at >= 0) layers.splice(at, 1);
    if (layers.length === 0) window.removeEventListener('keydown', onKeyDown);
  };
}
