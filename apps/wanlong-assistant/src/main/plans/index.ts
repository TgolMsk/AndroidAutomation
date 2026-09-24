import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { withFileLock } from '@avdm/core';
import { ExecutionGuardError, loadTemplateSet } from '@avdm/automation';
import {
  blockingIssues, mergeParams, referencedTemplateIds, SHOT_POLICIES, startsWithLaunch,
  type ScriptParamValue, type ShotPolicy,
} from '@avdm/automation/script';
import {
  comparePlanRows, defaultPlanConfig, dueReason, lastRunAtOf, nextFireAt, PLAN_ACCOUNT_RE,
  type PlanQueueEntry, type PlanQueueView, type PlanRunOrigin, type PlanTaskPhase, type PlanTaskState, type TaskRuntime,
} from '../../shared/plan';
import { withLabelledLease } from '../app/instance-access';
import { gamePlugin } from '../automation/games';
import type { GameAccount } from '../automation/accounts/types';
import { safeErrorMessage } from './device-errors';
import { readImeStatus, setupIme } from './ime';
import { assertRunId, KEEP_RUNS } from './run-logs';
import { ScriptRunner } from './script-runner';
import { ScriptStore, validateScript } from './scripts';
import { PlanStore, type PlanData } from './store';
import { SCRIPT_RUN_PRIORITIES } from './types';
import type {
  AccountPlan, ImeStatus, LogEntry, PlanConfig, PlanHostPort, PlanOverview, PlanRun, PlanTask, RunLogQuery, ScriptDef, ScriptIssue,
  ScriptMatchDefaults, ScriptMeta, ScriptRunOptions, ScriptRunSnapshot,
} from './types';

export type { AccountPlan, PlanConfig, PlanOverview, PlanRun, PlanTask, ScriptDef, ScriptMeta, TaskTrigger } from './types';
export { defaultPlanConfig } from './store';
export { ScriptRunner } from './script-runner';

interface Waiting { run: PlanRun; deadline: number }
interface Active {
  run: PlanRun;
  deadline: number;
  controller: AbortController;
  done: Promise<void>;
  /** The instance lease is held. Until then the round still shows as 排队中 (it may be waiting for the lease). */
  leased: boolean;
  /** Set when a switch took the round back before it held the lease: its claim is released like a dequeued one. */
  releaseClaim?: boolean;
}
interface Manual { runId: string; gameId: string; controller: AbortController; done: Promise<void> }
interface Lease { release(): Promise<void> }

/** Per-task state that lives only in the owning process (phases, holds, retries). */
interface LiveTask {
  /** Outcome of the last round in this session; null = derive it from the persisted `lastResult`. */
  phase: PlanTaskPhase | null;
  /** A failure retry is held until then (shown in 「下次运行」). */
  holdUntil: number | null;
  retryLeft: number;
  retryTimer: NodeJS.Timeout | null;
  /** Origin of the round a pending retry belongs to (the total switch only drops scheduled ones). */
  retryOrigin: PlanRunOrigin;
}

/** Default global cap of concurrent script runs (original MAX_CONCURRENT_INSTANCES); gather rounds do not count. */
export const DEFAULT_MAX_CONCURRENT_SCRIPTS = 4;
/** A plan run deferred by the global cap is tried again after this delay (back-off, never a failure; original). */
export const BUSY_RETRY_MS = 15_000;
/** The planner re-evaluates at least this often (instances booting, queue deadlines; original MAX_SLEEP_MS). */
const MAX_SLEEP_MS = 60_000;
const MIN_SLEEP_MS = 1_000;
/**
 * Shortest failure-retry delay (original MIN_RETRY_DELAY_MS): the attempt must be off the queue before its retry
 * comes back, or the retry would be dropped as a duplicate.
 */
const MIN_RETRY_DELAY_MS = 200;
const PUBLISH_DELAY_MS = 50;
/** Manual runs: default and maximum whole-run limit. */
const MANUAL_DEFAULT_MINUTES = 60;
const MANUAL_MAX_MINUTES = 720;
/**
 * A manual run waits this long for the instance lease: after the gather scheduler yielded, the lock may still be
 * draining an aborted step (≤ 5 s) or a short exclusive action (screenshot, resource read). Longer holders (login
 * wizard, another assistant process) still get a clear refusal.
 */
const MANUAL_LEASE_WAIT_MS = 20_000;
/** The IME install is a quick device write: it never waits for the instance. */
const IME_LEASE_WAIT_MS = 200;
/**
 * A plan run waits for the instance lease in slices this long: core's file lock takes no AbortSignal, so the run's
 * signal (停止 / 删除 / quitting) is checked between slices and a stop never waits out the whole queue budget.
 */
const LEASE_POLL_MS = 250;
const MAX_PARAMS = 50;
const PARAM_KEY = /^[A-Za-z0-9_.-]{1,64}$/;
const TASK_GONE = '找不到这条任务，面板可能不是最新的，刷新一下再试。';

/**
 * 「现在没法跑」 rather than 「脚本没跑通」 (original SKIP_CODES, mapped to @avdm/core codes): the round is skipped —
 * no retry, no failure count. Only errors raised before the script touched the device are classified this way.
 */
const SKIP_CODES = new Set(['INSTANCE_NOT_FOUND', 'INSTANCE_NOT_RUNNING', 'BOOT_TIMEOUT', 'ADMISSION_DENIED', 'ADB_MISSING', 'LOCK_TIMEOUT', 'COMMAND_FAILED']);

/** How a plan run ended when it did not succeed, and whether a failure may be retried. */
class PlanOutcome extends Error {
  constructor(message: string, readonly status: 'failed' | 'skipped' | 'cancelled', readonly retryable = false) {
    super(message);
    this.name = 'PlanOutcome';
  }
}

export interface PlanServiceOptions {
  /** Milliseconds per 「分钟」 of a task's time limit. Tests shrink it; production keeps 60 000. */
  minuteMs?: number;
  /** Back-off of a run deferred by the global script cap (default 15 s). */
  busyRetryMs?: number;
  /** Wall clock of the planner (tests move it; timers still use real time). */
  now?: () => number;
  /** How long a manual run waits for the instance lease (default 20 s; tests shrink it). */
  manualLeaseWaitMs?: number;
}

const liveKey = (gameId: string, accountId: string, taskId: string): string => `${gameId}\n${accountId}\n${taskId}`;

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Settles like `work`, or rejects with the abort reason as soon as `signal` aborts. A value that arrives after the
 * abort goes to `late` (e.g. giving back a scheduler hold nobody will use any more).
 */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal, late: (value: T) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      reject(signal.reason);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    work.then((value) => {
      signal.removeEventListener('abort', onAbort);
      if (settled) { late(value); return; }
      settled = true;
      resolve(value);
    }, (error: unknown) => {
      signal.removeEventListener('abort', onAbort);
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

function checkedRunOptions(options: ScriptRunOptions | undefined): Required<Pick<ScriptRunOptions, 'maxRunMinutes'>> & ScriptRunOptions {
  const value = options ?? {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('运行选项无效');
  if (value.accountId !== undefined && (typeof value.accountId !== 'string' || !PLAN_ACCOUNT_RE.test(value.accountId))) throw new Error('账号 ID 无效');
  if (value.shotPolicy !== undefined && !SHOT_POLICIES.includes(value.shotPolicy)) throw new Error('截图留痕策略无效');
  if (value.priority !== undefined && !SCRIPT_RUN_PRIORITIES.includes(value.priority)) throw new Error('执行优先级无效');
  const minutes = value.maxRunMinutes ?? MANUAL_DEFAULT_MINUTES;
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > MANUAL_MAX_MINUTES) throw new Error(`运行时长上限应为 0–${MANUAL_MAX_MINUTES} 分钟（0 表示不限）`);
  if (value.params !== undefined) {
    if (!value.params || typeof value.params !== 'object' || Array.isArray(value.params) || Object.keys(value.params).length > MAX_PARAMS) throw new Error('脚本参数无效');
    for (const [key, param] of Object.entries(value.params)) {
      if (!PARAM_KEY.test(key) || !(typeof param === 'boolean' || (typeof param === 'number' && Number.isFinite(param)) ||
        (typeof param === 'string' && param.length <= 2048))) throw new Error(`脚本参数 ${key} 无效`);
    }
  }
  return { ...value, maxRunMinutes: minutes };
}

/** Why this account cannot run plan tasks now, or null. */
function accountIssueOf(account: GameAccount | undefined, packageName: string): string | null {
  if (!account) return '账号已删除';
  if (account.packageName !== packageName) return '账号不属于当前游戏';
  if (!account.binding) return '未绑定实例';
  if (!account.enabled) return '账号已停用';
  if (account.login.status !== 'ready') return '尚未完成登录验证';
  return null;
}

/** The phase a persisted last result stands for (a cancelled round is not a result: waiting again). */
function phaseOfResult(result: TaskRuntime['lastResult'] | undefined): PlanTaskPhase {
  switch (result) {
    case 'succeeded': return 'done';
    case 'failed': return 'failed';
    case 'skipped': return 'skipped';
    default: return 'idle';
  }
}

/**
 * Game-scoped task plans, the script library and manual runs.
 *
 * The planner only orchestrates (original `src/main/plan/index.ts`): due → per-instance queue → ★ the gather
 * scheduler yields (`suspendForScript`) → instance lease → the ScriptRunner runs the script in a worker thread →
 * bookkeeping → next. One AVD receives one writer at a time across processes (the instance lease); a failure retry
 * releases the instance and queues again later, so gathering and other tasks get their turn in between.
 */
export class PlanService {
  readonly store: PlanStore;
  readonly scripts: ScriptStore;
  readonly runner: ScriptRunner;
  private readonly queues = new Map<number, Waiting[]>();
  private readonly active = new Map<number, Active>();
  private readonly manual = new Map<number, Manual>();
  private readonly live = new Map<string, LiveTask>();
  private readonly games = new Set<string>();
  private readonly contendedGames = new Set<string>();
  private readonly ownerLeases = new Map<string, Lease>();
  private readonly ticking = new Set<string>();
  private readonly tickAgain = new Set<string>();
  private readonly tickTimers = new Map<string, NodeJS.Timeout>();
  private readonly publishTimers = new Map<string, NodeJS.Timeout>();
  private readonly caps = new Map<string, number>();
  private readonly capRetries = new Map<number, NodeJS.Timeout>();
  private readonly accountCache = new Map<string, GameAccount[]>();
  private readonly scriptCache = new Map<string, ScriptMeta[]>();
  private readonly minuteMs: number;
  private readonly busyRetryMs: number;
  private readonly now: () => number;
  private readonly manualLeaseWaitMs: number;
  private closing = false;

  constructor(private readonly home: string, private readonly port: PlanHostPort, runner?: ScriptRunner, options: PlanServiceOptions = {}) {
    if (!path.isAbsolute(home)) throw new Error('计划根目录必须是绝对路径');
    this.store = new PlanStore(home);
    this.scripts = new ScriptStore(home);
    this.runner = runner ?? new ScriptRunner(home, { instance: (index) => port.instance(index), device: (index) => port.device(index) });
    this.minuteMs = options.minuteMs ?? 60_000;
    this.busyRetryMs = options.busyRetryMs ?? BUSY_RETRY_MS;
    this.now = options.now ?? Date.now;
    this.manualLeaseWaitMs = options.manualLeaseWaitMs ?? MANUAL_LEASE_WAIT_MS;
  }

  async start(gameId: string): Promise<void> {
    gamePlugin(gameId);
    if (this.games.has(gameId)) return;
    // Only one Assistant process owns the timed scheduler. The device lease below separately guards input.
    const pathToLease = path.join(this.home, 'automation', 'games', gameId, 'scheduler.lock');
    let entered!: () => void;
    let exit!: () => void;
    const acquired = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { exit = resolve; });
    const lockDone = withFileLock(pathToLease, async () => { entered(); await held; }, { timeoutMs: 150 });
    const winner = await Promise.race([acquired.then(() => true), lockDone.then(() => false, () => false)]);
    if (!winner) { this.contendedGames.add(gameId); return; }
    const lease = { release: async () => { exit(); await lockDone; } };
    this.ownerLeases.set(gameId, lease);
    try {
      // Also repairs a damaged plans.json (tolerant load; the broken original is backed up next to it).
      await this.store.recoverInterrupted(gameId);
      this.games.add(gameId);
      // Run directories are kept to the newest 200 (the original never pruned; the disk grew without bound).
      void this.runner.logs.prune(gameId, KEEP_RUNS, this.liveRunIds()).catch((error: unknown) => console.error('[plan] 清理旧运行记录失败', error));
      const data = await this.store.overview(gameId);
      const tasks = data.plans.reduce((n, plan) => n + plan.tasks.length, 0);
      console.info(`[plan] 任务计划已加载：${data.plans.length} 个账号、${tasks} 条任务，总开关${data.config.enabled ? '已开启' : '未开启'}。`);
      await this.tick(gameId);
    } catch (error) {
      this.games.delete(gameId);
      this.ownerLeases.delete(gameId);
      await lease.release();
      throw error;
    }
  }

  // ── Queries ──────────────────────────────────────────────────────────────

  /** The plan table, runtime and history plus the flattened rows and queues the page shows. */
  async overview(gameId: string): Promise<PlanOverview> {
    gamePlugin(gameId);
    const data = await this.store.overview(gameId);
    this.caps.set(gameId, data.config.maxConcurrentScripts);
    const [accounts, scripts] = await Promise.all([this.accountsOf(gameId), this.scriptsOf(gameId)]);
    const now = this.now();
    return {
      gameId, config: data.config, plans: data.plans, runtime: data.runtime, runs: data.runs,
      tasks: this.taskStates(gameId, data, accounts, scripts, now), queues: this.queueViews(gameId),
      warnings: this.store.warnings(gameId), contended: this.contendedGames.has(gameId), at: now,
    };
  }

  async config(gameId: string): Promise<PlanConfig> {
    gamePlugin(gameId);
    return (await this.store.overview(gameId)).config;
  }

  /**
   * The plan config's 「脚本执行期间允许 AI 介入」 (default on). The AI module reads it for script consults; the
   * runner also skips the consult for runs started with it off.
   */
  async aiAssistEnabled(gameId: string): Promise<boolean> {
    try { return (await this.config(gameId)).aiAssist; } catch { return defaultPlanConfig().aiAssist; }
  }

  /** One account's plan (an empty, disabled one when it has none; original plan:get). */
  async getPlan(gameId: string, accountId: string): Promise<AccountPlan> {
    gamePlugin(gameId);
    return await this.store.getPlan(gameId, accountId) ?? { accountId, enabled: false, tasks: [], updatedAt: 0 };
  }

  /** Queued, running or manual script work on this instance (monitoring / gather / update busy checks). */
  isActiveForInstance(index: number): boolean {
    return this.active.has(index) || this.manual.has(index) || (this.queues.get(index)?.length ?? 0) > 0 || this.runner.runIdOfInstance(index) !== null;
  }

  /** The script run holding this instance right now (admitted or executing), for the scheduler to yield. */
  runIdOfInstance(index: number): string | null {
    return this.active.get(index)?.run.runId ?? this.manual.get(index)?.runId ?? this.runner.runIdOfInstance(index);
  }

  async hasEnabledPlanForInstance(gameId: string, index: number): Promise<boolean> {
    const data = await this.store.overview(gameId);
    if (!data.config.enabled) return false;
    const accounts = new Map((await this.port.accounts(gameId)).map((account) => [account.id, account]));
    return data.plans.some((plan) => plan.enabled && plan.tasks.some((task) => task.enabled && task.trigger.kind !== 'manual') &&
      accounts.get(plan.accountId)?.enabled && accounts.get(plan.accountId)?.binding?.index === index);
  }

  // ── Script library ───────────────────────────────────────────────────────

  listScripts(gameId: string): Promise<ScriptMeta[]> { return this.scripts.list(gameId, gamePlugin(gameId).packageName); }
  getScript(gameId: string, id: string): Promise<ScriptDef> { return this.scripts.get(gameId, id, gamePlugin(gameId).packageName); }

  /** Static checks; with an instance, also against that instance's template set (ids and reference canvas). */
  async validateScript(gameId: string, raw: unknown, index?: number | null): Promise<ScriptIssue[]> {
    const pkg = gamePlugin(gameId).packageName;
    if (index === undefined || index === null) return validateScript(raw, pkg);
    const dir = await this.port.templateDir(gameId, index);
    if (!dir) return validateScript(raw, pkg);
    try {
      const set = await loadTemplateSet(dir);
      return validateScript(raw, pkg, set.templates.map((t) => t.id), { templateRef: { width: set.refWidth, height: set.refHeight } });
    } catch (error) {
      return [...validateScript(raw, pkg), { level: 'warn', stepId: null, message: `无法读取实例 #${index} 的模板集，跳过模板检查：${error instanceof Error ? error.message : String(error)}` }];
    }
  }

  async saveScript(gameId: string, raw: unknown): Promise<ScriptMeta> {
    const plugin = gamePlugin(gameId);
    const saved = await this.scripts.save(gameId, plugin.packageName, raw);
    this.scriptCache.delete(gameId);
    this.publish(gameId);
    return saved;
  }

  async deleteScript(gameId: string, id: string): Promise<void> {
    gamePlugin(gameId);
    const data = await this.store.overview(gameId);
    if (data.plans.some((plan) => plan.tasks.some((task) => task.scriptId === id))) {
      throw new Error('脚本仍被计划引用，请先移除对应任务');
    }
    await this.scripts.remove(gameId, id);
    this.scriptCache.delete(gameId);
    this.publish(gameId);
  }

  // ── Plan edits ───────────────────────────────────────────────────────────

  /** Whole-plan overwrite (the task dialog). Queued rounds of removed or switched-off tasks leave the queue. */
  async savePlan(gameId: string, plan: AccountPlan): Promise<AccountPlan> {
    gamePlugin(gameId);
    const account = (await this.port.accounts(gameId)).find((a) => a.id === plan.accountId);
    if (!account) throw new Error('账号不存在或不属于当前游戏');
    const available = new Set((await this.listScripts(gameId)).filter((s) => s.version !== '0').map((s) => s.id));
    for (const task of plan.tasks ?? []) if (!available.has(task.scriptId)) throw new Error(`脚本 ${task.scriptId} 不存在或无法读取`);
    const saved = await this.store.savePlan(gameId, plan);
    const alive = new Map(saved.tasks.map((task) => [task.id, task]));
    await this.dropWaiting(gameId, (run) => run.accountId === saved.accountId && !alive.has(run.taskId), '任务已从计划中删除，排队取消');
    await this.dropWaiting(gameId, (run) => run.accountId === saved.accountId && (run.origin ?? 'schedule') === 'schedule' &&
      (!saved.enabled || alive.get(run.taskId)?.enabled === false), '任务已关闭，排队取消');
    for (const [key, live] of this.live) {
      const [game, accountId, taskId] = key.split('\n');
      if (game !== gameId || accountId !== saved.accountId) continue;
      const task = alive.get(taskId!);
      if (!task) { this.clearRetry(live); this.live.delete(key); }
      else if (live.retryOrigin === 'schedule' && (!saved.enabled || !task.enabled)) this.clearRetry(live);
    }
    this.requestTick(gameId);
    this.publish(gameId);
    return saved;
  }

  /** The row's checkbox (original plan:setTaskEnabled). Off: its queued round leaves the queue at once. */
  async setTaskEnabled(gameId: string, accountId: string, taskId: string, enabled: boolean): Promise<PlanOverview> {
    gamePlugin(gameId);
    await this.store.setTaskEnabled(gameId, accountId, taskId, enabled);
    if (!enabled) {
      await this.dropWaiting(gameId, (run) => run.accountId === accountId && run.taskId === taskId, '任务已关闭，排队取消');
      const live = this.live.get(liveKey(gameId, accountId, taskId));
      if (live) this.clearRetry(live);
    }
    this.requestTick(gameId);
    return this.overview(gameId);
  }

  /** The account switch (original plan:setAccountEnabled; creates the plan when missing). Off: dequeue all its tasks. */
  async setAccountEnabled(gameId: string, accountId: string, enabled: boolean): Promise<PlanOverview> {
    gamePlugin(gameId);
    if (!(await this.port.accounts(gameId)).some((account) => account.id === accountId) && !(await this.store.getPlan(gameId, accountId))) {
      throw new Error('账号不存在或不属于当前游戏');
    }
    await this.store.setAccountEnabled(gameId, accountId, enabled);
    if (!enabled) {
      await this.dropWaiting(gameId, (run) => run.accountId === accountId, '账号计划已关闭，排队取消');
      for (const [key, live] of this.live) if (key.startsWith(`${gameId}\n${accountId}\n`)) this.clearRetry(live);
    }
    this.requestTick(gameId);
    return this.overview(gameId);
  }

  /**
   * Deletes one task (the row's delete button). Works for a plan whose account was deleted too: its plan entry
   * goes once no task is left. A queued round leaves the queue; a running one is stopped first.
   */
  async removeTask(gameId: string, accountId: string, taskId: string): Promise<PlanOverview> {
    gamePlugin(gameId);
    await this.cancelTask(gameId, accountId, taskId, '任务已删除');
    const accountGone = !(await this.port.accounts(gameId)).some((account) => account.id === accountId);
    await this.store.removeTask(gameId, accountId, taskId, accountGone);
    this.live.delete(liveKey(gameId, accountId, taskId));
    this.publish(gameId);
    return this.overview(gameId);
  }

  async saveConfig(gameId: string, patch: Partial<PlanConfig>): Promise<PlanConfig> {
    gamePlugin(gameId);
    const config = await this.store.saveConfig(gameId, patch);
    this.caps.set(gameId, config.maxConcurrentScripts);
    if (!config.enabled) {
      // The total switch off leaves only manual runs (original): scheduled rounds and their retries go.
      await this.dropWaiting(gameId, (run) => (run.origin ?? 'schedule') === 'schedule', '计划总开关已关闭，排队取消');
      for (const [key, live] of this.live) if (key.startsWith(`${gameId}\n`) && live.retryOrigin === 'schedule') this.clearRetry(live);
    }
    try { this.port.onConfigChanged?.({ gameId, config: structuredClone(config) }); } catch { /* Observers cannot break saving. */ }
    this.requestTick(gameId);
    this.pumpAll();
    this.publish(gameId);
    return config;
  }

  /**
   * 「立即运行」: ignores the trigger and every switch but still goes through the instance queue and preemption
   * (never straight to the device). A task already queued or running is refused with a clear message.
   */
  async runNow(gameId: string, accountId: string, taskId: string): Promise<PlanRun> {
    if (this.contendedGames.has(gameId)) throw new Error('另一个万龙助手进程正管理脚本计划，请在主窗口执行');
    if (this.closing) throw new Error('助手正在退出，不能启动新的脚本');
    const plugin = gamePlugin(gameId);
    const data = await this.store.overview(gameId);
    const task = data.plans.find((p) => p.accountId === accountId)?.tasks.find((t) => t.id === taskId);
    if (!task) throw new Error(TASK_GONE);
    const account = (await this.port.accounts(gameId)).find((a) => a.id === accountId);
    if (!account) throw new Error('这条计划挂的账号已经不存在了，请先把它删掉。');
    if (!account.binding) throw new Error(`账号「${account.name}」还没绑定实例，没法跑脚本。请先在「账号管理」里绑定实例。`);
    if (account.packageName !== plugin.packageName) throw new Error('账号对应的游戏包名不一致');
    if (!account.enabled) throw new Error(`账号「${account.name}」已停用，请先在「账号管理」里启用。`);
    if (account.login.status !== 'ready') throw new Error(`账号「${account.name}」还没完成登录验证，请先在「账号管理」里登录。`);
    if (this.queuedOrActive(gameId, accountId, taskId)) throw new Error('这条任务已经在队列里了，不用重复点。');
    const run = { ...this.newRun(gameId, account, task, 'manual', 1, '手动立即运行，等待实例空闲'), reason: '手动立即运行' };
    await this.store.addRun(gameId, run);
    // Re-checked after the await: two clicks can never queue the task twice.
    if (this.queuedOrActive(gameId, accountId, taskId)) {
      await this.finish(run, 'cancelled', '同一任务已在队列里');
      throw new Error('这条任务已经在队列里了，不用重复点。');
    }
    const live = this.liveOf(gameId, accountId, taskId);
    this.clearRetry(live);
    live.retryLeft = data.config.retry;
    live.retryOrigin = 'manual';
    this.enqueue(run, data.config);
    return run;
  }

  /** Cancel by task (a table row): a queued round leaves the queue, a running one is stopped, a pending retry is dropped. */
  async cancelTask(gameId: string, accountId: string, taskId: string, reason = '用户停止脚本'): Promise<PlanOverview> {
    gamePlugin(gameId);
    const live = this.live.get(liveKey(gameId, accountId, taskId));
    if (live) this.clearRetry(live);
    await this.dropWaiting(gameId, (run) => run.accountId === accountId && run.taskId === taskId,
      reason === '用户停止脚本' ? '用户取消排队' : reason, false);
    for (const item of this.active.values()) {
      if (item.run.gameId === gameId && item.run.accountId === accountId && item.run.taskId === taskId) {
        item.controller.abort(new Error(reason));
        await item.done;
      }
    }
    this.publish(gameId);
    return this.overview(gameId);
  }

  // ── Manual runs, monitor, input method ───────────────────────────────────

  /**
   * Run any script on one instance right now (authoring / testing; original run:start). An account is optional:
   * when given, it must be bound to this instance and logged in, and its script params apply.
   */
  async runScript(gameId: string, index: number, scriptId: string, rawOptions?: ScriptRunOptions): Promise<ScriptRunSnapshot> {
    if (this.closing) throw new Error('助手正在退出，不能启动新的脚本');
    const plugin = gamePlugin(gameId);
    const options = checkedRunOptions(rawOptions);
    const config = await this.config(gameId);
    this.caps.set(gameId, config.maxConcurrentScripts);
    // Admission is synchronous after the last await: two requests can never claim one instance. A plan task only
    // waiting in this instance's queue does not block a manual run (highest priority): it waits behind it.
    if (this.runIdOfInstance(index) !== null) throw new Error(`实例 #${index} 上已有脚本在运行，请先停止后再试`);
    const cap = config.maxConcurrentScripts;
    if (this.scriptSlotsInUse() >= cap) {
      throw new Error(`同时运行的脚本已达上限 ${cap} 个。请先停掉一个正在跑的脚本，或在「任务计划」页「计划设置」的「同时运行脚本上限」里调高（不建议超过 4 个）。`);
    }
    const runId = randomUUID();
    const release = this.runner.reserve(index, runId);
    const controller = new AbortController();
    const record: Manual = { runId, gameId, controller, done: Promise.resolve() };
    this.manual.set(index, record);
    let lease: Lease | null = null;
    let giveBack: (() => void) | null = null;
    const cleanup = async (): Promise<void> => {
      this.giveBackGather(giveBack);
      giveBack = null;
      await lease?.release();
      lease = null;
      if (this.manual.get(index) === record) this.manual.delete(index);
      release();
      this.pump(index);
      this.pumpAll();
    };
    try {
      const script = await this.getScript(gameId, scriptId);
      const state = await this.port.instance(index);
      if (state.status !== 'running') throw new Error(`实例 #${index} 尚未就绪，请先启动并等待 Android 启动完成`);
      const identity = state.record.createdAt;
      let account: GameAccount | undefined;
      if (options.accountId) {
        account = (await this.port.accounts(gameId)).find((item) => item.id === options.accountId);
        if (!account || !account.enabled || account.packageName !== plugin.packageName) throw new Error('账号不存在、已停用或不属于当前游戏');
        if (account.binding?.index !== index || account.binding.instanceCreatedAt !== identity) throw new Error(`账号「${account.name}」没有绑定到实例 #${index}`);
        if (account.login.status !== 'ready') throw new Error(`账号「${account.name}」尚未完成登录`);
      }
      const dir = await this.port.templateDir(gameId, index);
      await this.checkRunnable(gameId, script, dir);
      const device = await this.port.device(index);
      if (!startsWithLaunch(script, plugin.packageName)) {
        const foreground = await device.foregroundPackage();
        if (foreground !== plugin.packageName) throw new Error(`${plugin.name}未处于前台（当前 ${foreground ?? '未知'}）。请先打开游戏，或让脚本以「启动游戏」开头（也可以先用「如果游戏不在前台 → 启动游戏」）。`);
      }
      // ★ Scripts first (original plan rule 1): everything automatic on the instance yields before the script takes
      // it — at once for 'highest' (the default), after the plan config's grace for 'normal'.
      const graceMs = (options.priority ?? 'highest') === 'highest' ? 0 : config.preemptGraceMs;
      giveBack = await this.suspendGather(gameId, index, `临时运行脚本「${script.name}」`, graceMs);
      lease = await this.acquireLease(index, this.manualLeaseWaitMs, '运行脚本');
      const shotPolicy = options.shotPolicy ?? await this.defaultShotPolicy();
      const matchDefaults = await this.defaultMatch();
      // Script defaults < the account's saved params for this script < the request (original mergeParams).
      const params = mergeParams(script, account?.scriptParams?.[script.id], options.params);
      const assertOwnership = account ? this.ownershipCheck(gameId, account.id, index, identity, plugin.packageName) : undefined;
      const maxRunMs = options.maxRunMinutes > 0 ? options.maxRunMinutes * this.minuteMs : null;
      record.done = this.runner.run({
        runId, gameId, packageName: plugin.packageName, instanceIndex: index, instanceIdentity: identity, script, params,
        accountId: account?.id ?? null, accountName: account?.name ?? null, source: 'manual', taskId: null, templateDir: dir || null,
        shotPolicy, maxRunMs, signal: controller.signal, assertOwnership, aiAssist: config.aiAssist, ...(matchDefaults ? { matchDefaults } : {}),
      }).then(() => undefined, (error: unknown) => console.error('[plan] 临时脚本执行失败', error)).finally(() => cleanup());
      return {
        runId, scriptId: script.id, scriptName: script.name, instanceIndex: index, accountId: account?.id ?? null, accountName: account?.name ?? null,
        status: 'starting', startedAt: this.now(), endedAt: null, stepDone: 0, stepTotal: script.loop ? null : script.steps.length,
        currentStepId: null, currentStepName: null, iteration: 0, error: null,
        stats: { captures: 0, matches: 0, matchHits: 0, taps: 0, retries: 0, lastTickMs: 0, avgCaptureMs: 0 },
        gameId, source: 'manual', taskId: null, shotPolicy, maxRunMs,
      };
    } catch (error) {
      await cleanup();
      throw error;
    }
  }

  /** Script runs of this game known to the runner (active + recent finished), newest first. */
  listRuns(gameId: string): ScriptRunSnapshot[] {
    gamePlugin(gameId);
    return this.runner.list(gameId);
  }

  pauseRun(gameId: string, runId: string): void {
    this.ownRun(gameId, runId);
    this.runner.pause(runId);
  }

  resumeRun(gameId: string, runId: string): void {
    this.ownRun(gameId, runId);
    this.runner.resume(runId);
  }

  setRunDebugMatches(gameId: string, runId: string, enabled: boolean): void {
    this.ownRun(gameId, runId);
    this.runner.setDebugMatches(runId, enabled);
  }

  /** Stored log lines of one run of this game (also finished and older runs on disk). */
  runLogs(gameId: string, query: RunLogQuery): Promise<LogEntry[]> {
    gamePlugin(gameId);
    assertRunId(query.runId);
    return this.runner.logs.query(gameId, query);
  }

  runShot(gameId: string, runId: string, shot: string): Promise<Uint8Array> {
    gamePlugin(gameId);
    assertRunId(runId);
    return this.runner.logs.readShot(gameId, runId, shot);
  }

  /** Whether the instance can type non-ASCII text through ADBKeyboard (read only, no lease). */
  async imeStatus(index: number): Promise<ImeStatus> {
    const state = await this.port.instance(index);
    if (state.status !== 'running') throw new Error(`实例 #${index} 尚未就绪，请先启动并等待 Android 启动完成`);
    return readImeStatus(await this.port.device(index), index);
  }

  /** Install a user-picked ADBKeyboard APK and enable it. A device write: refused while the instance is busy. */
  async setupIme(index: number, apkPath: string): Promise<ImeStatus> {
    if (this.isActiveForInstance(index)) throw new Error(`实例 #${index} 正在运行脚本，请先停止后再安装输入法`);
    const state = await this.port.instance(index);
    if (state.status !== 'running') throw new Error(`实例 #${index} 尚未就绪，请先启动并等待 Android 启动完成`);
    const lease = await this.acquireLease(index, IME_LEASE_WAIT_MS, '安装中文输入法');
    try {
      const current = await this.port.instance(index);
      if (current.status !== 'running' || current.record.createdAt !== state.record.createdAt) throw new Error(`实例 #${index} 已停止或被替换`);
      return await setupIme(await this.port.device(index), index, apkPath);
    } finally { await lease.release(); }
  }

  private ownRun(gameId: string, runId: string): void {
    gamePlugin(gameId);
    const run = this.runner.get(runId);
    if (!run || run.gameId !== gameId) throw new Error('找不到执行记录（可能已经结束并被清理）');
  }

  /** Stop by run id (执行监控): a queued plan run leaves the queue, a running one is stopped (and never retried). */
  async cancelRun(gameId: string, runId: string): Promise<void> {
    gamePlugin(gameId);
    for (const [index, list] of this.queues) {
      const n = list.findIndex((item) => item.run.gameId === gameId && item.run.runId === runId);
      if (n >= 0) {
        const [item] = list.splice(n, 1);
        if (!list.length) this.queues.delete(index);
        if (item) {
          const live = this.live.get(liveKey(gameId, item.run.accountId, item.run.taskId));
          if (live) { this.clearRetry(live); live.phase = 'idle'; }
          await this.finish(item.run, 'cancelled', '用户取消排队');
        }
        this.publish(gameId);
        return;
      }
    }
    for (const active of this.active.values()) if (active.run.gameId === gameId && active.run.runId === runId) {
      active.controller.abort(new Error('用户停止脚本'));
      await active.done;
      return;
    }
    for (const manual of this.manual.values()) if (manual.gameId === gameId && manual.runId === runId) {
      manual.controller.abort(new Error('用户停止脚本'));
      await manual.done;
      return;
    }
    const known = this.runner.get(runId);
    if (known && known.gameId === gameId) await this.runner.stop(runId);
    // A plan attempt that already failed and waits for its retry: stopping it drops the retry too.
    const record = (await this.store.overview(gameId)).runs.find((run) => run.runId === runId);
    const live = record ? this.live.get(liveKey(gameId, record.accountId, record.taskId)) : undefined;
    if (record && live?.retryTimer && !this.queuedOrActive(gameId, record.accountId, record.taskId)) {
      this.clearRetry(live);
      this.publish(gameId);
    }
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    for (const timer of [...this.tickTimers.values(), ...this.publishTimers.values(), ...this.capRetries.values()]) clearTimeout(timer);
    this.tickTimers.clear();
    this.publishTimers.clear();
    this.capRetries.clear();
    for (const live of this.live.values()) this.clearRetry(live);
    for (const active of this.active.values()) active.controller.abort(new Error('助手正在退出'));
    for (const manual of this.manual.values()) manual.controller.abort(new Error('助手正在退出'));
    await Promise.allSettled([...this.active.values(), ...this.manual.values()].map((item) => item.done));
    for (const list of this.queues.values()) for (const item of list) await this.finish(item.run, 'skipped', '助手退出，未开始执行');
    this.queues.clear();
    await this.runner.dispose();
    await Promise.allSettled([...this.ownerLeases.values()].map((lease) => lease.release()));
    this.ownerLeases.clear();
  }

  // ── Overview building ────────────────────────────────────────────────────

  private liveOf(gameId: string, accountId: string, taskId: string): LiveTask {
    const key = liveKey(gameId, accountId, taskId);
    let live = this.live.get(key);
    if (!live) {
      live = { phase: null, holdUntil: null, retryLeft: 0, retryTimer: null, retryOrigin: 'schedule' };
      this.live.set(key, live);
    }
    return live;
  }

  private clearRetry(live: LiveTask): void {
    if (live.retryTimer) clearTimeout(live.retryTimer);
    live.retryTimer = null;
    live.holdUntil = null;
    live.retryLeft = 0;
  }

  private waitingOf(gameId: string, accountId: string, taskId: string): Waiting | undefined {
    for (const list of this.queues.values()) {
      const item = list.find((w) => w.run.gameId === gameId && w.run.accountId === accountId && w.run.taskId === taskId);
      if (item) return item;
    }
    return undefined;
  }

  private activeOf(gameId: string, accountId: string, taskId: string): Active | undefined {
    for (const item of this.active.values()) {
      if (item.run.gameId === gameId && item.run.accountId === accountId && item.run.taskId === taskId) return item;
    }
    return undefined;
  }

  private queuedOrActive(gameId: string, accountId: string, taskId: string): boolean {
    return Boolean(this.waitingOf(gameId, accountId, taskId) ?? this.activeOf(gameId, accountId, taskId));
  }

  private phaseOf(gameId: string, accountId: string, taskId: string, runtime: TaskRuntime | undefined): PlanTaskPhase {
    // Taken off the queue but still waiting for the instance lease: 排队中 until the lease is actually held.
    const active = this.activeOf(gameId, accountId, taskId);
    if (active) return active.leased ? 'running' : 'queued';
    if (this.waitingOf(gameId, accountId, taskId)) return 'queued';
    return this.live.get(liveKey(gameId, accountId, taskId))?.phase ?? phaseOfResult(runtime?.lastResult);
  }

  /**
   * Next automatic run (original nextRunAtOf): null when the task is queued / running, or when a switch is off or
   * the trigger is manual; otherwise the trigger's next time, raised to a pending retry hold. A pending retry of a
   * 「立即运行」 round still shows while the switches are off (it comes back regardless; scheduled rounds' retries
   * are dropped when a switch goes off).
   */
  private nextRunAtOf(config: PlanConfig, plan: AccountPlan, task: PlanTask, runtime: TaskRuntime | undefined, phase: PlanTaskPhase, holdUntil: number | null, now: number): number | null {
    if (phase === 'queued' || phase === 'running') return null;
    const hold = holdUntil !== null && holdUntil > now ? holdUntil : null;
    if (!config.enabled || !plan.enabled || !task.enabled) return hold;
    const next = nextFireAt(task.trigger, now, lastRunAtOf(runtime));
    if (hold === null) return next;
    return next === null ? hold : Math.max(hold, next);
  }

  private taskStates(gameId: string, data: PlanData, accounts: GameAccount[], scripts: ScriptMeta[], now: number): PlanTaskState[] {
    const pkg = gamePlugin(gameId).packageName;
    const rows: PlanTaskState[] = [];
    for (const plan of data.plans) {
      const account = accounts.find((a) => a.id === plan.accountId);
      for (const task of plan.tasks) {
        const runtime = data.runtime.find((r) => r.accountId === plan.accountId && r.taskId === task.id);
        const live = this.live.get(liveKey(gameId, plan.accountId, task.id));
        const phase = this.phaseOf(gameId, plan.accountId, task.id, runtime);
        const current = this.activeOf(gameId, plan.accountId, task.id) ?? this.waitingOf(gameId, plan.accountId, task.id);
        const script = scripts.find((s) => s.id === task.scriptId && s.version !== '0');
        const holdUntil = live && live.holdUntil !== null && live.holdUntil > now ? live.holdUntil : null;
        rows.push({
          accountId: plan.accountId, accountName: account?.name ?? '（账号已删除）', accountMissing: !account,
          accountIssue: accountIssueOf(account, pkg), instanceIndex: account?.binding?.index ?? null,
          taskId: task.id, scriptId: task.scriptId, scriptName: script?.name ?? null, enabled: task.enabled, accountEnabled: plan.enabled,
          trigger: task.trigger, priority: task.priority, maxRunMinutes: task.maxRunMinutes, ...(task.note ? { note: task.note } : {}),
          phase, nextRunAt: this.nextRunAtOf(data.config, plan, task, runtime, phase, holdUntil, now), holdUntil,
          retryLeft: live?.retryLeft ?? 0,
          lastRunAt: runtime?.lastStartedAt ?? null, lastEndedAt: runtime?.lastEndedAt ?? null, lastResult: runtime?.lastResult ?? null,
          lastError: runtime?.lastError ?? null, runId: current?.run.runId ?? null,
          queuedAt: phase === 'queued' ? current?.run.queuedAt ?? null : null, runs: runtime?.runs ?? 0, fails: runtime?.fails ?? 0,
        });
      }
    }
    return rows.sort(comparePlanRows);
  }

  private queueViews(gameId: string): PlanQueueView[] {
    const indices = new Set<number>();
    for (const [index, list] of this.queues) if (list.some((item) => item.run.gameId === gameId)) indices.add(index);
    for (const [index, item] of this.active) if (item.run.gameId === gameId) indices.add(index);
    const entry = (run: PlanRun): PlanQueueEntry => ({ accountId: run.accountId, taskId: run.taskId, runId: run.runId });
    return [...indices].sort((a, b) => a - b).map((instanceIndex) => {
      const current = this.active.get(instanceIndex);
      const mine = current?.run.gameId === gameId ? current : undefined;
      // A round still waiting for the instance lease heads the waiting list rather than showing as 执行中.
      const running = mine?.leased ? mine : undefined;
      const waiting = [
        ...(mine && !mine.leased ? [entry(mine.run)] : []),
        ...(this.queues.get(instanceIndex) ?? []).filter((item) => item.run.gameId === gameId).map((item) => entry(item.run)),
      ];
      return {
        instanceIndex, runningTaskId: running?.run.taskId ?? null,
        waitingTaskIds: waiting.map((item) => item.taskId), running: running ? entry(running.run) : null, waiting,
      };
    });
  }

  /** Accounts / scripts are read fresh each time, falling back to the last list when a read fails (original refreshRefs). */
  private async accountsOf(gameId: string): Promise<GameAccount[]> {
    try {
      const list = await this.port.accounts(gameId);
      this.accountCache.set(gameId, list);
      return list;
    } catch (error) {
      console.warn('[plan] 读账号列表失败，沿用上一次的：', safeErrorMessage(error));
      return this.accountCache.get(gameId) ?? [];
    }
  }

  private async scriptsOf(gameId: string): Promise<ScriptMeta[]> {
    try {
      const list = await this.listScripts(gameId);
      this.scriptCache.set(gameId, list);
      return list;
    } catch (error) {
      console.warn('[plan] 读脚本列表失败，沿用上一次的：', safeErrorMessage(error));
      return this.scriptCache.get(gameId) ?? [];
    }
  }

  /** Coalesced `plan-changed` push (enqueue, start, end, toggle …). */
  private publish(gameId: string): void {
    if (!this.port.onChanged || this.closing || this.publishTimers.has(gameId)) return;
    const timer = setTimeout(() => {
      this.publishTimers.delete(gameId);
      void this.overview(gameId).then((overview) => {
        try { this.port.onChanged?.(overview); } catch { /* Observers cannot break the planner. */ }
      }).catch((error: unknown) => console.warn('[plan] 推送计划状态失败（已忽略）', safeErrorMessage(error)));
    }, PUBLISH_DELAY_MS);
    timer.unref?.();
    this.publishTimers.set(gameId, timer);
  }

  // ── Main loop ────────────────────────────────────────────────────────────

  private requestTick(gameId: string): void {
    if (this.closing || !this.ownerLeases.has(gameId) || !this.games.has(gameId)) return;
    void this.tick(gameId).catch((error: unknown) => console.error('[plan] 计划评估出错（已忽略，下一轮继续）', error));
  }

  /** One evaluation: due tasks are claimed and queued, stale waiting rounds are skipped, queues pump, timer re-armed. */
  private async tick(gameId: string): Promise<void> {
    if (this.closing || !this.ownerLeases.has(gameId) || !this.games.has(gameId)) return;
    if (this.ticking.has(gameId)) { this.tickAgain.add(gameId); return; }
    this.ticking.add(gameId);
    let data: PlanData | null = null;
    try {
      data = await this.store.overview(gameId);
      this.caps.set(gameId, data.config.maxConcurrentScripts);
      const now = this.now();
      if (data.config.enabled) {
        const accounts = new Map((await this.accountsOf(gameId)).map((a) => [a.id, a]));
        const pkg = gamePlugin(gameId).packageName;
        for (const plan of data.plans) {
          if (!plan.enabled) continue;
          const account = accounts.get(plan.accountId);
          if (accountIssueOf(account, pkg) || !account?.binding) continue;
          for (const task of plan.tasks) {
            if (this.closing) return;
            if (!task.enabled || task.trigger.kind === 'manual' || this.queuedOrActive(gameId, plan.accountId, task.id)) continue;
            const live = this.live.get(liveKey(gameId, plan.accountId, task.id));
            if (live && live.holdUntil !== null && now < live.holdUntil) continue;
            const runtime = data.runtime.find((r) => r.accountId === plan.accountId && r.taskId === task.id);
            // Cheap pre-check; the store re-checks under the file lock before claiming the round.
            if (dueReason(task.trigger, now, lastRunAtOf(runtime), data.config.catchUpMs) === null) continue;
            const claimed = await this.store.claimScheduled(gameId, account.id, task.id, this.newRun(gameId, account, task, 'schedule', 1, ''), now);
            if (!claimed) continue;
            if (this.closing) {
              // Quitting began during the claim: the round is closed like the queued ones shutdown() skips.
              await this.finish(claimed, 'skipped', '助手退出，未开始执行');
              return;
            }
            if (this.queuedOrActive(gameId, plan.accountId, task.id)) {
              // A 「立即运行」 of the same task landed during the claim: this round never joins the queue, so its
              // record is closed (not left 排队中) and the claim released, like runNow() / retry() handle the race.
              await this.finish(claimed, 'cancelled', '同一任务已在队列里', true);
              continue;
            }
            const state = this.liveOf(gameId, plan.accountId, task.id);
            state.retryLeft = data.config.retry;
            state.retryOrigin = 'schedule';
            console.info(`[plan] [实例 #${claimed.instanceIndex}] 任务入队：${task.scriptId}（${claimed.message}）。`);
            // Queued without pumping: every due task joins the queue first, so priorities decide who starts.
            this.enqueue(claimed, data.config, false);
          }
        }
      }
      await this.sweep(gameId, this.now());
      this.pumpAll();
    } finally {
      this.ticking.delete(gameId);
      if (data && !this.closing) this.armTimer(gameId, data);
      if (this.tickAgain.delete(gameId)) this.requestTick(gameId);
    }
  }

  /**
   * ★ Waiting rounds that exceeded `queueWaitMs` are skipped (original iron rule 3: never pile up). The running
   * one is never touched.
   */
  private async sweep(gameId: string, now: number): Promise<void> {
    for (const [index, list] of [...this.queues]) {
      const expired = list.filter((item) => item.run.gameId === gameId && now > item.deadline);
      if (!expired.length) continue;
      const rest = list.filter((item) => !expired.includes(item));
      if (rest.length) this.queues.set(index, rest); else this.queues.delete(index);
      for (const item of expired) {
        const minutes = Math.round((now - item.run.queuedAt) / 60_000);
        const message = `等了 ${minutes} 分钟仍没轮到（实例一直忙），这一轮跳过。`;
        console.warn(`[plan] [${item.run.accountName}/${item.run.taskId}] ${message}`);
        await this.finish(item.run, 'skipped', message);
      }
      this.publish(gameId);
    }
  }

  /** Sleeps until the earliest next run or hold (1 s – 60 s, unref'd; original armTimer). */
  private armTimer(gameId: string, data: PlanData): void {
    const previous = this.tickTimers.get(gameId);
    if (previous) clearTimeout(previous);
    const now = this.now();
    let due = now + MAX_SLEEP_MS;
    for (const plan of data.plans) {
      for (const task of plan.tasks) {
        const runtime = data.runtime.find((r) => r.accountId === plan.accountId && r.taskId === task.id);
        const live = this.live.get(liveKey(gameId, plan.accountId, task.id));
        const hold = live?.holdUntil ?? null;
        const at = this.nextRunAtOf(data.config, plan, task, runtime, this.phaseOf(gameId, plan.accountId, task.id, runtime), hold, now);
        if (at !== null && at > now && at < due) due = at;
        if (hold !== null && hold > now && hold < due) due = hold;
      }
    }
    const wait = Math.min(MAX_SLEEP_MS, Math.max(MIN_SLEEP_MS, due - now));
    const timer = setTimeout(() => { this.tickTimers.delete(gameId); this.requestTick(gameId); }, wait);
    // ★ unref: a pending evaluation never keeps the app alive after its windows closed.
    timer.unref?.();
    this.tickTimers.set(gameId, timer);
  }

  // ── Queue ────────────────────────────────────────────────────────────────

  private newRun(gameId: string, account: GameAccount, task: PlanTask, origin: PlanRunOrigin, attempt: number, message: string): PlanRun {
    return {
      runId: randomUUID(), gameId, accountId: account.id, accountName: account.name, instanceIndex: account.binding?.index ?? -1,
      taskId: task.id, scriptId: task.scriptId, priority: task.priority, status: 'queued', queuedAt: this.now(), startedAt: null,
      endedAt: null, message, stepId: null, origin, attempt,
    };
  }

  private enqueue(run: PlanRun, config: PlanConfig, pump = true): void {
    const list = this.queues.get(run.instanceIndex) ?? [];
    list.push({ run, deadline: run.queuedAt + config.queueWaitMs });
    // Bigger priority first; equal priorities keep their queue order.
    list.sort((a, b) => b.run.priority - a.run.priority || a.run.queuedAt - b.run.queuedAt);
    this.queues.set(run.instanceIndex, list);
    const live = this.liveOf(run.gameId, run.accountId, run.taskId);
    live.holdUntil = null;
    this.emitRun(run);
    this.publish(run.gameId);
    if (pump) this.pump(run.instanceIndex);
  }

  /**
   * Takes matching waiting rounds off the queue; they end as cancelled. `releaseClaim` (a switch turned off): the
   * round did not run, so it is due again once the switch is back on (original: only a start counts). A user
   * cancel keeps the claim — the user did not want this round. Rounds already taken off the queue but still waiting
   * for the instance lease (shown as 排队中 too) are stopped the same way; a script that holds the lease is not.
   */
  private async dropWaiting(gameId: string, match: (run: PlanRun) => boolean, message: string, releaseClaim = true): Promise<void> {
    const stopping: Active[] = [];
    for (const item of this.active.values()) {
      if (item.leased || item.run.gameId !== gameId || item.controller.signal.aborted || !match(item.run)) continue;
      item.releaseClaim = releaseClaim;
      item.controller.abort(new Error(message));
      stopping.push(item);
    }
    const dropped: PlanRun[] = [];
    for (const [index, list] of [...this.queues]) {
      const keep = list.filter((item) => !(item.run.gameId === gameId && match(item.run)));
      if (keep.length === list.length) continue;
      dropped.push(...list.filter((item) => !keep.includes(item)).map((item) => item.run));
      if (keep.length) this.queues.set(index, keep); else this.queues.delete(index);
    }
    for (const run of dropped) {
      await this.finish(run, 'cancelled', message, releaseClaim);
      this.liveOf(run.gameId, run.accountId, run.taskId).phase = 'idle';
    }
    if (dropped.length) this.publish(gameId);
    await Promise.all(stopping.map((item) => item.done));
  }

  private pumpAll(): void {
    for (const index of [...this.queues.keys()]) this.pump(index);
  }

  /** Starts the instance's next round when the instance is free (fire and forget; execute never throws). */
  private pump(index: number): void {
    if (this.closing || this.active.has(index) || this.manual.has(index) || this.runner.runIdOfInstance(index)) return;
    const list = this.queues.get(index);
    const next = list?.[0];
    if (!list || !next) return;
    // Global cap: stay queued and try again later — a back-off, never a failure (original CONCURRENCY_LIMIT rule).
    const cap = this.caps.get(next.run.gameId) ?? DEFAULT_MAX_CONCURRENT_SCRIPTS;
    if (this.scriptSlotsInUse() >= cap) {
      if (!this.capRetries.has(index)) {
        console.info(`[plan] [实例 #${index}] 同时运行的脚本已达上限 ${cap} 个，${Math.round(this.busyRetryMs / 1000)}s 后自动重试。`);
        const timer = setTimeout(() => { this.capRetries.delete(index); this.pump(index); }, this.busyRetryMs);
        timer.unref?.();
        this.capRetries.set(index, timer);
      }
      return;
    }
    list.shift();
    if (!list.length) this.queues.delete(index);
    // Admission is synchronous: a manual run arriving meanwhile sees the instance taken.
    const release = this.runner.reserve(index, next.run.runId);
    const active: Active = { run: next.run, deadline: next.deadline, controller: new AbortController(), done: Promise.resolve(), leased: false };
    this.active.set(index, active);
    active.done = this.execute(active).catch((error: unknown) => console.error('[plan] 计划执行收尾出错', error)).finally(() => {
      release();
      if (this.active.get(index) === active) this.active.delete(index);
      this.publish(active.run.gameId);
      this.pump(index);
      this.pumpAll();
      // The next interval / daily time is counted from this run: re-evaluate and re-arm the timer now.
      this.requestTick(active.run.gameId);
    });
  }

  // ── Execution ────────────────────────────────────────────────────────────

  /**
   * One attempt of one round: re-check → ★ gather yields → instance lease → run → lease released → gather given
   * back → bookkeeping → maybe a retry later (outside the lease, as a new queued attempt). Every wait before the
   * script starts honours the run's AbortSignal, so 停止 / 删除 / quitting return promptly.
   */
  private async execute(active: Active): Promise<void> {
    const { run, controller } = active;
    const signal = controller.signal;
    let giveBack: (() => void) | null = null;
    let config = defaultPlanConfig();
    let retry = false;
    try {
      const data = await this.store.overview(run.gameId);
      config = data.config;
      const plan = data.plans.find((p) => p.accountId === run.accountId);
      const task = plan?.tasks.find((t) => t.id === run.taskId);
      if (!plan || !task) throw new PlanOutcome('任务已从计划中删除，这一轮不再执行', 'skipped');
      if ((run.origin ?? 'schedule') === 'schedule' && (!config.enabled || !plan.enabled || !task.enabled)) {
        throw new PlanOutcome(!config.enabled ? '计划总开关已关闭，这一轮不再执行' : !plan.enabled ? '账号计划已关闭，这一轮不再执行' : '任务已关闭，这一轮不再执行', 'cancelled');
      }
      const plugin = gamePlugin(run.gameId);
      const account = (await this.port.accounts(run.gameId)).find((a) => a.id === run.accountId);
      const issue = accountIssueOf(account, plugin.packageName);
      if (issue || !account?.binding) throw new PlanOutcome(`${issue ?? '未绑定实例'}，这一轮跳过`, 'skipped');
      if (account.binding.index !== run.instanceIndex) throw new PlanOutcome('账号绑定的实例已变化，这一轮跳过', 'skipped');
      // ★ Scripts first (original plan rule 1): the instance's gather scheduler yields (polite wait of preemptGraceMs,
      // then abort of its in-flight sample / dispatch) before the script takes the lease; it gets it back in `finally`.
      giveBack = await untilAborted(
        this.suspendGather(run.gameId, run.instanceIndex, `执行脚本计划「${task.scriptId}」`, config.preemptGraceMs),
        signal, (late) => this.giveBackGather(late));
      // The lease wait uses what is left of the queue budget (never twice queueWaitMs in total).
      const lease = await this.waitForLease(run.instanceIndex, '运行脚本计划', Math.max(1_000, active.deadline - this.now()), signal);
      let result: ScriptRunSnapshot;
      try {
        active.leased = true;
        this.publish(run.gameId);
        result = await this.runInLease(run, task, account, config, signal);
      } finally {
        await lease.release();
      }
      retry = await this.settle(run, result, task, signal);
    } catch (error) {
      retry = await this.settleError(run, error, signal, active.releaseClaim);
    } finally {
      // After the lease is released: the scheduler re-reads its queue 15 s later.
      this.giveBackGather(giveBack);
    }
    if (retry) this.scheduleRetry(run, config);
  }

  /** Inside the instance lease: last checks, then the script runs in its worker thread. */
  private async runInLease(run: PlanRun, task: PlanTask, account: GameAccount, config: PlanConfig, signal: AbortSignal): Promise<ScriptRunSnapshot> {
    if (signal.aborted) throw signal.reason;
    const plugin = gamePlugin(run.gameId);
    const pkg = plugin.packageName;
    const identity = account.binding!.instanceCreatedAt;
    const assertAccount = this.ownershipCheck(run.gameId, run.accountId, run.instanceIndex, identity, pkg);
    try { await assertAccount(); }
    catch (error) { throw new PlanOutcome(`${safeErrorMessage(error)}（这一轮跳过）`, 'skipped'); }
    const state = await this.port.instance(run.instanceIndex);
    if (state.status !== 'running' || state.record.createdAt !== identity) {
      throw new PlanOutcome(`实例 #${run.instanceIndex} 未运行或已被替换，这一轮跳过`, 'skipped');
    }
    let script: ScriptDef;
    try { script = await this.getScript(run.gameId, run.scriptId); }
    catch (error) { throw new PlanOutcome(`脚本 ${run.scriptId} 读取失败：${safeErrorMessage(error)}`, 'failed'); }
    if (!startsWithLaunch(script, pkg)) {
      const foreground = await (await this.port.device(run.instanceIndex)).foregroundPackage();
      if (foreground !== pkg) {
        throw new PlanOutcome(`${plugin.name}未处于前台（当前 ${foreground ?? '未知'}），这一轮跳过。请先打开游戏，或让脚本以「启动游戏」开头。`, 'skipped');
      }
    }
    const dir = await this.port.templateDir(run.gameId, run.instanceIndex);
    try { await this.checkRunnable(run.gameId, script, dir); }
    catch (error) { throw new PlanOutcome(error instanceof Error ? error.message : String(error), 'failed'); }
    if (signal.aborted) throw signal.reason;
    const startedAt = this.now();
    Object.assign(run, { status: 'running', startedAt, message: `正在执行 ${script.name}` });
    await this.store.updateRun(run.gameId, run.runId, { status: 'running', startedAt, message: run.message });
    this.liveOf(run.gameId, run.accountId, run.taskId).phase = null;
    this.emitRun(run);
    this.publish(run.gameId);
    const shotPolicy = await this.defaultShotPolicy();
    const matchDefaults = await this.defaultMatch();
    // Script defaults < the account's saved params for this script < the task's params (original mergeParams).
    const params = mergeParams(script, account.scriptParams?.[script.id], task.params);
    return this.runner.run({
      runId: run.runId, gameId: run.gameId, packageName: pkg, instanceIndex: run.instanceIndex, instanceIdentity: identity,
      script, params, accountId: account.id, accountName: account.name, source: 'plan', taskId: run.taskId,
      templateDir: dir || null, shotPolicy, maxRunMs: task.maxRunMinutes > 0 ? task.maxRunMinutes * this.minuteMs : null,
      signal, assertOwnership: assertAccount, aiAssist: config.aiAssist, ...(matchDefaults ? { matchDefaults } : {}),
    });
  }

  /** Bookkeeping of a run that executed. Returns whether the failure may be retried. */
  private async settle(run: PlanRun, result: ScriptRunSnapshot, task: PlanTask, signal: AbortSignal): Promise<boolean> {
    if (result.status === 'succeeded') {
      // A loop script ends only by a stop or the task's time limit: running the limit out is its planned end.
      const message = result.timedOut ? `循环脚本已运行满本次上限 ${task.maxRunMinutes} 分钟，按时结束（完成 ${result.iteration} 轮）` : '脚本执行完成';
      await this.finish(run, 'succeeded', message);
      this.liveOf(run.gameId, run.accountId, run.taskId).retryLeft = 0;
      return false;
    }
    if (result.status === 'aborted' || signal.aborted) {
      // ★ A stopped run is never retried (「用户按了停，就是不想让它再跑」).
      await this.finish(run, 'cancelled', signal.reason instanceof Error ? signal.reason.message : '脚本已停止');
      return false;
    }
    const message = result.error ?? '脚本执行失败，原因见运行日志。';
    switch (result.failureCode) {
      case 'START_CHECK':
        // The runner refused before any input (instance replaced, game left the foreground): 「现在没法跑」.
        await this.finish(run, 'skipped', `${message}（这一轮跳过）`);
        return false;
      case 'GUARD':
      case 'AI_RISK_BLOCKED':
        // Execution guards and 「需要人处理」 are never retried: the same run would only be stopped again.
        await this.finish(run, 'failed', message);
        return false;
      default:
        await this.finish(run, 'failed', message);
        // ★ A run the time limit stopped is not retried (original: the limit stops it, a stopped run is not retried).
        return !result.timedOut;
    }
  }

  /** Bookkeeping of a round that could not run (or was stopped before it did). Returns whether to retry. */
  private async settleError(run: PlanRun, error: unknown, signal: AbortSignal, releaseClaim = false): Promise<boolean> {
    if (signal.aborted) {
      await this.finish(run, 'cancelled', signal.reason instanceof Error ? signal.reason.message : '脚本已取消', releaseClaim);
      return false;
    }
    if (error instanceof PlanOutcome) {
      await this.finish(run, error.status, error.message);
      return error.retryable;
    }
    const code = errorCode(error);
    if (code === 'LOCK_TIMEOUT') {
      await this.finish(run, 'skipped', '等实例空闲超时（被登录、采集或其它写入占用），这一轮跳过。');
      return false;
    }
    // Persisted in plans.json: never with a device serial or an adb command line.
    const message = safeErrorMessage(error);
    if (code && SKIP_CODES.has(code)) {
      console.warn(`[plan] [实例 #${run.instanceIndex}] 这一轮跳过：${message}`);
      await this.finish(run, 'skipped', `${message}（这一轮跳过）`);
      return false;
    }
    console.error(`[plan] [实例 #${run.instanceIndex}] 启动脚本失败：${message}`);
    await this.finish(run, 'failed', message);
    return true;
  }

  /**
   * Failure retry (original scheduleRetry): the instance is already released; the task is held for `retryDelayMs`
   * (visible as 「下次运行」) and then queued again as a new attempt of the same round.
   */
  private scheduleRetry(run: PlanRun, config: PlanConfig): void {
    const live = this.liveOf(run.gameId, run.accountId, run.taskId);
    if (this.closing || live.retryLeft <= 0) return;
    live.retryLeft -= 1;
    const delay = Math.max(MIN_RETRY_DELAY_MS, config.retryDelayMs);
    live.holdUntil = this.now() + delay;
    live.retryOrigin = run.origin ?? 'schedule';
    if (live.retryTimer) clearTimeout(live.retryTimer);
    console.info(`[plan] [${run.accountName}/${run.taskId}] ${Math.round(delay / 1000)}s 后重试（还剩 ${live.retryLeft} 次）。`);
    live.retryTimer = setTimeout(() => {
      live.retryTimer = null;
      void this.retry(run, live).catch((error: unknown) => console.error('[plan] 失败重试没能排队', error));
    }, delay);
    live.retryTimer.unref?.();
    this.publish(run.gameId);
  }

  private async retry(previous: PlanRun, live: LiveTask): Promise<void> {
    live.holdUntil = null;
    if (this.closing || this.queuedOrActive(previous.gameId, previous.accountId, previous.taskId)) return;
    const data = await this.store.overview(previous.gameId);
    const plan = data.plans.find((p) => p.accountId === previous.accountId);
    const task = plan?.tasks.find((t) => t.id === previous.taskId);
    const origin = previous.origin ?? 'schedule';
    if (!plan || !task || (origin === 'schedule' && (!data.config.enabled || !plan.enabled || !task.enabled))) { this.publish(previous.gameId); return; }
    const account = (await this.port.accounts(previous.gameId)).find((a) => a.id === previous.accountId);
    if (!account?.binding) { this.publish(previous.gameId); return; }
    if (this.closing || this.queuedOrActive(previous.gameId, previous.accountId, previous.taskId)) return;
    const attempt = (previous.attempt ?? 1) + 1;
    const reason = `失败重试（第 ${attempt} 次尝试）`;
    const run = { ...this.newRun(previous.gameId, account, task, origin, attempt, reason), reason };
    await this.store.addRun(previous.gameId, run);
    if (this.closing || this.queuedOrActive(previous.gameId, previous.accountId, previous.taskId)) {
      await this.finish(run, 'cancelled', '同一任务已在队列里');
      return;
    }
    this.enqueue(run, data.config);
  }

  private async finish(run: PlanRun, status: PlanRun['status'], message: string, releaseClaim = false): Promise<void> {
    const endedAt = this.now();
    Object.assign(run, { status, endedAt, message, stepId: null });
    try { await this.store.updateRun(run.gameId, run.runId, { status, endedAt, message, stepId: null }, { releaseClaim }); }
    catch (error) { console.error('[plan] 无法保存运行结果', error); }
    const live = this.liveOf(run.gameId, run.accountId, run.taskId);
    live.phase = status === 'succeeded' ? 'done' : status === 'failed' ? 'failed' : status === 'skipped' ? 'skipped' : 'idle';
    this.emitRun(run);
    this.publish(run.gameId);
  }

  private emitRun(run: PlanRun): void {
    try { this.port.onRun?.({ ...run }); } catch { /* Observers cannot break the planner. */ }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  /** ★ Never throws: a scheduler that cannot yield never blocks the script (original). */
  private async suspendGather(gameId: string, index: number, reason: string, graceMs: number): Promise<(() => void) | null> {
    if (!this.port.suspendForScript) return null;
    try { return await this.port.suspendForScript(gameId, index, reason, graceMs); }
    catch (error) {
      console.warn('[plan] 采集调度让路失败，仍然继续启动脚本', safeErrorMessage(error));
      return null;
    }
  }

  /** Gives the instance back to the gather scheduler (a null hold is a no-op); never throws. */
  private giveBackGather(giveBack: (() => void) | null): void {
    try { giveBack?.(); } catch (error) { console.error('[plan] 恢复自动采集失败', error); }
  }

  /** Instances running (or admitted to run) a script right now; gather rounds do not count. */
  private scriptSlotsInUse(): number {
    return new Set([...this.active.keys(), ...this.manual.keys(), ...this.runner.busyIndices()]).size;
  }

  private liveRunIds(): Set<string> {
    return new Set([...this.active.values()].map((item) => item.run.runId).concat([...this.manual.values()].map((item) => item.runId)));
  }

  private async defaultShotPolicy(): Promise<ShotPolicy> {
    try {
      const value = await this.port.shotPolicy?.();
      return value && SHOT_POLICIES.includes(value) ? value : 'onFail';
    } catch { return 'onFail'; }
  }

  /** The app settings' matching defaults for this run; undefined (vision defaults) when absent, unreadable or invalid. */
  private async defaultMatch(): Promise<ScriptMatchDefaults | undefined> {
    try {
      const value = await this.port.matchDefaults?.();
      if (!value) return undefined;
      const { threshold, shrink } = value;
      if (!(Number.isFinite(threshold) && threshold > 0 && threshold <= 1 && Number.isInteger(shrink) && shrink >= 1 && shrink <= 4)) return undefined;
      return { threshold, shrink };
    } catch { return undefined; }
  }

  /** Execution-time checks: every validation error refuses the run (warnings do not). */
  private async checkRunnable(gameId: string, script: ScriptDef, dir: string): Promise<void> {
    const pkg = gamePlugin(gameId).packageName;
    const referenced = referencedTemplateIds(script);
    if (referenced.length && !dir) throw new Error('脚本用到了模板匹配，但该实例还没有选择模板集。请先到「模板库」为这个实例选择或新建模板集。');
    const set = referenced.length ? await loadTemplateSet(dir) : null;
    const errors = blockingIssues(validateScript(script, pkg, set?.templates.map((t) => t.id)));
    if (errors.length) throw new Error(`脚本校验失败：${errors.map((i) => `${i.stepId ? `${i.stepId} ` : ''}${i.message}`).join('；')}`);
  }

  /** Before every device operation: the account is still enabled, logged in and bound to the same AVD. */
  private ownershipCheck(gameId: string, accountId: string, index: number, identity: string, pkg: string): () => Promise<void> {
    return async () => {
      const current = (await this.port.accounts(gameId)).find((item) => item.id === accountId);
      if (!current?.enabled || current.login.status !== 'ready' || current.packageName !== pkg ||
          current.binding?.index !== index || current.binding.instanceCreatedAt !== identity) {
        throw new ExecutionGuardError('账号已禁用、退出登录或绑定发生变化，脚本已停止');
      }
    };
  }

  /**
   * Hold `run/automation-instance-<i>.lock` until `release()` (entered / held pair around the labelled lease: the
   * lock carries `label` in owner.json and the holder shows in the occupancy table meanwhile).
   */
  private async acquireLease(index: number, timeoutMs: number, label: string): Promise<Lease> {
    try { return await this.holdLease(index, timeoutMs, label); }
    catch (error) {
      if (errorCode(error) === 'LOCK_TIMEOUT') throw new Error(`实例 #${index} 正被登录、采集或脚本计划占用，请稍后再试`);
      throw error;
    }
  }

  /** `acquireLease` with core's errors unchanged (a busy instance fails with `LOCK_TIMEOUT`). */
  private async holdLease(index: number, timeoutMs: number, label: string): Promise<Lease> {
    let entered!: () => void;
    let exit!: () => void;
    const acquired = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { exit = resolve; });
    const lockDone = withLabelledLease(this.home, index, label, async () => { entered(); await held; }, { timeoutMs });
    await Promise.race([acquired, lockDone]);
    return { release: async () => { exit(); await lockDone.catch(() => undefined); } };
  }

  /**
   * A plan run's wait for the instance lease (up to `waitMs`, then core's `LOCK_TIMEOUT` → 「这一轮跳过」). Core's file
   * lock takes no AbortSignal, so the wait is sliced (`LEASE_POLL_MS`) and `signal` is checked in between: stopping,
   * deleting the task or quitting ends the wait within a slice instead of blocking for the rest of `queueWaitMs`.
   */
  private async waitForLease(index: number, label: string, waitMs: number, signal: AbortSignal): Promise<Lease> {
    // Real time, like the file lock itself (the planner clock may be moved in tests).
    const until = Date.now() + waitMs;
    for (;;) {
      if (signal.aborted) throw signal.reason;
      try { return await this.holdLease(index, Math.min(LEASE_POLL_MS, Math.max(0, until - Date.now())), label); }
      catch (error) {
        if (errorCode(error) !== 'LOCK_TIMEOUT' || Date.now() >= until) throw error;
      }
    }
  }
}
