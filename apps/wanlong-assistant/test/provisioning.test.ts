/**
 * Port of wanlong-panel `scripts/instances-offline-check.ts` (base instance + clone) against AvdManager with a
 * fake manager: no real AVD is created or removed. The partial-success diff checks are not ported because core's
 * clone is atomic and rolls back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AvdmError, withFileLock, type CloneOptions } from '@avdm/core';
import type { ManagerHost } from '../src/main/manager-host';
import { CLONE_BYTES_ESTIMATE, InstanceProvisioner, type ProvisionerPorts } from '../src/main/instances/provisioner';
import type { InstanceBaseChangedEvent } from '../src/main/instances/types';

interface FakeInstance { index: number; name: string; createdAt: string; status: string; provisioning?: boolean }

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

let home: string;
let list: FakeInstance[];
let nextIndex: number;
let clones: Array<{ from: number; opts: CloneOptions }>;
let beforeClone: () => Promise<void>;
let saved: Array<{ index: number; patch: unknown }>;
let busy: Map<number, string>;
let bound: Map<number, string>;
let events: InstanceBaseChangedEvent[];
let disabled: number[];
let free: number;
let manager: { getState: ReturnType<typeof vi.fn>; clone: ReturnType<typeof vi.fn> };

function provisioner(overrides: Partial<ProvisionerPorts> = {}): InstanceProvisioner {
  const ports: ProvisionerPorts = {
    settings: async (_gameId, index) => index === 0 ? { templateDir: '/templates/set-a', config: { version: 2 } } : { templateDir: '', config: {} },
    saveSettings: async (_gameId, index, patch) => { saved.push({ index, patch }); return { templateDir: '', config: {} }; },
    disableSchedule: async (_gameId, index) => { disabled.push(index); },
    busyReason: (index) => busy.get(index) ?? null,
    boundAccountName: async (_gameId, index) => bound.get(index) ?? null,
    freeBytes: async () => free,
    onChanged: (event) => events.push(event),
    ...overrides,
  };
  return new InstanceProvisioner({ get: async () => manager } as unknown as ManagerHost, home, ports);
}

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'avdm-provisioning-'));
  list = [
    { index: 0, name: '基础', createdAt: 'c0', status: 'stopped' },
    { index: 1, name: '实例 1', createdAt: 'c1', status: 'stopped' },
  ];
  nextIndex = 10;
  clones = [];
  beforeClone = async () => undefined;
  saved = [];
  busy = new Map();
  bound = new Map();
  events = [];
  disabled = [];
  free = 1024 ** 4;
  manager = {
    getState: vi.fn(async (index: number) => {
      const found = list.find((item) => item.index === index);
      if (!found) throw new AvdmError('INSTANCE_NOT_FOUND', `实例 #${index} 不存在`);
      return { status: found.status, record: { index, name: found.name, createdAt: found.createdAt, provisioning: found.provisioning } };
    }),
    clone: vi.fn(async (from: number, opts: CloneOptions) => {
      clones.push({ from, opts });
      await beforeClone();
      const created = Array.from({ length: opts.count }, () => {
        const index = nextIndex++;
        const record = { index, name: `${opts.namePrefix}-${index}`, createdAt: 'batch' };
        list.push({ ...record, status: 'stopped' });
        return record;
      });
      return created;
    }),
  };
});

afterEach(async () => { await rm(home, { recursive: true, force: true }); });

describe('base instance selection', () => {
  it('accepts index 0, persists privately per game and rejects invalid targets without touching the file', async () => {
    const service = provisioner();
    expect((await service.view('wanlong')).base).toBeNull();
    const view = await service.setBase('wanlong', 0);
    expect(view).toMatchObject({ base: { index: 0, name: '基础', createdAt: 'c0' }, status: 'stopped', cloneBlocked: null });
    expect(disabled).toEqual([0]);
    expect(events.at(-1)).toMatchObject({ gameId: 'wanlong', view: { base: { index: 0 } } });
    expect((await provisioner().view('wanlong')).base?.index).toBe(0);
    const file = service.store.fileFor('wanlong');
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
    const before = await readFile(file, 'utf8');
    await expect(service.setBase('wanlong', -1)).rejects.toThrow('实例编号无效');
    await expect(service.setBase('wanlong', 64)).rejects.toThrow('实例编号无效');
    await expect(service.setBase('wanlong', 40)).rejects.toThrow('实例 #40 不存在');
    bound.set(1, '主号');
    await expect(service.setBase('wanlong', 1)).rejects.toThrow('已绑定账号「主号」');
    busy.set(1, '正在进行账号登录');
    await expect(service.setBase('wanlong', 1)).rejects.toThrow('正在进行账号登录');
    expect(await readFile(file, 'utf8')).toBe(before);
    expect((await service.setBase('wanlong', null)).base).toBeNull();
    expect(await service.baseIdentity('wanlong')).toBeNull();
  });

  it('clears a base whose AVD was deleted or whose index now holds another AVD, and reports it once', async () => {
    const service = provisioner();
    await service.setBase('wanlong', 0);
    list[0]!.name = '改名仍是原实例';
    expect((await service.view('wanlong')).base?.name).toBe('改名仍是原实例');
    list[0]!.createdAt = 'c0-replaced';
    const replaced = await service.view('wanlong');
    expect(replaced).toMatchObject({ base: null, cleared: { index: 0, reason: expect.stringContaining('新的实例') } });
    expect((await service.view('wanlong')).cleared).toBeUndefined();
    list[0]!.createdAt = 'c0';
    await service.setBase('wanlong', 0);
    list = list.filter((item) => item.index !== 0);
    expect((await service.view('wanlong')).cleared?.reason).toContain('已被删除');
    expect(await service.baseIdentity('wanlong')).toBeNull();
  });

  it('reports a clear only from the call that made it, and never clears a base set meanwhile', async () => {
    const service = provisioner();
    await service.setBase('wanlong', 0);
    events.length = 0;
    list[0]!.createdAt = 'c0-replaced';
    const views = await Promise.all([service.view('wanlong'), service.view('wanlong'), service.baseIdentity('wanlong')]);
    expect(views.slice(0, 2).filter((view) => typeof view === 'object' && view && 'cleared' in view && view.cleared)).toHaveLength(1);
    expect(events.filter((event) => event.view.cleared)).toHaveLength(1);
    expect(events[0]?.view.cleared).toMatchObject({ index: 0, setAt: expect.any(Number) });

    // A stale check that loses the race to a new selection returns the new base and emits nothing.
    list[0]!.createdAt = 'c0';
    await service.setBase('wanlong', 1);
    events.length = 0;
    const stale = { index: 0, name: '基础', createdAt: 'gone', setAt: 1 };
    const write = service.store.write.bind(service.store);
    const spy = vi.spyOn(service.store, 'read').mockResolvedValueOnce(stale);
    const view = await service.view('wanlong');
    spy.mockRestore();
    expect(view).toMatchObject({ base: { index: 1 } });
    expect(view.cleared).toBeUndefined();
    expect(events).toEqual([]);
    expect(await write('wanlong', null, stale)).toBe(false);
    expect((await service.store.read('wanlong'))?.index).toBe(1);
  });

  it('never overwrites a corrupt selection file and recovers once it is fixed', async () => {
    const service = provisioner();
    await service.setBase('wanlong', 0);
    const file = service.store.fileFor('wanlong');
    const good = await readFile(file, 'utf8');
    await writeFile(file, '{broken');
    await expect(service.view('wanlong')).rejects.toThrow('文件损坏');
    await expect(service.setBase('wanlong', null)).rejects.toThrow('文件损坏');
    await expect(service.cloneFromBase('wanlong', { count: 1, expectedBaseIndex: 0 })).rejects.toThrow('文件损坏');
    expect(await readFile(file, 'utf8')).toBe('{broken');
    expect(clones).toEqual([]);
    await writeFile(file, good);
    expect((await service.view('wanlong')).base?.index).toBe(0);
  });
});

describe('clone from base', () => {
  it('clones every copy from the same stopped base, rotates identity by default and inherits the template set', async () => {
    const service = provisioner();
    await service.setBase('wanlong', 0);
    const result = await service.cloneFromBase('wanlong', { count: 3, expectedBaseIndex: 0 });
    expect(result.created.map((item) => item.index)).toEqual([10, 11, 12]);
    expect(clones).toEqual([{ from: 0, opts: { count: 3, namePrefix: '基础', identity: 'random' } }]);
    // The template set and the gather config are copied separately (a stale base config cannot cost the template set).
    expect(saved).toEqual([10, 11, 12].flatMap((index) => [
      { index, patch: { templateDir: '/templates/set-a' } },
      { index, patch: { config: { version: 2 } } },
    ]));
    expect(result.warnings).toEqual([]);
    // ★ The opt-out must reach core explicitly: omitted, core rotates a managed source anyway.
    await service.cloneFromBase('wanlong', { count: 1, expectedBaseIndex: 0, rotateIdentity: false });
    expect(clones.at(-1)?.opts).toEqual({ count: 1, namePrefix: '基础', identity: 'system' });
  });

  it('validates count, the expected base, the source state and identity before any clone call', async () => {
    const service = provisioner();
    await expect(service.cloneFromBase('wanlong', { count: 1, expectedBaseIndex: 0 })).rejects.toThrow('尚未设置基础实例');
    await service.setBase('wanlong', 0);
    for (const count of [0, -1, 1.5, 9, Number.NaN]) {
      await expect(service.cloneFromBase('wanlong', { count, expectedBaseIndex: 0 })).rejects.toThrow('克隆数量');
    }
    await expect(service.cloneFromBase('wanlong', { count: 1, expectedBaseIndex: 1 })).rejects.toThrow('基础实例已改变');
    list[0]!.status = 'running';
    await expect(service.cloneFromBase('wanlong', { count: 1, expectedBaseIndex: 0 })).rejects.toThrow('请先关闭源实例 #0');
    expect((await service.view('wanlong')).cloneBlocked).toContain('仍在运行');
    list[0]!.status = 'stopped';
    busy.set(0, '正在运行脚本计划');
    await expect(service.cloneFromBase('wanlong', { count: 1, expectedBaseIndex: 0 })).rejects.toThrow('正在运行脚本计划');
    busy.clear();
    free = CLONE_BYTES_ESTIMATE * 2 - 1;
    await expect(service.cloneFromBase('wanlong', { count: 2, expectedBaseIndex: 0 })).rejects.toThrow('磁盘剩余');
    free = 1024 ** 4;
    list[0]!.createdAt = 'replaced';
    await expect(service.cloneFromBase('wanlong', { count: 1, expectedBaseIndex: 0 })).rejects.toThrow('已被替换');
    expect(await service.baseIdentity('wanlong')).toBeNull();
    list[0]!.createdAt = 'c0';
    await service.setBase('wanlong', 0);
    list = list.filter((item) => item.index !== 0);
    await expect(service.cloneFromBase('wanlong', { count: 1, expectedBaseIndex: 0 })).rejects.toThrow('源实例 #0 已不存在');
    expect(clones).toEqual([]);
  });

  it('holds the source lease and excludes setBase and a second clone while copying', async () => {
    const service = provisioner();
    await service.setBase('wanlong', 0);
    const entered = gate();
    const finish = gate();
    beforeClone = async () => { entered.release(); await finish.promise; };
    const pending = service.cloneFromBase('wanlong', { count: 2, expectedBaseIndex: 0 });
    await entered.promise;
    await expect(service.cloneFromBase('wanlong', { count: 1, expectedBaseIndex: 0 })).rejects.toThrow('正在设置基础实例或克隆实例');
    await expect(service.setBase('wanlong', 1)).rejects.toThrow('正在设置基础实例或克隆实例');
    await expect(withFileLock(path.join(home, 'run', 'automation-instance-0.lock'), async () => undefined, { timeoutMs: 40 }))
      .rejects.toMatchObject({ code: 'LOCK_TIMEOUT' });
    finish.release();
    await pending;
    await withFileLock(path.join(home, 'run', 'automation-instance-0.lock'), async () => undefined, { timeoutMs: 40 });
  });

  it('refuses when login, gather or plans of another process hold the source lease', async () => {
    const service = provisioner();
    await service.setBase('wanlong', 0);
    const entered = gate();
    const held = gate();
    const other = withFileLock(path.join(home, 'run', 'automation-instance-0.lock'), async () => { entered.release(); await held.promise; });
    await entered.promise;
    await expect(service.cloneFromBase('wanlong', { count: 1, expectedBaseIndex: 0 })).rejects.toThrow('正被登录、采集或脚本计划占用');
    held.release();
    await other;
    expect(clones).toEqual([]);
  });

  it('translates core clone errors and keeps working afterwards', async () => {
    const service = provisioner();
    await service.setBase('wanlong', 0);
    manager.clone.mockRejectedValueOnce(new AvdmError('INSTANCE_RUNNING', 'running'));
    await expect(service.cloneFromBase('wanlong', { count: 1, expectedBaseIndex: 0 })).rejects.toThrow('请先关闭源实例 #0');
    manager.clone.mockRejectedValueOnce(new AvdmError('NO_FREE_INDEX', 'full'));
    await expect(service.cloneFromBase('wanlong', { count: 1, expectedBaseIndex: 0 })).rejects.toThrow('没有可用的实例编号');
    manager.clone.mockRejectedValueOnce(new AvdmError('COMMAND_FAILED', '磁盘写入失败'));
    await expect(service.cloneFromBase('wanlong', { count: 1, expectedBaseIndex: 0 })).rejects.toThrow('已自动回滚');
    expect((await service.cloneFromBase('wanlong', { count: 1, expectedBaseIndex: 0 })).created).toHaveLength(1);
  });

  it('reports a copy that could not inherit the template set as a warning, not a failure', async () => {
    const service = provisioner({ saveSettings: async (_gameId, index, patch) => {
      saved.push({ index, patch });
      if (index === 11 && patch.templateDir !== undefined) throw new Error('模板目录不存在');
      return { templateDir: '', config: {} };
    } });
    await service.setBase('wanlong', 0);
    const result = await service.cloneFromBase('wanlong', { count: 2, expectedBaseIndex: 0 });
    expect(result.created).toHaveLength(2);
    expect(result.warnings).toEqual(['实例 #11 未能继承基础实例的模板集设置：模板目录不存在']);
    // The gather config was still copied to #11.
    expect(saved).toContainEqual({ index: 11, patch: { config: { version: 2 } } });
  });

  it('a base config refused by save-time validation still leaves the copy its template set', async () => {
    const service = provisioner({ saveSettings: async (_gameId, index, patch) => {
      saved.push({ index, patch });
      if (patch.config !== undefined) throw new Error('采集配置有错误（共 1 处），没有保存：可放宽到的最低值 9 比固定搜索下限 7 还高。');
      return { templateDir: '', config: {} };
    } });
    await service.setBase('wanlong', 0);
    const result = await service.cloneFromBase('wanlong', { count: 1, expectedBaseIndex: 0 });
    expect(saved[0]).toEqual({ index: 10, patch: { templateDir: '/templates/set-a' } });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('实例 #10 未能继承基础实例的采集配置');
  });
});
