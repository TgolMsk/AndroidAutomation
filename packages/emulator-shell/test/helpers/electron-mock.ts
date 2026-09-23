/**
 * Minimal stand-in for the parts of Electron the main-process modules use, for unit tests running in plain
 * Node (vitest): `vi.mock('electron', () => import('./helpers/electron-mock'))`.
 */
import { EventEmitter } from 'node:events';

let nextId = 1;

export class FakeWebContents extends EventEmitter {
  readonly id = nextId++;
  destroyed = false;
  /** Every message sent to this renderer: [channel, payload]. */
  readonly sent: Array<[string, unknown]> = [];

  isDestroyed(): boolean {
    return this.destroyed;
  }
  send(channel: string, payload: unknown): void {
    if (this.destroyed) throw new Error('destroyed');
    this.sent.push([channel, payload]);
  }
  /** Payloads of avdm events with this channel. */
  events<T = unknown>(channel: string): T[] {
    return this.sent
      .filter(([c, m]) => c === 'avdm:event' && (m as { channel: string }).channel === channel)
      .map(([, m]) => (m as { payload: T }).payload);
  }
  setWindowOpenHandler(): void {}
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('destroyed');
  }
}

export class BrowserWindow extends EventEmitter {
  static instances: BrowserWindow[] = [];
  readonly webContents = new FakeWebContents();
  readonly options: Record<string, unknown>;
  destroyed = false;
  visible = true;
  minimized = false;
  onTop = false;
  aspect: number | undefined;
  contentSize: [number, number];
  bounds = { x: 0, y: 0, width: 800, height: 600 };
  loaded: string | undefined;

  constructor(options: Record<string, unknown> = {}) {
    super();
    this.options = options;
    this.contentSize = [Number(options['width']) || 800, Number(options['height']) || 600];
    BrowserWindow.instances.push(this);
  }

  static getAllWindows(): BrowserWindow[] {
    return BrowserWindow.instances.filter((w) => !w.destroyed);
  }
  static fromWebContents(wc: unknown): BrowserWindow | null {
    return BrowserWindow.instances.find((w) => w.webContents === wc) ?? null;
  }
  static getFocusedWindow(): BrowserWindow | null {
    return null;
  }
  static reset(): void {
    BrowserWindow.instances = [];
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }
  isVisible(): boolean {
    return this.visible && !this.destroyed;
  }
  isMinimized(): boolean {
    return this.minimized;
  }
  isFullScreen(): boolean {
    return false;
  }
  isMaximized(): boolean {
    return false;
  }
  minimize(): void {
    this.minimized = true;
    this.emit('minimize');
  }
  restore(): void {
    this.minimized = false;
    this.emit('restore');
  }
  show(): void {
    this.visible = true;
    this.emit('show');
  }
  hide(): void {
    this.visible = false;
    this.emit('hide');
  }
  focus(): void {}
  setTitle(): void {}
  setAspectRatio(aspect: number): void {
    this.aspect = aspect;
  }
  getBounds() {
    return { ...this.bounds };
  }
  getContentSize(): number[] {
    return [...this.contentSize];
  }
  setContentSize(w: number, h: number): void {
    this.contentSize = [w, h];
    this.bounds = { ...this.bounds, width: w, height: h };
  }
  setPosition(x: number, y: number): void {
    this.bounds = { ...this.bounds, x, y };
  }
  setAlwaysOnTop(on: boolean): void {
    this.onTop = on;
    this.emit('always-on-top-changed', {}, on);
  }
  isAlwaysOnTop(): boolean {
    return this.onTop;
  }
  loadFile(file: string, opts?: { hash?: string }): Promise<void> {
    this.loaded = `${file}#${opts?.hash ?? ''}`;
    return Promise.resolve();
  }
  loadURL(url: string): Promise<void> {
    this.loaded = url;
    return Promise.resolve();
  }
  close(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('closed');
    this.webContents.destroy();
  }
}

export const app = {
  isPackaged: false,
  name: 'AVD 多开管理器',
  getVersion: () => '0.0.0-test',
  getPath: () => '/tmp',
  on: () => undefined,
};

export const handlers = new Map<string, (...args: unknown[]) => unknown>();
export const ipcMain = {
  handle(channel: string, fn: (...args: unknown[]) => unknown): void {
    handlers.set(channel, fn);
  },
};

const workArea = { x: 0, y: 0, width: 1920, height: 1080 };
export const screen = {
  getDisplayMatching: () => ({ workArea }),
  getPrimaryDisplay: () => ({ workArea }),
};

export const Menu = {
  getApplicationMenu: () => null,
  buildFromTemplate: () => ({ getMenuItemById: () => null }),
  setApplicationMenu: () => undefined,
};

export const dialog = {
  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  showMessageBox: async () => ({ response: 1 }),
};

export const shell = {
  openExternal: async () => undefined,
  openPath: async () => '',
  showItemInFolder: () => undefined,
};

export const session = { defaultSession: {} };

export default { BrowserWindow, app, ipcMain, screen, Menu, dialog, shell, session };
