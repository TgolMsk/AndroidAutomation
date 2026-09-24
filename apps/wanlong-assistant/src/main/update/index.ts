/**
 * In-app update service: the `UpdateCenter` state machine plus the one automatic check after startup.
 * See `./README.md` for the flow, the iron rules and what differs from the original electron-updater version.
 */
import { UpdateCenter, type UpdateDeps, type UpdateLogLevel } from './center';

export { INSTANCE_SLOTS, SDK_INSTALL_BUSY, instanceHolders, interimInstanceBusy, updateBusyCheck } from './busy';
export type { BusyCheck, InstanceBusyServices, InstanceHolder, UpdateBusySources } from './busy';
export { BUSY_UNKNOWN, UpdateCenter, UpdateError, describe } from './center';
export type { UpdateDeps, UpdateLogLevel, UpdateRelease, UpdaterPort } from './center';

/** Delay of the automatic check: startup is busy restoring schedules and devices, the network can wait. */
export const AUTO_CHECK_DELAY_MS = 30_000;
/** While a downloaded installer waits, the busy answer is re-read this often so the install button follows the work. */
export const BUSY_REFRESH_MS = 5_000;

/** Scope of update lines in the app log (the original wrote `scope: 'update'` into `logs/app.ndjson`). */
export const UPDATE_LOG_SCOPE = 'update';

/** The app log's writer: the app shell's `AppLog` fits as is (`record(level, scope, message)`). */
export interface AppLogWriter {
  record(level: UpdateLogLevel, scope: string, message: string): void;
}

/**
 * Console writer for a build without the app log. Lines carry a `[scope]` tag, which the app log's console capture
 * turns back into the entry's scope, so warnings and errors still reach the log file.
 */
export const consoleLogWriter: AppLogWriter = {
  record(level, scope, message) {
    if (level === 'warn' || level === 'error') console.warn(`[${scope}] ${message}`);
    else console.log(`[${scope}] ${message}`);
  },
};

/**
 * The `log` port of `UpdateDeps`: every update line goes to the app log with scope `update`.
 * ★ It must reach the disk, not only the console: a packaged app opened from Finder has no console anyone can read.
 */
export function updateLog(writer: AppLogWriter): (level: UpdateLogLevel, message: string) => void {
  return (level, message) => writer.record(level, UPDATE_LOG_SCOPE, message);
}

export interface UpdateServiceOptions {
  /** Default 30 s. */
  autoCheckDelayMs?: number;
  /** False skips the automatic check (verification screenshots and packaged smoke runs never touch the network). */
  autoCheck?: boolean;
  /** Default 5 s. */
  busyRefreshMs?: number;
  /** Where the service's own failures go (default: the console writer). */
  log?: (level: UpdateLogLevel, message: string) => void;
}

export class UpdateService {
  readonly center = new UpdateCenter();
  private timer: NodeJS.Timeout | null = null;
  private busyTimer: NodeJS.Timeout | null = null;
  private refreshing = false;
  private readonly log: (level: UpdateLogLevel, message: string) => void;

  /** Initializes the center right away, so the renderer can read the version before `start()`; never throws. */
  constructor(deps: () => UpdateDeps, private readonly options: UpdateServiceOptions = {}) {
    this.log = options.log ?? updateLog(consoleLogWriter);
    try { this.center.init(deps()); }
    catch (error) { this.log('error', `更新中心初始化失败：${errorText(error)}`); }
  }

  /**
   * ★ The only automatic action: one silent check after startup. It reads release metadata and never downloads
   *   or installs. Development builds and unsupported platforms skip it.
   * Also keeps the busy answer fresh while a downloaded installer waits (the busy hook is async, state reads are not).
   */
  start(): void {
    if (!this.busyTimer && this.center.supported) {
      this.busyTimer = setInterval(() => this.refreshBusy(), this.options.busyRefreshMs ?? BUSY_REFRESH_MS);
      this.busyTimer.unref?.();
    }
    if (this.timer || this.options.autoCheck === false || !this.center.supported) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.center.check().catch((error: unknown) => this.log('warn', `自动检查更新失败：${errorText(error)}`));
    }, this.options.autoCheckDelayMs ?? AUTO_CHECK_DELAY_MS);
    this.timer.unref?.();
  }

  /** Cancel the pending automatic check and stop a running download (its partial file is kept for resuming). */
  async dispose(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    if (this.busyTimer) clearInterval(this.busyTimer);
    this.timer = null;
    this.busyTimer = null;
    await this.center.dispose();
  }

  /** Only the install button depends on it, so only the 'downloaded' phase asks (one call at a time). */
  private refreshBusy(): void {
    if (this.refreshing || this.center.getState().phase !== 'downloaded') return;
    this.refreshing = true;
    void this.center.refreshBusy()
      .catch((error: unknown) => this.log('warn', `刷新任务占用失败：${errorText(error)}`))
      .finally(() => { this.refreshing = false; });
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
