import type { DevicePort, RawFrame } from '../contracts.js';
import { ensureGameForeground } from './launch.js';
import type { GatherIo } from './gather/session.js';

export interface GatherIoOptions {
  refWidth: number;
  refHeight: number;
  signal?: AbortSignal;
  /** Receives cold-start diagnostics from ensureGameForeground (Chinese messages). */
  log?: (level: 'debug' | 'info' | 'warn', message: string) => void;
}

/** Map reference coordinates to actual frame pixels at the AVD boundary. */
export function createGatherIo(device: DevicePort, options: GatherIoOptions): GatherIo {
  let width = 0;
  let height = 0;
  const check = (): void => {
    if (options.signal?.aborted) throw options.signal.reason instanceof Error ? options.signal.reason : new Error('采集已取消');
  };
  const capture = async (): Promise<RawFrame> => {
    check();
    const frame = await device.capture(options.signal);
    width = frame.width;
    height = frame.height;
    return frame;
  };
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
      check();
      await device.tap(value.x, value.y);
    },
    async tapMany(points, gapMs = 0) {
      for (const [x, y] of points) {
        const value = await point(x, y);
        check();
        await device.tap(value.x, value.y);
        if (gapMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, gapMs));
      }
    },
    async swipe(x1, y1, x2, y2, durationMs) {
      const a = await point(x1, y1);
      const b = await point(x2, y2);
      check();
      await device.swipe(a.x, a.y, b.x, b.y, durationMs);
    },
    async key(key) { check(); await device.key(key); },
    async launchApp(packageName, cold) { check(); await device.launchApp(packageName, cold); },
    async foregroundPackage() { check(); return device.foregroundPackage(); },
    async ensureGameForeground(packageName) {
      check();
      return ensureGameForeground({
        foreground: () => device.foregroundPackage(),
        // The host's Wanlong launch adapter must use monkey, which works on a cold game process.
        launch: () => device.launchApp(packageName, false),
        isRunning: device.isAppRunning ? () => device.isAppRunning!(packageName) : undefined,
        // Cancellation must stop the 60 s foreground wait promptly; query errors stay swallowed.
        checkAlive: check,
        log: options.log,
      }, { packageName });
    },
  };
}
