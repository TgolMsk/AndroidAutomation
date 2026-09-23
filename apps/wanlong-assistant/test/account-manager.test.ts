import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { withFileLock } from '@avdm/core';
import type { ManagerHost } from '../src/main/manager-host';
import type { AutomationHost } from '../src/main/automation/host';
import { AccountManager } from '../src/main/automation/accounts';

let home: string;
let accounts: AccountManager;
let probe: ReturnType<typeof vi.fn>;
let disableSchedule: ReturnType<typeof vi.fn>;
let startApp: ReturnType<typeof vi.fn>;
const createdAt = '2026-09-23T12:00:00.000Z';
const pkg = 'com.lilithgames.samo.android.cn';

async function until(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= end) throw new Error('timed out waiting for login phase');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'avdm-account-manager-'));
  startApp = vi.fn().mockResolvedValue(undefined);
  const state = { status: 'running', record: { index: 1, name: '实例 1', createdAt } };
  const device = {
    listPackages: vi.fn().mockResolvedValue([pkg]), startApp,
    foregroundPackage: vi.fn().mockResolvedValue(pkg),
  };
  const manager = {
    getState: vi.fn().mockResolvedValue(state),
    start: vi.fn().mockResolvedValue(state),
    device: vi.fn().mockResolvedValue(device),
  };
  const host = { get: vi.fn().mockResolvedValue(manager) } as unknown as ManagerHost;
  probe = vi.fn().mockResolvedValue({
    launchReady: true, launchReason: '已确认世界地图',
    matches: [{ templateId: 'tpl_world_search_icon', found: true }],
  });
  disableSchedule = vi.fn().mockResolvedValue({});
  const automation = {
    setSchedule: disableSchedule,
    schedules: vi.fn().mockResolvedValue([{ gameId: 'wanlong', index: 1, enabled: true }]),
    runs: vi.fn().mockResolvedValue([]),
    probe,
  } as unknown as AutomationHost;
  accounts = new AccountManager(host, automation, home);
});

afterEach(async () => {
  await accounts.shutdown();
  await rm(home, { recursive: true, force: true });
});

describe('AccountManager AVD login', () => {
  it('pauses automatic work, holds the instance lease, and enables only after a home proof', async () => {
    const account = await accounts.create('wanlong', { name: '主号', server: '一区' });
    const session = accounts.beginLogin('wanlong', 1, account.id);
    await until(() => accounts.loginSession(1)?.phase === 'awaitingLogin');
    expect(startApp).toHaveBeenCalledWith(pkg);
    expect(disableSchedule).toHaveBeenCalledWith('wanlong', 1, false);
    expect((await accounts.list('wanlong'))[0]).toMatchObject({ enabled: false, login: { status: 'pending' } });
    expect(await stat(path.join(home, 'run', 'automation-instance-1.lock'))).toBeDefined();
    await expect(accounts.verifyLogin(session.id, false)).rejects.toThrow('确认');
    const done = await accounts.verifyLogin(session.id, true);
    expect(done.phase).toBe('completed');
    expect(probe).toHaveBeenCalledWith('wanlong', 1);
    expect((await accounts.list('wanlong'))[0]).toMatchObject({ enabled: true, login: { status: 'ready' } });
    await expect(stat(path.join(home, 'run', 'automation-instance-1.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('leaves an account disabled after a failed read-only home check, then cancels cleanly', async () => {
    const account = await accounts.create('wanlong', { name: '小号' });
    probe.mockResolvedValue({ launchReady: false, launchReason: '画面不明确', matches: [] });
    const session = accounts.beginLogin('wanlong', 1, account.id);
    await until(() => accounts.loginSession(1)?.phase === 'awaitingLogin');
    await expect(accounts.verifyLogin(session.id, true)).rejects.toThrow('画面不明确');
    expect(accounts.loginSession(1)?.phase).toBe('awaitingLogin');
    expect((await accounts.list('wanlong'))[0]?.enabled).toBe(false);
    await accounts.cancelLogin(session.id);
    expect(accounts.loginSession(1)?.phase).toBe('cancelled');
    await expect(stat(path.join(home, 'run', 'automation-instance-1.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects account edits while a script owns the bound instance lease', async () => {
    const account = await accounts.create('wanlong', { name: '主号' });
    await accounts.bind(account.id, 1);
    await accounts.store.prepareLogin(account.id, { index: 1, instanceCreatedAt: createdAt }, '00000000-0000-4000-8000-000000000011');
    await accounts.store.completeLogin(account.id, { index: 1, instanceCreatedAt: createdAt }, '00000000-0000-4000-8000-000000000011');
    let unlock!: () => void;
    let locked!: () => void;
    const entered = new Promise<void>((resolve) => { locked = resolve; });
    const held = new Promise<void>((resolve) => { unlock = resolve; });
    const lease = withFileLock(path.join(home, 'run', 'automation-instance-1.lock'), async () => {
      locked();
      await held;
    });
    await entered;
    try {
      await expect(accounts.update(account.id, { name: '改名' })).rejects.toThrow('正被登录、采集或脚本计划占用');
      await expect(accounts.bind(account.id, null)).rejects.toThrow('正被登录、采集或脚本计划占用');
      await expect(accounts.setEnabled(account.id, false)).rejects.toThrow('正被登录、采集或脚本计划占用');
      await expect(accounts.remove(account.id)).rejects.toThrow('正被登录、采集或脚本计划占用');
      expect((await accounts.list('wanlong'))[0]).toMatchObject({ name: '主号', enabled: true,
        binding: { index: 1, instanceCreatedAt: createdAt } });
      expect(disableSchedule).not.toHaveBeenCalled();
    } finally {
      unlock();
      await lease;
    }
    expect((await accounts.update(account.id, { name: '改名' })).name).toBe('改名');
  });
});
