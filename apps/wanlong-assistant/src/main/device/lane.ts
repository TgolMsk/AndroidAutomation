import { AsyncLocalStorage } from 'node:async_hooks';
import type { WanlongErrorCode } from '../../shared/errors';

/** Original GLOBAL_ADB_CONCURRENCY: several instances capturing 14 MB frames at once also cost memory and CPU. */
export const GLOBAL_ADB_CONCURRENCY = 6;

/** Methods that take a screenshot and therefore respect the minimum capture interval. */
const CAPTURE_METHODS: ReadonlySet<PropertyKey> = new Set(['screencapRaw', 'screencapPng']);

/** Pending device work was discarded (the lane was dropped or the assistant is quitting). */
export class DeviceLaneCancelledError extends Error {
  readonly code: WanlongErrorCode = 'CANCELLED';

  constructor(message: string) {
    super(message);
    this.name = 'DeviceLaneCancelledError';
  }
}

export interface DeviceLaneOptions {
  /** Minimum gap between two screencaps of one instance (a number, or a live getter such as app settings). */
  minCaptureIntervalMs?: number | (() => number);
  /** At most this many device operations run at the same time across all instances. */
  globalConcurrency?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface DeviceLaneStats {
  index: number;
  pending: number;
  running: boolean;
  lastCaptureAt: number | null;
}

interface Task {
  work: () => Promise<unknown>;
  capture: boolean;
  held: ReadonlySet<number>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

interface Lane {
  queue: Task[];
  running: boolean;
  lastCaptureAt: number | null;
}

/** The part of core's `ManagerHost` the lane wraps. */
interface HostLike<M> {
  get(): Promise<M>;
}

/** The part of core's `AvdManager` the lane wraps. */
interface ManagerLike<D> {
  device(index: number): Promise<D>;
}

/** Counting semaphore for the global concurrency cap. */
class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async use<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active++;
    try { return await fn(); }
    finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }
}

/**
 * Device lanes (DECISIONS C「设备通道 DeviceLane」, original `adb/queue.ts` + the capture throttle in `adb/capture.ts`):
 * every adb operation the assistant sends to instance N runs on N's lane, one at a time and in order, with a global
 * cap across instances. Screencaps also keep a minimum interval per instance (the emulator's screencap throughput is
 * fixed at ≈4.3 frames/s; asking faster only queues). The wait happens inside the lane on purpose, so nothing else
 * jumps the queue meanwhile.
 *
 * Read-only paths (probe, advisor, bot screenshots, template capture) share the lanes with the writers, so a
 * screenshot can never interleave with a gather tap sequence on the same device at the transport level.
 *
 * Re-entrant: work already running on lane N (for example `text(value, beforeEach)` whose callback reads the
 * foreground) calls N's lane inline instead of queueing behind itself, tracked with AsyncLocalStorage.
 */
export class DeviceLanes {
  private readonly lanes = new Map<number, Lane>();
  private readonly context = new AsyncLocalStorage<ReadonlySet<number>>();
  private readonly global: Semaphore;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly managers = new WeakMap<object, object>();
  private disposed = false;

  constructor(private readonly options: DeviceLaneOptions = {}) {
    this.global = new Semaphore(Math.max(1, Math.floor(options.globalConcurrency ?? GLOBAL_ADB_CONCURRENCY)));
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => { const timer = setTimeout(resolve, ms); timer.unref?.(); }));
  }

  /**
   * Run `work` on instance `index`'s lane. `capture: true` waits for the minimum capture interval first. Use it
   * directly for a composite that must not be interleaved (e.g. foreground check → capture → foreground check).
   */
  run<T>(index: number, work: () => Promise<T>, options: { capture?: boolean } = {}): Promise<T> {
    const capture = options.capture === true;
    const held = this.context.getStore();
    if (held?.has(index)) {
      // Already on this lane (nested call from running work): run inline, still honouring the capture interval.
      const lane = this.lane(index);
      return capture ? this.captureInline(lane, work) : work();
    }
    if (this.disposed) return Promise.reject(new DeviceLaneCancelledError('助手正在退出，设备操作已取消'));
    return new Promise<T>((resolve, reject) => {
      const lane = this.lane(index);
      lane.queue.push({ work, capture, held: held ?? new Set(), resolve: resolve as (value: unknown) => void, reject });
      this.pump(index, lane);
    });
  }

  /** `device` with every method routed through instance `index`'s lane (same method names; all are async). */
  device<D extends object>(index: number, device: D): D {
    return new Proxy(device, {
      get: (target, prop) => {
        const value: unknown = Reflect.get(target, prop, target);
        if (typeof value !== 'function' || prop === 'constructor') return value;
        const method = value as (...args: unknown[]) => unknown;
        return (...args: unknown[]) => this.run(index, async () => method.apply(target, args), { capture: CAPTURE_METHODS.has(prop) });
      },
    });
  }

  /**
   * A manager host whose `get()` resolves to the same manager except that `device(i)` hands out lane-bound
   * devices. Give this to every service that talks to devices; everything else on the manager is untouched.
   */
  host<H extends HostLike<object>>(host: H): H {
    return new Proxy(host, {
      get: (target, prop) => {
        const value: unknown = Reflect.get(target, prop, target);
        if (prop === 'get' && typeof value === 'function') {
          return async () => this.manager((await (value as () => Promise<object>).call(target)) as ManagerLike<object>);
        }
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
  }

  /** `manager` with `device(i)` returning lane-bound devices (cached per manager object). */
  manager<M extends ManagerLike<object>>(manager: M): M {
    const cached = this.managers.get(manager);
    if (cached) return cached as M;
    const proxy = new Proxy(manager, {
      get: (target, prop) => {
        const value: unknown = Reflect.get(target, prop, target);
        if (prop === 'device' && typeof value === 'function') {
          return async (index: number) => this.device(index, await (value as (i: number) => Promise<object>).call(target, index));
        }
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    this.managers.set(manager, proxy);
    return proxy;
  }

  /** Discard queued (not yet started) work on one lane, e.g. after the instance was stopped. */
  drop(index: number, reason = `实例 #${index} 的设备操作队列已清空（通常是实例被停止或助手退出）`): void {
    const lane = this.lanes.get(index);
    if (!lane) return;
    const queued = lane.queue.splice(0);
    for (const task of queued) task.reject(new DeviceLaneCancelledError(reason));
    if (!lane.running) this.lanes.delete(index);
  }

  /** Reject everything still queued; running work finishes on its own (an adb child process is not killed). */
  dispose(): void {
    this.disposed = true;
    for (const index of [...this.lanes.keys()]) this.drop(index, '助手正在退出，设备操作已取消');
  }

  stats(): DeviceLaneStats[] {
    return [...this.lanes.entries()].map(([index, lane]) => ({ index, pending: lane.queue.length, running: lane.running, lastCaptureAt: lane.lastCaptureAt }))
      .sort((a, b) => a.index - b.index);
  }

  private lane(index: number): Lane {
    let lane = this.lanes.get(index);
    if (!lane) {
      lane = { queue: [], running: false, lastCaptureAt: null };
      this.lanes.set(index, lane);
    }
    return lane;
  }

  private minInterval(): number {
    const value = this.options.minCaptureIntervalMs;
    let ms: number;
    try { ms = typeof value === 'function' ? value() : value ?? 0; }
    catch { ms = 0; }
    return Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : 0;
  }

  private async waitCaptureSlot(lane: Lane): Promise<void> {
    if (lane.lastCaptureAt === null) return;
    const wait = this.minInterval() - (this.now() - lane.lastCaptureAt);
    if (wait > 0) await this.sleep(wait);
  }

  private async captureInline<T>(lane: Lane, work: () => Promise<T>): Promise<T> {
    await this.waitCaptureSlot(lane);
    try { return await work(); }
    finally { lane.lastCaptureAt = this.now(); }
  }

  private pump(index: number, lane: Lane): void {
    if (lane.running) return;
    const task = lane.queue.shift();
    if (!task) return; // The idle lane stays: it remembers the last capture time for the throttle.
    lane.running = true;
    const held = new Set(task.held);
    held.add(index);
    void this.global.use(() => this.context.run(held, () => (task.capture ? this.captureInline(lane, task.work) : task.work())))
      .then(task.resolve, task.reject)
      .finally(() => {
        lane.running = false;
        this.pump(index, lane);
      });
  }
}
