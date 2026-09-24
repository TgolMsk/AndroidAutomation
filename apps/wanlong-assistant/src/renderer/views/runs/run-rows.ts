/**
 * Pure helpers of the 执行监控 page (tested in Node): one row per script execution, merging the runner's live
 * snapshots with plan queue records that never reached the runner (queued, skipped, older runs).
 */
import type { ScriptParamDef, ScriptParamValue } from '@avdm/automation/script';
import type { PlanRun, RunStats, RunStatus, ScriptRunSnapshot } from '../../../main/plans/types';
import { formatCstClock } from '../../../shared/time';
import { isScriptRunActive } from '../../state/plan-runs';

export type RowStatus = RunStatus | 'queued' | 'cancelled' | 'skipped';

export interface RunRow {
  runId: string;
  instanceIndex: number;
  scriptId: string;
  scriptName: string;
  accountName: string | null;
  source: 'plan' | 'manual';
  status: RowStatus;
  startedAt: number;
  endedAt: number | null;
  /** Live progress (only runs the runner executed in this session). */
  snapshot: ScriptRunSnapshot | null;
  /** Plan record message or the run's error. */
  message: string;
  active: boolean;
}

export const ROW_STATUS_LABEL: Record<RowStatus, string> = {
  pending: '等待中', starting: '启动中', running: '运行中', paused: '已暂停', stopping: '停止中',
  succeeded: '已完成', failed: '失败', aborted: '已停止', queued: '排队中', cancelled: '已取消', skipped: '已跳过',
};

export const SHOT_POLICY_OPTIONS: Array<{ value: 'never' | 'onFail' | 'always'; label: string }> = [
  { value: 'never', label: '不留痕（最省磁盘）' },
  { value: 'onFail', label: '仅失败时留痕（推荐）' },
  { value: 'always', label: '每步都留痕（很占磁盘）' },
];

export function buildRunRows(planRuns: readonly PlanRun[], scriptRuns: readonly ScriptRunSnapshot[], scriptName: (id: string) => string): RunRow[] {
  const rows = new Map<string, RunRow>();
  for (const run of scriptRuns) {
    rows.set(run.runId, {
      runId: run.runId, instanceIndex: run.instanceIndex, scriptId: run.scriptId, scriptName: run.scriptName, accountName: run.accountName,
      source: run.source, status: run.status, startedAt: run.startedAt, endedAt: run.endedAt, snapshot: run,
      message: run.error ?? (run.currentStepName ? `当前步骤：${run.currentStepName}` : ''), active: isScriptRunActive(run),
    });
  }
  for (const run of planRuns) {
    const live = rows.get(run.runId);
    if (live) {
      // A plan run whose executor finished but whose plan record says why it was cancelled / skipped.
      if (!live.active && (run.status === 'cancelled' || run.status === 'skipped')) rows.set(run.runId, { ...live, status: run.status, message: run.message });
      continue;
    }
    rows.set(run.runId, {
      runId: run.runId, instanceIndex: run.instanceIndex, scriptId: run.scriptId, scriptName: scriptName(run.scriptId), accountName: run.accountName,
      source: 'plan', status: run.status === 'running' ? 'running' : run.status, startedAt: run.startedAt ?? run.queuedAt, endedAt: run.endedAt,
      snapshot: null, message: run.message, active: run.status === 'queued' || run.status === 'running',
    });
  }
  return [...rows.values()].sort((a, b) => Number(b.active) - Number(a.active) || b.startedAt - a.startedAt);
}

/** `h:mm:ss` or `mm:ss`; a running run counts up to now. */
export function formatDuration(from: number, to: number | null, now = Date.now()): string {
  const ms = (to ?? now) - from;
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const seconds = Math.floor(ms / 1000);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** Hit rate in percent, or null without matches ("0 %" would read as "nothing matched"). */
export function hitRate(stats: Pick<RunStats, 'matches' | 'matchHits'>): number | null {
  return stats.matches > 0 ? Math.round(stats.matchHits / stats.matches * 100) : null;
}

/** The original thresholds: < 30 % hits means wrong templates / ROI; a tick over 2 s means a slow screencap. */
export const LOW_HIT_RATE = 30;
export const SLOW_TICK_MS = 2000;

export function progressLabel(snapshot: ScriptRunSnapshot): { percent: number | null; text: string } {
  if (snapshot.stepTotal && snapshot.stepTotal > 0) {
    return { percent: Math.min(100, Math.round(snapshot.stepDone / snapshot.stepTotal * 100)), text: snapshot.currentStepName ?? snapshot.currentStepId ?? '—' };
  }
  return { percent: null, text: `第 ${snapshot.iteration + 1} 轮｜已执行 ${snapshot.stepDone} 步｜${snapshot.currentStepName ?? '—'}` };
}

/** Initial values of a start-run param form: each declared default. */
export function defaultParams(params: readonly ScriptParamDef[] | undefined): Record<string, ScriptParamValue> {
  const out: Record<string, ScriptParamValue> = {};
  for (const param of params ?? []) if (param.default !== undefined) out[param.key] = param.default;
  return out;
}

/** A form value typed per its definition (number inputs deliver text). Invalid numbers are left out. */
export function coerceParam(param: ScriptParamDef, raw: string | boolean): ScriptParamValue | undefined {
  if (param.type === 'boolean') return raw === true || raw === 'true';
  if (param.type === 'number') {
    if (raw === '' || typeof raw === 'boolean') return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
  }
  return String(raw);
}

/** Why an instance cannot receive a manual run right now, or null when it can. */
export function instanceBlockReason(running: boolean, busyScript: string | null): string | null {
  if (!running) return '未开机';
  if (busyScript) return `正在跑 ${busyScript}`;
  return null;
}

/** `HH:MM:SS.mmm` in Beijing time (the one Beijing-time implementation plus milliseconds). */
export function logClock(ts: number): string {
  return `${formatCstClock(ts)}.${String(Math.floor(((ts % 1000) + 1000) % 1000)).padStart(3, '0')}`;
}

/** Structured data of a log line, shortened for the row (full text in the tooltip). */
export function shortData(data: Record<string, unknown> | undefined, max = 90): { short: string; full: string } | null {
  if (!data) return null;
  let full: string;
  try { full = JSON.stringify(data); } catch { return null; }
  return { full, short: full.length > max ? `${full.slice(0, max)}…` : full };
}
