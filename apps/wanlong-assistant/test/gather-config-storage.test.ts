/**
 * Gather config storage (original features/gather/configStorage.ts + main gatherRunner.readGatherConfigFromAccount):
 * the config follows the bound account with the instance file as fallback, binding moves the instance copy into the
 * account and clears it (original afterAccountBind), the fallback copy is identity-aware, and saving refuses the
 * original validateGatherConfig errors instead of silently clamping them.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountManager } from '../src/main/automation/accounts';
import { AccountStore } from '../src/main/automation/accounts/store';
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

  it('refuses wrong types instead of letting normalization turn them into clamped numbers', async () => {
    await host.saveSettings('wanlong', 1, { templateDir: home, config: { version: 2, enabled: false } });
    // "9" used to pass (coerce → default 1) and then be stored as 5 (normalize → Number("9") clamped).
    await expect(host.saveSettings('wanlong', 1, { config: { version: 2, resources: [{ type: 'wood', enabled: true, priority: 1, queues: '9' }] } }))
      .rejects.toThrow('「resources.wood.queues」必须是数字，当前是 "9"');
    await expect(host.saveSettings('wanlong', 1, { config: { version: 2, enabled: 'yes' } })).rejects.toThrow('「enabled」只能是 true 或 false');
    expect((await host.settings('wanlong', 1)).config['enabled']).toBe(false);
  });

  it('validates the per-resource overrides that normalization would clamp', async () => {
    await expect(host.saveSettings('wanlong', 1, { templateDir: home, config: {
      version: 2,
      resources: [{ type: 'gold', enabled: true, priority: 2, queues: 1, levelPolicy: { mode: 'absolute', level: 7, minLevel: 9, allowRelax: true, maxLevelHardCap: 15 }, minStorage: -1 }],
    } })).rejects.toThrow('「金币」单独设置的「可放宽到的最低值 9」比「固定搜索下限 7」还高');
  });

  it('stores the normalization of the validated document (overrides kept, fixed resource set)', async () => {
    const saved = await host.saveSettings('wanlong', 1, { templateDir: home, config: {
      version: 2, resources: [{ type: 'iron', enabled: true, priority: 3, queues: 2, maxTravelSeconds: 300 }],
    } });
    const iron = (saved.config['resources'] as Array<Record<string, unknown>>).find((item) => item['type'] === 'iron');
    expect(iron).toMatchObject({ queues: 2, maxTravelSeconds: 300 });
    expect(saved.config['resources']).toHaveLength(4);
  });
});

describe('a broken settings file can be repaired from the gather config page', () => {
  const fileOf = (index: number) => path.join(home, 'automation', 'wanlong', `${index}.json`);
  async function writeRaw(index: number, text: string): Promise<void> {
    await mkdir(path.dirname(fileOf(index)), { recursive: true });
    await writeFile(fileOf(index), text);
  }

  it('bad JSON: the page read shows defaults with the reason, saving rebuilds the file and keeps a backup', async () => {
    await writeRaw(1, '{ not json');
    const view = await host.settings('wanlong', 1);
    expect(view.settingsError).toContain('自动化配置无法读取');
    expect(view.settingsError).toContain('点「保存」即可重建');
    expect(view.config).toEqual({});
    // Runs and template-only edits stay strict.
    await expect(host.instanceSettings('wanlong', 1)).rejects.toThrow('自动化配置无法读取');
    await expect(host.saveSettings('wanlong', 1, { templateDir: home })).rejects.toThrow('自动化配置无法读取');

    const saved = await host.saveSettings('wanlong', 1, { config: { version: 2, enabled: true } });
    expect(saved.settingsError).toBeUndefined();
    expect(saved.config['enabled']).toBe(true);
    expect(await readFile(`${fileOf(1)}.corrupt`, 'utf8')).toBe('{ not json');
    expect((await host.instanceSettings('wanlong', 1)).config['enabled']).toBe(true);
  });

  it('wrong shape: the template set the file still names survives the repair', async () => {
    await writeRaw(2, JSON.stringify({ version: 7, templateDir: home, config: 'x' }));
    const view = await host.settings('wanlong', 2);
    expect(view.settingsError).toContain('自动化配置格式不兼容');
    expect(view.templateDir).toBe(home);
    const saved = await host.saveSettings('wanlong', 2, { config: { version: 2 } });
    expect(saved.settingsError).toBeUndefined();
    expect(saved.templateDir).not.toBe('');
  });

  it('account-bound: a broken instance file never hides the account copy, and saving rebuilds both', async () => {
    const account = await accounts.create('wanlong', { name: '主号' });
    await host.saveSettings('wanlong', 1, { templateDir: home });
    await accounts.bind(account.id, 1);
    await host.saveSettings('wanlong', 1, { config: { version: 2, enabled: true } });
    await writeRaw(1, JSON.stringify({ version: 1, templateDir: home, config: [] }));

    const view = await host.settings('wanlong', 1);
    expect(view.configAccount).toEqual({ id: account.id, name: '主号' });
    expect(view.config['enabled']).toBe(true);
    expect(view.settingsError).toContain('自动化配置格式不兼容');

    const saved = await host.saveSettings('wanlong', 1, { config: { version: 2, enabled: false } });
    expect(saved.settingsError).toBeUndefined();
    expect(saved.configAccount?.name).toBe('主号');
    expect((await accounts.gatherConfigFor('wanlong', 1))?.config['enabled']).toBe(false);
    expect((await host.instanceSettings('wanlong', 1)).templateDir).not.toBe('');
  });

  it('a corrupt account copy shows defaults with accountConfigError (not the instance copy), and saving fixes it', async () => {
    const account = await accounts.create('wanlong', { name: '主号' });
    await host.saveSettings('wanlong', 1, { templateDir: home });
    await accounts.bind(account.id, 1);
    await host.saveSettings('wanlong', 1, { config: { version: 2, enabled: true } });
    await new AccountStore(home).setScriptParams(account.id, 'gather', { configJson: '{ broken' });

    const view = await host.settings('wanlong', 1);
    expect(view.accountConfigError).toContain('账号「主号」里保存的采集配置已损坏');
    expect(view.config).toEqual({});
    expect(view.configAccount).toBeUndefined();

    const saved = await host.saveSettings('wanlong', 1, { config: { version: 2, enabled: true } });
    expect(saved.accountConfigError).toBeUndefined();
    expect(saved.configAccount?.name).toBe('主号');
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
    // ★ Runs never use it: the manual run is refused with the Chinese reason until it is re-saved.
    await expect(host.run('wanlong', 'gather-once', 2)).rejects.toThrow('已删除的旧实例留下的，不会按序号沿用');
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
