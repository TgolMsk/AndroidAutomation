/**
 * Pure helpers of the 任务计划 page (no React, no IPC) so they can be tested in Node. Every rule about when a task
 * runs lives in the main process and `src/shared/plan.ts`; this file only shapes drafts and texts.
 */
import { formatDuration } from '@avdm/automation/wanlong/pure';
import type { GameAccount } from '../../../main/automation/accounts/types';
import type { ScriptMeta } from '../../../main/plans/types';
import {
  clampToRange, makeTaskId, parseClock, PLAN_ID_RE, PLAN_RANGE,
  type AccountPlan, type PlanConfig, type PlanQueueView, type PlanTask, type PlanTaskPhase, type PlanTaskState, type TaskTrigger,
} from '../../../shared/plan';
import { formatCst } from '../../../shared/time';
import type { SemanticTone } from '../../components/SemanticTag';

export const PHASE_TONE: Readonly<Record<PlanTaskPhase, SemanticTone>> = {
  idle: 'neutral',
  queued: 'warning',
  running: 'accent',
  done: 'success',
  failed: 'danger',
  skipped: 'warning',
};

export const TRIGGER_KINDS: ReadonlyArray<{ kind: TaskTrigger['kind']; label: string }> = [
  { kind: 'daily', label: '每天固定时刻' },
  { kind: 'interval', label: '按间隔重复' },
  { kind: 'manual', label: '仅手动' },
];

/** Switching the trigger kind in the dialog (original defaults: 08:00 / every 60 minutes). */
export function triggerOfKind(kind: TaskTrigger['kind']): TaskTrigger {
  if (kind === 'daily') return { kind: 'daily', at: ['08:00'] };
  if (kind === 'interval') return { kind: 'interval', everyMinutes: 60 };
  return { kind: 'manual' };
}

/** One typed daily time: trimmed, `8:30` padded to `08:30`; null when it is not a Beijing `HH:MM`. */
export function normalizeClockInput(value: string): string | null {
  const text = value.trim().replace('：', ':');
  const padded = /^\d:\d\d$/.test(text) ? `0${text}` : text;
  return parseClock(padded) === null ? null : padded;
}

/** Splits typed text on the original separators (「,」「，」 and spaces) into times; bad pieces are reported. */
export function parseDailyInput(text: string): { times: string[]; invalid: string[] } {
  const times: string[] = [];
  const invalid: string[] = [];
  for (const piece of text.split(/[,，\s]+/).filter(Boolean)) {
    const clock = normalizeClockInput(piece);
    if (clock) times.push(clock); else invalid.push(piece);
  }
  return { times, invalid };
}

/** Adds times to a daily list: deduplicated and sorted, like the store keeps them. */
export function addDailyTimes(current: readonly string[], add: readonly string[]): string[] {
  return [...new Set([...current, ...add])].sort();
}

export const NOTE_MAX = 80;

/** The dialog's checks before saving (Chinese, actionable). Null = OK. */
export function taskDraftProblem(task: PlanTask): string | null {
  if (!task.scriptId) return '请选择一个脚本。';
  const t = task.trigger;
  if (t.kind === 'daily' && (t.at.length === 0 || t.at.some((value) => parseClock(value) === null))) {
    return '「每天」至少要填一个时刻，格式是 HH:MM（北京时间），例如 08:00。';
  }
  if (t.kind === 'interval') {
    if (!Number.isInteger(t.everyMinutes) || t.everyMinutes < PLAN_RANGE.everyMinutes[0] || t.everyMinutes > PLAN_RANGE.everyMinutes[1]) {
      return `间隔要是 ${PLAN_RANGE.everyMinutes[0]}–${PLAN_RANGE.everyMinutes[1]} 分钟的整数。`;
    }
    if (t.window && (parseClock(t.window.from) === null || parseClock(t.window.to) === null)) {
      return '时段的起止时刻要写成 HH:MM（北京时间），例如 09:00 至 23:00。';
    }
  }
  if (!Number.isInteger(task.priority) || task.priority < PLAN_RANGE.priority[0] || task.priority > PLAN_RANGE.priority[1]) {
    return `优先级要是 ${PLAN_RANGE.priority[0]}–${PLAN_RANGE.priority[1]} 的整数。`;
  }
  if (!Number.isInteger(task.maxRunMinutes) || task.maxRunMinutes < PLAN_RANGE.maxRunMinutes[0] || task.maxRunMinutes > PLAN_RANGE.maxRunMinutes[1]) {
    return `单次时间上限要是 ${PLAN_RANGE.maxRunMinutes[0]}–${PLAN_RANGE.maxRunMinutes[1]} 分钟的整数（0 表示不限）。`;
  }
  if ((task.note ?? '').length > NOTE_MAX) return `备注最多 ${NOTE_MAX} 个字。`;
  return null;
}

/** What the dialog saves: trimmed times and window, no empty note. */
export function cleanTask(task: PlanTask): PlanTask {
  const next: PlanTask = { ...task, trigger: structuredClone(task.trigger) };
  if (next.trigger.kind === 'daily') next.trigger = { kind: 'daily', at: addDailyTimes([], next.trigger.at.map((v) => v.trim())) };
  if (next.trigger.kind === 'interval' && next.trigger.window) {
    next.trigger = { ...next.trigger, window: { from: next.trigger.window.from.trim(), to: next.trigger.window.to.trim() } };
  }
  const note = next.note?.trim();
  if (note) next.note = note; else delete next.note;
  return next;
}

/**
 * Upsert one task into its account plan (original saveDraft): a new plan's account switch starts on, otherwise
 * checking a task would look broken while the whole account is off.
 */
export function withTask(plan: AccountPlan, task: PlanTask): AccountPlan {
  const exists = plan.tasks.some((item) => item.id === task.id);
  const tasks = exists ? plan.tasks.map((item) => (item.id === task.id ? task : item)) : [...plan.tasks, task];
  return { ...plan, enabled: plan.tasks.length === 0 ? true : plan.enabled, tasks };
}

/**
 * Imported legacy tasks are appended (「只增不改」): the account's own tasks and switch stay; an imported task
 * whose id is taken gets a fresh one. Nothing imported runs by itself: into an account plan that is already on,
 * the imported tasks arrive unchecked (a new plan stays off as a whole instead).
 */
export function mergeImportedPlan(current: AccountPlan, imported: AccountPlan, newId: () => string = () => makeTaskId()): { plan: AccountPlan; added: number } {
  const used = new Set(current.tasks.map((task) => task.id));
  const added = imported.tasks.map((task) => {
    let id = task.id;
    while (used.has(id) || !PLAN_ID_RE.test(id)) id = newId();
    used.add(id);
    return { ...task, id, enabled: current.enabled ? false : task.enabled };
  });
  return { plan: { ...current, tasks: [...current.tasks, ...added] }, added: added.length };
}

// ── Config dialog (UI units: seconds / minutes) ─────────────────────────────

export interface PlanConfigDraft {
  preemptGraceSec: number;
  catchUpMin: number;
  queueWaitMin: number;
  retry: number;
  retryDelaySec: number;
  aiAssist: boolean;
  maxConcurrentScripts: number;
}

export function configDraftOf(config: PlanConfig): PlanConfigDraft {
  return {
    preemptGraceSec: Math.round(config.preemptGraceMs / 1000),
    catchUpMin: Math.round(config.catchUpMs / 60_000),
    queueWaitMin: Math.round(config.queueWaitMs / 60_000),
    retry: config.retry,
    retryDelaySec: Math.round(config.retryDelayMs / 1000),
    aiAssist: config.aiAssist,
    maxConcurrentScripts: config.maxConcurrentScripts,
  };
}

/** Back to milliseconds, clamped into `PLAN_RANGE` (the input bounds come from the same table). */
export function configPatchOf(draft: PlanConfigDraft): Partial<PlanConfig> {
  return {
    preemptGraceMs: clampToRange(draft.preemptGraceSec * 1000, PLAN_RANGE.preemptGraceMs),
    catchUpMs: clampToRange(draft.catchUpMin * 60_000, PLAN_RANGE.catchUpMs),
    queueWaitMs: clampToRange(draft.queueWaitMin * 60_000, PLAN_RANGE.queueWaitMs),
    retry: clampToRange(draft.retry, PLAN_RANGE.retry),
    retryDelayMs: clampToRange(draft.retryDelaySec * 1000, PLAN_RANGE.retryDelayMs),
    aiAssist: draft.aiAssist,
    maxConcurrentScripts: clampToRange(draft.maxConcurrentScripts, PLAN_RANGE.maxConcurrentScripts),
  };
}

/** Input bounds in the dialog's units. */
export const CONFIG_BOUNDS = {
  preemptGraceSec: [PLAN_RANGE.preemptGraceMs[0] / 1000, PLAN_RANGE.preemptGraceMs[1] / 1000],
  catchUpMin: [PLAN_RANGE.catchUpMs[0] / 60_000, PLAN_RANGE.catchUpMs[1] / 60_000],
  queueWaitMin: [PLAN_RANGE.queueWaitMs[0] / 60_000, PLAN_RANGE.queueWaitMs[1] / 60_000],
  retry: PLAN_RANGE.retry,
  retryDelaySec: [PLAN_RANGE.retryDelayMs[0] / 1000, PLAN_RANGE.retryDelayMs[1] / 1000],
  maxConcurrentScripts: PLAN_RANGE.maxConcurrentScripts,
} as const;

// ── Row texts ───────────────────────────────────────────────────────────────

/** 「下次运行」: a countdown extrapolated from `now` plus the Beijing time; null → 「—」. */
export function nextRunText(row: Pick<PlanTaskState, 'nextRunAt'>, now: number): { countdown: string; at: string } | null {
  if (row.nextRunAt === null) return null;
  return { countdown: formatDuration(Math.max(0, row.nextRunAt - now)), at: `${formatCst(row.nextRunAt, false)}（北京）` };
}

/** 「已等 …」 of a queued row. */
export function waitedText(row: Pick<PlanTaskState, 'phase' | 'queuedAt'>, now: number): string | null {
  return row.phase === 'queued' && row.queuedAt !== null ? `已等 ${formatDuration(Math.max(0, now - row.queuedAt))}` : null;
}

/** 「上次」: last start (Beijing) and the counters; null when it never ran. */
export function lastRunText(row: Pick<PlanTaskState, 'lastRunAt' | 'runs' | 'fails'>): { at: string; counts: string } | null {
  if (row.lastRunAt === null) return null;
  return { at: formatCst(row.lastRunAt, false), counts: `共 ${row.runs} 次${row.fails > 0 ? `，失败 ${row.fails} 次` : ''}` };
}

/** 「运行时间」 second line. */
export function limitText(row: Pick<PlanTaskState, 'priority' | 'maxRunMinutes'>): string {
  return `优先级 ${row.priority}${row.maxRunMinutes > 0 ? ` · 上限 ${row.maxRunMinutes} 分钟` : ' · 不限时'}`;
}

/** Why 「立即运行」 is disabled on this row, or null. */
export function runNowBlocked(row: Pick<PlanTaskState, 'accountIssue' | 'scriptName' | 'instanceIndex'>): string | null {
  if (row.accountIssue === '账号已删除') return '这条计划挂的账号已经不存在了，请先把它删掉';
  if (row.instanceIndex === null) return '账号还没绑定实例，没法跑脚本';
  if (!row.scriptName) return '脚本已删除或无法读取';
  if (row.accountIssue) return `账号${row.accountIssue.replace(/^账号/, '')}，请先到「账号管理」处理`;
  return null;
}

/** The row's task switch is disabled while its account switch is off (original tooltip). */
export function taskSwitchTitle(row: Pick<PlanTaskState, 'accountEnabled'>): string {
  return row.accountEnabled ? '勾上才会自动跑' : '这个账号的总开关是关的';
}

/** Account choices of the dialog: 「名称（实例 N）」 / 「名称（未绑定实例）」. */
export function accountOptions(accounts: readonly GameAccount[]): Array<{ value: string; label: string }> {
  return accounts.map((account) => ({
    value: account.id,
    label: account.binding ? `${account.name}（实例 ${account.binding.index}）` : `${account.name}（未绑定实例）`,
  }));
}

/** Script choices: 「名称（N 步）」; unreadable scripts cannot be planned. */
export function scriptOptions(scripts: readonly ScriptMeta[]): Array<{ value: string; label: string }> {
  return scripts.filter((script) => script.version !== '0').map((script) => ({ value: script.id, label: `${script.name}（${script.stepCount} 步）` }));
}

/** One line per instance queue: 「实例 #0：执行中 日常；排队 联盟、收菜」. */
export function queueLines(queues: readonly PlanQueueView[], rows: readonly PlanTaskState[]): string[] {
  const name = (accountId: string, taskId: string): string => {
    const row = rows.find((item) => item.accountId === accountId && item.taskId === taskId);
    return row ? `${row.scriptName ?? row.scriptId}（${row.accountName}）` : taskId;
  };
  return queues.filter((queue) => queue.running || queue.waiting.length).map((queue) => {
    const parts = [];
    if (queue.running) parts.push(`执行中 ${name(queue.running.accountId, queue.running.taskId)}`);
    if (queue.waiting.length) parts.push(`排队 ${queue.waiting.map((item) => name(item.accountId, item.taskId)).join('、')}`);
    return `实例 #${queue.instanceIndex}：${parts.join('；')}`;
  });
}
