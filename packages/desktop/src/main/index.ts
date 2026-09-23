import { watchBuild } from './build-watch';
import { defaultHome } from '@avdm/core';
import { writeFile } from 'node:fs/promises';
import { app, dialog, session, type BrowserWindow, type MessageBoxOptions } from 'electron';
import { registerIpcHandlers } from './ipc-handlers';
import { AutomationHost } from './automation/host';
import { LiveService } from './live';
import { ManagerHost } from './manager-host';
import { installAppMenu } from './menu';
import { configureProto } from './proto';
import { SdkInstallTask } from './sdk-install';
import { ThumbnailService } from './thumbnails';
import { withTimeout } from './util';
import { WindowManager } from './windows';

/** Upper bound for waiting on a cancelled SDK install (curl/unzip killed, directory moves finished). */
const SDK_ABORT_WAIT_MS = 30_000;

const APP_NAME = 'AVD 多开管理器';
const isDev = !app.isPackaged && !!process.env['ELECTRON_RENDERER_URL'];

app.setName(APP_NAME);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  bootstrap();
}

function bootstrap(): void {
  configureProto(isDev);

  const host = new ManagerHost();
  const live = new LiveService(host);
  const thumbs = new ThumbnailService(host);
  const windows = new WindowManager(host, live);
  const sdkInstall = new SdkInstallTask();
  const automation = new AutomationHost(host, defaultHome());
  registerIpcHandlers({ host, live, thumbs, windows, sdkInstall, automation });

  app.on('second-instance', () => {
    if (app.isReady()) windows.showMain();
  });

  void app.whenReady().then(() => {
    // The UI needs no web permissions (camera, notifications, …).
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    installAppMenu(host);
    const win = windows.showMain();
    scheduleVerificationScreenshot(win, windows);
    void automation.restoreSchedules().catch((error: unknown) =>
      console.error('[avdm] 自动化调度恢复失败:', error));
    // Open the manager eagerly so the health monitor runs even before the UI asks for data.
    host.get().catch((err: unknown) => console.error('[avdm]', err));
    watchBuild();
  });

  app.on('activate', () => {
    if (app.isReady()) windows.showMain();
  });

  // Emulators are detached and keep running; on macOS the app stays alive until Cmd-Q.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  let quitState: 'idle' | 'confirming' | 'disposing' | 'done' = 'idle';
  const shutdown = async () => {
    // A running SDK install is aborted and awaited: curl/unzip get killed (they would otherwise outlive the
    // app and keep writing the .part file) and the installer finishes or rolls back its directory moves.
    await withTimeout(sdkInstall.abortAndWait(), SDK_ABORT_WAIT_MS, undefined);
    // Cancellation gives the worker up to 5 s to finish, then waits for any
    // ADB command already in flight before releasing the instance lease.
    await withTimeout(automation.dispose(), 15_000, undefined);
    thumbs.dispose();
    live.dispose();
    await withTimeout(host.dispose(), 5000, undefined);
    quitState = 'done';
    // Cleanup is done: exit rather than re-run quit. After a quit that came from a signal (SIGTERM, or Ctrl-C
    // on `pnpm start:desktop`) was cancelled by preventDefault above, a second app.quit() only closed the
    // windows and the process stayed alive (verified with Electron 44 on macOS); app.exit() works for both.
    app.exit(0);
  };
  app.on('before-quit', (event) => {
    if (quitState === 'done') return;
    event.preventDefault();
    if (quitState !== 'idle') return;
    if (!sdkInstall.active) {
      quitState = 'disposing';
      void shutdown();
      return;
    }
    quitState = 'confirming';
    void confirmQuitDuringInstall(windows.main).then(
      (quit) => {
        if (!quit) {
          quitState = 'idle';
          return;
        }
        quitState = 'disposing';
        void shutdown();
      },
      () => {
        quitState = 'idle';
      },
    );
  });
}

/** Ask before quitting while an SDK install runs (quitting cancels it). */
async function confirmQuitDuringInstall(parent: BrowserWindow | undefined): Promise<boolean> {
  const options: MessageBoxOptions = {
    type: 'warning',
    message: 'SDK 组件正在安装',
    detail: '退出将取消安装。已下载的部分会保留，下次安装时会继续下载。',
    buttons: ['取消安装并退出', '继续安装'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  };
  const result =
    parent && !parent.isDestroyed() ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
  return result.response === 0;
}

/**
 * Verification hook for the integration step / docs screenshots. With AVDM_SCREENSHOT_PATH set, capture a
 * window after it finished loading (AVDM_SCREENSHOT_DELAY_MS, default 3000), write a PNG there and quit.
 * With AVDM_OPEN_LIVE=<index> as well, the live window of that instance is opened and captured instead.
 * AVDM_SCREENSHOT_ROUTE=automation captures the automation page in the main window.
 */
function scheduleVerificationScreenshot(win: BrowserWindow, windows: WindowManager): void {
  const target = process.env['AVDM_SCREENSHOT_PATH'];
  if (!target) return;
  const delayMs = Math.max(0, Number(process.env['AVDM_SCREENSHOT_DELAY_MS']) || 3000);
  const liveRaw = process.env['AVDM_OPEN_LIVE'];
  const route = process.env['AVDM_SCREENSHOT_ROUTE'];
  const liveIndex = liveRaw !== undefined && /^\d+$/.test(liveRaw.trim()) ? Number(liveRaw) : undefined;
  win.webContents.once('did-finish-load', () => {
    void (async () => {
      try {
        let subject: BrowserWindow | undefined = win;
        if (route === 'automation') {
          await win.webContents.executeJavaScript("window.location.hash = '#/automation'", true);
        }
        if (liveIndex !== undefined) {
          await windows.openLive(liveIndex);
          subject = windows.liveWindow(liveIndex);
        }
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        if (!subject || subject.isDestroyed()) throw new Error('要截图的窗口已关闭');
        const image = await subject.webContents.capturePage();
        await writeFile(target, image.toPNG());
        console.log(`[avdm] 截图已保存：${target}`);
        app.quit();
      } catch (err) {
        console.error('[avdm] 截图失败:', err);
        app.exit(1);
      }
    })();
  });
}
