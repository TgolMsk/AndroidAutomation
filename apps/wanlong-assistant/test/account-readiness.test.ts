/**
 * The accounts readiness gate wired into gather (original `assertInstanceAutomationReady` + scheduler section of
 * `login-offline-check.ts`) and the accounts / instances IPC chain (instances-offline-check IPC section).
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
import { InstanceLocks } from '../src/main/scheduler/instance-lock';
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
  const automationReadiness = vi.fn<(gameId: string, index: number) => Promise<{ ready: boolean; reason?: string }>>();
  const panel = () => ({ sampledAt: Date.now(), queueUsed: 2, queueTotal: 5, rows: [], warnings: [] });
  const runner = {
    runOnce: vi.fn(), sample: vi.fn(async () => panel()),
    stop: vi.fn(async () => undefined), dispose: vi.fn(async () => undefined), isRunning: vi.fn(() => false),
  };
  /** The ETA scheduler with its test seams: no owner lease, no jitter, the instance lease faked. */
  const etaOptions = () => ({ locks: new InstanceLocks(home, { fileLock: async (_path: string, fn: () => Promise<unknown>) => fn() }) as InstanceLocks, scheduler: { ownerLease: false, random: () => 0 } });

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'avdm-account-gate-'));
    automationReadiness.mockReset();
    screencapRaw.mockClear();
    runner.runOnce.mockClear();
    runner.sample.mockClear();
    const manager = {
      getState: async () => ({ status: 'running', record: { createdAt: 'c1' } }),
      device: async () => ({ foregroundPackage: async () => wanlongPlugin.packageName, screencapRaw }),
    };
    host = new AutomationHost({ get: async () => manager } as unknown as ManagerHost, home, runner as never, undefined, { automationReadiness });
    await host.saveSettings('wanlong', 1, { templateDir: home, config: { version: 2, enabled: true } });
  });

  afterEach(async () => {
    await host.dispose();
    await rm(home, { recursive: true, force: true });
  });

  it('refuses to enable the schedule or start a manual run before any device read', async () => {
    automationReadiness.mockResolvedValue({ ready: false, reason: '基础实例用于克隆，请在副本中配置自动任务。' });
    await expect(host.setSchedule('wanlong', 1, true)).rejects.toThrow('基础实例用于克隆');
    await expect(host.run('wanlong', 'gather-once', 1)).rejects.toThrow('基础实例用于克隆');
    expect(automationReadiness).toHaveBeenCalledWith('wanlong', 1);
    expect(screencapRaw).not.toHaveBeenCalled();
    expect(runner.runOnce).not.toHaveBeenCalled();
    expect(runner.sample).not.toHaveBeenCalled();
    expect(await host.runs()).toEqual([]);
    // The resume path (alerts / bot: `eta.setAuto(i, true)`, no probe) meets the same gate.
    await expect(host.eta.setAuto(1, true)).rejects.toMatchObject({ code: 'AUTOMATION_NOT_READY', message: expect.stringContaining('基础实例用于克隆') });
    expect(host.eta.isAuto(1)).toBe(false);
    // So does the panel's「立即刷新」: a base instance is never driven, not even read-only.
    await expect(host.eta.sampleNow(1)).rejects.toThrow('基础实例用于克隆');
    expect(runner.sample).not.toHaveBeenCalled();
    // Switching off never consults the gate: a pause always wins.
    automationReadiness.mockClear();
    await expect(host.setSchedule('wanlong', 1, false)).resolves.toMatchObject({ enabled: false });
    expect(automationReadiness).not.toHaveBeenCalled();
  });

  it('pauses a scheduled wake the gate refuses at once, without counting a failure', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      // A schedule enabled before this gate existed (the pre-ETA switch, migrated at restore) meets a pending bound
      // account at its next wake.
      const file = join(home, 'automation', 'scheduler', 'wanlong', '1.json');
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify({ version: 1, gameId: 'wanlong', index: 1, enabled: true, nextWakeAt: 0, failureCount: 2 }));
      const reason = '账号「主号」尚未完成登录检查，或绑定实例已改变。请在账号登录向导中继续。';
      automationReadiness.mockResolvedValue({ ready: false, reason });
      const onScheduleStop = vi.fn(async () => undefined);
      const onSchedulePause = vi.fn(async () => undefined);
      const manager = {
        getState: async () => ({ status: 'running', record: { createdAt: 'c1' } }),
        device: async () => ({ foregroundPackage: async () => wanlongPlugin.packageName, screencapRaw }),
      };
      const scheduled = new AutomationHost({ get: async () => manager } as unknown as ManagerHost, home, runner as never, undefined,
        { automationReadiness, onScheduleStop, onSchedulePause }, etaOptions());
      const autoChanges: Array<{ enabled: boolean; reason?: string }> = [];
      scheduled.eta.setHooks({ onAutoChanged: (_index, enabled, _at, reason) => { autoChanges.push({ enabled, ...(reason ? { reason } : {}) }); } });
      try {
        await scheduled.restoreSchedules();
        expect(scheduled.eta.isAuto(1)).toBe(true);
        await vi.advanceTimersByTimeAsync(60_000);
        await vi.waitFor(() => expect(onSchedulePause).toHaveBeenCalledWith('wanlong', 1, reason));
        // Paused on the ETA scheduler itself: auto off with the reason, no wake left, failure count cleared.
        expect(scheduled.eta.getState(1)).toMatchObject({ auto: false, nextWakeAt: null, failureCount: 0 });
        // The pause / resume statistics source (`onAutoChanged`) carries the gate's reason.
        expect(autoChanges).toEqual([{ enabled: false, reason: `自动续跑已暂停（不计为失败）：${reason}` }]);
        expect(scheduled.eta.listWakes()).toEqual([]);
        expect(onScheduleStop).not.toHaveBeenCalled(); // no 「连续失败」 alert
        expect(automationReadiness).toHaveBeenCalledTimes(1); // no backoff retries
        expect(runner.sample).not.toHaveBeenCalled();
        expect(runner.runOnce).not.toHaveBeenCalled();
        expect(screencapRaw).not.toHaveBeenCalled();
        expect(await scheduled.runs()).toEqual([]);
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(automationReadiness).toHaveBeenCalledTimes(1);
      } finally {
        await scheduled.dispose();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('pauses when the account becomes unready between an enable and the dispatch wake', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      await host.dispose();
      const onSchedulePause = vi.fn(async () => undefined);
      const onCycleResult = vi.fn(async () => undefined);
      automationReadiness.mockResolvedValue({ ready: true });
      const manager = {
        getState: async () => ({ status: 'running', record: { createdAt: 'c1' } }),
        device: async () => ({ foregroundPackage: async () => wanlongPlugin.packageName, screencapRaw }),
      };
      host = new AutomationHost({ get: async () => manager } as unknown as ManagerHost, home, runner as never, undefined,
        { automationReadiness, onSchedulePause, onCycleResult }, etaOptions());
      vi.spyOn(host, 'probe').mockResolvedValue({
        gameId: 'wanlong', packageName: wanlongPlugin.packageName, foregroundPackage: wanlongPlugin.packageName, deviceWidth: 2560,
        deviceHeight: 1440, capturedAt: Date.now(), matches: [], launchReady: true, launchReason: '已确认世界地图画面', timingsMs: {},
      });
      await host.saveSettings('wanlong', 1, { templateDir: home, config: { version: 2, enabled: true } });
      expect((await host.setSchedule('wanlong', 1, true)).enabled).toBe(true);
      expect(runner.sample).toHaveBeenCalledTimes(1);
      // The panel shows a free slot; before the dispatch the account is reset to 待登录 (e.g. rebound elsewhere).
      automationReadiness.mockResolvedValue({ ready: false, reason: '账号「主号」尚未完成登录检查' });
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.waitFor(() => expect(onSchedulePause).toHaveBeenCalledWith('wanlong', 1, '账号「主号」尚未完成登录检查'));
      expect(host.eta.getState(1)).toMatchObject({ auto: false, failureCount: 0 });
      expect(runner.runOnce).not.toHaveBeenCalled();
      expect(onCycleResult).not.toHaveBeenCalled(); // a verdict, not a failed cycle
    } finally {
      vi.useRealTimers();
    }
  });

  it('still counts a gate that could not decide as a failure with backoff', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const file = join(home, 'automation', 'scheduler', 'wanlong', '1.json');
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify({ version: 1, gameId: 'wanlong', index: 1, enabled: true, nextWakeAt: 0, failureCount: 0 }));
      automationReadiness.mockRejectedValue(new Error('账号文件无法读取'));
      const onSchedulePause = vi.fn(async () => undefined);
      const manager = { getState: async () => ({ status: 'running', record: { createdAt: 'c1' } }), device: async () => ({}) };
      const scheduled = new AutomationHost({ get: async () => manager } as unknown as ManagerHost, home, runner as never, undefined,
        { automationReadiness, onSchedulePause }, etaOptions());
      try {
        await scheduled.restoreSchedules();
        await vi.advanceTimersByTimeAsync(60_000);
        await vi.waitFor(() => expect(scheduled.eta.getState(1).failureCount).toBe(1));
        expect(scheduled.eta.getState(1)).toMatchObject({ auto: true, nextWakeAt: expect.any(Number) });
        expect(scheduled.eta.getState(1).nextWakeReason).toContain('退避重试');
        expect(onSchedulePause).not.toHaveBeenCalled();
      } finally {
        await scheduled.dispose();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets a disable issued during the readiness check win', async () => {
    const approval = gate();
    automationReadiness.mockImplementationOnce(async () => { await approval.promise; return { ready: false, reason: '账号「主号」尚未完成登录检查' }; });
    const enable = host.setSchedule('wanlong', 1, true).catch((error: unknown) => error as Error);
    // The disable arrives while the gate is still deciding (not before the enable reached it).
    await vi.waitFor(() => expect(automationReadiness).toHaveBeenCalledTimes(1));
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
