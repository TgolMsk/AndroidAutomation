/**
 * 「画面巡检」: the freeze watchdog's own look at the screen, once a minute, for every instance under automatic scheduling.
 *
 * The watchdog (FreezeController / FreezeGuard) only judged frames the scheduler happened to capture — samples and health
 * probes. After a failed sample the scheduler waits on its back-off ladder (up to 5 minutes, no health probe in between),
 * so on 2026-09-25 03:25 a game whose render thread had stopped (a gfxstream fence fd leak; no ANR, the picture simply
 * stood still) was judged only at the third failed sample, 13 minutes later, and then paused instead of being restarted.
 * This watch bounds that delay at about `freezeMinutes`:
 *   · every SCREEN_WATCH_INTERVAL_MS: one read-only frame per target instance, taken inside the instance lock (`exclusive`,
 *     like a health probe: it queues behind a running sample and is refused while a script or a login holds the
 *     instance), and only with the game in the foreground (another app in front is the health probe's case)
 *   · the frame feeds the same FreezeGuard evidence, then the health probe's verdict runs (`tryRecover(strict)`, the full
 *     threshold): with the emulator restart off it restarts the game first, else says 「疑似模拟器卡死」 once per stretch
 * Paused instances, one in recovery and one whose previous look is still waiting for the lock are skipped. Never throws.
 */
import type { RawFrame } from '@avdm/automation';
import type { AlertLogLevel } from './notifier';

export const SCREEN_WATCH_INTERVAL_MS = 60_000;

export interface ScreenWatchPorts {
  /** Instances to look at now: automatic scheduling on (while this process owns the scheduler). */
  targets(): number[];
  /** Leave the instance alone this round (paused, a freeze or game restart in progress). */
  skip(index: number): boolean;
  /** `EtaScheduler.exclusive`. */
  exclusive<T>(index: number, what: string, fn: (ctx: { signal: AbortSignal }) => Promise<T>, signal?: AbortSignal): Promise<T>;
  /** One read-only frame with the game in the foreground; throws otherwise (another app in front, not running). */
  capture(index: number): Promise<RawFrame>;
  /** `FreezeController.onFrame`: the frame joins the evidence. */
  observe(index: number, raw: RawFrame): void;
  /** `FreezeController.tryRecover(index, …, signal, true)`: the health probe's verdict and what follows it. */
  judge(index: number, signal: AbortSignal): Promise<unknown>;
  log(level: AlertLogLevel, message: string, index?: number): void;
  intervalMs?: number;
}

export class ScreenWatch {
  private timer: NodeJS.Timeout | undefined;
  /** Instances whose look is in flight (waiting for the lock or judging): a round never stacks a second one. */
  private readonly looking = new Set<number>();
  /** Last reason a look was skipped, per instance: the debug log says it once, not every minute. */
  private readonly lastSkip = new Map<number, string>();
  private readonly shutdown = new AbortController();

  constructor(private readonly ports: ScreenWatchPorts) {}

  start(): void {
    if (this.timer || this.shutdown.signal.aborted) return;
    this.timer = setInterval(() => { void this.tick(); }, this.ports.intervalMs ?? SCREEN_WATCH_INTERVAL_MS);
    this.timer.unref?.();
  }

  /** Stop the timer and abort a look that waits for the lock (quitting). */
  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.shutdown.abort(new Error('助手正在退出'));
  }

  /** One round (the timer's; tests call it directly). Resolves once every look it started has finished. */
  async tick(): Promise<void> {
    if (this.shutdown.signal.aborted) return;
    let targets: number[];
    try { targets = this.ports.targets(); }
    catch (error) {
      this.ports.log('debug', `[卡死] 画面巡检读不到自动调度中的实例（本轮跳过）：${messageOf(error)}`);
      return;
    }
    const looks: Array<Promise<void>> = [];
    for (const index of targets) {
      if (this.looking.has(index) || this.ports.skip(index)) continue;
      this.looking.add(index);
      looks.push(this.look(index).finally(() => this.looking.delete(index)));
    }
    await Promise.all(looks);
  }

  private async look(index: number): Promise<void> {
    try {
      await this.ports.exclusive(index, '画面巡检', async ({ signal }) => {
        const raw = await this.ports.capture(index);
        if (signal.aborted) return;
        this.ports.observe(index, raw);
        this.lastSkip.delete(index);
        await this.ports.judge(index, signal);
      }, this.shutdown.signal);
    } catch (error) {
      if (this.shutdown.signal.aborted) return;
      // A script or a login holds the instance, the game is not in front, adb hiccuped: nothing to judge this round.
      const reason = messageOf(error);
      if (this.lastSkip.get(index) === reason) return;
      this.lastSkip.set(index, reason);
      this.ports.log('debug', `[卡死][实例 #${index}] 画面巡检本轮跳过：${reason}`, index);
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
