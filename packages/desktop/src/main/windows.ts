import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, app, screen, shell, type BrowserWindowConstructorOptions, type WebContents } from 'electron';
import { sendEvent } from './events';
import type { LiveService } from './live';
import type { ManagerHost } from './manager-host';
import { refreshAlwaysOnTopMenu } from './menu';

/** Which of our windows a renderer belongs to (IPC authorization). */
export type WindowKind = 'main' | 'live';

const here = dirname(fileURLToPath(import.meta.url));
const APP_TITLE = 'AVD 多开管理器';
/** Height of the live window toolbar (keep in sync with .live-toolbar in styles.css). */
export const LIVE_TOOLBAR_HEIGHT = 44;
const MAC = process.platform === 'darwin';

function devServerUrl(): string | undefined {
  const url = process.env['ELECTRON_RENDERER_URL'];
  return !app.isPackaged && url ? url : undefined;
}

function secureWebPreferences(): BrowserWindowConstructorOptions['webPreferences'] {
  return {
    preload: join(here, '../preload/index.cjs'),
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    webSecurity: true,
    spellcheck: false,
  };
}

/** Load the renderer at a hash route such as "/" or "/live/3". */
function loadRoute(win: BrowserWindow, route: string): Promise<void> {
  const dev = devServerUrl();
  if (dev) return win.loadURL(`${dev}#${route}`);
  return win.loadFile(join(here, '../renderer/index.html'), { hash: route });
}

/** True if `url` is our renderer (dev server or bundled file). */
export function isAppUrl(url: string): boolean {
  const dev = devServerUrl();
  if (dev && url.startsWith(dev)) return true;
  try {
    const u = new URL(url);
    return u.protocol === 'file:' && fileURLToPath(u).startsWith(join(here, '..', 'renderer'));
  } catch {
    return false;
  }
}

/** Block in-app navigation and popups; open http(s) links in the default browser. */
function lockDown(wc: WebContents): void {
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) event.preventDefault();
  });
}

export class WindowManager {
  main: BrowserWindow | undefined;
  private readonly liveWindows = new Map<number, BrowserWindow>();
  /** Aspect ratio (width / height of the picture) each live window is currently locked to. */
  private readonly liveAspects = new Map<number, number>();
  /** openLive() calls in progress: concurrent calls (double clicks) share one window. */
  private readonly openingLive = new Map<number, Promise<void>>();

  constructor(
    private readonly host: ManagerHost,
    private readonly live: LiveService,
  ) {
    live.setOrientationListener((index, width, height) => this.fitLiveToPicture(index, width, height));
  }

  /** 'main' / 'live' for our windows' renderers, undefined for anything else. */
  kindOf(wc: WebContents): WindowKind | undefined {
    if (this.main && !this.main.isDestroyed() && this.main.webContents.id === wc.id) return 'main';
    for (const win of this.liveWindows.values()) {
      if (!win.isDestroyed() && win.webContents.id === wc.id) return 'live';
    }
    return undefined;
  }

  /** Create the main window, or show/focus it if it exists. */
  showMain(): BrowserWindow {
    if (this.main && !this.main.isDestroyed()) {
      if (this.main.isMinimized()) this.main.restore();
      this.main.show();
      this.main.focus();
      return this.main;
    }
    const win = new BrowserWindow({
      width: 1360,
      height: 860,
      minWidth: 960,
      minHeight: 620,
      show: false,
      title: APP_TITLE,
      backgroundColor: '#0f1115',
      ...(MAC ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 18 } } : {}),
      webPreferences: secureWebPreferences(),
    });
    lockDown(win.webContents);
    win.once('ready-to-show', () => win.show());
    win.on('closed', () => {
      if (this.main === win) this.main = undefined;
    });
    void loadRoute(win, '/');
    this.main = win;
    return win;
  }

  /** Open (or focus) the live control window of an instance, sized to the device aspect ratio. */
  openLive(index: number): Promise<void> {
    const existing = this.liveWindows.get(index);
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore();
      existing.show();
      existing.focus();
      return Promise.resolve();
    }
    // Registered synchronously so a second call made while this one awaits the manager joins it.
    const inFlight = this.openingLive.get(index);
    if (inFlight) return inFlight;
    const opening = this.createLive(index).finally(() => {
      if (this.openingLive.get(index) === opening) this.openingLive.delete(index);
    });
    this.openingLive.set(index, opening);
    return opening;
  }

  private async createLive(index: number): Promise<void> {
    const manager = await this.host.get();
    const state = await manager.getState(index);
    if (state.status !== 'running' && state.status !== 'booting') {
      throw new Error(`实例 #${index}（${state.record.name}）未运行，请先启动`);
    }
    const devW = Math.max(1, state.record.spec.width);
    const devH = Math.max(1, state.record.spec.height);
    const anchor = this.main && !this.main.isDestroyed() ? this.main.getBounds() : undefined;
    const display = anchor ? screen.getDisplayMatching(anchor) : screen.getPrimaryDisplay();
    const area = display.workArea;
    const maxW = area.width * 0.7;
    const maxH = area.height * 0.7 - LIVE_TOOLBAR_HEIGHT;
    const scale = Math.min(maxW / devW, maxH / devH);
    const contentW = Math.max(240, Math.round(devW * scale));
    const contentH = Math.max(180, Math.round(devH * scale)) + LIVE_TOOLBAR_HEIGHT;
    const title = `${state.record.name} #${index}`;

    const win = new BrowserWindow({
      width: contentW,
      height: contentH,
      useContentSize: true,
      x: Math.round(area.x + (area.width - contentW) / 2),
      y: Math.round(area.y + (area.height - contentH) / 2),
      minWidth: 240,
      minHeight: 180 + LIVE_TOOLBAR_HEIGHT,
      show: false,
      title,
      backgroundColor: '#000000',
      webPreferences: secureWebPreferences(),
    });
    win.setAspectRatio(devW / devH, { width: 0, height: LIVE_TOOLBAR_HEIGHT });
    lockDown(win.webContents);
    // Keep "<name> #i" rather than the document title.
    win.on('page-title-updated', (event) => event.preventDefault());
    win.once('ready-to-show', () => win.show());
    const wc = win.webContents;
    // Keep the toolbar's 置顶 button and the 窗口 › 置顶显示 checkbox in sync, whichever changed it.
    win.on('always-on-top-changed', (_event, onTop: boolean) => {
      sendEvent(wc, 'window-state', { alwaysOnTop: onTop });
      refreshAlwaysOnTopMenu(win);
    });
    win.on('closed', () => {
      if (this.liveWindows.get(index) === win) {
        this.liveWindows.delete(index);
        this.liveAspects.delete(index);
      }
      // Only this window's stream: never another window's stream of the same instance.
      this.live.stopFor(wc);
    });
    this.liveWindows.set(index, win);
    this.liveAspects.set(index, devW / devH);
    await loadRoute(win, `/live/${index}`);
  }

  /** The open live window of an instance, if any. */
  liveWindow(index: number): BrowserWindow | undefined {
    const win = this.liveWindows.get(index);
    return win && !win.isDestroyed() ? win : undefined;
  }

  /**
   * The upright picture changed orientation (Android rotated, e.g. a landscape game on a portrait panel):
   * lock the window to the new aspect ratio and swap its shape, keeping it on screen.
   */
  fitLiveToPicture(index: number, width: number, height: number): void {
    const win = this.liveWindows.get(index);
    if (!win || win.isDestroyed() || !(width > 0) || !(height > 0)) return;
    const aspect = width / height;
    const current = this.liveAspects.get(index);
    if (current !== undefined && Math.abs(current - aspect) < 0.01) return;
    this.liveAspects.set(index, aspect);
    win.setAspectRatio(aspect, { width: 0, height: LIVE_TOOLBAR_HEIGHT });
    if (win.isFullScreen() || win.isMaximized()) return;
    const [cw = 0, ch = 0] = win.getContentSize();
    const stageH = Math.max(1, ch - LIVE_TOOLBAR_HEIGHT);
    const area = screen.getDisplayMatching(win.getBounds()).workArea;
    // Keep roughly the same picture area, fitted into the work area.
    const side = Math.sqrt(Math.max(1, cw) * stageH);
    let w = side * Math.sqrt(aspect);
    let h = side / Math.sqrt(aspect);
    const scale = Math.min(1, (area.width * 0.9) / w, (area.height * 0.9 - LIVE_TOOLBAR_HEIGHT) / h);
    w = Math.max(240, Math.round(w * scale));
    h = Math.max(180, Math.round(h * scale));
    win.setContentSize(w, h + LIVE_TOOLBAR_HEIGHT);
    const b = win.getBounds();
    const x = Math.round(Math.min(Math.max(b.x, area.x), area.x + area.width - b.width));
    const y = Math.round(Math.min(Math.max(b.y, area.y), area.y + area.height - b.height));
    if (x !== b.x || y !== b.y) win.setPosition(x, y);
  }

  /** Update live window titles after a rename. */
  retitleLive(index: number, name: string): void {
    const win = this.liveWindows.get(index);
    if (win && !win.isDestroyed()) win.setTitle(`${name} #${index}`);
  }
}
