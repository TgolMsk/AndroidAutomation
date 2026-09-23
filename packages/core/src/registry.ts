import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { MAX_INSTANCES } from './constants.js';
import { AvdmError } from './errors.js';
import type { InstanceRecord, ManagerPaths, RegistryFile, RunRecord } from './types.js';
import { atomicWriteJson, readJsonIfExists, readTextIfExists, withFileLock } from './util/fs.js';

function assertUniqueIdentities(records: InstanceRecord[]): void {
  for (const field of ['serialNumber', 'wifiMac', 'androidId'] as const) {
    const seen = new Map<string, number>();
    for (const record of records) {
      const value = record.identity?.[field];
      if (!value) continue;
      const previous = seen.get(value);
      if (previous !== undefined) {
        throw new AvdmError('INVALID_ARGUMENT', `${field} ${value} 已用于实例 #${previous}，请给实例 #${record.index} 使用不同值或 {index} 模板`);
      }
      seen.set(value, record.index);
    }
  }
}

/**
 * Persistent registry of managed instances (instances.json) plus per-instance
 * runtime records (run/instance-<index>.json).
 *
 * All mutations go through `withFileLock(<registryFile>.lock)` and `atomicWriteJson`
 * so the CLI and the desktop app can safely operate concurrently.
 *
 * IMPLEMENTER: agent "core-avd" (see docs/DESIGN.md §registry).
 */
export class Registry {
  constructor(readonly paths: ManagerPaths) {}

  /** All records sorted by index. Missing file → []. */
  async list(): Promise<InstanceRecord[]> {
    // Writers replace the file atomically (rename), so an unlocked read never sees a partial file.
    return (await this.readFile()).instances;
  }

  async get(index: number): Promise<InstanceRecord | undefined> {
    return (await this.list()).find((r) => r.index === index);
  }

  /** Like get() but throws AvdmError('INSTANCE_NOT_FOUND'). */
  async require(index: number): Promise<InstanceRecord> {
    const rec = await this.get(index);
    if (!rec) throw notFound(index);
    return rec;
  }

  /**
   * Atomically reserve the `count` lowest free indices in 0..MAX_INSTANCES-1 and insert
   * the records produced by `build(index)` (called inside the lock; must be fast, no I/O on AVD files).
   * Throws AvdmError('NO_FREE_INDEX') if not enough indices are free (nothing is inserted).
   */
  async allocate(count: number, build: (index: number) => InstanceRecord): Promise<InstanceRecord[]> {
    if (!Number.isInteger(count) || count < 1) {
      throw new AvdmError('INVALID_ARGUMENT', `实例数量需为正整数（收到 ${count}）`);
    }
    return this.withLock(async () => {
      const file = await this.readFile();
      const used = new Set(file.instances.map((r) => r.index));
      const free: number[] = [];
      for (let i = 0; i < MAX_INSTANCES && free.length < count; i++) {
        if (!used.has(i)) free.push(i);
      }
      if (free.length < count) {
        throw new AvdmError(
          'NO_FREE_INDEX',
          `可用实例编号不足：需要 ${count} 个，仅剩 ${free.length} 个（最多 ${MAX_INSTANCES} 个实例）`,
          { requested: count, available: free.length },
        );
      }
      // Build every record before touching the file so a throwing builder inserts nothing.
      const created = free.map((index) => ({ ...build(index), index }));
      assertUniqueIdentities([...file.instances, ...created]);
      await this.writeFile([...file.instances, ...created]);
      return created;
    });
  }

  /** Read-modify-write one record under the lock. Throws INSTANCE_NOT_FOUND. Returns the new record. */
  async update(index: number, mutate: (rec: InstanceRecord) => InstanceRecord): Promise<InstanceRecord> {
    return this.withLock(async () => {
      const file = await this.readFile();
      const pos = file.instances.findIndex((r) => r.index === index);
      const current = file.instances[pos];
      if (pos < 0 || !current) throw notFound(index);
      const next = mutate(structuredClone(current));
      if (next.index !== index) {
        throw new AvdmError('INVALID_ARGUMENT', `不允许修改实例编号（#${index} → #${next.index}）`);
      }
      if (JSON.stringify(next.identity) !== JSON.stringify(current.identity)) {
        assertUniqueIdentities([...file.instances.filter((r) => r.index !== index), next]);
      }
      const instances = [...file.instances];
      instances[pos] = next;
      await this.writeFile(instances);
      return next;
    });
  }

  /** Remove a record (no-op if absent). Also clears its run record. */
  async remove(index: number): Promise<void> {
    await this.withLock(async () => {
      const file = await this.readFile();
      const instances = file.instances.filter((r) => r.index !== index);
      if (instances.length !== file.instances.length) await this.writeFile(instances);
    });
    await this.clearRun(index);
  }

  // ── runtime records ──

  async readRun(index: number): Promise<RunRecord | undefined> {
    try {
      return await readJsonIfExists<RunRecord>(this.runFile(index));
    } catch {
      // A corrupt run record carries no useful information; treat it as absent.
      return undefined;
    }
  }

  async writeRun(run: RunRecord): Promise<void> {
    await this.withRunLock(run.index, () => atomicWriteJson(this.runFile(run.index), run));
  }

  /** Set stopRequestedAt = now (and the stop's time budget) on the run record if present. */
  async markStopRequested(index: number, opts: { timeoutMs?: number } = {}): Promise<void> {
    await this.updateRunIf(index, (run) => {
      const next: RunRecord = { ...run, stopRequestedAt: new Date().toISOString() };
      if (opts.timeoutMs !== undefined) next.stopTimeoutMs = opts.timeoutMs;
      else delete next.stopTimeoutMs;
      return next;
    });
  }

  async clearRun(index: number): Promise<void> {
    await this.withRunLock(index, () => fsp.rm(this.runFile(index), { force: true }));
  }

  /**
   * Compare-and-delete: re-read the run record under its lock and delete it only if `predicate` accepts it
   * (e.g. it is still the launch we observed — another process may have just written a new one).
   * Returns true if a record was deleted.
   */
  async clearRunIf(index: number, predicate: (current: RunRecord) => boolean): Promise<boolean> {
    return this.withRunLock(index, async () => {
      const current = await this.readRun(index);
      if (!current || !predicate(current)) return false;
      await fsp.rm(this.runFile(index), { force: true });
      return true;
    });
  }

  /**
   * Compare-and-update: `mutate` gets the current record (under the run lock) and returns the replacement,
   * or undefined to leave it alone. Never creates a record. Returns the record as stored afterwards.
   */
  async updateRunIf(index: number, mutate: (current: RunRecord) => RunRecord | undefined): Promise<RunRecord | undefined> {
    return this.withRunLock(index, async () => {
      const current = await this.readRun(index);
      if (!current) return undefined;
      const next = mutate(structuredClone(current));
      if (!next) return current;
      await atomicWriteJson(this.runFile(index), { ...next, index });
      return next;
    });
  }

  // ── internals ──

  /** Path of the runtime record for `index`. */
  runFile(index: number): string {
    return path.join(this.paths.runDir, `instance-${index}.json`);
  }

  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    return withFileLock(`${this.paths.registryFile}.lock`, fn);
  }

  /** Run records are also mutated read-modify-write (markStopRequested), so they get their own lock. */
  private withRunLock<T>(index: number, fn: () => Promise<T>): Promise<T> {
    return withFileLock(path.join(this.paths.runDir, `instance-${index}.lock`), fn);
  }

  private async readFile(): Promise<RegistryFile> {
    const text = await readTextIfExists(this.paths.registryFile);
    // Only a missing file means "no instances". We always write a full document, so an empty file or one
    // without an `instances` array is damage (e.g. a crash during a write) and must not be mistaken for an
    // empty registry: the next create would reuse index 0 on top of the existing instance's AVD.
    if (text === undefined) return { version: 1, instances: [] };
    const corrupt = (why: string) =>
      new AvdmError(
        'INVALID_ARGUMENT',
        `实例注册表文件已损坏，无法解析: ${this.paths.registryFile}（${why}）。` +
          '请从备份恢复该文件；若确定要重建，可将其移走后重新创建实例（avd/ 下未登记的 AVD 会被移到 avd/orphaned/ 保留）',
      );
    if (text.trim() === '') throw corrupt('文件为空');
    let parsed: Partial<RegistryFile>;
    try {
      parsed = JSON.parse(text) as Partial<RegistryFile>;
    } catch (err) {
      throw corrupt((err as Error).message);
    }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.instances)) throw corrupt('缺少 instances 数组');
    return { version: 1, instances: sortByIndex(parsed.instances) };
  }

  private async writeFile(instances: InstanceRecord[]): Promise<void> {
    const file: RegistryFile = { version: 1, instances: sortByIndex(instances) };
    await atomicWriteJson(this.paths.registryFile, file);
  }
}

function sortByIndex(records: InstanceRecord[]): InstanceRecord[] {
  return [...records].sort((a, b) => a.index - b.index);
}

function notFound(index: number): AvdmError {
  return new AvdmError('INSTANCE_NOT_FOUND', `实例 #${index} 不存在`);
}
