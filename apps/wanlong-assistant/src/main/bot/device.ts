/**
 * The bot's device side on the Android Emulator (@avdm/core), replacing the original MuMu wiring in `index.ts`
 * (`captureShotForBot`, `recoverGame`). Both run inside `EtaScheduler.exclusive()` (the action layer takes the lock);
 * nothing here locks.
 *
 *   captureShot   screencap → JPEG (≤ 1280 wide, q70, encoded in a worker) + foreground package + game process (pidof).
 *                 ★ Taken whatever is in front (original behaviour): a desktop or a crash is exactly what the user wants
 *                 to see; the caption says 「★ 不是游戏：pkg」.
 *   recoverGame   the kicked / network sequence of `@avdm/automation/wanlong` `recoverGame()` with this app's gates:
 *                 dialogs are matched on the instance's cached templates (vision worker, read-only query; a missing
 *                 template skips its step), every tap re-reads the foreground on the device lane and refuses anything
 *                 but the game, and the only launch is monkey for the game's own package.
 * Device objects come from the lane-bound manager (`DeviceLanes.host`), so every adb call queues on the instance's lane.
 */
import type { MatchResult, RawFrame } from '@avdm/automation';
import { recoverGame, type GameRecoveryIo, type RecoverKickedHit } from '@avdm/automation/wanlong';
import { probeKickedFrame } from '../alerts/kicked';
import { BotActionError, type BotCaptureResult } from './actions';

/** The part of an `AdbDevice` the bot uses. */
export interface BotDevicePort {
  screencapRaw(): Promise<RawFrame>;
  foregroundPackage(): Promise<string | undefined>;
  isAppRunning(pkg: string): Promise<boolean>;
  /** ★ Without an activity: `monkey -p <pkg> -c LAUNCHER 1`, the only launch that works for this game. */
  startApp(pkg: string): Promise<void>;
  tap(x: number, y: number): Promise<void>;
}

/** The part of core's `AvdManager` the bot uses. */
export interface BotManagerPort {
  getState(index: number): Promise<{ status: string }>;
  device(index: number): Promise<BotDevicePort>;
}

export interface BotDeviceOptions {
  /** The lane-bound manager (`deviceHost.get()`). */
  manager(): Promise<BotManagerPort>;
  gamePackage: string;
  /** Reference canvas of the game's coordinates (2560×1440). */
  referenceSize: { width: number; height: number };
  /** A check-then-act unit on the instance's device lane (`DeviceLanes.run`). */
  lane<T>(index: number, work: () => Promise<T>): Promise<T>;
  /** Frame → JPEG (a worker-backed encoder at the bot's width and quality). */
  encode(frame: RawFrame): Promise<{ jpeg: Uint8Array }>;
  /** Template matches on a held frame with the instance's cached templates (missing → found: false). */
  matchTemplates(index: number, raw: RawFrame, templateIds: string[]): Promise<MatchResult[]>;
  log(level: 'debug' | 'info' | 'warn', message: string, index?: number): void;
  sleep?(ms: number, signal?: AbortSignal): Promise<void>;
}

const PACKAGE_SHAPE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const timer = setTimeout(done, ms);
    timer.unref?.();
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class BotDevice {
  constructor(private readonly options: BotDeviceOptions) {
    if (!PACKAGE_SHAPE.test(options.gamePackage)) throw new Error('游戏包名无效');
  }

  private async runningDevice(index: number, what: string): Promise<BotDevicePort> {
    const manager = await this.options.manager();
    const state = await manager.getState(index);
    if (state.status !== 'running') {
      throw new BotActionError('DEVICE_NOT_READY', `实例 ${index} 尚未就绪（当前：${state.status}），没法${what}。请先启动它并等 Android 启动完成。`);
    }
    return manager.device(index);
  }

  /** The bot's 「📷 截图」. Never taps. */
  async captureShot(index: number): Promise<BotCaptureResult> {
    const device = await this.runningDevice(index, '截图');
    let raw: RawFrame;
    try { raw = await device.screencapRaw(); }
    catch (error) { throw new BotActionError('CAPTURE_FAILED', `ADB 截图失败：${messageOf(error)}`); }
    let foreground: string | null = null;
    let gameRunning: boolean | null = null;
    try { foreground = (await device.foregroundPackage()) ?? null; } catch { foreground = null; }
    try { gameRunning = await device.isAppRunning(this.options.gamePackage); } catch { gameRunning = null; }
    const { jpeg } = await this.options.encode(raw);
    return { jpeg, at: raw.capturedAt || Date.now(), foreground, gameRunning };
  }

  /** The 「重启游戏并恢复」 sequence (without the resume, which the action layer does outside the lock). */
  async recoverGame(index: number, signal?: AbortSignal): Promise<string> {
    const { gamePackage, referenceSize } = this.options;
    const device = await this.runningDevice(index, '重启游戏');
    const log = (level: 'debug' | 'info' | 'warn', message: string): void => this.options.log(level, `[重启游戏][实例 #${index}] ${message}`, index);
    let lastFrame: { width: number; height: number } | null = null;
    const io: GameRecoveryIo = {
      gamePackage,
      ...(signal ? { signal } : {}),
      log,
      capture: async () => {
        const raw = await device.screencapRaw();
        lastFrame = { width: raw.width, height: raw.height };
        return raw;
      },
      kicked: async (raw): Promise<RecoverKickedHit | null> => {
        const hit = await probeKickedFrame((ids) => this.options.matchTemplates(index, raw, ids), (level, message) => log(level, message));
        if (!hit) return null;
        const templateId = hit.detail['命中模板'];
        return typeof templateId === 'string'
          ? { templateId, type: hit.type === 'suspectedKicked' ? 'suspectedKicked' : 'needsAttention', reason: hit.reason }
          : null;
      },
      seen: async (templateId, raw) => {
        try {
          return (await this.options.matchTemplates(index, raw, [templateId])).some((result) => result.templateId === templateId && result.found);
        } catch (error) {
          // No template set / worker trouble: no conclusion, so that step is skipped (never a blind tap).
          log('debug', `没能匹配 ${templateId}（跳过这一步）：${messageOf(error)}`);
          return false;
        }
      },
      tapRef: async (point) => {
        const frame = lastFrame;
        if (!frame) throw new BotActionError('STEP_FAILED', '还没有截到画面，不能点击。');
        const x = Math.round(point.x * frame.width / referenceSize.width);
        const y = Math.round(point.y * frame.height / referenceSize.height);
        // ★ One unit on the lane: the foreground is re-read right before the tap, and only the game is ever tapped.
        await this.options.lane(index, async () => {
          const foreground = (await device.foregroundPackage()) ?? null;
          if (foreground !== gamePackage) throw new BotActionError('STEP_FAILED', `前台不是游戏（${foreground ?? '未知'}），为安全起见没有点击。`);
          await device.tap(x, y);
        });
      },
      isGameRunning: () => device.isAppRunning(gamePackage),
      launchGame: () => device.startApp(gamePackage),
      foreground: async () => (await device.foregroundPackage()) ?? null,
      sleep: (ms) => (this.options.sleep ?? abortableSleep)(ms, signal),
    };
    return recoverGame(io);
  }
}
