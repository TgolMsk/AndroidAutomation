import { BrowserWindow, type WebContents } from 'electron';
import type { AvdManager } from '@avdm/core';
import type { ThumbnailFrame } from '../shared/ipc';
import { sendEvent } from './events';
import type { ManagerHost } from './manager-host';
import { heightFor, isInstanceIndex, pngSize, toU8 } from './util';

const DEFAULT_WIDTH = 320;
const DEFAULT_INTERVAL_MS = 2000;
const MIN_INTERVAL_MS = 250;
const MAX_CONCURRENT = 3;
const TICK_MS = 200;
/** Back off a little after a failed capture so a wedged instance does not hog a slot. */
const FAILURE_BACKOFF_MS = 3000;
const CAPTURE_TIMEOUT_MS = 4000;

interface Subscription {
  wc: WebContents;
  indices: Set<number>;
  width: number;
  intervalMs: number;
}

interface Want {
  width: number;
  intervalMs: number;
  targets: WebContents[];
}

/**
 * Polls manager.screenshot() for the instances each renderer subscribed to and pushes 'thumbnail'
 * events. At most MAX_CONCURRENT captures in flight; an index is skipped while its previous capture
 * is still running; windows that are hidden/minimised are not served.
 */
export class ThumbnailService {
  private readonly subs = new Map<number, Subscription>();
  private readonly hooked = new WeakSet<WebContents>();
  private readonly lastAt = new Map<number, number>();
  private readonly inflight = new Set<number>();
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly host: ManagerHost) {}

  subscribe(wc: WebContents, indices: number[], opts: { width?: number; intervalMs?: number } = {}): void {
    const clean = [...new Set(indices.filter(isInstanceIndex))];
    if (clean.length === 0) {
      this.subs.delete(wc.id);
    } else {
      const width = Math.round(Math.min(Math.max(Number(opts.width) || DEFAULT_WIDTH, 64), 1920));
      const intervalMs = Math.max(Number(opts.intervalMs) || DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS);
      this.subs.set(wc.id, { wc, indices: new Set(clean), width, intervalMs });
      if (!this.hooked.has(wc)) {
        this.hooked.add(wc);
        const id = wc.id;
        wc.once('destroyed', () => {
          this.subs.delete(id);
          this.updateTimer();
        });
      }
    }
    this.updateTimer();
  }

  dispose(): void {
    this.subs.clear();
    this.updateTimer();
  }

  private updateTimer(): void {
    if (this.subs.size > 0 && !this.timer) {
      this.timer = setInterval(() => this.tick(), TICK_MS);
    } else if (this.subs.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private isActive(index: number): boolean {
    const status = this.host.statuses.get(index);
    // Unknown → let the capture decide (it fails fast when the instance is not up).
    return status === undefined || status === 'running' || status === 'booting';
  }

  private tick(): void {
    const manager = this.host.manager;
    if (!manager) return;
    const wanted = new Map<number, Want>();
    for (const [id, sub] of this.subs) {
      if (sub.wc.isDestroyed()) {
        this.subs.delete(id);
        continue;
      }
      if (!isShown(sub.wc)) continue;
      for (const index of sub.indices) {
        const w = wanted.get(index);
        if (w) {
          w.width = Math.max(w.width, sub.width);
          w.intervalMs = Math.min(w.intervalMs, sub.intervalMs);
          w.targets.push(sub.wc);
        } else {
          wanted.set(index, { width: sub.width, intervalMs: sub.intervalMs, targets: [sub.wc] });
        }
      }
    }
    const now = Date.now();
    // Oldest first so every subscribed instance gets its turn.
    const due = [...wanted.entries()]
      .filter(([index, want]) => !this.inflight.has(index) && this.isActive(index) && now - (this.lastAt.get(index) ?? 0) >= want.intervalMs)
      .sort((a, b) => (this.lastAt.get(a[0]) ?? 0) - (this.lastAt.get(b[0]) ?? 0));
    for (const [index, want] of due) {
      if (this.inflight.size >= MAX_CONCURRENT) break;
      this.capture(manager, index, want);
    }
  }

  private capture(manager: AvdManager, index: number, want: Want): void {
    this.inflight.add(index);
    this.lastAt.set(index, Date.now());
    this.grab(manager, index, want.width)
      .then((png) => {
        const data = toU8(png);
        const { width, height } = pngSize(data);
        const frame: ThumbnailFrame = { index, png: data, width, height, at: Date.now() };
        for (const wc of want.targets) sendEvent(wc, 'thumbnail', frame);
      })
      .catch(() => {
        this.lastAt.set(index, Date.now() + FAILURE_BACKOFF_MS);
      })
      .finally(() => {
        this.inflight.delete(index);
      });
  }

  /**
   * PNG at `width`. The emulator scales by width AND height (a width-only request may fall back to the full
   * device size), so pass both at the device aspect ratio; core's screenshot() (gRPC width-only, then adb)
   * is the fallback.
   */
  private async grab(manager: AvdManager, index: number, width: number): Promise<Uint8Array> {
    const spec = this.host.specs.get(index);
    if (spec && spec.width > 0 && spec.height > 0) {
      const w = Math.min(width, spec.width);
      try {
        const frame = await (await manager.grpc(index)).getScreenshot({ format: 'png', width: w, height: heightFor(w, spec) }, CAPTURE_TIMEOUT_MS);
        if (frame.format === 'png' && pngSize(frame.data).width > 0) return frame.data;
      } catch {
        // fall back below
      }
    }
    return manager.screenshot(index, { width });
  }
}

function isShown(wc: WebContents): boolean {
  const win = BrowserWindow.fromWebContents(wc);
  return !!win && !win.isDestroyed() && win.isVisible() && !win.isMinimized();
}
