import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultSchedulerConfig } from '@avdm/automation/wanlong/pure';
import { SchedulerStore, sanitizeHint, sanitizeMarch } from '../src/main/scheduler/store';
import { SchedulerError } from '../src/main/scheduler/errors';
import { InstanceLocks } from '../src/main/scheduler/instance-lock';
import { withFileLock } from '@avdm/core';

describe('SchedulerStore', () => {
  let home: string;
  let store: SchedulerStore;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'avdm-eta-store-'));
    store = new SchedulerStore(home, () => 1234);
  });
  afterEach(async () => { await rm(home, { recursive: true, force: true }); });

  it('starts from defaults when nothing is stored', async () => {
    expect(await store.loadConfig()).toEqual({ config: defaultSchedulerConfig(), warnings: [] });
    expect(await store.loadInstances()).toEqual({ instances: [], warnings: [] });
  });

  it('quarantines corrupt, oversized and incompatible files instead of blocking startup', async () => {
    await mkdir(path.join(store.root, 'instances'), { recursive: true });
    await writeFile(store.configFile, '{ not json');
    await writeFile(store.instanceFile(1), JSON.stringify({ version: 99 }));
    await writeFile(store.instanceFile(2), 'x'.repeat(300 * 1024));
    await writeFile(store.instanceFile(3), JSON.stringify({ version: 1, auto: true, queueUsed: 2, queueTotal: 5 }));
    const { config, warnings } = await store.loadConfig();
    expect(config).toEqual(defaultSchedulerConfig());
    expect(warnings[0]).toContain('不是合法 JSON');
    const loaded = await store.loadInstances();
    expect(loaded.instances.map((item) => item.instanceIndex)).toEqual([3]);
    expect(loaded.warnings.join('\n')).toMatch(/格式不兼容[\s\S]*超过 256 KB/);
    const names = await readdir(path.join(store.root, 'instances'));
    expect(names.sort()).toEqual(['1.json.corrupt-1234', '2.json.corrupt-1234', '3.json']);
    expect(await readdir(store.root)).toContain('config.json.corrupt-1234');
  });

  it('clamps config values and drops malformed records field by field', async () => {
    await mkdir(store.root, { recursive: true });
    await writeFile(store.configFile, JSON.stringify({ version: 1, config: { slackSeconds: -5, jitterSeconds: 'x', minSampleIntervalMs: 10 } }));
    expect((await store.loadConfig()).config).toMatchObject({ slackSeconds: 0, jitterSeconds: 20, minSampleIntervalMs: 1000 });

    expect(sanitizeMarch({ slot: 0, status: 'gathering' })).toBeNull();
    expect(sanitizeMarch({ slot: 1, status: 'flying' })).toBeNull();
    expect(sanitizeMarch({ slot: 2, status: 'returning', targetCoord: 'evil', resourceType: 'gems', travelTimeSource: 'x' }))
      .toMatchObject({ slot: 2, targetCoord: null, resourceType: null, travelTimeSource: 'fallback', freeAt: null });
    expect(sanitizeHint({ travelTimeMs: -1 })).toBeNull();
    expect(sanitizeHint({ travelTimeMs: 5000, source: 'bogus', coord: '1,2' })).toMatchObject({ source: 'dispatch', coord: '1,2' });
  });

  it('writes private files atomically, keeps at most 8 travel hints and deletes on forget', async () => {
    await store.saveInstance({
      instanceIndex: 4, instanceCreatedAt: 'avd', auto: true, accountId: null, queueUsed: 1, queueTotal: 5, marches: [],
      lastSampledAt: 10, failureCount: 2,
      travelHints: Array.from({ length: 12 }, (_, i) => ({ travelTimeMs: i * 1000, source: 'dispatch' as const, at: i, coord: null, resourceType: null })),
    });
    const file = store.instanceFile(4);
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
    const [loaded] = (await store.loadInstances()).instances;
    expect(loaded.travelHints).toHaveLength(8);
    expect(loaded.travelHints[0].at).toBe(11);
    expect(loaded).toMatchObject({ auto: true, failureCount: 2, instanceCreatedAt: 'avd' });
    expect((await readdir(path.dirname(file))).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    await store.deleteInstance(4);
    expect((await store.loadInstances()).instances).toEqual([]);
  });
});

describe('InstanceLocks', () => {
  let home: string;
  beforeEach(async () => { home = await mkdtemp(path.join(tmpdir(), 'avdm-instance-lock-')); });
  afterEach(async () => { await rm(home, { recursive: true, force: true }); });

  it('queues in-process holders in FIFO order and re-enters nested calls', async () => {
    const locks = new InstanceLocks(home);
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = locks.run(1, '采样', async () => {
      order.push('a-start');
      expect(locks.holder(1)).toBe('采样');
      expect(locks.anyBusy()).toBe('实例 #1 正在采样。');
      // Re-entry (dispatch → noteDispatch → sample) runs immediately.
      await locks.run(1, '派兵后校准', async () => { order.push('nested'); });
      await gate;
      order.push('a-end');
    });
    const second = locks.run(1, '截图', async () => { order.push('b'); });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual(['a-start', 'nested']);
    expect(locks.busy(1)).toBe(true);
    release();
    await Promise.all([first, second]);
    await locks.drain(1);
    expect(order).toEqual(['a-start', 'nested', 'a-end', 'b']);
    expect(locks.busy(1)).toBe(false);
    expect(locks.anyBusy()).toBeNull();
  });

  it('fails fast with CONCURRENCY_LIMIT when another process holds the lease', async () => {
    const locks = new InstanceLocks(home, { leaseTimeoutMs: 100 });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    const external = withFileLock(locks.leasePath(2), async () => { entered(); await held; });
    await inside;
    const error = await locks.run(2, '读取部队管理面板', async () => 'never').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SchedulerError);
    expect(error).toMatchObject({ code: 'CONCURRENCY_LIMIT', message: expect.stringContaining('读取部队管理面板稍后再试') });
    release();
    await external;
    expect(await locks.run(2, '读取部队管理面板', async () => 'ok')).toBe('ok');
  });

  it('does not enter after an abort while queued', async () => {
    const locks = new InstanceLocks(home, { fileLock: async (_path, fn) => fn() });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = locks.run(3, '采集', () => gate);
    const controller = new AbortController();
    let ran = false;
    const second = locks.run(3, '采样', async () => { ran = true; }, { signal: controller.signal });
    controller.abort(new Error('停止'));
    release();
    await first;
    await expect(second).rejects.toMatchObject({ code: 'RUN_ABORTED' });
    expect(ran).toBe(false);
  });
});
