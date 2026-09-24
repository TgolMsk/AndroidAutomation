import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isAvdmError, withFileLock } from '@avdm/core';

/** Same staleness rule as core's `withFileLock` (a holder refreshes the lock's mtime every 10 s). */
const LEASE_STALE_MS = 30_000;
const OWNER_FILE = 'owner.json';

/** Refused because another activity holds the instance. `code` survives IPC so the UI can branch on it. */
export class InstanceBusyError extends Error {
  readonly code = 'CONCURRENCY_LIMIT';

  constructor(readonly index: number, readonly owner: string | null, message?: string) {
    super(message ?? (owner ? `实例 #${index} 正在${owner}，请等待结束后再试。` : `实例 #${index} 正被登录、采集或脚本计划占用，请等待结束后再试。`));
    this.name = 'InstanceBusyError';
  }
}

export interface AccessHolder {
  index: number;
  label: string;
  since: number;
}

/**
 * The in-process occupancy table (original `instanceAccess`). `acquire()` is synchronous and must be called before
 * the first await of an operation, so two IPC calls can never both claim one device. The returned release only
 * removes its own token: a stale release after someone else re-acquired the index is a no-op.
 *
 * It is the single place that answers "is anything touching an instance right now" (`anyBusy()`, used by the update
 * gate). Merely having automatic gather enabled does not count: that is only a timer.
 */
export class InstanceAccess {
  private readonly owners = new Map<number, { label: string; since: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  acquire(index: number, label: string): () => void {
    const owner = this.owners.get(index);
    if (owner) throw new InstanceBusyError(index, owner.label);
    const token = { label, since: this.now() };
    this.owners.set(index, token);
    return () => {
      if (this.owners.get(index) === token) this.owners.delete(index);
    };
  }

  /** `acquire` without throwing: null when the instance is taken. */
  tryAcquire(index: number, label: string): (() => void) | null {
    return this.owners.has(index) ? null : this.acquire(index, label);
  }

  holderOf(index: number): string | null {
    return this.owners.get(index)?.label ?? null;
  }

  holders(): AccessHolder[] {
    return [...this.owners.entries()].map(([index, owner]) => ({ index, label: owner.label, since: owner.since }))
      .sort((a, b) => a.index - b.index);
  }

  /** 「实例 #N 正在<label>。」 for the first held instance, or null when nothing is held. */
  anyBusy(): string | null {
    const first = this.holders()[0];
    return first ? `实例 #${first.index} 正在${first.label}。` : null;
  }

  /** Run `fn` while holding the instance (taken synchronously, released on success, failure or abort). */
  async run<T>(index: number, label: string, fn: () => Promise<T>): Promise<T> {
    const release = this.acquire(index, label);
    try { return await fn(); }
    finally { release(); }
  }
}

/** `<AVDM_HOME>/run/automation-instance-<i>.lock`: the cross-process device lease every assistant writer takes. */
export function instanceLeasePath(home: string, index: number): string {
  return path.join(home, 'run', `automation-instance-${index}.lock`);
}

export interface LeaseOwner {
  /** Activity label written by `withInstanceLease`; null for holders that do not write one yet. */
  label: string | null;
  pid: number | null;
  at: number | null;
}

/** The live holder of an instance's lease, or null when the lease is free (or abandoned). */
export async function readLeaseOwner(home: string, index: number, now: () => number = Date.now): Promise<LeaseOwner | null> {
  const lock = instanceLeasePath(home, index);
  try {
    const st = await stat(lock);
    if (!st.isDirectory() || now() - st.mtimeMs > LEASE_STALE_MS) return null;
  } catch {
    return null;
  }
  try {
    const raw = JSON.parse(await readFile(path.join(lock, OWNER_FILE), 'utf8')) as Record<string, unknown>;
    return {
      label: typeof raw['label'] === 'string' && raw['label'] ? raw['label'].slice(0, 60) : null,
      pid: typeof raw['pid'] === 'number' ? raw['pid'] : null,
      at: typeof raw['at'] === 'number' ? raw['at'] : null,
    };
  } catch {
    return { label: null, pid: null, at: null };
  }
}

export interface InstanceLeaseOptions {
  /** How long to wait for the cross-process lock (writers use 100–200 ms: a busy device is refused, not queued). */
  timeoutMs?: number;
  /** Also claim the in-process table first (synchronously, before any await). */
  access?: InstanceAccess;
}

/**
 * Take an instance for `label`: the in-process table (optional) and then the cross-process file lease, with an
 * `owner.json` inside the lock directory so another process can say who holds it. A lock timeout becomes an
 * `InstanceBusyError` naming the holder instead of core's generic 「等待文件锁超时」.
 *
 * Not re-entrant (neither is `withFileLock`): code inside `fn` must not take the same lease again.
 */
export async function withInstanceLease<T>(
  home: string, index: number, label: string, fn: () => Promise<T>, options: InstanceLeaseOptions = {},
): Promise<T> {
  const release = options.access?.acquire(index, label);
  try {
    const lock = instanceLeasePath(home, index);
    try {
      return await withFileLock(lock, async () => {
        await writeFile(path.join(lock, OWNER_FILE), `${JSON.stringify({ label, pid: process.pid, at: Date.now() })}\n`, { mode: 0o600 })
          .catch(() => undefined); // The label is informational; the lock itself is what excludes.
        return fn();
      }, { timeoutMs: options.timeoutMs ?? 200 });
    } catch (error) {
      if (!isAvdmError(error, 'LOCK_TIMEOUT')) throw error;
      const owner = await readLeaseOwner(home, index);
      const other = owner?.pid !== null && owner?.pid !== undefined && owner.pid !== process.pid;
      throw new InstanceBusyError(index, owner?.label ?? null,
        owner?.label ? `实例 #${index} 正在${owner.label}${other ? '（另一个助手进程）' : ''}，请等待结束后再试。` : undefined);
    }
  } finally {
    release?.();
  }
}

const LEASE_PATH_RE = /automation-instance-(\d+)\.lock/;

/**
 * Turn core's generic 「等待文件锁超时: …/automation-instance-<i>.lock」 into an `InstanceBusyError` naming the holder
 * (when it wrote a label). Any other error is returned unchanged. Never throws.
 */
export async function explainLeaseTimeout(error: unknown, home: string | undefined): Promise<unknown> {
  try {
    if (!home || !isAvdmError(error, 'LOCK_TIMEOUT')) return error;
    const match = LEASE_PATH_RE.exec(error.message);
    if (!match || !error.message.includes(path.join(home, 'run'))) return error;
    const index = Number(match[1]);
    const owner = await readLeaseOwner(home, index);
    const other = owner?.pid !== null && owner?.pid !== undefined && owner.pid !== process.pid;
    return new InstanceBusyError(index, owner?.label ?? null,
      owner?.label ? `实例 #${index} 正在${owner.label}${other ? '（另一个助手进程）' : ''}，请等待结束后再试。` : undefined);
  } catch {
    return error;
  }
}

