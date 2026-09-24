import { randomUUID } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { withFileLock } from '@avdm/core';
import {
  defaultPlanConfig, dueReason, lastRunAtOf, MAX_DAILY_TIMES, MAX_NOTE_LENGTH, MAX_PLAN_TASKS, MAX_TASK_PARAMS, mergePlanConfig,
  PLAN_ACCOUNT_RE, PLAN_ID_RE, PLAN_RANGE, sanitizePlan,
  type AccountPlan, type PlanConfig, type PlanRun, type PlanRunResult, type TaskRuntime, type TaskTrigger,
} from '../../shared/plan';
import { parseClock } from './clock';

export { defaultPlanConfig } from '../../shared/plan';

const FILE_LIMIT = 2 * 1024 * 1024;
const MAX_RUNS = 200;
const MAX_PLANS = 512;
const RUN_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'skipped'] as const;
const RESULTS: ReadonlyArray<PlanRunResult | null> = [null, 'succeeded', 'failed', 'cancelled', 'skipped'];
const CONFIG_KEYS = ['version', 'enabled', 'preemptGraceMs', 'catchUpMs', 'queueWaitMs', 'retry', 'retryDelayMs', 'aiAssist', 'maxConcurrentScripts'] as const;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const bounded = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const inRange = (v: unknown, range: readonly [number, number]): v is number => bounded(v, range[0], range[1]);
const time = (v: unknown): boolean => v === null || bounded(v, 0, Number.MAX_SAFE_INTEGER);

/** Strict check of one trigger (writes). Daily times must be canonical `HH:MM` (see `normalizePlan`). */
export function validateTrigger(value: unknown): asserts value is TaskTrigger {
  if (!record(value)) throw new Error('触发方式无效');
  if (value.kind === 'manual') return;
  if (value.kind === 'daily') {
    if (!Array.isArray(value.at) || !value.at.length || value.at.length > MAX_DAILY_TIMES ||
      !value.at.every((v: unknown) => typeof v === 'string' && parseClock(v) !== null) || new Set(value.at).size !== value.at.length) {
      throw new Error(`「每天」至少要填一个时刻，最多 ${MAX_DAILY_TIMES} 个，格式是 HH:MM（北京时间），例如 08:00`);
    }
    return;
  }
  if (value.kind === 'interval') {
    if (!Number.isInteger(value.everyMinutes) || !inRange(value.everyMinutes, PLAN_RANGE.everyMinutes)) {
      throw new Error(`间隔必须为 ${PLAN_RANGE.everyMinutes[0]}–${PLAN_RANGE.everyMinutes[1]} 分钟`);
    }
    if (value.window !== undefined && (!record(value.window) || typeof value.window.from !== 'string' ||
      typeof value.window.to !== 'string' || parseClock(value.window.from) === null || parseClock(value.window.to) === null)) {
      throw new Error('时段的起止时刻要写成 HH:MM（北京时间），例如 09:00 至 23:00');
    }
    return;
  }
  throw new Error('触发方式不受支持');
}

/** Strict check of one account plan (writes). */
export function validatePlan(value: unknown): asserts value is AccountPlan {
  if (!record(value) || typeof value.accountId !== 'string' || !PLAN_ACCOUNT_RE.test(value.accountId) ||
    typeof value.enabled !== 'boolean' || !Array.isArray(value.tasks)) throw new Error('账号计划无效');
  if (value.tasks.length > MAX_PLAN_TASKS) throw new Error(`一个账号最多 ${MAX_PLAN_TASKS} 条任务`);
  const ids = new Set<string>();
  for (const raw of value.tasks) {
    if (!record(raw) || typeof raw.id !== 'string' || !PLAN_ID_RE.test(raw.id) || ids.has(raw.id) ||
      typeof raw.scriptId !== 'string' || !PLAN_ID_RE.test(raw.scriptId) || typeof raw.enabled !== 'boolean') {
      throw new Error('计划任务字段无效或 id 重复');
    }
    if (!Number.isInteger(raw.priority) || !inRange(raw.priority, PLAN_RANGE.priority)) {
      throw new Error(`优先级要是 ${PLAN_RANGE.priority[0]}–${PLAN_RANGE.priority[1]} 的整数`);
    }
    if (!Number.isInteger(raw.maxRunMinutes) || !inRange(raw.maxRunMinutes, PLAN_RANGE.maxRunMinutes)) {
      throw new Error(`单次时间上限要是 ${PLAN_RANGE.maxRunMinutes[0]}–${PLAN_RANGE.maxRunMinutes[1]} 分钟的整数（0 表示不限）`);
    }
    ids.add(raw.id);
    validateTrigger(raw.trigger);
    if (raw.params !== undefined && (!record(raw.params) || Object.keys(raw.params).length > MAX_TASK_PARAMS ||
      !Object.entries(raw.params).every(([key, val]) => PLAN_ID_RE.test(key) && (typeof val === 'string' && val.length <= 2048 ||
        typeof val === 'boolean' || typeof val === 'number' && Number.isFinite(val))))) throw new Error('任务参数无效');
    if (raw.note !== undefined && (typeof raw.note !== 'string' || raw.note.length > MAX_NOTE_LENGTH)) throw new Error('任务备注过长');
  }
}

/** Canonical form before validation: trimmed, deduplicated and sorted daily times; empty note / params dropped. */
export function normalizePlan(plan: AccountPlan): AccountPlan {
  const next = structuredClone(plan);
  if (!Array.isArray(next.tasks)) return next;
  next.tasks = next.tasks.map((task) => {
    if (!record(task)) return task;
    const out = { ...task };
    if (record(out.trigger) && out.trigger.kind === 'daily' && Array.isArray(out.trigger.at)) {
      const at = out.trigger.at.map((value) => typeof value === 'string' ? value.trim() : value);
      out.trigger = { kind: 'daily', at: at.every((value) => typeof value === 'string') ? [...new Set(at as string[])].sort() : at as string[] };
    }
    if (record(out.trigger) && out.trigger.kind === 'interval' && record(out.trigger.window)) {
      out.trigger = { ...out.trigger, window: { from: String(out.trigger.window.from).trim(), to: String(out.trigger.window.to).trim() } };
    }
    if (typeof out.note === 'string') {
      const note = out.note.trim();
      if (note) out.note = note; else delete out.note;
    }
    if (record(out.params) && Object.keys(out.params).length === 0) delete out.params;
    return out;
  });
  return next;
}

interface PlanFile { version: 1; config: PlanConfig; plans: AccountPlan[]; runtime: TaskRuntime[]; runs: PlanRun[] }
const fresh = (): PlanFile => ({ version: 1, config: defaultPlanConfig(), plans: [], runtime: [], runs: [] });

function checkedConfig(raw: unknown): PlanConfig {
  if (!record(raw) || raw.version !== 1 || typeof raw.enabled !== 'boolean' || typeof raw.aiAssist !== 'boolean' ||
    !inRange(raw.preemptGraceMs, PLAN_RANGE.preemptGraceMs) || !inRange(raw.catchUpMs, PLAN_RANGE.catchUpMs) ||
    !inRange(raw.queueWaitMs, PLAN_RANGE.queueWaitMs) || !Number.isInteger(raw.retry) || !inRange(raw.retry, PLAN_RANGE.retry) ||
    !inRange(raw.retryDelayMs, PLAN_RANGE.retryDelayMs) ||
    !Number.isInteger(raw.maxConcurrentScripts) || !inRange(raw.maxConcurrentScripts, PLAN_RANGE.maxConcurrentScripts)) {
    throw new Error('计划配置无效');
  }
  return { version: 1, enabled: raw.enabled, preemptGraceMs: raw.preemptGraceMs, catchUpMs: raw.catchUpMs, queueWaitMs: raw.queueWaitMs,
    retry: raw.retry, retryDelayMs: raw.retryDelayMs, aiAssist: raw.aiAssist, maxConcurrentScripts: raw.maxConcurrentScripts };
}

function checkedRuntime(row: unknown): void {
  if (!record(row) || typeof row.accountId !== 'string' || typeof row.taskId !== 'string' ||
    !RESULTS.includes(row.lastResult as PlanRunResult | null) || !(row.lastError === null || typeof row.lastError === 'string') ||
    !['lastClaimedAt', 'lastStartedAt', 'lastEndedAt'].every((key) => time(row[key])) ||
    !bounded(row.runs, 0, Number.MAX_SAFE_INTEGER) || !bounded(row.fails, 0, Number.MAX_SAFE_INTEGER)) throw new Error('计划运行计数损坏');
}

function checkedRun(row: unknown): void {
  if (!record(row) || typeof row.runId !== 'string' || typeof row.gameId !== 'string' || typeof row.accountId !== 'string' ||
    typeof row.taskId !== 'string' || typeof row.scriptId !== 'string' || typeof row.accountName !== 'string' ||
    typeof row.message !== 'string' || !Number.isInteger(row.instanceIndex) || !bounded(row.queuedAt, 0, Number.MAX_SAFE_INTEGER) ||
    !inRange(row.priority, PLAN_RANGE.priority) || !RUN_STATUSES.includes(row.status as typeof RUN_STATUSES[number]) ||
    !time(row.startedAt) || !time(row.endedAt) || !(row.stepId === null || typeof row.stepId === 'string') ||
    (row.origin !== undefined && row.origin !== 'schedule' && row.origin !== 'manual') ||
    (row.attempt !== undefined && (!Number.isInteger(row.attempt) || !bounded(row.attempt, 1, 100))) ||
    (row.reason !== undefined && typeof row.reason !== 'string')) throw new Error('计划运行记录损坏');
}

/** Files written before preemption / AI assist / the global cap existed get those defaults (a migration, not damage). */
function migrate(raw: unknown): unknown {
  if (!record(raw) || !record(raw.config)) return raw;
  const defaults = defaultPlanConfig();
  const config = { ...raw.config };
  if (config.preemptGraceMs === undefined) config.preemptGraceMs = defaults.preemptGraceMs;
  if (config.aiAssist === undefined) config.aiAssist = defaults.aiAssist;
  if (config.maxConcurrentScripts === undefined) config.maxConcurrentScripts = defaults.maxConcurrentScripts;
  return { ...raw, config };
}

function checkedFile(raw: unknown): PlanFile {
  if (!record(raw) || raw.version !== 1 || !Array.isArray(raw.plans) || raw.plans.length > MAX_PLANS ||
    !Array.isArray(raw.runtime) || !Array.isArray(raw.runs) || raw.runs.length > MAX_RUNS) throw new Error('计划文件格式不兼容');
  const config = checkedConfig(raw.config);
  const plans = raw.plans as unknown[];
  for (const one of plans) validatePlan(one);
  if (new Set(plans.map((p) => (p as AccountPlan).accountId)).size !== plans.length) throw new Error('账号计划重复');
  for (const row of raw.runtime) checkedRuntime(row);
  for (const row of raw.runs) checkedRun(row);
  return { version: 1, config, plans: plans as AccountPlan[], runtime: raw.runtime as TaskRuntime[], runs: raw.runs as PlanRun[] };
}

const numOrNull = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;

/**
 * Tolerant load of a damaged (hand-edited) file, like the original `loadPlanFile`: every field is clamped or
 * dropped with a Chinese warning, an invalid daily trigger becomes manual, and bad runtime / history rows are
 * dropped. The result always passes `checkedFile`.
 */
export function sanitizePlanFile(raw: unknown, warn: (message: string) => void): PlanFile {
  const o = record(raw) ? raw : {};
  if (!record(raw)) warn('计划文件的顶层不是 JSON 对象，已从默认值重建。');
  const migrated = migrate(o) as Record<string, unknown>;
  try { checkedConfig(migrated.config); }
  catch { if (migrated.config !== undefined) warn('计划设置里有字段不合法，已逐项夹回范围或恢复默认值。'); }
  const config = mergePlanConfig(defaultPlanConfig(), record(migrated.config) ? migrated.config : undefined);
  const plans: AccountPlan[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(o.plans) ? o.plans : []) {
    const plan = sanitizePlan(item, warn);
    if (!plan) continue;
    if (!PLAN_ACCOUNT_RE.test(plan.accountId)) { warn(`计划表里的账号 ID「${plan.accountId}」不合法，这份计划已跳过。`); continue; }
    if (seen.has(plan.accountId)) { warn(`账号 ${plan.accountId} 有两份计划，已丢弃后一份。`); continue; }
    if (plans.length >= MAX_PLANS) { warn(`计划账号超过 ${MAX_PLANS} 个，多出的已丢弃。`); break; }
    seen.add(plan.accountId);
    plans.push(plan);
  }
  const runtime: TaskRuntime[] = [];
  let badRuntime = 0;
  for (const row of Array.isArray(o.runtime) ? o.runtime : []) {
    if (!record(row) || typeof row.accountId !== 'string' || typeof row.taskId !== 'string') { badRuntime++; continue; }
    const result = row.lastResult === 'aborted' ? 'cancelled' : row.lastResult;
    runtime.push({
      accountId: row.accountId, taskId: row.taskId,
      lastClaimedAt: numOrNull(row.lastClaimedAt), lastStartedAt: numOrNull(row.lastStartedAt ?? row.lastRunAt), lastEndedAt: numOrNull(row.lastEndedAt),
      lastResult: RESULTS.includes(result as PlanRunResult) ? result as PlanRunResult : null,
      lastError: typeof row.lastError === 'string' ? row.lastError : null,
      runs: Math.max(0, Math.round(numOrNull(row.runs) ?? 0)), fails: Math.max(0, Math.round(numOrNull(row.fails) ?? 0)),
    });
  }
  const runs: PlanRun[] = [];
  let badRuns = 0;
  for (const row of Array.isArray(o.runs) ? o.runs : []) {
    try { checkedRun(row); } catch { badRuns++; continue; }
    if (runs.length < MAX_RUNS) runs.push(row as unknown as PlanRun);
  }
  if (badRuntime) warn(`有 ${badRuntime} 条执行记账损坏，已丢弃。`);
  if (badRuns) warn(`有 ${badRuns} 条运行记录损坏，已丢弃。`);
  const data = { version: 1 as const, config, plans, runtime, runs };
  try { return checkedFile(data); }
  catch (error) {
    warn(`计划文件修复后仍无法通过校验（${error instanceof Error ? error.message : String(error)}），已从默认值重建。`);
    return fresh();
  }
}

/** The config keys the page may change; `version` is ignored. Types are checked, numbers clamped (original). */
export function checkedConfigPatch(patch: unknown): Partial<PlanConfig> {
  if (!record(patch)) throw new Error('计划配置无效');
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!(CONFIG_KEYS as readonly string[]).includes(key)) throw new Error(`计划配置不认识的字段：${key}`);
    if (key === 'version') continue;
    if (key === 'enabled' || key === 'aiAssist') {
      if (typeof value !== 'boolean') throw new Error(`计划配置字段 ${key} 应为开关`);
    } else if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`计划配置字段 ${key} 应为数字`);
    out[key] = value;
  }
  return out as Partial<PlanConfig>;
}

function runtimeOf(data: PlanFile, accountId: string, taskId: string): TaskRuntime {
  let row = data.runtime.find((r) => r.accountId === accountId && r.taskId === taskId);
  if (!row) {
    row = { accountId, taskId, lastClaimedAt: null, lastStartedAt: null, lastEndedAt: null, lastResult: null, lastError: null, runs: 0, fails: 0 };
    data.runtime.push(row);
  }
  return row;
}

const taskOf = (data: PlanFile, accountId: string, taskId: string) =>
  data.plans.find((p) => p.accountId === accountId)?.tasks.find((t) => t.id === taskId);

const TASK_GONE = '找不到这条任务，面板可能不是最新的，刷新一下再试。';

interface Loaded { data: PlanFile; warnings: string[] | null }

/** Snapshot of one game's plan file. */
export interface PlanData { config: PlanConfig; plans: AccountPlan[]; runtime: TaskRuntime[]; runs: PlanRun[] }

/**
 * `<home>/automation/games/<gameId>/plans.json`: private (0600), atomic, and serialized across Assistant
 * processes. Reads are tolerant (original iron rule: a hand-edited or damaged file never keeps the panel or the
 * planner from starting): a broken file is repaired, the original is backed up next to it on the next write, and
 * the Chinese warnings stay available through `warnings()`. Writes are strictly validated.
 */
export class PlanStore {
  private readonly loadWarnings = new Map<string, string[]>();

  constructor(private readonly home: string, private readonly log: (message: string) => void = (message) => console.warn('[plan]', message)) {
    if (!path.isAbsolute(home)) throw new Error('计划数据目录必须是绝对路径');
  }

  /** Where the game's plans.json lives. */
  file(gameId: string): string {
    if (!PLAN_ID_RE.test(gameId)) throw new Error('游戏编号无效');
    return path.join(this.home, 'automation', 'games', gameId, 'plans.json');
  }

  /** Problems found while loading this game's file in this session (empty when it was clean). */
  warnings(gameId: string): string[] {
    return [...(this.loadWarnings.get(gameId) ?? [])];
  }

  private noteWarnings(gameId: string, warnings: string[]): void {
    const previous = this.loadWarnings.get(gameId);
    if (previous && JSON.stringify(previous) === JSON.stringify(warnings)) return;
    this.loadWarnings.set(gameId, warnings);
    for (const warning of warnings) this.log(warning);
  }

  private async load(gameId: string): Promise<Loaded> {
    const file = this.file(gameId);
    let info;
    try { info = await lstat(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { data: fresh(), warnings: null }; throw error; }
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`计划文件不是普通文件，拒绝读取：${file}`);
    if (info.size > FILE_LIMIT) return { data: fresh(), warnings: [`计划文件超过 2 MB，已忽略并从默认值重建：${file}`] };
    const text = await readFile(file, 'utf8');
    let raw: unknown;
    try { raw = JSON.parse(text) as unknown; }
    catch { return { data: fresh(), warnings: [`计划文件不是合法 JSON，已忽略并从默认值重建：${file}`] }; }
    try { return { data: checkedFile(migrate(raw)), warnings: null }; }
    catch (error) {
      const warnings = [`计划文件有内容不合法（${error instanceof Error ? error.message : String(error)}），已按原版规则逐项修复：${file}`];
      return { data: sanitizePlanFile(raw, (message) => warnings.push(message)), warnings };
    }
  }

  private async read(gameId: string): Promise<PlanFile> {
    const loaded = await this.load(gameId);
    if (loaded.warnings) this.noteWarnings(gameId, loaded.warnings);
    return loaded.data;
  }

  private async write(gameId: string, data: PlanFile): Promise<void> {
    checkedFile(data);
    const file = this.file(gameId);
    const json = JSON.stringify(data, null, 2) + '\n';
    if (Buffer.byteLength(json) > FILE_LIMIT) throw new Error('计划文件超过 2 MB');
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temp, 'wx', 0o600);
      try { await handle.writeFile(json); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temp, file);
      await chmod(file, 0o600);
    } catch (error) { await rm(temp, { force: true }).catch(() => undefined); throw error; }
  }

  /** Keeps the damaged original before the repaired version overwrites it (the user may want to recover it). */
  private async backup(gameId: string, warnings: string[]): Promise<void> {
    const file = this.file(gameId);
    const target = `${file}.corrupt-${Date.now()}`;
    try {
      await copyFile(file, target);
      await chmod(target, 0o600);
      this.noteWarnings(gameId, [...warnings, `损坏的原文件已备份为 ${path.basename(target)}。`]);
    } catch (error) {
      this.noteWarnings(gameId, [...warnings, `损坏的原文件没能备份（${error instanceof Error ? error.message : String(error)}）。`]);
    }
  }

  private async change<T>(gameId: string, fn: (data: PlanFile) => T | Promise<T>): Promise<T> {
    const file = this.file(gameId);
    return withFileLock(`${file}.lock`, async () => {
      const loaded = await this.load(gameId);
      if (loaded.warnings) await this.backup(gameId, loaded.warnings);
      const data = loaded.data;
      const result = await fn(data);
      await this.write(gameId, data);
      return result;
    });
  }

  async overview(gameId: string): Promise<PlanData> {
    const data = await this.read(gameId);
    return { config: data.config, plans: data.plans, runtime: data.runtime, runs: data.runs };
  }

  async getPlan(gameId: string, accountId: string): Promise<AccountPlan | null> {
    const plan = (await this.read(gameId)).plans.find((item) => item.accountId === accountId);
    return plan ? structuredClone(plan) : null;
  }

  /** Merge a checked patch (numbers are clamped into `PLAN_RANGE`, like the original). */
  async saveConfig(gameId: string, patch: Partial<PlanConfig>): Promise<PlanConfig> {
    const checked = checkedConfigPatch(patch);
    return this.change(gameId, (data) => {
      data.config = checkedConfig(mergePlanConfig(data.config, checked));
      return structuredClone(data.config);
    });
  }

  /** Whole-plan overwrite; runtime rows of removed tasks are purged. */
  async savePlan(gameId: string, plan: AccountPlan): Promise<AccountPlan> {
    const normalized = normalizePlan(plan);
    validatePlan(normalized);
    return this.change(gameId, (data) => {
      const next = { ...structuredClone(normalized), updatedAt: Date.now() };
      const index = data.plans.findIndex((p) => p.accountId === next.accountId);
      if (index >= 0) data.plans[index] = next;
      else { if (data.plans.length >= MAX_PLANS) throw new Error('计划账号数量达到上限'); data.plans.push(next); }
      const alive = new Set(next.tasks.map((task) => task.id));
      data.runtime = data.runtime.filter((row) => row.accountId !== next.accountId || alive.has(row.taskId));
      return structuredClone(next);
    });
  }

  /** The row's checkbox only (the most frequent action; no whole-plan rewrite). */
  async setTaskEnabled(gameId: string, accountId: string, taskId: string, enabled: boolean): Promise<AccountPlan> {
    return this.change(gameId, (data) => {
      const plan = data.plans.find((p) => p.accountId === accountId);
      const task = plan?.tasks.find((t) => t.id === taskId);
      if (!plan || !task) throw new Error(TASK_GONE);
      task.enabled = enabled;
      plan.updatedAt = Date.now();
      return structuredClone(plan);
    });
  }

  /** The account switch; creates an empty plan for an account that has none (original). */
  async setAccountEnabled(gameId: string, accountId: string, enabled: boolean): Promise<AccountPlan> {
    if (!PLAN_ACCOUNT_RE.test(accountId)) throw new Error('账号 ID 无效');
    return this.change(gameId, (data) => {
      let plan = data.plans.find((p) => p.accountId === accountId);
      if (!plan) {
        if (data.plans.length >= MAX_PLANS) throw new Error('计划账号数量达到上限');
        plan = { accountId, enabled, tasks: [], updatedAt: 0 };
        data.plans.push(plan);
      }
      plan.enabled = enabled;
      plan.updatedAt = Date.now();
      return structuredClone(plan);
    });
  }

  /**
   * Removes one task (and its runtime row). `dropEmptyPlan` also removes the account's whole plan once it has no
   * task left (a plan whose account was deleted). Returns the remaining plan, or null when it was dropped.
   */
  async removeTask(gameId: string, accountId: string, taskId: string, dropEmptyPlan = false): Promise<AccountPlan | null> {
    return this.change(gameId, (data) => {
      const plan = data.plans.find((p) => p.accountId === accountId);
      if (!plan || !plan.tasks.some((t) => t.id === taskId)) throw new Error(TASK_GONE);
      plan.tasks = plan.tasks.filter((t) => t.id !== taskId);
      plan.updatedAt = Date.now();
      data.runtime = data.runtime.filter((row) => row.accountId !== accountId || row.taskId !== taskId);
      if (dropEmptyPlan && plan.tasks.length === 0) {
        data.plans = data.plans.filter((p) => p !== plan);
        return null;
      }
      return structuredClone(plan);
    });
  }

  /**
   * Claims the task's current round when its trigger says it is due (`dueReason`): records the claim time (★ so a
   * restart never runs the round again) and the queued run, whose message is the Chinese reason.
   */
  async claimScheduled(gameId: string, accountId: string, taskId: string, run: PlanRun, now = Date.now()): Promise<PlanRun | null> {
    return this.change(gameId, (data) => {
      const plan = data.plans.find((p) => p.accountId === accountId);
      const task = plan?.tasks.find((t) => t.id === taskId);
      if (!data.config.enabled || !plan?.enabled || !task?.enabled) return null;
      const runtime = runtimeOf(data, accountId, taskId);
      const reason = dueReason(task.trigger, now, lastRunAtOf(runtime), data.config.catchUpMs);
      if (reason === null) return null;
      runtime.lastClaimedAt = now;
      // queuedAt = the claim time: a round taken off the queue before it started can release exactly this claim.
      const claimed: PlanRun = { ...run, queuedAt: now, message: reason, reason, origin: 'schedule', attempt: run.attempt ?? 1 };
      data.runs.unshift(claimed);
      data.runs = data.runs.slice(0, MAX_RUNS);
      return claimed;
    });
  }

  /** Records a queued run that did not come from a trigger (「立即运行」, a failure retry). The task must exist. */
  async addRun(gameId: string, run: PlanRun): Promise<PlanRun> {
    return this.change(gameId, (data) => {
      if (!taskOf(data, run.accountId, run.taskId)) throw new Error(TASK_GONE);
      data.runs.unshift(run);
      data.runs = data.runs.slice(0, MAX_RUNS);
      return run;
    });
  }

  /**
   * Updates a run record and the task's bookkeeping: `running` counts a run and its start; a terminal status sets
   * the last result (a failure counts toward `fails`). A run cancelled before it started leaves the bookkeeping
   * alone (original: taking a task off the queue is not a result); with `releaseClaim` (the task was switched off)
   * its round's claim is released too, so the round is due again once the task is back on (original: only a start
   * counted as 「跑过」).
   */
  async updateRun(gameId: string, runId: string, patch: Partial<PlanRun>, options: { releaseClaim?: boolean } = {}): Promise<PlanRun | null> {
    return this.change(gameId, (data) => {
      const run = data.runs.find((r) => r.runId === runId);
      if (!run) return null;
      const startedBefore = run.startedAt !== null;
      Object.assign(run, patch);
      if (!taskOf(data, run.accountId, run.taskId)) return structuredClone(run);
      if (patch.status === 'running') {
        const rt = runtimeOf(data, run.accountId, run.taskId);
        rt.lastStartedAt = patch.startedAt ?? Date.now();
        rt.runs++;
      } else if (patch.status === 'succeeded' || patch.status === 'failed' || patch.status === 'cancelled' || patch.status === 'skipped') {
        if (patch.status === 'cancelled' && !startedBefore && run.startedAt === null) {
          const rt = data.runtime.find((r) => r.accountId === run.accountId && r.taskId === run.taskId);
          if (options.releaseClaim && rt && rt.lastClaimedAt === run.queuedAt) rt.lastClaimedAt = null;
          return structuredClone(run);
        }
        const rt = runtimeOf(data, run.accountId, run.taskId);
        rt.lastEndedAt = patch.endedAt ?? Date.now();
        rt.lastResult = patch.status;
        rt.lastError = patch.status === 'succeeded' ? null : (patch.message ?? run.message);
        if (patch.status === 'failed') rt.fails++;
      }
      return structuredClone(run);
    });
  }

  /** Runs left queued or running by a previous process are closed as skipped (they never finished). */
  async recoverInterrupted(gameId: string): Promise<number> {
    return this.change(gameId, (data) => {
      let count = 0;
      for (const run of data.runs) if (run.status === 'queued' || run.status === 'running') {
        run.status = 'skipped'; run.message = '助手上次退出，已停止未完成任务'; run.endedAt = Date.now();
        if (taskOf(data, run.accountId, run.taskId)) {
          const rt = runtimeOf(data, run.accountId, run.taskId);
          rt.lastEndedAt = run.endedAt; rt.lastResult = 'skipped'; rt.lastError = run.message;
        }
        count++;
      }
      return count;
    });
  }
}
