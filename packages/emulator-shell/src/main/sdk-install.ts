import type { InstallProgress, SdkInstallPlan } from '@avdm/core';
import type { SdkInstallStatus } from '../shared/ipc';

interface Running {
  key: string;
  packages: string[];
  plan: SdkInstallPlan;
  abort: AbortController;
  promise: Promise<void>;
  progress: Record<string, InstallProgress>;
}

function packagesKey(packages: string[]): string {
  return [...new Set(packages)].sort().join('\n');
}

/**
 * The single SDK install the main process may run at a time. It outlives renderers: a reloaded or reopened
 * wizard can read its status and join it, and quitting the app aborts it and waits until the installer has
 * killed curl/unzip and finished (or rolled back) moving directories.
 */
export class SdkInstallTask {
  private running: Running | undefined;

  get active(): boolean {
    return this.running !== undefined;
  }

  /**
   * Start `install` for `packages`, or join the running install when it is for the same package set.
   * `prepare` runs before the install starts (e.g. to compute the plan shown by the wizard).
   */
  run(
    packages: string[],
    prepare: () => Promise<SdkInstallPlan>,
    install: (signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    const key = packagesKey(packages);
    const current = this.running;
    if (current) {
      if (current.key === key) return current.promise;
      return Promise.reject(new Error('已有 SDK 安装任务正在进行，请等待其完成或先取消'));
    }
    const abort = new AbortController();
    const running: Running = {
      key,
      packages: [...packages],
      plan: { packages: [], licenses: {}, unaccepted: [], missing: [], totalBytes: 0 },
      abort,
      progress: {},
      promise: Promise.resolve(),
    };
    running.promise = (async () => {
      try {
        running.plan = await prepare();
        if (abort.signal.aborted) throw new Error('安装已取消');
        await install(abort.signal);
      } catch (err) {
        if (abort.signal.aborted) throw new Error('安装已取消');
        throw err;
      } finally {
        if (this.running === running) this.running = undefined;
      }
    })();
    this.running = running;
    return running.promise;
  }

  /** Record progress of the running install (ignored when idle). */
  noteProgress(progress: InstallProgress): void {
    const running = this.running;
    if (!running) return;
    running.progress = { ...running.progress, [progress.packagePath]: progress };
  }

  status(): SdkInstallStatus | null {
    const running = this.running;
    if (!running) return null;
    return {
      packages: [...running.packages],
      plan: running.plan,
      progress: { ...running.progress },
      cancelling: running.abort.signal.aborted,
    };
  }

  /** Request cancellation; resolves immediately. */
  cancel(): void {
    this.running?.abort.abort();
  }

  /** Cancel and wait until the install has settled (curl/unzip killed, directory moves finished or rolled back). */
  async abortAndWait(): Promise<void> {
    const running = this.running;
    if (!running) return;
    running.abort.abort();
    await running.promise.catch(() => undefined);
  }
}
