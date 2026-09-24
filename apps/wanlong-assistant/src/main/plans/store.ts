import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { withFileLock } from '@avdm/core';
import { dueAt, parseClock } from './clock';
import type { AccountPlan, PlanConfig, PlanOverview, PlanRun, PlanTask, TaskRuntime, TaskTrigger } from './types';

const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/;
const FILE_LIMIT = 2 * 1024 * 1024;
const MAX_RUNS = 200;
const MAX_PLANS = 512;
const MAX_TASKS = 100;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const bounded = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;

export function defaultPlanConfig(): PlanConfig {
  return { version: 1, enabled: false, catchUpMs: 30 * 60_000, queueWaitMs: 30 * 60_000, retry: 0, retryDelayMs: 60_000, maxConcurrentScripts: 4 };
}

export function validateTrigger(value: unknown): asserts value is TaskTrigger {
  if (!record(value)) throw new Error('触发方式无效');
  if (value.kind === 'manual') return;
  if (value.kind === 'daily') {
    if (!Array.isArray(value.at) || !value.at.length || value.at.length > 24 ||
      !value.at.every((v: unknown) => typeof v === 'string' && parseClock(v) !== null)) throw new Error('每日时间必须是 HH:MM');
    return;
  }
  if (value.kind === 'interval') {
    if (!Number.isInteger(value.everyMinutes) || !bounded(value.everyMinutes, 1, 1440)) throw new Error('间隔必须为 1–1440 分钟');
    if (value.window !== undefined && (!record(value.window) || typeof value.window.from !== 'string' ||
      typeof value.window.to !== 'string' || parseClock(value.window.from) === null || parseClock(value.window.to) === null)) {
      throw new Error('北京时间窗口无效');
    }
    return;
  }
  throw new Error('触发方式不受支持');
}

export function validatePlan(value: unknown): asserts value is AccountPlan {
  if (!record(value) || typeof value.accountId !== 'string' || !/^[0-9a-f-]{36}$/i.test(value.accountId) ||
    typeof value.enabled !== 'boolean' || !Array.isArray(value.tasks) || value.tasks.length > MAX_TASKS) throw new Error('账号计划无效');
  const ids = new Set<string>();
  for (const raw of value.tasks) {
    if (!record(raw) || typeof raw.id !== 'string' || !ID.test(raw.id) || ids.has(raw.id) ||
      typeof raw.scriptId !== 'string' || !ID.test(raw.scriptId) || typeof raw.enabled !== 'boolean' ||
      !Number.isInteger(raw.priority) || !bounded(raw.priority, 0, 100) ||
      !Number.isInteger(raw.maxRunMinutes) || !bounded(raw.maxRunMinutes, 1, 120)) throw new Error('计划任务字段无效或 id 重复');
    ids.add(raw.id);
    validateTrigger(raw.trigger);
    if (raw.params !== undefined && (!record(raw.params) || Object.keys(raw.params).length > 50 ||
      !Object.entries(raw.params).every(([key, val]) => ID.test(key) && (typeof val === 'string' && val.length <= 2048 ||
        typeof val === 'boolean' || typeof val === 'number' && Number.isFinite(val))))) throw new Error('任务参数无效');
    if (raw.note !== undefined && (typeof raw.note !== 'string' || raw.note.length > 1000)) throw new Error('任务备注过长');
  }
}

interface PlanFile { version: 1; config: PlanConfig; plans: AccountPlan[]; runtime: TaskRuntime[]; runs: PlanRun[] }
const fresh = (): PlanFile => ({ version: 1, config: defaultPlanConfig(), plans: [], runtime: [], runs: [] });

function checkedConfig(raw: unknown): PlanConfig {
  if (!record(raw) || raw.version !== 1 || typeof raw.enabled !== 'boolean' ||
    !bounded(raw.catchUpMs, 0, 12 * 3_600_000) || !bounded(raw.queueWaitMs, 60_000, 12 * 3_600_000) ||
    !Number.isInteger(raw.retry) || !bounded(raw.retry, 0, 5) || !bounded(raw.retryDelayMs, 0, 30 * 60_000) ||
    (raw.maxConcurrentScripts !== undefined && (!Number.isInteger(raw.maxConcurrentScripts) || !bounded(raw.maxConcurrentScripts, 1, 16)))) {
    throw new Error('计划配置无效');
  }
  // Files written before the global script cap existed get the default (original MAX_CONCURRENT_INSTANCES = 4).
  return { ...raw, maxConcurrentScripts: raw.maxConcurrentScripts ?? 4 } as unknown as PlanConfig;
}

function checkedFile(raw: unknown): PlanFile {
  if (!record(raw) || raw.version !== 1 || !Array.isArray(raw.plans) || raw.plans.length > MAX_PLANS ||
    !Array.isArray(raw.runtime) || !Array.isArray(raw.runs) || raw.runs.length > MAX_RUNS) throw new Error('计划文件格式不兼容');
  const config = checkedConfig(raw.config);
  const plans = raw.plans as unknown[];
  for (const one of plans) validatePlan(one);
  if (new Set(plans.map((p) => (p as AccountPlan).accountId)).size !== plans.length) throw new Error('账号计划重复');
  const runtime = raw.runtime as unknown[];
  for (const row of runtime) {
    if (!record(row) || typeof row.accountId !== 'string' || typeof row.taskId !== 'string' ||
      ![null, 'succeeded', 'failed', 'cancelled', 'skipped'].includes(row.lastResult as string | null) ||
      !['lastClaimedAt', 'lastStartedAt', 'lastEndedAt'].every((key) => row[key] === null || bounded(row[key], 0, Number.MAX_SAFE_INTEGER)) ||
      !bounded(row.runs, 0, Number.MAX_SAFE_INTEGER) || !bounded(row.fails, 0, Number.MAX_SAFE_INTEGER)) throw new Error('计划运行计数损坏');
  }
  for (const row of raw.runs) if (!record(row) || typeof row.runId !== 'string' ||
    !bounded(row.queuedAt, 0, Number.MAX_SAFE_INTEGER) || !bounded(row.priority, 0, 100) ||
    !['queued', 'running', 'succeeded', 'failed', 'cancelled', 'skipped'].includes(String(row.status))) throw new Error('计划运行记录损坏');
  return { version: 1, config, plans: plans as AccountPlan[], runtime: runtime as TaskRuntime[], runs: raw.runs as PlanRun[] };
}

function runtimeOf(data: PlanFile, accountId: string, taskId: string): TaskRuntime {
  let row = data.runtime.find((r) => r.accountId === accountId && r.taskId === taskId);
  if (!row) {
    row = { accountId, taskId, lastClaimedAt: null, lastStartedAt: null, lastEndedAt: null,
      lastResult: null, lastError: null, runs: 0, fails: 0 };
    data.runtime.push(row);
  }
  return row;
}

/** All edits are private, atomic, and serialized across Assistant processes. */
export class PlanStore {
  constructor(private readonly home: string) { if (!path.isAbsolute(home)) throw new Error('计划数据目录必须是绝对路径'); }
  private file(gameId: string): string {
    if (!ID.test(gameId)) throw new Error('游戏编号无效');
    return path.join(this.home, 'automation', 'games', gameId, 'plans.json');
  }
  private async read(gameId: string): Promise<PlanFile> {
    const file = this.file(gameId);
    let info;
    try { info = await lstat(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fresh(); throw error; }
    if (!info.isFile() || info.isSymbolicLink() || info.size > FILE_LIMIT) throw new Error('计划文件无效或超过 2 MB');
    return checkedFile(JSON.parse(await readFile(file, 'utf8')) as unknown);
  }
  private async write(gameId: string, data: PlanFile): Promise<void> {
    checkedFile(data);
    const file = this.file(gameId);
    const json = JSON.stringify(data, null, 2) + '\n';
    if (Buffer.byteLength(json) > FILE_LIMIT) throw new Error('计划文件超过 2 MB');
    await mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temp, 'wx', 0o600);
      try { await handle.writeFile(json); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temp, file);
      await chmod(file, 0o600);
    } catch (error) { await rm(temp, { force: true }).catch(() => undefined); throw error; }
  }
  private async change<T>(gameId: string, fn: (data: PlanFile) => T | Promise<T>): Promise<T> {
    const file = this.file(gameId);
    return withFileLock(`${file}.lock`, async () => {
      const data = await this.read(gameId);
      const result = await fn(data);
      await this.write(gameId, data);
      return result;
    });
  }
  async overview(gameId: string): Promise<PlanOverview> {
    const data = await this.read(gameId);
    return { config: data.config, plans: data.plans, runtime: data.runtime, runs: data.runs, at: Date.now() };
  }
  async saveConfig(gameId: string, patch: Partial<PlanConfig>): Promise<PlanConfig> {
    return this.change(gameId, (data) => {
      data.config = checkedConfig({ ...data.config, ...patch, version: 1 });
      return structuredClone(data.config);
    });
  }
  async savePlan(gameId: string, plan: AccountPlan): Promise<AccountPlan> {
    validatePlan(plan);
    return this.change(gameId, (data) => {
      const next = { ...structuredClone(plan), updatedAt: Date.now() };
      const index = data.plans.findIndex((p) => p.accountId === next.accountId);
      if (index >= 0) data.plans[index] = next;
      else { if (data.plans.length >= MAX_PLANS) throw new Error('计划账号数量达到上限'); data.plans.push(next); }
      const alive = new Set(next.tasks.map((task) => task.id));
      data.runtime = data.runtime.filter((row) => row.accountId !== next.accountId || alive.has(row.taskId));
      return next;
    });
  }
  async claimScheduled(gameId: string, accountId: string, taskId: string, run: PlanRun, now = Date.now()): Promise<PlanRun | null> {
    return this.change(gameId, (data) => {
      const plan = data.plans.find((p) => p.accountId === accountId);
      const task = plan?.tasks.find((t) => t.id === taskId);
      if (!data.config.enabled || !plan?.enabled || !task?.enabled) return null;
      const runtime = runtimeOf(data, accountId, taskId);
      const due = dueAt(task.trigger, now, runtime.lastClaimedAt, plan.updatedAt);
      if (due === null || now - due > data.config.catchUpMs) return null;
      runtime.lastClaimedAt = now;
      data.runs.unshift(run);
      data.runs = data.runs.slice(0, MAX_RUNS);
      return run;
    });
  }
  async enqueueManual(gameId: string, accountId: string, taskId: string, run: PlanRun): Promise<PlanRun> {
    return this.change(gameId, (data) => {
      const task = data.plans.find((p) => p.accountId === accountId)?.tasks.find((t) => t.id === taskId);
      if (!task) throw new Error('计划任务不存在');
      data.runs.unshift(run);
      data.runs = data.runs.slice(0, MAX_RUNS);
      return run;
    });
  }
  async updateRun(gameId: string, runId: string, patch: Partial<PlanRun>): Promise<PlanRun> {
    return this.change(gameId, (data) => {
      const run = data.runs.find((r) => r.runId === runId);
      if (!run) throw new Error('运行记录不存在');
      Object.assign(run, patch);
      if (patch.status === 'running') {
        const rt = runtimeOf(data, run.accountId, run.taskId);
        rt.lastStartedAt = patch.startedAt ?? Date.now();
        rt.runs++;
      } else if (patch.status === 'succeeded' || patch.status === 'failed' || patch.status === 'cancelled' || patch.status === 'skipped') {
        const rt = runtimeOf(data, run.accountId, run.taskId);
        rt.lastEndedAt = patch.endedAt ?? Date.now();
        rt.lastResult = patch.status;
        rt.lastError = patch.status === 'succeeded' ? null : (patch.message ?? run.message);
        if (patch.status === 'failed') rt.fails++;
      }
      return structuredClone(run);
    });
  }
  async recoverInterrupted(gameId: string): Promise<number> {
    return this.change(gameId, (data) => {
      let count = 0;
      for (const run of data.runs) if (run.status === 'queued' || run.status === 'running') {
        run.status = 'skipped'; run.message = '助手上次退出，已停止未完成任务'; run.endedAt = Date.now();
        const rt = runtimeOf(data, run.accountId, run.taskId);
        rt.lastEndedAt = run.endedAt; rt.lastResult = 'skipped'; rt.lastError = run.message;
        count++;
      }
      return count;
    });
  }
}
