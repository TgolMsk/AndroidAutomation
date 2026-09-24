import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppSettingsStore } from '../src/main/app/settings-store';
import {
  APP_SETTINGS_KEYS, defaultAppSettings, keepShot, legacyAppSettingsPatch, mergeAppSettings, parseStoredAppSettings, type AppSettings,
} from '../src/shared/app-settings';

let home: string;
let file: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'avdm-app-settings-'));
  file = path.join(home, 'automation', 'app-settings.json');
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

async function onDisk(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
}

describe('app settings defaults and validation (shared, pure)', () => {
  it('has one source of defaults, matching the original measured values', () => {
    expect(defaultAppSettings()).toEqual({
      shotPolicy: 'onFail', matchThreshold: 0.85, shrink: 2, minCaptureIntervalMs: 400, logLevel: 'warn', locale: 'zh-CN',
    });
    expect(defaultAppSettings()).not.toBe(defaultAppSettings());
    expect(Object.keys(defaultAppSettings()).sort()).toEqual([...APP_SETTINGS_KEYS].sort());
  });

  it('merges a partial file per field, ignores unknown keys, and falls back entirely on an invalid value', () => {
    expect(parseStoredAppSettings({ shotPolicy: 'always', emulator: 'mumu', adbPath: 'C:\\adb.exe' })).toEqual({
      settings: { ...defaultAppSettings(), shotPolicy: 'always' }, problems: [],
    });
    const invalid = parseStoredAppSettings({ shotPolicy: 'always', shrink: 9 });
    expect(invalid.settings).toEqual(defaultAppSettings());
    expect(invalid.problems).toEqual(['匹配降采样倍率必须是 1 到 4 的整数']);
    expect(parseStoredAppSettings([1, 2]).problems).toEqual(['设置文件不是 JSON 对象']);
  });

  it('rejects unknown keys and out-of-range values with Chinese messages', () => {
    const base = defaultAppSettings();
    expect(mergeAppSettings(base, { matchThreshold: 0.9 })).toEqual({ ...base, matchThreshold: 0.9 });
    expect(() => mergeAppSettings(base, { dataDir: '/tmp' })).toThrow('未知的应用设置：dataDir');
    expect(() => mergeAppSettings(base, { matchThreshold: 1.5 })).toThrow('默认命中阈值必须在 0.5 到 0.999 之间');
    expect(() => mergeAppSettings(base, { minCaptureIntervalMs: 100 })).toThrow('单实例最小截图间隔必须是 200 到 5000 毫秒的整数');
    expect(() => mergeAppSettings(base, { shotPolicy: 'sometimes' })).toThrow('截图留痕策略');
    expect(() => mergeAppSettings(base, { locale: 'en' })).toThrow('界面语言目前只支持简体中文');
    expect(() => mergeAppSettings(base, null)).toThrow('应用设置无效');
  });

  it('carries over only the still-meaningful fields of the original panel settings (explicit import)', () => {
    const original = {
      emulator: 'mumu', adbPath: 'D:\\tool\\MuMuPlayer\\nx_main\\adb.exe', mumutoolPath: '', dataDir: 'D:\\wl', refWidth: 2560, refHeight: 1440,
      shrink: 2, matchThreshold: 0.9, maxConcurrentInstances: 4, minCaptureIntervalMs: 100, shotPolicy: 'always',
      instancePollIntervalMs: 3000, locale: 'zh-CN',
    };
    const { patch, ignored } = legacyAppSettingsPatch(original);
    expect(patch).toEqual({ shrink: 2, matchThreshold: 0.9, shotPolicy: 'always', locale: 'zh-CN' });
    expect(ignored).toContain('minCaptureIntervalMs：单实例最小截图间隔必须是 200 到 5000 毫秒的整数');
    expect(ignored.some((line) => line.startsWith('maxConcurrentInstances：') && line.includes('手动确认'))).toBe(true);
    expect(ignored.some((line) => line.startsWith('adbPath：'))).toBe(true);
    expect(mergeAppSettings(defaultAppSettings(), patch)).toMatchObject(patch);
    expect(legacyAppSettingsPatch('x')).toEqual({ patch: {}, ignored: ['旧版设置文件不是 JSON 对象'] });
  });

  it('decides which screenshots are kept by the shot policy', () => {
    expect(keepShot('never', 'failure')).toBe(false);
    expect(keepShot('never', 'requested')).toBe(false);
    expect(keepShot('onFail', 'failure')).toBe(true);
    expect(keepShot('onFail', 'requested')).toBe(true);
    expect(keepShot('onFail', 'process')).toBe(false);
    expect(keepShot('always', 'process')).toBe(true);
  });
});

describe('AppSettingsStore (app-settings.json)', () => {
  it('writes the defaults on first start, private and versioned', async () => {
    const store = new AppSettingsStore(home);
    expect(store.get()).toEqual(defaultAppSettings()); // Usable before the file was read.
    await store.ready;
    expect(await onDisk()).toEqual({ version: 1, ...defaultAppSettings() });
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(store.view()).toEqual({ settings: defaultAppSettings(), file, warning: null });
  });

  it('fills missing fields of a hand-edited file and keeps a valid file untouched', async () => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ shotPolicy: 'never' }));
    const store = new AppSettingsStore(home);
    await store.ready;
    expect(store.get().shotPolicy).toBe('never');
    expect(await onDisk()).toEqual({ version: 1, ...defaultAppSettings(), shotPolicy: 'never' });
    const before = (await stat(file)).mtimeMs;
    const again = new AppSettingsStore(home);
    await again.ready;
    expect((await stat(file)).mtimeMs).toBe(before);
    expect(again.view().warning).toBeNull();
  });

  it('never blocks startup on a broken file: it is backed up and the defaults are used', async () => {
    await mkdir(path.dirname(file), { recursive: true });
    for (const [content, reason] of [
      ['{broken', '设置文件不是有效的 JSON'],
      [JSON.stringify({ version: 1, shrink: 0 }), '匹配降采样倍率必须是 1 到 4 的整数'],
      [JSON.stringify({ version: 9, shotPolicy: 'never' }), '设置文件版本 9 与当前助手不兼容'],
    ] as const) {
      await writeFile(file, content);
      const log = vi.fn();
      const store = new AppSettingsStore(home, { log, now: () => Date.parse('2026-09-24T01:02:03.004Z') });
      await store.ready;
      expect(store.get()).toEqual(defaultAppSettings());
      expect(store.view().warning).toContain(reason);
      expect(store.view().warning).toContain('已恢复默认设置');
      expect(log).toHaveBeenCalledWith(expect.stringContaining(reason));
      const backups = (await readdir(path.dirname(file))).filter((name) => name.startsWith('app-settings.json.bad-'));
      expect(backups).toEqual(['app-settings.json.bad-2026-09-24T01-02-03-004Z']);
      expect(await readFile(path.join(path.dirname(file), backups[0]!), 'utf8')).toBe(content);
      expect(await onDisk()).toEqual({ version: 1, ...defaultAppSettings() });
      await rm(path.join(path.dirname(file), backups[0]!));
    }
  });

  it('serializes concurrent saves in order and notifies once per save', async () => {
    const onChange = vi.fn();
    const store = new AppSettingsStore(home, { onChange });
    const listener = vi.fn();
    const unsubscribe = store.onChange(listener);
    const [first, second] = await Promise.all([store.save({ matchThreshold: 0.9 }), store.save({ shotPolicy: 'always' })]);
    expect(first.settings).toMatchObject({ matchThreshold: 0.9, shotPolicy: 'onFail' });
    expect(second.settings).toMatchObject({ matchThreshold: 0.9, shotPolicy: 'always' });
    expect(await onDisk()).toMatchObject({ matchThreshold: 0.9, shotPolicy: 'always' });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange.mock.calls[1]![0]).toMatchObject({ settings: { shotPolicy: 'always' }, warning: null });
    unsubscribe();
    await store.save({ shrink: 3 });
    expect(listener).toHaveBeenCalledTimes(2);
    // Reloading reads what was saved.
    const reloaded = new AppSettingsStore(home);
    await reloaded.ready;
    expect(reloaded.get()).toEqual({ ...defaultAppSettings(), matchThreshold: 0.9, shotPolicy: 'always', shrink: 3 } satisfies AppSettings);
  });

  it('changes nothing when a value is invalid or the write fails, and a throwing listener does not fail a save', async () => {
    const store = new AppSettingsStore(home, { log: () => undefined });
    await store.ready;
    await expect(store.save({ minCaptureIntervalMs: 50 })).rejects.toThrow('单实例最小截图间隔');
    await expect(store.save({ nonsense: true })).rejects.toThrow('未知的应用设置');
    expect(store.get()).toEqual(defaultAppSettings());
    store.onChange(() => { throw new Error('坏监听'); });
    await expect(store.save({ shotPolicy: 'never' })).resolves.toMatchObject({ settings: { shotPolicy: 'never' } });
    // A directory where the file should be makes the atomic rename fail.
    await rm(file);
    await mkdir(file);
    await expect(store.save({ shotPolicy: 'always' })).rejects.toThrow(`应用设置写入失败：${file}`);
    expect(store.get().shotPolicy).toBe('never');
    // The failed save does not poison the chain.
    await rm(file, { recursive: true });
    await expect(store.save({ shotPolicy: 'always' })).resolves.toMatchObject({ settings: { shotPolicy: 'always' } });
  });

  it('requires an absolute data root', () => {
    expect(() => new AppSettingsStore('relative/home')).toThrow('应用设置数据目录必须是绝对路径');
  });
});
