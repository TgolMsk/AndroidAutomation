import { describe, expect, it } from 'vitest';
import type { GameAccount } from '../src/main/automation/accounts/types';
import type { ScriptMeta } from '../src/main/plans/types';
import {
  accountOptions, addDailyTimes, cleanTask, CONFIG_BOUNDS, configDraftOf, configPatchOf, lastRunText, limitText, mergeImportedPlan,
  nextRunText, normalizeClockInput, parseDailyInput, queueLines, runNowBlocked, scriptOptions, taskDraftProblem, taskSwitchTitle,
  triggerOfKind, waitedText, withTask,
} from '../src/renderer/views/plans/plans-model';
import { defaultPlanConfig, emptyTask, PLAN_RANGE, type AccountPlan, type PlanTaskState } from '../src/shared/plan';

const ACCOUNT = '00000000-0000-4000-8000-000000000001';

function row(extra: Partial<PlanTaskState> = {}): PlanTaskState {
  return {
    accountId: ACCOUNT, accountName: '主号', accountMissing: false, accountIssue: null, instanceIndex: 0, taskId: 't1', scriptId: 's1',
    scriptName: '日常', enabled: true, accountEnabled: true, trigger: { kind: 'daily', at: ['08:00'] }, priority: 50, maxRunMinutes: 30,
    phase: 'idle', nextRunAt: null, holdUntil: null, retryLeft: 0, lastRunAt: null, lastEndedAt: null, lastResult: null, lastError: null,
    runId: null, queuedAt: null, runs: 0, fails: 0, ...extra,
  };
}

describe('任务计划 page helpers', () => {
  it('parses daily times with the original separators and pads single-digit hours', () => {
    expect(normalizeClockInput(' 8:30 ')).toBe('08:30');
    expect(normalizeClockInput('20：30')).toBe('20:30');
    expect(normalizeClockInput('24:00')).toBeNull();
    expect(parseDailyInput('08:00, 20:30，7:05 x 25:00')).toEqual({ times: ['08:00', '20:30', '07:05'], invalid: ['x', '25:00'] });
    expect(addDailyTimes(['20:30'], ['08:00', '20:30'])).toEqual(['08:00', '20:30']);
  });

  it('checks a task draft before saving, with Chinese guidance', () => {
    const task = emptyTask('task_1', 's1');
    expect(taskDraftProblem(task)).toBeNull();
    expect(taskDraftProblem({ ...task, trigger: { kind: 'daily', at: [] } })).toContain('「每天」至少要填一个时刻');
    expect(taskDraftProblem({ ...task, trigger: { kind: 'interval', everyMinutes: 30, window: { from: '9', to: '23:00' } } })).toContain('时段');
    expect(taskDraftProblem({ ...task, maxRunMinutes: 721 })).toContain('0 表示不限');
    expect(taskDraftProblem({ ...task, maxRunMinutes: 0 })).toBeNull();
    expect(taskDraftProblem({ ...task, note: 'x'.repeat(81) })).toContain('备注');
    expect(triggerOfKind('interval')).toEqual({ kind: 'interval', everyMinutes: 60 });
    expect(cleanTask({ ...task, note: '  ', trigger: { kind: 'daily', at: ['20:30', ' 08:00'] } })).toEqual({ ...task, trigger: { kind: 'daily', at: ['08:00', '20:30'] } });
  });

  it('turns the account switch on for a new plan only, and appends imported tasks without overwriting', () => {
    const empty: AccountPlan = { accountId: ACCOUNT, enabled: false, tasks: [], updatedAt: 0 };
    const first = withTask(empty, emptyTask('a', 's1'));
    expect(first.enabled).toBe(true);
    const off = { ...first, enabled: false };
    expect(withTask(off, emptyTask('b', 's1')).enabled).toBe(false);
    expect(withTask(off, { ...emptyTask('a', 's2') }).tasks.map((task) => task.scriptId)).toEqual(['s2']);
    const merged = mergeImportedPlan(off, { ...empty, tasks: [emptyTask('a', 'old'), emptyTask('c', 'old2')] }, () => 'task_fresh');
    expect(merged.added).toBe(2);
    expect(merged.plan.enabled).toBe(false);
    expect(merged.plan.tasks.map((task) => `${task.id}:${task.scriptId}`)).toEqual(['a:s1', 'task_fresh:old', 'c:old2']);
    expect(merged.plan.tasks.every((task) => task.enabled)).toBe(true);
    // Into a plan that is already on, imported tasks arrive unchecked: nothing imported runs by itself.
    const on = mergeImportedPlan(first, { ...empty, tasks: [emptyTask('x', 'old')] });
    expect(on.plan).toMatchObject({ enabled: true });
    expect(on.plan.tasks.map((task) => [task.id, task.enabled])).toEqual([['a', true], ['x', false]]);
  });

  it('converts the settings dialog units and clamps into PLAN_RANGE', () => {
    const draft = configDraftOf(defaultPlanConfig());
    expect(draft).toEqual({ preemptGraceSec: 8, catchUpMin: 30, queueWaitMin: 30, retry: 1, retryDelaySec: 60, aiAssist: true, maxConcurrentScripts: 4 });
    expect(configPatchOf({ ...draft, preemptGraceSec: 999, queueWaitMin: 0, maxConcurrentScripts: 99 })).toMatchObject({
      preemptGraceMs: PLAN_RANGE.preemptGraceMs[1], queueWaitMs: PLAN_RANGE.queueWaitMs[0], maxConcurrentScripts: 16, catchUpMs: 30 * 60_000,
    });
    expect(CONFIG_BOUNDS.preemptGraceSec).toEqual([0, 120]);
    expect(CONFIG_BOUNDS.queueWaitMin).toEqual([1, 720]);
  });

  it('renders countdowns and times in Beijing time, never the host zone', () => {
    const nextRunAt = Date.UTC(2026, 8, 18, 12, 30); // Beijing 20:30
    expect(nextRunText(row({ nextRunAt }), nextRunAt - 90_061_000)).toEqual({ countdown: '1天 01:01:01', at: '2026-09-18 20:30（北京）' });
    expect(nextRunText(row(), 0)).toBeNull();
    expect(waitedText(row({ phase: 'queued', queuedAt: 1_000 }), 65_000)).toBe('已等 00:01:04');
    expect(waitedText(row({ phase: 'idle', queuedAt: 1_000 }), 65_000)).toBeNull();
    expect(lastRunText(row({ lastRunAt: Date.UTC(2026, 8, 18, 0, 0), runs: 3, fails: 1 }))).toEqual({ at: '2026-09-18 08:00', counts: '共 3 次，失败 1 次' });
    expect(lastRunText(row())).toBeNull();
    expect(limitText(row())).toBe('优先级 50 · 上限 30 分钟');
    expect(limitText(row({ maxRunMinutes: 0 }))).toBe('优先级 50 · 不限时');
  });

  it('explains why a row cannot run now', () => {
    expect(runNowBlocked(row())).toBeNull();
    expect(runNowBlocked(row({ instanceIndex: null, accountIssue: '未绑定实例' }))).toContain('没绑定实例');
    expect(runNowBlocked(row({ scriptName: null }))).toContain('脚本已删除');
    expect(runNowBlocked(row({ accountIssue: '账号已删除', accountMissing: true, instanceIndex: null }))).toContain('账号已经不存在');
    expect(runNowBlocked(row({ accountIssue: '尚未完成登录验证' }))).toBe('账号尚未完成登录验证，请先到「账号管理」处理');
    expect(taskSwitchTitle(row({ accountEnabled: false }))).toBe('这个账号的总开关是关的');
  });

  it('labels accounts, scripts and queues', () => {
    const accounts = [
      { id: ACCOUNT, name: '主号', binding: { index: 2, instanceCreatedAt: 'x' } },
      { id: 'b', name: '小号', binding: null },
    ] as GameAccount[];
    expect(accountOptions(accounts).map((option) => option.label)).toEqual(['主号（实例 2）', '小号（未绑定实例）']);
    const scripts = [{ id: 's1', name: '日常', stepCount: 3, version: '1.0.0' }, { id: 'bad', name: '坏的', stepCount: 0, version: '0' }] as ScriptMeta[];
    expect(scriptOptions(scripts)).toEqual([{ value: 's1', label: '日常（3 步）' }]);
    const rows = [row(), row({ taskId: 't2', scriptName: null, scriptId: 'gone' })];
    expect(queueLines([
      { instanceIndex: 0, runningTaskId: 't1', waitingTaskIds: ['t2'], running: { accountId: ACCOUNT, taskId: 't1', runId: 'r1' },
        waiting: [{ accountId: ACCOUNT, taskId: 't2', runId: 'r2' }] },
      { instanceIndex: 1, runningTaskId: null, waitingTaskIds: [], running: null, waiting: [] },
    ], rows)).toEqual(['实例 #0：执行中 日常（主号）；排队 gone（主号）']);
  });
});
