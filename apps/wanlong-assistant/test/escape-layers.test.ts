/**
 * Esc closes only the topmost layer (original antd Drawer + Modal): a dialog opened from the gather config drawer
 * (导出 / 导入, 恢复默认) closes alone instead of also closing — or asking to close — the drawer under it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pushEscapeLayer } from '../../../packages/emulator-shell/src/renderer/components/escape-layers';

function press(key: string): void {
  window.dispatchEvent(Object.assign(new Event('keydown'), { key }));
}

beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('escape layer stack', () => {
  it('only the topmost layer sees Esc; removing it hands Esc back to the one below', () => {
    const drawer = vi.fn();
    const dialog = vi.fn();
    const popDrawer = pushEscapeLayer(drawer);
    const popDialog = pushEscapeLayer(dialog);
    press('Escape');
    expect(dialog).toHaveBeenCalledTimes(1);
    expect(drawer).not.toHaveBeenCalled();
    popDialog();
    popDialog(); // idempotent: never removes another layer
    press('Escape');
    expect(drawer).toHaveBeenCalledTimes(1);
    press('Enter');
    expect(drawer).toHaveBeenCalledTimes(1);
    popDrawer();
    press('Escape');
    expect(drawer).toHaveBeenCalledTimes(1);
  });

  it('a busy top layer swallows Esc instead of letting it fall through', () => {
    const drawer = vi.fn();
    let busy = true;
    const closeDialog = vi.fn();
    const popDrawer = pushEscapeLayer(drawer);
    const popDialog = pushEscapeLayer(() => { if (!busy) closeDialog(); });
    press('Escape');
    expect(closeDialog).not.toHaveBeenCalled();
    expect(drawer).not.toHaveBeenCalled();
    busy = false;
    press('Escape');
    expect(closeDialog).toHaveBeenCalledTimes(1);
    popDialog();
    popDrawer();
  });

  it('layers removed out of order leave the stack consistent', () => {
    const a = vi.fn();
    const b = vi.fn();
    const popA = pushEscapeLayer(a);
    const popB = pushEscapeLayer(b);
    popA();
    press('Escape');
    expect(b).toHaveBeenCalledTimes(1);
    expect(a).not.toHaveBeenCalled();
    popB();
  });
});
