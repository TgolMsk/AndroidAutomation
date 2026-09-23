import {
  AvdManager,
  emulatorDiscoveryDirs,
  loadSettings,
  type InstanceSpec,
  type InstanceState,
  type InstanceStatus,
} from '@avdm/core';
import { broadcast } from './events';
import { DirWatcher, type DirWatchOptions } from './fs-watch';
import { errorMessage, withTimeout } from './util';

/** Debounce for file-system change notifications from the CLI (instances.json, run records, settings). */
export const WATCH_DEBOUNCE_MS = 300;
/** Fallback rescan when fs.watch is unavailable or silent. */
export const WATCH_POLL_MS = 3000;

const REGISTRY_FILE = 'instances.json';
const SETTINGS_FILE = 'settings.json';
const RUN_RECORD_RE = /^instance-\d+\.json$/;
const DISCOVERY_FILE_RE = /^pid_\d+\.ini$/;

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Owns the single AvdManager of the app. Opening is lazy and retried on the next call if it failed,
 * so the UI can show a meaningful error instead of the app crashing at startup.
 *
 * Changes made by other processes (the `avdm` CLI) are picked up promptly: the registry, the run records,
 * the emulator discovery dir and settings.json are watched (debounced, with a slow poll as fallback) and
 * turned into 'instances-changed' / 'instance-state' / 'settings-changed' events.
 */
export class ManagerHost {
  manager: AvdManager | undefined;
  /** Last known status per instance index (from monitor events and list() results). */
  readonly statuses = new Map<number, InstanceStatus>();
  /** Last known display size per instance index (screenshot requests pass both dimensions). */
  readonly specs = new Map<number, Pick<InstanceSpec, 'width' | 'height'>>();
  private opening: Promise<AvdManager> | undefined;
  private disposed = false;
  private readonly watchers: DirWatcher[] = [];
  private refreshing: Promise<void> | undefined;
  private refreshAgain = false;
  private registryDirty = false;

  get(): Promise<AvdManager> {
    if (this.manager) return Promise.resolve(this.manager);
    if (this.disposed) return Promise.reject(new Error('应用正在退出'));
    if (!this.opening) {
      this.opening = this.open().catch((err: unknown) => {
        this.opening = undefined;
        throw new Error(`管理器初始化失败：${errorMessage(err)}`);
      });
    }
    return this.opening;
  }

  noteStates(states: InstanceState[]): void {
    const seen = new Set<number>();
    for (const s of states) {
      this.noteState(s);
      seen.add(s.record.index);
    }
    for (const index of [...this.statuses.keys()]) {
      if (!seen.has(index)) {
        this.statuses.delete(index);
        this.specs.delete(index);
      }
    }
  }

  private noteState(state: InstanceState): void {
    this.statuses.set(state.record.index, state.status);
    this.specs.set(state.record.index, { width: state.record.spec.width, height: state.record.spec.height });
  }

  private async open(): Promise<AvdManager> {
    const manager = await AvdManager.open();
    manager.on('instance-state', (state) => {
      this.noteState(state);
      broadcast('instance-state', state);
    });
    manager.on('instances-changed', () => broadcast('instances-changed', null));
    manager.on('sdk-progress', (progress) => broadcast('sdk-progress', progress));
    manager.on('script-run', (run) => broadcast('script-run', run));
    manager.on('script-output', (runId, line) => broadcast('script-output', { runId, line }));
    manager.on('log', (entry) => broadcast('log', entry));
    try {
      manager.startMonitor();
    } catch (err) {
      console.error('[avdm] 健康监控启动失败:', err);
      broadcast('log', { level: 'warn', message: `健康监控启动失败：${errorMessage(err)}`, at: new Date().toISOString() });
    }
    this.manager = manager;
    this.watchExternalChanges(manager);
    return manager;
  }

  /** Watch what the CLI (or another manager process) changes on disk. */
  private watchExternalChanges(manager: AvdManager): void {
    const add = (dir: string, filter: (name: string) => boolean, onChange: () => void) => {
      const opts: DirWatchOptions = { filter, debounceMs: WATCH_DEBOUNCE_MS, pollMs: WATCH_POLL_MS };
      const watcher = new DirWatcher(dir, onChange, opts);
      this.watchers.push(watcher);
      watcher.start().catch((err: unknown) => console.error(`[avdm] 无法监视目录 ${dir}:`, err));
    };
    // `avdm create` / `rm` / `set` rewrite instances.json (temp file renamed over it).
    add(manager.paths.home, (n) => n === REGISTRY_FILE, () => void this.refreshInstances(manager, true));
    // `avdm start` / `stop` write and clear run records.
    add(manager.paths.runDir, (n) => RUN_RECORD_RE.test(n), () => void this.refreshInstances(manager, false));
    // Emulators add/remove their discovery file when they come up or exit (also crashes, external stops).
    for (const dir of emulatorDiscoveryDirs()) {
      add(dir, (n) => DISCOVERY_FILE_RE.test(n), () => void this.refreshInstances(manager, false));
    }
    // `avdm settings set …`
    add(manager.paths.home, (n) => n === SETTINGS_FILE, () => void this.settingsChanged(manager));
  }

  /**
   * Recompute all states (the manager emits 'instance-state' for instances whose state changed) and tell
   * renderers to reload when the registry itself changed (new, removed or renamed instances do not produce
   * state events). Concurrent triggers are coalesced into one more pass.
   */
  refreshInstances(manager: AvdManager, registryChanged: boolean): Promise<void> {
    if (registryChanged) this.registryDirty = true;
    if (this.refreshing) {
      this.refreshAgain = true;
      return this.refreshing;
    }
    this.refreshing = (async () => {
      try {
        do {
          this.refreshAgain = false;
          if (this.disposed) return;
          const before = new Set(this.statuses.keys());
          try {
            this.noteStates(await manager.list());
          } catch (err) {
            console.error('[avdm] 刷新实例状态失败:', errorMessage(err));
          }
          const after = new Set(this.statuses.keys());
          const indexSetChanged = before.size !== after.size || [...after].some((i) => !before.has(i));
          if (this.registryDirty || indexSetChanged) {
            this.registryDirty = false;
            broadcast('instances-changed', null);
          }
        } while (this.refreshAgain && !this.disposed);
      } finally {
        this.refreshing = undefined;
      }
    })();
    return this.refreshing;
  }

  /**
   * settings.json changed on disk. The manager re-reads it on its health-check tick; restart the monitor so
   * that tick runs now (it also re-scans the SDK when sdkRoot changed), then tell renderers to reload.
   */
  async settingsChanged(manager: AvdManager): Promise<void> {
    if (this.disposed) return;
    let onDisk: unknown;
    try {
      onDisk = await loadSettings(manager.paths);
    } catch {
      return; // unreadable / mid-edit: the manager keeps its last good copy
    }
    if (!sameJson(onDisk, manager.getSettings())) {
      try {
        manager.stopMonitor();
        manager.startMonitor();
      } catch {
        // disposed
      }
      const deadline = Date.now() + 2000;
      while (!this.disposed && Date.now() < deadline && !sameJson(onDisk, manager.getSettings())) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    if (!this.disposed) broadcast('settings-changed', null);
  }

  /** Stop monitor / watchers / gRPC clients. Emulators keep running (they are detached). */
  async dispose(): Promise<void> {
    this.disposed = true;
    for (const w of this.watchers.splice(0)) w.close();
    const manager = this.manager ?? (this.opening ? await withTimeout(this.opening, 2000, undefined) : undefined);
    for (const w of this.watchers.splice(0)) w.close(); // opened while we waited
    if (!manager) return;
    try {
      await manager.dispose();
    } catch (err) {
      console.error('[avdm] 释放管理器失败:', err);
    }
  }
}
