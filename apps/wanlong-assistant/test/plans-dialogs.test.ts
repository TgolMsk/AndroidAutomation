import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PlanConfigDialog } from '../src/renderer/views/plans/PlanConfigDialog';
import { TaskDialog, type TaskDraft } from '../src/renderer/views/plans/TaskDialog';
import { defaultPlanConfig, emptyTask } from '../src/shared/plan';

/** Static renders of the 任务计划 dialogs: every trigger editor and the settings form render without a runtime error. */
// Vitest compiles TSX with the classic runtime (the app build uses the automatic one): provide the global it expects.
(globalThis as { React?: typeof React }).React = React;
const noop = (): void => undefined;
const accounts = [{ value: 'a1', label: '主号（实例 0）' }];
const scripts = [{ value: 's1', label: '日常（3 步）' }];

function renderTask(draft: TaskDraft): string {
  return renderToStaticMarkup(createElement(TaskDialog, {
    draft, accountOptions: accounts, scriptOptions: scripts, busy: false, onChange: noop, onClose: noop, onSave: noop,
  }));
}

describe('任务计划 dialogs', () => {
  it('renders the daily, interval (with window) and manual editors', () => {
    const task = emptyTask('task_1', 's1');
    const daily = renderTask({ accountId: 'a1', task: { ...task, trigger: { kind: 'daily', at: ['08:00', '20:30'] } }, editing: false });
    expect(daily).toContain('添加任务');
    expect(daily).toContain('08:00');
    expect(daily).toContain('20:30');
    expect(daily).toContain('HH:MM 一律是北京时间');
    const interval = renderTask({ accountId: 'a1', task: { ...task, trigger: { kind: 'interval', everyMinutes: 45, window: { from: '22:00', to: '06:00' } } }, editing: true });
    expect(interval).toContain('编辑任务');
    expect(interval).toContain('value="22:00"');
    expect(interval).toContain('限时段');
    const manual = renderTask({ accountId: 'a1', task: { ...task, scriptId: 'gone', trigger: { kind: 'manual' } }, editing: false });
    expect(manual).toContain('只在这一页点「立即运行」时才跑');
    expect(manual).toContain('脚本已删除（gone）');
    const broken = renderTask({ accountId: 'a1', task: { ...task, trigger: { kind: 'daily', at: [] } }, editing: false });
    expect(broken).toContain('「每天」至少要填一个时刻');
  });

  it('renders the settings form in seconds / minutes with PLAN_RANGE bounds', () => {
    const html = renderToStaticMarkup(createElement(PlanConfigDialog, { config: defaultPlanConfig(), busy: false, onClose: noop, onSave: noop }));
    expect(html).toContain('计划设置');
    expect(html).toContain('抢占宽限');
    expect(html).toMatch(/max="120"[^>]*value="8"|value="8"[^>]*max="120"/);
    expect(html).toContain('同时运行脚本上限');
    expect(html).toContain('脚本执行期间允许 AI 介入');
  });
});
