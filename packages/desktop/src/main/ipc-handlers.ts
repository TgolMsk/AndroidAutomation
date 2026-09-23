import { constants as fsConstants } from 'node:fs';
import { access, mkdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import {
  BrowserWindow,
  app,
  dialog,
  ipcMain,
  shell,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
  type WebContents,
} from 'electron';
import { defaultHome, loadSettings, type AvdManager, type InstallProgress, type RemotePackage, type Settings } from '@avdm/core';
import {
  INVOKE_METHODS,
  LIVE_WINDOW_METHODS,
  invokeChannel,
  type AvdmApi,
  type AvdmInvokeMethod,
  type BatchResult,
} from '../shared/ipc';
import type { AutomationHost } from './automation/host';
import type { LiveService } from './live';
import type { ManagerHost } from './manager-host';
import { refreshAlwaysOnTopMenu } from './menu';
import type { SdkInstallTask } from './sdk-install';
import type { ThumbnailService } from './thumbnails';
import { asIndex, asIndices, asOptionalStringRecord, asStrings, errorCode, errorMessage, fileStamp, safeFileName } from './util';
import { isAppUrl, type WindowKind, type WindowManager } from './windows';

export interface MainServices {
  host: ManagerHost;
  live: LiveService;
  thumbs: ThumbnailService;
  windows: WindowManager;
  sdkInstall: SdkInstallTask;
  automation?: AutomationHost;
}

interface HandlerContext extends MainServices {
  sender: WebContents;
}

/** Every AvdmApi invoke method implemented against the manager; the mapped type keeps it in sync with ipc.ts. */
type Handler<K extends AvdmInvokeMethod> = (
  ctx: HandlerContext,
  ...args: Parameters<AvdmApi[K]>
) => Promise<Awaited<ReturnType<AvdmApi[K]>>>;
type HandlerMap = { [K in AvdmInvokeMethod]: Handler<K> };

function automationOrThrow(service: AutomationHost | undefined): AutomationHost {
  if (!service) throw new Error('自动化服务尚未就绪');
  return service;
}

/** Result envelope returned by every handler; the preload unwraps it and rethrows Error(message). */
export type IpcEnvelope = { ok: true; value: unknown } | { ok: false; error: { message: string; code?: string } };

/** Concurrency for batch operations (emulator boot is CPU heavy; adb calls are cheap). */
const CONCURRENCY = { start: 3, restart: 3, stop: 8, remove: 4, install: 3, shell: 8, app: 8 } as const;

async function toBatch<T>(
  manager: AvdManager,
  indices: number[],
  fn: (index: number) => Promise<T>,
  concurrency: number,
): Promise<BatchResult<T>[]> {
  const results = await manager.batch(indices, fn, { concurrency });
  return results.map((r) =>
    r.ok ? { index: r.index, ok: true as const, value: r.value } : { index: r.index, ok: false as const, error: errorMessage(r.error) },
  );
}

/**
 * Decide whether a renderer may call `method`. Fail closed: the calling frame must be one of our pages
 * (a null senderFrame is rejected too) in one of our windows; live-view windows only get the few methods
 * they need, so settings / SDK install / create / remove / scripts are reachable from the main window only.
 */
export function authorizeInvoke(method: AvdmInvokeMethod, frameUrl: string | undefined, kind: WindowKind | undefined): void {
  if (!frameUrl || !isAppUrl(frameUrl)) throw new Error('拒绝来自未知页面的请求');
  if (!kind) throw new Error('拒绝来自未知窗口的请求');
  if (kind === 'live' && !LIVE_WINDOW_METHODS.has(method)) throw new Error('实时画面窗口无权执行此操作');
}

const SCRCPY_NAME_RE = process.platform === 'win32' ? /^scrcpy\.exe$/i : /^scrcpy$/;

/**
 * The scrcpy path from the settings dialog is executed by openScrcpy(), so only accept an existing
 * executable file that is actually called scrcpy ('' = look it up in PATH).
 */
export async function assertScrcpyPath(value: unknown): Promise<void> {
  if (typeof value !== 'string') throw new Error('scrcpy 路径无效');
  const raw = value.trim();
  if (!raw) return;
  const expanded = raw === '~' || raw.startsWith('~/') ? join(homedir(), raw.slice(1)) : raw;
  const file = resolve(expanded);
  if (!SCRCPY_NAME_RE.test(basename(file))) {
    throw new Error(`scrcpy 路径必须指向名为 scrcpy 的可执行文件：${file}`);
  }
  try {
    const st = await stat(file);
    if (!st.isFile()) throw new Error('not a file');
    await access(file, fsConstants.X_OK);
  } catch {
    throw new Error(`scrcpy 路径不存在或不可执行：${file}`);
  }
}

function isStableArm64Image(pkg: RemotePackage): boolean {
  return pkg.path.startsWith('system-images;') && (pkg.abi ?? pkg.path.split(';')[3]) === 'arm64-v8a' && (pkg.channel || 'channel-0') === 'channel-0';
}

function apiNumber(pkg: RemotePackage): number {
  const n = parseFloat(pkg.apiLevel ?? pkg.path.split(';')[1]?.replace(/^android-/, '') ?? '0');
  return Number.isFinite(n) ? n : 0;
}

const handlers: HandlerMap = {
  // ── state / settings / host ──
  async listInstances({ host }) {
    const states = await (await host.get()).list();
    host.noteStates(states);
    return states;
  },
  async hostStats({ host }) {
    return (await host.get()).hostStats();
  },
  async getSettings({ host }) {
    const manager = await host.get();
    // settings.json itself: the manager re-reads it only on its health-check cadence, and the settings dialog
    // must start from what is on disk (e.g. right after `avdm settings set`).
    try {
      return await loadSettings(manager.paths);
    } catch {
      return manager.getSettings();
    }
  },
  async updateSettings({ host }, patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('参数错误：设置内容无效');
    if ('scrcpyPath' in patch) await assertScrcpyPath(patch.scrcpyPath);
    // A partial defaultSpec is merged field by field by core's saveSettings.
    return (await host.get()).updateSettings(patch as Partial<Settings>);
  },
  async relaunchApp() {
    // before-quit runs the normal shutdown (streams, SDK install, manager dispose); emulators are detached and stay up.
    app.relaunch();
    app.quit();
  },
  async appInfo({ host }) {
    return {
      version: app.getVersion(),
      home: host.manager?.paths.home ?? defaultHome(),
      platform: process.platform,
      arch: process.arch,
    };
  },

  // ── SDK ──
  async getSdk({ host }) {
    return (await host.get()).getSdk();
  },
  async refreshSdk({ host }) {
    return (await host.get()).refreshSdk();
  },
  async listRemoteImages({ host }) {
    const catalog = await (await host.get()).fetchCatalog();
    return catalog.packages.filter(isStableArm64Image).sort((a, b) => apiNumber(b) - apiNumber(a) || a.path.localeCompare(b.path));
  },
  async planSdkInstall({ host }, pkgPaths) {
    return (await host.get()).planSdkInstall(asStrings(pkgPaths, '组件列表'));
  },
  async acceptLicenses({ host }, licenseIds, shownTexts) {
    // Only reachable from the main window's wizard, with the ids whose "我已阅读并同意许可 <id>" box was ticked.
    await (await host.get()).acceptLicenses(asStrings(licenseIds, '许可列表'), asOptionalStringRecord(shownTexts, '许可全文'));
  },
  async installSdk({ host, sdkInstall }, pkgPaths) {
    const paths = asStrings(pkgPaths, '组件列表');
    const manager = await host.get();
    // Same package set as the running install → join it (a reloaded/reopened wizard); otherwise rejected.
    await sdkInstall.run(
      paths,
      () => manager.planSdkInstall(paths),
      async (signal) => {
        const onProgress = (p: InstallProgress) => sdkInstall.noteProgress(p);
        manager.on('sdk-progress', onProgress);
        try {
          await manager.installSdkPackages(paths, { signal });
        } finally {
          manager.off('sdk-progress', onProgress);
        }
      },
    );
  },
  async cancelSdkInstall({ sdkInstall }) {
    sdkInstall.cancel();
  },
  async sdkInstallStatus({ sdkInstall }) {
    return sdkInstall.status();
  },

  // ── lifecycle ──
  async create({ host }, opts) {
    return (await host.get()).create(opts);
  },
  async clone({ host }, sourceIndex, opts) {
    return (await host.get()).clone(asIndex(sourceIndex), opts);
  },
  async update({ host, windows }, index, opts) {
    const record = await (await host.get()).update(asIndex(index), opts);
    if (opts?.name !== undefined) windows.retitleLive(record.index, record.name);
    return record;
  },
  async remove({ host }, indices, force) {
    const manager = await host.get();
    return toBatch(manager, asIndices(indices), (i) => manager.remove(i, { force: !!force }), CONCURRENCY.remove);
  },
  async start({ host }, indices, opts) {
    const manager = await host.get();
    return toBatch(manager, asIndices(indices), async (i) => void (await manager.start(i, opts)), CONCURRENCY.start);
  },
  async stop({ host }, indices, opts) {
    const manager = await host.get();
    return toBatch(manager, asIndices(indices), (i) => manager.stop(i, opts), CONCURRENCY.stop);
  },
  async restart({ host }, indices) {
    const manager = await host.get();
    return toBatch(manager, asIndices(indices), async (i) => void (await manager.restart(i)), CONCURRENCY.restart);
  },

  // ── device ops ──
  async pickApks({ sender }) {
    const options: OpenDialogOptions = {
      title: '选择要安装的 APK',
      buttonLabel: '选择',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Android 安装包', extensions: ['apk', 'apks', 'xapk'] }],
    };
    const win = BrowserWindow.fromWebContents(sender);
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    return result.canceled ? [] : result.filePaths;
  },
  async installApk({ host }, indices, apkPaths) {
    const manager = await host.get();
    const paths = asStrings(apkPaths, 'APK 列表');
    if (paths.length === 0) throw new Error('未选择 APK 文件');
    return toBatch(manager, asIndices(indices), (i) => manager.installApk(i, paths), CONCURRENCY.install);
  },
  async shell({ host }, indices, command) {
    if (typeof command !== 'string' || !command.trim()) throw new Error('请输入要执行的命令');
    const manager = await host.get();
    return toBatch(manager, asIndices(indices), async (i) => (await manager.device(i)).shell(command), CONCURRENCY.shell);
  },
  async startApp({ host }, indices, pkg) {
    if (typeof pkg !== 'string' || !pkg.trim()) throw new Error('请输入应用包名');
    const manager = await host.get();
    return toBatch(manager, asIndices(indices), async (i) => (await manager.device(i)).startApp(pkg.trim()), CONCURRENCY.app);
  },
  async stopApp({ host }, indices, pkg) {
    if (typeof pkg !== 'string' || !pkg.trim()) throw new Error('请输入应用包名');
    const manager = await host.get();
    return toBatch(manager, asIndices(indices), async (i) => (await manager.device(i)).stopApp(pkg.trim()), CONCURRENCY.app);
  },
  async listPackages({ host }, index) {
    const device = await (await host.get()).device(asIndex(index));
    // Third-party apps first (what users usually launch), then the rest.
    const [thirdParty, all] = await Promise.all([
      device.listPackages({ thirdPartyOnly: true }).catch(() => [] as string[]),
      device.listPackages(),
    ]);
    const seen = new Set(thirdParty);
    return [...thirdParty, ...all.filter((p) => !seen.has(p))];
  },
  async saveScreenshot({ host }, index) {
    const i = asIndex(index);
    const manager = await host.get();
    const [png, state] = await Promise.all([manager.screenshot(i), manager.getState(i)]);
    const dir = join(app.getPath('pictures'), 'avdm');
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${safeFileName(state.record.name)}-${i}-${fileStamp()}.png`);
    await writeFile(file, png);
    return file;
  },
  async openScrcpy({ host }, index) {
    await (await host.get()).openScrcpy(asIndex(index));
  },
  async openLiveView({ windows }, index) {
    await windows.openLive(asIndex(index));
  },
  async instanceLog({ host }, index, lines) {
    const n = typeof lines === 'number' && lines > 0 ? Math.min(Math.round(lines), 5000) : undefined;
    return (await host.get()).instanceLog(asIndex(index), n);
  },
  async revealPath(_ctx, path) {
    if (typeof path !== 'string' || !path) throw new Error('路径无效');
    shell.showItemInFolder(path);
  },

  // ── thumbnails ──
  async setThumbnailSubscription({ thumbs, sender }, indices, opts) {
    thumbs.subscribe(sender, asIndices(indices), opts ?? {});
  },

  // ── live view ──
  async liveStart({ live, sender }, index, opts) {
    return live.start(asIndex(index), sender, opts?.maxWidth);
  },
  async liveStop({ live, sender }, index) {
    // Only the window that owns the stream may stop it (a stale window must not kill another one's stream).
    live.stop(asIndex(index), sender);
  },
  async liveTouch({ live }, index, touches) {
    if (!Array.isArray(touches)) throw new Error('参数错误：触摸点无效');
    await live.touch(asIndex(index), touches);
  },
  async liveKey({ live }, index, input) {
    if (!input || typeof input !== 'object') throw new Error('参数错误：按键无效');
    await live.key(asIndex(index), input);
  },
  async alwaysOnTop({ sender }, on) {
    const win = BrowserWindow.fromWebContents(sender);
    if (!win || win.isDestroyed()) throw new Error('窗口已关闭');
    if (typeof on === 'boolean') {
      win.setAlwaysOnTop(on, 'floating');
      refreshAlwaysOnTopMenu(win);
    }
    return win.isAlwaysOnTop();
  },

  // ── scripts ──
  async listScripts({ host }) {
    return (await host.get()).listScripts();
  },
  async runScript({ host }, scriptId, indices, args) {
    if (typeof scriptId !== 'string' || !scriptId) throw new Error('请选择脚本');
    return (await host.get()).runScript(scriptId, asIndices(indices), args ? asStrings(args, '脚本参数') : undefined);
  },
  async stopScript({ host }, runId) {
    await (await host.get()).scripts.stop(String(runId));
  },
  async listScriptRuns({ host }) {
    return (await host.get()).scripts.listRuns();
  },
  async createExampleScript({ host }) {
    return (await host.get()).scripts.createExample();
  },
  async openScriptsDir({ host }) {
    const dir = (await host.get()).paths.scriptsDir;
    await mkdir(dir, { recursive: true });
    const err = await shell.openPath(dir);
    if (err) throw new Error(`无法打开脚本目录：${err}`);
  },

  // ── game automation ──
  async automationGames({ automation }) {
    return automationOrThrow(automation).games();
  },
  async pickAutomationTemplateSet({ sender }) {
    const options: OpenDialogOptions = {
      title: '选择游戏模板集目录',
      buttonLabel: '选择模板集',
      properties: ['openDirectory'],
    };
    const win = BrowserWindow.fromWebContents(sender);
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  },
  async getAutomationSettings({ automation }, gameId, index) {
    return automationOrThrow(automation).settings(String(gameId), asIndex(index));
  },
  async saveAutomationSettings({ automation }, gameId, index, patch) {
    return automationOrThrow(automation).saveSettings(String(gameId), asIndex(index), patch);
  },
  async probeAutomation({ automation }, gameId, index) {
    return automationOrThrow(automation).probe(String(gameId), asIndex(index));
  },
  async runAutomation({ automation }, gameId, taskId, index) {
    return automationOrThrow(automation).run(String(gameId), String(taskId), asIndex(index));
  },
  async stopAutomation({ automation }, runId) {
    await automationOrThrow(automation).stop(String(runId));
  },
  async automationRuns({ automation }) {
    return automationOrThrow(automation).runs();
  },
  async automationSchedules({ automation }) {
    return automationOrThrow(automation).schedules();
  },
  async setAutomationSchedule({ automation }, gameId, index, enabled) {
    if (typeof enabled !== 'boolean') throw new Error('自动续跑开关无效');
    return automationOrThrow(automation).setSchedule(String(gameId), asIndex(index), enabled);
  },
};

/** Register `avdm:<method>` for every INVOKE_METHODS entry. */
export function registerIpcHandlers(services: MainServices): void {
  for (const method of INVOKE_METHODS) {
    const handler = handlers[method] as (ctx: HandlerContext, ...args: unknown[]) => Promise<unknown>;
    ipcMain.handle(invokeChannel(method), async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<IpcEnvelope> => {
      try {
        authorizeInvoke(method, event.senderFrame?.url, services.windows.kindOf(event.sender));
        const value = await handler({ ...services, sender: event.sender }, ...args);
        return { ok: true, value };
      } catch (err) {
        const code = errorCode(err);
        return { ok: false, error: code ? { message: errorMessage(err), code } : { message: errorMessage(err) } };
      }
    });
  }
}
