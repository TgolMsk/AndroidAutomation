/**
 * Task plans (「账号勾选脚本 + 运行时间」): the contract shared by the main process and the renderer, and the only
 * implementation of the plan rules that both sides need (ported from wanlong-panel `src/shared/plan.ts` and the
 * pure parts of `src/main/plan/{index,store}.ts`).
 *
 * Iron rules kept from the original:
 *  1. ★ Scripts come first: when a task is due, the gather scheduler of that instance yields (polite wait of
 *     `preemptGraceMs`, then abort) and gets the instance back after the run. Never the other way round.
 *  2. ★ One chain per instance: every instance has its own serial queue; the global cap `maxConcurrentScripts`
 *     only defers a run (back-off), it never fails it.
 *  3. ★ Beijing time: `HH:MM` is a Beijing clock reading whatever the host time zone is. All clock maths lives in
 *     `./time.ts`; this file only builds on it. Main arms its timers and the renderer shows 「下次运行」 with the
 *     same functions, so both compute the same millisecond.
 *
 * Pure module: no Node, Electron or DOM imports (checked by `test/shared-purity.test.ts`).
 */
import {
  cstDayStartOf, cstOffsetOfDay, formatClock, inClockWindow, nextFireAt, nextWindowStart, parseClock, previousFireAt,
  type ClockTrigger, type ClockWindow,
} from './time';

export { cstDayStartOf, cstOffsetOfDay, formatClock, inClockWindow, nextFireAt, nextWindowStart, parseClock, previousFireAt };
export type { ClockWindow };

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

// ── Triggers ────────────────────────────────────────────────────────────────

/**
 * When a task runs. `manual`: only 「立即运行」. `daily`: at each Beijing `HH:MM`. `interval`: every
 * `everyMinutes`, optionally only inside a Beijing `window` (`from > to` wraps midnight).
 */
export type TaskTrigger = ClockTrigger;

/** Chinese description shared by the page and the logs (original wording). */
export function describeTrigger(trigger: TaskTrigger): string {
  switch (trigger.kind) {
    case 'manual':
      return '仅手动';
    case 'daily': {
      const list = trigger.at.filter((value) => parseClock(value) !== null);
      return list.length === 0 ? '每天（未设时刻）' : `每天 ${list.join('、')}`;
    }
    case 'interval': {
      const every = Math.max(1, Math.round(trigger.everyMinutes));
      const base = every % 60 === 0 ? `每 ${every / 60} 小时` : `每 ${every} 分钟`;
      return trigger.window ? `${base}（${trigger.window.from}–${trigger.window.to}）` : base;
    }
  }
}

/**
 * Is the task due right now? Returns the Chinese reason, or null. `lastRunAt` is the last time this task's round
 * was claimed or started (`lastRunAtOf`).
 *
 * daily: the latest passed time (`previousFireAt`) that has not run yet, and at most `catchUpMs` ago — a missed
 * time is caught up once, a time missed for longer is dropped (never a day of runs at once).
 * interval: `nextFireAt(trigger, now, lastRunAt) <= now`. The catch-up window does NOT apply: an overdue interval
 * fires exactly once and continues from there (the old target build applied it and stalled such tasks forever).
 */
export function dueReason(trigger: TaskTrigger, now: number, lastRunAt: number | null, catchUpMs: number): string | null {
  if (trigger.kind === 'manual') return null;
  if (trigger.kind === 'daily') {
    const previous = previousFireAt(trigger, now);
    if (previous === null) return null;
    if (lastRunAt !== null && lastRunAt >= previous) return null;
    if (now - previous > catchUpMs) return null;
    return now - previous < MINUTE_MS
      ? `到点（${describeTrigger(trigger)}）`
      : `补跑错过的触发点（晚了 ${Math.round((now - previous) / MINUTE_MS)} 分钟）`;
  }
  const due = nextFireAt(trigger, now, lastRunAt);
  if (due === null || due > now) return null;
  return `到点（${describeTrigger(trigger)}）`;
}

// ── Plan table (persisted) ──────────────────────────────────────────────────

export type PlanParamValue = string | number | boolean;

export interface PlanTask {
  /** Unique inside the account's plan. */
  id: string;
  scriptId: string;
  /** ★ The row's checkbox: off only stops automatic runs, the task stays. */
  enabled: boolean;
  trigger: TaskTrigger;
  /** On the same instance, the bigger number runs first. Default 50. */
  priority: number;
  /** Overrides of the script's parameters (merged: script defaults < account < this < a one-off request). */
  params?: Record<string, PlanParamValue>;
  /** Limit of one run in minutes; 0 = unlimited. A run that exceeds it is stopped (and not retried). */
  maxRunMinutes: number;
  note?: string;
}

/** One account's plan; the account's instance binding decides where it runs. */
export interface AccountPlan {
  accountId: string;
  /** Account switch: off = none of its tasks runs automatically. */
  enabled: boolean;
  tasks: PlanTask[];
  updatedAt: number;
}

export interface PlanConfig {
  version: 1;
  /** Total switch: off = only 「立即运行」 remains. */
  enabled: boolean;
  /** ★ Preemption grace: how long the gather scheduler may finish its in-flight chain before it is aborted. */
  preemptGraceMs: number;
  /** A missed daily time is still caught up within this window; later it is dropped. */
  catchUpMs: number;
  /** Longest wait in an instance queue; beyond it the round is skipped (never piled up). */
  queueWaitMs: number;
  /** Retries after a failed run (each retry releases the instance first and waits `retryDelayMs`). */
  retry: number;
  retryDelayMs: number;
  /**
   * ★ Let the AI advisor look at the screen when a script step exhausted its retries (mostly a popup in the way).
   * Only effective while the AI advisor itself is enabled and allowed to act (`autoActions`).
   */
  aiAssist: boolean;
  /** Script runs across all instances at once (gather rounds not counted); a deferred plan run is not a failure. */
  maxConcurrentScripts: number;
}

/** The only defaults (original `defaultPlanConfig`, plus the assistant's global script cap). */
export function defaultPlanConfig(): PlanConfig {
  return {
    version: 1,
    enabled: false,
    preemptGraceMs: 8_000,
    catchUpMs: 30 * MINUTE_MS,
    queueWaitMs: 30 * MINUTE_MS,
    retry: 1,
    retryDelayMs: 60_000,
    aiAssist: true,
    maxConcurrentScripts: 4,
  };
}

/** Ranges (bounds, not defaults); the page's inputs take their min/max from here. */
export const PLAN_RANGE = {
  preemptGraceMs: [0, 120_000],
  catchUpMs: [0, 12 * HOUR_MS],
  queueWaitMs: [MINUTE_MS, 12 * HOUR_MS],
  retry: [0, 5],
  retryDelayMs: [0, 30 * MINUTE_MS],
  everyMinutes: [1, 24 * 60],
  maxRunMinutes: [0, 12 * 60],
  priority: [0, 100],
  maxConcurrentScripts: [1, 16],
} as const satisfies Record<string, readonly [number, number]>;

/** Rounds and clamps into `range`; a non-finite value becomes the lower bound. */
export function clampToRange(value: number, range: readonly [number, number]): number {
  if (!Number.isFinite(value)) return range[0];
  return Math.min(range[1], Math.max(range[0], Math.round(value)));
}

const num = (value: unknown, fallback: number): number => typeof value === 'number' && Number.isFinite(value) ? value : fallback;

/** Field-by-field merge: one bad field falls back alone and never voids the whole config. */
export function mergePlanConfig(base: PlanConfig, patch: Partial<PlanConfig> | Record<string, unknown> | undefined | null): PlanConfig {
  const p = (patch && typeof patch === 'object' ? patch : {}) as Record<string, unknown>;
  return {
    version: 1,
    enabled: typeof p.enabled === 'boolean' ? p.enabled : base.enabled,
    preemptGraceMs: clampToRange(num(p.preemptGraceMs, base.preemptGraceMs), PLAN_RANGE.preemptGraceMs),
    catchUpMs: clampToRange(num(p.catchUpMs, base.catchUpMs), PLAN_RANGE.catchUpMs),
    queueWaitMs: clampToRange(num(p.queueWaitMs, base.queueWaitMs), PLAN_RANGE.queueWaitMs),
    retry: clampToRange(num(p.retry, base.retry), PLAN_RANGE.retry),
    retryDelayMs: clampToRange(num(p.retryDelayMs, base.retryDelayMs), PLAN_RANGE.retryDelayMs),
    aiAssist: typeof p.aiAssist === 'boolean' ? p.aiAssist : base.aiAssist,
    maxConcurrentScripts: clampToRange(num(p.maxConcurrentScripts, base.maxConcurrentScripts), PLAN_RANGE.maxConcurrentScripts),
  };
}

/** A new task's shape (「添加任务」): every day at 08:00, enabled, priority 50, 30 minutes. */
export function emptyTask(id: string, scriptId: string): PlanTask {
  return { id, scriptId, enabled: true, trigger: { kind: 'daily', at: ['08:00'] }, priority: 50, maxRunMinutes: 30 };
}

/** `task_<base36 time><random>` like the original `makeId('task')`; matches `PLAN_ID_RE`. */
export function makeTaskId(now = Date.now(), random: () => number = Math.random): string {
  return `task_${now.toString(36)}${Math.floor(random() * 36 ** 4).toString(36).padStart(4, '0')}`;
}

// ── Identifier rules (the store enforces them on write; the sanitizers keep loads writable) ──

/** Task and script ids. */
export const PLAN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/;
/** Account ids are UUIDs. */
export const PLAN_ACCOUNT_RE = /^[0-9a-f-]{36}$/i;
export const MAX_PLAN_TASKS = 100;
export const MAX_DAILY_TIMES = 24;
export const MAX_TASK_PARAMS = 50;
export const MAX_NOTE_LENGTH = 1000;
const PARAM_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/;

// ── Tolerant sanitizers (hand-edited plans.json, legacy imports) ─────────────

const str = (value: unknown): string | null => typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
type Warn = (message: string) => void;

function sanitizeWindow(raw: unknown, warn: Warn): ClockWindow | undefined {
  if (raw === undefined || raw === null) return undefined;
  const o = typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const from = str(o.from);
  const to = str(o.to);
  if (from === null || to === null || parseClock(from) === null || parseClock(to) === null) {
    warn('有一条「按间隔」任务的时段不是合法的 HH:MM，已改为全天。');
    return undefined;
  }
  return { from, to };
}

/** Unknown or broken triggers become 「仅手动」: better not to run than to run at a guessed time. */
export function sanitizeTrigger(raw: unknown, warn: Warn): TaskTrigger {
  if (typeof raw !== 'object' || raw === null) return { kind: 'manual' };
  const o = raw as Record<string, unknown>;
  if (o.kind === 'daily') {
    const at = Array.isArray(o.at) ? o.at.map(str).filter((v): v is string => v !== null && parseClock(v) !== null) : [];
    if (at.length === 0) {
      warn('有一条「每天」任务没给合法时刻（要 HH:MM），已改成仅手动。');
      return { kind: 'manual' };
    }
    // Deduplicated and sorted: display and firing order stay stable.
    const unique = [...new Set(at)].sort();
    if (unique.length > MAX_DAILY_TIMES) warn(`有一条「每天」任务的时刻超过 ${MAX_DAILY_TIMES} 个，只保留前 ${MAX_DAILY_TIMES} 个。`);
    return { kind: 'daily', at: unique.slice(0, MAX_DAILY_TIMES) };
  }
  if (o.kind === 'interval') {
    const everyMinutes = clampToRange(num(o.everyMinutes, 60), PLAN_RANGE.everyMinutes);
    const window = sanitizeWindow(o.window, warn);
    return window ? { kind: 'interval', everyMinutes, window } : { kind: 'interval', everyMinutes };
  }
  if (o.kind !== 'manual') warn('有一条任务的触发方式认不出来，已改成仅手动。');
  return { kind: 'manual' };
}

/** Keeps string / finite number / boolean values under safe keys; undefined when nothing is left. */
export function sanitizeParams(raw: unknown): Record<string, PlanParamValue> | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const out: Record<string, PlanParamValue> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!PARAM_KEY_RE.test(key) || Object.keys(out).length >= MAX_TASK_PARAMS) continue;
    if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) out[key] = value;
    else if (typeof value === 'string' && value.length <= 2048) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export interface SanitizeTaskOptions {
  /** Give a task with a missing or unusable id a fresh one instead of dropping it (legacy import). */
  newId?: () => string;
}

export function sanitizeTask(raw: unknown, warn: Warn, options: SanitizeTaskOptions = {}): PlanTask | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  let id = str(o.id);
  const scriptId = str(o.scriptId);
  if (scriptId === null || !PLAN_ID_RE.test(scriptId)) {
    warn(`计划里有一条任务的脚本 ID 缺失或不合法（${String(o.scriptId ?? '空')}），已跳过。`);
    return null;
  }
  if (id === null || !PLAN_ID_RE.test(id)) {
    if (!options.newId) {
      warn('计划里有一条任务缺 id 或 id 不合法，已跳过。');
      return null;
    }
    id = options.newId();
  }
  const maxRun = num(o.maxRunMinutes, 30);
  if (maxRun > PLAN_RANGE.maxRunMinutes[1]) warn(`任务 ${id} 的单次时间上限超过 ${PLAN_RANGE.maxRunMinutes[1]} 分钟，已改为 ${PLAN_RANGE.maxRunMinutes[1]} 分钟。`);
  const task: PlanTask = {
    id,
    scriptId,
    enabled: o.enabled === true,
    trigger: sanitizeTrigger(o.trigger, warn),
    priority: clampToRange(num(o.priority, 50), PLAN_RANGE.priority),
    maxRunMinutes: clampToRange(maxRun, PLAN_RANGE.maxRunMinutes),
  };
  const params = sanitizeParams(o.params);
  if (params) task.params = params;
  const note = str(o.note);
  if (note) task.note = note.slice(0, MAX_NOTE_LENGTH);
  return task;
}

export function sanitizePlan(raw: unknown, warn: Warn, options: SanitizeTaskOptions = {}): AccountPlan | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const accountId = str(o.accountId);
  if (accountId === null) {
    warn('计划表里有一条记录没有 accountId，已跳过。');
    return null;
  }
  const tasks: PlanTask[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(o.tasks) ? o.tasks : []) {
    const task = sanitizeTask(item, warn, options);
    if (!task) continue;
    if (seen.has(task.id)) {
      if (!options.newId) { warn(`账号 ${accountId} 的任务 id「${task.id}」重复，已丢弃后一条。`); continue; }
      task.id = options.newId();
    }
    if (tasks.length >= MAX_PLAN_TASKS) { warn(`账号 ${accountId} 的任务超过 ${MAX_PLAN_TASKS} 条，多出的已丢弃。`); break; }
    seen.add(task.id);
    tasks.push(task);
  }
  return { accountId, enabled: o.enabled === true, tasks, updatedAt: Math.max(0, num(o.updatedAt, 0)) };
}

// ── Runtime (persisted bookkeeping) ─────────────────────────────────────────

export type PlanRunResult = 'succeeded' | 'failed' | 'cancelled' | 'skipped';

/**
 * Bookkeeping of one task, kept across restarts (★ iron rule 5: without it a task that ran at 08:00 would run
 * again after a restart at 08:05).
 */
export interface TaskRuntime {
  accountId: string;
  taskId: string;
  /** When the current round was claimed (queued by its trigger); persisted before the run starts. */
  lastClaimedAt: number | null;
  /** When the last run started executing. */
  lastStartedAt: number | null;
  lastEndedAt: number | null;
  lastResult: PlanRunResult | null;
  /** Chinese reason of the last unsuccessful result. */
  lastError: string | null;
  runs: number;
  fails: number;
}

/** The trigger baseline: the later of the round claim and the last start (a manual run pushes an interval on). */
export function lastRunAtOf(runtime: Pick<TaskRuntime, 'lastClaimedAt' | 'lastStartedAt'> | undefined | null): number | null {
  if (!runtime) return null;
  const { lastClaimedAt: claimed, lastStartedAt: started } = runtime;
  if (claimed === null) return started;
  if (started === null) return claimed;
  return Math.max(claimed, started);
}

export type PlanRunStatus = 'queued' | 'running' | PlanRunResult;

/** How a run entered the queue: its trigger (`schedule`) or 「立即运行」 (`manual`, runs even with switches off). */
export type PlanRunOrigin = 'schedule' | 'manual';

/** One queued or executed run of a plan task (the history keeps the newest 200). */
export interface PlanRun {
  runId: string;
  gameId: string;
  accountId: string;
  accountName: string;
  instanceIndex: number;
  taskId: string;
  scriptId: string;
  priority: number;
  status: PlanRunStatus;
  queuedAt: number;
  startedAt: number | null;
  endedAt: number | null;
  message: string;
  stepId: string | null;
  /** Absent in records written before the plans port (treated as `schedule`). */
  origin?: PlanRunOrigin;
  /** 1 for the first attempt of a round, 2… for the failure retries. */
  attempt?: number;
  /** Why it was queued (「到点（每天 08:00）」「补跑错过的触发点（晚了 7 分钟）」「手动立即运行」「失败重试…」). */
  reason?: string;
}

// ── Overview (pushed to the page) ───────────────────────────────────────────

export type PlanTaskPhase =
  /** Waiting for the next trigger. */
  | 'idle'
  /** Due and waiting in its instance queue. */
  | 'queued'
  | 'running'
  /** The last round succeeded. */
  | 'done'
  /** The last round failed (retries used up). */
  | 'failed'
  /** The last round was skipped (instance not ready, waited too long …). */
  | 'skipped';

export const PLAN_PHASE_TEXT: Readonly<Record<PlanTaskPhase, string>> = {
  idle: '等待',
  queued: '排队中',
  running: '执行中',
  done: '已完成',
  failed: '失败',
  skipped: '已跳过',
};

/** One row of the page: plan table and runtime flattened together (the renderer never joins them itself). */
export interface PlanTaskState {
  accountId: string;
  /** 「（账号已删除）」 when the plan's account is gone. */
  accountName: string;
  accountMissing: boolean;
  /** Why this account cannot run tasks now (未绑定实例 / 已停用 / 未完成登录验证 / 已删除), or null. */
  accountIssue: string | null;
  /** The account's bound instance; null when unbound. */
  instanceIndex: number | null;
  taskId: string;
  scriptId: string;
  /** Null when the script was deleted (the page marks it red). */
  scriptName: string | null;
  enabled: boolean;
  /** Account switch; the task switch is disabled while it is off. */
  accountEnabled: boolean;
  trigger: TaskTrigger;
  priority: number;
  maxRunMinutes: number;
  note?: string;
  phase: PlanTaskPhase;
  /** Next automatic run; null when a switch is off, manual, queued or running. */
  nextRunAt: number | null;
  /** A pending failure retry or back-off is held until then (also reflected in `nextRunAt`). */
  holdUntil: number | null;
  /** Retries left in the current round. */
  retryLeft: number;
  /** Last start of this task. */
  lastRunAt: number | null;
  lastEndedAt: number | null;
  lastResult: PlanRunResult | null;
  lastError: string | null;
  /** The queued or running run, to follow it in 执行监控. */
  runId: string | null;
  /** When it entered the queue (phase `queued`), for 「已等 …」. */
  queuedAt: number | null;
  runs: number;
  fails: number;
}

export interface PlanQueueEntry {
  accountId: string;
  taskId: string;
  runId: string;
}

/** One instance's queue. */
export interface PlanQueueView {
  instanceIndex: number;
  runningTaskId: string | null;
  /** Waiting task ids in execution order (priority, then queue time). */
  waitingTaskIds: string[];
  running: PlanQueueEntry | null;
  waiting: PlanQueueEntry[];
}

export interface PlanOverview {
  gameId: string;
  config: PlanConfig;
  plans: AccountPlan[];
  runtime: TaskRuntime[];
  /** Run history, newest first (≤ 200). */
  runs: PlanRun[];
  /** One row per task, ordered like the page (account name, priority desc, task id). */
  tasks: PlanTaskState[];
  queues: PlanQueueView[];
  /** Problems found while loading plans.json (it was repaired; the broken original was backed up). */
  warnings: string[];
  /** Another assistant process owns the timed scheduler of this game (edits work, runs happen there). */
  contended: boolean;
  /** When main built this snapshot; the page extrapolates countdowns from it. */
  at: number;
}

/** `plan-config-changed` push event. */
export interface PlanConfigEvent {
  gameId: string;
  config: PlanConfig;
}

/** Page order: accounts together (zh-CN collation), inside an account by priority (= execution order). */
export function comparePlanRows(a: Pick<PlanTaskState, 'accountName' | 'priority' | 'taskId'>, b: Pick<PlanTaskState, 'accountName' | 'priority' | 'taskId'>): number {
  return a.accountName.localeCompare(b.accountName, 'zh-CN') || b.priority - a.priority || a.taskId.localeCompare(b.taskId);
}
