import type { DevicePort, RawFrame } from '../contracts.js';
import { ensureGameForeground, type GameLaunchIo } from './launch.js';
import { GatherHalt, type GatherIo, type GatherLogger } from './gather/session.js';

export interface GatherIoOptions {
  refWidth: number;
  refHeight: number;
  signal?: AbortSignal;
  /** Receives the cold-start recovery log lines (Chinese). */
  log?: GatherLogger;
}

const CANCELLED_MESSAGE = '自动采集已被中止。';

/**
 * Map reference coordinates to actual frame pixels at the AVD boundary.
 *
 * Cancellation is a `GatherHalt('cancelled')`: checked before every call and also when a pending device call
 * rejects because the run was aborted, so the flow reports outcome `cancelled` (no backoff, no error shot)
 * instead of a failure.
 */
export function createGatherIo(device: DevicePort, options: GatherIoOptions): GatherIo {
  let width = 0;
  let height = 0;
  const check = (): void => {
    if (options.signal?.aborted) throw new GatherHalt('cancelled', CANCELLED_MESSAGE);
  };
  const guarded = async <T>(call: () => Promise<T>): Promise<T> => {
    check();
    try {
      return await call();
    } catch (error) {
      if (options.signal?.aborted && !(error instanceof GatherHalt)) throw new GatherHalt('cancelled', CANCELLED_MESSAGE);
      throw error;
    }
  };
  const capture = (): Promise<RawFrame> => guarded(async () => {
    const frame = await device.capture(options.signal);
    width = frame.width;
    height = frame.height;
    return frame;
  });
  const point = async (x: number, y: number): Promise<{ x: number; y: number }> => {
    if (!width || !height) await capture();
    check();
    return {
      x: Math.round(x * width / options.refWidth),
      y: Math.round(y * height / options.refHeight),
    };
  };
  return {
    capture,
    async tap(x, y) {
      const value = await point(x, y);
      await guarded(() => device.tap(value.x, value.y));
    },
    async tapMany(points, gapMs = 0) {
      const mapped: [number, number][] = [];
      for (const [x, y] of points) {
        const value = await point(x, y);
        mapped.push([value.x, value.y]);
      }
      // One shell for the whole burst (measured: 5 separate taps 103 ms, merged 34 ms) when the host offers it.
      if (device.tapMany) {
        const tapMany = device.tapMany.bind(device);
        await guarded(() => tapMany(mapped, gapMs));
        return;
      }
      for (const [x, y] of mapped) {
        await guarded(() => device.tap(x, y));
        if (gapMs > 0) await guarded(() => new Promise<void>((resolve) => setTimeout(resolve, gapMs)));
      }
    },
    async swipe(x1, y1, x2, y2, durationMs) {
      const a = await point(x1, y1);
      const b = await point(x2, y2);
      await guarded(() => device.swipe(a.x, a.y, b.x, b.y, durationMs));
    },
    key: (key) => guarded(() => device.key(key)),
    launchApp: (packageName, cold) => guarded(() => device.launchApp(packageName, cold)),
    foregroundPackage: () => guarded(() => device.foregroundPackage()),
    async ensureGameForeground(packageName) {
      check();
      const io: GameLaunchIo = {
        // Every query re-checks cancellation so a stop is seen within one poll, not at the 60 s deadline.
        foreground: () => guarded(() => device.foregroundPackage()),
        // The host's Wanlong launch adapter must use monkey, which works on a cold game process.
        launch: () => guarded(() => device.launchApp(packageName, false)),
        ...(device.isAppRunning ? { isRunning: () => guarded(() => device.isAppRunning!(packageName)) } : {}),
        log: (level, message) => options.log?.(level, message),
        checkAlive: check,
      };
      const presence = await ensureGameForeground(io, { packageName });
      check();
      return presence;
    },
  };
}
