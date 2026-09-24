import path from 'node:path';
import { withFileLock } from '@avdm/core';
import type { RawFrame } from '@avdm/automation';
import {
  HEALTH_PROBE_REASON,
  MAX_TRAVEL_HINTS,
  applySample,
  backoffMs,
  defaultSchedulerConfig,
  emptyInstanceState,
  formatDuration,
  hasFreeSlot,
  marchesGone,
  mergeSchedulerConfig,
  planNextWake,
  type InstanceQueueState,
  type PanelSample,
  type SchedulerConfig,
  type TravelHint,
  type TravelTimeSource,
  type WakeInfo,
} from '@avdm/automation/wanlong/pure';
import { formatCstClock } from '../../shared/time';
import type { SchedulerQueueState, SchedulerServiceStatus } from '../../shared/ipc/scheduler';
import {
  SchedulerError, abortError, codeOf, isAbortCode, isAttentionCode, messageOf, sleep, throwIfAborted,
} from './errors';
import { InstanceLocks } from './instance-lock';
import { SchedulerStore, trimHints, type PersistedQueue } from './store';
import { WakeTimers, type WakeTask } from './timers';
import type {
  DispatchNote, EtaSchedulerPorts, FrameContext, LogLevel, QueueFreeHook, QueueFreeResult, SchedulerHooks,
} from './types';

const GAME_ID = 'wanlong';
/** After an abort, give the in-flight chain this long to release the instance (original ABORT_DRAIN_MS). */
const ABORT_DRAIN_MS = 5_000;
/** Re-read the queue this long after a script released the instance: the screen was touched, old state is stale. */
const RESAMPLE_AFTER_SCRIPT_MS = 15_000;
/** Extra safety of this port (the original relied on the alert centre alone): pause after this many real failures. */
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 8;
/**
 * Shutdown waits this long for in-flight work to let go of the instances after aborting it (the vision worker's own
 * abort grace is 5 s); the shell bounds the whole addon dispose at 15 s.
 */
const DISPOSE_DRAIN_MS = 8_000;
/**
 * A read-only process retries the scheduler lease this often. The lease of a crashed / force-quit owner stops being
 * refreshed and expires after 30 s (withFileLock's stale age), so a restart right after a crash takes over by itself.
 */
const OWNER_RETRY_MS = 10_000;
/** Mutating entry points wait this long for `restore()` before going ahead (the merge keeps live runtimes anyway). */
const RESTORE_WAIT_MS = 15_000;
const READ_ONLY_MESSAGE = '另一个万龙助手进程正在管理自动采集调度，本窗口只显示状态，不会排期或自动派遣。' +
  '如果并没有别的窗口（例如上次异常退出后留下的调度租约），本窗口会在约 30 秒内自动接管。';

export interface EtaSchedulerOptions {
  now?: () => number;
  random?: () => number;
  locks?: InstanceLocks;
  maxConsecutiveFailures?: number;
  /** Test seam for the single-owner service lease. */
  ownerLease?: boolean;
  /** Test seam: how often a read-only process retries the lease (default 10 s). */
  ownerRetryMs?: number;
  /** Host wiring (IPC push). Separate from `setHooks` so later modules cannot unplug the renderer by accident. */
  publish?(state: SchedulerQueueState): void;
  publishConfig?(config: SchedulerConfig): void;
  /** Owner / read-only changes of this process (the UI explains why nothing is scheduled while read-only). */
  publishStatus?(status: SchedulerServiceStatus): void;
  log?(level: LogLevel, message: string): void;
  /** The consecutive-failure safety pause fired (before auto is switched off). */
  onSafetyPause?(index: number, failureCount: number, reason: string): void;
  /**
   * A human-needed pause (GAME_UPDATE_REQUIRED / AI_RISK_BLOCKED) while no module has set the `onNeedsAttention` hook:
   * the host's fallback alert path, so such a pause is never silent.
   */
  onAttentionPause?(index: number, info: { code: string; message: string }): void;
}

interface Runtime {
  state: InstanceQueueState;
  /** AVD identity (`record.createdAt`) the bookkeeping belongs to. */
  identity: string | null;
  travelHints: TravelHint[];
  failureCount: number;
  lastHealthProbeAt?: number;
  /**
   * No sample wake before this (circuit breaker cooldown). Health probes still run inside it, so kicked / game-exit
   * detection keeps its `healthProbeIntervalMin` latency.
   */
  cooldownUntil?: number;
  autoController?: AbortController;
  autoRequest: number;
  /** Script runs holding the instance (suspendForScript). While > 0 nothing new starts. */
  scriptHolds: number;
  operatingDepth: number;
}

interface SampleOptions {
  signal: AbortSignal;
  force: boolean;
  allowColdStart: boolean;
}

/**
 * ETA-driven gather scheduler (port of the original main-process `SchedulerImpl`).
 *
 *   sample:  open the troop panel → read each row (status, countdown) → close it
 *   book:    freeAt = sampledAt + remaining (fatigue-adjusted) + travel time   (absolute times, survive restarts)
 *   show:    the renderer extrapolates every second from the same pure functions, zero ADB traffic
 *   wake:    a timer on freeAt + slack (late rather than early), then re-read the panel; only a free slot hands off
 *            to the QueueFreeHook (the G0–G16 gather cycle); full/unknown queues back off 30 s → … → 5 min
 *
 * The scheduler decides when to look and what it saw; it never decides where to send troops.
 */
export class EtaScheduler {
  readonly locks: InstanceLocks;
  private readonly store: SchedulerStore;
  private readonly timers: WakeTimers;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly maxFailures: number;
  private readonly runtimes = new Map<number, Runtime>();
  private readonly lifetime = new AbortController();
  private hooks: SchedulerHooks = {};
  private queueFreeHook: QueueFreeHook | null = null;
  private config: SchedulerConfig = defaultSchedulerConfig();
  private restored: Promise<void> | null = null;
  private stopping = false;
  private readOnly = false;
  private readOnlySince: number | null = null;
  private ownerRelease: (() => Promise<void>) | null = null;
  private ownerRetry?: NodeJS.Timeout;
  private takeover: Promise<void> | null = null;
  /** saveConfig ran before restore finished loading: the file is older than memory. */
  private configTouched = false;

  constructor(private readonly home: string, private readonly ports: EtaSchedulerPorts, private readonly options: EtaSchedulerOptions = {}) {
    if (!path.isAbsolute(home)) throw new Error('调度数据目录必须是绝对路径');
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.locks = options.locks ?? new InstanceLocks(home);
    this.store = new SchedulerStore(home, this.now);
    this.timers = new WakeTimers(this.now, (key, error) => this.log('error', `实例 #${key} 唤醒回调抛错：${messageOf(error)}`));
    this.maxFailures = options.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES;
  }

  // ── hooks ────────────────────────────────────────────────────────────────

  /** Merge hooks (later modules call this from main/index.ts). Passing `undefined` for a key removes it. */
  setHooks(hooks: Partial<SchedulerHooks>): void {
    this.hooks = { ...this.hooks, ...hooks };
  }

  /** The gather cycle hand-off. Install before `restore()` so re-armed wakes can dispatch. */
  setQueueFreeHook(hook: QueueFreeHook | null): void {
    this.queueFreeHook = hook;
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  /**
   * Load persisted bookkeeping and re-arm auto instances. Never samples at startup: the emulator may not be up yet
   * and the user may not want the device touched. A corrupt file is moved aside; startup never blocks on it.
   */
  restore(): Promise<void> {
    this.restored ??= this.doRestore();
    return this.restored;
  }

  private async doRestore(): Promise<void> {
    const owner = this.options.ownerLease === false || await this.tryOwnerLease();
    if (!owner) {
      // A viewer only shows the owner's state: no migration, no identity reset, no timers, no writes. It keeps
      // retrying the lease, so a lease left behind by a crash never makes this window read-only for good.
      this.readOnly = true;
      this.readOnlySince = this.now();
      this.log('warn', READ_ONLY_MESSAGE);
      await this.loadPersisted(false);
      this.publishStatus();
      this.scheduleOwnerRetry();
      return;
    }
    const adopted = await this.loadPersisted(false);
    await this.startOwning(adopted, '面板重启后恢复排期');
  }

  /**
   * Read config and per-instance bookkeeping from disk. At startup (`overwrite` false) an instance that an operation
   * already registered keeps its live runtime (its AbortController, lock depth and fresh sample must not be orphaned);
   * a takeover (`overwrite` true) refreshes the persisted fields of every runtime in place, because the previous
   * owner kept writing while this process only viewed. @returns the runtimes taken from disk
   */
  private async loadPersisted(overwrite: boolean): Promise<Runtime[]> {
    const { config, warnings } = await this.store.loadConfig();
    if (overwrite || !this.configTouched) this.config = config;
    const loaded = await this.store.loadInstances();
    for (const w of [...warnings, ...loaded.warnings]) this.log('warn', w);
    const adopted: Runtime[] = [];
    for (const item of loaded.instances) {
      const live = this.runtimes.get(item.instanceIndex);
      if (!live) {
        const rt = this.fromPersisted(item);
        this.runtimes.set(item.instanceIndex, rt);
        adopted.push(rt);
      } else if (overwrite) {
        const fresh = this.fromPersisted(item);
        live.state = { ...fresh.state, sampling: live.state.sampling, operating: live.state.operating };
        live.identity = fresh.identity;
        // Dispatches noted while viewing (manual cycles) are kept next to the owner's.
        const seen = new Set(fresh.travelHints.map((hint) => `${hint.at}:${hint.coord ?? ''}`));
        live.travelHints = trimHints([...fresh.travelHints, ...live.travelHints.filter((hint) => !seen.has(`${hint.at}:${hint.coord ?? ''}`))]);
        live.failureCount = fresh.failureCount;
        adopted.push(live);
      }
    }
    return adopted;
  }

  /** Become the scheduling process: migrate the legacy switch and re-arm every auto instance among `candidates`. */
  private async startOwning(candidates: readonly Runtime[], why: string): Promise<void> {
    this.readOnly = false;
    this.readOnlySince = null;
    await this.migrateLegacy();
    const migrated = [...this.runtimes.values()].filter((rt) => !candidates.includes(rt) && rt.state.auto && !rt.autoController);
    let armed = 0;
    for (const rt of [...candidates, ...migrated]) {
      if (!rt.state.auto || this.stopping) continue;
      const index = rt.state.instanceIndex;
      try {
        const instance = await this.ports.instance(index);
        if (!instance || (rt.identity && instance.createdAt !== rt.identity)) {
          this.resetBookkeeping(rt);
          this.applyAuto(rt, false, instance ? '原实例已被替换，自动调度已关闭，请重新确认后再开启' : '实例已不存在，自动调度已关闭');
          await this.persist(rt);
          continue;
        }
        rt.identity ??= instance.createdAt;
        if (!rt.autoController || rt.autoController.signal.aborted) rt.autoController = new AbortController();
        this.rearm(index, why);
        armed++;
      } catch (error) {
        // ★ Never auto=true without a timer: retry on the backoff ladder; the wake re-checks the instance identity.
        this.log('warn', `实例 #${index} 的调度恢复时读不到实例状态，按退避稍后重试：${messageOf(error)}`);
        if (!rt.autoController || rt.autoController.signal.aborted) rt.autoController = new AbortController();
        this.rearm(index, `恢复排期时读不到实例状态：${messageOf(error)}`, 1);
        armed++;
      }
    }
    this.publishStatus();
    this.log('info', `ETA 调度器已就绪，恢复了 ${this.runtimes.size} 个实例的记账，其中 ${armed} 个开着自动调度。`);
  }

  /** Try the single-owner lease once (150 ms). @returns whether this process now owns the scheduler */
  private async tryOwnerLease(): Promise<boolean> {
    const lease = path.join(this.home, 'automation', 'games', GAME_ID, 'eta-scheduler.lock');
    let entered!: () => void;
    let exit!: () => void;
    const acquired = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { exit = resolve; });
    const lockDone = withFileLock(lease, async () => { entered(); await held; }, { timeoutMs: 150 });
    const winner = await Promise.race([acquired.then(() => true), lockDone.then(() => false, () => false)]);
    if (!winner) return false;
    this.ownerRelease = async () => { exit(); await lockDone.catch(() => undefined); };
    return true;
  }

  private scheduleOwnerRetry(): void {
    if (this.stopping || !this.readOnly) return;
    this.ownerRetry = setTimeout(() => {
      this.ownerRetry = undefined;
      this.takeover = this.retryOwner().finally(() => { this.takeover = null; });
    }, this.options.ownerRetryMs ?? OWNER_RETRY_MS);
    this.ownerRetry.unref?.();
  }

  /** A read-only process takes over once the lease is free (the owner quit, or its lease went stale after a crash). */
  private async retryOwner(): Promise<void> {
    if (this.stopping || !this.readOnly) return;
    let won = false;
    try { won = await this.tryOwnerLease(); }
    catch (error) { this.log('debug', `尝试接管自动采集调度失败，稍后再试：${messageOf(error)}`); }
    if (!won) { this.scheduleOwnerRetry(); return; }
    if (this.stopping) return;
    let adopted: Runtime[] = [];
    try { adopted = await this.loadPersisted(true); }
    catch (error) { this.log('warn', `接管时读取调度状态失败，按内存里的状态继续：${messageOf(error)}`); }
    if (this.stopping) return;
    this.log('info', '已接管自动采集调度（之前的管理进程已退出，或它留下的调度租约已过期）。');
    await this.startOwning(adopted, '接管调度后恢复排期');
    // Every queue view loses its read-only flag.
    for (const rt of this.runtimes.values()) this.publish(rt);
  }

  /**
   * Mutating entry points wait (bounded) for `restore()`: an IPC call that arrives while the window is up but the
   * bookkeeping is still loading must not race it. Never throws.
   */
  private async ready(): Promise<void> {
    if (!this.restored) return;
    await Promise.race([this.restored.catch(() => undefined), sleep(RESTORE_WAIT_MS)]);
  }

  /** Whether this process schedules, and why not while read-only (IPC `schedulerStatus`). */
  status(): SchedulerServiceStatus {
    return {
      gameId: GAME_ID,
      owner: !this.readOnly,
      message: this.readOnly ? READ_ONLY_MESSAGE : null,
      since: this.readOnly ? this.readOnlySince : null,
    };
  }

  private publishStatus(): void {
    const status = this.status();
    this.emit(() => this.options.publishStatus?.(status));
  }

  /** The previous per-instance wake scheduler only kept an enabled flag; its wake times are stale. */
  private async migrateLegacy(): Promise<void> {
    for (const legacy of await this.store.legacySchedules()) {
      try {
        if (!this.runtimes.has(legacy.index) && legacy.enabled) {
          const instance = await this.ports.instance(legacy.index);
          if (instance) {
            const rt = this.rt(legacy.index);
            rt.identity = instance.createdAt;
            rt.state.auto = true;
            await this.persist(rt);
            this.log('info', `实例 #${legacy.index} 的旧版自动续跑开关已迁移到 ETA 调度。`);
          }
        }
        await this.store.retireLegacy(legacy);
      } catch (error) {
        this.log('warn', `实例 #${legacy.index} 的旧版调度状态迁移失败：${messageOf(error)}`);
      }
    }
  }

  /**
   * Stop timers, abort in-flight work, wait (bounded) for the instance locks, persist. The lock is shared with manual
   * gather runs, which their owner (the automation host) aborts before or together with this call.
   */
  async dispose(): Promise<void> {
    this.stopping = true;
    if (this.ownerRetry) { clearTimeout(this.ownerRetry); this.ownerRetry = undefined; }
    this.lifetime.abort(new SchedulerError('RUN_ABORTED', '助手正在退出'));
    for (const rt of this.runtimes.values()) rt.autoController?.abort(new SchedulerError('RUN_ABORTED', '助手正在退出'));
    this.timers.cancelAll();
    await this.restored?.catch(() => undefined);
    await this.takeover?.catch(() => undefined);
    this.timers.cancelAll();
    const drained = Promise.allSettled([...this.runtimes.keys()].map((index) => this.locks.drain(index)));
    await Promise.race([drained, sleep(DISPOSE_DRAIN_MS)]);
    await Promise.allSettled([...this.runtimes.values()].map((rt) => this.persist(rt)));
    await this.ownerRelease?.();
    this.ownerRelease = null;
  }

  // ── queries ──────────────────────────────────────────────────────────────

  /** Instances with any scheduling state (auto on, a sample, marches, an error or work in flight), sorted by index. */
  list(): SchedulerQueueState[] {
    return [...this.runtimes.values()].filter((rt) => !this.blank(rt)).map((rt) => this.view(rt))
      .sort((a, b) => a.instanceIndex - b.instanceIndex);
  }

  /** A read: never registers the instance (an unknown index reads as an empty, auto-off queue). */
  getState(index: number): SchedulerQueueState {
    assertIndex(index);
    const rt = this.runtimes.get(index);
    return this.view(rt ?? newRuntime(index));
  }

  /** Whether auto scheduling is on for the instance (never creates a runtime). */
  isAuto(index: number): boolean {
    return this.runtimes.get(index)?.state.auto === true;
  }

  /** Whether the scheduler itself is touching the device right now. */
  isOperating(index: number): boolean {
    return (this.runtimes.get(index)?.operatingDepth ?? 0) > 0;
  }

  getConfig(): SchedulerConfig {
    return { ...this.config, retryBackoffSeconds: [...this.config.retryBackoffSeconds] };
  }

  listWakes(): WakeInfo[] {
    return this.timers.list();
  }

  // ── operations ───────────────────────────────────────────────────────────

  async saveConfig(patch: Partial<SchedulerConfig>): Promise<SchedulerConfig> {
    await this.ready();
    this.assertOwner();
    const next = mergeSchedulerConfig(this.config, patch);
    await this.store.saveConfig(next);
    this.config = next;
    this.configTouched = true;
    this.emit(() => this.options.publishConfig?.(this.getConfig()));
    this.emit(() => this.hooks.onConfigChange?.(this.getConfig()));
    // Slack or intervals changed: re-plan every auto instance.
    for (const rt of this.runtimes.values()) {
      if (rt.state.auto && rt.scriptHolds === 0) this.rearm(rt.state.instanceIndex, '调度配置已更新');
    }
    return this.getConfig();
  }

  /**
   * Turn auto scheduling on or off. Disable always wins: a newer request (or shutdown) during the readiness check
   * cancels an enable. Enabling samples once right away (read-only, never dispatches); a failed first sample still
   * leaves a backoff wake, never "auto on without a timer". Pause = setAuto(false); nothing re-arms after it.
   * ★ Never call setAuto(true) inside the instance lock (a hook): it awaits a sample and would deadlock.
   */
  async setAuto(index: number, enabled: boolean, reason?: string): Promise<SchedulerQueueState> {
    assertIndex(index);
    await this.ready();
    if (!enabled) {
      const known = this.runtimes.get(index);
      // Nothing to turn off: never register the instance or write a file just to say so.
      if (!known || (!known.state.auto && !this.readOnly && known.autoRequest === 0)) {
        if (known) known.autoRequest++;
        return this.getState(index);
      }
      if (this.readOnly) {
        if (!known.state.auto) return this.view(known);
        throw readOnlyError();
      }
    } else if (this.readOnly) {
      throw readOnlyError();
    }
    const rt = this.rt(index);
    const request = ++rt.autoRequest;
    if (enabled) {
      if (this.stopping) throw new SchedulerError('RUN_ABORTED', '助手正在退出');
      await this.ports.ensureReady?.(index);
      const instance = await this.ports.instance(index);
      if (!instance) throw new SchedulerError('DEVICE_NOT_READY', `实例 #${index} 不存在`);
      if (instance.status !== 'running') throw new SchedulerError('DEVICE_NOT_READY', `实例 #${index} 尚未就绪，请先启动并等待 Android 启动完成`);
      if (rt.autoRequest !== request || this.stopping) return this.view(rt);
      if (rt.identity && rt.identity !== instance.createdAt) this.resetBookkeeping(rt);
      rt.identity = instance.createdAt;
    }
    const flipped = rt.state.auto !== enabled;
    this.applyAuto(rt, enabled, reason);
    if (!enabled) {
      this.timers.cancel(index);
      rt.state.nextWakeAt = null;
      rt.state.nextWakeReason = null;
      rt.state.backoffStep = 0;
      this.publish(rt);
      await this.persist(rt);
      return this.view(rt);
    }
    if (flipped) rt.failureCount = 0;
    this.publish(rt);
    await this.persist(rt);
    const signal = rt.autoController!.signal;
    try {
      const sampled = await this.sample(index, '开启自动调度后的首次采样', { signal, force: false, allowColdStart: true });
      // A throttled first sample did not re-arm: arm from the state we already have.
      if (!sampled && !this.timers.get(index)) this.rearm(index, '开启自动调度');
    } catch (error) {
      if (signal.aborted) return this.view(rt);
      if (isAbortCode(codeOf(error))) {
        // Aborted by something other than this instance's own stop: never leave auto on without a timer.
        if (rt.state.auto && !this.stopping) this.rearm(index, `首次采样被中止：${messageOf(error)}`, 1);
        return this.view(rt);
      }
      this.log('warn', `实例 #${index} 首次采样失败：${messageOf(error)}`);
      if (isAttentionCode(codeOf(error))) this.pauseForAttention(index, error);
      else this.rearm(index, `首次采样失败：${messageOf(error)}`, 1);
    }
    return this.view(rt);
  }

  /**
   * Scripts take priority (original plans iron rule 1). Polite first: cancel the wake and wait up to `graceMs` for
   * the in-flight sample/dispatch to finish; then abort it and wait for the lock (≤ 5 s). Never throws.
   * The returned release (idempotent) swaps in a fresh AbortController — the old one is aborted and would kill the
   * next wake — and schedules「脚本执行结束，重读队列校验」15 s later.
   */
  async suspendForScript(index: number, graceMs: number, reason: string): Promise<() => void> {
    await this.ready();
    let rt: Runtime;
    try { rt = this.rt(index); } catch { return () => undefined; }
    rt.scriptHolds++;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      rt.scriptHolds = Math.max(0, rt.scriptHolds - 1);
      if (rt.scriptHolds > 0 || this.stopping || !rt.state.auto || this.readOnly) return;
      rt.autoController = new AbortController();
      const dueAt = this.now() + RESAMPLE_AFTER_SCRIPT_MS;
      this.arm(index, { key: index, dueAt, reason: '脚本执行结束，重读队列校验', backoffStep: 0 });
      this.log('info', `实例 #${index} 的自动调度已恢复，${Math.round(RESAMPLE_AFTER_SCRIPT_MS / 1000)}s 后重读队列。`);
    };
    try {
      if (!rt.state.auto) return release;
      this.timers.cancel(index);
      rt.state.nextWakeAt = null;
      rt.state.nextWakeReason = `为脚本让路：${reason}`;
      this.publish(rt);
      const drain = (): Promise<void> => this.locks.drain(index);
      if (graceMs > 0 && rt.operatingDepth > 0) await Promise.race([drain(), sleep(graceMs)]);
      if (rt.operatingDepth > 0) {
        this.log('warn', `实例 #${index} 上的自动调度 ${Math.round(graceMs / 1000)}s 内没让开，按脚本优先中断它（${reason}）。`);
        rt.autoController?.abort(new SchedulerError('RUN_ABORTED', `为脚本让路：${reason}`));
        await Promise.race([drain(), sleep(ABORT_DRAIN_MS)]);
      }
    } catch (error) {
      this.log('warn', `实例 #${index} 让路时出错（按已让路继续）：${messageOf(error)}`);
    }
    return release;
  }

  /**
   * Lend the instance lock to an external flow (bot screenshot, resource read, relaunch, freeze restart, AI taps):
   * while `fn` runs the scheduler never touches the device, and it queues behind an in-flight sample. Re-enters when
   * called from a hook that already holds the lock. ★ `fn` must never call `setAuto(true)`.
   * @param what Chinese action name for the refusal message, e.g.「截图」「读资源统计」.
   */
  async exclusive<T>(index: number, what: string, fn: (ctx: { signal: AbortSignal }) => Promise<T>, signal?: AbortSignal): Promise<T> {
    assertIndex(index);
    // A nested call (from a hook inside the lock) never waits: restore finished long before the lock was taken.
    if (!this.locks.held(index)) await this.ready();
    const rt = this.rt(index);
    if (!this.locks.held(index)) {
      const busy = this.ports.externalBusy?.(index);
      if (busy) throw new SchedulerError('CONCURRENCY_LIMIT', `实例 #${index} 上正有${busy}，${what}稍后再试。`, { instanceIndex: index });
      if (rt.scriptHolds > 0) throw new SchedulerError('CONCURRENCY_LIMIT', `实例 #${index} 正在运行脚本，${what}稍后再试。`, { instanceIndex: index });
    }
    const ctxSignal = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
    return this.withLock(index, what, () => fn({ signal: ctxSignal }), ctxSignal);
  }

  /** The panel's "refresh": read the queue now (throttled), never dispatch. */
  async sampleNow(index: number): Promise<SchedulerQueueState> {
    assertIndex(index);
    await this.ready();
    this.assertOwner();
    await this.sample(index, '面板手动刷新', { signal: this.lifetime.signal, force: false, allowColdStart: true });
    return this.view(this.rt(index));
  }

  /** Single-dispatch form of `noteDispatches` (original API). */
  noteDispatch(index: number, note: DispatchNote, ctx?: { signal?: AbortSignal; resample?: boolean }): Promise<void> {
    return this.noteDispatches(index, [note], ctx);
  }

  /**
   * Record dispatches (travel time from the march button, coordinate, resource) and re-sample once. Travel time read
   * at dispatch is the only reliable source of freeAt; coordinate + resource are the only way marching/returning rows
   * learn what they gather. Record even when travel time was unread (fallback source).
   */
  async noteDispatches(index: number, notes: DispatchNote[], ctx: { signal?: AbortSignal; resample?: boolean } = {}): Promise<void> {
    for (const note of notes) {
      if (note.travelTimeMs != null && (!Number.isFinite(note.travelTimeMs) || note.travelTimeMs < 0)) {
        throw new SchedulerError('INVALID_ARGUMENT', `派兵记账收到非法的行军耗时：${String(note.travelTimeMs)}（毫秒）。`, { instanceIndex: index });
      }
    }
    if (notes.length === 0) return;
    if (!this.locks.held(index)) await this.ready();
    const rt = this.rt(index);
    const at = this.now();
    for (const note of notes) {
      const travelTimeMs = note.travelTimeMs ?? this.config.defaultTravelSeconds * 1000;
      const source: TravelTimeSource = note.travelTimeMs == null ? 'fallback' : (note.source ?? 'dispatch');
      rt.travelHints.unshift({ travelTimeMs, source, at, coord: note.coord ?? null, resourceType: note.resourceType ?? null });
      this.log('info', `实例 #${index} 记下一次派兵：单程 ${Math.round(travelTimeMs / 1000)}s` +
        `${note.travelTimeMs == null ? '（行军按钮没读到，按兜底值记）' : ''}` +
        `${note.coord ? `，目标 ${note.coord}` : ''}${note.resourceType ? `，资源 ${note.resourceType}` : ''}。`);
    }
    rt.travelHints = trimHints(rt.travelHints).slice(0, MAX_TRAVEL_HINTS);
    await this.persist(rt);
    if (ctx.resample === false) return;
    const signal = ctx.signal ?? rt.autoController?.signal ?? this.lifetime.signal;
    if (signal.aborted) return;
    try {
      // The queue certainly changed: read the new march's countdown (bypasses the throttle).
      await this.sample(index, '派兵后校准', { signal, force: true, allowColdStart: false });
    } catch (error) {
      if (signal.aborted || isAbortCode(codeOf(error))) return;
      this.log('warn', `实例 #${index} 派兵后校准失败：${messageOf(error)}`);
      this.rearm(index, '派兵后校准失败，稍后重试');
    }
  }

  /** Turn auto off and drop every piece of bookkeeping for the instance (the panel's "reset"). */
  async forget(index: number): Promise<void> {
    assertIndex(index);
    await this.ready();
    this.assertOwner();
    const rt = this.runtimes.get(index);
    if (rt) {
      this.applyAuto(rt, false, '已重置该实例的调度记账');
      await this.locks.drain(index);
    }
    this.timers.cancel(index);
    this.runtimes.delete(index);
    await this.store.deleteInstance(index);
    if (rt) {
      const cleared: Runtime = { ...rt, state: emptyInstanceState(index), travelHints: [], failureCount: 0, operatingDepth: 0 };
      this.publish(cleared);
    }
  }

  /** Drop the pending wake but keep auto on. */
  cancelWake(index: number): void {
    this.timers.cancel(index);
    const rt = this.runtimes.get(index);
    if (!rt) return;
    rt.state.nextWakeAt = null;
    rt.state.nextWakeReason = null;
    this.publish(rt);
  }

  // ── locking and sampling ─────────────────────────────────────────────────

  private withLock<T>(index: number, label: string, fn: () => Promise<T>, signal: AbortSignal): Promise<T> {
    const rt = this.rt(index);
    return this.locks.run(index, label, async () => {
      throwIfAborted(signal);
      rt.operatingDepth++;
      if (rt.operatingDepth === 1) { rt.state.operating = true; this.publish(rt); }
      try {
        return await fn();
      } finally {
        rt.operatingDepth--;
        if (rt.operatingDepth === 0) { rt.state.operating = false; this.publish(rt); }
      }
    }, { signal });
  }

  /** @returns false when throttled (no device work, no re-arm). */
  private sample(index: number, reason: string, options: SampleOptions): Promise<boolean> {
    return this.withLock(index, '读取部队管理面板', () => this.sampleLocked(index, reason, options), options.signal);
  }

  private async sampleLocked(index: number, reason: string, { signal, force, allowColdStart }: SampleOptions): Promise<boolean> {
    throwIfAborted(signal);
    const rt = this.rt(index);
    // Scripts yield: a normal hand-over, not a failure. scriptHolds covers the gap before the script takes the lease.
    if (rt.scriptHolds > 0) {
      throw new SchedulerError('CONCURRENCY_LIMIT', `实例 #${index} 正在为脚本让路，调度器不去动它。等脚本结束后会自动重试。`, { instanceIndex: index });
    }
    const busy = this.ports.externalBusy?.(index);
    if (busy) {
      throw new SchedulerError('CONCURRENCY_LIMIT',
        `实例 #${index} 上正有${busy}，调度器不去动它。等这次执行结束后会自动重试；想立刻读队列请先停掉那个任务。`, { instanceIndex: index });
    }
    const since = this.now() - rt.state.lastSampledAt;
    if (!force && rt.state.lastSampledAt > 0 && since < this.config.minSampleIntervalMs) {
      this.log('debug', `实例 #${index} 距上次采样只有 ${since}ms，低于最小间隔 ${this.config.minSampleIntervalMs}ms，本次跳过（${reason}）。`);
      return false;
    }

    rt.state.sampling = true;
    this.publish(rt);
    try {
      const instance = await this.ports.instance(index).catch((error: unknown) => {
        // No device at all also counts as "no frame": the freeze watchdog tells "ADB hung" from "not running" by code.
        if (!signal.aborted && !isAbortCode(codeOf(error))) this.notifyCaptureFailed(index, error);
        throw new SchedulerError('DEVICE_NOT_READY', `读取实例 #${index} 状态失败：${messageOf(error)}`);
      });
      if (!instance) {
        const error = new SchedulerError('DEVICE_NOT_READY', `实例 #${index} 不存在`);
        this.notifyCaptureFailed(index, error);
        throw error;
      }
      if (rt.identity && instance.createdAt !== rt.identity) {
        this.resetBookkeeping(rt);
        if (rt.state.auto) this.applyAuto(rt, false, '原实例已被替换，自动调度已关闭');
        rt.identity = instance.createdAt;
        throw new SchedulerError('DEVICE_NOT_READY', `实例 #${index} 已被替换，原来的调度记账已清空；请重新确认后再开启自动调度`);
      }
      if (instance.status !== 'running') {
        const error = new SchedulerError('DEVICE_NOT_READY', `实例 #${index} 未运行（${instance.status}），无法读取部队管理面板`);
        this.notifyCaptureFailed(index, error);
        throw error;
      }
      rt.identity ??= instance.createdAt;
      throwIfAborted(signal);
      this.log('info', `实例 #${index} 开始读部队管理面板（${reason}）。`);
      const sample: PanelSample = await this.ports.sample(index, {
        reason,
        config: this.getConfig(),
        deadlineAt: this.now() + this.config.sampleTimeoutMs,
        signal,
        allowColdStart,
        onFrame: (raw) => this.notifyFrame(index, raw),
        onCaptureFailed: (error) => { if (!signal.aborted && !isAbortCode(codeOf(error))) this.notifyCaptureFailed(index, error); },
        onUnrecognized: async (raw) => {
          const hook = this.hooks.onUnrecognizedFrame;
          if (!hook) return false;
          const result = await hook(index, raw, { signal });
          return result === true || result === 'recovered' || result === 'updated' ? result : false;
        },
        log: (level, message) => this.log(level, `[实例 #${index}] ${message}`),
      });
      throwIfAborted(signal);
      if (this.ports.accountIdOf) rt.state.accountId = await this.ports.accountIdOf(index).catch(() => null);
      throwIfAborted(signal);
      const previous = rt.state;
      rt.state = applySample(previous, sample, rt.travelHints, this.config);
      this.notifyMarchGone(index, previous, sample);
      for (const w of sample.warnings) this.log('warn', `[实例 #${index}] ${w}`);
      this.log('info', `实例 #${index} 读到队列 ${sample.queueUsed ?? '?'}/${sample.queueTotal ?? '?'}，` +
        `${sample.rows.filter((r) => r.status !== 'idle').length} 支队在外。`);
    } catch (error) {
      const code = codeOf(error);
      if (signal.aborted || isAbortCode(code)) {
        rt.state.sampling = false;
        this.publish(rt);
        await this.persist(rt);
        throw abortError(signal);
      }
      rt.state = { ...rt.state, sampling: false, lastSampleOk: false, error: messageOf(error) };
      this.publish(rt);
      await this.persist(rt);
      // Yielding to a script is not a fault; update prompts and AI risk refusals have their own alerts.
      if (code !== 'CONCURRENCY_LIMIT' && !isAttentionCode(code)) await this.notifySampleResult(index, false, messageOf(error), signal);
      throw error;
    }
    this.publish(rt);
    await this.persist(rt);
    await this.notifySampleResult(index, true, null, signal);
    this.rearm(index, '采样完成');
    return true;
  }

  private async healthProbe(index: number, rt: Runtime, signal: AbortSignal): Promise<void> {
    rt.lastHealthProbeAt = this.now();
    if (!this.hooks.onHealthProbe) return;
    const busy = this.ports.externalBusy?.(index);
    if (rt.scriptHolds > 0 || busy) {
      this.log('debug', `实例 #${index} 上有${busy ?? '脚本'}在跑，本次健康探针跳过。`);
      return;
    }
    try {
      await this.withLock(index, '健康探针', async () => {
        let frame;
        try {
          frame = await this.ports.healthFrame(index, signal);
        } catch (error) {
          if (signal.aborted || isAbortCode(codeOf(error))) throw abortError(signal);
          // No frame at all also counts: the freeze watchdog tells "ADB hung" from "instance not running" with it.
          this.notifyCaptureFailed(index, error);
          try { await this.hooks.onHealthProbeFailed?.(index, { code: codeOf(error), message: messageOf(error) }, { signal }); }
          catch (hookError) { if (!isAbortCode(codeOf(hookError))) this.log('warn', `实例 #${index} 健康探针失败通报出错（已忽略）：${messageOf(hookError)}`); }
          throw error;
        }
        this.notifyFrame(index, frame.raw);
        this.log('debug', `实例 #${index} 健康探针：前台=${frame.foreground ?? '未知'} 游戏进程=${frame.running === null ? '未知' : frame.running ? '在' : '不在'}`);
        throwIfAborted(signal);
        await this.hooks.onHealthProbe!(index, frame.raw, { foreground: frame.foreground, running: frame.running, signal });
      }, signal);
    } catch (error) {
      if (!signal.aborted && !isAbortCode(codeOf(error))) this.log('warn', `实例 #${index} 健康探针失败：${messageOf(error)}`);
    }
  }

  // ── planning and wakes ───────────────────────────────────────────────────

  /** Re-plan from the current state. `backoffStep` > 0 walks the backoff ladder; a cooldown is a floor for samples. */
  private rearm(index: number, why: string, backoffStep?: number): void {
    const rt = this.runtimes.get(index);
    if (!rt || this.stopping || this.readOnly) return;
    if (!rt.state.auto) {
      this.timers.cancel(index);
      rt.state.nextWakeAt = null;
      rt.state.nextWakeReason = null;
      this.publish(rt);
      return;
    }
    const now = this.now();
    let dueAt: number;
    let reason: string;
    let step = 0;
    if (backoffStep && backoffStep > 0) {
      step = backoffStep;
      const wait = backoffMs(this.config, step);
      dueAt = now + wait;
      reason = `退避重试（第 ${step} 次，等 ${Math.round(wait / 1000)}s）：${why}`;
    } else {
      const plan = planNextWake(rt.state, this.config, now, { lastHealthProbeAt: rt.lastHealthProbeAt, random: this.random });
      if (!plan) {
        this.timers.cancel(index);
        rt.state.nextWakeAt = null;
        rt.state.nextWakeReason = null;
        this.publish(rt);
        return;
      }
      dueAt = plan.dueAt;
      reason = plan.reason;
    }
    if (rt.cooldownUntil !== undefined && rt.cooldownUntil <= now) rt.cooldownUntil = undefined;
    const floorAt = rt.cooldownUntil ?? 0;
    if (floorAt > dueAt) {
      reason = `${reason}（最早 ${formatCstClock(floorAt)} 再试）`;
      dueAt = floorAt;
      // A cooldown never silences the health probe: it still looks every `healthProbeIntervalMin` (one frame, no panel).
      const probeAt = this.healthProbeDueAt(rt, now);
      if (probeAt !== null && probeAt < dueAt) {
        this.arm(index, { key: index, dueAt: probeAt, reason: HEALTH_PROBE_REASON, backoffStep: step });
        this.log('debug', `实例 #${index} 冷却到 ${formatCstClock(dueAt)}（北京时间，${reason}），期间先按时做健康探针。`);
        return;
      }
    }
    this.arm(index, { key: index, dueAt, reason, backoffStep: step });
    this.log('debug', `实例 #${index} 下次唤醒：${formatCstClock(dueAt)}（北京时间，${reason}，约 ${formatDuration(dueAt - now)} 后）。`);
  }

  /** The next health probe (same candidate and 30 s floor as `planNextWake`), or null when probes are off. */
  private healthProbeDueAt(rt: Runtime, now: number): number | null {
    if (this.config.healthProbeIntervalMin <= 0) return null;
    const last = rt.lastHealthProbeAt ?? (rt.state.lastSampledAt || now);
    return Math.max(last + this.config.healthProbeIntervalMin * 60_000, now + Math.max(30_000, this.config.minSampleIntervalMs));
  }

  private arm(index: number, task: WakeTask): void {
    const rt = this.rt(index);
    rt.state.nextWakeAt = task.dueAt;
    rt.state.nextWakeReason = task.reason;
    rt.state.backoffStep = task.backoffStep;
    this.timers.schedule(task, (fired) => { void this.onWake(fired.key, fired.reason, fired.backoffStep); });
    this.publish(rt);
  }

  /**
   * A timer fired. ★ It only means "go and look" (sleep delays timers): always re-read the panel, never assume the
   * troops are back.
   */
  private async onWake(index: number, reason: string, prevStep: number): Promise<void> {
    const rt = this.runtimes.get(index);
    if (!rt || !rt.state.auto || this.stopping || this.readOnly) return;
    rt.state.nextWakeAt = null;
    rt.state.nextWakeReason = null;
    // Scripts first: no wake while a script holds the instance; its release schedules the re-read.
    if (rt.scriptHolds > 0) {
      this.log('debug', `实例 #${index} 上有脚本在跑，本次唤醒跳过（等脚本结束后重排）。`);
      this.publish(rt);
      return;
    }
    if (!rt.autoController || rt.autoController.signal.aborted) rt.autoController = new AbortController();
    const controller = rt.autoController;
    try {
      await this.wakeActive(index, reason, prevStep, rt, controller.signal);
    } catch (error) {
      if (!controller.signal.aborted && !isAbortCode(codeOf(error))) this.log('warn', `实例 #${index} 唤醒处理出错：${messageOf(error)}`);
    }
  }

  private async wakeActive(index: number, reason: string, prevStep: number, rt: Runtime, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    // Health probe: one frame, no panel; never a sample result, does not advance the backoff ladder.
    if (reason === HEALTH_PROBE_REASON) {
      await this.healthProbe(index, rt, signal);
      if (rt.state.auto && !signal.aborted) this.rearm(index, '健康探针已完成');
      return;
    }

    try {
      await this.sample(index, `到点唤醒 · ${reason}`, { signal, force: true, allowColdStart: true });
    } catch (error) {
      if (signal.aborted) return;
      const code = codeOf(error);
      if (isAbortCode(code)) { this.rearmAfterStrayAbort(index, rt, error, prevStep); return; }
      this.log('warn', `实例 #${index} 唤醒采样失败：${messageOf(error)}`);
      if (isAttentionCode(code)) { this.pauseForAttention(index, error); return; }
      if (code !== 'CONCURRENCY_LIMIT' && this.noteFailure(index, messageOf(error))) return;
      this.rearm(index, messageOf(error), prevStep + 1);
      return;
    }

    throwIfAborted(signal);
    if (!rt.state.auto) return;
    const free = hasFreeSlot(rt.state);
    if (free !== true) {
      rt.failureCount = 0;
      // Full, or N/M unreadable (null counts as full): back off instead of spinning.
      const why = free === null ? '队列占用没读出来，按未空处理' : `队列仍是 ${rt.state.queueUsed}/${rt.state.queueTotal}，还没空出来`;
      this.log('info', `实例 #${index} 唤醒后${why}，进入退避重试。`);
      this.rearm(index, why, prevStep + 1);
      return;
    }

    // A free slot: hand over to the gather flow. The scheduler never decides where troops go.
    rt.state.backoffStep = 0;
    if (!this.queueFreeHook) {
      this.log('info', `实例 #${index} 队列有空位（${rt.state.queueUsed}/${rt.state.queueTotal}），但还没有接入采集派遣流程，本次只做记录。`);
      // Back off: nobody fills the slot, so the normal plan would re-sample every 30 s.
      this.rearm(index, '队列有空位但没有采集派遣流程接管', prevStep + 1);
      return;
    }
    const hook = this.queueFreeHook;
    let outcome: QueueFreeResult | void;
    try {
      outcome = await this.withLock(index, '自动采集派遣', async () => {
        throwIfAborted(signal);
        if (!rt.state.auto) return undefined;
        return hook(this.view(rt), { signal });
      }, signal);
    } catch (error) {
      if (signal.aborted) return;
      const code = codeOf(error);
      if (isAbortCode(code)) { this.rearmAfterStrayAbort(index, rt, error, prevStep); return; }
      this.log('warn', `实例 #${index} 的派遣流程报错：${messageOf(error)}`);
      if (isAttentionCode(code)) { this.pauseForAttention(index, error); return; }
      if (code !== 'CONCURRENCY_LIMIT' && this.noteFailure(index, `派遣失败：${messageOf(error)}`)) return;
      this.rearm(index, `派遣失败：${messageOf(error)}`, prevStep + 1);
      return;
    }
    throwIfAborted(signal);
    rt.failureCount = 0;
    await this.persist(rt);
    const notBefore = outcome?.notBefore ?? null;
    // Circuit breaker: no sample wake before `notBefore` (health probes still run); any other round ends a cooldown.
    rt.cooldownUntil = notBefore !== null && Number.isFinite(notBefore) && notBefore > this.now() ? notBefore : undefined;
    // noteDispatch re-sampled and re-planned. Still a free slot means this round placed nothing (no suitable node,
    // circuit breaker…): back off, or the plan would reopen the panel every 30 s.
    if (hasFreeSlot(rt.state) === true) {
      this.rearm(index, outcome?.reason ?? '派遣流程跑完了但队列仍有空位，稍后再试', prevStep + 1);
      return;
    }
    this.rearm(index, '派遣流程已执行');
  }

  // ── failure bookkeeping ──────────────────────────────────────────────────

  /**
   * An abort code while this wake's own signal is live (e.g. a worker stopped by something else): not a stop of the
   * instance, so back off instead of leaving auto on without a timer. Not counted as a failure.
   */
  private rearmAfterStrayAbort(index: number, rt: Runtime, error: unknown, prevStep: number): void {
    if (!rt.state.auto || this.stopping || rt.scriptHolds > 0) return;
    this.log('warn', `实例 #${index} 的自动调度被意外中止（稍后重试）：${messageOf(error)}`);
    this.rearm(index, `被中止：${messageOf(error)}`, prevStep + 1);
  }

  /** Count a real failure; pause after `maxConsecutiveFailures`. @returns true when it paused the instance. */
  private noteFailure(index: number, message: string): boolean {
    const rt = this.rt(index);
    rt.failureCount = Math.min(99, rt.failureCount + 1);
    this.publish(rt);
    if (rt.failureCount < this.maxFailures) return false;
    const reason = `连续 ${rt.failureCount} 次失败，自动调度已暂停：${message}`;
    this.log('error', `实例 #${index} ${reason}`);
    this.emit(() => this.options.onSafetyPause?.(index, rt.failureCount, reason));
    void this.setAuto(index, false, reason).catch(() => undefined);
    return true;
  }

  /**
   * A human must look: pause (without counting a failure) and tell the alerts module; until a module sets the
   * `onNeedsAttention` hook, the host's fallback alert path (`onAttentionPause`) raises it, so it is never silent.
   */
  private pauseForAttention(index: number, error: unknown): void {
    const info = { code: codeOf(error), message: messageOf(error) };
    const hook = this.hooks.onNeedsAttention;
    if (hook) this.emit(() => hook(index, info));
    else this.emit(() => this.options.onAttentionPause?.(index, info));
    void this.setAuto(index, false, `需要人工处理：${info.message}`).catch(() => undefined);
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  /** The instance's runtime, registered on first use. Operations only: reads use `runtimes.get`. */
  private rt(index: number): Runtime {
    assertIndex(index);
    let rt = this.runtimes.get(index);
    if (!rt) {
      rt = newRuntime(index);
      this.runtimes.set(index, rt);
    }
    return rt;
  }

  /** Nothing worth listing: auto off, never sampled, no marches, hints, error or work in flight. */
  private blank(rt: Runtime): boolean {
    const s = rt.state;
    return !s.auto && s.lastSampledAt === 0 && s.marches.length === 0 && !s.error && !s.sampling &&
      rt.travelHints.length === 0 && rt.operatingDepth === 0 && rt.scriptHolds === 0 && rt.failureCount === 0;
  }

  /** A viewer process never writes the owner's scheduler files. */
  private assertOwner(): void {
    if (this.readOnly) throw readOnlyError();
  }

  private fromPersisted(item: PersistedQueue): Runtime {
    const state = emptyInstanceState(item.instanceIndex);
    state.auto = item.auto;
    state.accountId = item.accountId;
    state.queueUsed = item.queueUsed;
    state.queueTotal = item.queueTotal;
    // Absolute times: countdowns are still right after a restart.
    state.marches = item.marches;
    state.lastSampledAt = item.lastSampledAt;
    state.lastSampleOk = item.lastSampledAt > 0;
    return {
      state, identity: item.instanceCreatedAt, travelHints: item.travelHints, failureCount: item.failureCount,
      autoRequest: 0, scriptHolds: 0, operatingDepth: 0,
    };
  }

  /** A different AVD now lives at this index: nothing of the old bookkeeping applies. */
  private resetBookkeeping(rt: Runtime): void {
    const fresh = emptyInstanceState(rt.state.instanceIndex);
    rt.state = { ...fresh, auto: rt.state.auto, operating: rt.state.operating, nextWakeAt: rt.state.nextWakeAt, nextWakeReason: rt.state.nextWakeReason };
    rt.travelHints = [];
    rt.failureCount = 0;
    rt.lastHealthProbeAt = undefined;
    rt.cooldownUntil = undefined;
  }

  /** Flip the flag, abort on disable and notify only on a real flip (the single source of pause/resume events). */
  private applyAuto(rt: Runtime, enabled: boolean, reason?: string): void {
    const flipped = rt.state.auto !== enabled;
    if (flipped) rt.cooldownUntil = undefined;
    if (!enabled) {
      rt.autoController?.abort(new SchedulerError('RUN_ABORTED', reason ? `自动调度已停止：${reason}` : '自动调度已停止。'));
      this.timers.cancel(rt.state.instanceIndex);
      rt.state.nextWakeAt = null;
      rt.state.nextWakeReason = null;
      rt.state.backoffStep = 0;
    } else if (flipped || !rt.autoController || rt.autoController.signal.aborted) {
      rt.autoController = new AbortController();
    }
    rt.state.auto = enabled;
    if (flipped) {
      const index = rt.state.instanceIndex;
      const at = this.now();
      this.emit(() => this.hooks.onAutoChanged?.(index, enabled, at, reason));
      this.log('info', `实例 #${index} 自动调度已${enabled ? '开启' : '关闭'}${reason ? `（${reason}）` : ''}。`);
    }
    if (!enabled) this.publish(rt);
  }

  private view(rt: Runtime): SchedulerQueueState {
    const s = rt.state;
    let pause = null;
    try { pause = this.hooks.pauseOf?.(s.instanceIndex) ?? null; } catch { pause = null; }
    return {
      ...s,
      marches: s.marches.map((m) => ({ ...m, commanders: m.commanders.map((c) => ({ ...c })) })),
      warnings: [...s.warnings],
      operating: rt.operatingDepth > 0,
      gameId: GAME_ID,
      failureCount: rt.failureCount,
      pause,
      ...(this.readOnly ? { readOnly: true } : {}),
    };
  }

  private publish(rt: Runtime): void {
    const view = this.view(rt);
    this.emit(() => this.options.publish?.(view));
    this.emit(() => this.hooks.onStateChange?.(view));
  }

  private async persist(rt: Runtime): Promise<void> {
    if (this.readOnly) return;
    try {
      await this.store.saveInstance({
        instanceIndex: rt.state.instanceIndex,
        instanceCreatedAt: rt.identity,
        auto: rt.state.auto,
        accountId: rt.state.accountId,
        queueUsed: rt.state.queueUsed,
        queueTotal: rt.state.queueTotal,
        marches: rt.state.marches,
        lastSampledAt: rt.state.lastSampledAt,
        travelHints: rt.travelHints,
        failureCount: rt.failureCount,
      });
    } catch (error) {
      // A failed save must not stop scheduling, but it is never silent.
      this.log('error', `保存调度状态失败：${messageOf(error)}`);
    }
  }

  private notifyFrame(index: number, raw: RawFrame): void {
    this.emit(() => this.hooks.onFrameCaptured?.(index, raw));
  }

  private notifyCaptureFailed(index: number, error: unknown): void {
    const info = { code: codeOf(error), message: messageOf(error) };
    this.emit(() => this.hooks.onCaptureFailed?.(index, info));
  }

  private async notifySampleResult(index: number, ok: boolean, message: string | null, signal: AbortSignal): Promise<void> {
    const hook = this.hooks.onSampleResult;
    if (!hook) return;
    const ctx: FrameContext = { signal };
    try { await hook(index, ok, message, ctx); }
    catch (error) { if (!isAbortCode(codeOf(error))) this.log('warn', `采样结果通报失败（不影响调度）：${messageOf(error)}`); }
  }

  private notifyMarchGone(index: number, previous: InstanceQueueState, sample: PanelSample): void {
    const gone = marchesGone(previous, sample);
    if (gone.length === 0) return;
    this.emit(() => this.hooks.onMarchGone?.(index, gone, sample.sampledAt));
  }

  /** Observers never break scheduling. */
  private emit(call: () => void): void {
    try { call(); } catch (error) { this.log('warn', `调度回调抛错（已忽略）：${messageOf(error)}`); }
  }

  private log(level: LogLevel, message: string): void {
    try { this.hooks.log?.(level, message); } catch { /* observers never break scheduling */ }
    const sink = this.options.log;
    if (sink) {
      try { sink(level, message); return; } catch { /* fall through to the console */ }
    }
    if (level === 'error' || level === 'warn') console.warn(`[wanlong/scheduler] ${message}`);
    else if (level === 'info') console.log(`[wanlong/scheduler] ${message}`);
  }
}

function assertIndex(index: number): void {
  if (!Number.isInteger(index) || index < 0 || index > 63) throw new SchedulerError('INVALID_ARGUMENT', `实例编号非法：${String(index)}`);
}

function newRuntime(index: number): Runtime {
  return { state: emptyInstanceState(index), identity: null, travelHints: [], failureCount: 0, autoRequest: 0, scriptHolds: 0, operatingDepth: 0 };
}

function readOnlyError(): SchedulerError {
  return new SchedulerError('CONCURRENCY_LIMIT',
    '另一个万龙助手进程正在管理自动采集调度，请在那个窗口操作；如果并没有别的窗口（例如上次异常退出），本窗口会在约 30 秒内自动接管，请稍后再试');
}
