import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { withFileLock } from '@avdm/core';
import {
  describeLeaseHolder, instanceAccess, instanceLeasePath, labelInstanceLease, type AccessHolder, type InstanceAccess,
} from '../app/instance-access';
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
  /**
   * The in-process occupancy table (app shell, original `instanceAccess`); defaults to the process-wide one, so the
   * lifecycle guard, the update gate and every `withInstanceLease` writer see the scheduler's holders by name.
   */
  access?: InstanceAccess;
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
 * It is the scheduler's front end to the app shell's single lease system, not a second one:
 *  1. an in-process FIFO chain per index, so scheduler work queues instead of failing while a sample is in flight;
 *  2. the app shell's labelled instance lease: the cross-process file lease `run/automation-instance-<i>.lock`
 *     (shared with login, plans, template edits and other processes) carrying an `owner.json` label, and the holder
 *     noted in the in-process occupancy table (`instanceAccess`) for as long as it is held.
 * A foreign in-process holder (login wizard, script run, template edit) is refused at once by name; a lease held by
 * another process fails after a short timeout with CONCURRENCY_LIMIT naming its label when it wrote one.
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
  private readonly access: InstanceAccess;

  constructor(readonly home: string, options: InstanceLockOptions = {}) {
    if (!path.isAbsolute(home)) throw new Error('实例锁数据目录必须是绝对路径');
    this.fileLock = options.fileLock ?? withFileLock;
    this.leaseTimeoutMs = options.leaseTimeoutMs ?? DEFAULT_LEASE_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    this.access = options.access ?? instanceAccess;
  }

  leasePath(index: number): string {
    return instanceLeasePath(this.home, index);
  }

  /** Whether the current async context already holds this instance (nested calls re-enter). */
  held(index: number): boolean {
    return this.als.getStore()?.has(index) ?? false;
  }

  /** The label of the in-process holder, if any. */
  holder(index: number): string | null {
    return this.holders.get(index)?.label ?? null;
  }

  /** Every instance this lock holds right now with its label (the scheduler's occupancy source). */
  holderList(): AccessHolder[] {
    return [...this.holders.entries()].map(([index, holder]) => ({ index, label: holder.label, since: holder.since }))
      .sort((a, b) => a.index - b.index);
  }

  /** Whether something in this process holds or waits for the instance. */
  busy(index: number): boolean {
    return this.chains.has(index);
  }

  /** One Chinese sentence naming a busy instance, or null. */
  anyBusy(): string | null {
    const first = this.holderList()[0];
    return first ? `实例 #${first.index} 正在${first.label}。` : null;
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
   * Run `fn` while holding the instance. Queues behind in-process scheduler holders; fails with CONCURRENCY_LIMIT
   * (naming the holder) when another writer of this process holds the instance or the cross-process lease is held
   * elsewhere. Throws RUN_ABORTED when `signal` aborts before the lock is entered.
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
      // Another writer of this process (login wizard, script run, template edit) is on the instance: say who.
      const foreign = this.access.holderOf(index);
      if (foreign) {
        throw new SchedulerError('CONCURRENCY_LIMIT', `实例 #${index} 正在${foreign}，${label}稍后再试。`, { instanceIndex: index, holder: foreign });
      }
      let entered = false;
      try {
        return await this.fileLock(this.leasePath(index), async () => {
          entered = true;
          throwIfAborted(options.signal);
          await labelInstanceLease(this.home, index, label);
          const noted = this.access.note(index, label);
          this.holders.set(index, { label, since: this.now() });
          try {
            const held = new Set(this.als.getStore() ?? []);
            held.add(index);
            return await this.als.run(held, fn);
          } finally {
            this.holders.delete(index);
            noted();
          }
        }, { timeoutMs: options.leaseTimeoutMs ?? this.leaseTimeoutMs });
      } catch (error) {
        if (!entered && codeOf(error) === 'LOCK_TIMEOUT') {
          const owner = await describeLeaseHolder(this.home, index);
          throw new SchedulerError('CONCURRENCY_LIMIT', owner
            ? `实例 #${index} 正在${owner}，${label}稍后再试。`
            : `实例 #${index} 正被登录、脚本计划或另一个助手进程占用，${label}稍后再试。`, { instanceIndex: index, holder: owner });
        }
        throw error;
      }
    } finally {
      release();
      if (this.chains.get(index) === tail) this.chains.delete(index);
    }
  }
}
