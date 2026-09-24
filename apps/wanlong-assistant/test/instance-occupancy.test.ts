import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AvdmError, withFileLock } from '@avdm/core';
import {
  InstanceAccess, InstanceBusyError, explainLeaseTimeout, instanceLeasePath, readLeaseOwner, readLeaseOwners, withInstanceLease,
  withLabelledLease,
} from '../src/main/app/instance-access';
import { DeviceLaneCancelledError } from '../src/main/device/lane';
import { WANLONG_ERROR_CODES, isRetryLaterCode } from '../src/shared/errors';
import { InstanceOccupancy, perInstanceSource } from '../src/main/app/occupancy';
import { describeOccupancy, lifecycleConfirmation, lifecycleNeedsConfirm } from '../src/shared/occupancy';
import type { OccupancyHolder } from '../src/shared/ipc';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

let home: string;
beforeEach(async () => { home = await mkdtemp(path.join(tmpdir(), 'avdm-occupancy-')); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

describe('InstanceAccess (original reliability-offline-check, occupancy table)', () => {
  it('acquires synchronously and names the holder on conflict', () => {
    const access = new InstanceAccess();
    expect(access.anyBusy()).toBeNull();
    const release = access.acquire(21, '自动采集');
    expect(access.anyBusy()).toBe('实例 #21 正在自动采集。');
    expect(() => access.acquire(21, '运行脚本')).toThrow(InstanceBusyError);
    try { access.acquire(21, '运行脚本'); } catch (error) {
      expect(error).toMatchObject({ code: 'CONCURRENCY_LIMIT', index: 21, owner: '自动采集', message: '实例 #21 正在自动采集，请等待结束后再试。' });
    }
    // Different instances do not block each other.
    const other = access.acquire(20, '运行脚本');
    expect(access.holders().map((holder) => [holder.index, holder.label])).toEqual([[20, '运行脚本'], [21, '自动采集']]);
    other();
    release();
    expect(access.anyBusy()).toBeNull();
  });

  it('a stale release only removes its own token', () => {
    const access = new InstanceAccess();
    const first = access.acquire(1, '采集');
    first();
    const second = access.acquire(1, '登录');
    first(); // Released twice: must not free the new holder.
    expect(access.holderOf(1)).toBe('登录');
    expect(access.tryAcquire(1, '脚本')).toBeNull();
    second();
    expect(access.tryAcquire(1, '脚本')).not.toBeNull();
  });

  it('is exclusive both ways and releases on failure', async () => {
    const access = new InstanceAccess();
    const running = gate();
    const script = access.run(5, '运行脚本', () => running.promise);
    await expect(access.run(5, '自动采集', async () => undefined)).rejects.toThrow('实例 #5 正在运行脚本');
    running.release();
    await script;
    await expect(access.run(5, '自动采集', async () => { throw new Error('设备离线'); })).rejects.toThrow('设备离线');
    expect(access.anyBusy()).toBeNull();
    await expect(access.run(5, '运行脚本', async () => 'ok')).resolves.toBe('ok');
  });
});

describe('withInstanceLease (occupancy table + cross-process lease)', () => {
  it('reserves before its first await, writes the holder label into the lock and releases afterwards', async () => {
    const access = new InstanceAccess();
    const inside = gate();
    const finish = gate();
    const leased = withInstanceLease(home, 2, '运行采集', async () => { inside.release(); await finish.promise; return 'done'; }, { access });
    // Synchronously reserved: nothing else can claim the instance even before the lock directory exists.
    expect(() => access.acquire(2, '启动实例')).toThrow('实例 #2 正在运行采集');
    await inside.promise;
    expect(await readLeaseOwner(home, 2)).toMatchObject({ label: '运行采集', pid: process.pid });
    finish.release();
    await expect(leased).resolves.toBe('done');
    expect(await readLeaseOwner(home, 2)).toBeNull();
    expect(access.anyBusy()).toBeNull();
  });

  it('turns a lock timeout into a busy error naming the other holder', async () => {
    const lock = instanceLeasePath(home, 3);
    await mkdir(lock, { recursive: true });
    await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ label: '进行账号登录', pid: process.pid + 1, at: Date.now() }));
    const work = vi.fn(async () => 'never');
    await expect(withInstanceLease(home, 3, '运行采集', work, { timeoutMs: 50 })).rejects.toMatchObject({
      code: 'CONCURRENCY_LIMIT', message: '实例 #3 正在进行账号登录（另一个助手进程），请等待结束后再试。',
    });
    expect(work).not.toHaveBeenCalled();
    // A holder that does not label its lease yet (older code paths) still gets a readable message.
    await rm(path.join(lock, 'owner.json'));
    await expect(withInstanceLease(home, 3, '运行采集', work, { timeoutMs: 50 })).rejects.toThrow('实例 #3 正被登录、采集或脚本计划占用');
    // The other holder's lock is left alone.
    expect((await stat(lock)).isDirectory()).toBe(true);
  });

  it('explains a raw lease timeout from older writers (IPC error translation)', async () => {
    const lock = instanceLeasePath(home, 5);
    const holding = gate();
    const held = withFileLock(lock, () => holding.promise);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const raw = await withFileLock(lock, async () => undefined, { timeoutMs: 30 }).catch((error: unknown) => error);
    expect(raw).toBeInstanceOf(AvdmError);
    await expect(explainLeaseTimeout(raw, home)).resolves.toMatchObject({
      code: 'CONCURRENCY_LIMIT', message: '实例 #5 正被登录、采集或脚本计划占用，请等待结束后再试。',
    });
    await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ label: '保存模板', pid: process.pid, at: Date.now() }));
    await expect(explainLeaseTimeout(raw, home)).resolves.toMatchObject({ message: '实例 #5 正在保存模板，请等待结束后再试。' });
    holding.release();
    await held;
    // Anything else passes through untouched.
    const other = new AvdmError('LOCK_TIMEOUT', '等待文件锁超时: /elsewhere/registry.lock');
    await expect(explainLeaseTimeout(other, home)).resolves.toBe(other);
    await expect(explainLeaseTimeout(raw, undefined)).resolves.toBe(raw);
    const plain = new Error('别的错误');
    await expect(explainLeaseTimeout(plain, home)).resolves.toBe(plain);
  });

  it('treats an abandoned lease as free', async () => {
    const lock = instanceLeasePath(home, 4);
    await mkdir(lock, { recursive: true });
    expect(await readLeaseOwner(home, 4, () => Date.now() + 60_000)).toBeNull();
    expect(await readLeaseOwner(home, 4)).toEqual({ label: null, pid: null, at: null });
  });
});

describe('withLabelledLease (existing writers: gather, templates, login, accounts, plans)', () => {
  it('keeps core\'s LOCK_TIMEOUT for callers, but labels the lease and lists the holder while it is held', async () => {
    const access = new InstanceAccess();
    const inside = gate();
    const finish = gate();
    const held = withLabelledLease(home, 6, '运行脚本计划', async () => { inside.release(); await finish.promise; return 'ok'; }, { access });
    await inside.promise;
    expect(await readLeaseOwner(home, 6)).toMatchObject({ label: '运行脚本计划', pid: process.pid });
    expect(access.holderOf(6)).toBe('运行脚本计划');
    expect(await readLeaseOwners(home)).toEqual([{ index: 6, owner: expect.objectContaining({ label: '运行脚本计划' }) }]);
    // A second writer still fails exactly as before (PlanService marks LOCK_TIMEOUT runs skipped, accounts map it) …
    const raw = await withLabelledLease(home, 6, '运行采集', async () => 'never', { timeoutMs: 30, access }).catch((error: unknown) => error);
    expect(raw).toBeInstanceOf(AvdmError);
    expect(raw).toMatchObject({ code: 'LOCK_TIMEOUT' });
    // … and the IPC boundary can now name the holder.
    await expect(explainLeaseTimeout(raw, home)).resolves.toMatchObject({ code: 'CONCURRENCY_LIMIT', message: '实例 #6 正在运行脚本计划，请等待结束后再试。' });
    finish.release();
    await expect(held).resolves.toBe('ok');
    expect(access.holderOf(6)).toBeNull();
    expect(await readLeaseOwners(home)).toEqual([]);
  });

  it('never throws on an in-process entry it does not own (the file lock is what excludes)', async () => {
    const access = new InstanceAccess();
    const release = access.acquire(8, '克隆实例');
    await expect(withLabelledLease(home, 8, '修改模板或采集配置', async () => access.holderOf(8), { access })).resolves.toBe('克隆实例');
    expect(access.holderOf(8)).toBe('克隆实例');
    release();
  });

  it('keeps every error code the assistant creates in the shared list', () => {
    expect(WANLONG_ERROR_CODES).toContain(new InstanceBusyError(1, null).code);
    expect(WANLONG_ERROR_CODES).toContain(new DeviceLaneCancelledError('x').code);
    expect(isRetryLaterCode('CONCURRENCY_LIMIT')).toBe(true);
    expect(isRetryLaterCode('LOCK_TIMEOUT')).toBe(false);
  });
});

describe('InstanceOccupancy (who is using an instance)', () => {
  const gather: OccupancyHolder = { index: 1, label: '运行采集', source: 'gather', blocking: true };
  const schedule: OccupancyHolder = { index: 1, label: '自动采集已开启', source: 'schedule', blocking: false };

  it('merges the occupancy table and registered sources, blocking holders first', async () => {
    const access = new InstanceAccess();
    const release = access.acquire(2, '克隆实例');
    const occupancy = new InstanceOccupancy({ access });
    occupancy.register('gather', () => [gather]);
    occupancy.register('schedule', async () => [schedule, { ...schedule, index: 3 }]);
    expect(await occupancy.holders(1)).toEqual([gather, schedule]);
    expect(await occupancy.holders(2)).toEqual([{ index: 2, label: '克隆实例', source: 'access', blocking: true }]);
    expect(await occupancy.holders(9)).toEqual([]);
    release();
  });

  it('does not count an enabled schedule as busy for the update gate', async () => {
    const occupancy = new InstanceOccupancy();
    const unregister = occupancy.register('schedule', () => [schedule]);
    expect(await occupancy.anyBusy()).toBeNull();
    occupancy.register('gather', () => [gather]);
    expect(await occupancy.anyBusy()).toBe('实例 #1 正在运行采集。');
    unregister();
    expect((await occupancy.all()).map((holder) => holder.label)).toEqual(['运行采集']);
  });

  it('skips a failing source (reporting it) and removes duplicates', async () => {
    const onSourceError = vi.fn();
    const occupancy = new InstanceOccupancy({ onSourceError });
    occupancy.register('broken', () => { throw new Error('读不到'); });
    occupancy.register('a', () => [{ ...gather, blocking: false }]);
    occupancy.register('b', () => [gather, { index: -1, label: '坏数据', source: 'b', blocking: true }]);
    expect(await occupancy.holders(1)).toEqual([gather]);
    expect(onSourceError).toHaveBeenCalledWith('broken', expect.any(Error));
  });

  it('passes the index to sources that can answer for one instance only', async () => {
    const source = vi.fn(async (index?: number) => (index === undefined ? [] : [{ index, label: '运行脚本计划', source: 'plans', blocking: true }]));
    const occupancy = new InstanceOccupancy();
    occupancy.register('plans', source);
    expect(await occupancy.holders(6)).toEqual([{ index: 6, label: '运行脚本计划', source: 'plans', blocking: true }]);
    expect(source).toHaveBeenCalledWith(6);
  });

  it('asks before stopping an instance with enabled script plans, as for an enabled gather schedule', async () => {
    const enabledPlans = new Set([2]);
    const test = vi.fn(async (index: number) => enabledPlans.has(index));
    const occupancy = new InstanceOccupancy();
    occupancy.register('planSchedule', perInstanceSource(async (index) => (index === undefined ? [1, 2, 3] : [index]), test,
      { label: '已启用脚本计划', source: 'plans', blocking: false }));
    occupancy.register('schedule', () => [schedule]);
    const planned: OccupancyHolder = { index: 2, label: '已启用脚本计划', source: 'plans', blocking: false };
    expect(await occupancy.holders(2)).toEqual([planned]);
    expect(test).toHaveBeenCalledTimes(1);
    expect(await occupancy.holders(3)).toEqual([]);
    expect(await occupancy.all()).toEqual(expect.arrayContaining([planned, schedule]));
    // Standing automation never blocks the update gate …
    expect(await occupancy.anyBusy()).toBeNull();
    // … but stop / restart / remove ask the same way for both kinds.
    for (const holders of [[planned], [{ ...schedule, index: 2 }]]) {
      expect(lifecycleNeedsConfirm('stop', holders)).toBe(true);
      expect(lifecycleConfirmation('remove', [2], holders)).toMatchObject({ needed: true, warning: expect.stringContaining('开启了自动化') });
    }
  });

  it('makes the update gate wait for a lease held by another assistant process', async () => {
    const lock = instanceLeasePath(home, 9);
    await mkdir(lock, { recursive: true });
    await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ label: '运行采集', pid: 1, at: 1 }));
    await mkdir(path.join(home, 'run', 'unrelated.lock'), { recursive: true });
    const occupancy = new InstanceOccupancy({ leaseOwners: () => readLeaseOwners(home), pid: 99 });
    occupancy.register('schedule', () => [schedule]);
    expect(await occupancy.anyBusy()).toBe('实例 #9 正在运行采集（另一个助手进程）。');
    // Our own blocking holder is named first.
    occupancy.register('gather', () => [gather]);
    expect(await occupancy.anyBusy()).toBe('实例 #1 正在运行采集。');
    // An abandoned lease does not block.
    expect(await readLeaseOwners(home, () => Date.now() + 60_000)).toEqual([]);
  });

  it('reports a lease held by another process when no service claims the instance', async () => {
    const lock = instanceLeasePath(home, 7);
    await mkdir(lock, { recursive: true });
    await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ label: '运行脚本', pid: 1, at: 1 }));
    const occupancy = new InstanceOccupancy({ leaseOwner: (index) => readLeaseOwner(home, index), pid: 99 });
    expect(await occupancy.holders(7)).toEqual([{ index: 7, label: '运行脚本（另一个助手进程）', source: 'lease', blocking: true }]);
    await writeFile(path.join(lock, 'owner.json'), '{}');
    // A lease without a label only says what is known (it was not necessarily another process).
    expect((await occupancy.holders(7))[0]!.label).toBe('执行设备操作');
    await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: 1, at: 1 }));
    expect((await occupancy.holders(7))[0]!.label).toBe('被另一个助手进程操作');
    // Our own gather run explains the lease: it is not listed twice.
    occupancy.register('gather', () => [{ ...gather, index: 7 }]);
    expect((await occupancy.holders(7)).map((holder) => holder.label)).toEqual(['运行采集']);
  });
});

describe('instance lifecycle confirmation wording', () => {
  const holders: OccupancyHolder[] = [
    { index: 1, label: '运行采集', source: 'gather', blocking: true },
    { index: 1, label: '自动采集已开启', source: 'schedule', blocking: false },
    { index: 2, label: '自动采集已开启', source: 'schedule', blocking: false },
  ];

  it('asks before stop / restart / remove of a used instance, never before start', () => {
    expect(describeOccupancy(1, holders)).toBe('实例 #1 正在运行采集、自动采集已开启');
    expect(describeOccupancy(3, holders)).toBeNull();
    expect(lifecycleNeedsConfirm('start', holders)).toBe(false);
    expect(lifecycleNeedsConfirm('stop', holders)).toBe(true);
    expect(lifecycleNeedsConfirm('stop', [])).toBe(false);
    const stop = lifecycleConfirmation('stop', [1, 3], holders);
    expect(stop).toMatchObject({ needed: true, title: '确认关闭 2 个实例', lines: ['实例 #1 正在运行采集、自动采集已开启'] });
    expect(stop.warning).toContain('会打断正在进行的任务');
    const remove = lifecycleConfirmation('remove', [2], holders);
    expect(remove).toMatchObject({ needed: true, title: '确认删除实例 #2' });
    expect(remove.warning).toContain('开启了自动化');
    expect(lifecycleConfirmation('start', [1], holders).needed).toBe(false);
    expect(lifecycleConfirmation('restart', [4], [], [4]).lines).toEqual(['实例 #4 的占用情况读取失败，无法确认是否有任务在运行']);
  });
});
