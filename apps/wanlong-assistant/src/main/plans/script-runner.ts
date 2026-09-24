import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { ExecutionGuardError, isExecutionGuardError, type RawFrame } from '@avdm/automation';
import {
  startsWithLaunch, TERMINAL_RUN_STATUSES, type AiAssistResult, type LogEntry, type LogLevel, type RunSnapshot, type RunStatus,
  type ScriptDef, type ScriptParamValue, type ShotPolicy,
} from '@avdm/automation/script';
import { forwardedDeviceError, RunnerMessageError, safeErrorMessage } from './device-errors';
import { imeBroadcastCommand, needsUnicodeInput, readImeStatus } from './ime';
import { KEEP_RUNS, RunLogStore } from './run-logs';
import {
  AI_CONSULT_TIMEOUT_MS, type ScriptDeviceRequest, type ScriptMainToWorker, type ScriptWorkerInput, type ScriptWorkerLike,
  type ScriptWorkerToMain,
} from './script-protocol';
import type {
  RunLogsEvent, RunMatchesEvent, ScriptAiAssist, ScriptDevice, ScriptMatchDefaults, ScriptRunSnapshot, ScriptRunSource,
} from './types';

/** How a runner reaches the emulator; `AvdManager` (via ManagerHost) satisfies it. */
export interface ScriptRunnerHost {
  instance(index: number): Promise<{ status: string; record: { createdAt: string } }>;
  device(index: number): Promise<ScriptDevice>;
}

export interface ScriptRunnerOptions {
  workerFactory?: (entry: string) => ScriptWorkerLike;
  /** Every snapshot change (the worker throttles progress to ≤ 4/s). */
  onSnapshot?: (snapshot: ScriptRunSnapshot) => void;
  /** Every persisted log batch (≈ every 100 ms per run). */
  onLogs?: (event: RunLogsEvent) => void;
  /** Match results of runs whose debug overlay is on. */
  onMatches?: (event: RunMatchesEvent) => void;
  /** The AI advisor (plugged in by the ai module); without it every consult is answered `handled: false`. */
  aiAssist?: ScriptAiAssist | null;
  /** Graceful stop: time for the current step to finish before the thread is terminated. */
  stopGraceMs?: number;
  /**
   * Main-side backstop of `maxRunMs`: the engine's own timer ends the run on time; this one fires this much later
   * only when the thread did not (blocked event loop, a device call or AI consult it cannot interrupt).
   */
  deadlineSlackMs?: number;
  /** How long a stopped run still waits for an AI advisor that ignores its abort signal. */
  aiAbortGraceMs?: number;
  foregroundTimeoutMs?: number;
  foregroundPollMs?: number;
  /**
   * The app settings' minimum capture interval, read at every start: the worker reuses a frame younger than this
   * (original worker/context.ts took `settings.minCaptureIntervalMs`); the device lane keeps the same gap between
   * screencaps. Absent / invalid = the engine default (400 ms). `pacing` (tests) wins over it.
   */
  captureIntervalMs?: () => number;
  /** Pacing overrides handed to the worker (tests). */
  pacing?: Pick<ScriptWorkerInput, 'minCaptureIntervalMs' | 'captureJitterMs' | 'restartGapMs' | 'restartSettleMs'>;
  logs?: RunLogStore;
}

export interface ScriptExecuteOptions {
  runId: string;
  gameId: string;
  /** The game's package: the only app a script may launch, stop or type into. */
  packageName: string;
  instanceIndex: number;
  /** `record.createdAt` of the instance when the run was admitted; a different AVD at that index stops it. */
  instanceIdentity: string;
  script: ScriptDef;
  params: Record<string, ScriptParamValue>;
  accountId: string | null;
  accountName: string | null;
  source: ScriptRunSource;
  taskId: string | null;
  templateDir: string | null;
  shotPolicy: ShotPolicy;
  maxRunMs: number | null;
  /**
   * App settings defaults for matching (`PlanHostPort.matchDefaults`): threshold of templates without their own and
   * the frame / template downsampling factor. Absent = the vision defaults.
   */
  matchDefaults?: ScriptMatchDefaults;
  signal?: AbortSignal;
  /** Extra ownership check before every device operation (account binding); throws ExecutionGuardError. */
  assertOwnership?: () => Promise<void>;
  /** Relay failed steps to the AI advisor (plan config `aiAssist`); default true. */
  aiAssist?: boolean;
}

interface RunEntry {
  snapshot: ScriptRunSnapshot;
  finished: boolean;
  stopReason: string | null;
  debugMatches: boolean;
  post?: (message: ScriptMainToWorker) => void;
  requestStop?: (reason: string) => void;
  done: Promise<ScriptRunSnapshot>;
}

/** Finished runs kept in memory for the monitor (the original kept 50). */
export const MAX_FINISHED_KEPT = 50;
/** Graceful stop window before the thread is terminated (original STOP_GRACE_MS). */
export const STOP_GRACE_MS = 10_000;
/** The main-side run limit fires this long after `maxRunMs` (the worker's own limit normally ends the run first). */
export const DEADLINE_SLACK_MS = 30_000;
const AI_ABORT_GRACE_MS = 5_000;
const FOREGROUND_TIMEOUT_MS = 60_000;
const FOREGROUND_POLL_MS = 1000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new RunnerMessageError('脚本执行已结束');
}

function limitMessage(maxRunMs: number): string {
  // Same wording as the engine's own limit.
  return `脚本运行超过本次时间上限（${Math.round(maxRunMs / 6000) / 10} 分钟），已停止。`;
}

function isTerminal(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

function copy(snapshot: ScriptRunSnapshot): ScriptRunSnapshot {
  return { ...snapshot, stats: { ...snapshot.stats } };
}

/**
 * Runs scripts in `script-worker` threads (never OpenCV on the main thread) and owns everything the thread may
 * not: adb, files, the device queue and the per-input checks. The caller holds the instance lease
 * (`run/automation-instance-<i>.lock`) for the whole `execute()`, which resolves only after every queued device
 * call has settled, so the next writer can never overlap a late tap.
 */
export class ScriptRunner {
  readonly logs: RunLogStore;
  private readonly runs = new Map<string, RunEntry>();
  private readonly activeByIndex = new Map<number, string>();
  private readonly reservations = new Map<number, string>();
  private readonly workerFactory: (entry: string) => ScriptWorkerLike;
  private aiAssist: ScriptAiAssist | null;
  private disposed = false;
  private readonly pruning = new Set<string>();

  constructor(home: string, private readonly host: ScriptRunnerHost, private readonly options: ScriptRunnerOptions = {}) {
    this.logs = options.logs ?? new RunLogStore(home);
    this.workerFactory = options.workerFactory ?? ((entry) => new Worker(entry) as unknown as ScriptWorkerLike);
    this.aiAssist = options.aiAssist ?? null;
  }

  /** Plug in (or remove) the AI advisor for later consults. */
  setAiAssist(handler: ScriptAiAssist | null): void {
    this.aiAssist = handler;
  }

  /** The run on this instance (admitted or executing), for busy checks by the scheduler, updates and monitoring. */
  runIdOfInstance(index: number): string | null {
    return this.reservations.get(index) ?? this.activeByIndex.get(index) ?? null;
  }

  /** Script runs admitted or executing across all instances. */
  activeCount(): number {
    return this.busyIndices().length;
  }

  busyIndices(): number[] {
    return [...new Set([...this.reservations.keys(), ...this.activeByIndex.keys()])];
  }

  /**
   * Admission: claim `index` for `runId` synchronously (before the caller's first await) so two requests can
   * never claim one instance. Returns the release function.
   */
  reserve(index: number, runId: string): () => void {
    if (this.disposed) throw new Error('助手正在退出，不能启动新的脚本');
    const busy = this.runIdOfInstance(index);
    if (busy && busy !== runId) throw new Error(`实例 #${index} 上已经有脚本在运行（${busy}），请先停止它`);
    this.reservations.set(index, runId);
    return () => { if (this.reservations.get(index) === runId) this.reservations.delete(index); };
  }

  list(gameId?: string): ScriptRunSnapshot[] {
    return [...this.runs.values()].map((entry) => copy(entry.snapshot))
      .filter((snapshot) => !gameId || snapshot.gameId === gameId)
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  get(runId: string): ScriptRunSnapshot | null {
    const entry = this.runs.get(runId);
    return entry ? copy(entry.snapshot) : null;
  }

  isActive(runId: string): boolean {
    const entry = this.runs.get(runId);
    return !!entry && !entry.finished;
  }

  pause(runId: string): void {
    this.live(runId, '暂停').post?.({ type: 'pause' });
  }

  resume(runId: string): void {
    this.live(runId, '继续').post?.({ type: 'resume' });
  }

  /** Graceful stop (the current step finishes); resolves when the run has ended. */
  async stop(runId: string, reason = '用户停止脚本'): Promise<void> {
    const entry = this.runs.get(runId);
    if (!entry) throw new Error('找不到执行记录（可能已经结束并被清理）');
    if (entry.finished) return;
    entry.requestStop?.(reason);
    await entry.done;
  }

  setDebugMatches(runId: string, enabled: boolean): void {
    const entry = this.live(runId, '切换匹配调试');
    entry.debugMatches = enabled;
    entry.post?.({ type: 'debugMatches', enabled });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const live = [...this.runs.values()].filter((entry) => !entry.finished);
    for (const entry of live) entry.requestStop?.('助手正在退出');
    await Promise.allSettled(live.map((entry) => entry.done));
  }

  private live(runId: string, action: string): RunEntry {
    const entry = this.runs.get(runId);
    if (!entry) throw new Error('找不到执行记录（可能已经结束并被清理）');
    if (entry.finished) throw new Error(`该执行已经结束，无法${action}`);
    return entry;
  }

  /**
   * Run one script in a worker thread (the entry point for PlanService and later modules). Never rejects for a
   * script failure: the terminal snapshot says how the run ended (succeeded / failed / aborted; `timedOut` when the
   * whole-run limit ended it). The caller must hold the instance lease for the whole call.
   */
  run(options: ScriptExecuteOptions): Promise<ScriptRunSnapshot> {
    return this.execute(options);
  }

  /** Same as `run()`. */
  async execute(options: ScriptExecuteOptions): Promise<ScriptRunSnapshot> {
    if (this.disposed) throw new Error('助手正在退出，不能启动新的脚本');
    const index = options.instanceIndex;
    const busy = this.activeByIndex.get(index);
    if (busy) throw new Error(`实例 #${index} 上已经有脚本在运行（${busy}），请先停止它`);
    const reserved = this.reservations.get(index);
    if (reserved && reserved !== options.runId) throw new Error(`实例 #${index} 已被另一次执行占用（${reserved}）`);
    const previous = this.runs.get(options.runId);
    if (previous && !previous.finished) throw new Error('同一执行正在运行');
    this.activeByIndex.set(index, options.runId);
    const snapshot: ScriptRunSnapshot = {
      runId: options.runId, scriptId: options.script.id, scriptName: options.script.name, instanceIndex: index,
      accountId: options.accountId, accountName: options.accountName, status: 'starting', startedAt: Date.now(), endedAt: null,
      stepDone: 0, stepTotal: options.script.loop ? null : options.script.steps.length, currentStepId: null, currentStepName: null,
      iteration: 0, error: null, stats: { captures: 0, matches: 0, matchHits: 0, taps: 0, retries: 0, lastTickMs: 0, avgCaptureMs: 0 },
      gameId: options.gameId, source: options.source, taskId: options.taskId, shotPolicy: options.shotPolicy, maxRunMs: options.maxRunMs,
    };
    const entry: RunEntry = { snapshot, finished: false, stopReason: null, debugMatches: false, done: Promise.resolve(snapshot) };
    this.runs.set(options.runId, entry);
    this.notify(entry);
    try {
      // A retried plan run reuses its run id: continue the shot numbering instead of colliding with old files.
      const shotSeqStart = (await this.logs.listShots(options.gameId, options.runId).catch(() => [])).length;
      entry.done = this.runWorker(entry, options, shotSeqStart);
      return await entry.done;
    } finally {
      if (this.activeByIndex.get(index) === options.runId) this.activeByIndex.delete(index);
      this.pruneMemory();
      this.pruneDisk(options.gameId);
    }
  }

  private notify(entry: RunEntry): void {
    try { this.options.onSnapshot?.(copy(entry.snapshot)); }
    catch (error) { console.error('[plan] 执行状态推送失败', error); }
  }

  /** A line written by the runner itself (gate failures, crashes), persisted and pushed like engine lines. */
  private runnerLog(entry: RunEntry, level: LogLevel, message: string): void {
    const line: LogEntry = { ts: Date.now(), level, runId: entry.snapshot.runId, instanceIndex: entry.snapshot.instanceIndex, scope: 'runner', message };
    this.persistLogs(entry, [line]);
  }

  private persistLogs(entry: RunEntry, entries: LogEntry[]): void {
    const { gameId, runId } = entry.snapshot;
    void this.logs.append(gameId, runId, entries).catch((error: unknown) => console.error(`[plan] 写运行日志失败（${runId}）`, error));
    try { this.options.onLogs?.({ gameId, runId, entries }); }
    catch (error) { console.error('[plan] 日志推送失败', error); }
  }

  private pruneMemory(): void {
    const done = [...this.runs.values()].filter((entry) => entry.finished)
      .sort((a, b) => (b.snapshot.endedAt ?? 0) - (a.snapshot.endedAt ?? 0));
    for (const entry of done.slice(MAX_FINISHED_KEPT)) this.runs.delete(entry.snapshot.runId);
  }

  /** Keep the newest 200 run directories of a game, never touching live runs. */
  private pruneDisk(gameId: string): void {
    if (this.pruning.has(gameId)) return;
    this.pruning.add(gameId);
    const protect = new Set([...this.runs.values()].filter((entry) => !entry.finished).map((entry) => entry.snapshot.runId));
    void this.logs.prune(gameId, KEEP_RUNS, protect)
      .catch((error: unknown) => console.error('[plan] 清理旧运行记录失败', error))
      .finally(() => this.pruning.delete(gameId));
  }

  private runWorker(entry: RunEntry, options: ScriptExecuteOptions, shotSeqStart: number): Promise<ScriptRunSnapshot> {
    const workerPath = join(dirname(fileURLToPath(import.meta.url)), 'script-worker.js');
    const controller = new AbortController();
    const signal = controller.signal;
    let worker: ScriptWorkerLike;
    try { worker = this.workerFactory(workerPath); }
    catch (error) {
      return Promise.resolve(this.close(entry, 'failed', `无法启动脚本执行线程：${errorMessage(error)}`));
    }
    // Aborted on stop (not only on finish): an advisor still looking at the screen must stop touching it.
    const aiStop = new AbortController();
    let approved = false;
    let settled = false;
    let deviceQueue: Promise<void> = Promise.resolve();
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let overrun: string | null = null;
    const queue = (operation: () => Promise<void>): Promise<void> => {
      const call = deviceQueue.then(operation);
      // The tail always resolves; callers still see the failure.
      deviceQueue = call.catch(() => undefined);
      return call;
    };
    const post = (message: ScriptMainToWorker, transfer?: ArrayBuffer[]): void => {
      if (settled) return;
      try { worker.postMessage(message, transfer); } catch { /* The exit handler settles the run. */ }
    };

    return new Promise<ScriptRunSnapshot>((resolve) => {
      const finish = (reported: RunStatus, reportedError: string | null, final?: RunSnapshot): void => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener('abort', onExternalAbort);
        if (stopTimer) clearTimeout(stopTimer);
        if (deadlineTimer) clearTimeout(deadlineTimer);
        // Stopped by the main-side run limit: that is a failure, not a user stop.
        const status: RunStatus = overrun && reported === 'aborted' ? 'failed' : reported;
        const error = overrun && reported === 'aborted' ? overrun : reportedError;
        // Queued requests are refused from now on; calls already in flight must settle before the lease goes.
        controller.abort(new RunnerMessageError('脚本执行已结束'));
        aiStop.abort(new RunnerMessageError('脚本执行已结束'));
        void (async () => {
          await deviceQueue;
          entry.post = undefined;
          await worker.terminate().catch(() => undefined);
          if (final) entry.snapshot = { ...entry.snapshot, ...final, ...this.appFields(options) };
          // The main-side backstop is the same limit: plans must not retry it either.
          if (overrun) entry.snapshot.timedOut = true;
          const done = this.close(entry, isTerminal(status) ? status : 'failed', error);
          await this.logs.flushed(options.gameId, options.runId).catch(() => undefined);
          resolve(done);
        })();
      };
      const requestStop = (reason: string): void => {
        if (settled || entry.stopReason) return;
        entry.stopReason = reason;
        aiStop.abort(new RunnerMessageError(reason));
        if (!isTerminal(entry.snapshot.status)) {
          entry.snapshot.status = 'stopping';
          this.notify(entry);
        }
        post({ type: 'stop', reason });
        stopTimer = setTimeout(() => {
          this.runnerLog(entry, 'warn', `停止等待超过 ${Math.round((this.options.stopGraceMs ?? STOP_GRACE_MS) / 1000)} 秒，强制结束执行线程。`);
          post({ type: 'abort', reason });
          finish('aborted', null);
        }, this.options.stopGraceMs ?? STOP_GRACE_MS);
        (stopTimer as { unref?: () => void }).unref?.();
      };
      function onExternalAbort(): void {
        requestStop(options.signal?.reason instanceof Error ? options.signal.reason.message : '脚本已取消');
      }
      entry.post = post;
      entry.requestStop = requestStop;
      const maxRunMs = options.maxRunMs ?? 0;
      if (maxRunMs > 0) {
        deadlineTimer = setTimeout(() => {
          if (settled || entry.stopReason) return;
          overrun = limitMessage(maxRunMs);
          this.runnerLog(entry, 'error', `${overrun}执行线程没有按时结束，由主进程强制收尾。`);
          requestStop(overrun);
        }, Math.min(maxRunMs + (this.options.deadlineSlackMs ?? DEADLINE_SLACK_MS), 2_147_483_647));
        (deadlineTimer as { unref?: () => void }).unref?.();
      }

      worker.on('message', (message: ScriptWorkerToMain) => {
        if (settled) return;
        switch (message.type) {
          case 'request': {
            const wasApproved = approved;
            void queue(() => this.handleDeviceRequest(post, message, wasApproved, signal, options, entry));
            return;
          }
          case 'ready':
            if (entry.stopReason) return; // The worker finishes as aborted on its own.
            void queue(async () => {
              checkAbort(signal);
              await this.assertIdentity(options);
              if (!startsWithLaunch(options.script, options.packageName)) await this.assertForeground(options, await this.host.device(options.instanceIndex));
              checkAbort(signal);
              if (settled || entry.stopReason) return;
              approved = true;
              post({ type: 'go' });
            }).catch((error: unknown) => {
              const reason = safeErrorMessage(error);
              this.runnerLog(entry, 'error', `启动检查未通过：${reason}`);
              finish('failed', reason);
            });
            return;
          case 'status':
            entry.snapshot = { ...entry.snapshot, ...message.snapshot, ...this.appFields(options) };
            if (entry.stopReason && !isTerminal(entry.snapshot.status)) entry.snapshot.status = 'stopping';
            this.notify(entry);
            return;
          case 'logs':
            this.persistLogs(entry, message.entries);
            return;
          case 'matches':
            if (entry.debugMatches) {
              try { this.options.onMatches?.({ gameId: options.gameId, runId: options.runId, instanceIndex: options.instanceIndex, results: message.results }); }
              catch { /* A closed monitor cannot break the run. */ }
            }
            return;
          case 'aiConsult':
            // In the device queue: the advisor may tap, so the lease waits for it like for any device call.
            void queue(async () => {
              const result = await this.relayAi(message, options, aiStop.signal);
              post({ type: 'aiResult', requestId: message.requestId, result });
            });
            return;
          case 'finished':
            finish(message.snapshot.status, message.snapshot.error, message.snapshot);
            return;
          case 'failed':
            this.runnerLog(entry, 'error', message.error);
            finish(entry.stopReason ? 'aborted' : 'failed', entry.stopReason ? null : message.error);
            return;
        }
      });
      worker.on('error', (error) => {
        if (settled) return;
        const text = `脚本执行线程异常：${error.message}`;
        this.runnerLog(entry, 'error', text);
        finish(entry.stopReason ? 'aborted' : 'failed', entry.stopReason ? null : text);
      });
      worker.on('exit', (code) => {
        if (settled) return;
        const text = `脚本执行线程已退出（${code}），本次执行未完成。`;
        this.runnerLog(entry, entry.stopReason ? 'warn' : 'error', text);
        finish(entry.stopReason ? 'aborted' : 'failed', entry.stopReason ? null : text);
      });

      if (options.signal?.aborted) onExternalAbort();
      else options.signal?.addEventListener('abort', onExternalAbort, { once: true });
      post({
        type: 'start',
        input: {
          runId: options.runId, instanceIndex: options.instanceIndex, script: options.script, params: options.params,
          accountId: options.accountId, accountName: options.accountName, templateDir: options.templateDir,
          shotPolicy: options.shotPolicy, maxRunMs: options.maxRunMs, consultAi: options.aiAssist !== false,
          debugMatches: entry.debugMatches, shotSeqStart, ...(options.matchDefaults ? { matchDefaults: options.matchDefaults } : {}),
          ...this.captureInterval(), ...this.options.pacing,
        },
      });
    });
  }

  /** `{ minCaptureIntervalMs }` from the app settings, or nothing (engine default) when absent, failing or invalid. */
  private captureInterval(): { minCaptureIntervalMs?: number } {
    try {
      const value = this.options.captureIntervalMs?.();
      return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 60_000 ? { minCaptureIntervalMs: value } : {};
    } catch {
      return {};
    }
  }

  private appFields(options: ScriptExecuteOptions): Pick<ScriptRunSnapshot, 'gameId' | 'source' | 'taskId' | 'shotPolicy' | 'maxRunMs' | 'runId' | 'instanceIndex'> {
    return {
      gameId: options.gameId, source: options.source, taskId: options.taskId, shotPolicy: options.shotPolicy, maxRunMs: options.maxRunMs,
      runId: options.runId, instanceIndex: options.instanceIndex,
    };
  }

  private close(entry: RunEntry, status: RunStatus, error: string | null): ScriptRunSnapshot {
    entry.finished = true;
    entry.post = undefined;
    entry.snapshot = {
      ...entry.snapshot,
      status,
      endedAt: entry.snapshot.endedAt ?? Date.now(),
      currentStepId: null,
      currentStepName: null,
      error: status === 'failed' ? (error ?? entry.snapshot.error ?? '脚本执行失败') : null,
    };
    this.notify(entry);
    return copy(entry.snapshot);
  }

  /**
   * ★ Always answers, and within bounds: the worker is idle on this await, and the run's device queue (so the
   * lease) waits for it. A stop aborts `signal`; an advisor that ignores it is given up on after a short grace.
   */
  private async relayAi(message: Extract<ScriptWorkerToMain, { type: 'aiConsult' }>, options: ScriptExecuteOptions, signal: AbortSignal): Promise<AiAssistResult> {
    const assist = this.aiAssist;
    if (!assist) return { handled: false, message: 'AI 顾问没有接入执行链路，本次跳过。' };
    if (signal.aborted) return { handled: false, message: '执行已停止，不再等待 AI 顾问。' };
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    let onAbort: (() => void) | undefined;
    const bounded = new Promise<AiAssistResult>((resolve) => {
      const give = (text: string): void => resolve({ handled: false, message: text });
      timers.push(setTimeout(() => give('AI 顾问超时没有回应，按未处理继续。'), AI_CONSULT_TIMEOUT_MS));
      onAbort = (): void => { timers.push(setTimeout(() => give('执行已停止，不再等待 AI 顾问。'), this.options.aiAbortGraceMs ?? AI_ABORT_GRACE_MS)); };
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      return await Promise.race([
        assist({
          gameId: options.gameId, runId: options.runId, instanceIndex: options.instanceIndex, scriptId: options.script.id,
          templateSetId: options.script.templateSetId ?? null, templateDir: options.templateDir,
          stepId: message.stepId, reason: message.reason, expectTemplateIds: message.expectTemplateIds, signal,
        }),
        bounded,
      ]);
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      return {
        handled: false,
        message: `AI 顾问出错，按未处理继续：${safeErrorMessage(error)}`,
        requiresAttention: code === 'AI_RISK_BLOCKED' || code === 'GAME_UPDATE_REQUIRED',
      };
    } finally {
      for (const timer of timers) clearTimeout(timer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  /** The instance is still the one admitted, and the extra ownership rules (account binding) still hold. */
  private async assertIdentity(options: ScriptExecuteOptions): Promise<void> {
    const state = await this.host.instance(options.instanceIndex);
    if (state.status !== 'running' || state.record.createdAt !== options.instanceIdentity) {
      throw new ExecutionGuardError('实例已停止或被替换，脚本已停止');
    }
    await options.assertOwnership?.();
  }

  private async assertForeground(options: ScriptExecuteOptions, device: ScriptDevice): Promise<void> {
    const current = await device.foregroundPackage();
    if (current !== options.packageName) {
      throw new ExecutionGuardError(`目标游戏已离开前台（预期 ${options.packageName}，当前 ${current ?? '未知'}），脚本已停止`);
    }
  }

  /**
   * ★ Frames come only from the game: while another app, the launcher or a system dialog is in front no frame
   * reaches the worker, so no trace shot can store someone else's screen. A plain step failure, not a guard:
   * retries and `onFail: restartApp` keep their chance to bring the game back (original recovery semantics).
   */
  private async assertCaptureForeground(options: ScriptExecuteOptions, device: ScriptDevice): Promise<void> {
    const current = await device.foregroundPackage();
    if (current !== options.packageName) {
      throw new RunnerMessageError(`目标游戏不在前台（当前 ${current ?? '未知'}），本次不抓取画面`);
    }
  }

  /** Input is allowed only on the admitted instance, for the bound account, with the game in the foreground. */
  private async guardInput(options: ScriptExecuteOptions, device: ScriptDevice, signal: AbortSignal): Promise<void> {
    checkAbort(signal);
    await this.assertIdentity(options);
    await this.assertForeground(options, device);
    checkAbort(signal);
  }

  private async waitForForeground(options: ScriptExecuteOptions, device: ScriptDevice, signal: AbortSignal): Promise<void> {
    const timeout = this.options.foregroundTimeoutMs ?? FOREGROUND_TIMEOUT_MS;
    const poll = this.options.foregroundPollMs ?? FOREGROUND_POLL_MS;
    const deadline = Date.now() + timeout;
    for (;;) {
      checkAbort(signal);
      if (await device.foregroundPackage() === options.packageName) return;
      if (Date.now() >= deadline) throw new RunnerMessageError(`启动游戏后 ${Math.round(timeout / 1000)} 秒仍未进入前台`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { signal.removeEventListener('abort', wake); resolve(); }, poll);
        const wake = (): void => { clearTimeout(timer); resolve(); };
        signal.addEventListener('abort', wake, { once: true });
      });
    }
  }

  private async handleDeviceRequest(
    post: (message: ScriptMainToWorker, transfer?: ArrayBuffer[]) => void, request: ScriptDeviceRequest, approved: boolean,
    signal: AbortSignal, options: ScriptExecuteOptions, entry: RunEntry,
  ): Promise<void> {
    const reply = (value?: RawFrame | string | null, transfer?: ArrayBuffer[]): void => post({ type: 'response', id: request.id, ok: true, value }, transfer);
    try {
      checkAbort(signal);
      if (!approved) throw new RunnerMessageError('启动检查通过前禁止操作设备');
      if (request.op === 'shot') {
        const [file, bytes] = request.args;
        reply(await this.logs.saveShot(options.gameId, options.runId, file, bytes));
        return;
      }
      const device = await this.host.device(options.instanceIndex);
      switch (request.op) {
        case 'foregroundPackage':
          reply((await device.foregroundPackage()) ?? null);
          return;
        case 'capture': {
          await this.assertIdentity(options);
          await this.assertCaptureForeground(options, device);
          const frame = await device.screencapRaw();
          checkAbort(signal);
          // After as well: the frame may have been taken while another app was coming to the front.
          await this.assertCaptureForeground(options, device);
          checkAbort(signal);
          const data = Uint8Array.from(frame.data);
          reply({ width: frame.width, height: frame.height, data, capturedAt: frame.capturedAt, format: frame.format }, [data.buffer]);
          return;
        }
        case 'tap': await this.guardInput(options, device, signal); await device.tap(...request.args); break;
        case 'swipe': await this.guardInput(options, device, signal); await device.swipe(...request.args); break;
        case 'key': await this.guardInput(options, device, signal); await device.keyevent(request.args[0]); break;
        case 'longPress': {
          const [x, y, ms] = request.args;
          if (![x, y, ms].every((value) => Number.isFinite(value) && value >= 0)) throw new RunnerMessageError('长按参数无效');
          await this.guardInput(options, device, signal);
          // ★ DOWN / sleep / UP in ONE shell so nothing can run between them (never a swipe).
          await device.shell(`input motionevent DOWN ${Math.round(x)} ${Math.round(y)}; sleep ${(ms / 1000).toFixed(3)}; input motionevent UP ${Math.round(x)} ${Math.round(y)}`,
            { timeoutMs: ms + 10_000 });
          break;
        }
        case 'text': {
          const [value] = request.args;
          await this.guardInput(options, device, signal);
          if (needsUnicodeInput(value)) {
            const ime = await readImeStatus(device, options.instanceIndex);
            if (!ime.available) {
              throw new RunnerMessageError(`文本含中文等非 ASCII 字符，但实例 #${options.instanceIndex} 没有可用的 ADBKeyboard 输入法：${ime.message}`);
            }
            await this.guardInput(options, device, signal);
            await device.shell(imeBroadcastCommand(value), { timeoutMs: 15_000 });
          } else {
            await device.text(value, () => this.guardInput(options, device, signal));
          }
          break;
        }
        case 'launchApp': {
          const [pkg, cold] = request.args;
          if (pkg !== options.packageName) throw new RunnerMessageError(`脚本只能启动当前游戏（${options.packageName}），禁止启动其他应用`);
          await this.assertIdentity(options);
          checkAbort(signal);
          if (cold) await device.stopApp(pkg);
          checkAbort(signal);
          // ★ monkey (AdbDevice.startApp without an activity): `am start` reports success but the game never starts.
          await device.startApp(pkg);
          await this.waitForForeground(options, device, signal);
          this.runnerLog(entry, 'info', `${cold ? '冷启动' : '启动'}游戏后已回到前台。`);
          break;
        }
        case 'stopApp': {
          const [pkg] = request.args;
          if (pkg !== options.packageName) throw new RunnerMessageError(`脚本只能停止当前游戏（${options.packageName}），禁止停止其他应用`);
          await this.assertIdentity(options);
          checkAbort(signal);
          await device.stopApp(pkg);
          break;
        }
      }
      checkAbort(signal);
      reply();
    } catch (error) {
      // ★ Never the raw device error: it carries the adb command line (serial, typed text or its base64).
      post({ type: 'response', id: request.id, ok: false, error: forwardedDeviceError(request.op, error, request.args), guard: isExecutionGuardError(error) });
    }
  }
}
