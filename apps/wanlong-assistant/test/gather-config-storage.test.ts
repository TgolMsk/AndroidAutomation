/**
 * Gather config storage (original features/gather/configStorage.ts + main gatherRunner.readGatherConfigFromAccount):
 * the config follows the bound account with the instance file as fallback, binding moves the instance copy into the
 * account and clears it (original afterAccountBind), the fallback copy is identity-aware, and saving refuses the
 * original validateGatherConfig errors instead of silently clamping them.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountManager } from '../src/main/automation/accounts';
import { AutomationHost } from '../src/main/automation/host';
import { AutomationSettingsStore } from '../src/main/automation/store';
import type { ManagerHost } from '../src/main/manager-host';
import { InstanceLocks } from '../src/main/scheduler/instance-lock';

const { broadcast } = vi.hoisted(() => ({ broadcast: vi.fn() }));
vi.mock('../src/main/events', () => ({ broadcast }));

const FIRST_AVD = '2026-09-24T00:00:00.000Z';
const SECOND_AVD = '2026-09-25T00:00:00.000Z';

let home: string;
let createdAt: string;
let host: AutomationHost;
let accounts: AccountManager;

beforeEach(async () => {
  broadcast.mockReset();
  home = await mkdtemp(path.join(tmpdir(), 'avdm-gather-config-'));
  createdAt = FIRST_AVD;
  const manager = {
    getState: vi.fn(async () => ({ status: 'running', record: { createdAt } })),
    device: async () => { throw new Error('no device in this test'); },
  };
  const managerHost = { get: async () => manager } as unknown as ManagerHost;
  const runner = { runOnce: vi.fn(), sample: vi.fn(), stop: vi.fn(async () => undefined), dispose: vi.fn(async () => undefined), isRunning: () => false };
  host = new AutomationHost(managerHost, home, runner as never, undefined, {}, {
    locks: new InstanceLocks(home, { fileLock: async (_path, fn) => fn() }), scheduler: { ownerLease: false },
  });
  // Wired exactly as main/index.ts does.
  accounts = new AccountManager(managerHost, host, home, {
    instanceGatherConfig: (gameId, index) => host.instanceGatherConfig(gameId, index),
    clearInstanceGatherConfig: (gameId, index) => host.clearInstanceGatherConfig(gameId, index),
  });
  host.setPorts({
    accountIdOf: async (index) => (await accounts.accountForInstance('wanlong', index))?.id ?? null,
    accountGatherConfig: (index) => accounts.gatherConfigFor('wanlong', index),
    saveAccountGatherConfig: async (accountId, config) => { await accounts.saveGatherConfig(accountId, config); },
  });
});

afterEach(async () => {
  await accounts.shutdown();
  await host.dispose();
  await rm(home, { recursive: true, force: true });
});

describe('save-time validation (original validateGatherConfig, not silent clamping)', () => {
  it('refuses error-level issues with the Chinese reasons and leaves the stored file untouched', async () => {
    await host.saveSettings('wanlong', 1, { templateDir: home, config: { version: 2, enabled: false } });
    await expect(host.saveSettings('wanlong', 1, {
      config: { version: 2, enabled: true, resources: [{ type: 'wood', enabled: true, priority: 1, queues: 20 }], schedule: { retryBackoffSeconds: [3, 60] } },
    })).rejects.toThrow('采集配置有错误（共 2 处），没有保存：「木材」的队列数必须在 0 ~ 5 之间，当前是 20；退避序列里每一项都必须 ≥ 5 秒。');
    expect((await host.settings('wanlong', 1)).config['enabled']).toBe(false);
  });

  it('accepts warnings (enabled resource with 0 queues) and stores the normalized document', async () => {
    const saved = await host.saveSettings('wanlong', 1, {
      templateDir: home, config: { version: 2, enabled: true, resources: [{ type: 'mana', enabled: true, priority: 4, queues: 0 }] },
    });
    expect(saved.config['version']).toBe(2);
    expect((saved.config['resources'] as Array<{ type: string; enabled: boolean }>).find((item) => item.type === 'mana')?.enabled).toBe(true);
  });

  it('refuses an incompatible version before validation', async () => {
    await expect(host.saveSettings('wanlong', 1, { config: { version: 1 } })).rejects.toThrow('万龙觉醒配置版本不兼容');
  });
});

describe('instance fallback copy is identity-aware', () => {
  it('stamps the AVD identity and flags a config saved for a replaced AVD at the same index', async () => {
    await host.saveSettings('wanlong', 2, { templateDir: home, config: { version: 2, enabled: true } });
    const file = path.join(home, 'automation', 'wanlong', '2.json');
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ configFor: FIRST_AVD });
    expect((await host.settings('wanlong', 2)).configReplaced).toBeUndefined();

    createdAt = SECOND_AVD; // the AVD at index 2 was deleted and recreated
    const view = await host.settings('wanlong', 2);
    expect(view.configReplaced).toBe(true);
    expect(view.config['enabled']).toBe(true);
    // Binding a new account never moves another AVD's config into it.
    expect(await host.instanceGatherConfig('wanlong', 2)).toBeNull();
    // Re-saving stamps the current AVD.
    await host.saveSettings('wanlong', 2, { config: view.config });
    expect((await host.settings('wanlong', 2)).configReplaced).toBeUndefined();
  });

  it('never flags files written before the stamp existed, and a template-only save keeps the stamp', async () => {
    const store = new AutomationSettingsStore(home);
    await store.save('wanlong', 3, { templateDir: home, config: { version: 2, enabled: true } });
    createdAt = SECOND_AVD;
    expect((await host.settings('wanlong', 3)).configReplaced).toBeUndefined();
    await store.save('wanlong', 4, { templateDir: home, config: { version: 2 } }, { configFor: FIRST_AVD });
    await store.save('wanlong', 4, { templateDir: home });
    expect((await store.get('wanlong', 4)).configFor).toBe(FIRST_AVD);
    await store.save('wanlong', 4, { config: {} }, { configFor: SECOND_AVD });
    expect((await store.get('wanlong', 4)).configFor).toBeUndefined();
  });
});

describe('config follows the account; binding migrates and clears the instance copy', () => {
  it('moves the instance config into a newly bound account, clears the instance copy, unbinding shows defaults', async () => {
    await host.saveSettings('wanlong', 1, { templateDir: home, config: { version: 2, enabled: true, safety: { maxCapturesPerCycle: 45 } } });
    const account = await accounts.create('wanlong', { name: '主号' });
    const bound = await accounts.bind(account.id, 1);
    expect(bound.notice).toContain('实例上保存的采集配置已搬到账号「主号」');
    expect((await accounts.gatherConfigFor('wanlong', 1))?.config).toMatchObject({ safety: { maxCapturesPerCycle: 45 } });
    // Original afterAccountBind removed the local copy: the instance file keeps only its template set.
    expect(await host.instanceGatherConfig('wanlong', 1)).toBeNull();
    expect((await host.instanceSettings('wanlong', 1)).templateDir).not.toBe('');

    const view = await host.settings('wanlong', 1);
    expect(view.configAccount).toEqual({ id: account.id, name: '主号' });

    const unbound = await accounts.bind(account.id, null);
    expect(unbound.notice).toBe('已解除绑定。采集配置仍留在账号「主号」里，绑回它就会回来。');
    const after = await host.settings('wanlong', 1);
    expect(after.configAccount).toBeUndefined();
    expect(after.config).toEqual({});
    // Binding it back brings the account's copy back.
    await accounts.bind(account.id, 1);
    expect((await host.settings('wanlong', 1)).config).toMatchObject({ safety: { maxCapturesPerCycle: 45 } });
  });

  it('keeps an existing account copy and says so instead of overwriting it', async () => {
    const account = await accounts.create('wanlong', { name: '副号' });
    await accounts.saveGatherConfig(account.id, { version: 2, enabled: false, safety: { maxCapturesPerCycle: 30 } });
    await host.saveSettings('wanlong', 1, { templateDir: home, config: { version: 2, enabled: true } });
    const bound = await accounts.bind(account.id, 1);
    expect(bound.notice).toContain('账号「副号」里本来就有一份采集配置，没有用实例上的那份覆盖');
    expect((await host.settings('wanlong', 1)).config).toMatchObject({ enabled: false, safety: { maxCapturesPerCycle: 30 } });
    // Not moved, so not cleared either.
    expect(await host.instanceGatherConfig('wanlong', 1)).toMatchObject({ enabled: true });
  });

  it('saves into the bound account (never the instance file) and validates the same way', async () => {
    const account = await accounts.create('wanlong', { name: '主号' });
    await host.saveSettings('wanlong', 1, { templateDir: home });
    await accounts.bind(account.id, 1);
    const saved = await host.saveSettings('wanlong', 1, { config: { version: 2, enabled: true } });
    expect(saved.configAccount).toEqual({ id: account.id, name: '主号' });
    expect(await host.instanceGatherConfig('wanlong', 1)).toBeNull();
    await expect(host.saveSettings('wanlong', 1, { config: { version: 2, safety: { maxCapturesPerCycle: 2 } } }))
      .rejects.toThrow('单轮派兵截图上限至少 6 张');
    expect((await accounts.gatherConfigFor('wanlong', 1))?.config['enabled']).toBe(true);
  });
});
