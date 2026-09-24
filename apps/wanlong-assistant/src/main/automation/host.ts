import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { AppError, canonicalDirectory, TemplateLibrary, type MatchResult, type RawFrame, type Rect, type TemplateDraft, type TemplateSaveResult, type TemplateSet } from '@avdm/automation';
import {
  cycleFactOf, normalizeGatherConfig, startupFailureFact, type DispatchRecord, type GatherCycleFact,
  type GatherCycleResult, type KickedProbeResult, type PanelSample, type ResourceSnapshot, type ShotPolicy,
} from '@avdm/automation/wanlong';
import { coerceGatherConfig, describeBlockingIssues, validateGatherConfigInput } from '@avdm/automation/wanlong/pure';
import type { AutomationGameSummary, AutomationProbeReport, AutomationRun, AutomationSchedule, AutomationSettings, TemplateAlphaPreview, TemplateCapture, TemplateCoverage, TemplateImportResult, TemplatesChange, TemplateTestOptions, TemplateTestResult } from '../../shared/ipc';
import { withLabelledLease } from '../app/instance-access';
import { broadcast } from '../events';
import type { ManagerHost } from '../manager-host';
import { asIndex, errorMessage } from '../util';
import { ScheduleCompat, toAutomationSchedule } from '../scheduler/compat';
import { SchedulerError, abortError, codeOf, isAttentionCode, isGateCode, messageOf } from '../scheduler/errors';
import { InstanceLocks } from '../scheduler/instance-lock';
import { EtaScheduler, type EtaSchedulerOptions } from '../scheduler/service';
import { ShotStore } from '../scheduler/shots';
import type { HealthFrame, LogLevel, QueueFreeResult, SampleRequest } from '../scheduler/types';
import { WanlongGatherRunner, type DeviceLaneRun, type GatherManager, type GatherRunResult, type MatchQueryOptions } from './gather-runner';
import { inspectGatherProbe } from './gather-probe-guard';
import { gamePlugin, gameSummaries, gameTask } from './games';
import type { ProbeWorkerInput, ProbeWorkerOutput } from './probe-worker';
import { transferableJob, type TemplateJob, type TemplateJobOutput } from './template-jobs';
import { buildTemplateCoverage, rawFrameToPng, TemplateChangeFeed, workerError, type TemplatesChangeListener } from './template-tools';
import { AutomationSettingsStore, type StoredAutomationSettings } from './store';

const PROBE_TIMEOUT_MS = 120_000;
const TEMPLATE_JOB_TIMEOUT_MESSAGES: Record<TemplateJob['kind'], string> = {
  test: '模板测试超时', compile: '模板编译检查超时', alphaPreview: '去底预览超时', diffAlpha: '透明底计算超时',
};
const NOT_READY = '该实例暂不能运行自动任务，请在账号管理中检查账号登录状态';
/** DECISIONS B: a tripped circuit breaker is not a failure; the scheduler looks again after this (probes continue). */
const CIRCUIT_BREAKER_COOLDOWN_MS = 10 * 60_000;
/** How long a read-only probe pass the user confirmed in the enable dialog stands in for the first-enable probe. */
const PROBE_PASS_TTL_MS = 5 * 60_000;
const MAX_RUN_HISTORY = 100;
const RUN_HISTORY_VERSION = 1;
const MAX_RUN_HISTORY_BYTES = 256 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isRun(value: unknown): value is AutomationRun {
  if (!isRecord(value)) return false;
  const status = value['status'];
  return typeof value['runId'] === 'string' && typeof value['gameId'] === 'string' &&
    typeof value['taskId'] === 'string' && typeof value['index'] === 'number' &&
    Number.isInteger(value['index']) && value['index'] >= 0 && value['index'] <= 63 &&
    typeof status === 'string' && ['running', 'stopping', 'succeeded', 'failed', 'cancelled'].includes(status) &&
    typeof value['startedAt'] === 'number' && Number.isFinite(value['startedAt']) &&
    (value['endedAt'] === null || (typeof value['endedAt'] === 'number' && Number.isFinite(value['endedAt']))) &&
    typeof value['message'] === 'string' &&
    (value['nextWakeAt'] === undefined || value['nextWakeAt'] === null ||
      (typeof value['nextWakeAt'] === 'number' && Number.isFinite(value['nextWakeAt'])));
}

type GatherRunnerPort = Pick<WanlongGatherRunner, 'runOnce' | 'stop' | 'dispose' | 'isRunning'> &
  Partial<Pick<WanlongGatherRunner, 'sample' | 'healthFrame' | 'invalidateTemplates' | 'recognize' | 'match' | 'updateCheck' | 'readResources'>> &
  Partial<Pick<WanlongGatherRunner, 'frameDiff' | 'targetStable' | 'admittedIdentity'>>;

/** Extra run observers (statistics next to alerts); see `AutomationHost.observe`. */
export type AutomationRunObserver = Pick<AutomationHostHooks, 'onCycleResult' | 'onDispatched'>;

/** A resource read waits this long for a short holder of the instance (a health probe) before calling it busy. */
const RESOURCE_READ_LOCK_WAIT_MS = 5_000;

/** A future durable scheduler may consume a completed cycle and return only a wake it actually stored. */
export type CycleCompletionSink = (run: AutomationRun, result: GatherCycleResult) => Promise<number | null>;

/**
 * Observers of gather runs. Pass them to the constructor or merge them later with `AutomationHost.setHooks()` from a
 * module's own section of main/index.ts (alerts: `onCycleResult` / `onNeedsAttention`, stats: `onDispatched`…).
 */
export interface AutomationHostHooks {
  onCycle?: (run: AutomationRun, result: GatherCycleResult, source: 'manual' | 'scheduled') => Promise<void>;
  onFailure?: (run: AutomationRun, error: unknown, source: 'manual' | 'scheduled') => Promise<void>;
  onScheduleStop?: (gameId: string, index: number, failureCount: number) => Promise<void>;
  /**
   * Accounts gate (`AccountManager.readiness`, original `assertInstanceAutomationReady`): the base instance, an active
   * login and a pending / stale bound account are refused with a Chinese reason. Asked when auto is enabled or resumed,
   * before every troop-panel sample and before every cycle; never when switching off. A refusal is a verdict, not a
   * failure: a scheduled wake it refuses pauses the ETA scheduler (`setAuto(false)` with the reason) without counting
   * a failure. A rejected promise (the gate could not decide) is an ordinary failure with backoff.
   */
  automationReadiness?: (gameId: string, index: number) => Promise<{ ready: boolean; reason?: string }>;
  /** A scheduled wake the accounts gate refused: the schedule is paused (not a failure) and `reason` is user-facing. */
  onSchedulePause?: (gameId: string, index: number, reason: string) => Promise<void>;
  /**
   * App settings `shotPolicy` (original AppSettings.shotPolicy): which gather scenes are written to
   * `automation/wanlong/shots` — `never` none, `onFail` failure scenes only, `always` process shots too. Absent = the
   * gather config's own `safety.shotPolicy`. Failure frames still reach the kicked probe under every policy.
   */
  shotPolicy?: () => ShotPolicy;
  /**
   * App settings defaults for script matching (threshold of templates without their own, downsampling factor).
   * 「测试模板」 uses the same values so a test hits or misses exactly as a script run would (original matchOnce).
   */
  matchDefaults?: () => { threshold: number; shrink: number };
  /**
   * Facts of one gather cycle for alerts (outcome, step 'G0' = recovery ladder exhausted, error code, failure shot,
   * kicked probe). Reported before a failed scheduled cycle throws, and also for cycles that never started.
   * Not called for cancelled cycles.
   */
  onCycleResult?: (index: number, fact: GatherCycleFact, source: 'manual' | 'scheduled') => Promise<void>;
  /** Every dispatch of a cycle (statistics: storage ≈ amount gathered), even when the cycle ended in an error. */
  onDispatched?: (index: number, records: DispatchRecord[], at: number) => Promise<void> | void;
  /**
   * The scheduler paused the instance because a human must look (GAME_UPDATE_REQUIRED / AI_RISK_BLOCKED) and no module
   * has set the scheduler's own `onNeedsAttention` hook yet (the fallback alert path).
   */
  onNeedsAttention?: (gameId: string, index: number, info: { code: string; message: string }) => Promise<void>;
}

/**
 * Ports later modules plug in (accounts, alerts, AI). All optional; see src/main/scheduler/README.md.
 * Set them with `AutomationHost.setPorts()` from main/index.ts.
 */
export interface AutomationHostPorts {
  /** Account bound to this AVD (index and instance identity; queue view, gather config owner). */
  accountIdOf?(index: number): Promise<string | null>;
  /** Another writer owns the instance (plan script, login): a Chinese label, or null. */
  externalBusy?(index: number): string | null;
  /**
   * The gather config stored on the account bound to this AVD (`AccountManager.gatherConfigFor`, original
   * Account.scriptParams.gather), or null when the instance has no current account or the account holds none (the
   * instance's own settings apply). A corrupt stored copy rejects: it never silently falls back.
   * The readiness gate is the `automationReadiness` hook (accounts + base instance), not a port.
   */
  accountGatherConfig?(index: number): Promise<{ accountId: string; accountName: string; config: Record<string, unknown> } | null>;
  /** Save the gather config onto the bound account (`AccountManager.saveGatherConfig`). */
  saveAccountGatherConfig?(accountId: string, config: Record<string, unknown>): Promise<void>;
  /** Second-layer kicked probe on a failure frame already captured. Must return null when templates are missing. */
  probeKicked?(index: number, raw: RawFrame): Promise<KickedProbeResult | null>;
  /** G0 unknown-screen advisor (AI / game update) inside a gather cycle. true = the screen changed. */
  adviseUnknownScreen?(index: number, raw: RawFrame, attempt: number, signal: AbortSignal): Promise<boolean>;
  /**
   * Why an alert paused this instance (null when it is not paused). The user's switch refuses to enable a paused
   * instance: only the pause banner's 「恢复」 clears the pause, its counters and its push cooldown.
   */
  pauseReason?(index: number): string | null;
}

export interface AutomationHostOptions {
  locks?: InstanceLocks;
  /**
   * The app shell's device lane (`DeviceLanes.run`). The host's manager already hands out lane-bound devices
   * (`deviceHost`); this keeps check-then-act sequences (foreground → screencap → foreground, foreground → tap) whole.
   */
  deviceLane?: DeviceLaneRun;
  scheduler?: Omit<EtaSchedulerOptions, 'locks' | 'publish' | 'publishConfig' | 'publishStatus' | 'log' | 'onSafetyPause' | 'onAttentionPause'>;
  shots?: ShotStore;
}

interface ActiveAutomationRun {
  index: number;
  controller: AbortController;
  source: 'manual' | 'scheduled';
  result: Promise<GatherCycleResult>;
  done: Promise<void>;
}

const GATHER_GAME_ID = 'wanlong';

/**
 * Whether a failed scheduled start is a fact for alerts: not a stop, a hand-over to another writer, a human-needed
 * pause or a readiness refusal (the gate's pause has its own「不计为失败」warning).
 */
function reportable(error: unknown, signal: AbortSignal): boolean {
  const code = codeOf(error);
  return !signal.aborted && code !== 'CONCURRENCY_LIMIT' && code !== 'RUN_ABORTED' && code !== 'CANCELLED' &&
    !isAttentionCode(code) && !isGateCode(code);
}

/** Host-owned bridge from AVD instances to isolated game-vision workers. */
export class AutomationHost {
  private readonly store: AutomationSettingsStore;
  private readonly home: string;
  private readonly templates: TemplateLibrary;
  private readonly gatherRunner: GatherRunnerPort;
  private readonly scheduler: ScheduleCompat;
  /** The ETA scheduler: queue states, exclusive(), suspendForScript(), hooks. Other modules use it from here. */
  readonly eta: EtaScheduler;
  /** The per-instance device lock shared by samples, cycles and `eta.exclusive()`. */
  readonly locks: InstanceLocks;
  private readonly shots: ShotStore;
  private readonly deviceLane: DeviceLaneRun | undefined;
  private ports: AutomationHostPorts = {};
  private hooks: AutomationHostHooks;
  private readonly observers = new Set<AutomationRunObserver>();
  private readonly workers = new Set<Worker>();
  private readonly runHistory = new Map<string, AutomationRun>();
  private readonly activeRuns = new Map<string, ActiveAutomationRun>();
  private readonly activeByIndex = new Map<number, string>();
  private readonly controlQueues = new Map<number, Promise<void>>();
  private readonly templateChanges = new TemplateChangeFeed();
  /** Replaces the one-shot template worker (tests run `runTemplateJob` in-process); unset in the app. */
  templateJobRunner?: (job: TemplateJob) => Promise<TemplateJobOutput>;
  /** Per-instance generation of schedule requests: a later disable supersedes an enable still probing. */
  private readonly scheduleRequests = new Map<number, number>();
  /** Instances whose first enable passed the read-only probe (this AVD, this template set) since the last edit. */
  private readonly probeConfirmed = new Map<number, { createdAt: string; templateDir: string }>();
  /**
   * The latest passing read-only probe of each instance (identified by its frame's `capturedAt`): the enable dialog
   * passes that id back, so the verdict the user confirmed is the one enforced instead of a second probe.
   */
  private readonly probePasses = new Map<number, { createdAt: string; templateDir: string; capturedAt: number; at: number }>();
  /** Bumped by every template or policy edit: a probe that started before the edit never counts as a pass. */
  private readonly probeGenerations = new Map<number, number>();
  private readonly historyFile: string;
  private readonly historyReady: Promise<void>;
  private historyWrite: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(private readonly host: ManagerHost, home: string, gatherRunner?: GatherRunnerPort, private readonly cycleSink?: CycleCompletionSink,
    hooks: AutomationHostHooks = {}, options: AutomationHostOptions = {}) {
    this.hooks = { ...hooks };
    this.home = home;
    this.store = new AutomationSettingsStore(home);
    this.templates = new TemplateLibrary(home);
    this.historyFile = join(home, 'automation', 'runs.json');
    this.historyReady = this.loadHistory();
    // Initialization is eager, but callers receive the error through the relevant IPC method.
    void this.historyReady.catch(() => undefined);
    const manager: GatherManager = {
      getState: async (index) => (await this.host.get()).getState(index),
      device: async (index) => (await this.host.get()).device(index),
    };
    this.locks = options.locks ?? new InstanceLocks(home);
    this.shots = options.shots ?? new ShotStore(home);
    this.deviceLane = options.deviceLane;
    this.gatherRunner = gatherRunner ?? new WanlongGatherRunner(manager, home, {
      locks: this.locks, ...(options.deviceLane ? { lane: options.deviceLane } : {}),
    });
    this.eta = new EtaScheduler(home, {
      sample: (index, request) => this.sampleTroopPanel(index, request),
      healthFrame: (index, signal) => this.healthFrame(index, signal),
      instance: (index) => this.instanceIdentity(index),
      ensureReady: (index) => this.ensureAutomationReady(index),
      accountIdOf: async (index) => (await this.ports.accountIdOf?.(index)) ?? null,
      externalBusy: (index) => this.ports.externalBusy?.(index) ?? null,
    }, {
      ...options.scheduler,
      locks: this.locks,
      publish: (state) => {
        broadcast('scheduler-changed', state);
        broadcast('automation-schedule', toAutomationSchedule(state));
      },
      publishConfig: (config) => broadcast('scheduler-config-changed', config),
      publishStatus: (status) => broadcast('scheduler-status', status),
      log: (level, message) => this.logLine(level, message),
      onSafetyPause: (index, failureCount) => {
        void this.hooks.onScheduleStop?.(GATHER_GAME_ID, index, failureCount).catch((error: unknown) =>
          console.error('[avdm] 调度暂停告警无法保存', error));
      },
      onAttentionPause: (index, info) => {
        void this.hooks.onNeedsAttention?.(GATHER_GAME_ID, index, info).catch((error: unknown) =>
          console.error('[avdm] 需要人工处理的告警无法保存', error));
      },
      onReadinessPause: (index, reason) => {
        void this.hooks.onSchedulePause?.(GATHER_GAME_ID, index, reason).catch((error: unknown) =>
          console.error('[avdm] 调度暂停提醒无法保存', error));
      },
    });
    this.eta.setQueueFreeHook((state, ctx) => this.gatherForScheduler(state.instanceIndex, ctx.signal));
    this.scheduler = new ScheduleCompat(this.eta);
    // ★ Compile once, invalidate on change (DECISIONS A.7): a template save / delete / import drops the compiled sets
    //   in the vision workers at once. The workers' manifest-fingerprint check stays as the fallback for edits made
    //   outside the host (a set changed on disk by tplkit or another process).
    this.onTemplatesChanged(() => this.gatherRunner.invalidateTemplates?.());
  }

  /** Plug in the ports of later modules (accounts, alerts, AI). Merges; `undefined` removes one. */
  setPorts(ports: Partial<AutomationHostPorts>): void {
    this.ports = { ...this.ports, ...ports };
  }

  /**
   * Merge run observers (`onCycleResult`, `onDispatched`, `onNeedsAttention`, …) from a later module's own section of
   * main/index.ts. Passing `undefined` for a key removes it. Applies to cycles that finish after the call.
   */
  setHooks(hooks: Partial<AutomationHostHooks>): void {
    this.hooks = { ...this.hooks, ...hooks };
  }

  /**
   * Add run observers next to the primary hooks (statistics next to alerts, which own `onCycleResult`): called
   * after them with the same arguments, each isolated (a throwing observer is logged). Returns the removal.
   */
  observe(observer: AutomationRunObserver): () => void {
    this.observers.add(observer);
    return () => { this.observers.delete(observer); };
  }

  /**
   * Read the in-game resource table (道具 → 资源统计) of one instance inside the instance lock (`eta.exclusive`, the
   * lock samples and cycles use; refused while a script or login holds the instance). A read never queues behind a
   * long sample or cycle: after a short wait it answers CONCURRENCY_LIMIT (busy, retry later — not a failure).
   * Failure scenes follow the app settings' shot policy. Never cold-starts the game.
   */
  async readResourceStats(index: number, options: { signal?: AbortSignal } = {}): Promise<ResourceSnapshot> {
    const i = asIndex(index);
    if (!this.gatherRunner.readResources) throw new SchedulerError('UNKNOWN', '采集运行器不支持读取资源统计');
    const settings = await this.store.get(GATHER_GAME_ID, i);
    if (!settings.templateDir) throw new SchedulerError('TEMPLATE_NOT_FOUND', '请先在「模板」页为该实例选择模板集，再读资源统计');
    const templateDir = settings.templateDir;
    if (this.locks.busy(i) && !this.locks.held(i)) {
      await Promise.race([this.locks.drain(i), new Promise((resolve) => setTimeout(resolve, RESOURCE_READ_LOCK_WAIT_MS).unref?.())]);
      if (this.locks.busy(i)) {
        const holder = this.locks.holder(i);
        throw new SchedulerError('CONCURRENCY_LIMIT', `实例 #${i} 正在${holder ?? '执行其他操作'}，读资源统计稍后再试。`, { instanceIndex: i });
      }
    }
    let shotPolicy: ShotPolicy | undefined;
    try { shotPolicy = this.hooks.shotPolicy?.(); } catch { shotPolicy = undefined; }
    return this.eta.exclusive(i, '读资源统计', ({ signal }) => this.gatherRunner.readResources!(i, {
      templateDir,
      signal,
      ...(shotPolicy ? { shotPolicy } : {}),
      saveShot: (label, raw) => this.shots.save(i, label, raw),
      log: (level, message) => this.logLine(level, `[实例 #${i}][资源统计] ${message}`),
    }), options.signal);
  }

  games(): AutomationGameSummary[] {
    return gameSummaries();
  }

  /**
   * The instance's settings as automation uses them: its template set, and the gather config of the account bound to
   * this AVD when that account holds one (original Account.scriptParams.gather, `configAccount` says whose), else the
   * instance's own config (DECISIONS B「采集配置跟随绑定的账号」).
   * This is the page read, so it never fails on a broken copy (original configStorage.loadGatherConfig: fall back to
   * defaults and say so): an account copy that cannot be parsed shows defaults with `accountConfigError`, a broken
   * instance file shows a salvage with `settingsError`; saving from the gather config page rewrites both. Runs never
   * fall back like this (`gatherConfig()` and `store.get()` refuse with the reason).
   */
  async settings(gameId: string, index: number): Promise<AutomationSettings> {
    gamePlugin(gameId);
    const i = asIndex(index);
    const read = await this.store.inspect(gameId, i);
    const broken = read.error ? { settingsError: read.error } : {};
    const own = async (): Promise<AutomationSettings> => ({ ...(await this.instanceView(i, read.settings)), ...broken });
    if (gameId !== GATHER_GAME_ID || !this.ports.accountGatherConfig) return own();
    let owned: Awaited<ReturnType<NonNullable<AutomationHostPorts['accountGatherConfig']>>>;
    try { owned = await this.ports.accountGatherConfig(i); }
    catch (error) {
      this.logLine('warn', `[实例 #${i}] 读不出绑定账号里的采集配置，采集配置页先显示默认配置（重新保存即可修复）：${messageOf(error)}`);
      return { templateDir: read.settings.templateDir, config: {}, accountConfigError: messageOf(error), ...broken };
    }
    return owned
      ? { templateDir: read.settings.templateDir, config: owned.config, configAccount: { id: owned.accountId, name: owned.accountName }, ...broken }
      : own();
  }

  /**
   * The instance file as the renderer sees it: `configReplaced` when its gather config was saved for another AVD that
   * used to sit at this index (identity stamp ≠ current `record.createdAt`). Files without a stamp are not flagged.
   */
  private async instanceView(index: number, stored: StoredAutomationSettings): Promise<AutomationSettings> {
    const view: AutomationSettings = { templateDir: stored.templateDir, config: stored.config };
    if (await this.isConfigReplaced(index, stored)) view.configReplaced = true;
    return view;
  }

  /** The instance file's gather config was saved for another AVD that used to sit at this index (identity stamp). */
  private async isConfigReplaced(index: number, stored: StoredAutomationSettings): Promise<boolean> {
    if (!stored.configFor || Object.keys(stored.config).length === 0) return false;
    const identity = await this.instanceIdentity(index).catch(() => null);
    return identity !== null && identity.createdAt !== stored.configFor;
  }

  /**
   * The instance's own settings file (template set + instance gather config), ignoring any bound account. For callers
   * that only need the template set (plans, the login home check) or copy an instance's file (base-instance clones):
   * an account's corrupt gather config must not break them.
   */
  instanceSettings(gameId: string, index: number): Promise<AutomationSettings> {
    gamePlugin(gameId);
    return this.store.get(gameId, asIndex(index));
  }

  /**
   * The gather config saved in the instance's own settings file, ignoring any bound account. For the accounts module:
   * binding moves it into a newly bound account that has none (original afterAccountBind).
   */
  async instanceGatherConfig(gameId: string, index: number): Promise<Record<string, unknown> | null> {
    gamePlugin(gameId);
    const i = asIndex(index);
    const view = await this.instanceView(i, await this.store.get(gameId, i));
    // A config saved for an AVD that no longer exists never moves into the newly bound account.
    return Object.keys(view.config).length > 0 && !view.configReplaced ? view.config : null;
  }

  /**
   * Original afterAccountBind removed the local copy once it moved into the account: the instance's own gather config is
   * cleared (template set kept), so unbinding later shows defaults instead of an outdated pre-bind copy. Lease-free
   * (the caller already holds the instance lease); only the settings file's own lock is taken.
   */
  async clearInstanceGatherConfig(gameId: string, index: number): Promise<void> {
    gamePlugin(gameId);
    await this.store.save(gameId, asIndex(index), { config: {} });
    this.emitSettingsChanged(gameId, asIndex(index));
  }

  templateSets(gameId: string): Promise<TemplateSet[]> {
    gamePlugin(gameId);
    return this.templates.managedSets(gameId);
  }

  async createTemplateSet(gameId: string, index: number, name: string): Promise<TemplateSet> {
    const plugin = gamePlugin(gameId);
    const i = asIndex(index);
    return this.withControlLock(i, async () => {
      this.assertTemplateEditable(i);
      this.forgetProbe(i);
      if ((await this.scheduler.get(gameId, i)).enabled) await this.scheduler.disable(gameId, i);
      return this.withDeviceLease(i, async () => {
      const size = plugin.referenceSize ?? { width: 2560, height: 1440 };
      const set = await this.templates.createSet(gameId, name, plugin.packageName, size.width, size.height);
      await this.store.save(gameId, i, { templateDir: set.directory });
      this.emitSettingsChanged(gameId, i);
      return set;
      });
    });
  }

  async templateSet(gameId: string, index: number): Promise<TemplateSet | null> {
    const plugin = gamePlugin(gameId);
    const { templateDir } = await this.store.get(gameId, asIndex(index));
    if (!templateDir) return null;
    const set = await this.templates.load(templateDir);
    if (set.packageName && set.packageName !== plugin.packageName) throw new Error('模板集与当前游戏包名不一致');
    return set;
  }

  async templateImage(gameId: string, index: number, id: string): Promise<Uint8Array> {
    const set = await this.templateSet(gameId, index);
    if (!set) throw new Error('请先选择或创建模板集');
    return this.templates.image(set.directory, id);
  }

  /** Shared read-only capture for template authoring and the opt-in advisor. */
  async captureReadOnly(gameId: string, index: number): Promise<{ frame: RawFrame; foregroundPackage: string | null }> {
    const plugin = gamePlugin(gameId);
    const i = asIndex(index);
    if (this.disposed) throw new Error('应用正在退出');
    const manager = await this.host.get();
    const state = await manager.getState(i);
    if (state.status !== 'running') throw new Error(`实例 #${i} 尚未就绪`);
    const device = await manager.device(i);
    // One unit on the device lane: nothing else of this instance runs between the two foreground reads.
    return this.onLane(i, async () => {
      const before = await device.foregroundPackage();
      if (before !== plugin.packageName) throw new Error(`${plugin.name}未处于前台`);
      let frame: RawFrame;
      try { frame = await device.screencapRaw(); }
      catch (error) { throw new Error(`ADB 截图失败: ${errorMessage(error)}`, { cause: error }); }
      const after = await device.foregroundPackage();
      if (before !== after) throw new Error('截图期间前台应用发生切换，请重试');
      return { frame, foregroundPackage: after ?? null };
    });
  }

  async captureTemplate(gameId: string, index: number): Promise<TemplateCapture> {
    const { frame, foregroundPackage } = await this.captureReadOnly(gameId, index);
    const png = await rawFrameToPng(frame);
    return { png, width: frame.width, height: frame.height, capturedAt: frame.capturedAt, foregroundPackage };
  }

  /**
   * `frames`: the main frame plus 1–3 diff frames of the same size. Pure computation in a worker (PNG decodes and
   * per-pixel loops), never touches the device.
   */
  async previewTemplateAlpha(gameId: string, index: number, frames: Uint8Array[], crop: Rect, tolerance: number, previewWidth?: number): Promise<TemplateAlphaPreview> {
    const set = await this.templateSet(gameId, index);
    if (!set) throw new Error('请先选择或创建模板集');
    const output = await this.runTemplateJob({ kind: 'alphaPreview', frames, crop, tolerance, previewWidth });
    if (output.kind !== 'alphaPreview') throw new Error('去底预览未返回结果');
    return output.preview;
  }

  async saveTemplate(gameId: string, index: number, draft: TemplateDraft): Promise<TemplateSaveResult> {
    const i = asIndex(index);
    // The diff mask is pure computation: done in a worker before any lock is taken.
    const { draft: ready, diffCoverage } = await this.resolveDiffAlpha(draft);
    const result = await this.withControlLock(i, async () => {
      this.assertTemplateEditable(i);
      const set = await this.templateSet(gameId, i);
      if (!set) throw new Error('请先选择或创建模板集');
      this.forgetProbe(i);
      if ((await this.scheduler.get(gameId, i)).enabled) await this.scheduler.disable(gameId, i);
      return this.withDeviceLease(i, () => this.templates.save(set.directory, ready));
    });
    this.emitTemplatesChanged(gameId, result.directory, 'save', [result.definition.id]);
    return diffCoverage === undefined ? result : { ...result, diffCoverage };
  }

  /**
   * A draft with `diffFrames` (and no caller alpha): compute the mask in the template worker with the preview's
   * algorithm and hand it to the library as `alpha`, so the main thread never decodes whole frames.
   */
  private async resolveDiffAlpha(draft: TemplateDraft): Promise<{ draft: TemplateDraft; diffCoverage?: number }> {
    const { diffFrames, diffTolerance, ...rest } = draft;
    if (!diffFrames?.length || (draft.alpha && draft.alpha.byteLength > 0)) return { draft: rest };
    if (!draft.crop) throw new AppError('INVALID_ARGUMENT', `模板「${draft.name}」要做差分去底必须给裁剪区域（差分帧是整帧，得知道裁哪一块）`);
    const output = await this.runTemplateJob({ kind: 'diffAlpha', frames: [draft.image, ...diffFrames], crop: draft.crop, tolerance: diffTolerance });
    if (output.kind !== 'diffAlpha') throw new Error('透明底计算未返回结果');
    return { draft: { ...rest, alpha: output.alphaPng }, diffCoverage: output.coverage };
  }

  async deleteTemplate(gameId: string, index: number, id: string): Promise<void> {
    const i = asIndex(index);
    const directory = await this.withControlLock(i, async () => {
      this.assertTemplateEditable(i);
      const set = await this.templateSet(gameId, i);
      if (!set) throw new Error('请先选择或创建模板集');
      this.forgetProbe(i);
      if ((await this.scheduler.get(gameId, i)).enabled) await this.scheduler.disable(gameId, i);
      await this.withDeviceLease(i, () => this.templates.delete(set.directory, id));
      return set.directory;
    });
    this.emitTemplatesChanged(gameId, directory, 'delete', [id]);
  }

  /** 「立即验证」: one fresh read-only capture, matched and previewed on that same frame (in a worker). */
  async testTemplate(gameId: string, index: number, id: string, options: TemplateTestOptions = {}): Promise<TemplateTestResult> {
    const set = await this.templateSet(gameId, index);
    if (!set) throw new Error('请先选择或创建模板集');
    const stored = set.templates.find((item) => item.id === id);
    if (!stored) throw new AppError('TEMPLATE_NOT_FOUND', `模板集「${set.name}」里没有 id 为 ${id} 的模板`);
    const [{ frame, foregroundPackage }, image] = await Promise.all([
      this.captureReadOnly(gameId, index), this.templates.image(set.directory, id),
    ]);
    // Same values as a script run (original matchOnce): the settings threshold for templates without their own and the
    // settings shrink; a threshold typed into the test itself still wins.
    const defaults = this.hooks.matchDefaults?.();
    const definition = defaults && stored.threshold === undefined ? { ...stored, threshold: defaults.threshold } : stored;
    const output = await this.runTemplateJob({
      kind: 'test', frame, set, definition, image, roi: options.roi, threshold: options.threshold, ...(defaults ? { shrink: defaults.shrink } : {}),
    });
    if (output.kind !== 'test') throw new Error('模板测试未返回结果');
    const png = await rawFrameToPng(frame);
    return { match: output.match, preview: { png, width: frame.width, height: frame.height, capturedAt: frame.capturedAt, foregroundPackage } };
  }

  /**
   * Missing critical / optional gather templates and glyph digits of the instance's set. `compile` also compiles
   * every template in a worker and reports the ones that fail (missing PNG, low variance after a hand edit, …).
   */
  async templateCoverage(gameId: string, index: number, compile: boolean): Promise<TemplateCoverage | null> {
    const set = await this.templateSet(gameId, index);
    if (!set) return null;
    if (!compile) return buildTemplateCoverage(gameId, set, [], false);
    const output = await this.runTemplateJob({ kind: 'compile', directory: set.directory });
    if (output.kind !== 'compile') throw new Error('模板编译检查未返回结果');
    return buildTemplateCoverage(gameId, set, output.failed, true);
  }

  /**
   * Only-add merge of legacy template sets (e.g. wanlong-panel's `.wl-data/templates` or `<dataDir>/templates`)
   * into this game's managed library. Sets of another game package are skipped; existing ids are never touched.
   *
   * A set that gains templates is a template change for every instance bound to it, so the import follows the same
   * rule as save / delete (a changed template needs a fresh probe before the next automatic write): a dry run finds
   * the sets that would change, then for each bound instance (in index order) no automation may be running, its
   * auto-resume is switched off, and its device lease is held while the sets are written. Sets copied whole are new
   * and bound to no instance. Change events and lock keys use the canonical (realpath) set folders.
   */
  async importTemplateSets(gameId: string, sourceDir: string): Promise<TemplateImportResult> {
    const plugin = gamePlugin(gameId);
    if (this.disposed) throw new Error('应用正在退出');
    const root = await this.templates.canonicalGameRoot(gameId);
    const setDirectories = (ids: string[]) => Promise.all(ids.map((setId) => canonicalDirectory(join(root, setId))));
    const plan = await this.templates.importSets(gameId, sourceDir, { packageName: plugin.packageName, dryRun: true });
    const bound = await this.instancesBoundTo(gameId, await setDirectories(Object.keys(plan.addedTemplates)));
    for (const i of bound) this.assertTemplateEditable(i);
    const paused: number[] = [];
    const result = await this.withTemplateWriters(gameId, bound, paused, () => this.templates.importSets(gameId, sourceDir, {
      packageName: plugin.packageName,
      log: (level, message) => { if (level === 'warn') console.warn('[wanlong] 模板导入：', message); },
    }));

    const addedIds = Object.keys(result.addedTemplates);
    const added = await setDirectories(addedIds);
    const copied = await setDirectories(Object.keys(result.copiedSets));
    // A set that changed between the dry run and the merge (another writer in between): switch those schedules off too.
    for (const i of (await this.instancesBoundTo(gameId, added)).filter((index) => !bound.includes(index))) {
      await this.withControlLock(i, async () => {
        this.forgetProbe(i);
        if ((await this.scheduler.get(gameId, i)).enabled) { await this.scheduler.disable(gameId, i); paused.push(i); }
      });
    }
    added.forEach((directory, n) => this.emitTemplatesChanged(gameId, directory, 'import', result.addedTemplates[addedIds[n]!] ?? []));
    for (const directory of copied) this.emitTemplatesChanged(gameId, directory, 'import', []);
    return {
      result, sets: await this.templates.managedSets(gameId),
      changedDirectories: [...added, ...copied], pausedSchedules: [...new Set(paused)].sort((a, b) => a - b),
    };
  }

  /** Instances of this game whose template set is one of `directories` (canonical spellings, as the store keeps them). */
  private async instancesBoundTo(gameId: string, directories: readonly string[]): Promise<number[]> {
    if (directories.length === 0) return [];
    const wanted = new Set(directories);
    const bound: number[] = [];
    for (const index of await this.store.indexes(gameId)) {
      const settings = await this.store.get(gameId, index).catch(() => null);
      if (settings?.templateDir && wanted.has(settings.templateDir)) bound.push(index);
    }
    return bound;
  }

  /**
   * Runs `action` as a template write for every instance in `indexes` (ascending, like the account mutations): no
   * automation running, auto-resume off first (recorded in `paused`), the device lease held for the write.
   */
  private withTemplateWriters<T>(gameId: string, indexes: readonly number[], paused: number[], action: () => Promise<T>): Promise<T> {
    const [first, ...rest] = indexes;
    if (first === undefined) return action();
    return this.withControlLock(first, async () => {
      this.assertTemplateEditable(first);
      this.forgetProbe(first);
      if ((await this.scheduler.get(gameId, first)).enabled) {
        await this.scheduler.disable(gameId, first);
        paused.push(first);
      }
      return this.withDeviceLease(first, () => this.withTemplateWriters(gameId, rest, paused, action));
    });
  }

  /**
   * Save into a known set without taking the device lease or touching schedules: for callers that already hold the
   * instance lease (the AI harvest inside a cycle). Same library rules (variance guard, explicit overwrite, atomic
   * writes, per-directory writer) and the same change notification.
   */
  async saveTemplateToSet(gameId: string, directory: string, draft: TemplateDraft): Promise<TemplateSaveResult> {
    gamePlugin(gameId);
    if (this.disposed) throw new Error('应用正在退出');
    const { draft: ready, diffCoverage } = await this.resolveDiffAlpha(draft);
    const result = await this.templates.save(directory, ready);
    this.emitTemplatesChanged(gameId, result.directory, 'save', [result.definition.id]);
    return diffCoverage === undefined ? result : { ...result, diffCoverage };
  }

  /** Subscribe to template-content changes (save / delete / import). Returns the unsubscribe function. */
  onTemplatesChanged(listener: TemplatesChangeListener): () => void {
    return this.templateChanges.on(listener);
  }

  private emitTemplatesChanged(gameId: string, directory: string, reason: TemplatesChange['reason'], templateIds: string[]): void {
    this.templateChanges.emit({ gameId, directory, reason, templateIds, at: Date.now() });
  }

  /** A changed template or policy needs a fresh scene probe before the next automatic write. */
  private forgetProbe(index: number): void {
    this.probeConfirmed.delete(index);
    this.probePasses.delete(index);
    this.probeGenerations.set(index, (this.probeGenerations.get(index) ?? 0) + 1);
  }

  /** Tell every page that an instance's settings changed (another page's badges and drawers reload). */
  private emitSettingsChanged(gameId: string, index: number): void {
    broadcast('automation-settings-changed', { gameId, index, at: Date.now() });
  }

  private assertTemplateEditable(index: number): void {
    if (this.disposed) throw new Error('应用正在退出');
    if (this.activeByIndex.has(index) || this.gatherRunner.isRunning(index)) {
      throw new Error(`实例 #${index} 正在运行自动化，请先停止`);
    }
  }

  private withDeviceLease<T>(index: number, action: () => Promise<T>, label = '修改模板或采集配置'): Promise<T> {
    return withLabelledLease(this.home, index, label, action, { timeoutMs: 200 });
  }

  async saveSettings(gameId: string, index: number, patch: Partial<AutomationSettings>): Promise<AutomationSettings> {
    gamePlugin(gameId);
    const i = asIndex(index);
    return this.withControlLock(i, async () => {
      if (patch && 'config' in patch && gameId === 'wanlong') {
        const config = patch.config;
        if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('自动化参数无效');
        if ('version' in config && config.version !== 2) throw new Error('万龙觉醒配置版本不兼容');
        // Original validateGatherConfig: wrong types and out-of-range values (per-resource overrides included) are
        // refused with Chinese reasons instead of being silently replaced or clamped (the form shows the same issues
        // before saving). What is stored is the normalization of exactly the document that was validated.
        const blocking = describeBlockingIssues(validateGatherConfigInput(config));
        if (blocking) throw new Error(blocking);
        patch = { ...patch, config: normalizeGatherConfig(coerceGatherConfig(config)) as unknown as Record<string, unknown> };
      }
      // A changed template or policy needs a fresh scene probe before the next automatic write.
      if (patch.templateDir !== undefined || patch.config !== undefined) {
        this.forgetProbe(i);
        if ((await this.scheduler.get(gameId, i)).enabled) await this.scheduler.disable(gameId, i);
      }
      this.assertTemplateEditable(i);
      // The config follows the account bound to this AVD (original: the gather page saved into the account's
      // scriptParams); without a current account it stays in the instance's settings file.
      const accountId = patch.config !== undefined && gameId === GATHER_GAME_ID && this.ports.saveAccountGatherConfig
        ? await this.ports.accountIdOf?.(i) ?? null : null;
      // An instance-file config is stamped with the AVD it was saved for (identity awareness of the fallback copy).
      const configFor = !accountId && patch.config !== undefined ? (await this.instanceIdentity(i).catch(() => null))?.createdAt ?? null : null;
      await this.withDeviceLease(i, async () => {
        if (accountId) {
          const { config, ...rest } = patch;
          await this.ports.saveAccountGatherConfig!(accountId, config!);
          // A broken instance file is rebuilt too (template set kept when it still names one): saving from the page
          // is the documented repair, and the account copy is the config in effect anyway.
          const broken = Boolean((await this.store.inspect(gameId, i)).error);
          if (rest.templateDir !== undefined || broken) await this.store.save(gameId, i, broken ? { ...rest, config: {} } : rest);
        } else {
          await this.store.save(gameId, i, patch, { configFor });
        }
      });
      this.emitSettingsChanged(gameId, i);
      return this.settings(gameId, i);
    });
  }

  async restoreSchedules(): Promise<void> {
    await this.scheduler.restore();
  }

  async schedules(): Promise<AutomationSchedule[]> {
    return this.scheduler.list();
  }

  /**
   * The user's schedule switch (IPC). Enabling: busy checks, then the first-enable probe gate (`confirmProbe`), then the
   * ETA scheduler's readiness gate and one read-only sample. ★ Disabling never queues behind an enable that is still
   * probing or cold-starting the game (conventions §6.6): it supersedes it and aborts its sample right away.
   * Resume paths (alerts, bot) call `eta.setAuto(i, true)` directly and skip the probe gate.
   * `probeCapturedAt`: the probe the user just confirmed (enable dialog); a recent pass with that id counts as the gate.
   */
  async setSchedule(gameId: string, index: number, enabled: boolean, opts: { probeCapturedAt?: number } = {}): Promise<AutomationSchedule> {
    if (enabled && this.disposed) throw new Error('应用正在退出');
    gamePlugin(gameId);
    if (gameId !== 'wanlong') throw new Error('该游戏尚未接入自动续跑');
    const i = asIndex(index);
    const request = (this.scheduleRequests.get(i) ?? 0) + 1;
    this.scheduleRequests.set(i, request);
    if (!enabled) return this.scheduler.disable(gameId, i);
    const paused = this.ports.pauseReason?.(i);
    if (paused) throw new Error(`实例 #${i} 因异常被暂停（${paused}），请先处理好现场，再在暂停横幅上点「恢复」`);
    const superseded = () => this.scheduleRequests.get(i) !== request || this.disposed;
    return this.withControlLock(i, async () => {
      if (superseded()) return this.scheduler.get(gameId, i);
      if (this.activeByIndex.has(i) || this.gatherRunner.isRunning(i)) throw new Error(`实例 #${i} 已有自动化任务在运行`);
      // The accounts gate (base instance, login in progress, pending account) refuses before any device read.
      await this.assertReady(gameId, i);
      if (superseded()) return this.scheduler.get(gameId, i);
      await this.confirmProbe(gameId, i, opts?.probeCapturedAt);
      if (superseded()) return this.scheduler.get(gameId, i);
      // Readiness (instance running, template set, config enabled, account) is the ETA scheduler's gate
      // (ensureAutomationReady). The game need not stay in front afterwards (DECISIONS C): samples and cycles
      // cold-start it and every write still passes the probe gate inside the vision worker.
      return this.scheduler.enable(gameId, i);
    });
  }

  /**
   * DECISIONS C「首次启用自动调度仍需只读探针 + 用户确认」, enforced fail-closed here (the renderer adds the
   * confirmation): a pass is remembered for this AVD and template set until a template or policy edit, so re-enabling
   * later may cold-start a game that is not running. The memory is per process: after a restart the probe is due again.
   * A pass the user just confirmed (`probeCapturedAt`, same AVD, same template set, no edit since, ≤ 5 min old) counts
   * as the gate, so enabling does not probe twice and never refuses what the dialog said could be enabled.
   */
  private async confirmProbe(gameId: string, index: number, probeCapturedAt?: number): Promise<void> {
    const [instance, settings] = await Promise.all([this.instanceIdentity(index), this.store.get(gameId, index)]);
    if (!instance) throw new Error(`实例 #${index} 不存在`);
    if (!settings.templateDir) throw new Error('请先选择本地模板集目录');
    const confirmed = this.probeConfirmed.get(index);
    if (confirmed?.createdAt === instance.createdAt && confirmed.templateDir === settings.templateDir) return;
    const pass = this.probePasses.get(index);
    if (probeCapturedAt !== undefined && pass && pass.capturedAt === probeCapturedAt && pass.createdAt === instance.createdAt &&
      pass.templateDir === settings.templateDir && Date.now() - pass.at <= PROBE_PASS_TTL_MS) {
      this.probeConfirmed.set(index, { createdAt: instance.createdAt, templateDir: settings.templateDir });
      return;
    }
    const report = await this.probe(gameId, index);
    if (!report.launchReady) {
      throw new Error(`首次开启自动续跑前需要只读探针通过：${report.launchReason}。请把游戏停在城内或世界地图后重新探测`);
    }
    this.probeConfirmed.set(index, { createdAt: instance.createdAt, templateDir: settings.templateDir });
  }

  async probe(gameId: string, index: number): Promise<AutomationProbeReport> {
    const startedAt = performance.now();
    if (this.disposed) throw new Error('应用正在退出');
    const plugin = gamePlugin(gameId);
    const i = asIndex(index);
    const generation = this.probeGenerations.get(i) ?? 0;
    const manager = await this.host.get();
    const [state, settings] = await Promise.all([manager.getState(i), this.store.get(gameId, i)]);
    if (state.status !== 'running') throw new Error(`实例 #${i} 尚未就绪，请先启动并等待 Android 启动完成`);
    if (!settings.templateDir) throw new Error('请先选择本地模板集目录');
    const device = await manager.device(i);
    const adbStartedAt = performance.now();
    const { frame, foregroundPackage } = await this.onLane(i, async () => {
      const foregroundBefore = await device.foregroundPackage();
      const captured = await device.screencapRaw();
      const after = await device.foregroundPackage();
      if (foregroundBefore !== after) throw new Error('截图时前台应用发生切换，请重新探测');
      return { frame: captured, foregroundPackage: after };
    });
    const adbMs = performance.now() - adbStartedAt;
    if (this.disposed) throw new Error('应用正在退出');
    const workerStartedAt = performance.now();
    const report = await this.runProbeWorker({
      gameId: plugin.id,
      templateDir: settings.templateDir,
      foregroundPackage: foregroundPackage ?? null,
      frame,
    });
    const decision = gameId === 'wanlong' ? inspectGatherProbe(report) : { ok: false as const, reason: '游戏包尚无安全启动条件' };
    if (decision.ok && (this.probeGenerations.get(i) ?? 0) === generation) {
      this.probePasses.set(i, { createdAt: state.record.createdAt, templateDir: settings.templateDir, capturedAt: report.frame.capturedAt, at: Date.now() });
    }
    return {
      gameId: report.gameId,
      packageName: report.packageName,
      foregroundPackage: report.foregroundPackage,
      deviceWidth: report.frame.width,
      deviceHeight: report.frame.height,
      capturedAt: report.frame.capturedAt,
      matches: report.matches.map(({ templateId, found, score, threshold, x, y, w, h, reason }) =>
        ({ templateId, found, score, threshold, x, y, w, h, ...(reason ? { reason } : {}) })),
      launchReady: decision.ok,
      launchReason: decision.ok ? `已确认${decision.scene}画面，匹配分数 ${decision.score.toFixed(3)}` : decision.reason,
      timingsMs: {
        adb: Math.round(adbMs),
        prepare: report.timingMs.prepare,
        match: report.timingMs.match,
        worker: Math.round(performance.now() - workerStartedAt),
        total: Math.round(performance.now() - startedAt),
      },
    };
  }

  /** Start one cycle and return its run record immediately; the result arrives over automation-run. */
  async run(gameId: string, taskId: string, index: number): Promise<AutomationRun> {
    const i = asIndex(index);
    return this.withControlLock(i, async () => {
      if ((await this.scheduler.get(gameId, i)).enabled) throw new Error(`实例 #${i} 已启用自动续跑，请先停止后再手动运行`);
      const { run } = await this.startRun(gameId, taskId, i, 'manual');
      return run;
    });
  }

  /** Serialize policy changes and manual start for one instance across IPC requests. */
  private async withControlLock<T>(index: number, action: () => Promise<T>): Promise<T> {
    const previous = this.controlQueues.get(index) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.controlQueues.set(index, current);
    await previous;
    try { return await action(); }
    finally {
      if (this.controlQueues.get(index) === current) this.controlQueues.delete(index);
      release();
    }
  }

  /**
   * The ETA scheduler's QueueFreeHook: one gather cycle, run inside the scheduler's instance lock. Reports the
   * cycle's facts (and a start-up failure) before throwing, records every dispatch with the scheduler (travel time,
   * coordinate, resource — then one re-sample), and only a failed cycle throws; queueFull / noResourceWanted / giveUp
   * / staminaLow / circuitBroken return normally (not failures; circuitBroken asks for a 10-minute cooldown).
   */
  private async gatherForScheduler(index: number, signal: AbortSignal): Promise<QueueFreeResult> {
    let started: { run: AutomationRun; active: ActiveAutomationRun };
    try {
      started = await this.startRun(GATHER_GAME_ID, 'gather-once', index, 'scheduled', signal);
    } catch (error) {
      if (reportable(error, signal)) await this.reportFact(index, startupFailureFact(messageOf(error), codeOf(error)), 'scheduled');
      throw error;
    }
    let result: GatherRunResult;
    try {
      result = await started.active.result as GatherRunResult;
    } catch (error) {
      await started.active.done;
      if (reportable(error, signal)) await this.reportFact(index, startupFailureFact(messageOf(error), codeOf(error)), 'scheduled');
      throw error;
    }
    // completeCycle has stored the run record and reported the facts and dispatches.
    await started.active.done;
    for (const warning of result.warnings) this.logLine('warn', `[实例 #${index}] ${warning}`);
    for (const record of result.dispatched) {
      if (record.travelTimeSec === null) this.logLine('warn', `[实例 #${index}] 这一趟没读出单程行军耗时，调度器只能用兜底值估 freeAt（会偏保守）。`);
    }
    if (result.dispatched.length > 0) {
      // ★ Record even without a travel time (coordinate + resource are the only way marching rows learn what they
      //   gather) and even when stopped meanwhile: the troops are out either way. The re-sample is skipped on abort.
      await this.eta.noteDispatches(index, result.dispatched.map((record) => ({
        travelTimeMs: record.travelTimeSec === null ? null : record.travelTimeSec * 1000,
        coord: record.coord,
        resourceType: record.resource,
      })), { signal });
    }
    if (result.outcome === 'cancelled') {
      if (signal.aborted) throw abortError(signal, '自动采集已被中止。');
      // Not stopped by the scheduler: the vision job's own timeout ended the cycle. A failure, so it backs off.
      throw new SchedulerError('TIMEOUT', `采集一轮没有在限定时间内完成，已中止：${result.message}`);
    }
    if (result.outcome === 'error') {
      const code = result.error?.code;
      if (code && isAttentionCode(code)) throw new SchedulerError(code, result.message);
      throw new SchedulerError('STEP_FAILED', result.message, { step: result.fact?.step ?? null });
    }
    this.logLine(result.dispatched.length > 0 ? 'info' : 'debug', `[实例 #${index}] 自动采集本轮结束：${result.message}`);
    if (result.outcome === 'circuitBroken') {
      // DECISIONS B: not a failure; look again in 10 minutes (the flow's early return does no device I/O). Health
      // probes keep running meanwhile.
      return { dispatched: result.dispatched.length, notBefore: Date.now() + CIRCUIT_BREAKER_COOLDOWN_MS, reason: '熔断中，10 分钟后复查' };
    }
    // giveUp and the rest follow the original: the scheduler ignores the flow's own wake and backs off (≤ 5 min);
    // the flow's cooldown check returns early without touching the device.
    return { dispatched: result.dispatched.length };
  }

  private async reportFact(index: number, fact: GatherCycleFact, source: 'manual' | 'scheduled'): Promise<void> {
    if (fact.outcome === 'cancelled') return;
    try { await this.hooks.onCycleResult?.(index, fact, source); }
    catch (error) { this.logLine('warn', `[实例 #${index}] 异常检测模块处理本轮结果时出错：${messageOf(error)}`); }
    for (const observer of [...this.observers]) {
      try { await observer.onCycleResult?.(index, fact, source); }
      catch (error) { this.logLine('warn', `[实例 #${index}] 本轮结果的观察者出错：${messageOf(error)}`); }
    }
  }

  private async instanceIdentity(index: number): Promise<{ status: string; createdAt: string } | null> {
    try {
      const state = await (await this.host.get()).getState(index);
      return { status: state.status, createdAt: state.record.createdAt };
    } catch (error) {
      if (codeOf(error) === 'INSTANCE_NOT_FOUND') return null;
      throw error;
    }
  }

  /** Readiness before auto scheduling is enabled (also used by resume paths): instance, templates, config, account. */
  private async ensureAutomationReady(index: number): Promise<void> {
    const instance = await this.instanceIdentity(index);
    if (!instance) throw new Error(`实例 #${index} 不存在`);
    if (instance.status !== 'running') throw new Error(`实例 #${index} 尚未就绪，请先启动并等待 Android 启动完成`);
    const settings = await this.store.get(GATHER_GAME_ID, index);
    if (!settings.templateDir) throw new Error('请先选择本地模板集目录');
    const config = normalizeGatherConfig((await this.gatherConfig(index, settings)) as Parameters<typeof normalizeGatherConfig>[0]);
    if (!config.enabled) throw new Error('请先启用并保存自动采集配置');
    await this.assertReady(GATHER_GAME_ID, index);
  }

  /**
   * The accounts readiness gate (base instance, active login, pending / stale bound account). A refusal throws
   * AUTOMATION_NOT_READY with the Chinese reason: the ETA scheduler pauses a refused scheduled wake without counting a
   * failure; a manual run or an enable shows the reason. Never asked when switching off.
   */
  private async assertReady(gameId: string, index: number): Promise<void> {
    const readiness = await this.hooks.automationReadiness?.(gameId, index);
    if (readiness && !readiness.ready) throw new SchedulerError('AUTOMATION_NOT_READY', readiness.reason || NOT_READY, { instanceIndex: index });
  }

  /**
   * The account's gather config when one is bound (original Account.scriptParams.gather), else the instance's. A
   * corrupt account copy fails the run with its Chinese reason instead of silently using another config.
   */
  private async gatherConfig(index: number, stored: StoredAutomationSettings): Promise<Record<string, unknown>> {
    const fromAccount = await this.ports.accountGatherConfig?.(index);
    if (fromAccount) return fromAccount.config;
    // ★ Never inherited by index alone (docs/APPLICATIONS.md): a config left by a deleted AVD at this index is shown
    //   for review but never run; a gate refusal pauses a scheduled wake without counting a failure.
    if (await this.isConfigReplaced(index, stored)) {
      throw new SchedulerError('AUTOMATION_NOT_READY',
        `实例 #${index} 的采集配置是这个序号上已删除的旧实例留下的，不会按序号沿用。请打开采集配置核对后点「保存」`, { instanceIndex: index });
    }
    return stored.config;
  }

  private async sampleTroopPanel(index: number, request: SampleRequest): Promise<PanelSample> {
    if (!this.gatherRunner.sample) throw new SchedulerError('UNKNOWN', '采集运行器不支持读取部队管理面板');
    const settings = await this.store.get(GATHER_GAME_ID, index);
    if (!settings.templateDir) throw new SchedulerError('TEMPLATE_NOT_FOUND', '请先选择本地模板集目录');
    // Original resolveDevice → assertInstanceAutomationReady: an unready account or a base instance is never driven.
    await this.assertReady(GATHER_GAME_ID, index);
    return this.gatherRunner.sample(index, {
      templateDir: settings.templateDir,
      config: request.config,
      deadlineAt: request.deadlineAt,
      signal: request.signal,
      allowColdStart: request.allowColdStart,
      onFrame: request.onFrame,
      onCaptureFailed: request.onCaptureFailed,
      onUnrecognized: request.onUnrecognized,
      log: request.log,
    });
  }

  private async healthFrame(index: number, signal: AbortSignal): Promise<HealthFrame> {
    if (!this.gatherRunner.healthFrame) throw new SchedulerError('UNKNOWN', '采集运行器不支持健康探针');
    return this.gatherRunner.healthFrame(index, signal);
  }

  /**
   * Whether a frame shows a known screen (world map, city, panels…) with the instance's cached templates
   * (`isRecognizableScreen`). For later modules: AI click verification, freeze recovery waiting for the main screen.
   * A read-only query on the instance's long-lived vision worker: ★ it also works from a hook the running sample or
   * cycle is awaiting (onUnrecognizedFrame, adviseUnknownScreen, probeKicked). No device access, no lock.
   */
  async recognizeScreen(index: number, raw: RawFrame, signal?: AbortSignal): Promise<boolean> {
    const i = asIndex(index);
    const settings = await this.store.get(GATHER_GAME_ID, i);
    if (!settings.templateDir) throw new Error('请先选择本地模板集目录');
    if (!this.gatherRunner.recognize) throw new SchedulerError('UNKNOWN', '采集运行器不支持界面识别');
    return this.gatherRunner.recognize(i, settings.templateDir, raw, signal);
  }

  /**
   * Match UI templates by id on a frame main already holds (the kicked probe on a failure frame, AI checks), with
   * the instance's cached compiled templates. Missing templates answer `found: false` with reason「模板缺失」, so a
   * probe for user-authored templates degrades silently. Same read-only query path as `recognizeScreen`.
   */
  async matchTemplates(index: number, raw: RawFrame, templateIds: string[], options: MatchQueryOptions = {}): Promise<MatchResult[]> {
    const i = asIndex(index);
    const settings = await this.store.get(GATHER_GAME_ID, i);
    if (!settings.templateDir) throw new Error('请先选择本地模板集目录');
    if (!this.gatherRunner.match) throw new SchedulerError('UNKNOWN', '采集运行器不支持模板匹配');
    return this.gatherRunner.match(i, settings.templateDir, raw, templateIds, options);
  }

  /**
   * `matchTemplates` against an explicit template directory (a script run's set) instead of the instance's selected
   * one. Same read-only worker query: no device, no lock. The directory must be absolute.
   */
  async matchTemplatesIn(index: number, templateDir: string, raw: RawFrame, templateIds: string[], options: MatchQueryOptions = {}): Promise<MatchResult[]> {
    const i = asIndex(index);
    if (!templateDir || !isAbsolute(templateDir)) throw new Error('模板集目录必须是绝对路径');
    if (!this.gatherRunner.match) throw new SchedulerError('UNKNOWN', '采集运行器不支持模板匹配');
    return this.gatherRunner.match(i, templateDir, raw, templateIds, options);
  }

  /**
   * Game-update verdict of a frame (the calibrated update prompt's confirm button, the download / check progress
   * texts) from the update crops in `templateDir`, answered by the instance's vision worker. Missing crops answer
   * "no update"; never runs OpenCV in main. For the AI module's update routing.
   */
  async checkGameUpdate(index: number, templateDir: string, raw: RawFrame, signal?: AbortSignal): Promise<{ target: { x: number; y: number } | null; downloading: boolean; progress: boolean }> {
    const i = asIndex(index);
    if (!templateDir || !isAbsolute(templateDir)) throw new Error('模板集目录必须是绝对路径');
    if (!this.gatherRunner.updateCheck) throw new SchedulerError('UNKNOWN', '采集运行器不支持游戏更新识别');
    return this.gatherRunner.updateCheck(i, templateDir, raw, signal);
  }

  /**
   * AI executor frame comparisons on the instance's vision worker (point-sampled grey loops kept off the main thread):
   * the shrink-4 mean absolute difference of two frames. No device, no lock.
   */
  async frameDiff(index: number, a: RawFrame, b: RawFrame, refWidth: number, refHeight: number, signal?: AbortSignal): Promise<number> {
    if (!this.gatherRunner.frameDiff) throw new SchedulerError('UNKNOWN', '采集运行器不支持画面比较');
    return this.gatherRunner.frameDiff(asIndex(index), a, b, refWidth, refHeight, signal);
  }

  /** Same worker query: whether a box (reference coordinates) and its surroundings stayed put between two frames. */
  async targetStable(index: number, a: RawFrame, b: RawFrame, box: { x: number; y: number; w: number; h: number }, refWidth: number, refHeight: number, signal?: AbortSignal): Promise<boolean> {
    if (!this.gatherRunner.targetStable) throw new SchedulerError('UNKNOWN', '采集运行器不支持画面比较');
    return this.gatherRunner.targetStable(asIndex(index), a, b, box, refWidth, refHeight, signal);
  }

  /**
   * The instance identity (`record.createdAt`) the troop-panel sample or gather cycle now running on `index` was
   * admitted with; null when none runs. Hooks acting while that job waits on them (AI recovery) act for this AVD only.
   */
  admittedIdentity(index: number): string | null {
    return this.gatherRunner.admittedIdentity?.(asIndex(index)) ?? null;
  }

  /**
   * Compiled templates are dropped in every vision worker. Template edits through the host already do this (the
   * `onTemplatesChanged` subscription); for writers that bypass it.
   */
  invalidateTemplates(): void {
    this.gatherRunner.invalidateTemplates?.();
  }

  /** A check-then-act device sequence as one unit on the instance's lane (when the composition root gave one). */
  private onLane<T>(index: number, work: () => Promise<T>): Promise<T> {
    return this.deviceLane ? this.deviceLane(index, work) : work();
  }

  private logLine(level: LogLevel, message: string): void {
    if (level === 'error' || level === 'warn') console.warn(`[wanlong] ${message}`);
    else if (level === 'info') console.log(`[wanlong] ${message}`);
    if (level !== 'debug') broadcast('log', { level, message: `[万龙] ${message}`, at: new Date().toISOString() });
  }

  private async startRun(
    gameId: string, taskId: string, index: number, source: 'manual' | 'scheduled', externalSignal?: AbortSignal,
  ): Promise<{ run: AutomationRun; active: ActiveAutomationRun }> {
    if (this.disposed) throw new Error('应用正在退出');
    if (externalSignal?.aborted) throw externalSignal.reason ?? new Error('调度已停止');
    await this.historyReady;
    gamePlugin(gameId);
    const task = gameTask(gameId, taskId);
    if (gameId !== 'wanlong' || task.id !== 'gather-once') throw new Error('该自动化任务尚未接入');
    const i = asIndex(index);
    if (this.activeByIndex.has(i) || this.gatherRunner.isRunning(i)) throw new Error(`实例 #${i} 已有自动化任务在运行`);
    await this.assertReady(gameId, i);

    const manager = await this.host.get();
    const [instance, settings] = await Promise.all([manager.getState(i), this.store.get(gameId, i)]);
    if (instance.status !== 'running') throw new Error(`实例 #${i} 尚未就绪，请先启动并等待 Android 启动完成`);
    if (!settings.templateDir) throw new Error('请先选择本地模板集目录');
    const templateDir = settings.templateDir;
    const config = normalizeGatherConfig((await this.gatherConfig(i, settings)) as Parameters<typeof normalizeGatherConfig>[0]);
    if (!config.enabled) throw new Error('请先启用并保存自动采集配置');
    // ★ No foreground requirement: a game that is not running is cold-started (monkey + look-only wait) by the cycle.
    if (this.disposed) throw new Error('应用正在退出');
    if (externalSignal?.aborted) throw externalSignal.reason ?? new Error('调度已停止');
    // The check and reservation are synchronous after the last await, so two IPC calls cannot claim one device.
    if (this.activeByIndex.has(i) || this.gatherRunner.isRunning(i)) throw new Error(`实例 #${i} 已有自动化任务在运行`);

    const runId = randomUUID();
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort(externalSignal?.reason ?? new Error('调度已停止'));
    externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
    const run: AutomationRun = {
      runId, gameId, taskId, index: i, status: 'running', startedAt: Date.now(), endedAt: null,
      message: source === 'scheduled' ? '自动续跑：正在执行采集一轮' : '正在执行采集一轮', nextWakeAt: null,
    };
    this.activeByIndex.set(i, runId);
    try {
      await this.publishRun(run);
    } catch (error) {
      externalSignal?.removeEventListener('abort', onExternalAbort);
      this.activeByIndex.delete(i);
      this.runHistory.delete(runId);
      throw error;
    }
    const ports = this.ports;
    let shotPolicy: ShotPolicy | undefined;
    try { shotPolicy = this.hooks.shotPolicy?.(); } catch { shotPolicy = undefined; }
    const result = Promise.resolve().then(() => this.gatherRunner.runOnce(i, {
      templateDir,
      config,
      signal: controller.signal,
      allowColdStart: true,
      // Failure scenes follow the app settings' shot policy (original saveAlertShot); the runner still hands every
      // failure frame to the kicked probe whatever the policy.
      ...(shotPolicy ? { shotPolicy } : {}),
      log: (level, message) => this.logLine(level, `[实例 #${i}] ${message}`),
      saveShot: (label, raw) => this.shots.save(i, label, raw),
      ...(ports.probeKicked ? { probeKicked: (raw: RawFrame) => ports.probeKicked!(i, raw) } : {}),
      ...(ports.adviseUnknownScreen
        ? { advise: (raw: RawFrame, attempt: number) => ports.adviseUnknownScreen!(i, raw, attempt, controller.signal) }
        : {}),
    }));
    const done = result
      .then((result) => this.completeCycle(runId, result))
      .catch(async (error: unknown) => {
        const cancelled = controller.signal.aborted;
        try {
          await this.finishRun(runId, cancelled ? 'cancelled' : 'failed', errorMessage(error));
          const terminal = this.runHistory.get(runId);
          if (terminal && !cancelled) await this.hooks.onFailure?.({ ...terminal }, error, source);
        } catch (persistError) {
          console.error('[avdm] 自动化运行记录无法保存', persistError);
        }
      })
      .finally(() => {
        externalSignal?.removeEventListener('abort', onExternalAbort);
        this.activeRuns.delete(runId);
        if (this.activeByIndex.get(i) === runId) this.activeByIndex.delete(i);
      });
    const active: ActiveAutomationRun = { index: i, controller, source, result, done };
    this.activeRuns.set(runId, active);
    return { run: { ...run }, active };
  }

  async stop(runId: string): Promise<void> {
    await this.historyReady;
    const run = this.runHistory.get(runId);
    if (!run) throw new Error('找不到自动化任务');
    if (run.endedAt !== null) return;
    const active = this.activeRuns.get(runId);
    if (!active) return;
    if (active.source === 'scheduled') {
      await this.setSchedule(run.gameId, active.index, false);
      return;
    }
    active.controller.abort(new Error('采集已取消'));
    if (run.status !== 'stopping') {
      try { await this.publishRun({ ...run, status: 'stopping', message: '正在停止采集' }); }
      catch (error) { console.error('[avdm] 自动化停止状态无法保存', error); }
    }
    await this.gatherRunner.stop(active.index);
    await active.done;
  }

  async runs(): Promise<AutomationRun[]> {
    await this.historyReady;
    return [...this.runHistory.values()].sort((a, b) => b.startedAt - a.startedAt).map((run) => ({ ...run }));
  }

  /**
   * Abort in-flight work, then await it (conventions §2.1). ★ Manual cycles hold the same instance lock the scheduler
   * drains, so every cycle is aborted first and the scheduler and runner wind down together; waiting for the scheduler
   * before aborting a manual cycle would hang shutdown until that cycle ended.
   */
  async dispose(): Promise<void> {
    this.disposed = true;
    for (const run of this.activeRuns.values()) run.controller.abort(new Error('助手正在退出'));
    await Promise.allSettled([this.scheduler.dispose(), this.gatherRunner.dispose()]);
    await Promise.allSettled([...this.activeRuns.values()].map((run) => run.done));
    await Promise.allSettled([...this.workers].map((worker) => worker.terminate()));
    this.workers.clear();
    await this.historyReady.catch(() => undefined);
    await this.historyWrite.catch(() => undefined);
  }

  private async completeCycle(runId: string, result: GatherCycleResult): Promise<void> {
    // ★ circuitBroken is a designed stop, not a failure (original alerts iron rule 1); statistics count it apart.
    const status: AutomationRun['status'] = result.outcome === 'cancelled' ? 'cancelled' :
      result.outcome === 'error' ? 'failed' : 'succeeded';
    const run = this.runHistory.get(runId);
    // The Runner has already persisted its state. A future scheduler must durably store a wake
    // before returning it here; without that service, the engine's nextWakeAt is only advice.
    const scheduledWakeAt = run && this.cycleSink ? await this.cycleSink({ ...run }, result) : null;
    if (scheduledWakeAt !== null && (!Number.isFinite(scheduledWakeAt) || scheduledWakeAt < 0)) {
      throw new Error('自动化唤醒时间无效');
    }
    await this.finishRun(runId, status, result.message, scheduledWakeAt);
    const terminal = this.runHistory.get(runId);
    const active = this.activeRuns.get(runId);
    if (!terminal || !active) return;
    const { source, index } = active;
    const fact = (result as Partial<GatherRunResult>).fact ?? cycleFactOf(result, { shotPath: null, kicked: null });
    // ★ Facts go out before a failed scheduled cycle throws (gatherForScheduler awaits this `done`).
    await this.reportFact(index, fact, source);
    if (result.dispatched.length > 0) {
      const dispatchedAt = Date.now();
      try { await this.hooks.onDispatched?.(index, result.dispatched, dispatchedAt); }
      catch (error) { this.logLine('warn', `[实例 #${index}] 派兵统计无法保存：${messageOf(error)}`); }
      for (const observer of [...this.observers]) {
        try { await observer.onDispatched?.(index, result.dispatched, dispatchedAt); }
        catch (error) { this.logLine('warn', `[实例 #${index}] 派兵统计无法保存：${messageOf(error)}`); }
      }
      if (source === 'manual') {
        // A manual cycle still teaches the queue view what the new marches gather; the next sample reads the timers.
        await this.eta.noteDispatches(index, result.dispatched.map((record) => ({
          travelTimeMs: record.travelTimeSec === null ? null : record.travelTimeSec * 1000,
          coord: record.coord,
          resourceType: record.resource,
        })), { resample: false }).catch((error: unknown) =>
          this.logLine('warn', `[实例 #${index}] 派兵记账失败：${messageOf(error)}`));
      }
    }
    try { await this.hooks.onCycle?.({ ...terminal }, result, source); }
    catch (error) { console.error('[avdm] 采集统计无法保存', error); }
  }

  private async finishRun(runId: string, status: AutomationRun['status'], message: string, nextWakeAt: number | null = null): Promise<void> {
    const run = this.runHistory.get(runId);
    if (!run) return;
    await this.publishRun({ ...run, status, endedAt: Date.now(), message, nextWakeAt });
  }

  private async publishRun(run: AutomationRun): Promise<void> {
    this.runHistory.set(run.runId, run);
    this.trimHistory();
    await this.persistHistory();
    broadcast('automation-run', { ...run });
  }

  private trimHistory(): void {
    while (this.runHistory.size > MAX_RUN_HISTORY) {
      const old = [...this.runHistory].find(([, run]) => run.endedAt !== null);
      if (!old) break;
      this.runHistory.delete(old[0]);
    }
  }

  private async loadHistory(): Promise<void> {
    let value: unknown;
    try {
      const size = (await stat(this.historyFile)).size;
      if (size > MAX_RUN_HISTORY_BYTES) throw new Error('自动化运行记录超过 256 KB');
      value = JSON.parse(await readFile(this.historyFile, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new Error(`自动化运行记录无法读取：${this.historyFile}`, { cause: error });
    }
    if (!isRecord(value) || value['version'] !== RUN_HISTORY_VERSION || !Array.isArray(value['runs']) ||
      value['runs'].length > MAX_RUN_HISTORY || !value['runs'].every(isRun)) {
      throw new Error(`自动化运行记录格式不兼容：${this.historyFile}`);
    }
    let recovered = false;
    for (const stored of value['runs'] as AutomationRun[]) {
      const interrupted = stored.endedAt === null || stored.status === 'running' || stored.status === 'stopping';
      const run = interrupted ? {
        ...stored, status: 'failed' as const, endedAt: Date.now(), nextWakeAt: null,
        message: '上次运行因应用退出或中断而结束',
      } : stored;
      this.runHistory.set(run.runId, run);
      recovered ||= interrupted;
    }
    if (recovered) await this.persistHistory();
  }

  private persistHistory(): Promise<void> {
    const json = JSON.stringify({ version: RUN_HISTORY_VERSION, runs: [...this.runHistory.values()] }, null, 2) + '\n';
    if (Buffer.byteLength(json) > MAX_RUN_HISTORY_BYTES) return Promise.reject(new Error('自动化运行记录超过 256 KB'));
    const previous = this.historyWrite;
    const next = previous.catch(() => undefined).then(() => this.writePrivateHistory(json));
    this.historyWrite = next;
    return next;
  }

  private async writePrivateHistory(json: string): Promise<void> {
    await mkdir(dirname(this.historyFile), { recursive: true, mode: 0o700 });
    const temp = `${this.historyFile}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temp, 'wx', 0o600);
      try { await handle.writeFile(json); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temp, this.historyFile);
      await chmod(this.historyFile, 0o600);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private runProbeWorker(input: ProbeWorkerInput): Promise<import('@avdm/automation').ProbeReport> {
    // electron-vite emits this sibling entry for both dev and packaged builds.
    const entry = join(dirname(fileURLToPath(import.meta.url)), 'probe-worker.js');
    const worker = new Worker(entry);
    this.workers.add(worker);
    // A screencap may be a view into a larger Buffer. Copy exactly the pixels once,
    // then transfer ownership so the main process need not clone a multi-MB frame again.
    const pixels = Uint8Array.from(input.frame.data);
    const transferred: RawFrame = { ...input.frame, data: pixels };
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error, report?: import('@avdm/automation').ProbeReport) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.workers.delete(worker);
        void worker.terminate();
        if (error) reject(error);
        else if (report) resolve(report);
        else reject(new Error('图像识别未返回结果'));
      };
      const timer = setTimeout(() => finish(new Error('图像识别超时')), PROBE_TIMEOUT_MS);
      worker.once('message', (result: ProbeWorkerOutput) => {
        if (result.ok) finish(undefined, result.report);
        else finish(new Error(result.error));
      });
      worker.once('error', (error) => finish(error));
      worker.once('exit', (code) => finish(new Error(`图像识别工作线程已退出 (${code})`)));
      worker.postMessage({ ...input, frame: transferred } satisfies ProbeWorkerInput, [pixels.buffer]);
    });
  }

  /**
   * One template job in a fresh worker (match test, full compile check, 透明底 preview or a save's diff mask);
   * a failure keeps its error code. `templateJobRunner` replaces the worker in tests.
   */
  private runTemplateJob(job: TemplateJob): Promise<Extract<TemplateJobOutput, { ok: true }>> {
    if (this.disposed) return Promise.reject(new Error('应用正在退出'));
    if (this.templateJobRunner) {
      return this.templateJobRunner(job).then((output) => {
        if (output.ok) return output;
        throw workerError(output.error);
      });
    }
    const entry = join(dirname(fileURLToPath(import.meta.url)), 'template-test-worker.js');
    const worker = new Worker(entry);
    this.workers.add(worker);
    const { message, transfer } = transferableJob(job);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error, output?: Extract<TemplateJobOutput, { ok: true }>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.workers.delete(worker);
        void worker.terminate();
        if (error) reject(error);
        else if (output) resolve(output);
        else reject(new Error('模板任务未返回结果'));
      };
      const timer = setTimeout(() => finish(new Error(TEMPLATE_JOB_TIMEOUT_MESSAGES[job.kind])), PROBE_TIMEOUT_MS);
      worker.once('message', (output: TemplateJobOutput) => {
        if (output.ok) finish(undefined, output);
        else finish(workerError(output.error));
      });
      worker.once('error', (error) => finish(error));
      worker.once('exit', (code) => finish(new Error(`模板工作线程已退出 (${code})`)));
      worker.postMessage(message, transfer);
    });
  }
}
