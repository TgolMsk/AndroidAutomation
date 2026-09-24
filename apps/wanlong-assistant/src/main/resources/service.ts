import { normalizeResourceSnapshot, type ResourceSnapshot } from '@avdm/automation/wanlong/pure';
import { SchedulerError, codeOf, messageOf } from '../scheduler/errors';

export type ResourcesLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface ResourcesPorts {
  /** The read itself: `AutomationHost.readResourceStats` (vision worker, inside the instance lock). */
  read(index: number): Promise<ResourceSnapshot>;
  /** Record a successful read as a statistics snapshot (every read path records one, like the original). */
  record?(snapshot: ResourceSnapshot): Promise<void>;
  /** A read started / ended on an instance (the page's busy state, also for reads the bot started). */
  onReading?(index: number, reading: boolean): void;
  log?(level: ResourcesLogLevel, message: string): void;
}

/**
 * 「读一次资源统计」 for the page, `statsSnapshotNow` and the bot (original readResourceStatsForInstance callers):
 * one read per instance at a time, every successful read recorded into today's statistics. A busy instance
 * (CONCURRENCY_LIMIT) is a「稍后再试」, never a failure. The snapshot is only accurate to 0.1亿 (reconciliation only).
 */
export class ResourcesService {
  private readonly reading = new Set<number>();

  constructor(readonly gameId: string, private readonly ports: ResourcesPorts) {}

  /** Instances being read right now. */
  readingList(): number[] {
    return [...this.reading].sort((a, b) => a - b);
  }

  async read(index: number): Promise<ResourceSnapshot> {
    if (!Number.isInteger(index) || index < 0 || index > 63) throw new SchedulerError('INVALID_ARGUMENT', `实例序号非法：${String(index)}`);
    if (this.reading.has(index)) {
      throw new SchedulerError('CONCURRENCY_LIMIT', `实例 #${index} 正在读资源统计，等它完成再点。`, { instanceIndex: index });
    }
    this.reading.add(index);
    this.notify(index, true);
    try {
      const snapshot = normalizeResourceSnapshot(await this.ports.read(index));
      if (!snapshot || snapshot.instanceIndex !== index) throw new SchedulerError('UNKNOWN', '资源统计读取返回了无效的结果');
      if (this.ports.record) {
        // Recording is a side effect: a statistics problem never turns a successful read into a failure.
        try { await this.ports.record(snapshot); }
        catch (error) { this.log('warn', `实例 #${index} 的资源统计快照没能记入统计：${messageOf(error)}`); }
      }
      const clean = snapshot.warnings.length === 0 ? '（干净）' : `（${snapshot.warnings.length} 条降级说明）`;
      this.log('info', `实例 #${index} 读到一张资源统计快照${clean}。`);
      return snapshot;
    } catch (error) {
      this.log(codeOf(error) === 'CONCURRENCY_LIMIT' ? 'info' : 'warn', `实例 #${index} 读资源统计没成功：${messageOf(error)}`);
      throw error;
    } finally {
      this.reading.delete(index);
      this.notify(index, false);
    }
  }

  private notify(index: number, reading: boolean): void {
    try { this.ports.onReading?.(index, reading); } catch { /* observers never break a read */ }
  }

  private log(level: ResourcesLogLevel, message: string): void {
    try { this.ports.log?.(level, `[资源统计] ${message}`); } catch { /* logging never breaks a read */ }
  }
}
