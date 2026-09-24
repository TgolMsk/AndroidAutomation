import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => import('../../../packages/emulator-shell/test/helpers/electron-mock'));

import { AvdmError } from '@avdm/core';
import { BrowserWindow, handlers } from '../../../packages/emulator-shell/test/helpers/electron-mock';
import { broadcast } from '../src/main/events';
import { registerWanlongIpcHandlers, type WanlongServices } from '../src/main/ipc-handlers';
import { WANLONG_EVENT_CHANNEL, WANLONG_INVOKE_METHODS, wanlongInvokeChannel } from '../src/shared/ipc';

const here = dirname(fileURLToPath(import.meta.url));
const appUrl = `${pathToFileURL(join(here, '..', '..', '..', 'packages', 'emulator-shell', 'src', 'renderer', 'index.html')).href}#/`;

type Invoke = (event: unknown, ...args: unknown[]) => Promise<unknown>;

const status = { enabled: false, configured: false };
const fakes = {
  advisor: { status: vi.fn(async () => status) },
  automation: {
    runs: vi.fn(async () => []),
    stop: vi.fn(async () => { throw new AvdmError('LOCK_TIMEOUT', '实例 #1 正被占用'); }),
  },
  plans: {},
  accounts: {},
  insights: {},
  remoteBot: {},
  serviceHealth: { list: vi.fn(() => [{ name: '脚本计划', message: '坏文件', at: 1 }]) },
  windows: { kindOf: (sender: unknown) => (sender === liveSender ? 'live' : 'main') },
};
const mainSender = { id: 1 };
const liveSender = { id: 2 };

function invoke(method: string, sender: unknown, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(wanlongInvokeChannel(method as never)) as Invoke | undefined;
  if (!handler) throw new Error(`未注册 ${method}`);
  return handler({ sender, senderFrame: { url: appUrl } }, ...args);
}

describe('assistant IPC registration', () => {
  beforeAll(() => { registerWanlongIpcHandlers(fakes as unknown as WanlongServices); });

  it('registers every declared method on its wanlong:<method> channel', () => {
    for (const method of WANLONG_INVOKE_METHODS) expect(handlers.has(`wanlong:${method}`), method).toBe(true);
    expect([...handlers.keys()].filter((channel) => channel.startsWith('wanlong:'))).toHaveLength(WANLONG_INVOKE_METHODS.length);
  });

  it('returns values in an ok envelope', async () => {
    await expect(invoke('advisorStatus', mainSender)).resolves.toEqual({ ok: true, value: status });
    await expect(invoke('automationRuns', mainSender)).resolves.toEqual({ ok: true, value: [] });
    await expect(invoke('appServiceFailures', mainSender)).resolves.toEqual({
      ok: true, value: [{ name: '脚本计划', message: '坏文件', at: 1 }],
    });
  });

  it('returns failures as data, keeping the error code', async () => {
    await expect(invoke('stopAutomation', mainSender, 'run-1')).resolves.toEqual({
      ok: false, error: { message: '实例 #1 正被占用', code: 'LOCK_TIMEOUT' },
    });
    await expect(invoke('stopAutomation', mainSender, '')).resolves.toEqual({ ok: false, error: { message: '运行 ID无效' } });
    await expect(invoke('getAutomationSettings', mainSender, 'unknown-game', 0)).resolves.toMatchObject({ ok: false });
  });

  it('rejects other windows before any service runs', async () => {
    fakes.advisor.status.mockClear();
    await expect(invoke('advisorStatus', liveSender)).resolves.toEqual({
      ok: false, error: { message: '此操作仅允许在万龙助手主窗口执行' },
    });
    const handler = handlers.get('wanlong:advisorStatus') as Invoke;
    await expect(handler({ sender: mainSender, senderFrame: { url: 'https://example.com/' } })).resolves.toMatchObject({ ok: false });
    expect(fakes.advisor.status).not.toHaveBeenCalled();
  });
});

describe('assistant push events', () => {
  it('sends assistant events on the wanlong channel and log entries on the shell channel', () => {
    BrowserWindow.reset();
    const win = new BrowserWindow();
    const run = { runId: 'r', gameId: 'wanlong', taskId: 't', index: 0, status: 'running' as const, startedAt: 1, endedAt: null, message: '' };
    broadcast('automation-run', run);
    broadcast('log', { level: 'warn', message: '提示', at: 'now' });
    expect(win.webContents.sent).toEqual([
      [WANLONG_EVENT_CHANNEL, { channel: 'automation-run', payload: run }],
      ['avdm:event', { channel: 'log', payload: { level: 'warn', message: '提示', at: 'now' } }],
    ]);
    win.close();
    expect(() => broadcast('automation-run', run)).not.toThrow();
  });
});
