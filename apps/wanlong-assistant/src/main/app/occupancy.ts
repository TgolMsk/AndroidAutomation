import type { OccupancyHolder } from '../../shared/ipc';
import type { InstanceAccess, LeaseOwner } from './instance-access';

/**
 * One contributor to the occupancy picture. Called with an index when only that instance matters (it may then
 * answer for that instance alone), without one when every holder is wanted. Sources are the assistant's services,
 * registered from the composition root: gather runs, schedules, login sessions, script plans …
 */
export type OccupancySource = (index?: number) => readonly OccupancyHolder[] | Promise<readonly OccupancyHolder[]>;

export interface OccupancyOptions {
  /** The in-process occupancy table (always consulted, reported as source `access`). */
  access?: Pick<InstanceAccess, 'holders'>;
  /** Cross-process lease of one instance (reported as source `lease` when no in-process holder explains it). */
  leaseOwner?: (index: number) => Promise<LeaseOwner | null>;
  /** This process's pid, to tell our own leases from another assistant process's. */
  pid?: number;
  /** Source failures are reported here and otherwise ignored. */
  onSourceError?: (name: string, error: unknown) => void;
}

/**
 * Aggregates "who is using instance N" for the lifecycle guard (ask before stop / restart / remove) and the update
 * gate (`anyBusy`). A failing source is skipped, never fatal: the guard must still answer.
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
    const holders: OccupancyHolder[] = [];
    for (const item of this.options.access?.holders() ?? []) {
      holders.push({ index: item.index, label: item.label, source: 'access', blocking: true });
    }
    const results = await Promise.all([...this.sources.entries()].map(async ([name, source]) => {
      try { return (await source(index)).filter(validHolder); }
      catch (error) {
        try { this.options.onSourceError?.(name, error); } catch { /* Reporting is best effort. */ }
        return [];
      }
    }));
    for (const list of results) holders.push(...list);
    return dedupe(holders);
  }

  /** Holders of one instance, blocking ones first. Includes a foreign lease holder the services do not know about. */
  async holders(index: number): Promise<OccupancyHolder[]> {
    const own = (await this.all(index)).filter((holder) => holder.index === index);
    if (!own.some((holder) => holder.blocking) && this.options.leaseOwner) {
      let owner: LeaseOwner | null = null;
      try { owner = await this.options.leaseOwner(index); }
      catch (error) { try { this.options.onSourceError?.('lease', error); } catch { /* best effort */ } }
      if (owner) own.push({ index, label: leaseLabel(owner, this.options.pid ?? process.pid), source: 'lease', blocking: true });
    }
    return sortHolders(own);
  }

  /** 「实例 #N 正在<label>。」 for the first blocking holder anywhere, or null (the update gate asks this). */
  async anyBusy(): Promise<string | null> {
    const blocking = sortHolders((await this.all()).filter((holder) => holder.blocking));
    const first = blocking[0];
    return first ? `实例 #${first.index} 正在${first.label}。` : null;
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

function leaseLabel(owner: LeaseOwner, pid: number): string {
  const other = owner.pid !== null && owner.pid !== pid;
  if (owner.label) return other ? `${owner.label}（另一个助手进程）` : owner.label;
  return other || owner.pid === null ? '被另一个进程操作' : '执行设备操作';
}
