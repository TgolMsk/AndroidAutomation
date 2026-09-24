/** The update IPC domain: registration, envelopes that keep the refusal code, main-window-only, import rules. */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => import('../../../packages/emulator-shell/test/helpers/electron-mock'));

import { INVOKE_METHODS } from '@avdm/emulator-shell/shared/ipc';
import { handlers } from '../../../packages/emulator-shell/test/helpers/electron-mock';
import { registerWanlongIpcHandlers, type WanlongServices } from '../src/main/ipc-handlers';
import { UpdateError } from '../src/main/update/center';
import { UPDATE_METHODS, WANLONG_INVOKE_METHODS, wanlongInvokeChannel } from '../src/shared/ipc';
import { initialUpdateState } from '../src/shared/update';

const here = dirname(fileURLToPath(import.meta.url));
const appUrl = `${pathToFileURL(join(here, '..', '..', '..', 'packages', 'emulator-shell', 'src', 'renderer', 'index.html')).href}#/`;
const mainSender = { id: 1 };
const liveSender = { id: 2 };

const state = { ...initialUpdateState('0.3.0'), phase: 'downloaded' as const, installable: false, busyReason: '实例 #0 正在运行采集。' };
const updateCenter = {
  getState: vi.fn(() => state),
  check: vi.fn(async () => state),
  download: vi.fn(async () => state),
  cancelDownload: vi.fn(async () => state),
  install: vi.fn(async () => {
    throw new UpdateError('CONCURRENCY_LIMIT', '实例 #0 正在运行采集。安装要先退出助手，现在装会把正在跑的活儿掐断。等它结束、或先手动停掉再装。');
  }),
  openReleasePage: vi.fn(async () => undefined),
  revealDownload: vi.fn(async () => undefined),
};

type Invoke = (event: unknown, ...args: unknown[]) => Promise<unknown>;

function invoke(method: string, sender: unknown, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(wanlongInvokeChannel(method as never)) as Invoke | undefined;
  if (!handler) throw new Error(`未注册 ${method}`);
  return handler({ sender, senderFrame: { url: appUrl } }, ...args);
}

describe('update IPC', () => {
  beforeAll(() => {
    registerWanlongIpcHandlers({
      updateCenter,
      windows: { kindOf: (sender: unknown) => (sender === liveSender ? 'live' : 'main') },
    } as unknown as WanlongServices);
  });

  it('每个 update* 方法都注册在 wanlong:<method>，且不与外壳方法重名', () => {
    for (const method of UPDATE_METHODS) {
      expect(WANLONG_INVOKE_METHODS).toContain(method);
      expect((INVOKE_METHODS as readonly string[]).includes(method)).toBe(false);
      expect(handlers.has(`wanlong:${method}`), method).toBe(true);
    }
  });

  it('状态读取与检查返回数据', async () => {
    await expect(invoke('updateState', mainSender)).resolves.toEqual({ ok: true, value: state });
    await expect(invoke('updateCheck', mainSender)).resolves.toEqual({ ok: true, value: state });
    await expect(invoke('updateOpenReleasePage', mainSender, 'https://evil.example/')).resolves.toEqual({ ok: true, value: undefined });
    // The renderer cannot choose a URL: extra arguments never reach the center.
    expect(updateCenter.openReleasePage).toHaveBeenCalledWith();
  });

  it('★ 安装被闸门拒绝时，中文原因与 CONCURRENCY_LIMIT 一起回到界面', async () => {
    await expect(invoke('updateInstall', mainSender)).resolves.toEqual({
      ok: false,
      error: { code: 'CONCURRENCY_LIMIT', message: expect.stringContaining('掐断') },
    });
  });

  it('★ 实时画面窗口不能触发安装或下载', async () => {
    updateCenter.install.mockClear();
    updateCenter.download.mockClear();
    await expect(invoke('updateInstall', liveSender)).resolves.toEqual({ ok: false, error: { message: '此操作仅允许在万龙助手主窗口执行' } });
    await expect(invoke('updateDownload', liveSender)).resolves.toMatchObject({ ok: false });
    expect(updateCenter.install).not.toHaveBeenCalled();
    expect(updateCenter.download).not.toHaveBeenCalled();
  });
});

describe('update 模块的引用边界', () => {
  const dir = join(here, '..', 'src', 'main', 'update');

  it('只有 electron-deps.ts 引用 electron；状态机、GitHub 端口与占用检查可在纯 Node 下测试', async () => {
    const files = (await readdir(dir)).filter((name) => name.endsWith('.ts'));
    expect(files).toEqual(expect.arrayContaining(['center.ts', 'github.ts', 'busy.ts', 'electron-deps.ts', 'index.ts']));
    for (const name of files) {
      const source = await readFile(join(dir, name), 'utf8');
      const importsElectron = /from ['"]electron['"]|import\(['"]electron['"]\)/.test(source);
      expect(importsElectron, name).toBe(name === 'electron-deps.ts');
    }
  });

  it('不引入 electron-updater（未签名的 macOS 应用无法经 Squirrel 替换，改走 DMG）', async () => {
    const pkg = JSON.parse(await readFile(join(here, '..', 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
    expect(pkg.dependencies?.['electron-updater']).toBeUndefined();
    for (const name of await readdir(dir)) {
      if (!name.endsWith('.ts')) continue;
      expect(await readFile(join(dir, name), 'utf8'), name).not.toMatch(/from ['"]electron-updater['"]/);
    }
  });
});
