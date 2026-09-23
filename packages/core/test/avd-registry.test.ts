import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_INSTANCES } from '../src/constants.js';
import { isAvdmError } from '../src/errors.js';
import { resolvePaths } from '../src/paths.js';
import { Registry } from '../src/registry.js';
import { atomicWriteFile, isLockHeld, withFileLock } from '../src/util/fs.js';
import type { ManagerPaths, RegistryFile, RunRecord } from '../src/types.js';
import { leftovers, makeRecord, makeTempDir } from './fixtures/avd-support/helpers.js';

let home: string;
let paths: ManagerPaths;
let reg: Registry;

beforeEach(async () => {
  home = await makeTempDir('avdm-registry-');
  paths = resolvePaths(home);
  reg = new Registry(paths);
});

afterEach(async () => {
  await fsp.rm(home, { recursive: true, force: true });
});

async function readRegistryFile(): Promise<RegistryFile> {
  return JSON.parse(await fsp.readFile(paths.registryFile, 'utf8')) as RegistryFile;
}

function runRecord(index: number, extra: Partial<RunRecord> = {}): RunRecord {
  const console = 5554 + index * 2;
  return {
    index,
    pid: 4242 + index,
    startedAt: '2026-01-01T00:00:00.000Z',
    ports: { console, adb: console + 1, grpc: 8554 + index, serial: `emulator-${console}` },
    argv: ['emulator', '-avd', `avdm_${index}`],
    ...extra,
  };
}

async function expectCode(p: Promise<unknown>, code: string): Promise<void> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(isAvdmError(err), `expected AvdmError(${code}), got ${String(err)}`).toBe(true);
  expect((err as { code: string }).code).toBe(code);
}

describe('Registry basics', () => {
  it('lists [] when instances.json is missing', async () => {
    expect(await reg.list()).toEqual([]);
    expect(await reg.get(0)).toBeUndefined();
    await expectCode(reg.require(0), 'INSTANCE_NOT_FOUND');
  });

  it('allocates the lowest free indices and persists {version:1, instances} sorted by index', async () => {
    const first = await reg.allocate(3, (i) => makeRecord(i));
    expect(first.map((r) => r.index)).toEqual([0, 1, 2]);
    expect(first.map((r) => r.avdName)).toEqual(['avdm_0', 'avdm_1', 'avdm_2']);

    await reg.remove(1);
    const next = await reg.allocate(2, (i) => makeRecord(i, { name: `新-${i}` }));
    expect(next.map((r) => r.index)).toEqual([1, 3]);

    const file = await readRegistryFile();
    expect(file.version).toBe(1);
    expect(file.instances.map((r) => r.index)).toEqual([0, 1, 2, 3]);
    expect(file.instances[1]?.name).toBe('新-1');
    expect((await reg.list()).map((r) => r.index)).toEqual([0, 1, 2, 3]);
    expect((await reg.require(3)).name).toBe('新-3');
  });

  it('forces record.index to the reserved index', async () => {
    const [rec] = await reg.allocate(1, () => makeRecord(99));
    expect(rec?.index).toBe(0);
    expect((await reg.list()).map((r) => r.index)).toEqual([0]);
  });

  it('rejects a non-positive count', async () => {
    await expectCode(reg.allocate(0, (i) => makeRecord(i)), 'INVALID_ARGUMENT');
    await expectCode(reg.allocate(-1, (i) => makeRecord(i)), 'INVALID_ARGUMENT');
    await expectCode(reg.allocate(1.5, (i) => makeRecord(i)), 'INVALID_ARGUMENT');
  });

  it('inserts nothing when build() throws', async () => {
    await reg.allocate(1, (i) => makeRecord(i));
    await expect(
      reg.allocate(3, (i) => {
        if (i === 2) throw new Error('boom');
        return makeRecord(i);
      }),
    ).rejects.toThrow('boom');
    expect((await reg.list()).map((r) => r.index)).toEqual([0]);
    expect(await leftovers(home)).toEqual([]);
  });

  it('an empty file or one without an instances array is corrupt, not an empty registry', async () => {
    await fsp.mkdir(home, { recursive: true });
    for (const text of ['', '   \n', '{}', '{"version":1}', '{"version":1,"instances":{}}', 'null']) {
      await fsp.writeFile(paths.registryFile, text);
      const err = await reg.list().catch((e: unknown) => e);
      expect(isAvdmError(err, 'INVALID_ARGUMENT'), JSON.stringify(text)).toBe(true);
      expect((err as Error).message).toContain('实例注册表文件已损坏');
      await expect(reg.allocate(1, (i) => makeRecord(i))).rejects.toThrow('实例注册表文件已损坏');
      expect(await fsp.readFile(paths.registryFile, 'utf8')).toBe(text);
    }
  });

  it('reports a corrupt registry file with a Chinese message instead of silently resetting it', async () => {
    await fsp.mkdir(home, { recursive: true });
    await fsp.writeFile(paths.registryFile, '{ not json');
    const err = await reg.list().catch((e: unknown) => e);
    expect(isAvdmError(err, 'INVALID_ARGUMENT')).toBe(true);
    expect((err as Error).message).toContain('实例注册表文件已损坏');
    await expect(reg.allocate(1, (i) => makeRecord(i))).rejects.toThrow('实例注册表文件已损坏');
    expect(await fsp.readFile(paths.registryFile, 'utf8')).toBe('{ not json');
  });
});

describe('Registry capacity', () => {
  it(`fills all ${MAX_INSTANCES} slots, then throws NO_FREE_INDEX without writing`, async () => {
    await expectCode(reg.allocate(MAX_INSTANCES + 1, (i) => makeRecord(i)), 'NO_FREE_INDEX');
    expect(await reg.list()).toEqual([]);

    const all = await reg.allocate(MAX_INSTANCES, (i) => makeRecord(i));
    expect(all.map((r) => r.index)).toEqual(Array.from({ length: MAX_INSTANCES }, (_, i) => i));
    const before = await fsp.readFile(paths.registryFile, 'utf8');

    const err = await reg.allocate(1, (i) => makeRecord(i)).catch((e: unknown) => e);
    expect(isAvdmError(err, 'NO_FREE_INDEX')).toBe(true);
    expect((err as Error).message).toMatch(/可用实例编号不足/);
    expect(await fsp.readFile(paths.registryFile, 'utf8')).toBe(before);
  });

  it('partial availability: NO_FREE_INDEX when fewer than count are free', async () => {
    await reg.allocate(MAX_INSTANCES - 2, (i) => makeRecord(i));
    await expectCode(reg.allocate(3, (i) => makeRecord(i)), 'NO_FREE_INDEX');
    expect((await reg.list()).length).toBe(MAX_INSTANCES - 2);
    const last = await reg.allocate(2, (i) => makeRecord(i));
    expect(last.map((r) => r.index)).toEqual([MAX_INSTANCES - 2, MAX_INSTANCES - 1]);
  });
});

describe('Registry concurrency', () => {
  it('20 parallel allocate(1) calls get 20 distinct indices with no lost writes', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => reg.allocate(1, (i) => makeRecord(i))));
    const indices = results.map((r) => r[0]!.index).sort((a, b) => a - b);
    expect(indices).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect((await reg.list()).map((r) => r.index)).toEqual(indices);
    expect(await leftovers(home)).toEqual([]);
  });

  it('parallel allocations through separate Registry objects (simulated CLI + desktop) do not collide', async () => {
    const regs = Array.from({ length: 4 }, () => new Registry(resolvePaths(home)));
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, k) => regs[k % regs.length]!.allocate(2, (i) => makeRecord(i))),
    );
    const indices = results.flat().map((r) => r.index);
    expect(new Set(indices).size).toBe(24);
    expect((await reg.list()).map((r) => r.index)).toEqual(Array.from({ length: 24 }, (_, i) => i));
  });

  it('concurrent allocations near the limit: exactly the free slots are handed out', async () => {
    await reg.allocate(MAX_INSTANCES - 4, (i) => makeRecord(i));
    const settled = await Promise.allSettled(Array.from({ length: 8 }, () => reg.allocate(1, (i) => makeRecord(i))));
    const ok = settled.filter((s) => s.status === 'fulfilled');
    const failed = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected');
    expect(ok.length).toBe(4);
    expect(failed.length).toBe(4);
    for (const f of failed) expect(isAvdmError(f.reason, 'NO_FREE_INDEX')).toBe(true);
    expect((await reg.list()).length).toBe(MAX_INSTANCES);
  });

  it('parallel update() calls on one record are all applied', async () => {
    await reg.allocate(1, (i) => makeRecord(i, { notes: '' }));
    await Promise.all(
      Array.from({ length: 15 }, (_, k) =>
        reg.update(0, (rec) => ({ ...rec, notes: `${rec.notes ?? ''}[${k}]` })),
      ),
    );
    const notes = (await reg.require(0)).notes ?? '';
    for (let k = 0; k < 15; k++) expect(notes).toContain(`[${k}]`);
  });

  it('interleaved allocate/remove keep the file consistent', async () => {
    await reg.allocate(10, (i) => makeRecord(i));
    await Promise.all([
      reg.remove(2),
      reg.remove(5),
      reg.allocate(1, (i) => makeRecord(i)),
      reg.remove(7),
      reg.allocate(1, (i) => makeRecord(i)),
    ]);
    const idx = (await reg.list()).map((r) => r.index);
    expect(idx.length).toBe(9);
    expect(new Set(idx).size).toBe(9);
    for (const keep of [0, 1, 3, 4, 6, 8, 9]) expect(idx).toContain(keep);
  });
});

describe('Registry update/remove', () => {
  it('update() returns and persists the mutated record', async () => {
    await reg.allocate(2, (i) => makeRecord(i));
    const updated = await reg.update(1, (rec) => ({ ...rec, name: '改名', autoRestart: true }));
    expect(updated.name).toBe('改名');
    expect(updated.autoRestart).toBe(true);
    expect((await reg.require(1)).name).toBe('改名');
    expect((await reg.require(0)).name).toBe('实例-0');
  });

  it('update() hands the mutator a copy (a throwing mutator changes nothing)', async () => {
    await reg.allocate(1, (i) => makeRecord(i));
    await expect(
      reg.update(0, (rec) => {
        rec.name = 'half-done';
        throw new Error('nope');
      }),
    ).rejects.toThrow('nope');
    expect((await reg.require(0)).name).toBe('实例-0');
  });

  it('update() throws INSTANCE_NOT_FOUND for unknown index and refuses index changes', async () => {
    await expectCode(reg.update(5, (r) => r), 'INSTANCE_NOT_FOUND');
    await reg.allocate(1, (i) => makeRecord(i));
    await expectCode(
      reg.update(0, (r) => ({ ...r, index: 3 })),
      'INVALID_ARGUMENT',
    );
    expect((await reg.list()).map((r) => r.index)).toEqual([0]);
  });

  it('remove() drops the record and its run record; absent index is a no-op', async () => {
    await reg.allocate(2, (i) => makeRecord(i));
    await reg.writeRun(runRecord(1));
    await reg.remove(1);
    expect((await reg.list()).map((r) => r.index)).toEqual([0]);
    expect(await reg.readRun(1)).toBeUndefined();
    await expect(reg.remove(1)).resolves.toBeUndefined();
    await expect(reg.remove(42)).resolves.toBeUndefined();
    expect((await reg.list()).map((r) => r.index)).toEqual([0]);
  });
});

describe('Registry run records', () => {
  it('writeRun/readRun round-trip via run/instance-<i>.json', async () => {
    const run = runRecord(3);
    await reg.writeRun(run);
    expect(await reg.readRun(3)).toEqual(run);
    const onDisk = JSON.parse(await fsp.readFile(path.join(paths.runDir, 'instance-3.json'), 'utf8'));
    expect(onDisk).toEqual(run);
    expect(await reg.readRun(4)).toBeUndefined();
    expect(await leftovers(home)).toEqual([]);
  });

  it('markStopRequested sets an ISO timestamp and keeps the rest', async () => {
    const run = runRecord(2);
    await reg.writeRun(run);
    const before = Date.now();
    await reg.markStopRequested(2);
    const after = await reg.readRun(2);
    expect(after).toMatchObject({ ...run });
    expect(after?.stopRequestedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Date.parse(after!.stopRequestedAt!)).toBeGreaterThanOrEqual(before - 1000);
  });

  it('markStopRequested is a no-op without a run record (does not create one)', async () => {
    await reg.markStopRequested(9);
    expect(await reg.readRun(9)).toBeUndefined();
    await expect(fsp.access(path.join(paths.runDir, 'instance-9.json'))).rejects.toThrow();
  });

  it('clearRun deletes the record and tolerates absence', async () => {
    await reg.writeRun(runRecord(0));
    await reg.clearRun(0);
    expect(await reg.readRun(0)).toBeUndefined();
    await expect(reg.clearRun(0)).resolves.toBeUndefined();
  });

  it('a corrupt run record reads as undefined', async () => {
    await fsp.mkdir(paths.runDir, { recursive: true });
    await fsp.writeFile(path.join(paths.runDir, 'instance-1.json'), '{"index":');
    expect(await reg.readRun(1)).toBeUndefined();
  });

  it('markStopRequested records the stop budget', async () => {
    await reg.writeRun(runRecord(4));
    await reg.markStopRequested(4, { timeoutMs: 600_000 });
    const run = (await reg.readRun(4))!;
    expect(run.stopTimeoutMs).toBe(600_000);
    expect(Date.parse(run.stopRequestedAt!)).toBeGreaterThan(Date.now() - 10_000);
    await reg.markStopRequested(4);
    expect((await reg.readRun(4))!.stopTimeoutMs).toBeUndefined();
  });

  it('clearRunIf / updateRunIf only act on the record the predicate accepts', async () => {
    await reg.writeRun(runRecord(2, { pid: 111 }));
    expect(await reg.clearRunIf(2, (cur) => cur.pid === 222)).toBe(false);
    expect((await reg.readRun(2))?.pid).toBe(111);
    const same = await reg.updateRunIf(2, (cur) => (cur.pid === 222 ? { ...cur, crashedAt: 'x' } : undefined));
    expect(same?.crashedAt).toBeUndefined();
    const updated = await reg.updateRunIf(2, (cur) => ({ ...cur, discoveryFile: '/d/pid_111.ini' }));
    expect(updated?.discoveryFile).toBe('/d/pid_111.ini');
    expect((await reg.readRun(2))?.discoveryFile).toBe('/d/pid_111.ini');
    expect(await reg.clearRunIf(2, (cur) => cur.pid === 111)).toBe(true);
    expect(await reg.readRun(2)).toBeUndefined();
    // never creates a record
    expect(await reg.updateRunIf(2, (cur) => cur)).toBeUndefined();
    expect(await reg.readRun(2)).toBeUndefined();
    expect(await reg.clearRunIf(2, () => true)).toBe(false);
  });

  it('concurrent markStopRequested/clearRun never resurrect a cleared record', async () => {
    for (let round = 0; round < 5; round++) {
      await reg.writeRun(runRecord(6));
      await Promise.all([reg.markStopRequested(6), reg.clearRun(6)]);
      // Whichever order the lock imposed the record ends up gone: if markStopRequested ran last it
      // found no record and must not have written one back.
      expect(await reg.readRun(6)).toBeUndefined();
    }
  });
});

describe('file lock', () => {
  it('a long critical section keeps its lock fresh, so a contender never breaks it as stale', async () => {
    const lock = path.join(home, 'long.lock');
    const order: string[] = [];
    const holder = withFileLock(
      lock,
      async () => {
        order.push('holder-start');
        await new Promise((r) => setTimeout(r, 900));
        order.push('holder-end');
      },
      { staleMs: 300 },
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(await isLockHeld(lock, 300)).toBe(true);
    await withFileLock(
      lock,
      async () => {
        order.push('contender');
      },
      { staleMs: 300, timeoutMs: 5000 },
    );
    await holder;
    expect(order).toEqual(['holder-start', 'holder-end', 'contender']);
    expect(await isLockHeld(lock, 300)).toBe(false);
  });

  it('atomicWriteFile leaves no temp file behind and replaces the target', async () => {
    const file = path.join(home, 'sub', 'x.json');
    await atomicWriteFile(file, 'one');
    await atomicWriteFile(file, 'two');
    expect(await fsp.readFile(file, 'utf8')).toBe('two');
    expect(await fsp.readdir(path.dirname(file))).toEqual(['x.json']);
  });
});
