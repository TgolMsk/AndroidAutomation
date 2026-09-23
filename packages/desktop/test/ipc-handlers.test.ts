import { EventEmitter } from 'node:events';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => import('../../emulator-shell/test/helpers/electron-mock'));

import { defaultSettings, resolvePaths } from '@avdm/core';
import { assertScrcpyPath, authorizeInvoke, registerIpcHandlers, type IpcEnvelope } from '../src/main/ipc-handlers';
import type { ManagerHost } from '../src/main/manager-host';
import { SdkInstallTask } from '../src/main/sdk-install';
import type { WindowKind } from '../src/main/windows';
import { BrowserWindow, FakeWebContents, handlers } from '../../emulator-shell/test/helpers/electron-mock';

const here = dirname(fileURLToPath(import.meta.url));
const APP_URL = `${pathToFileURL(join(here, '..', '..', 'emulator-shell', 'src', 'renderer', 'index.html')).href}#/`;

describe('authorizeInvoke', () => {
  it('lets the main window call everything', () => {
    expect(() => authorizeInvoke('updateSettings', APP_URL, 'main')).not.toThrow();
    expect(() => authorizeInvoke('installSdk', APP_URL, 'main')).not.toThrow();
  });
  it('restricts live windows to the live-view surface', () => {
    for (const m of ['liveStart', 'liveTouch', 'liveKey', 'liveStop', 'saveScreenshot', 'revealPath', 'alwaysOnTop', 'listInstances'] as const) {
      expect(() => authorizeInvoke(m, APP_URL, 'live')).not.toThrow();
    }
    for (const m of ['updateSettings', 'acceptLicenses', 'installSdk', 'create', 'remove', 'runScript', 'shell', 'openScrcpy'] as const) {
      expect(() => authorizeInvoke(m, APP_URL, 'live')).toThrow('实时画面窗口无权执行此操作');
    }
  });
  it('fails closed on a missing frame, a foreign page or an unknown window', () => {
    expect(() => authorizeInvoke('listInstances', undefined, 'main')).toThrow('拒绝来自未知页面的请求');
    expect(() => authorizeInvoke('listInstances', 'https://example.com/', 'main')).toThrow('拒绝来自未知页面的请求');
    expect(() => authorizeInvoke('listInstances', APP_URL, undefined)).toThrow('拒绝来自未知窗口的请求');
  });
});

describe('assertScrcpyPath', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'avdm-scrcpy-'));
    await mkdir(join(dir, 'ok'));
    await writeFile(join(dir, 'ok', 'scrcpy'), '#!/bin/sh\n');
    await chmod(join(dir, 'ok', 'scrcpy'), 0o755);
    await mkdir(join(dir, 'noexec'));
    await writeFile(join(dir, 'noexec', 'scrcpy'), 'x');
    await chmod(join(dir, 'noexec', 'scrcpy'), 0o644);
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('accepts empty (PATH lookup) and an executable called scrcpy', async () => {
    await expect(assertScrcpyPath('')).resolves.toBeUndefined();
    await expect(assertScrcpyPath(`  ${join(dir, 'ok', 'scrcpy')}  `)).resolves.toBeUndefined();
  });
  it('rejects other binaries, non-executables and junk', async () => {
    await expect(assertScrcpyPath('/bin/sh')).rejects.toThrow('名为 scrcpy');
    await expect(assertScrcpyPath(join(dir, 'noexec', 'scrcpy'))).rejects.toThrow('不可执行');
    await expect(assertScrcpyPath(join(dir, 'missing', 'scrcpy'))).rejects.toThrow('不存在');
    await expect(assertScrcpyPath(42)).rejects.toThrow('无效');
  });
});

describe('registered handlers', () => {
  const kinds = new Map<unknown, WindowKind>();
  const mainWc = new FakeWebContents();
  const liveWc = new FakeWebContents();
  kinds.set(mainWc, 'main');
  kinds.set(liveWc, 'live');
  let home: string;
  let installRelease: ((err?: Error) => void) | undefined;
  const installCalls: string[][] = [];
  const updates: unknown[] = [];
  const accepted: unknown[][] = [];

  class FakeManager extends EventEmitter {
    paths = resolvePaths('/nonexistent');
    getSettings() {
      return defaultSettings();
    }
    async updateSettings(patch: unknown) {
      updates.push(patch);
      return defaultSettings();
    }
    async acceptLicenses(ids: string[], shownTexts?: Record<string, string>) {
      accepted.push([ids, shownTexts]);
    }
    async planSdkInstall(paths: string[]) {
      return { packages: paths.map((path) => ({ path })), licenses: {}, unaccepted: [], missing: [], totalBytes: 1 };
    }
    installSdkPackages(paths: string[], opts: { signal?: AbortSignal }) {
      installCalls.push(paths);
      return new Promise<void>((resolve, reject) => {
        installRelease = (err) => (err ? reject(err) : resolve());
        opts.signal?.addEventListener('abort', () => reject(new Error('curl 被信号 SIGTERM 终止')));
      });
    }
  }
  const manager = new FakeManager();
  const host = { get: async () => manager, manager } as unknown as ManagerHost;
  const sdkInstall = new SdkInstallTask();

  const call = (method: string, sender: FakeWebContents, ...args: unknown[]) =>
    handlers.get(`avdm:${method}`)!({ sender, senderFrame: { url: APP_URL } }, ...args) as Promise<IpcEnvelope>;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'avdm-ipc-'));
    manager.paths = resolvePaths(home);
    registerIpcHandlers({
      host,
      live: { stop: vi.fn() } as never,
      thumbs: {} as never,
      windows: { kindOf: (wc: unknown) => kinds.get(wc) } as never,
      sdkInstall,
    });
  });
  afterAll(() => rm(home, { recursive: true, force: true }));

  it('rejects privileged calls from a live window before touching the manager', async () => {
    const res = await call('updateSettings', liveWc, { maxRunning: 1 });
    expect(res).toEqual({ ok: false, error: { message: '实时画面窗口无权执行此操作' } });
    expect(updates).toHaveLength(0);
  });

  it('rejects a call whose senderFrame is gone', async () => {
    const res = (await handlers.get('avdm:listInstances')!({ sender: mainWc, senderFrame: null })) as IpcEnvelope;
    expect(res.ok).toBe(false);
  });

  it('getSettings returns settings.json from disk (not the manager copy that lags behind the CLI)', async () => {
    await writeFile(join(home, 'settings.json'), JSON.stringify({ maxRunning: 12 }));
    const res = await call('getSettings', mainWc);
    expect(res.ok && (res.value as { maxRunning: number }).maxRunning).toBe(12);
  });

  it('updateSettings forwards the partial patch and validates scrcpyPath', async () => {
    const ok = await call('updateSettings', mainWc, { defaultSpec: { cpuCores: 4 } });
    expect(ok.ok).toBe(true);
    expect(updates.at(-1)).toEqual({ defaultSpec: { cpuCores: 4 } });
    const bad = await call('updateSettings', mainWc, { scrcpyPath: '/bin/sh' });
    expect(bad.ok).toBe(false);
    expect(updates).toHaveLength(1);
  });

  it('acceptLicenses forwards the license texts the wizard showed, and validates them', async () => {
    const ok = await call('acceptLicenses', mainWc, ['android-sdk-license'], { 'android-sdk-license': 'Terms…' });
    expect(ok.ok).toBe(true);
    expect(accepted.at(-1)).toEqual([['android-sdk-license'], { 'android-sdk-license': 'Terms…' }]);
    expect((await call('acceptLicenses', mainWc, ['android-sdk-license'])).ok).toBe(true);
    expect(accepted.at(-1)).toEqual([['android-sdk-license'], undefined]);
    const bad = await call('acceptLicenses', mainWc, ['android-sdk-license'], { 'android-sdk-license': 1 });
    expect(bad).toEqual({ ok: false, error: { message: '参数错误：许可全文需为字符串映射' } });
    expect(accepted).toHaveLength(2);
  });

  it('installSdk: a reopened wizard joins the running install, sees its status and can cancel it', async () => {
    const first = call('installSdk', mainWc, ['emulator']);
    await new Promise((r) => setTimeout(r, 10));
    const status = await call('sdkInstallStatus', mainWc);
    expect(status.ok && (status.value as { packages: string[] }).packages).toEqual(['emulator']);
    manager.emit('sdk-progress', { packagePath: 'emulator', phase: 'download', receivedBytes: 5, totalBytes: 10 });
    const again = await call('sdkInstallStatus', mainWc);
    expect(again.ok && (again.value as { progress: Record<string, { receivedBytes: number }> }).progress['emulator']?.receivedBytes).toBe(5);

    const joined = call('installSdk', mainWc, ['emulator']);
    const other = await call('installSdk', mainWc, ['platform-tools']);
    expect(other.ok).toBe(false);
    await call('cancelSdkInstall', mainWc);
    expect(await first).toEqual({ ok: false, error: { message: '安装已取消' } });
    expect(await joined).toEqual({ ok: false, error: { message: '安装已取消' } });
    expect(installCalls).toEqual([['emulator']]);
    const after = await call('sdkInstallStatus', mainWc);
    expect(after).toEqual({ ok: true, value: null });
    expect(manager.listenerCount('sdk-progress')).toBe(0);
    installRelease = undefined;
  });

  it('alwaysOnTop applies to the calling window only', async () => {
    const win = new BrowserWindow();
    kinds.set(win.webContents, 'live');
    const set = await call('alwaysOnTop', win.webContents, true);
    expect(set).toEqual({ ok: true, value: true });
    expect(win.onTop).toBe(true);
    const query = await call('alwaysOnTop', win.webContents);
    expect(query).toEqual({ ok: true, value: true });
  });
});
