import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => import('../../../packages/emulator-shell/test/helpers/electron-mock'));

import { handlers } from '../../../packages/emulator-shell/test/helpers/electron-mock';
import { AppLog } from '../src/main/app/app-log';
import { DeviceTools } from '../src/main/app/device-tools';
import {
  APP_PATH_KEYS, configuredSettingsIndices, copyText, listAppPaths, listInstanceTemplateSets, openAppPath, resolveAppPath, type PathOpener,
} from '../src/main/app/paths';
import { AppSettingsStore } from '../src/main/app/settings-store';
import { announceHealth, announceServiceFailures } from '../src/main/app/startup';
import { AppToasts, TOAST_REPLAY_MS } from '../src/main/app/toasts';
import { registerWanlongIpcHandlers, type WanlongServices } from '../src/main/ipc-handlers';
import { wanlongInvokeChannel } from '../src/shared/ipc';

const here = dirname(fileURLToPath(import.meta.url));
const appUrl = `${pathToFileURL(join(here, '..', '..', '..', 'packages', 'emulator-shell', 'src', 'renderer', 'index.html')).href}#/`;
type Invoke = (event: unknown, ...args: unknown[]) => Promise<unknown>;

let home: string;
let settings: AppSettingsStore;
let log: AppLog;
const occupancy = { holders: vi.fn(async (index: number) => [{ index, label: '运行采集', source: 'gather', blocking: true }]) };
const appHealth = { last: vi.fn(() => null), check: vi.fn(async () => ({ ok: true, checkedAt: 1, durationMs: 1, items: [] })) };
const clipboard = { writeText: vi.fn() };
const deviceTools = { installApk: vi.fn(async (index: number, paths: string[]) => `Success ${index} ${paths.length}`) };
const appTemplateSets = vi.fn(async (gameId: string) => [{ index: 0, instanceName: gameId, path: '/sets/a', exists: true, name: 'A', templates: 3 }]);

function invoke(method: string, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(wanlongInvokeChannel(method as never)) as Invoke | undefined;
  if (!handler) throw new Error(`未注册 ${method}`);
  return handler({ sender: { id: 1 }, senderFrame: { url: appUrl } }, ...args);
}

beforeAll(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'avdm-app-ipc-'));
  settings = new AppSettingsStore(home);
  log = new AppLog(home, { console: { log: () => undefined, warn: () => undefined, error: () => undefined } });
  const toasts = new AppToasts();
  toasts.push({ level: 'warn', title: '脚本计划没能启动', view: 'settings' });
  registerWanlongIpcHandlers({
    serviceHealth: { list: () => [] },
    appSettings: settings,
    appLog: log,
    appHealth,
    appToasts: toasts,
    occupancy,
    appHome: home,
    deviceTools,
    appTemplateSets,
    appClipboard: clipboard,
    windows: { kindOf: () => 'main' },
  } as unknown as WanlongServices);
});
afterAll(async () => { await rm(home, { recursive: true, force: true }); });

describe('app IPC domain', () => {
  it('reads and saves app settings, validating the patch', async () => {
    await expect(invoke('appSettings')).resolves.toMatchObject({ ok: true, value: { settings: { shotPolicy: 'onFail' }, warning: null } });
    await expect(invoke('saveAppSettings', { shotPolicy: 'always' })).resolves.toMatchObject({ ok: true, value: { settings: { shotPolicy: 'always' } } });
    await expect(invoke('saveAppSettings', ['x'])).resolves.toEqual({ ok: false, error: { message: '应用设置无效' } });
    await expect(invoke('saveAppSettings', { shrink: 12 })).resolves.toEqual({ ok: false, error: { message: '匹配降采样倍率必须是 1 到 4 的整数' } });
  });

  it('queries the app log with checked filters', async () => {
    log.warn('gather', '搜索页卡住', undefined, 1);
    log.error('update', '检查失败');
    await expect(invoke('appLogs', { minLevel: 'error' })).resolves.toMatchObject({ ok: true, value: [{ message: '检查失败' }] });
    await expect(invoke('appLogs')).resolves.toMatchObject({ ok: true, value: [{ message: '搜索页卡住' }, { message: '检查失败' }] });
    await expect(invoke('appLogs', { minLevel: 'loud' })).resolves.toEqual({ ok: false, error: { message: '日志级别无效' } });
    await expect(invoke('appLogs', { limit: 99999 })).resolves.toEqual({ ok: false, error: { message: '日志条数无效' } });
    await expect(invoke('appLogs', 'all')).resolves.toEqual({ ok: false, error: { message: '日志查询条件无效' } });
  });

  it('lists data paths under AVDM_HOME and only opens whitelisted keys', async () => {
    const listed = await invoke('appPaths', 'wanlong') as { ok: true; value: { key: string; path: string }[] };
    expect(listed.value.map((entry) => entry.key)).toEqual([...APP_PATH_KEYS]);
    for (const entry of listed.value) expect(entry.path.startsWith(home)).toBe(true);
    await expect(invoke('openAppPath', 'wanlong', '../../etc')).resolves.toEqual({ ok: false, error: { message: '数据目录无效' } });
    await expect(invoke('openAppPath', 'no-such-game', 'logs')).resolves.toMatchObject({ ok: false });
    await expect(invoke('openAppPath', 'wanlong', 'logs')).resolves.toEqual({ ok: true, value: undefined });
  });

  it('returns the health report, recent toasts and instance occupancy', async () => {
    await expect(invoke('appHealth')).resolves.toEqual({ ok: true, value: null });
    await expect(invoke('runAppHealthCheck')).resolves.toMatchObject({ ok: true, value: { ok: true } });
    await expect(invoke('appRecentToasts')).resolves.toMatchObject({ ok: true, value: [{ id: 1, title: '脚本计划没能启动', view: 'settings' }] });
    await expect(invoke('instanceOccupancy', 4)).resolves.toMatchObject({ ok: true, value: [{ index: 4, label: '运行采集' }] });
    await expect(invoke('instanceOccupancy', -1)).resolves.toMatchObject({ ok: false });
  });

  it('lists template sets, copies text through main and installs APKs with checked arguments', async () => {
    await expect(invoke('appTemplateSets', 'wanlong')).resolves.toMatchObject({ ok: true, value: [{ index: 0, path: '/sets/a' }] });
    await expect(invoke('appTemplateSets', 'no-such-game')).resolves.toMatchObject({ ok: false });
    await expect(invoke('appCopyText', '/Users/me/.avdm')).resolves.toEqual({ ok: true, value: undefined });
    expect(clipboard.writeText).toHaveBeenCalledWith('/Users/me/.avdm');
    await expect(invoke('appCopyText', '')).resolves.toEqual({ ok: false, error: { message: '复制内容无效' } });
    await expect(invoke('appCopyText', 'x'.repeat(5000))).resolves.toEqual({ ok: false, error: { message: '复制内容无效' } });
    await expect(invoke('appInstallApk', 2, ['/a.apk'])).resolves.toEqual({ ok: true, value: 'Success 2 1' });
    await expect(invoke('appInstallApk', 2, '/a.apk')).resolves.toEqual({ ok: false, error: { message: 'APK 文件列表无效' } });
    await expect(invoke('appInstallApk', 99, ['/a.apk'])).resolves.toMatchObject({ ok: false });
    expect(deviceTools.installApk).toHaveBeenCalledTimes(1);
  });
});

describe('device tools (设备工具)', () => {
  it('installs existing package files on a running instance only, through the given (lane) host', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'avdm-app-apk-'));
    try {
      const apk = path.join(root, 'ADBKeyboard.apk');
      await writeFile(apk, 'pk');
      const install = vi.fn(async (files: string[]) => `Success ${files.length}`);
      let status = 'running';
      const tools = new DeviceTools({ get: async () => ({ getState: async () => ({ status }), device: async () => ({ install }) }) });
      await expect(tools.installApk(1, [apk])).resolves.toBe('Success 1');
      expect(install).toHaveBeenCalledWith([apk]);
      await expect(tools.installApk(1, [])).rejects.toThrow('请先选择要安装的 APK 文件');
      await expect(tools.installApk(1, ['relative.apk'])).rejects.toThrow('不是可安装的 APK 文件');
      await expect(tools.installApk(1, [path.join(root, 'notes.txt')])).rejects.toThrow('不是可安装的 APK 文件');
      await expect(tools.installApk(1, [path.join(root, 'missing.apk')])).rejects.toThrow('找不到安装包文件');
      status = 'stopped';
      await expect(tools.installApk(1, [apk])).rejects.toThrow('实例 #1 尚未就绪');
      expect(install).toHaveBeenCalledTimes(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('instance template sets and clipboard', () => {
  it('lists each instance\'s set, keeps a deleted instance\'s settings and reports unreadable ones per entry', async () => {
    const entries = await listInstanceTemplateSets({
      instances: async () => [{ index: 0, name: '主号' }, { index: 1, name: '小号' }, { index: 2, name: '空' }],
      configuredIndices: async () => [0, 5],
      templateDir: async (index) => {
        if (index === 1) throw new Error('自动化配置格式不兼容');
        return index === 2 ? '' : `/sets/${index}`;
      },
      describe: async (index) => {
        if (index === 5) throw new Error('模板清单损坏');
        return { name: `集${index}`, templates: 10 + index };
      },
    });
    expect(entries).toEqual([
      { index: 0, instanceName: '主号', path: '/sets/0', exists: false, name: '集0', templates: 10 },
      { index: 1, instanceName: '小号', path: '', exists: false, name: null, templates: null, error: '自动化配置格式不兼容' },
      { index: 5, instanceName: null, path: '/sets/5', exists: false, name: null, templates: null, error: '模板清单损坏' },
    ]);
  });

  it('finds settings files of deleted instances and validates clipboard text', async () => {
    await mkdir(path.join(home, 'automation', 'wanlong'), { recursive: true });
    await writeFile(path.join(home, 'automation', 'wanlong', '3.json'), '{}');
    await writeFile(path.join(home, 'automation', 'wanlong', 'notes.json'), '{}');
    expect(await configuredSettingsIndices(home, 'wanlong')).toEqual([3]);
    expect(await configuredSettingsIndices(home, 'missing')).toEqual([]);
    const writer = { writeText: vi.fn() };
    await copyText('路径', writer);
    expect(writer.writeText).toHaveBeenCalledWith('路径');
    await expect(copyText('a\0b', writer)).rejects.toThrow('复制内容无效');
    await expect(copyText(42, writer)).rejects.toThrow('复制内容无效');
  });
});

describe('data paths', () => {
  it('resolves every key under the data root, per game', () => {
    expect(resolveAppPath('/h', 'wanlong', 'templates')).toEqual({ path: path.join('/h', 'automation', 'templates', 'wanlong'), kind: 'dir' });
    expect(resolveAppPath('/h', 'wanlong', 'plans')).toEqual({ path: path.join('/h', 'automation', 'games', 'wanlong', 'plans.json'), kind: 'file' });
    expect(resolveAppPath('/h', 'wanlong', 'leases')).toEqual({ path: path.join('/h', 'run'), kind: 'dir' });
    expect(() => resolveAppPath('/h', '../x', 'logs')).toThrow('游戏 ID无效');
  });

  it('creates and opens a directory, reveals an existing file and opens the folder of a missing one', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'avdm-app-paths-'));
    try {
      const opener: PathOpener & { opened: string[]; revealed: string[] } = {
        opened: [], revealed: [],
        async openPath(target) { this.opened.push(target); return ''; },
        showItemInFolder(target) { this.revealed.push(target); },
      };
      await openAppPath(root, 'wanlong', 'monitoringShots', opener);
      const shots = path.join(root, 'automation', 'monitoring', 'shots');
      expect((await stat(shots)).isDirectory()).toBe(true);
      expect(opener.opened).toEqual([shots]);
      await openAppPath(root, 'wanlong', 'accounts', opener);
      expect(opener.opened.at(-1)).toBe(path.join(root, 'automation'));
      await writeFile(path.join(root, 'automation', 'accounts.json'), '{}');
      await openAppPath(root, 'wanlong', 'accounts', opener);
      expect(opener.revealed).toEqual([path.join(root, 'automation', 'accounts.json')]);
      const failing: PathOpener = { openPath: async () => '没有权限', showItemInFolder: () => undefined };
      await expect(openAppPath(root, 'wanlong', 'logs', failing)).rejects.toThrow(`无法打开目录 ${path.join(root, 'automation', 'logs')}：没有权限`);
      const entries = await listAppPaths(root, 'wanlong');
      expect(entries.find((entry) => entry.key === 'accounts')!.exists).toBe(true);
      // Nothing writes gather scene shots yet: the entry says so instead of looking broken.
      expect(entries.find((entry) => entry.key === 'gatherShots')!.pending).toContain('尚未接入');
      expect(entries.filter((entry) => entry.pending).map((entry) => entry.key)).toEqual(['gatherShots']);
      expect(entries.find((entry) => entry.key === 'scripts')!.exists).toBe(false);
      await mkdir(path.join(root, 'automation', 'games', 'wanlong', 'scripts'), { recursive: true });
      expect((await listAppPaths(root, 'wanlong')).find((entry) => entry.key === 'scripts')!.exists).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('main → renderer toasts', () => {
  it('pushes each toast with an increasing id and replays recent ones to a late window', () => {
    let now = 1_000;
    const emit = vi.fn();
    const toasts = new AppToasts(emit, () => now);
    const first = toasts.push({ level: 'warn', title: '运行监控没能启动', detail: '坏文件' });
    const second = toasts.push({ level: 'info', title: '提示', detail: '', view: '' });
    expect([first.id, second.id]).toEqual([1, 2]);
    expect(second).toEqual({ id: 2, level: 'info', title: '提示', at: 1_000 });
    expect(emit).toHaveBeenCalledTimes(2);
    expect(toasts.recent().map((toast) => toast.id)).toEqual([1, 2]);
    now += TOAST_REPLAY_MS + 1;
    expect(toasts.recent()).toEqual([]);
    const throwing = new AppToasts(() => { throw new Error('窗口已关闭'); });
    expect(() => throwing.push({ level: 'error', title: 'x' })).not.toThrow();
  });
});

describe('startup announcements (app-toast)', () => {
  it('toasts each failed service once and the self-check only when it found problems', () => {
    const toasts = new AppToasts(() => undefined, () => 5);
    announceServiceFailures([{ name: '脚本计划', message: '计划文件损坏。', impact: '定时脚本不会自动运行', at: 1 }], toasts);
    announceHealth({ ok: true, checkedAt: 1, durationMs: 1, items: [] }, toasts);
    announceHealth({
      ok: false, checkedAt: 1, durationMs: 1,
      items: [{ key: 'sharp', label: '图像处理（sharp / libvips）', level: 'fail', ok: false, detail: 'x', group: 'assistant' }],
    }, toasts);
    expect(toasts.recent()).toEqual([
      { id: 1, level: 'warn', title: '脚本计划没能启动', detail: '计划文件损坏。定时脚本不会自动运行，其余功能不受影响；排除问题后重启助手即可重试。', view: 'settings', at: 5 },
      { id: 2, level: 'warn', title: '环境自检发现 1 个问题：图像处理（sharp / libvips）', detail: '请到「设置」页的「环境自检」查看修复建议。', view: 'settings', at: 5 },
    ]);
  });
});
