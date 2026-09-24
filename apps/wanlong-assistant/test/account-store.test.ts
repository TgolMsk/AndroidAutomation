import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AccountStore } from '../src/main/automation/accounts/store';
import { previewLegacyAccounts } from '../src/main/automation/accounts/legacy';

const PKG = 'com.lilithgames.samo.android.cn';
const ATTEMPT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NEW_ID = '11111111-2222-4333-8444-555555555555';
let home: string;
let store: AccountStore;

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'avdm-account-'));
  store = new AccountStore(home);
});

afterEach(async () => { await rm(home, { recursive: true, force: true }); });

describe('AccountStore', () => {
  it('persists private metadata without credentials and preserves verified state on edit', async () => {
    const account = await store.create('wanlong', PKG, { name: '主号', server: '一区', role: '角色甲', note: '采集' });
    await store.bind(account.id, { index: 1, instanceCreatedAt: '2026-09-23T00:00:00.000Z' });
    await store.prepareLogin(account.id, { index: 1, instanceCreatedAt: '2026-09-23T00:00:00.000Z' }, ATTEMPT);
    await store.completeLogin(account.id, { index: 1, instanceCreatedAt: '2026-09-23T00:00:00.000Z' }, ATTEMPT);
    const updated = await store.update(account.id, { name: '主号甲' });
    expect(updated.name).toBe('主号甲');
    expect(updated.login.status).toBe('ready');
    expect(updated.enabled).toBe(true);
    const saved = await readFile(store.file, 'utf8');
    expect(saved).toContain('主号甲');
    expect(saved).not.toMatch(/phone|password|verificationCode/i);
    expect(JSON.parse(saved).version).toBe(2);
    if (process.platform !== 'win32') expect((await stat(store.file)).mode & 0o777).toBe(0o600);
  });

  it('enforces one account per game and AVD, but permits another game on the same AVD', async () => {
    const a = await store.create('wanlong', PKG, { name: 'A' });
    const b = await store.create('wanlong', PKG, { name: 'B' });
    const c = await store.create('other', 'com.example.other', { name: 'C' });
    const binding = { index: 2, instanceCreatedAt: 'created' };
    await store.bind(a.id, binding);
    await expect(store.bind(b.id, binding)).rejects.toMatchObject({ code: 'ACCOUNT_SLOT_TAKEN', message: expect.stringContaining('已绑定「A」') });
    await store.bind(c.id, binding);
    expect((await store.list()).filter((item) => item.binding?.index === 2)).toHaveLength(2);
  });

  it('takes an instance over only when confirmed, resetting and disabling the displaced account', async () => {
    const a = await store.create('wanlong', PKG, { name: 'A' });
    const b = await store.create('wanlong', PKG, { name: 'B' });
    const binding = { index: 3, instanceCreatedAt: 'created' };
    await store.prepareLogin(a.id, binding, ATTEMPT);
    await store.completeLogin(a.id, binding, ATTEMPT);
    const { account, displaced } = await store.bind(b.id, binding, { takeOver: true });
    expect(account.binding).toEqual(binding);
    expect(displaced).toMatchObject({ id: a.id, binding: null, enabled: false, login: { status: 'pending', attemptId: null, verifiedAt: null } });
    expect((await store.get(a.id))).toMatchObject({ binding: null, enabled: false });
    // Taking over a free instance reports nobody displaced.
    expect((await store.bind(a.id, { index: 4, instanceCreatedAt: 'x' }, { takeOver: true })).displaced).toBeNull();
  });

  it('rejects stale login attempts and invalidates verification when an index is reused, keeps it on an identical rebind', async () => {
    const a = await store.create('wanlong', PKG, { name: 'A' });
    const first = { index: 1, instanceCreatedAt: 'old' };
    const next = { index: 1, instanceCreatedAt: 'new' };
    await store.prepareLogin(a.id, first, ATTEMPT);
    await expect(store.completeLogin(a.id, first, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')).rejects.toThrow('已变化');
    await store.completeLogin(a.id, first, ATTEMPT);
    const same = await store.bind(a.id, first);
    expect(same.account).toMatchObject({ enabled: true, login: { status: 'ready' } });
    const rebound = (await store.bind(a.id, next)).account;
    expect(rebound.login.status).toBe('pending');
    expect(rebound.enabled).toBe(false);
    await expect(store.setEnabled(a.id, true)).rejects.toThrow('请先完成登录向导');
    await expect(store.completeLogin(a.id, first, ATTEMPT)).rejects.toThrow('已变化');
  });

  it('never lets a details edit forge login state, the enable switch or the binding', async () => {
    const a = await store.create('wanlong', PKG, { name: 'A' });
    const forged = await store.update(a.id, { name: 'B', enabled: true, login: { status: 'ready' }, binding: { index: 1 } } as never);
    expect(forged).toMatchObject({ name: 'B', enabled: false, binding: null, login: { status: 'pending' } });
  });

  it('prepares a login without stealing, creating a new account idempotently under the client id', async () => {
    const binding = { index: 5, instanceCreatedAt: 'c5' };
    const create = { gameId: 'wanlong', packageName: PKG, details: { name: '新号' } };
    const first = await store.prepareLogin(NEW_ID, binding, ATTEMPT, create);
    expect(first).toMatchObject({ id: NEW_ID, name: '新号', enabled: false, binding, login: { status: 'pending', attemptId: ATTEMPT } });
    await store.prepareLogin(NEW_ID, binding, ATTEMPT, create);
    expect(await store.list('wanlong')).toHaveLength(1);
    const other = await store.create('wanlong', PKG, { name: '别的号' });
    await expect(store.prepareLogin(other.id, binding, ATTEMPT)).rejects.toMatchObject({ code: 'ACCOUNT_SLOT_TAKEN' });
    await expect(store.prepareLogin(NEW_ID, { index: 6, instanceCreatedAt: 'c6' }, ATTEMPT)).rejects.toMatchObject({ code: 'ACCOUNT_BOUND_ELSEWHERE' });
    await expect(store.prepareLogin('22222222-2222-4222-8222-222222222222', binding, ATTEMPT)).rejects.toThrow('账号不存在');
    // A client id is idempotent for create() too, and never crosses games.
    expect((await store.create('wanlong', PKG, { name: '重复' }, { id: NEW_ID })).name).toBe('新号');
    await expect(store.create('other', 'com.example.other', { name: 'X' }, { id: NEW_ID })).rejects.toMatchObject({ code: 'ACCOUNT_ID_TAKEN' });
    await expect(store.create('wanlong', PKG, { name: 'X' }, { id: 'not-a-uuid' })).rejects.toThrow('账号编号无效');
  });

  it('stores the default script and bounded per-script parameters', async () => {
    const a = await store.create('wanlong', PKG, { name: 'A' }, { defaultScriptId: 'daily' });
    expect(a.defaultScriptId).toBe('daily');
    const withParams = await store.setScriptParams(a.id, 'daily', { rounds: 3, fast: true, city: '一区' });
    expect(withParams.scriptParams).toEqual({ daily: { rounds: 3, fast: true, city: '一区' } });
    await store.setScriptParams(a.id, 'gather', { configJson: JSON.stringify({ version: 2 }) });
    expect(Object.keys((await store.get(a.id))!.scriptParams!)).toEqual(['daily', 'gather']);
    expect((await store.setScriptParams(a.id, 'daily', null)).scriptParams).toEqual({ gather: { configJson: '{"version":2}' } });
    expect((await store.update(a.id, { defaultScriptId: null })).defaultScriptId).toBeUndefined();
    await expect(store.update(a.id, { defaultScriptId: '../escape' })).rejects.toThrow('默认脚本编号无效');
    await expect(store.setScriptParams(a.id, 'daily', { 'bad key': 1 })).rejects.toThrow('参数名无效');
    await expect(store.setScriptParams(a.id, 'daily', { n: Number.NaN })).rejects.toThrow('参数值');
    await expect(store.setScriptParams(a.id, 'daily', { nested: { a: 1 } } as never)).rejects.toThrow('参数值');
    await expect(store.setScriptParams(a.id, 'daily', Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`k${i}`, i]))))
      .rejects.toThrow('最多保存 64 个参数');
    await expect(store.setScriptParams(a.id, 'big', { a: 'x'.repeat(65 * 1024) })).rejects.toThrow('64 KB');
    for (let i = 0; i < 2; i++) await store.setScriptParams(a.id, `s${i}`, { v: 'y'.repeat(60 * 1024) });
    await expect(store.setScriptParams(a.id, 's2', { v: 'y'.repeat(60 * 1024) })).rejects.toThrow('128 KB');
  });

  it('upgrades a version 1 file on the next write without losing records', async () => {
    const v1 = {
      version: 1,
      accounts: [{
        id: '33333333-3333-4333-8333-333333333333', gameId: 'wanlong', packageName: PKG, name: '旧号', server: '', role: '',
        note: '', enabled: false, binding: null, login: { status: 'pending', attemptId: null, verifiedAt: null },
        createdAt: 1, updatedAt: 1,
      }],
    };
    await mkdir(path.dirname(store.file), { recursive: true });
    await writeFile(store.file, JSON.stringify(v1));
    expect((await store.list('wanlong'))[0]).toMatchObject({ name: '旧号' });
    await store.update(v1.accounts[0]!.id, { defaultScriptId: 'daily' });
    const saved = JSON.parse(await readFile(store.file, 'utf8'));
    expect(saved.version).toBe(2);
    expect(saved.accounts[0]).toMatchObject({ name: '旧号', defaultScriptId: 'daily' });
    await writeFile(store.file, JSON.stringify({ ...v1, version: 3 }));
    await expect(store.list()).rejects.toThrow('格式不兼容');
  });

  it('serializes concurrent creation and refuses corrupted files without overwriting them', async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.create('wanlong', PKG, { name: `号 ${i}` })));
    expect(await store.list('wanlong')).toHaveLength(20);
    const corrupt = '{ broken';
    await writeFile(store.file, corrupt);
    await expect(store.create('wanlong', PKG, { name: 'X' })).rejects.toThrow('无法读取');
    expect(await readFile(store.file, 'utf8')).toBe(corrupt);
  });
});

describe('legacy wanlong-panel accounts.json', () => {
  const legacy = {
    version: 1,
    accounts: [
      { id: 'acc_main', name: '主号', packageName: PKG, instanceIndex: 1, note: '一区\n王朝', defaultScriptId: 'daily',
        scriptParams: { daily: { rounds: 2 }, gather: { configJson: '{"version":2}' } }, enabled: true,
        setup: { status: 'ready', instanceIdentity: 'mumu:1', verifiedAt: 1 }, createdAt: 1, updatedAt: 1 },
      { id: 'acc_other', name: '别的游戏', packageName: 'com.example.other', instanceIndex: null, enabled: false, createdAt: 1, updatedAt: 1 },
      { id: 'acc_main', name: '重复', instanceIndex: null, enabled: false, createdAt: 1, updatedAt: 1 },
      { id: 'acc_bad_params', name: '参数坏了', instanceIndex: 2, scriptParams: { daily: { nested: { a: 1 } } }, enabled: true, createdAt: 1, updatedAt: 1 },
      { id: '', name: '' },
    ],
  };

  it('previews importable rows and skips other games, duplicates and nameless rows', () => {
    const { entries, rows } = previewLegacyAccounts(legacy, PKG);
    expect(entries.map((entry) => [entry.oldId, entry.importable])).toEqual([
      ['acc_main', true], ['acc_other', false], ['acc_main', false], ['acc_bad_params', true], ['', false],
    ]);
    expect(entries[0]).toMatchObject({ note: '一区 王朝', defaultScriptId: 'daily', scriptParamCount: 2 });
    expect(entries[3]?.reason).toContain('脚本参数格式不兼容');
    expect(rows.map((row) => row.oldId)).toEqual(['acc_main', 'acc_bad_params']);
    expect(() => previewLegacyAccounts({ version: 2, accounts: [] }, PKG)).toThrow('不是旧版');
  });

  it('imports unbound, pending and disabled accounts and returns the old → new id map', async () => {
    const { rows } = previewLegacyAccounts(legacy, PKG);
    const { idMap: map, created } = await store.importLegacy('wanlong', PKG, rows);
    expect(created).toBe(2);
    const imported = await store.list('wanlong');
    expect(imported).toHaveLength(2);
    expect(imported.map((account) => account.legacyId)).toEqual(['acc_main', 'acc_bad_params']);
    // ★ Only adds: the same rows again create nothing and map to the accounts made the first time.
    expect(await store.importLegacy('wanlong', PKG, rows)).toEqual({ idMap: map, created: 0 });
    expect(await store.list('wanlong')).toHaveLength(2);
    const known = new Map(imported.map((account) => [account.legacyId!, { id: account.id, name: account.name }]));
    const again = previewLegacyAccounts(legacy, PKG, undefined, known);
    expect(again.rows).toEqual([]);
    expect(again.entries[0]).toMatchObject({ importable: false, importedAs: map['acc_main'], reason: expect.stringContaining('已导入过') });
    for (const account of imported) expect(account).toMatchObject({ binding: null, enabled: false, login: { status: 'pending' } });
    expect(imported.find((account) => account.id === map['acc_main'])).toMatchObject({
      name: '主号', defaultScriptId: 'daily', scriptParams: { daily: { rounds: 2 } },
    });
    expect(imported.find((account) => account.id === map['acc_bad_params'])?.scriptParams).toBeUndefined();
  });

  it('points the default script and parameter keys at the ids the old scripts were imported under', () => {
    const file = {
      version: 1,
      accounts: [{ id: 'acc_main', name: '主号', defaultScriptId: 'daily', enabled: true,
        scriptParams: { daily: { rounds: 2 }, 'daily-import-abc123': { rounds: 9 }, weekly: { on: true }, gather: { configJson: '{}' } } }],
    };
    const { rows } = previewLegacyAccounts(file, PKG, { daily: 'daily-import-abc123', gather: 'gather-import-x' });
    expect(rows[0]?.defaultScriptId).toBe('daily-import-abc123');
    // The renamed old `daily` wins over an old key that happens to equal its new id; gather is not a script id.
    expect(rows[0]?.scriptParams).toEqual({ 'daily-import-abc123': { rounds: 2 }, weekly: { on: true }, gather: { configJson: '{}' } });
    expect(previewLegacyAccounts(file, PKG).rows[0]?.defaultScriptId).toBe('daily');
    expect(() => previewLegacyAccounts(file, PKG, { daily: '../x' })).toThrow('脚本编号对照表无效');
  });
});

describe('atomic create-and-bind', () => {
  const ID = '11111111-2222-4333-8444-555555555555';
  const binding = { index: 3, instanceCreatedAt: 'c3' };
  const create = { gameId: 'wanlong', packageName: PKG, details: { name: '新号' } };

  it('creates the account inside the bind transaction, and a refused bind leaves nothing behind', async () => {
    const owner = await store.create('wanlong', PKG, { name: '甲' });
    await store.bind(owner.id, binding);
    await expect(store.bind(ID, binding, { create })).rejects.toMatchObject({ code: 'ACCOUNT_SLOT_TAKEN' });
    expect((await store.list('wanlong')).map((item) => item.name)).toEqual(['甲']);
    const { account, displaced } = await store.bind(ID, binding, { create, takeOver: true });
    expect(account).toMatchObject({ id: ID, name: '新号', binding, enabled: false, login: { status: 'pending' } });
    expect(displaced?.name).toBe('甲');
    // A retry under the same id binds the existing account instead of creating a second one.
    await store.bind(ID, binding, { create });
    expect(await store.list('wanlong')).toHaveLength(2);
    await expect(store.bind(ID, binding, { create: { ...create, gameId: 'other-game' } })).rejects.toMatchObject({ code: 'ACCOUNT_ID_TAKEN' });
    await expect(store.bind('not-a-uuid', binding, { create })).rejects.toThrow('账号编号或游戏标识无效');
    await expect(store.bind('22222222-2222-4333-8444-555555555555', null, { create })).rejects.toThrow('账号不存在');
  });
});
