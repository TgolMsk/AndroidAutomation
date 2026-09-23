import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AccountStore } from '../src/main/automation/accounts/store';

let home: string;
let store: AccountStore;

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'avdm-account-'));
  store = new AccountStore(home);
});

afterEach(async () => { await rm(home, { recursive: true, force: true }); });

describe('AccountStore', () => {
  it('persists private metadata without credentials and preserves verified state on edit', async () => {
    const account = await store.create('wanlong', 'com.lilithgames.samo.android.cn', {
      name: '主号', server: '一区', role: '角色甲', note: '采集',
    });
    await store.bind(account.id, { index: 1, instanceCreatedAt: '2026-09-23T00:00:00.000Z' });
    await store.prepareLogin(account.id, { index: 1, instanceCreatedAt: '2026-09-23T00:00:00.000Z' }, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    await store.completeLogin(account.id, { index: 1, instanceCreatedAt: '2026-09-23T00:00:00.000Z' }, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    const updated = await store.update(account.id, { name: '主号甲' });
    expect(updated.name).toBe('主号甲');
    expect(updated.login.status).toBe('ready');
    expect(updated.enabled).toBe(true);
    const saved = await readFile(store.file, 'utf8');
    expect(saved).toContain('主号甲');
    expect(saved).not.toMatch(/phone|password|verificationCode/i);
    expect((await stat(store.file)).mode & 0o777).toBe(0o600);
  });

  it('enforces one account per game and AVD, but permits another game on the same AVD', async () => {
    const a = await store.create('wanlong', 'com.lilithgames.samo.android.cn', { name: 'A' });
    const b = await store.create('wanlong', 'com.lilithgames.samo.android.cn', { name: 'B' });
    const c = await store.create('other', 'com.example.other', { name: 'C' });
    const binding = { index: 2, instanceCreatedAt: 'created' };
    await store.bind(a.id, binding);
    await expect(store.bind(b.id, binding)).rejects.toThrow('已绑定其他账号');
    await store.bind(c.id, binding);
    expect((await store.list()).filter((item) => item.binding?.index === 2)).toHaveLength(2);
  });

  it('rejects stale login attempts and invalidates verification when an index is reused', async () => {
    const a = await store.create('wanlong', 'com.lilithgames.samo.android.cn', { name: 'A' });
    const first = { index: 1, instanceCreatedAt: 'old' };
    const next = { index: 1, instanceCreatedAt: 'new' };
    await store.prepareLogin(a.id, first, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    await expect(store.completeLogin(a.id, first, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')).rejects.toThrow('已变化');
    await store.completeLogin(a.id, first, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    const rebound = await store.bind(a.id, next);
    expect(rebound.login.status).toBe('pending');
    expect(rebound.enabled).toBe(false);
    await expect(store.setEnabled(a.id, true)).rejects.toThrow('请先完成登录验证');
    await expect(store.completeLogin(a.id, first, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')).rejects.toThrow('已变化');
  });

  it('serializes concurrent creation and refuses corrupted files without overwriting them', async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) =>
      store.create('wanlong', 'com.lilithgames.samo.android.cn', { name: `号 ${i}` })));
    expect(await store.list('wanlong')).toHaveLength(20);
    const corrupt = '{ broken';
    await writeFile(store.file, corrupt);
    await expect(store.create('wanlong', 'com.lilithgames.samo.android.cn', { name: 'X' })).rejects.toThrow('无法读取');
    expect(await readFile(store.file, 'utf8')).toBe(corrupt);
  });
});
