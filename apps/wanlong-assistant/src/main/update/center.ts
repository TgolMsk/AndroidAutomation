/**
 * Update center: check GitHub Releases → download and verify the installer → open it and quit.
 * Ported from wanlong-panel `src/main/update/index.ts` (UpdateCenter).
 *
 * This module only orchestrates and imports neither Electron nor the network: the updater sits behind
 * `UpdaterPort` (real implementation in `./github.ts`), so tests drive the whole state machine with a fake.
 *   · when installing is allowed — the `busy()` hook (the assistant's occupancy table plus the SDK install)
 *   · whether updating is supported — development builds and unsupported platforms short-circuit
 *   · where state goes — one `UpdateState`, published after every change
 *
 * ★ Never install on its own: checking may be automatic, downloading and installing always need a click.
 *   This is an unattended tool; quitting by itself in the middle of the night cuts running work.
 */
import type { UnsupportedReason, UpdateProgress, UpdateState } from '../../shared/update';
import { initialUpdateState, isNewer } from '../../shared/update';

export type UpdateErrorCode = 'INVALID_ARGUMENT' | 'CONCURRENCY_LIMIT' | 'UNKNOWN';

/** A refused update action; `code` survives the IPC envelope, so the renderer can branch on it (`errorCodeOf`). */
export class UpdateError extends Error {
  readonly code: UpdateErrorCode;

  constructor(code: UpdateErrorCode, message: string) {
    super(message);
    this.name = 'UpdateError';
    this.code = code;
  }
}

/** Shown when the busy hook itself fails: never let an install cut work because a probe broke. */
export const BUSY_UNKNOWN = '无法确认是否有任务在运行。';

/** What a check found: the newest release that carries an assistant installer. */
export interface UpdateRelease {
  version: string;
  releaseNotes: string | null;
  releaseUrl: string | null;
  prerelease: boolean;
  publishedAt: number | null;
  /** The installer asset (`Wanlong-Assistant-<version>-mac-arm64.dmg`). */
  asset: { name: string; size: number; url: string };
  /** `SHA256SUMS` of the same release; without it the download is refused (nothing to verify against). */
  checksumsUrl: string | null;
}

export interface DownloadOptions {
  signal: AbortSignal;
  onProgress(progress: UpdateProgress): void;
}

/** Narrow updater interface. The real one talks to GitHub (`./github.ts`); tests plug in a fake. */
export interface UpdaterPort {
  /** Look once. Null means "no release with an installer found" (treated as up to date, as in the original). */
  check(): Promise<UpdateRelease | null>;
  /** Download the installer and verify its SHA-256; resolves with the verified file's absolute path. */
  download(release: UpdateRelease, options: DownloadOptions): Promise<string>;
  /** Verify the downloaded installer again right before opening it (it lives in the user's Downloads folder). */
  verify(file: string, release: UpdateRelease): Promise<void>;
  /** Open the installer (mounts the DMG in Finder). */
  open(file: string): Promise<void>;
  /** Show the installer in Finder. */
  reveal(file: string): Promise<void>;
}

export type UpdateLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface UpdateDeps {
  /** Version of the running app (`app.getVersion()`). */
  currentVersion(): string;
  /** Whether this is a packaged build (`app.isPackaged`). Development builds never check. */
  packaged(): boolean;
  /** Whether an installer is published for this OS and CPU (macOS on Apple Silicon). */
  supportedPlatform(): boolean;
  /**
   * A Chinese reason when something is busy, otherwise null. Installing is refused while it returns a reason.
   * May be async (the occupancy table is); `install()` awaits it, state reads show the last answer.
   */
  busy(): string | null | Promise<string | null>;
  /** Release list page, the fallback when a check gave no page. */
  releasePageUrl(): string;
  /** Open a URL in the system browser. */
  openExternal(url: string): Promise<void>;
  /** The updater; built on first use (never at module load, see `./README.md`). */
  updater(): UpdaterPort;
  /** Quit the assistant after the installer was opened; the shell stops every service first. */
  quit(): void;
  /** Push a state change to the renderer. */
  publish(state: UpdateState): void;
  log?(level: UpdateLogLevel, message: string): void;
  now?(): number;
}

interface ActiveDownload {
  controller: AbortController;
  done: Promise<void>;
  /** Why it was aborted when the user (or shutdown) stopped it; a cancel is not reported as a failure. */
  cancelled: boolean;
}

export class UpdateCenter {
  private state: UpdateState;
  private deps: UpdateDeps | null = null;
  private release: UpdateRelease | null = null;
  private active: ActiveDownload | null = null;
  private installing = false;
  /** The installer was opened and the quit is on its way: a second click must not open it again. */
  private quitRequested = false;
  private disposed = false;
  /** Last answer of the busy hook (it may be async, state reads are not); refreshed by `refreshBusy()` and `install()`. */
  private busyReason: string | null = null;

  constructor(currentVersion = '0.0.0') {
    this.state = initialUpdateState(currentVersion);
  }

  init(deps: UpdateDeps): void {
    this.deps = deps;
    this.state = initialUpdateState(deps.currentVersion());
    this.release = null;
    this.busyReason = null;
    const unsupported = this.unsupportedReason();
    if (unsupported) {
      this.patch({ phase: 'unsupported', unsupportedReason: unsupported });
      this.log('info', `当前环境不支持自动更新（${unsupported === 'dev' ? '开发模式' : '没有对应系统的安装包'}）。`);
    }
  }

  /** Whether an automatic check makes sense (initialized and supported). */
  get supported(): boolean {
    return this.deps !== null && this.unsupportedReason() === null;
  }

  getState(): UpdateState {
    return { ...this.state, installable: this.busyReason === null, busyReason: this.busyReason };
  }

  /**
   * Ask the busy hook again and return the state with the fresh answer; publishes when the answer changed.
   * The renderer's state read goes through here, and the service re-asks while an installer waits (see `index.ts`).
   */
  async refreshBusy(): Promise<UpdateState> {
    if (this.deps) await this.readBusy();
    return this.getState();
  }

  /** Check once. Every failure ends in phase 'error' with a Chinese reason; never throws to the caller. */
  async check(): Promise<UpdateState> {
    const deps = this.requireDeps();
    const unsupported = this.unsupportedReason();
    if (unsupported) {
      this.patch({ phase: 'unsupported', unsupportedReason: unsupported });
      return this.getState();
    }
    if (this.state.phase === 'checking' || this.state.phase === 'downloading' || this.disposed) return this.getState();

    this.patch({ phase: 'checking', error: null });
    try {
      const info = await deps.updater().check();
      const now = this.now();
      if (!info) {
        this.release = null;
        // Nothing of an earlier check may linger: the panel would show an old 「发布于」 next to 「已是最新版」, and
        // 「打开 Release 页面」 must fall back to the release list rather than a (possibly deleted) tag page.
        this.patch({
          phase: 'latest', checkedAt: now, latestVersion: null, downloadedFile: null, error: null,
          publishedAt: null, prerelease: false, assetName: null, assetSize: null, releaseNotes: null, releaseUrl: null,
        });
        this.log('info', `没有找到带安装包的发布，按已是最新版 ${this.state.currentVersion} 处理。`);
        return this.getState();
      }
      const newer = isNewer(info.version, this.state.currentVersion);
      this.release = newer ? info : null;
      this.patch({
        phase: newer ? 'available' : 'latest',
        latestVersion: info.version,
        releaseNotes: info.releaseNotes,
        releaseUrl: info.releaseUrl ?? deps.releasePageUrl(),
        prerelease: info.prerelease,
        publishedAt: info.publishedAt,
        assetName: info.asset.name,
        assetSize: info.asset.size,
        downloadedFile: null,
        checkedAt: now,
        error: null,
      });
      this.log('info', newer
        ? `发现新版本 ${info.version}（当前 ${this.state.currentVersion}）。`
        : `已是最新版 ${this.state.currentVersion}。`);
    } catch (error) {
      this.patch({ phase: 'error', error: describe(error), checkedAt: this.now() });
      this.log('warn', `检查更新失败：${describe(error)}`);
    }
    return this.getState();
  }

  /** Download. Only from 'available'; stops at 'downloaded' until the user installs. */
  async download(): Promise<UpdateState> {
    const deps = this.requireDeps();
    if (this.state.phase === 'downloading' || this.state.phase === 'downloaded') return this.getState();
    const release = this.release;
    if (this.state.phase !== 'available' || !release) {
      throw new UpdateError('INVALID_ARGUMENT', '现在没有可下载的新版本，先点「检查更新」。');
    }
    if (this.disposed) throw new UpdateError('UNKNOWN', '助手正在退出');
    const controller = new AbortController();
    let settle!: () => void;
    const active: ActiveDownload = { controller, cancelled: false, done: new Promise<void>((resolve) => { settle = resolve; }) };
    this.active = active;
    this.patch({ phase: 'downloading', error: null, progress: null });
    try {
      const file = await deps.updater().download(release, {
        signal: controller.signal,
        // Late progress (after a cancel or failure) must not resurrect a finished download.
        onProgress: (progress) => {
          if (this.active === active && this.state.phase === 'downloading') this.patch({ progress });
        },
      });
      if (active.cancelled) throw controller.signal.reason ?? new Error('已取消下载');
      // The install button is enabled from this state: carry a fresh busy answer in the same push.
      await this.readBusy(false);
      this.patch({ phase: 'downloaded', progress: null, downloadedFile: file });
      this.log('info', `新版本 ${release.version} 已下载并校验通过：${file}，等待用户安装。`);
    } catch (error) {
      if (active.cancelled) {
        this.patch({ phase: 'available', error: null, progress: null });
        this.log('info', `已取消下载 ${release.version}，下次下载会从断点继续。`);
      } else {
        this.patch({ phase: 'available', error: describe(error), progress: null });
        this.log('warn', `下载更新失败：${describe(error)}`);
      }
    } finally {
      if (this.active === active) this.active = null;
      settle();
    }
    return this.getState();
  }

  /** Stop the running download; the partial file stays, so the next download resumes. */
  async cancelDownload(): Promise<UpdateState> {
    this.requireDeps();
    const active = this.active;
    if (active) {
      active.cancelled = true;
      active.controller.abort(new Error('已取消下载'));
      await active.done;
    }
    return this.getState();
  }

  /**
   * Open the installer and quit.
   * ★ Iron rule 2: refused outright while a gather run, script plan, login or SDK install is in flight, with a
   *   Chinese reason the panel shows as is — the main process enforces it, not a disabled button.
   */
  async install(): Promise<void> {
    const deps = this.requireDeps();
    const release = this.release;
    const file = this.state.downloadedFile;
    if (this.state.phase !== 'downloaded' || !release || !file) {
      throw new UpdateError('INVALID_ARGUMENT', '安装包还没下载完，先点「下载更新」。');
    }
    if (this.quitRequested) return;
    if (this.installing) throw new UpdateError('CONCURRENCY_LIMIT', '正在打开安装包，请稍候。');
    this.installing = true;
    try {
      await this.assertIdle();
      // A check may have started while the gate was asked (it resets the downloaded state).
      if (this.state.phase !== 'downloaded' || this.state.downloadedFile !== file) {
        throw new UpdateError('INVALID_ARGUMENT', '安装包还没下载完，先点「下载更新」。');
      }
      try {
        await deps.updater().verify(file, release);
      } catch (error) {
        this.patch({ phase: 'available', downloadedFile: null, error: describe(error), progress: null });
        this.log('warn', `安装包复核失败：${describe(error)}`);
        throw new UpdateError('UNKNOWN', describe(error));
      }
      // Something may have started while the file was being hashed: ask again right before quitting.
      await this.assertIdle();
      try {
        await deps.updater().open(file);
      } catch (error) {
        this.log('warn', `打开安装包失败：${describe(error)}`);
        throw new UpdateError('UNKNOWN', describe(error));
      }
      this.log('info', `用户确认安装 ${release.version}：已打开安装包，助手即将退出。`);
      this.quitRequested = true;
      deps.quit();
    } finally {
      this.installing = false;
    }
  }

  /** Open the Release page (development builds, other platforms, or when the user wants to download by hand). */
  async openReleasePage(): Promise<void> {
    const deps = this.requireDeps();
    await deps.openExternal(this.state.releaseUrl ?? deps.releasePageUrl());
  }

  /** Show the downloaded installer in Finder. */
  async revealDownload(): Promise<void> {
    const deps = this.requireDeps();
    const file = this.state.downloadedFile;
    if (this.state.phase !== 'downloaded' || !file) throw new UpdateError('INVALID_ARGUMENT', '还没有下载好的安装包。');
    await deps.updater().reveal(file);
  }

  /** Stop a running download when the assistant quits (the partial file is kept for resuming). */
  async dispose(): Promise<void> {
    this.disposed = true;
    const active = this.active;
    if (!active) return;
    active.cancelled = true;
    active.controller.abort(new Error('助手正在退出'));
    await active.done;
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private async assertIdle(): Promise<void> {
    const reason = await this.readBusy();
    if (reason) {
      throw new UpdateError(
        'CONCURRENCY_LIMIT',
        `${reason}安装要先退出助手，现在装会把正在跑的活儿掐断。等它结束、或先手动停掉再装。`,
      );
    }
  }

  private unsupportedReason(): UnsupportedReason | null {
    const deps = this.requireDeps();
    if (!deps.packaged()) return 'dev';
    if (!deps.supportedPlatform()) return 'platform';
    return null;
  }

  /**
   * Ask the busy hook (sync or async). ★ Fail closed: a hook that throws counts as busy. The answer is kept for state
   * reads and pushed to the renderer when it changed (unless the caller publishes a patch right after).
   */
  private async readBusy(publishChange = true): Promise<string | null> {
    const deps = this.deps;
    if (!deps) return null;
    let reason: string | null;
    try { reason = (await deps.busy()) || null; }
    catch (error) {
      reason = BUSY_UNKNOWN;
      // Logged once per failure streak: the service re-asks every few seconds while an installer waits.
      if (this.busyReason !== BUSY_UNKNOWN) this.log('warn', `读取任务占用失败，按占用处理：${describe(error)}`);
    }
    if (reason !== this.busyReason) {
      this.busyReason = reason;
      if (publishChange) this.publish();
    }
    return reason;
  }

  private patch(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch };
    this.publish();
  }

  private publish(): void {
    try {
      this.deps?.publish(this.getState());
    } catch (error) {
      this.log('warn', `推送更新状态失败（已忽略）：${describe(error)}`);
    }
  }

  private now(): number {
    return this.deps?.now?.() ?? Date.now();
  }

  private log(level: UpdateLogLevel, message: string): void {
    const fn = this.deps?.log;
    if (fn) {
      try { fn(level, message); return; }
      catch { /* Logging must never break the update flow. */ }
    }
    if (level === 'warn' || level === 'error') console.warn(`[update] ${message}`);
    else console.log(`[update] ${message}`);
  }

  private requireDeps(): UpdateDeps {
    if (!this.deps) throw new UpdateError('UNKNOWN', '更新中心还没初始化。');
    return this.deps;
  }
}

/** The raw errors mean nothing to users; translate the common ones (check, download and install failures). */
export function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // File system first: their messages carry paths, which must not be mistaken for network words below.
  const code = typeof error === 'object' && error !== null ? (error as NodeJS.ErrnoException).code : undefined;
  const fsError = (name: string) => code === name || new RegExp(`\\b${name}\\b`).test(message);
  if (fsError('EPERM') || fsError('EACCES') || fsError('EROFS')) {
    return '没有权限读写保存安装包的文件夹（「下载」文件夹或临时文件夹）：请在「系统设置 → 隐私与安全性 → 文件和文件夹」里'
      + '允许万龙助手访问「下载」文件夹后重试，或到 Release 页手动下载。';
  }
  if (fsError('ENOSPC') || fsError('EDQUOT')) {
    return '磁盘空间不足，安装包没能保存完：清理出几百 MB 空间后再点「下载更新」，已下载的部分会接着续传。';
  }
  // Node fetch says `fetch failed`, Electron's net.fetch `net::ERR_…`, our own timeouts carry ETIMEDOUT.
  if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|network|fetch failed|socket hang up|net::ERR_|timeout|timed out/i.test(message)) {
    return '连不上 GitHub（网络不通或被墙），稍后再试，或到 Release 页手动下载。';
  }
  if (/rate limit/i.test(message)) return 'GitHub API 限流了，过一会儿再试。';
  if (/404/.test(message)) return '没找到发布信息（仓库还没有 Release？）。';
  // Not a bare /sha256/: 「缺少 SHA256SUMS」 is a different, already-Chinese problem.
  if (/sha256 mismatch|sha512|checksum/i.test(message)) return '下载的文件校验没通过，已丢弃，请重试。';
  return message;
}
