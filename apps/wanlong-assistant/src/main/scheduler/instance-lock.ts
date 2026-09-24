import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { withFileLock } from '@avdm/core';
import { SchedulerError, codeOf, throwIfAborted } from './errors';

/** A lease acquisition that waits longer than this means another writer (login, plan, other process) owns the AVD. */
const DEFAULT_LEASE_TIMEOUT_MS = 150;

type FileLock = <T>(lockPath: string, fn: () => Promise<T>, opts?: { timeoutMs?: number; staleMs?: number }) => Promise<T>;

export interface InstanceLockOptions {
  /** How long to wait for the cross-process file lease once this process's queue reaches us. */
  leaseTimeoutMs?: number;
  /** Test seam; defaults to `@avdm/core` withFileLock. */
  fileLock?: FileLock;
  now?: () => number;
}

export interface RunOptions {
  signal?: AbortSignal;
  leaseTimeoutMs?: number;
}

interface Holder {
  label: string;
  since: number;
}

/**
 * The per-instance device lock shared by the ETA scheduler (samples, dispatch cycles, health probes), manual gather
 * runs and anything lent the instance through `EtaScheduler.exclusive()` (bot screenshot, resource read, freeze
 * restart, AI taps).
 *
 * Two layers, acquired in order by the outermost holder only:
 *  1. an in-process FIFO chain per index, so work queues instead of failing while a sample is in flight;
 *  2. the cross-process file lease `run/automation-instance-<i>.lock`, shared with login, plans and other processes,
 *     acquired with a short timeout so a long-held external lease fails fast with CONCURRENCY_LIMIT.
 *
 * Reentrant through AsyncLocalStorage: a hook running inside the lock (dispatch → noteDispatch → sample,
 * onSampleResult → exclusive → freeze restart) runs immediately instead of deadlocking on itself.
 */
export class InstanceLocks {
  private readonly als = new AsyncLocalStorage<ReadonlySet<number>>();
  private readonly chains = new Map<number, Promise<void>>();
  private readonly holders = new Map<number, Holder>();
  private readonly fileLock: FileLock;
  private readonly leaseTimeoutMs: number;
  private readonly now: () => number;

  constructor(readonly home: string, options: InstanceLockOptions = {}) {
    if (!path.isAbsolute(home)) throw new Error('实例锁数据目录必须是绝对路径');
    this.fileLock = options.fileLock ?? withFileLock;
    this.leaseTimeoutMs = options.leaseTimeoutMs ?? DEFAULT_LEASE_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  leasePath(index: number): string {
    return path.join(this.home, 'run', `automation-instance-${index}.lock`);
  }

  /** Whether the current async context already holds this instance (nested calls re-enter). */
  held(index: number): boolean {
    return this.als.getStore()?.has(index) ?? false;
  }

  /** The label of the in-process holder, if any. */
  holder(index: number): string | null {
    return this.holders.get(index)?.label ?? null;
  }

  /** Whether something in this process holds or waits for the instance. */
  busy(index: number): boolean {
    return this.chains.has(index);
  }

  /** One Chinese sentence naming a busy instance, or null. The update gate asks this single table. */
  anyBusy(): string | null {
    for (const [index, holder] of this.holders) return `实例 #${index} 正在${holder.label}。`;
    return null;
  }

  /** Resolves once nothing in this process holds or waits for the instance. Never rejects. */
  drain(index: number): Promise<void> {
    return this.chains.get(index) ?? Promise.resolve();
  }

  /** A function that runs its argument in the current lock context (for callbacks arriving on other event sources). */
  bind(): <R>(fn: () => R) => R {
    const store = this.als.getStore();
    return (fn) => (store ? this.als.run(store, fn) : fn());
  }

  /**
   * Run `fn` while holding the instance. Queues behind in-process holders; fails with CONCURRENCY_LIMIT when the
   * cross-process lease is held elsewhere. Throws RUN_ABORTED when `signal` aborts before the lock is entered.
   */
  async run<T>(index: number, label: string, fn: () => Promise<T>, options: RunOptions = {}): Promise<T> {
    if (this.held(index)) return fn();
    const previous = this.chains.get(index) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => mine, () => mine);
    this.chains.set(index, tail);
    try {
      await previous;
      throwIfAborted(options.signal);
      let entered = false;
      try {
        return await this.fileLock(this.leasePath(index), async () => {
          entered = true;
          throwIfAborted(options.signal);
          this.holders.set(index, { label, since: this.now() });
          try {
            const held = new Set(this.als.getStore() ?? []);
            held.add(index);
            return await this.als.run(held, fn);
          } finally {
            this.holders.delete(index);
          }
        }, { timeoutMs: options.leaseTimeoutMs ?? this.leaseTimeoutMs });
      } catch (error) {
        if (!entered && codeOf(error) === 'LOCK_TIMEOUT') {
          throw new SchedulerError('CONCURRENCY_LIMIT',
            `实例 #${index} 正被登录、脚本计划或另一个助手进程占用，${label}稍后再试。`, { instanceIndex: index });
        }
        throw error;
      }
    } finally {
      release();
      if (this.chains.get(index) === tail) this.chains.delete(index);
    }
  }
}
