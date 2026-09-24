import { describe, expect, it } from 'vitest';
import type { AutomationRun, AutomationSchedule, AutomationSettings } from '../src/shared/ipc';
import {
  DEFAULT_VIEW, NAVIGATION, RETIRED_VIEWS, VIEW_KEYS, VIEW_STORAGE_KEY, parseStoredView, readStoredView,
  sectionForView, storeView, viewForSection, viewLabel,
} from '../src/renderer/navigation';
import { VIEW_REGISTRY, restoredScrollTop } from '../src/renderer/views/registry';
import { sectionTones, sortBadges } from '../src/renderer/state/badges';
import { isRunActive, upsertRun, upsertSchedule } from '../src/renderer/state/activity';
import { isPlanRunActive } from '../src/renderer/state/plan-runs';
import { GATHER_RESOURCES, wanlongConfig, wanlongDraftOf } from '../src/renderer/views/gather/gather-config';
import { describeServiceFailure, serviceFailureDetail, serviceFailureLabel } from '../src/renderer/hooks/useServiceFailures';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
  };
}

describe('seven-section navigation', () => {
  it('matches the original information architecture', () => {
    expect(NAVIGATION.map((section) => section.label)).toEqual(['设备与账号', '自动采集', '运行记录', '数据统计', 'AI 处理', '脚本与模板', '设置']);
    expect(NAVIGATION.map((section) => section.views.map((view) => view.key))).toEqual([
      ['instances', 'accounts'], ['gatherOverview'], ['plans', 'runs'], ['stats'], ['ai'], ['scripts', 'templates'], ['settings'],
    ]);
  });

  it('lists every page exactly once and registers a component for it', () => {
    expect(new Set(VIEW_KEYS).size).toBe(VIEW_KEYS.length);
    expect(Object.keys(VIEW_REGISTRY).sort()).toEqual([...VIEW_KEYS].sort());
    for (const key of VIEW_KEYS) expect(sectionForView(key).views.some((view) => view.key === key)).toBe(true);
    expect(viewLabel('templates')).toBe('模板库');
    // Pages holding unsaved drafts stay mounted, as the always-mounted workspace kept them before the split:
    // the script editor (template library round trip), the plan / 调度设置 drafts and the gather draft + probe.
    for (const key of ['gatherOverview', 'plans', 'scripts'] as const) expect(VIEW_REGISTRY[key].keepAlive, key).toBe(true);
  });

  it('brings a kept-alive page back at its scroll position and opens other pages at the top', () => {
    const saved = new Map([['scripts', 840], ['stats', 300]] as const);
    expect(restoredScrollTop('scripts', saved)).toBe(840);
    expect(restoredScrollTop('stats', saved)).toBe(0);
    expect(restoredScrollTop('plans', saved)).toBe(0);
  });

  it('remembers pages and survives broken storage', () => {
    const storage = memoryStorage();
    expect(readStoredView(storage)).toBe(DEFAULT_VIEW);
    storeView('stats', storage);
    expect(storage.data.get(VIEW_STORAGE_KEY)).toBe('stats');
    expect(readStoredView(storage)).toBe('stats');
    const retired = memoryStorage({ [VIEW_STORAGE_KEY]: 'gatherConfig' });
    expect(readStoredView(retired)).toBe('gatherOverview');
    expect(retired.data.get(VIEW_STORAGE_KEY)).toBe('gatherOverview');
    expect(parseStoredView('nonsense')).toBe(DEFAULT_VIEW);
    expect(parseStoredView(null)).toBe(DEFAULT_VIEW);
    const throwing = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(readStoredView(throwing)).toBe(DEFAULT_VIEW);
    expect(() => storeView('ai', throwing)).not.toThrow();
    for (const target of Object.values(RETIRED_VIEWS)) expect(VIEW_KEYS).toContain(target);
  });

  it('reopens a section at its last page', () => {
    expect(viewForSection('tools', {})).toBe('scripts');
    expect(viewForSection('tools', { tools: 'templates' })).toBe('templates');
    expect(viewForSection('tools', { tools: 'stats' })).toBe('scripts');
  });
});

describe('top-bar badges', () => {
  it('sorts by severity and marks the owning section', () => {
    const badges = sortBadges([
      { id: 'a', tone: 'info', label: '有更新', view: 'settings' },
      { id: 'b', tone: 'bad', label: '实例读取失败', view: 'instances' },
      { id: 'c', tone: 'warn', label: '缺少模板', view: 'templates' },
      { id: 'd', tone: 'warn', label: '账号待登录', view: 'accounts' },
    ]);
    expect(badges.map((badge) => badge.tone)).toEqual(['bad', 'warn', 'warn', 'info']);
    expect(sortBadges(badges).map((badge) => badge.id)).toEqual(badges.map((badge) => badge.id));
    expect(sectionTones(badges)).toEqual({ devices: 'bad', tools: 'warn', settings: 'info' });
  });
});

describe('service start failures', () => {
  it('says what broke, what is lost and that the rest keeps working', () => {
    const plans = { name: '脚本计划', message: 'plans.json 损坏。', impact: '定时脚本不会自动运行', at: 1 };
    expect(serviceFailureDetail(plans)).toBe('plans.json 损坏。定时脚本不会自动运行，其余功能不受影响；排除问题后重启助手即可重试。');
    expect(describeServiceFailure({ name: '运行监控', message: '同步失败', at: 1 }))
      .toBe('运行监控没能启动：同步失败。其余功能不受影响；排除问题后重启助手即可重试。');
    expect(serviceFailureLabel([])).toBeNull();
    expect(serviceFailureLabel([plans])).toBe('脚本计划未启动');
    expect(serviceFailureLabel([plans, { ...plans, name: '运行监控' }])).toBe('2 项服务未启动');
  });
});

describe('gather activity state', () => {
  const run = (runId: string, startedAt: number, status: AutomationRun['status'] = 'running'): AutomationRun =>
    ({ runId, gameId: 'wanlong', taskId: 'gather-once', index: 0, status, startedAt, endedAt: null, message: '' });
  const schedule = (index: number, enabled: boolean): AutomationSchedule =>
    ({ gameId: 'wanlong', index, enabled, nextWakeAt: null, failureCount: 0 });

  it('upserts runs newest first and schedules by game + instance', () => {
    const runs = upsertRun(upsertRun([run('a', 1)], run('b', 3)), run('a', 1, 'succeeded'));
    expect(runs.map((item) => `${item.runId}:${item.status}`)).toEqual(['b:running', 'a:succeeded']);
    expect(runs.filter(isRunActive)).toHaveLength(1);
    expect(isRunActive(run('c', 4, 'stopping'))).toBe(true);
    // The top bar's 「执行中」 also counts script runs that are queued or running.
    expect((['queued', 'running', 'succeeded', 'failed', 'cancelled', 'skipped'] as const).filter((status) => isPlanRunActive({ status })))
      .toEqual(['queued', 'running']);
    const schedules = upsertSchedule([schedule(0, true), schedule(1, true)], schedule(0, false));
    expect(schedules).toEqual([schedule(0, false), schedule(1, true)]);
  });
});

describe('gather config draft', () => {
  const settings = (config: Record<string, unknown>): AutomationSettings => ({ templateDir: '/t', config });

  it('takes resource defaults from the single automation source (mana off, no queue)', () => {
    expect(GATHER_RESOURCES.map((item) => item.label)).toEqual(['木材', '金币', '铁矿石', '魔水']);
    expect(GATHER_RESOURCES.find((item) => item.type === 'mana')).toMatchObject({ defaultEnabled: false, defaultQueues: 0 });
    const draft = wanlongDraftOf(settings({}));
    expect(draft).toEqual({ enabled: false, resources: { wood: true, gold: true, iron: true, mana: false } });
    const config = wanlongConfig(settings({}), draft);
    expect(config['version']).toBe(2);
    expect((config['resources'] as { type: string; queues: number }[]).find((item) => item.type === 'mana')?.queues).toBe(0);
  });

  it('gives an enabled resource at least one queue and keeps fields the page does not edit', () => {
    const saved = settings({ version: 2, enabled: true, schedule: { x: 1 }, resources: [{ type: 'mana', enabled: false, queues: 0, minStorage: 5 }] });
    const draft = wanlongDraftOf(saved);
    const config = wanlongConfig(saved, { ...draft, resources: { ...draft.resources, mana: true } });
    const mana = (config['resources'] as Record<string, unknown>[]).find((item) => item['type'] === 'mana');
    expect(mana).toMatchObject({ enabled: true, queues: 1, minStorage: 5, priority: 4 });
    expect(config['schedule']).toEqual({ x: 1 });
    expect(config['enabled']).toBe(true);
  });
});
