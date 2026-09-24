import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { withFileLock } from '@avdm/core';
import { ExecutionGuardError, loadTemplateSet } from '@avdm/automation';
import {
  blockingIssues, mergeParams, referencedTemplateIds, SHOT_POLICIES, startsWithLaunch,
  type ScriptParamValue, type ShotPolicy,
} from '@avdm/automation/script';
import { gamePlugin } from '../automation/games';
import type { GameAccount } from '../automation/accounts/types';
import { safeErrorMessage } from './device-errors';
import { readImeStatus, setupIme } from './ime';
import { assertRunId, KEEP_RUNS } from './run-logs';
import { ScriptRunner } from './script-runner';
import { ScriptStore, validateScript } from './scripts';
import { PlanStore } from './store';
import type {
  AccountPlan, ImeStatus, LogEntry, PlanConfig, PlanHostPort, PlanOverview, PlanRun, RunLogQuery, ScriptDef, ScriptIssue, ScriptMeta,
  ScriptRunOptions, ScriptRunSnapshot,
} from './types';

export type { AccountPlan, PlanConfig, PlanOverview, PlanRun, PlanTask, ScriptDef, ScriptMeta, TaskTrigger } from './types';
export { defaultPlanConfig } from './store';
export { ScriptRunner } from './script-runner';
export { readAppShotPolicy } from './app-shot-policy';

interface Active { run: PlanRun; controller: AbortController; done: Promise<void> }
interface Manual { runId: string; gameId: string; controller: AbortController; done: Promise<void> }
interface Lease { release(): Promise<void> }

/** Default global cap of concurrent script runs (original MAX_CONCURRENT_INSTANCES); gather rounds do not count. */
export const DEFAULT_MAX_CONCURRENT_SCRIPTS = 4;
/** A plan run deferred by the global cap is retried after this delay (back-off, never a failure). */
const CAP_RETRY_MS = 5_000;
/** Manual runs: default and maximum whole-run limit. */
const MANUAL_DEFAULT_MINUTES = 60;
const MANUAL_MAX_MINUTES = 720;
const MANUAL_LEASE_WAIT_MS = 200;
const MAX_PARAMS = 50;
const PARAM_KEY = /^[A-Za-z0-9_.-]{1,64}$/;

/** A script run ended without success; carries the plan run status it maps to. */
class RunEndedError extends Error {
  constructor(message: string, readonly status: PlanRun['status']) { super(message); this.name = 'RunEndedError'; }
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('脚本已取消'));
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const aborted = (): void => { clearTimeout(timer); reject(signal.reason ?? new Error('脚本已取消')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', aborted); resolve(); }, ms);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

/** Account-level script parameters (added by the accounts module); read defensively until then. */
function accountScriptParams(account: GameAccount | undefined, scriptId: string): Record<string, ScriptParamValue> | undefined {
  const all = (account as (GameAccount & { scriptParams?: Record<string, Record<string, ScriptParamValue>> }) | undefined)?.scriptParams;
  return all && typeof all === 'object' ? all[scriptId] : undefined;
}

function checkedRunOptions(options: ScriptRunOptions | undefined): Required<Pick<ScriptRunOptions, 'maxRunMinutes'>> & ScriptRunOptions {
  const value = options ?? {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('运行选项无效');
  if (value.accountId !== undefined && (typeof value.accountId !== 'string' || !/^[0-9a-f-]{36}$/i.test(value.accountId))) throw new Error('账号 ID 无效');
  if (value.shotPolicy !== undefined && !SHOT_POLICIES.includes(value.shotPolicy)) throw new Error('截图留痕策略无效');
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

/**
 * Game-scoped task plans, the script library and manual runs. One AVD receives one writer at a time across
 * processes (the instance lease); scripts execute in worker threads through the ScriptRunner.
 */
export class PlanService {
  readonly store: PlanStore;
  readonly scripts: ScriptStore;
  readonly runner: ScriptRunner;
  private readonly queues = new Map<number, PlanRun[]>();
  private readonly active = new Map<number, Active>();
  private readonly manual = new Map<number, Manual>();
  private readonly games = new Set<string>();
  private readonly contendedGames = new Set<string>();
  private readonly ownerLeases = new Map<string, Lease>();
  private readonly ticking = new Set<string>();
  private readonly caps = new Map<string, number>();
  private readonly capRetries = new Map<number, NodeJS.Timeout>();
  private timer: NodeJS.Timeout | null = null;
  private closing = false;

  constructor(private readonly home: string, private readonly port: PlanHostPort, runner?: ScriptRunner) {
    if (!path.isAbsolute(home)) throw new Error('计划根目录必须是绝对路径');
    this.store = new PlanStore(home);
    this.scripts = new ScriptStore(home);
    this.runner = runner ?? new ScriptRunner(home, { instance: (index) => port.instance(index), device: (index) => port.device(index) });
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
      await this.store.recoverInterrupted(gameId);
      this.games.add(gameId);
      // Run directories are kept to the newest 200 (the original never pruned; the disk grew without bound).
      void this.runner.logs.prune(gameId, KEEP_RUNS, this.liveRunIds()).catch((error: unknown) => console.error('[plan] 清理旧运行记录失败', error));
      if (!this.timer) {
        this.timer = setInterval(() => { for (const game of this.games) void this.tick(game).catch((e) => console.error('[plan] 调度失败', e)); }, 15_000);
        this.timer.unref?.();
      }
      await this.tick(gameId);
    } catch (error) {
      this.games.delete(gameId);
      this.ownerLeases.delete(gameId);
      await lease.release();
      throw error;
    }
  }

  async overview(gameId: string): Promise<PlanOverview> {
    gamePlugin(gameId);
    const overview = await this.store.overview(gameId);
    this.caps.set(gameId, overview.config.maxConcurrentScripts ?? DEFAULT_MAX_CONCURRENT_SCRIPTS);
    return overview;
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
    const overview = await this.overview(gameId);
    if (!overview.config.enabled) return false;
    const accounts = new Map((await this.port.accounts(gameId)).map((account) => [account.id, account]));
    return overview.plans.some((plan) => plan.enabled && plan.tasks.some((task) => task.enabled && task.trigger.kind !== 'manual') &&
      accounts.get(plan.accountId)?.enabled && accounts.get(plan.accountId)?.binding?.index === index);
  }

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

  saveScript(gameId: string, raw: unknown): Promise<ScriptMeta> {
    const plugin = gamePlugin(gameId);
    return this.scripts.save(gameId, plugin.packageName, raw);
  }

  async deleteScript(gameId: string, id: string): Promise<void> {
    gamePlugin(gameId);
    const overview = await this.store.overview(gameId);
    if (overview.plans.some((plan) => plan.tasks.some((task) => task.scriptId === id))) {
      throw new Error('脚本仍被计划引用，请先移除对应任务');
    }
    await this.scripts.remove(gameId, id);
  }

  async savePlan(gameId: string, plan: AccountPlan): Promise<AccountPlan> {
    gamePlugin(gameId);
    const account = (await this.port.accounts(gameId)).find((a) => a.id === plan.accountId);
    if (!account) throw new Error('账号不存在或不属于当前游戏');
    const available = new Set((await this.listScripts(gameId)).filter((s) => s.version !== '0').map((s) => s.id));
    for (const task of plan.tasks) if (!available.has(task.scriptId)) throw new Error(`脚本 ${task.scriptId} 不存在或无法读取`);
    if (plan.enabled && account.binding && await this.port.gatherScheduleEnabled(gameId, account.binding.index)) {
      throw new Error('当前实例正在自动采集。请先关闭采集调度，再启用脚本计划');
    }
    const saved = await this.store.savePlan(gameId, plan);
    void this.tick(gameId);
    return saved;
  }

  async saveConfig(gameId: string, patch: Partial<PlanConfig>): Promise<PlanConfig> {
    gamePlugin(gameId);
    if (patch.enabled) {
      const overview = await this.store.overview(gameId);
      const accounts = await this.port.accounts(gameId);
      for (const plan of overview.plans.filter((p) => p.enabled)) {
        const binding = accounts.find((a) => a.id === plan.accountId)?.binding;
        if (binding && await this.port.gatherScheduleEnabled(gameId, binding.index)) {
          throw new Error(`实例 #${binding.index} 正在自动采集，不能同时启用脚本计划`);
        }
      }
    }
    const config = await this.store.saveConfig(gameId, patch);
    this.caps.set(gameId, config.maxConcurrentScripts ?? DEFAULT_MAX_CONCURRENT_SCRIPTS);
    void this.tick(gameId);
    this.pumpAll();
    return config;
  }

  async runNow(gameId: string, accountId: string, taskId: string): Promise<PlanRun> {
    if (this.contendedGames.has(gameId)) throw new Error('另一个万龙助手进程正管理脚本计划，请在主窗口执行');
    const plugin = gamePlugin(gameId);
    const overview = await this.overview(gameId);
    const task = overview.plans.find((p) => p.accountId === accountId)?.tasks.find((t) => t.id === taskId);
    if (!task) throw new Error('计划任务不存在');
    const account = (await this.port.accounts(gameId)).find((a) => a.id === accountId);
    if (!account || !account.enabled || account.login.status !== 'ready' || !account.binding) throw new Error('账号尚未启用、完成登录并绑定实例');
    if (account.packageName !== plugin.packageName) throw new Error('账号对应的游戏包名不一致');
    if (await this.port.gatherScheduleEnabled(gameId, account.binding.index)) throw new Error('请先关闭该实例的自动采集调度');
    const run = this.newRun(gameId, account.id, account.name, account.binding.index, task.id, task.scriptId, task.priority);
    await this.store.enqueueManual(gameId, account.id, task.id, run);
    this.enqueue(run);
    return run;
  }

  /**
   * Run any script on one instance right now (authoring / testing; original run:start). An account is optional:
   * when given, it must be bound to this instance and logged in, and its script params apply.
   */
  async runScript(gameId: string, index: number, scriptId: string, rawOptions?: ScriptRunOptions): Promise<ScriptRunSnapshot> {
    if (this.closing) throw new Error('助手正在退出，不能启动新的脚本');
    const plugin = gamePlugin(gameId);
    const options = checkedRunOptions(rawOptions);
    const config = (await this.overview(gameId)).config;
    // Admission is synchronous after the last await: two requests can never claim one instance.
    if (this.isActiveForInstance(index)) throw new Error(`实例 #${index} 上已有脚本在运行或排队，请先停止后再试`);
    const cap = config.maxConcurrentScripts ?? DEFAULT_MAX_CONCURRENT_SCRIPTS;
    if (this.scriptSlotsInUse() >= cap) {
      throw new Error(`同时运行的脚本已达上限 ${cap} 个。请先停掉一个正在跑的脚本，或在「任务计划」页「调度设置」的「同时运行脚本上限」里调高（不建议超过 4 个）。`);
    }
    const runId = randomUUID();
    const release = this.runner.reserve(index, runId);
    const controller = new AbortController();
    const record: Manual = { runId, gameId, controller, done: Promise.resolve() };
    this.manual.set(index, record);
    let lease: Lease | null = null;
    let giveBack: (() => void) | null = null;
    const cleanup = async (): Promise<void> => {
      try { giveBack?.(); } catch (error) { console.error('[plan] 恢复自动采集失败', error); }
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
      if (this.port.suspendForScript) giveBack = await this.port.suspendForScript(gameId, index, `临时运行脚本「${script.name}」`);
      else if (await this.port.gatherScheduleEnabled(gameId, index)) throw new Error('该实例正在自动采集，请先关闭自动采集调度后再运行脚本');
      lease = await this.acquireLease(index, MANUAL_LEASE_WAIT_MS);
      const shotPolicy = options.shotPolicy ?? await this.defaultShotPolicy();
      const params = mergeParams(script, accountScriptParams(account, script.id), options.params);
      const assertOwnership = account ? this.ownershipCheck(gameId, account.id, index, identity, plugin.packageName) : undefined;
      const maxRunMs = options.maxRunMinutes > 0 ? options.maxRunMinutes * 60_000 : null;
      record.done = this.runner.run({
        runId, gameId, packageName: plugin.packageName, instanceIndex: index, instanceIdentity: identity, script, params,
        accountId: account?.id ?? null, accountName: account?.name ?? null, source: 'manual', taskId: null, templateDir: dir || null,
        shotPolicy, maxRunMs, signal: controller.signal, assertOwnership,
      }).then(() => undefined, (error: unknown) => console.error('[plan] 临时脚本执行失败', error)).finally(() => cleanup());
      return {
        runId, scriptId: script.id, scriptName: script.name, instanceIndex: index, accountId: account?.id ?? null, accountName: account?.name ?? null,
        status: 'starting', startedAt: Date.now(), endedAt: null, stepDone: 0, stepTotal: script.loop ? null : script.steps.length,
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
    const lease = await this.acquireLease(index, MANUAL_LEASE_WAIT_MS);
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

  async cancelRun(gameId: string, runId: string): Promise<void> {
    gamePlugin(gameId);
    for (const [index, list] of this.queues) {
      const n = list.findIndex((run) => run.gameId === gameId && run.runId === runId);
      if (n >= 0) {
        const [run] = list.splice(n, 1);
        if (!list.length) this.queues.delete(index);
        if (run) await this.finish(run, 'cancelled', '用户取消排队');
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
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const timer of this.capRetries.values()) clearTimeout(timer);
    this.capRetries.clear();
    for (const active of this.active.values()) active.controller.abort(new Error('助手正在退出'));
    for (const manual of this.manual.values()) manual.controller.abort(new Error('助手正在退出'));
    await Promise.allSettled([...this.active.values(), ...this.manual.values()].map((item) => item.done));
    for (const list of this.queues.values()) for (const run of list) await this.finish(run, 'skipped', '助手退出，未开始执行');
    this.queues.clear();
    await this.runner.dispose();
    await Promise.allSettled([...this.ownerLeases.values()].map((lease) => lease.release()));
    this.ownerLeases.clear();
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

  /** Hold `run/automation-instance-<i>.lock` until `release()` (entered / held pair around withFileLock). */
  private async acquireLease(index: number, timeoutMs: number): Promise<Lease> {
    const lock = path.join(this.home, 'run', `automation-instance-${index}.lock`);
    let entered!: () => void;
    let exit!: () => void;
    const acquired = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { exit = resolve; });
    const lockDone = withFileLock(lock, async () => { entered(); await held; }, { timeoutMs });
    try { await Promise.race([acquired, lockDone]); }
    catch (error) {
      if ((error as { code?: string }).code === 'LOCK_TIMEOUT') throw new Error(`实例 #${index} 正被登录、采集或脚本计划占用，请稍后再试`);
      throw error;
    }
    return { release: async () => { exit(); await lockDone.catch(() => undefined); } };
  }

  private newRun(gameId: string, accountId: string, accountName: string, index: number, taskId: string, scriptId: string, priority: number): PlanRun {
    return { runId: randomUUID(), gameId, accountId, accountName, instanceIndex: index, taskId, scriptId,
      priority, status: 'queued', queuedAt: Date.now(), startedAt: null, endedAt: null, message: '等待实例空闲', stepId: null };
  }

  private async tick(gameId: string): Promise<void> {
    if (this.closing || !this.ownerLeases.has(gameId) || !this.games.has(gameId) || this.ticking.has(gameId)) return;
    this.ticking.add(gameId);
    try {
      const overview = await this.overview(gameId);
      if (!overview.config.enabled) return;
      const accounts = new Map((await this.port.accounts(gameId)).map((a) => [a.id, a]));
      for (const plan of overview.plans) {
        if (!plan.enabled) continue;
        const account = accounts.get(plan.accountId);
        if (!account?.enabled || account.login.status !== 'ready' || !account.binding) continue;
        const index = account.binding.index;
        for (const task of plan.tasks) {
          if (!task.enabled || task.trigger.kind === 'manual') continue;
          const run = this.newRun(gameId, account.id, account.name, index, task.id, task.scriptId, task.priority);
          const claimed = await this.store.claimScheduled(gameId, account.id, task.id, run);
          if (claimed) this.enqueue(claimed);
        }
      }
    } finally { this.ticking.delete(gameId); }
  }

  private enqueue(run: PlanRun): void {
    const list = this.queues.get(run.instanceIndex) ?? [];
    // A task cannot stack while a previous run is pending or active.
    if (list.some((r) => r.gameId === run.gameId && r.accountId === run.accountId && r.taskId === run.taskId) ||
      [...this.active.values()].some((a) => a.run.gameId === run.gameId && a.run.accountId === run.accountId && a.run.taskId === run.taskId)) {
      void this.finish(run, 'skipped', '同一任务已在运行或排队');
      return;
    }
    list.push(run);
    list.sort((a, b) => b.priority - a.priority || a.queuedAt - b.queuedAt);
    this.queues.set(run.instanceIndex, list);
    this.port.onRun?.({ ...run });
    this.pump(run.instanceIndex);
  }

  private pumpAll(): void {
    for (const index of [...this.queues.keys()]) this.pump(index);
  }

  private pump(index: number): void {
    if (this.closing || this.active.has(index) || this.manual.has(index) || this.runner.runIdOfInstance(index)) return;
    const list = this.queues.get(index);
    const next = list?.[0];
    if (!next) return;
    // Global cap: defer (back-off), never fail — the original CONCURRENCY_LIMIT rule.
    const cap = this.caps.get(next.gameId) ?? DEFAULT_MAX_CONCURRENT_SCRIPTS;
    if (this.scriptSlotsInUse() >= cap) {
      if (!this.capRetries.has(index)) {
        const timer = setTimeout(() => { this.capRetries.delete(index); this.pump(index); }, CAP_RETRY_MS);
        timer.unref?.();
        this.capRetries.set(index, timer);
      }
      return;
    }
    const run = list!.shift()!;
    if (!list!.length) this.queues.delete(index);
    const controller = new AbortController();
    const active: Active = { run, controller, done: Promise.resolve() };
    this.active.set(index, active);
    active.done = this.execute(run, controller.signal).finally(() => {
      if (this.active.get(index) === active) this.active.delete(index);
      this.pump(index);
      this.pumpAll();
    });
  }

  private async execute(run: PlanRun, signal: AbortSignal): Promise<void> {
    let doneMessage = '脚本执行完成';
    try {
      const overview = await this.overview(run.gameId);
      const config = overview.config;
      const task = overview.plans.find((p) => p.accountId === run.accountId)?.tasks.find((t) => t.id === run.taskId);
      if (!task) throw new RunEndedError('任务已从计划中删除', 'skipped');
      if (Date.now() - run.queuedAt > config.queueWaitMs) throw new RunEndedError('等待实例超时', 'skipped');
      const account = (await this.port.accounts(run.gameId)).find((a) => a.id === run.accountId);
      if (!account?.enabled || account.login.status !== 'ready' || !account.binding || account.binding.index !== run.instanceIndex) {
        throw new RunEndedError('账号绑定或登录状态已变化', 'failed');
      }
      if (await this.port.gatherScheduleEnabled(run.gameId, run.instanceIndex)) throw new RunEndedError('自动采集已启用，脚本计划本轮跳过', 'skipped');
      const lock = path.join(this.home, 'run', `automation-instance-${run.instanceIndex}.lock`);
      await withFileLock(lock, async () => {
        if (signal.aborted) throw signal.reason;
        const expectedIdentity = account.binding!.instanceCreatedAt;
        const plugin = gamePlugin(run.gameId);
        const pkg = plugin.packageName;
        const assertAccount = this.ownershipCheck(run.gameId, run.accountId, run.instanceIndex, expectedIdentity, pkg);
        await assertAccount();
        const state = await this.port.instance(run.instanceIndex);
        if (state.status !== 'running' || state.record.createdAt !== expectedIdentity) throw new RunEndedError('实例未运行或已被替换', 'skipped');
        if (await this.port.gatherScheduleEnabled(run.gameId, run.instanceIndex)) throw new RunEndedError('自动采集已启用，脚本计划本轮跳过', 'skipped');
        const script = await this.getScript(run.gameId, run.scriptId);
        if (!startsWithLaunch(script, pkg)) {
          const foreground = await (await this.port.device(run.instanceIndex)).foregroundPackage();
          if (foreground !== pkg) throw new RunEndedError(`目标游戏未在前台（当前 ${foreground ?? '未知'}）`, 'failed');
        }
        const dir = await this.port.templateDir(run.gameId, run.instanceIndex);
        try { await this.checkRunnable(run.gameId, script, dir); }
        catch (error) { throw new RunEndedError(error instanceof Error ? error.message : String(error), 'failed'); }
        const startedAt = Date.now();
        Object.assign(run, { status: 'running', startedAt, message: `正在执行 ${script.name}` });
        await this.store.updateRun(run.gameId, run.runId, { status: 'running', startedAt, message: run.message });
        this.port.onRun?.({ ...run });
        const shotPolicy = await this.defaultShotPolicy();
        const params = mergeParams(script, accountScriptParams(account, script.id), task.params);
        for (let attempt = 0; attempt <= config.retry; attempt++) {
          const result = await this.runner.run({
            runId: run.runId, gameId: run.gameId, packageName: pkg, instanceIndex: run.instanceIndex, instanceIdentity: expectedIdentity,
            script, params, accountId: account.id, accountName: account.name, source: 'plan', taskId: run.taskId,
            templateDir: dir || null, shotPolicy, maxRunMs: task.maxRunMinutes > 0 ? task.maxRunMinutes * 60_000 : null,
            signal, assertOwnership: assertAccount,
          });
          if (result.status === 'succeeded') {
            // A loop script ends only by a stop or the task's time limit: running the limit out is its planned end.
            if (result.timedOut) doneMessage = `循环脚本已运行满本次上限 ${task.maxRunMinutes} 分钟，按时结束（完成 ${result.iteration} 轮）`;
            return;
          }
          if (result.status === 'aborted' || signal.aborted) throw new RunEndedError(signal.reason instanceof Error ? signal.reason.message : '脚本已停止', 'cancelled');
          // ★ Original (plan awaitRun / settle): a run stopped by the time limit is never retried — a script stuck
          // for maxRunMinutes would only be stuck again, holding the instance for another full limit.
          if (result.timedOut) throw new RunEndedError(result.error ?? `脚本运行超过本次上限 ${task.maxRunMinutes} 分钟，已停止`, 'failed');
          if (attempt === config.retry) throw new RunEndedError(result.error ?? '脚本执行失败', 'failed');
          await abortableDelay(config.retryDelayMs, signal);
        }
      }, { timeoutMs: config.queueWaitMs });
      await this.finish(run, 'succeeded', doneMessage);
    } catch (error) {
      // Persisted in plans.json: never with a device serial or an adb command line.
      const message = safeErrorMessage(error);
      const status: PlanRun['status'] = signal.aborted ? 'cancelled'
        : error instanceof RunEndedError ? error.status
          : (error as { code?: string }).code === 'LOCK_TIMEOUT' ? 'skipped' : 'failed';
      await this.finish(run, status, (error as { code?: string }).code === 'LOCK_TIMEOUT' ? '等待实例空闲超时' : message);
    }
  }

  private async finish(run: PlanRun, status: PlanRun['status'], message: string): Promise<void> {
    const endedAt = Date.now();
    Object.assign(run, { status, endedAt, message, stepId: null });
    try { await this.store.updateRun(run.gameId, run.runId, { status, endedAt, message, stepId: null }); }
    catch (error) { console.error('[plan] 无法保存运行结果', error); }
    this.port.onRun?.({ ...run });
  }
}

