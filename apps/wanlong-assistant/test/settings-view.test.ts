import { describe, expect, it } from 'vitest';
import { defaultAppSettings } from '../src/shared/app-settings';
import type { AppLogEntry, HealthReport } from '../src/shared/ipc';
import { RUN_STATUS_TEXT, runStatusText } from '../src/renderer/components/SemanticTag';
import { healthBadgeText } from '../src/renderer/hooks/useAppHealth';
import type { InstanceState } from '@avdm/core';
import { SETTINGS_CARDS } from '../src/renderer/views/settings/cards';
import { templateSetTitle } from '../src/renderer/views/settings/DataPathsCard';
import { DEVICE_TOOL_SLOTS } from '../src/renderer/views/settings/device-tool-slots';
import { apkSummary, defaultToolIndex } from '../src/renderer/views/settings/DeviceToolsCard';
import { logScopes, matchesLogFilter, mergeLogEntries } from '../src/renderer/views/settings/log-view';
import { appSettingsPatch, appSettingsProblems, emulatorSettingsProblems, numberInput } from '../src/renderer/views/settings/settings-form';

describe('shared status labels', () => {
  it('keeps the original run labels verbatim', () => {
    expect(Object.fromEntries(['pending', 'starting', 'running', 'paused', 'stopping', 'succeeded', 'failed', 'aborted']
      .map((status) => [status, RUN_STATUS_TEXT[status]!.label]))).toEqual({
      pending: '排队中', starting: '启动中', running: '执行中', paused: '已暂停', stopping: '停止中', succeeded: '已完成', failed: '失败', aborted: '已中止',
    });
    expect(runStatusText('queued').label).toBe('排队中');
    expect(runStatusText('cancelled')).toEqual(RUN_STATUS_TEXT['aborted']);
    expect(runStatusText('weird')).toEqual({ label: 'weird', tone: 'neutral' });
  });

  it('words the health badge like the original', () => {
    const report = (levels: ('ok' | 'warn' | 'fail')[]): HealthReport => ({
      ok: !levels.includes('fail'), checkedAt: 1, durationMs: 1,
      items: levels.map((level, i) => ({ key: `k${i}`, label: `项${i}`, level, ok: level !== 'fail', detail: '', group: 'assistant' })),
    });
    expect(healthBadgeText(null)).toEqual({ label: '自检未完成', tone: 'neutral' });
    expect(healthBadgeText(report(['ok', 'ok']))).toEqual({ label: '环境正常', tone: 'success' });
    expect(healthBadgeText(report(['ok', 'warn']))).toEqual({ label: '1 项提醒', tone: 'warning' });
    expect(healthBadgeText(report(['fail', 'warn', 'fail']))).toEqual({ label: '2 项异常', tone: 'danger' });
  });
});

describe('settings page', () => {
  it('has every section of the original settings page, one card each', () => {
    expect(SETTINGS_CARDS.map((card) => card.key)).toEqual([
      'services', 'panel', 'notifications', 'bot', 'ai', 'features', 'logs', 'health', 'update', 'emulator', 'paths', 'deviceTools',
      'legacyImport', 'about',
    ]);
    expect(new Set(SETTINGS_CARDS.map((card) => card.key)).size).toBe(SETTINGS_CARDS.length);
  });

  it('device tools pick a running instance and keep a slot for the Chinese input method tool', () => {
    const instance = (index: number, status: InstanceState['status']) => ({ record: { index, name: `i${index}` }, status }) as unknown as InstanceState;
    const instances = [instance(0, 'stopped'), instance(1, 'running'), instance(2, 'running')];
    expect(defaultToolIndex(instances, 2)).toBe(2);
    expect(defaultToolIndex(instances, 0)).toBe(1);
    expect(defaultToolIndex(instances, null)).toBe(1);
    expect(defaultToolIndex([instance(0, 'booting')], 0)).toBeNull();
    expect(apkSummary(['/Users/me/Downloads/ADBKeyboard.apk'])).toBe('ADBKeyboard.apk');
    expect(apkSummary(['/a/base.apk', '/a/split_config.apk'])).toBe('base.apk 等 2 个文件');
    expect(DEVICE_TOOL_SLOTS.map((slot) => slot.key)).toEqual(['ime']);
    expect(templateSetTitle({ index: 1, instanceName: '主号', path: '/s', exists: true, name: '万龙', templates: 93 })).toBe('实例 #1「主号」 · 模板集「万龙」93 张');
    expect(templateSetTitle({ index: 4, instanceName: null, path: '/s', exists: false, name: null, templates: null })).toBe('实例 #4（实例已删除）');
  });

  it('validates drafts and sends only the changed fields', () => {
    const saved = defaultAppSettings();
    const draft = { ...saved, shotPolicy: 'always' as const, minCaptureIntervalMs: numberInput('') };
    expect(appSettingsProblems(draft)).toEqual(['单实例最小截图间隔必须是 200 到 5000 毫秒的整数']);
    expect(appSettingsPatch(saved, { ...draft, minCaptureIntervalMs: 400 })).toEqual({ shotPolicy: 'always' });
    expect(appSettingsPatch(saved, saved)).toEqual({});
    expect(numberInput(' 0.9 ')).toBe(0.9);
    expect(emulatorSettingsProblems({ maxRunning: 0, healthIntervalSec: 5, bootTimeoutSec: 10 })).toEqual([
      '同时运行实例上限必须是 1 到 64 个的整数', '开机等待上限必须是 30 到 1800 秒的整数',
    ]);
  });

  it('filters and merges live log lines like the main-process query', () => {
    const entry = (ts: number, level: AppLogEntry['level'], scope: string, message: string): AppLogEntry => ({ ts, level, scope, message });
    const filter = { minLevel: 'warn' as const, scope: '', search: '' };
    expect(matchesLogFilter(entry(1, 'info', 'gather', 'x'), filter)).toBe(false);
    expect(matchesLogFilter(entry(1, 'error', 'gather', '出错'), { ...filter, scope: 'gather', search: '出' })).toBe(true);
    expect(matchesLogFilter(entry(1, 'error', 'update', '出错'), { ...filter, scope: 'gather' })).toBe(false);
    const current = [entry(3, 'warn', 'a', '三'), entry(1, 'warn', 'b', '一')];
    const merged = mergeLogEntries(current, [entry(4, 'error', 'a', '四'), entry(3, 'warn', 'a', '三')], 3);
    expect(merged.map((item) => item.message)).toEqual(['四', '三', '一']);
    expect(mergeLogEntries(merged, [entry(5, 'warn', 'c', '五')], 2).map((item) => item.message)).toEqual(['五', '四']);
    expect(logScopes(merged)).toEqual(['a', 'b']);
  });
});
