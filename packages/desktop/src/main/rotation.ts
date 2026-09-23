import type { DisplayRotation } from '../shared/ipc';

/**
 * Device-side commands that reveal Android's current display rotation, most specific first. On the
 * emulator 37 / android-35 image `dumpsys display` reports `mCurrentOrientation=<0..3>` (verified on real
 * hardware); older images expose it through the input dump (`SurfaceOrientation: <n>` or the viewport's
 * `orientation=`). grep runs on the device so only one line crosses adb.
 */
export const ROTATION_PROBES: readonly string[] = [
  'dumpsys display | grep -m 1 mCurrentOrientation=',
  "dumpsys input | grep -m 1 -E 'SurfaceOrientation|Viewport INTERNAL'",
];

function quarterTurns(value: string): DisplayRotation | undefined {
  const n = Number(value);
  if (n === 0 || n === 1 || n === 2 || n === 3) return n;
  if (n === 90 || n === 180 || n === 270) return (n / 90) as DisplayRotation;
  return undefined;
}

/** Parse the rotation from the output of one of ROTATION_PROBES (undefined when it is not there). */
export function parseDisplayRotation(text: string): DisplayRotation | undefined {
  const m =
    /mCurrentOrientation=(\d+)/.exec(text) ??
    /SurfaceOrientation:\s*(\d+)/.exec(text) ??
    /\borientation=(?:ROTATION_)?(\d+)/i.exec(text);
  return m?.[1] !== undefined ? quarterTurns(m[1]) : undefined;
}

/**
 * Polls Android's display rotation for one instance. The first probe that yields a value is kept for the
 * following polls; while none does, all are retried only every `retryMs` (the image may not support them).
 */
export class RotationProber {
  private source: number | undefined;
  private unsupportedUntil = 0;

  constructor(
    private readonly shell: (command: string) => Promise<string>,
    private readonly retryMs = 10_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Current rotation, or undefined when it cannot be determined (callers keep the last known value). */
  async probe(): Promise<DisplayRotation | undefined> {
    if (this.source !== undefined) {
      const r = await this.run(this.source);
      if (r !== undefined) return r;
      this.source = undefined; // fall through and rediscover
    }
    if (this.now() < this.unsupportedUntil) return undefined;
    for (let i = 0; i < ROTATION_PROBES.length; i++) {
      const r = await this.run(i);
      if (r !== undefined) {
        this.source = i;
        return r;
      }
    }
    this.unsupportedUntil = this.now() + this.retryMs;
    return undefined;
  }

  private async run(i: number): Promise<DisplayRotation | undefined> {
    try {
      return parseDisplayRotation(await this.shell(ROTATION_PROBES[i]!));
    } catch {
      return undefined; // grep found nothing (exit 1), device busy, adb hiccup…
    }
  }
}
