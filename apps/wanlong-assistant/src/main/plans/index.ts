import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { withFileLock } from '@avdm/core';
import { loadTemplateSet } from '@avdm/automation';
import { gamePlugin } from '../automation/games';
import { executeScript, ExecutionGuardError } from './engine';
import { ScriptStore, validateScript } from './scripts';
import { PlanStore } from './store';
import type { AccountPlan, PlanConfig, PlanHostPort, PlanOverview, PlanRun, ScriptDef, ScriptIssue, ScriptMeta } from './types';

export type { AccountPlan, PlanConfig, PlanOverview, PlanRun, PlanTask, ScriptDef, ScriptMeta, TaskTrigger } from './types';
export { defaultPlanConfig } from './store';

interface Active { run: PlanRun; controller: AbortController; done: Promise<void> }
interface Lease { release(): Promise<void> }
const MAX_LOG_LINE = 4096;
const MAX_SHOTS = 100;
const MAX_SHOT_BYTES = 16 * 1024 * 1024;

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

/** Game-scoped task plans and JSON scripts. One AVD receives one writer at a time across processes. */
export class PlanService {
  readonly store: PlanStore;
  readonly scripts: ScriptStore;
  private readonly queues = new Map<number, PlanRun[]>();
  private readonly active = new Map<number, Active>();
  private readonly games = new Set<string>();
  private readonly contendedGames = new Set<string>();
  private readonly ownerLeases = new Map<string, Lease>();
  private readonly ticking = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private closing = false;

  constructor(private readonly home: string, private readonly port: PlanHostPort) {
    if (!path.isAbsolute(home)) throw new Error('计划根目录必须是绝对路径');
    this.store = new PlanStore(home);
    this.scripts = new ScriptStore(home);
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

  overview(gameId: string): Promise<PlanOverview> { gamePlugin(gameId); return this.store.overview(gameId); }
  isActiveForInstance(index: number): boolean { return this.active.has(index) || (this.queues.get(index)?.length ?? 0) > 0; }
  async hasEnabledPlanForInstance(gameId: string, index: number): Promise<boolean> {
    const overview = await this.overview(gameId);
    if (!overview.config.enabled) return false;
    const accounts = new Map((await this.port.accounts(gameId)).map((account) => [account.id, account]));
    return overview.plans.some((plan) => plan.enabled && plan.tasks.some((task) => task.enabled && task.trigger.kind !== 'manual') &&
      accounts.get(plan.accountId)?.enabled && accounts.get(plan.accountId)?.binding?.index === index);
  }
  listScripts(gameId: string): Promise<ScriptMeta[]> { gamePlugin(gameId); return this.scripts.list(gameId); }
  getScript(gameId: string, id: string): Promise<ScriptDef> { gamePlugin(gameId); return this.scripts.get(gameId, id); }
  validateScript(gameId: string, raw: unknown): ScriptIssue[] { return validateScript(raw, gamePlugin(gameId).packageName); }
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
    const available = new Set((await this.scripts.list(gameId)).filter((s) => s.version !== '0').map((s) => s.id));
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
    void this.tick(gameId);
    return config;
  }

  async runNow(gameId: string, accountId: string, taskId: string): Promise<PlanRun> {
    if (this.contendedGames.has(gameId)) throw new Error('另一个万龙助手进程正管理脚本计划，请在主窗口执行');
    const plugin = gamePlugin(gameId);
    const overview = await this.store.overview(gameId);
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
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const active of this.active.values()) active.controller.abort(new Error('助手正在退出'));
    await Promise.allSettled([...this.active.values()].map((item) => item.done));
    for (const list of this.queues.values()) for (const run of list) await this.finish(run, 'skipped', '助手退出，未开始执行');
    this.queues.clear();
    await Promise.allSettled([...this.ownerLeases.values()].map((lease) => lease.release()));
    this.ownerLeases.clear();
  }

  private newRun(gameId: string, accountId: string, accountName: string, index: number, taskId: string, scriptId: string, priority: number): PlanRun {
    return { runId: randomUUID(), gameId, accountId, accountName, instanceIndex: index, taskId, scriptId,
      priority, status: 'queued', queuedAt: Date.now(), startedAt: null, endedAt: null, message: '等待实例空闲', stepId: null };
  }

  private async tick(gameId: string): Promise<void> {
    if (this.closing || !this.ownerLeases.has(gameId) || !this.games.has(gameId) || this.ticking.has(gameId)) return;
    this.ticking.add(gameId);
    try {
      const overview = await this.store.overview(gameId);
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
    this.port.onRun?.(run);
    this.pump(run.instanceIndex);
  }

  private pump(index: number): void {
    if (this.closing || this.active.has(index)) return;
    const list = this.queues.get(index);
    const run = list?.shift();
    if (!run) return;
    if (!list?.length) this.queues.delete(index);
    const controller = new AbortController();
    const active: Active = { run, controller, done: Promise.resolve() };
    this.active.set(index, active);
    active.done = this.execute(run, controller.signal).finally(() => {
      if (this.active.get(index) === active) this.active.delete(index);
      this.pump(index);
    });
  }

  private async execute(run: PlanRun, signal: AbortSignal): Promise<void> {
    try {
      const overview = await this.store.overview(run.gameId);
      const config = overview.config;
      const task = overview.plans.find((p) => p.accountId === run.accountId)?.tasks.find((t) => t.id === run.taskId);
      if (!task) throw new Error('任务已从计划中删除');
      if (Date.now() - run.queuedAt > config.queueWaitMs) throw new Error('等待实例超时');
      const account = (await this.port.accounts(run.gameId)).find((a) => a.id === run.accountId);
      if (!account?.enabled || account.login.status !== 'ready' || !account.binding || account.binding.index !== run.instanceIndex) throw new Error('账号绑定或登录状态已变化');
      if (await this.port.gatherScheduleEnabled(run.gameId, run.instanceIndex)) throw new Error('自动采集已启用，脚本计划本轮跳过');
      const lock = path.join(this.home, 'run', `automation-instance-${run.instanceIndex}.lock`);
      await withFileLock(lock, async () => {
        if (signal.aborted) throw signal.reason;
        const expectedIdentity = account.binding!.instanceCreatedAt;
        const pkg = gamePlugin(run.gameId).packageName;
        const assertAccount = async (): Promise<void> => {
          if (signal.aborted) throw signal.reason ?? new Error('脚本已取消');
          const current = (await this.port.accounts(run.gameId)).find((item) => item.id === run.accountId);
          if (!current?.enabled || current.login.status !== 'ready' || current.packageName !== pkg ||
              current.binding?.index !== run.instanceIndex || current.binding.instanceCreatedAt !== expectedIdentity) {
            throw new ExecutionGuardError('账号已禁用、退出登录或绑定发生变化，脚本已停止');
          }
          const state = await this.port.instance(run.instanceIndex);
          if (state.status !== 'running' || state.record.createdAt !== expectedIdentity) {
            throw new ExecutionGuardError('实例已停止或被替换，脚本已停止');
          }
        };
        await assertAccount();
        if (await this.port.gatherScheduleEnabled(run.gameId, run.instanceIndex)) throw new Error('自动采集已启用，脚本计划本轮跳过');
        const device = await this.port.device(run.instanceIndex);
        const foreground = await device.foregroundPackage();
        if (foreground !== pkg) throw new Error(`目标游戏未在前台（当前 ${foreground ?? '未知'}）`);
        const script = await this.scripts.get(run.gameId, run.scriptId);
        const dir = await this.port.templateDir(run.gameId, run.instanceIndex);
        const templateSet = dir ? await loadTemplateSet(dir) : null;
        const errors = validateScript(script, pkg, templateSet?.templates.map((t) => t.id)).filter((i) => i.level === 'error');
        if (errors.length) throw new Error(`脚本校验失败：${errors.map((i) => i.message).join('；')}`);
        const startedAt = Date.now();
        Object.assign(run, { status: 'running', startedAt, message: `正在执行 ${script.name}` });
        await this.store.updateRun(run.gameId, run.runId, { status: 'running', startedAt, message: run.message });
        this.port.onRun?.({ ...run });
        const shotsDir = path.join(this.home, 'automation', 'games', run.gameId, 'runs', run.runId, 'shots');
        let shotNo = 0;
        const shot = async (label: string, png: Uint8Array): Promise<void> => {
          if (++shotNo > MAX_SHOTS || png.byteLength > MAX_SHOT_BYTES) throw new Error('截图留痕超过安全上限');
          await mkdir(shotsDir, { recursive: true });
          const safe = label.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80);
          const file = path.join(shotsDir, `${String(shotNo).padStart(3, '0')}-${safe}.png`);
          const handle = await open(file, 'wx', 0o600);
          try { await handle.writeFile(png); await handle.sync(); }
          finally { await handle.close(); }
          await chmod(file, 0o600);
        };
        const logFile = path.join(this.home, 'automation', 'games', run.gameId, 'runs', run.runId, 'events.ndjson');
        await mkdir(path.dirname(logFile), { recursive: true });
        const logs = await open(logFile, 'a', 0o600);
        let logTail: Promise<void> = Promise.resolve();
        try {
          let lastStepAt = 0;
          for (let attempt = 0; attempt <= config.retry; attempt++) {
            try {
              await executeScript({ script, device, templateDir: dir, signal, params: task.params, assertAccount,
                maxRunMs: task.maxRunMinutes * 60_000,
                onStep: (step) => {
                  run.stepId = step.id;
                  if (Date.now() - lastStepAt > 500) { this.port.onRun?.({ ...run }); lastStepAt = Date.now(); }
                },
                onLog: (level, message, stepId) => {
                  const line = JSON.stringify({ at: Date.now(), level, stepId, message: message.slice(0, MAX_LOG_LINE) }) + '\n';
                  logTail = logTail.then(() => logs.appendFile(line));
                },
                onScreenshot: shot,
              });
              return;
            } catch (error) {
              if (signal.aborted || attempt === config.retry) throw error;
              await abortableDelay(config.retryDelayMs, signal);
            }
          }
        } finally { try { await logTail; } finally { await logs.close(); } }
      }, { timeoutMs: config.queueWaitMs });
      await this.finish(run, 'succeeded', '脚本执行完成');
    } catch (error) {
      const status = signal.aborted ? 'cancelled' : /超时|未运行|已被替换|自动采集已启用|LOCK_TIMEOUT/.test(String(error)) ? 'skipped' : 'failed';
      await this.finish(run, status, error instanceof Error ? error.message : String(error));
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
