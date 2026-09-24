import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => import('../../../packages/emulator-shell/test/helpers/electron-mock'));

import { handlers } from '../../../packages/emulator-shell/test/helpers/electron-mock';
import { AppLog } from '../src/main/app/app-log';
import { APP_PATH_KEYS, listAppPaths, openAppPath, resolveAppPath, type PathOpener } from '../src/main/app/paths';
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
