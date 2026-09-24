/**
 * The accounts readiness gate wired into gather (original `assertInstanceAutomationReady` + scheduler section of
 * `login-offline-check.ts`) and the accounts / instances IPC chain (instances-offline-check IPC section).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path, { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => import('../../../packages/emulator-shell/test/helpers/electron-mock'));
const { broadcast } = vi.hoisted(() => ({ broadcast: vi.fn() }));
vi.mock('../src/main/events', () => ({ broadcast }));

import { AvdmError } from '@avdm/core';
import { wanlongPlugin } from '@avdm/automation/wanlong';
import { handlers } from '../../../packages/emulator-shell/test/helpers/electron-mock';
import { AutomationHost } from '../src/main/automation/host';
import { registerWanlongIpcHandlers, type WanlongServices } from '../src/main/ipc-handlers';
import { InstanceProvisioner } from '../src/main/instances/provisioner';
import type { ManagerHost } from '../src/main/manager-host';
import { wanlongInvokeChannel } from '../src/shared/ipc';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

describe('gather refuses what the accounts gate refuses', () => {
  let home: string;
  let host: AutomationHost;
  const screencapRaw = vi.fn(async () => ({ width: 1, height: 1, data: new Uint8Array(4) }));
  const ensureAutomationReady = vi.fn<(gameId: string, index: number) => Promise<void>>();
  const runner = { runOnce: vi.fn(), stop: vi.fn(async () => undefined), dispose: vi.fn(async () => undefined), isRunning: vi.fn(() => false) };

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'avdm-account-gate-'));
    ensureAutomationReady.mockReset();
    screencapRaw.mockClear();
    runner.runOnce.mockClear();
    const manager = {
      getState: async () => ({ status: 'running', record: { createdAt: 'c1' } }),
      device: async () => ({ foregroundPackage: async () => wanlongPlugin.packageName, screencapRaw }),
    };
    host = new AutomationHost({ get: async () => manager } as unknown as ManagerHost, home, runner as never, undefined, { ensureAutomationReady });
    await host.saveSettings('wanlong', 1, { templateDir: home, config: { version: 2, enabled: true } });
  });

  afterEach(async () => {
    await host.dispose();
    await rm(home, { recursive: true, force: true });
  });

  it('refuses to enable the schedule or start a manual run before any device read', async () => {
    ensureAutomationReady.mockRejectedValue(new Error('基础实例用于克隆，请在副本中配置自动任务。'));
    await expect(host.setSchedule('wanlong', 1, true)).rejects.toThrow('基础实例用于克隆');
    await expect(host.run('wanlong', 'gather-once', 1)).rejects.toThrow('基础实例用于克隆');
    expect(ensureAutomationReady).toHaveBeenCalledWith('wanlong', 1);
    expect(screencapRaw).not.toHaveBeenCalled();
    expect(runner.runOnce).not.toHaveBeenCalled();
    expect(await host.runs()).toEqual([]);
    // Switching off never consults the gate: a pause always wins.
    await expect(host.setSchedule('wanlong', 1, false)).resolves.toMatchObject({ enabled: false });
  });

  it('lets a disable issued during the readiness check win', async () => {
    const approval = gate();
    ensureAutomationReady.mockImplementationOnce(async () => { await approval.promise; throw new Error('账号「主号」尚未完成登录检查'); });
    const enable = host.setSchedule('wanlong', 1, true).catch((error: unknown) => error as Error);
    const disable = host.setSchedule('wanlong', 1, false);
    approval.release();
    expect((await enable)?.message).toContain('尚未完成登录检查');
    expect(await disable).toMatchObject({ enabled: false });
    expect((await host.schedules()).some((item) => item.index === 1 && item.enabled)).toBe(false);
    expect(screencapRaw).not.toHaveBeenCalled();
  });
});

describe('accounts and instances IPC', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const appUrl = `${pathToFileURL(join(here, '..', '..', '..', 'packages', 'emulator-shell', 'src', 'renderer', 'index.html')).href}#/`;
  let home: string;
  const accounts = {
    bind: vi.fn(async () => ({ account: {}, displaced: null })),
    loginInput: vi.fn(async () => undefined),
    beginLogin: vi.fn(() => ({})),
    readiness: vi.fn(async () => ({ ready: true })),
  };

  function invoke(method: string, ...args: unknown[]): Promise<unknown> {
    const handler = handlers.get(wanlongInvokeChannel(method as never)) as (event: unknown, ...a: unknown[]) => Promise<unknown>;
    return handler({ sender: { id: 1 }, senderFrame: { url: appUrl } }, ...args);
  }

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'avdm-instances-ipc-'));
    const list = [{ index: 3, name: '基础', createdAt: 'c3', status: 'stopped' }];
    const manager = {
      getState: async (index: number) => {
        const found = list.find((item) => item.index === index);
        if (!found) throw new AvdmError('INSTANCE_NOT_FOUND', 'missing');
        return { status: found.status, record: { index, name: found.name, createdAt: found.createdAt } };
      },
      clone: async (_from: number, opts: { count: number }) => Array.from({ length: opts.count }, (_, i) => ({ index: 20 + i, name: `基础-${20 + i}` })),
    };
    const provisioner = new InstanceProvisioner({ get: async () => manager } as unknown as ManagerHost, home, {
      settings: async () => ({ templateDir: '', config: {} }),
      saveSettings: async () => ({ templateDir: '', config: {} }),
      disableSchedule: async () => undefined,
      busyReason: () => null,
      boundAccountName: async () => null,
      freeBytes: async () => 1024 ** 4,
    });
    registerWanlongIpcHandlers({ accounts, provisioner, windows: { kindOf: () => 'main' } } as unknown as WanlongServices);
  });

  afterEach(async () => { await rm(home, { recursive: true, force: true }); });

  it('sets a base, clones from it and cancels it through the handlers', async () => {
    await expect(invoke('instanceBase', 'wanlong')).resolves.toMatchObject({ ok: true, value: { base: null } });
    await expect(invoke('instanceSetBase', 'wanlong', 3)).resolves.toMatchObject({ ok: true, value: { base: { index: 3 } } });
    await expect(invoke('instanceCloneFromBase', 'wanlong', { count: 2, expectedBaseIndex: 3 })).resolves.toMatchObject({
      ok: true, value: { baseIndex: 3, created: [{ index: 20 }, { index: 21 }] },
    });
    await expect(invoke('instanceCloneFromBase', 'wanlong', { count: 2, expectedBaseIndex: 3, rotateIdentity: 'yes' }))
      .resolves.toMatchObject({ ok: false, error: { message: '设备标识选项无效' } });
    await expect(invoke('instanceCloneFromBase', 'wanlong', null)).resolves.toMatchObject({ ok: false });
    await expect(invoke('instanceSetBase', 'wanlong', null)).resolves.toMatchObject({ ok: true, value: { base: null } });
    await expect(invoke('instanceSetBase', 'unknown-game', 3)).resolves.toMatchObject({ ok: false });
  });

  it('validates bind options, login targets and preview input shapes before the service runs', async () => {
    await invoke('accountBind', 'acc', 2, { takeOver: true });
    expect(accounts.bind).toHaveBeenLastCalledWith('acc', 2, { takeOver: true });
    await invoke('accountBind', 'acc', null);
    expect(accounts.bind).toHaveBeenLastCalledWith('acc', null, { takeOver: false });
    await expect(invoke('accountBind', 'acc', 2, { takeOver: 'yes' })).resolves.toMatchObject({ ok: false, error: { message: '改绑确认无效' } });
    await expect(invoke('accountLoginInput', 'session', 'tap')).resolves.toMatchObject({ ok: false, error: { message: '登录输入无效' } });
    await expect(invoke('accountBeginLogin', 'wanlong', 1, 'id', '')).resolves.toMatchObject({ ok: false, error: { message: '新账号名称无效' } });
    await expect(invoke('accountInstanceReadiness', 'wanlong', 70)).resolves.toMatchObject({ ok: false });
    expect(accounts.readiness).not.toHaveBeenCalled();
  });
});
