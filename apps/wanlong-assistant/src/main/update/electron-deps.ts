/**
 * `UpdateDeps` backed by Electron. The only update file that imports `electron`; the center, the GitHub port and
 * the busy gate stay importable in plain Node tests.
 */
import { tmpdir } from 'node:os';
import { app, net, shell } from 'electron';
import type { UpdateState } from '../../shared/update';
import type { UpdateDeps, UpdateLogLevel } from './center';
import { GitHubUpdater, isReleasePageUrl, releasePageUrl } from './github';

/** Give Finder a moment to take the DMG before the assistant starts shutting down. */
const QUIT_DELAY_MS = 800;

export interface UpdateHostPorts {
  /** Chinese reason when something is busy (the `BusyGate`), otherwise null. */
  busy(): string | null;
  publish(state: UpdateState): void;
  log(level: UpdateLogLevel, message: string): void;
}

export function electronUpdateDeps(ports: UpdateHostPorts): UpdateDeps {
  // Built on first use only: never at module load or before the app is ready (the original crashed the packaged
  // app at startup by touching its updater too early). Development builds never reach this at all.
  let updater: GitHubUpdater | null = null;
  return {
    currentVersion: () => app.getVersion(),
    packaged: () => app.isPackaged,
    supportedPlatform: () => process.platform === 'darwin' && process.arch === 'arm64',
    busy: () => ports.busy(),
    releasePageUrl: () => releasePageUrl(),
    async openExternal(url) {
      // The renderer never supplies a URL; this only guards against a malformed API answer.
      if (!isReleasePageUrl(url)) throw new Error('只能打开万龙助手的 GitHub 发布页');
      await shell.openExternal(url);
    },
    updater: () => (updater ??= new GitHubUpdater({
      // net.fetch uses Chromium's network stack, so the system proxy applies (GitHub is often unreachable without one).
      fetch: (url, init) => net.fetch(url, init),
      downloadsDir: () => {
        try { return app.getPath('downloads'); }
        catch { return tmpdir(); }
      },
      userAgent: `WanlongAssistant/${app.getVersion()} (${process.platform}; ${process.arch})`,
      openPath: (file) => shell.openPath(file),
      showItemInFolder: (file) => shell.showItemInFolder(file),
    })),
    quit: () => { setTimeout(() => app.quit(), QUIT_DELAY_MS); },
    publish: (state) => ports.publish(state),
    log: (level, message) => ports.log(level, message),
  };
}
