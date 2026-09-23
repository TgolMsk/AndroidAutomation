import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => import('../../emulator-shell/test/helpers/electron-mock'));

import type { LiveService } from '../src/main/live';
import type { ManagerHost } from '../src/main/manager-host';
import { LIVE_TOOLBAR_HEIGHT, WindowManager } from '../src/main/windows';
import { BrowserWindow } from '../../emulator-shell/test/helpers/electron-mock';

function setup(spec = { width: 1280, height: 720 }, gate?: Promise<void>) {
  const manager = {
    async getState(index: number) {
      if (gate) await gate; // e.g. a gRPC getStatus on a booting instance under load
      return { status: 'booting', record: { index, name: `实例-${index}`, spec } };
    },
  };
  const host = { get: async () => manager } as unknown as ManagerHost;
  const live = { setOrientationListener: vi.fn(), stopFor: vi.fn(), stop: vi.fn() };
  const wm = new WindowManager(host, live as unknown as LiveService);
  return { wm, live };
}

beforeEach(() => BrowserWindow.reset());

describe('WindowManager live windows', () => {
  it('click + click + dblclick while the state query is slow opens ONE window', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { wm } = setup(undefined, gate);
    const calls = [wm.openLive(0), wm.openLive(0), wm.openLive(0)];
    release();
    await Promise.all(calls);
    expect(BrowserWindow.instances).toHaveLength(1);
    await wm.openLive(0); // focuses the existing window
    expect(BrowserWindow.instances).toHaveLength(1);
  });

  it('closing a live window stops only its own stream', async () => {
    const { wm, live } = setup();
    await wm.openLive(3);
    const win = wm.liveWindow(3) as unknown as BrowserWindow;
    expect(wm.kindOf(win.webContents as never)).toBe('live');
    win.close();
    expect(live.stopFor).toHaveBeenCalledWith(win.webContents);
    expect(live.stop).not.toHaveBeenCalled();
    expect(wm.kindOf(win.webContents as never)).toBeUndefined();
    expect(wm.liveWindow(3)).toBeUndefined();
  });

  it('classifies renderers for IPC authorization', async () => {
    const { wm } = setup();
    const main = wm.showMain() as unknown as BrowserWindow;
    expect(wm.kindOf(main.webContents as never)).toBe('main');
    const stranger = new BrowserWindow();
    expect(wm.kindOf(stranger.webContents as never)).toBeUndefined();
  });

  it('reshapes the window when the picture turns (portrait panel showing a landscape app)', async () => {
    const { wm } = setup({ width: 720, height: 1280 });
    await wm.openLive(0);
    const win = wm.liveWindow(0) as unknown as BrowserWindow;
    expect(win.aspect).toBeCloseTo(720 / 1280);
    wm.fitLiveToPicture(0, 1280, 720);
    expect(win.aspect).toBeCloseTo(1280 / 720);
    const [w, h] = win.getContentSize() as [number, number];
    expect(w / (h - LIVE_TOOLBAR_HEIGHT)).toBeCloseTo(1280 / 720, 1);
  });

  it('reports always-on-top changes to the live window (toolbar 置顶 button stays in sync)', async () => {
    const { wm } = setup();
    await wm.openLive(1);
    const win = wm.liveWindow(1) as unknown as BrowserWindow;
    win.setAlwaysOnTop(true);
    win.setAlwaysOnTop(false);
    expect(win.webContents.events('window-state')).toEqual([{ alwaysOnTop: true }, { alwaysOnTop: false }]);
  });
});
