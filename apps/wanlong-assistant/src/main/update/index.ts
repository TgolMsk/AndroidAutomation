/**
 * In-app update service: the `UpdateCenter` state machine plus the one automatic check after startup.
 * See `./README.md` for the flow, the iron rules and what differs from the original electron-updater version.
 */
import { UpdateCenter, type UpdateDeps } from './center';

export { BusyGate, describeHolder, formatBusyReason, gatherRunProbe, loginProbe, planRunProbe, sdkInstallProbe } from './busy';
export type { BusyHolder, BusyProbe } from './busy';
export { UpdateCenter, UpdateError, describe } from './center';
export type { UpdateDeps, UpdateLogLevel, UpdateRelease, UpdaterPort } from './center';

/** Delay of the automatic check: startup is busy restoring schedules and devices, the network can wait. */
export const AUTO_CHECK_DELAY_MS = 30_000;

export interface UpdateServiceOptions {
  /** Default 30 s. */
  autoCheckDelayMs?: number;
  /** False skips the automatic check (verification screenshots and packaged smoke runs never touch the network). */
  autoCheck?: boolean;
}

export class UpdateService {
  readonly center = new UpdateCenter();
  private timer: NodeJS.Timeout | null = null;

  /** Initializes the center right away, so the renderer can read the version before `start()`; never throws. */
  constructor(deps: () => UpdateDeps, private readonly options: UpdateServiceOptions = {}) {
    try { this.center.init(deps()); }
    catch (error) { console.error('[wanlong/update] 更新中心初始化失败', error); }
  }

  /**
   * ★ The only automatic action: one silent check after startup. It reads release metadata and never downloads
   *   or installs. Development builds and unsupported platforms skip it.
   */
  start(): void {
    if (this.timer || this.options.autoCheck === false || !this.center.supported) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.center.check().catch((error: unknown) => console.warn('[wanlong/update] 自动检查更新失败', error));
    }, this.options.autoCheckDelayMs ?? AUTO_CHECK_DELAY_MS);
    this.timer.unref?.();
  }

  /** Cancel the pending automatic check and stop a running download (its partial file is kept for resuming). */
  async dispose(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.center.dispose();
  }
}
