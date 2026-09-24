import type { OpenDialogOptions } from 'electron';
import { LOG_LEVELS, SHOT_POLICIES, type LogLevel } from '@avdm/automation/script';
import type { RunsApi } from '../../shared/ipc';
import type { PlanService } from '../plans';
import { SCRIPT_RUN_PRIORITIES, type RunLogQuery, type ScriptRunOptions } from '../plans/types';
import type { DomainHandlers } from './types';
import { asIndex, flag, game, patchObject, text } from './validate';

export interface RunsServices {
  plans: PlanService;
}

function runOptions(value: unknown): ScriptRunOptions | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = patchObject(value as ScriptRunOptions, '运行选项');
  const out: ScriptRunOptions = {};
  if (raw.accountId !== undefined && raw.accountId !== null && raw.accountId !== '') out.accountId = text(raw.accountId, '账号 ID');
  if (raw.params !== undefined) out.params = patchObject(raw.params, '脚本参数');
  if (raw.shotPolicy !== undefined) {
    if (!SHOT_POLICIES.includes(raw.shotPolicy)) throw new Error('截图留痕策略无效');
    out.shotPolicy = raw.shotPolicy;
  }
  if (raw.maxRunMinutes !== undefined) {
    if (!Number.isInteger(raw.maxRunMinutes)) throw new Error('运行时长上限无效');
    out.maxRunMinutes = raw.maxRunMinutes;
  }
  if (raw.priority !== undefined) {
    if (!SCRIPT_RUN_PRIORITIES.includes(raw.priority)) throw new Error('执行优先级无效');
    out.priority = raw.priority;
  }
  return out;
}

function logQuery(value: unknown): RunLogQuery {
  const raw = patchObject(value as RunLogQuery, '日志查询');
  const query: RunLogQuery = { runId: text(raw.runId, '运行 ID') };
  if (raw.minLevel !== undefined) {
    if (!LOG_LEVELS.includes(raw.minLevel as LogLevel)) throw new Error('日志级别无效');
    query.minLevel = raw.minLevel;
  }
  if (raw.since !== undefined) {
    if (typeof raw.since !== 'number' || !Number.isFinite(raw.since)) throw new Error('起始时间无效');
    query.since = raw.since;
  }
  if (raw.limit !== undefined) {
    if (!Number.isInteger(raw.limit) || raw.limit < 1) throw new Error('条数上限无效');
    query.limit = raw.limit;
  }
  if (raw.instanceIndex !== undefined) query.instanceIndex = asIndex(raw.instanceIndex);
  return query;
}

export const runsHandlers: DomainHandlers<RunsApi, RunsServices> = {
  async scriptRun({ plans }, gameId, index, scriptId, options) {
    return plans.runScript(game(gameId), asIndex(index), text(scriptId, '脚本 ID'), runOptions(options));
  },
  async runList({ plans }, gameId) { return plans.listRuns(game(gameId)); },
  async runPause({ plans }, gameId, runId) { plans.pauseRun(game(gameId), text(runId, '运行 ID')); },
  async runResume({ plans }, gameId, runId) { plans.resumeRun(game(gameId), text(runId, '运行 ID')); },
  async runStop({ plans }, gameId, runId) { await plans.cancelRun(game(gameId), text(runId, '运行 ID')); },
  async runLogs({ plans }, gameId, query) { return plans.runLogs(game(gameId), logQuery(query)); },
  async runShot({ plans }, gameId, runId, shot) {
    return plans.runShot(game(gameId), text(runId, '运行 ID'), text(shot, '截图路径'));
  },
  async runDebugMatches({ plans }, gameId, runId, enabled) {
    plans.setRunDebugMatches(game(gameId), text(runId, '运行 ID'), flag(enabled, '匹配调试开关'));
  },
  async imeStatus({ plans }, index) { return plans.imeStatus(asIndex(index)); },
  async imeSetup({ plans, sender }, index) {
    const i = asIndex(index);
    // Imported lazily (conventions §2.4): handler modules stay importable in vitest without the Electron mock.
    const { BrowserWindow, dialog } = await import('electron');
    const options: OpenDialogOptions = {
      title: '选择 ADBKeyboard 安装包（APK）', buttonLabel: '安装到实例', properties: ['openFile'],
      filters: [{ name: 'Android 安装包', extensions: ['apk'] }],
    };
    const win = BrowserWindow.fromWebContents(sender);
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    const file = result.canceled ? null : result.filePaths[0] ?? null;
    return file ? plans.setupIme(i, file) : null;
  },
};
