import { AsyncResource } from 'node:async_hooks';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { AndroidKey, ProbeReport, RawFrame } from '@avdm/automation';
import { ensureGameForeground, type GamePresence, type SerializedError } from '@avdm/automation/wanlong';
import { SchedulerError, abortError, codeOf, messageOf, sleep, throwIfAborted } from './errors';
import type { LogLevel } from './types';
import type {
  MainToWorker, VisionJobResult, VisionJobSpec, VisionQuery, VisionQueryResult, VisionRequest, WorkerToMain,
} from './vision-protocol';

/** After an abort, the worker gets this long to report back before it is terminated (its cache is lost). */
const ABORT_GRACE_MS = 5_000;
/** Idle workers are terminated after this long to bound memory; the next job recompiles once. */
const DEFAULT_IDLE_MS = 30 * 60_000;
/** A main-side hook (AI consult, game-update wait) suspends the job timeout for at most this long per call. */
const MAX_HOOK_MS = 30 * 60_000;
/** Taps per `input tap …; sleep …` shell command (original chunking). */
const TAPS_PER_SHELL = 32;
/**
 * Whitelisted pre-approval actions per job (the sampler ladder uses each at most once; cancel may follow twice;
 * the gather pre-gate ladder may consult the advisor twice).
 */
const WHITELIST_BUDGET = { closePopup: 1, exitCancel: 2, probeBack: 1, advise: 2 } as const;
type WhitelistAction = keyof typeof WHITELIST_BUDGET;
/**
 * A resource-table read allows only the popup's own × before its gate (original resources precheck): no blind BACK,
 * no exit-dialog cancel, no advisor. Enforced here too, not only by the worker's own code.
 */
const RESOURCES_WHITELIST_BUDGET: Readonly<Record<WhitelistAction, number>> = { closePopup: 1, exitCancel: 0, probeBack: 0, advise: 0 };

function whitelistBudget(spec: VisionJobSpec): Readonly<Record<WhitelistAction, number>> {
  return spec.kind === 'resources' ? RESOURCES_WHITELIST_BUDGET : WHITELIST_BUDGET;
}
/** A read-only query (recognize / match on a frame main holds) never takes longer than this. */
const DEFAULT_QUERY_TIMEOUT_MS = 60_000;

/** The subset of `@avdm/core` AdbDevice a vision job drives. */
export interface VisionDevice {
  screencapRaw(): Promise<RawFrame>;
  foregroundPackage(): Promise<string | undefined>;
  tap(x: number, y: number): Promise<void>;
  swipe(x1: number, y1: number, x2: number, y2: number, durationMs: number): Promise<void>;
  keyevent(key: AndroidKey): Promise<void>;
  startApp(packageName: string): Promise<void>;
  stopApp(packageName: string): Promise<void>;
  isAppRunning?(packageName: string): Promise<boolean>;
  shell?(command: string, options?: { timeoutMs?: number }): Promise<string>;
}

export interface VisionJobContext {
  device: VisionDevice;
  /** The only package this job may launch, stop or require in the foreground. */
  packageName: string;
  signal: AbortSignal;
  /** Hard cap for the whole job (suspended while a main-side hook runs). */
  timeoutMs: number;
  /**
   * The probe gate: resolves when the job may inject input beyond the whitelist (exactly one known anchor, the game
   * in the foreground, the same AVD). Rejects with the Chinese refusal.
   */
  approve(probe: ProbeReport): Promise<void>;
  /**
   * The same AVD still runs at this index (`getState` + `record.createdAt`): checked before every input, next to the
   * foreground package. Throws a Chinese reason.
   */
  assertInstance?(): Promise<void>;
  /** Monkey launch of `packageName` is allowed (cold-start recovery). */
  allowColdStart: boolean;
  /**
   * The instance's device lane (app shell `DeviceLanes.run`): a check-then-act sequence (foreground / identity check
   * → input, foreground check → screencap) runs as one unit on the lane, so no other lane user of this instance (a
   * read-only preview, the advisor, the bot) interleaves between the check and the act. The device calls inside
   * re-enter the lane. Absent in tests: the sequence just runs.
   */
  lane?<T>(work: () => Promise<T>): Promise<T>;
  log?(level: LogLevel, message: string): void;
  onShot?(label: string, raw: RawFrame): Promise<void>;
  onFrame?(raw: RawFrame): void;
  onCaptureFailed?(error: unknown): void;
  onUnrecognized?(raw: RawFrame): Promise<boolean | 'recovered' | 'updated'>;
  onAdvise?(raw: RawFrame, attempt: number): Promise<boolean>;
}

export interface VisionWorkerLike {
  on(event: 'message', listener: (message: WorkerToMain) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
  postMessage(message: MainToWorker, transferList?: ArrayBuffer[]): void;
  terminate(): Promise<number>;
}

interface PendingQuery {
  resolve(result: VisionQueryResult): void;
  reject(error: Error): void;
}

interface Slot {
  worker: VisionWorkerLike;
  job: ((message: WorkerToMain) => void) | null;
  onExit: ((error: Error) => void) | null;
  /** Read-only queries in flight on this worker (they never occupy `job`). */
  queries: Map<number, PendingQuery>;
  idle?: NodeJS.Timeout;
  dead: boolean;
}

export interface VisionWorkerPoolOptions {
  workerFactory?: (entry: string) => VisionWorkerLike;
  entry?: string;
  idleMs?: number;
}

function reviveError(error: SerializedError | undefined, fallback: string): SchedulerError {
  return new SchedulerError(error?.code ?? 'UNKNOWN', error?.message || fallback, error?.detail);
}

function serialize(error: unknown): SerializedError {
  return { code: codeOf(error), message: messageOf(error) };
}

function copyFrame(frame: RawFrame): { frame: RawFrame; transfer: ArrayBuffer[] } {
  const data = Uint8Array.from(frame.data);
  return { frame: { width: frame.width, height: frame.height, data, capturedAt: frame.capturedAt, ...(frame.format === undefined ? {} : { format: frame.format }) }, transfer: [data.buffer] };
}

function assertPoint(...values: number[]): void {
  for (const v of values) if (!Number.isFinite(v) || v < 0 || v > 16_384) throw new SchedulerError('INVALID_ARGUMENT', `无效的坐标：${v}`);
}

/**
 * Long-lived vision workers, one per instance: templates are compiled once per template set and reused by every
 * sample and gather cycle (original iron rule 10). Main keeps the device: every request is serialized per job,
 * inputs re-check the foreground package, and nothing but the whitelisted recovery actions runs before the probe
 * gate approves the job. The instance lock is the caller's (runner / scheduler).
 */
export class VisionWorkerPool {
  private readonly slots = new Map<number, Slot>();
  private readonly workerFactory: (entry: string) => VisionWorkerLike;
  private readonly entry: string;
  private readonly idleMs: number;
  private nextJobId = 1;
  private nextQueryId = 1;
  private disposed = false;

  constructor(options: VisionWorkerPoolOptions = {}) {
    this.entry = options.entry ?? join(dirname(fileURLToPath(import.meta.url)), 'vision-worker.js');
    this.workerFactory = options.workerFactory ?? ((entry) => new Worker(entry) as unknown as VisionWorkerLike);
    this.idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  }

  /** Workers alive right now (tests / diagnostics). */
  size(): number { return this.slots.size; }

  /** Drop every worker's compiled templates (the template library changed outside the manifest stamp check). */
  invalidate(): void {
    for (const slot of this.slots.values()) {
      try { slot.worker.postMessage({ type: 'invalidate' }); } catch { /* a dead worker is recreated anyway */ }
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.allSettled([...this.slots.keys()].map((index) => this.kill(index)));
  }

  run(index: number, spec: VisionJobSpec, ctx: VisionJobContext): Promise<VisionJobResult> {
    if (this.disposed) return Promise.reject(new SchedulerError('RUN_ABORTED', '助手正在退出'));
    if (ctx.signal.aborted) return Promise.reject(abortError(ctx.signal));
    const slot = this.slotFor(index);
    if (slot.job) return Promise.reject(new SchedulerError('CONCURRENCY_LIMIT', `实例 #${index} 的视觉任务正在进行，请稍后再试`));
    if (slot.idle) { clearTimeout(slot.idle); slot.idle = undefined; }
    const jobId = this.nextJobId++;
    return new Job(this, index, slot, jobId, spec, ctx).start();
  }

  /**
   * A read-only question about a frame main already holds (is it a known screen? where do these templates match?),
   * answered with the instance worker's cached compiled set. ★ Works while a job of that instance is running — the
   * AI recover path and the kicked probe ask from hooks the running sample / cycle is awaiting, so a second job
   * would only ever get CONCURRENCY_LIMIT. No device access, no approval, no instance lock needed.
   */
  query(index: number, query: VisionQuery, signal?: AbortSignal, timeoutMs = DEFAULT_QUERY_TIMEOUT_MS): Promise<VisionQueryResult> {
    if (this.disposed) return Promise.reject(new SchedulerError('RUN_ABORTED', '助手正在退出'));
    if (signal?.aborted) return Promise.reject(abortError(signal));
    const slot = this.slotFor(index);
    if (slot.idle) { clearTimeout(slot.idle); slot.idle = undefined; }
    const queryId = this.nextQueryId++;
    const { frame, transfer } = copyFrame(query.frame);
    let payload: VisionQuery = { ...query, frame };
    if (query.kind === 'frameDiff') {
      const other = copyFrame(query.other);
      payload = { ...query, frame, other: other.frame };
      transfer.push(...other.transfer);
    }
    return new Promise<VisionQueryResult>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const settle = (): void => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        slot.queries.delete(queryId);
        if (!slot.job && slot.queries.size === 0 && !slot.dead) this.released(index, slot, false);
      };
      const onAbort = (): void => { settle(); reject(abortError(signal!)); };
      slot.queries.set(queryId, {
        resolve: (result) => { settle(); resolve(result); },
        reject: (error) => { settle(); reject(error); },
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => { settle(); reject(new SchedulerError('TIMEOUT', '图像识别超时')); }, timeoutMs);
      timer.unref?.();
      try { slot.worker.postMessage({ type: 'query', queryId, query: payload }, transfer); }
      catch (error) { settle(); reject(new SchedulerError('UNKNOWN', `无法联系视觉工作线程：${messageOf(error)}`)); }
    });
  }

  /** @internal */
  released(index: number, slot: Slot, kill: boolean): void {
    slot.job = null;
    slot.onExit = null;
    if (kill || slot.dead) { void this.kill(index, slot); return; }
    if (this.disposed || slot.queries.size > 0) return;
    if (slot.idle) clearTimeout(slot.idle);
    slot.idle = setTimeout(() => { void this.kill(index, slot); }, this.idleMs);
    slot.idle.unref?.();
  }

  private slotFor(index: number): Slot {
    const existing = this.slots.get(index);
    if (existing && !existing.dead) return existing;
    const worker = this.workerFactory(this.entry);
    const slot: Slot = { worker, job: null, onExit: null, queries: new Map(), dead: false };
    const failQueries = (error: Error): void => {
      for (const pending of [...slot.queries.values()]) pending.reject(error);
    };
    worker.on('message', (message) => {
      if (message.type === 'queryResult') {
        const pending = slot.queries.get(message.queryId);
        if (!pending) return;
        if (message.ok) pending.resolve(message.result);
        else pending.reject(reviveError(message.error, '图像识别失败'));
        return;
      }
      slot.job?.(message);
    });
    worker.on('error', (error) => { slot.dead = true; slot.onExit?.(error); failQueries(error); });
    worker.on('exit', (code) => {
      slot.dead = true;
      if (this.slots.get(index) === slot) this.slots.delete(index);
      const error = new SchedulerError('UNKNOWN', `视觉工作线程已退出 (${code})`);
      slot.onExit?.(error);
      failQueries(error);
    });
    this.slots.set(index, slot);
    return slot;
  }

  private async kill(index: number, slot = this.slots.get(index)): Promise<void> {
    if (!slot) return;
    if (slot.idle) clearTimeout(slot.idle);
    slot.dead = true;
    if (this.slots.get(index) === slot) this.slots.delete(index);
    await slot.worker.terminate().catch(() => undefined);
  }
}

/** One job on one worker: device RPC, the two-level input gate, timeouts and settle-once bookkeeping. */
class Job {
  private approved = false;
  private readonly spent: Record<WhitelistAction, number> = { closePopup: 0, exitCancel: 0, probeBack: 0, advise: 0 };
  private deviceQueue: Promise<void> = Promise.resolve();
  private readonly shots: Promise<void>[] = [];
  private settled = false;
  private timer?: NodeJS.Timeout;
  private deadline: number;
  private suspended = 0;
  private abortTimer?: NodeJS.Timeout;
  private resolve!: (value: VisionJobResult) => void;
  private reject!: (error: Error) => void;
  private readonly controller = new AbortController();

  constructor(
    private readonly pool: VisionWorkerPool, private readonly index: number, private readonly slot: Slot,
    private readonly jobId: number, private readonly spec: VisionJobSpec, private readonly ctx: VisionJobContext,
  ) {
    this.deadline = Date.now() + ctx.timeoutMs;
  }

  /**
   * ★ Must be called in the caller's async context (inside the instance lock for samples and cycles). Worker messages
   * arrive on the worker's MessagePort, whose context is wherever the long-lived worker was first created, so every
   * worker-originated callback (hooks, device RPC, shots) is re-entered in the job's own context: a hook that calls
   * `exclusive()` then re-enters the lock the job holds instead of queueing behind it.
   */
  start(): Promise<VisionJobResult> {
    const scope = new AsyncResource('wanlong.vision-job');
    return new Promise<VisionJobResult>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
      this.slot.job = (message) => scope.runInAsyncScope(() => this.onMessage(message));
      this.slot.onExit = (error) => scope.runInAsyncScope(() => this.finish(error, undefined, true));
      this.ctx.signal.addEventListener('abort', this.onAbort, { once: true });
      this.armTimer();
      this.post({ type: 'job', jobId: this.jobId, spec: this.spec });
    });
  }

  private readonly onAbort = (): void => this.abort(abortError(this.ctx.signal));

  private post(message: MainToWorker, transfer?: ArrayBuffer[]): void {
    try { this.slot.worker.postMessage(message, transfer); }
    catch (error) { this.finish(new SchedulerError('UNKNOWN', `无法联系视觉工作线程：${messageOf(error)}`), undefined, true); }
  }

  private armTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.suspended > 0 || this.settled) return;
    this.timer = setTimeout(() => this.abort(new SchedulerError('TIMEOUT', '视觉任务超时，已中止（模拟器可能卡住或截图过慢）')),
      Math.max(0, this.deadline - Date.now()));
    this.timer.unref?.();
  }

  /** Run a main-side hook without charging its time to the job (capped per call). */
  private async suspendTimeout<T>(work: () => Promise<T>): Promise<T> {
    const started = Date.now();
    this.suspended++;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    try {
      return await Promise.race([
        work(),
        sleep(MAX_HOOK_MS, this.controller.signal).then(() => { throw new SchedulerError('TIMEOUT', '外部处理超过 30 分钟，已放弃'); }),
      ]);
    } finally {
      this.suspended--;
      this.deadline += Date.now() - started;
      this.armTimer();
    }
  }

  private abort(error: SchedulerError): void {
    if (this.settled || this.controller.signal.aborted) return;
    this.controller.abort(error);
    this.post({ type: 'abort', jobId: this.jobId, error: serialize(error) });
    // The worker may be stuck inside OpenCV: give it a grace period, then kill it (the next job recompiles).
    this.abortTimer = setTimeout(() => this.finish(error, undefined, true), ABORT_GRACE_MS);
    this.abortTimer.unref?.();
  }

  private finish(error?: Error, result?: VisionJobResult, kill = false): void {
    if (this.settled) return;
    this.settled = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.abortTimer) clearTimeout(this.abortTimer);
    this.ctx.signal.removeEventListener('abort', this.onAbort);
    if (!this.controller.signal.aborted) this.controller.abort(new SchedulerError('RUN_ABORTED', '视觉任务已结束'));
    // ADB commands already started cannot be cancelled: keep the job (and the caller's instance lock) until every
    // queued device call and shot save has settled, so the next job never overlaps an old tap.
    void (async () => {
      await this.deviceQueue;
      await Promise.allSettled(this.shots);
      this.pool.released(this.index, this.slot, kill);
      if (error) this.reject(this.ctx.signal.aborted && !(error instanceof SchedulerError && error.code === 'TIMEOUT') ? abortError(this.ctx.signal) : error);
      else if (result) this.resolve(result);
      else this.reject(new SchedulerError('UNKNOWN', '视觉工作线程未返回结果'));
    })();
  }

  private onMessage(message: WorkerToMain): void {
    if (this.settled || message.type === 'queryResult' || message.jobId !== this.jobId) return;
    switch (message.type) {
      case 'request': {
        const { id } = message;
        this.queue(async () => {
          try {
            const { value, transfer } = await this.handle(message);
            this.post({ type: 'response', jobId: this.jobId, id, ok: true, value }, transfer);
          } catch (error) {
            this.post({ type: 'response', jobId: this.jobId, id, ok: false, error: serialize(error) });
          }
        });
        return;
      }
      case 'ready':
        this.queue(async () => {
          try {
            throwIfAborted(this.controller.signal);
            await this.ctx.approve(message.probe);
            throwIfAborted(this.controller.signal);
            this.approved = true;
            this.post({ type: 'approved', jobId: this.jobId });
          } catch (error) {
            this.post({ type: 'denied', jobId: this.jobId, reason: messageOf(error) });
          }
        });
        return;
      case 'log':
        try { this.ctx.log?.(message.level, message.message); } catch { /* observers never break a job */ }
        return;
      case 'shot':
        if (this.ctx.onShot) this.shots.push(this.ctx.onShot(message.label, message.raw).catch(() => undefined));
        return;
      case 'result':
        if ((message.result.kind === 'gather' || message.result.kind === 'resources') && !this.approved) {
          this.finish(new SchedulerError('PROBE_REJECTED', message.result.kind === 'gather' ? '采集工作线程越过探针门槛' : '资源统计读取越过探针门槛'));
          return;
        }
        this.finish(undefined, message.result);
        return;
      case 'failed':
        this.finish(reviveError(message.error, '视觉任务失败'));
        return;
    }
  }

  private queue(operation: () => Promise<void>): void {
    const call = this.deviceQueue.then(operation);
    this.deviceQueue = call.catch(() => undefined);
  }

  private requireApproved(what: string): void {
    if (!this.approved) throw new SchedulerError('PROBE_REJECTED', `探针通过前禁止注入设备输入（${what}）`);
  }

  private spend(kind: WhitelistAction): void {
    const budget = whitelistBudget(this.spec)[kind];
    if (budget === 0) throw new SchedulerError('PROBE_REJECTED', `探针通过前禁止注入设备输入（这类作业不允许 ${kind}）`);
    if (this.spent[kind] >= budget) {
      throw new SchedulerError('PROBE_REJECTED', `探针通过前的恢复动作次数已用完（${kind}），不再盲点`);
    }
    this.spent[kind]++;
  }

  private async assertForeground(): Promise<void> {
    const foreground = await this.ctx.device.foregroundPackage();
    if (foreground !== this.ctx.packageName) {
      throw new SchedulerError('NOT_FOUND', `万龙觉醒已离开前台（当前：${foreground ?? '未知'}），已停止输入`);
    }
  }

  /** Before every input: the same AVD (identity) and, unless launching it, the game in front. */
  private async assertInputTarget(foreground = true): Promise<void> {
    if (this.ctx.assertInstance) {
      try { await this.ctx.assertInstance(); }
      catch (error) {
        throw error instanceof SchedulerError ? error : new SchedulerError('DEVICE_NOT_READY', `${messageOf(error)}，已停止输入`);
      }
      this.check();
    }
    if (foreground) await this.assertForeground();
  }

  private check(): void {
    throwIfAborted(this.controller.signal);
  }

  /** Run a check-then-act sequence as one unit on the instance's device lane (see `VisionJobContext.lane`). */
  private onLane<T>(work: () => Promise<T>): Promise<T> {
    return this.ctx.lane ? this.ctx.lane(work) : work();
  }

  private async handle(request: VisionRequest): Promise<{ value?: unknown; transfer?: ArrayBuffer[] }> {
    const { device, packageName } = this.ctx;
    this.check();
    switch (request.op) {
      case 'capture': {
        const frame = await this.onLane(async (): Promise<RawFrame> => {
          // Once approved, frames are only taken of the game itself (conventions §5.3): a foreign screen ends the job.
          if (this.approved) await this.assertForeground();
          try { return await device.screencapRaw(); }
          catch (error) {
            if (!this.controller.signal.aborted) this.ctx.onCaptureFailed?.(error);
            throw new SchedulerError(codeOf(error) === 'UNKNOWN' ? 'COMMAND_FAILED' : codeOf(error), `ADB 截图失败: ${messageOf(error)}`);
          }
        });
        this.check();
        try { this.ctx.onFrame?.(frame); } catch { /* observers never break a job */ }
        const copy = copyFrame(frame);
        return { value: copy.frame, transfer: copy.transfer };
      }
      case 'foregroundPackage':
        return { value: (await device.foregroundPackage()) ?? null };
      case 'isAppRunning':
        return { value: device.isAppRunning ? await device.isAppRunning(packageName) : null };
      case 'ensureGame': {
        if (!this.ctx.allowColdStart) return { value: 'failed' satisfies GamePresence };
        const presence = await ensureGameForeground({
          foreground: async () => (await device.foregroundPackage()) ?? null,
          // ★ Monkey only (`startApp` without an activity): `am start` returns success but the game never starts.
          launch: () => this.onLane(async () => { await this.assertInputTarget(false); this.check(); await device.startApp(packageName); }),
          ...(device.isAppRunning ? { isRunning: () => device.isAppRunning!(packageName) } : {}),
          log: (level, message) => this.ctx.log?.(level, message),
          sleep: (ms) => sleep(ms, this.controller.signal),
          checkAlive: () => this.check(),
        }, { packageName });
        return { value: presence };
      }
      case 'tap': {
        const [x, y, intent] = request.args;
        assertPoint(x, y);
        if (!this.approved) {
          if (intent !== 'closePopup' && intent !== 'exitCancel') this.requireApproved('点击');
          else this.spend(intent);
        }
        await this.onLane(async () => {
          await this.assertInputTarget();
          this.check();
          await device.tap(x, y);
        });
        return {};
      }
      case 'tapMany': {
        this.requireApproved('连点');
        const [points, gapMs] = request.args;
        if (!Array.isArray(points) || points.length === 0 || points.length > 256) throw new SchedulerError('INVALID_ARGUMENT', '连点参数无效');
        for (const [x, y] of points) assertPoint(x, y);
        const gap = Math.max(0, Math.min(5_000, Number.isFinite(gapMs) ? gapMs : 0));
        for (let i = 0; i < points.length; i += TAPS_PER_SHELL) {
          const chunk = points.slice(i, i + TAPS_PER_SHELL);
          await this.onLane(async () => {
            await this.assertInputTarget();
            this.check();
            if (device.shell) {
              // One shell per chunk (measured: 5 taps 103 ms separately, 34 ms merged); coordinates are integers.
              const sleepPart = gap > 0 ? `; sleep ${(gap / 1000).toFixed(3)}` : '';
              const command = chunk.map(([x, y]) => `input tap ${Math.round(x)} ${Math.round(y)}`).join(`${sleepPart}; `);
              await device.shell(command, { timeoutMs: 10_000 + chunk.length * (gap + 200) });
            } else {
              for (const [x, y] of chunk) {
                await device.tap(x, y);
                if (gap > 0) await sleep(gap, this.controller.signal);
              }
            }
          });
        }
        return {};
      }
      case 'swipe': {
        this.requireApproved('滑动');
        const [x1, y1, x2, y2, ms] = request.args;
        assertPoint(x1, y1, x2, y2);
        await this.onLane(async () => {
          await this.assertInputTarget();
          this.check();
          await device.swipe(x1, y1, x2, y2, Math.max(0, Math.min(10_000, ms)));
        });
        return {};
      }
      case 'key': {
        const [key, intent] = request.args;
        if (!this.approved) {
          if (intent !== 'probeBack' || key !== 'BACK') this.requireApproved('按键');
          else this.spend('probeBack');
        }
        await this.onLane(async () => {
          await this.assertInputTarget();
          this.check();
          await device.keyevent(key);
        });
        return {};
      }
      case 'launchApp': {
        this.requireApproved('启动应用');
        const [pkg, cold] = request.args;
        if (pkg !== packageName) throw new SchedulerError('INVALID_ARGUMENT', '禁止启动其他应用');
        await this.onLane(async () => {
          await this.assertInputTarget(false);
          this.check();
          if (cold) await device.stopApp(packageName);
          this.check();
          await device.startApp(packageName);
        });
        // The wait polls the lane call by call: other users of the instance's lane are not held up for a minute.
        await this.waitForForeground();
        return {};
      }
      case 'stopApp': {
        this.requireApproved('停止应用');
        const [pkg] = request.args;
        if (pkg !== packageName) throw new SchedulerError('INVALID_ARGUMENT', '禁止停止其他应用');
        await this.onLane(async () => {
          await this.assertInputTarget();
          this.check();
          await device.stopApp(packageName);
        });
        return {};
      }
      case 'unrecognized': {
        const [raw] = request.args;
        const hook = this.ctx.onUnrecognized;
        const value = hook ? await this.suspendTimeout(() => hook(raw)) : false;
        return { value };
      }
      case 'advise': {
        // Before the gate only a limited number of consults (DECISIONS C ④); the advisor acts in main under its
        // own whitelist and switches (autoActions), re-entering the instance lock this job holds.
        if (!this.approved) this.spend('advise');
        const [raw, attempt] = request.args;
        const hook = this.ctx.onAdvise;
        const value = hook ? await this.suspendTimeout(() => hook(raw, attempt)) : false;
        return { value: value === true };
      }
    }
  }

  private async waitForForeground(): Promise<void> {
    const deadline = Date.now() + 60_000;
    for (;;) {
      this.check();
      if (await this.ctx.device.foregroundPackage() === this.ctx.packageName) return;
      if (Date.now() >= deadline) throw new SchedulerError('TIMEOUT', '启动万龙觉醒后 60 秒仍未进入前台');
      await sleep(1_000, this.controller.signal);
    }
  }
}
