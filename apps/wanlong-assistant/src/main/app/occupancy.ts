import type { OccupancyHolder } from '../../shared/ipc';
import type { InstanceAccess, LeaseOwner } from './instance-access';

/**
 * One contributor to the occupancy picture. Called with an index when only that instance matters (it may then
 * answer for that instance alone), without one when every holder is wanted. Sources are the assistant's services,
 * registered from the composition root: gather runs, schedules, login sessions, script plans …
 */
export type OccupancySource = (index?: number) => readonly OccupancyHolder[] | Promise<readonly OccupancyHolder[]>;

/**
 * A source for services that can only answer one instance at a time: `test(i)` for every index `indices(index)`
 * yields (just `index` when the guard asks about one instance), each hit becoming `holder` on that instance.
 */
export function perInstanceSource(
  indices: (index?: number) => Promise<readonly number[]>,
  test: (index: number) => boolean | Promise<boolean>,
  holder: Omit<OccupancyHolder, 'index'>,
): OccupancySource {
  return async (index) => {
    const list = await indices(index);
    const hits = await Promise.all(list.map(async (i) => ((await test(i)) ? i : null)));
    return hits.filter((i): i is number => i !== null).map((i) => ({ ...holder, index: i }));
  };
}

export interface OccupancyOptions {
  /** The in-process occupancy table (always consulted, reported as source `access`). */
  access?: Pick<InstanceAccess, 'holders'>;
  /** Cross-process lease of one instance (reported as source `lease` when no in-process holder explains it). */
  leaseOwner?: (index: number) => Promise<LeaseOwner | null>;
  /** Every live lease (any process): the update gate must also wait for another assistant process's writer. */
  leaseOwners?: () => Promise<Array<{ index: number; owner: LeaseOwner }>>;
  /** This process's pid, to tell our own leases from another assistant process's. */
  pid?: number;
  /** Source failures are reported here and otherwise ignored. */
  onSourceError?: (name: string, error: unknown) => void;
}

/**
 * Aggregates "who is using instance N" for the lifecycle guard (ask before stop / restart / remove) and the update
 * gate (`anyBusy`). For the guard a failing source is skipped, never fatal: it must still answer. The update gate
 * fails closed instead: `anyBusy()` throws when nothing is known to block but a source could not be read.
 */
export class InstanceOccupancy {
  private readonly sources = new Map<string, OccupancySource>();

  constructor(private readonly options: OccupancyOptions = {}) {}

  /** Register (or replace) a named source; returns the unregister function. */
  register(name: string, source: OccupancySource): () => void {
    this.sources.set(name, source);
    return () => { if (this.sources.get(name) === source) this.sources.delete(name); };
  }

  /** Every holder of every instance (or of `index` only), de-duplicated by (index, label). */
  async all(index?: number): Promise<OccupancyHolder[]> {
    return (await this.collect(index)).holders;
  }

  /** `all()` plus the names of the sources that failed (reported through `onSourceError`, otherwise skipped). */
  private async collect(index?: number): Promise<{ holders: OccupancyHolder[]; failed: string[] }> {
    const holders: OccupancyHolder[] = [];
    const failed: string[] = [];
    for (const item of this.options.access?.holders() ?? []) {
      holders.push({ index: item.index, label: item.label, source: 'access', blocking: true });
    }
    const results = await Promise.all([...this.sources.entries()].map(async ([name, source]) => {
      try { return (await source(index)).filter(validHolder); }
      catch (error) {
        failed.push(name);
        this.reportError(name, error);
        return [];
      }
    }));
    for (const list of results) holders.push(...list);
    return { holders: dedupe(holders), failed: failed.sort() };
  }

  private reportError(name: string, error: unknown): void {
    try { this.options.onSourceError?.(name, error); } catch { /* Reporting is best effort. */ }
  }

  /** Holders of one instance, blocking ones first. Includes a foreign lease holder the services do not know about. */
  async holders(index: number): Promise<OccupancyHolder[]> {
    const own = (await this.all(index)).filter((holder) => holder.index === index);
    if (!own.some((holder) => holder.blocking) && this.options.leaseOwner) {
      let owner: LeaseOwner | null = null;
      try { owner = await this.options.leaseOwner(index); }
      catch (error) { this.reportError('lease', error); }
      if (owner) own.push({ index, label: leaseLabel(owner, this.options.pid ?? process.pid), source: 'lease', blocking: true });
    }
    return sortHolders(own);
  }

  /**
   * 「实例 #N 正在<label>。」 for the first blocking holder anywhere — this process's services and table, then any
   * live lease (another assistant process, the CLI) — or null. The update gate asks this (installing quits the app).
   *
   * ★ Fails closed: when no blocking holder is known but a source (or the lease directory) could not be read, it
   *   throws instead of answering null, so a broken source can never let an install cut running work (the update
   *   center shows 「无法确认是否有任务在运行」 and refuses).
   */
  async anyBusy(): Promise<string | null> {
    const { holders, failed } = await this.collect();
    const first = sortHolders(holders.filter((holder) => holder.blocking))[0];
    if (first) return `实例 #${first.index} 正在${first.label}。`;
    let leases: Array<{ index: number; owner: LeaseOwner }> = [];
    try { leases = await this.options.leaseOwners?.() ?? []; }
    catch (error) { failed.push('lease'); this.reportError('lease', error); }
    const lease = [...leases].sort((a, b) => a.index - b.index)[0];
    if (lease) return `实例 #${lease.index} 正在${leaseLabel(lease.owner, this.options.pid ?? process.pid)}。`;
    if (failed.length) throw new OccupancyUnknownError(failed);
    return null;
  }
}

/** Thrown by `anyBusy()` when a source could not be read and nothing else is known to block. */
export class OccupancyUnknownError extends Error {
  constructor(readonly sources: readonly string[]) {
    super(`无法确认实例占用：占用来源 ${sources.join('、')} 读取失败`);
    this.name = 'OccupancyUnknownError';
  }
}

function validHolder(holder: OccupancyHolder): boolean {
  return Number.isInteger(holder.index) && holder.index >= 0 && typeof holder.label === 'string' && holder.label.length > 0;
}

function dedupe(holders: readonly OccupancyHolder[]): OccupancyHolder[] {
  const seen = new Map<string, OccupancyHolder>();
  for (const holder of holders) {
    const key = `${holder.index}\u0000${holder.label}`;
    const previous = seen.get(key);
    // Keep the blocking variant when two sources report the same activity.
    if (!previous || (!previous.blocking && holder.blocking)) seen.set(key, holder);
  }
  return [...seen.values()];
}

function sortHolders(holders: readonly OccupancyHolder[]): OccupancyHolder[] {
  return [...holders].sort((a, b) => a.index - b.index || Number(b.blocking) - Number(a.blocking) || a.label.localeCompare(b.label, 'zh-CN'));
}

/**
 * Every assistant writer labels its lease, so a lease without a label comes from a holder that does not (the CLI, an
 * older version) or was caught between taking the lock and writing the label: say only what is known.
 */
function leaseLabel(owner: LeaseOwner, pid: number): string {
  const other = owner.pid !== null && owner.pid !== pid;
  if (owner.label) return other ? `${owner.label}（另一个助手进程）` : owner.label;
  return other ? '被另一个助手进程操作' : '执行设备操作';
}
