import type { RawFrame } from '@avdm/automation';
import type { FreezeRecoveryIo, InstanceProbe } from '@avdm/automation/wanlong';

/** The part of an `AdbDevice` the recovery uses (lane-bound in the app). */
export interface FreezeDevice {
  readonly serial: string;
  getState(): Promise<string | undefined>;
  isBootCompleted(): Promise<boolean>;
  foregroundPackage(): Promise<string | undefined>;
  /** ★ Without an activity this is `monkey -p <pkg> -c LAUNCHER 1`: the only launch that works for this game. */
  startApp(pkg: string): Promise<void>;
  isAppRunning?(pkg: string): Promise<boolean>;
  screencapRaw(): Promise<RawFrame>;
}

/** The part of core's `AvdManager` the recovery uses. */
export interface FreezeManager {
  getState(index: number): Promise<{ status: string; pid?: number | null }>;
  stop(index: number, opts?: { force?: boolean }): Promise<void>;
  start(index: number, opts?: { wait?: boolean }): Promise<unknown>;
  device(index: number): Promise<FreezeDevice>;
}

export interface AvdFreezeIoOptions {
  manager(): Promise<FreezeManager>;
  index: number;
  signal: AbortSignal;
  gamePackage: string;
  /** Known-screen check on the instance's cached templates (`AutomationHost.recognizeScreen`). */
  recognize(raw: RawFrame, signal: AbortSignal): Promise<boolean>;
  /** Discard queued adb work of the instance after the forced stop (`DeviceLanes.drop`). */
  dropLane?(index: number): void;
  log(level: 'debug' | 'info' | 'warn', message: string): void;
  /** How long `restartInstance` waits for the new emulator process to show up (default 30 s). */
  launchWaitMs?: number;
  sleep?(ms: number): Promise<void>;
  now?(): number;
}

const ALIVE = new Set(['starting', 'booting', 'running']);

/**
 * The recovery flow's device capabilities on the Android Emulator (@avdm/core), replacing the original MuMu /
 * LDPlayer adapter:
 *   restart   = `stop({ force: true })` + `start()` — a SIGKILL keeps the snapshot-stale marker, so the next start
 *               cold-boots instead of saving the frozen guest into its Quick Boot snapshot (DECISIONS C; the core's
 *               own `restart()` stops gracefully and is not used)
 *   state     = `getState()`: process started = starting / booting / running; Android started = running
 *               (gRPC booted + sys.boot_completed); the pid tells a new process from the old one
 *   attach    = `device()` re-reads the discovery file (the serial `emulator-<console>` may change) + adb state
 *   launch    = `startApp(pkg)` without an activity (monkey), only for the game's own package
 * `waitForBoot` is not used: it takes no AbortSignal, so the flow polls `getState` itself.
 */
export function createAvdFreezeRecoveryIo(options: AvdFreezeIoOptions): FreezeRecoveryIo {
  const { index, signal, gamePackage } = options;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => { const timer = setTimeout(resolve, ms); timer.unref?.(); }));
  let current: FreezeDevice | null = null;
  const device = (serial: string): FreezeDevice => {
    if (!current || current.serial !== serial) throw new Error(`设备 ${serial} 已不可用，请重新连接`);
    return current;
  };
  return {
    async restartInstance() {
      const manager = await options.manager();
      await manager.stop(index, { force: true });
      options.dropLane?.(index);
      current = null;
      let failure: unknown = null;
      let settled = false;
      // start() may wait for boot (managed identity): do not await it here, only its failure and the new process.
      void manager.start(index).then(() => { settled = true; }, (error: unknown) => { settled = true; failure = error; });
      const deadline = now() + (options.launchWaitMs ?? 30_000);
      while (!settled && now() < deadline && !signal.aborted) {
        const state = await manager.getState(index).catch(() => null);
        if (state && ALIVE.has(state.status)) break;
        await sleep(500);
      }
      if (failure) throw failure;
    },
    async instanceState(): Promise<InstanceProbe | null> {
      const state = await (await options.manager()).getState(index);
      return { processStarted: ALIVE.has(state.status), androidStarted: state.status === 'running', pid: state.pid ?? null };
    },
    async dropDevice() {
      current = null;
      options.dropLane?.(index);
    },
    async attachDevice() {
      const dev = await (await options.manager()).device(index);
      const state = await dev.getState();
      if (state !== 'device') throw new Error(`adb 设备状态是「${state ?? '未连接'}」`);
      current = dev;
      return dev.serial;
    },
    // async: a stale serial rejects (never a synchronous throw out of the flow's awaits).
    isBooted: async (serial) => device(serial).isBootCompleted(),
    foreground: async (serial) => (await device(serial).foregroundPackage()) ?? null,
    launchGame: async (serial) => {
      if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/.test(gamePackage)) throw new Error('游戏包名无效');
      await device(serial).startApp(gamePackage);
    },
    isGameRunning: async (serial) => {
      const dev = device(serial);
      if (!dev.isAppRunning) throw new Error('无法查询游戏进程');
      return dev.isAppRunning(gamePackage);
    },
    capture: async (serial) => device(serial).screencapRaw(),
    recognize: (raw) => options.recognize(raw, signal),
    log: options.log,
    signal,
  };
}
