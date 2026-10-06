/**
 * 「异常时自动重启游戏（顶号除外）」 — the user's request 「当出现非挤号情况自动重启应用」.
 *
 * The emulator is fine but the game is not: stuck on a screen the flows cannot recognise, the system's 「isn't
 * responding」 dialog (ANR — on 2026-09-24 a guest GPU driver deadlock left one spinning for four hours), a picture
 * frozen for minutes, or a crash. Instead of pausing and waiting for a human, force-stop the game and launch it again
 * (the pure flow `restartStuckGame` in @avdm/automation/wanlong); scheduling goes on. The AlertsService decides when
 * (its hooks, see index.ts); this controller runs one restart:
 *   · preconditions: the switch is on, the instance is not paused and is running (Android up), within the budget
 *   · inside `exclusive()` (re-enters from a hook in the lock): a fresh frame goes through the layer-2 probe FIRST — a
 *     kicked / login / maintenance / update screen is never restarted over (the auto-login would push the other
 *     device off); the hit goes back to the caller as a verdict
 *   · budget: `gameRestartLimit` restarts per `gameRestartWindowMin`, counted once the restart was issued (a failed one
 *     too); beyond it the caller pauses as before, with a note
 *   · success → failure counters and freeze evidence cleared, one 「游戏异常已自动重启」 warning (no pause)
 * ★ Never `setAuto(true)` in here (it would wait for the lock this runs in). Aborts with the hook's signal (automatic
 *   schedule switched off) and on shutdown. Never throws.
 */
import type { RawFrame } from '@avdm/automation';
import {
  GAME_RESTART_STAGE_TEXT, restartStuckGame, type GameRestartIo, type GameRestartResult, type KickedProbeResult,
} from '@avdm/automation/wanlong';
import { makeAlertEvent, type AlertDetectConfig, type AlertEvent } from '../../shared/alerts';
import type { AlertLogLevel } from './notifier';

export type GameRestartAttempt =
  | { outcome: 'recovered' }
  /** Switched off, not wired, paused, already restarting, the emulator not running: the caller goes on as before. */
  | { outcome: 'skipped' }
  /** Restarted without success, or over the budget: `note` goes into the pause the caller raises. */
  | { outcome: 'failed'; note: string; shotPath: string | null }
  /**
   * A kicked / login / maintenance / update screen — `before`: nothing was restarted; else the game came back to it.
   * The caller raises it as the layer-2 verdict instead of its own event.
   */
  | { outcome: 'verdict'; verdict: KickedProbeResult; shotPath: string | null; before: boolean };

export interface GameRestartBudget {
  allowed: boolean;
  used: number;
  limit: number;
  windowMin: number;
}

export interface GameRestartControllerPorts {
  config(): AlertDetectConfig;
  isPaused(index: number): boolean;
  /** The emulator's state: only a running instance (Android up) gets its game restarted. */
  instanceAlive(index: number): Promise<{ alive: boolean; status: string; identity?: string | null }>;
  /** `EtaScheduler.exclusive` (re-enters from a hook in the lock). */
  exclusive<T>(index: number, what: string, fn: (ctx: { signal: AbortSignal }) => Promise<T>, signal?: AbortSignal): Promise<T>;
  /** The device side of one restart. Missing → the game is never restarted. */
  restartIo?(index: number, signal: AbortSignal): GameRestartIo;
  /** Keep a scene shot under the app's shot policy; resolves to the relative path or null. Never throws. */
  saveShot(index: number, label: string, raw: RawFrame): Promise<string | null>;
  /** Raise an alert from inside the lock (the pause is awaited, the push is not). Never throws. */
  raise(event: AlertEvent): Promise<void>;
  /** After a successful restart: the failure counters and the freeze evidence start afresh. */
  resetEvidence(index: number): void;
  log(level: AlertLogLevel, message: string, index?: number): void;
  gamePackage: string;
  now?(): number;
  /** Test seam: the flow. */
  restart?: typeof restartStuckGame;
}

export class GameRestartController {
  /** When restarts were issued, per instance (the budget window). */
  private readonly restarts = new Map<number, number[]>();
  /** One restart per instance at a time. */
  private readonly restarting = new Set<number>();
  /** AVD identity last seen per index (a new AVD forgets the old restarts). */
  private readonly identities = new Map<number, string>();
  private readonly shutdown = new AbortController();

  constructor(private readonly ports: GameRestartControllerPorts) {}

  private now(): number {
    return this.ports.now ? this.ports.now() : Date.now();
  }

  /** Whether the switch is on and the device side is wired (callers skip their own checks otherwise). */
  enabled(): boolean {
    return Boolean(this.ports.restartIo) && this.ports.config().gameRestartEnabled;
  }

  isRestarting(index: number): boolean {
    return this.restarting.has(index);
  }

  /** Restarts used in the current window. */
  budget(index: number): GameRestartBudget {
    const cfg = this.ports.config();
    const limit = Math.max(1, cfg.gameRestartLimit);
    const windowMin = Math.max(1, cfg.gameRestartWindowMin);
    const floor = this.now() - windowMin * 60_000;
    const kept = (this.restarts.get(index) ?? []).filter((at) => at > floor);
    this.restarts.set(index, kept);
    return { allowed: kept.length < limit, used: kept.length, limit, windowMin };
  }

  /** The instance was deleted or replaced: forget its restarts. */
  forget(index: number): void {
    this.restarts.delete(index);
    this.identities.delete(index);
  }

  /** Abort every restart in flight (quitting), so shutdown never waits minutes. */
  dispose(): void {
    this.shutdown.abort(new Error('助手正在退出'));
  }

  /**
   * Restart the game of a running instance when allowed. Must be called inside the scheduler's instance lock (every
   * trigger is a hook in it). @param trigger Chinese cause for logs and the alert, e.g.「连续采样失败」.
   */
  async tryRestart(index: number, trigger: string, signal: AbortSignal | undefined): Promise<GameRestartAttempt> {
    if (!this.enabled() || this.ports.isPaused(index) || this.restarting.has(index)) return { outcome: 'skipped' };
    const tag = `[重启游戏][实例 #${index}]`;
    let alive: { alive: boolean; status: string; identity?: string | null };
    try { alive = await this.ports.instanceAlive(index); }
    catch (error) {
      this.ports.log('warn', `${tag} 读取实例状态失败，不重启游戏：${messageOf(error)}`, index);
      return { outcome: 'skipped' };
    }
    if (alive.identity) {
      const known = this.identities.get(index);
      this.identities.set(index, alive.identity);
      if (known && known !== alive.identity) {
        this.restarts.delete(index);
        this.ports.log('info', `${tag} 实例已被替换，之前的重启记录已清空。`, index);
      }
    }
    // A stopped or booting emulator is the offline path's (a game restart cannot help it).
    if (alive.status !== 'running') {
      this.ports.log('info', `${tag} ${trigger}，但实例状态是「${alive.status}」而不是运行中，不重启游戏。`, index);
      return { outcome: 'skipped' };
    }
    const budget = this.budget(index);
    if (!budget.allowed) {
      const note = `${budget.windowMin} 分钟内已自动重启游戏 ${budget.used} 次（上限 ${budget.limit}），这次不再重启。`;
      this.ports.log('warn', `${tag} ${trigger}；${note}`, index);
      return { outcome: 'failed', note, shotPath: null };
    }

    const combined = signal ? AbortSignal.any([signal, this.shutdown.signal]) : this.shutdown.signal;
    this.restarting.add(index);
    const startedAt = this.now();
    try {
      const restart = this.ports.restart ?? restartStuckGame;
      const result = await this.ports.exclusive(index, '重启游戏', ({ signal: lockSignal }) => {
        this.ports.log('warn', `${tag} ${trigger}，先确认不是顶号，再做第 ${budget.used + 1}/${budget.limit} 次自动重启游戏。`, index);
        return restart(this.ports.restartIo!(index, AbortSignal.any([combined, lockSignal])), { gamePackage: this.ports.gamePackage });
      }, combined);
      // ★ Counted once issued (a failed restart counts even more); a screen that stopped it beforehand is not a restart.
      if (!(result.verdict && result.stage === 'check')) this.noteRestart(index);
      return await this.conclude(index, trigger, result, budget);
    } catch (error) {
      if (combined.aborted || codeOf(error) === 'RUN_ABORTED') {
        this.ports.log('warn', `${tag} 自动重启游戏被中止（自动调度已关闭或助手正在退出）。`, index);
        return { outcome: 'skipped' };
      }
      this.noteRestart(index);
      const note = `自动重启游戏时出错：${messageOf(error)}`;
      this.ports.log('error', `${tag} ${note}`, index);
      return { outcome: 'failed', note, shotPath: null };
    } finally {
      this.restarting.delete(index);
      this.ports.log('debug', `${tag} 重启流程结束，耗时 ${Math.round((this.now() - startedAt) / 1000)}s。`, index);
    }
  }

  private noteRestart(index: number): void {
    const list = this.restarts.get(index) ?? [];
    list.push(this.now());
    this.restarts.set(index, list);
  }

  private async conclude(index: number, trigger: string, result: GameRestartResult, budget: GameRestartBudget): Promise<GameRestartAttempt> {
    const tag = `[重启游戏][实例 #${index}]`;
    if (result.verdict) {
      const shotPath = result.frame ? await this.saveShot(index, 'kicked', result.frame) : null;
      return { outcome: 'verdict', verdict: result.verdict, shotPath, before: result.stage === 'check' };
    }
    const steps = result.steps.join(' → ');
    const seconds = Math.round(result.elapsedMs / 1000);
    if (result.ok) {
      this.ports.resetEvidence(index);
      this.ports.log('info', `${tag} 自动重启游戏完成（${steps}，耗时 ${seconds}s），自动调度继续。`, index);
      const shotPath = result.before ? await this.saveShot(index, 'game-restart', result.before) : null;
      await this.ports.raise(makeAlertEvent({
        type: 'gameRestarted', instanceIndex: index, shotPath, at: this.now(),
        reason: `${trigger}。确认不是顶号后已强制重启游戏（${steps}，耗时 ${seconds}s），自动调度继续。`,
        detail: {
          触发: trigger,
          主界面: result.loaded ? '已认出' : '尚未认出，交给采样时的弹窗阶梯',
          本窗口重启次数: `${budget.used + 1}/${budget.limit}`,
        },
      }));
      return { outcome: 'recovered' };
    }
    const stage = result.stage === 'done' ? '收尾' : GAME_RESTART_STAGE_TEXT[result.stage];
    const note = `已自动重启游戏，但没能恢复（卡在：${stage}）：${result.reason ?? '原因未知'}`;
    this.ports.log('error', `${tag} ${note}`, index);
    const scene = result.frame ?? result.before;
    return { outcome: 'failed', note, shotPath: scene ? await this.saveShot(index, 'game-restart', scene) : null };
  }

  private async saveShot(index: number, label: string, raw: RawFrame): Promise<string | null> {
    try { return await this.ports.saveShot(index, label, raw); }
    catch (error) {
      this.ports.log('warn', `[重启游戏][实例 #${index}] 现场截图没能保存（不影响重启）：${messageOf(error)}`, index);
      return null;
    }
  }
}

/** The part of an `AdbDevice` a game restart uses (lane-bound in the app). */
export interface GameRestartDevice {
  screencapRaw(): Promise<RawFrame>;
  /** `am force-stop <pkg>` */
  stopApp(pkg: string): Promise<void>;
  /** ★ Without an activity this is `monkey -p <pkg> -c LAUNCHER 1`: the only launch that works for this game. */
  startApp(pkg: string): Promise<void>;
  foregroundPackage(): Promise<string | undefined>;
  isAppRunning(pkg: string): Promise<boolean>;
}

export interface GameRestartIoOptions {
  /** The lane-bound device of the instance (`deviceHost.get()` → `device(index)`). */
  device(): Promise<GameRestartDevice>;
  signal: AbortSignal;
  gamePackage: string;
  /** Known-screen check on the instance's cached templates (`AutomationHost.recognizeScreen`). */
  recognize(raw: RawFrame, signal: AbortSignal): Promise<boolean>;
  /** The alerts module's layer-2 probe (null when off, missing templates or no hit). */
  kicked(raw: RawFrame): Promise<KickedProbeResult | null>;
  log(level: 'debug' | 'info' | 'warn', message: string): void;
}

const PACKAGE_SHAPE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;

/** `GameRestartIo` on the Android Emulator (@avdm/core): only the game's own package is ever stopped or launched. */
export function createGameRestartIo(options: GameRestartIoOptions): GameRestartIo {
  const { gamePackage, signal } = options;
  if (!PACKAGE_SHAPE.test(gamePackage)) throw new Error('游戏包名无效');
  // The emulator keeps running (only the game restarts), so one device lookup serves the whole restart; a failed
  // lookup is not kept, the next call asks again.
  let device: Promise<GameRestartDevice> | null = null;
  const dev = (): Promise<GameRestartDevice> => {
    if (!device) {
      const pending = options.device();
      device = pending;
      pending.catch(() => { if (device === pending) device = null; });
    }
    return device;
  };
  return {
    capture: async () => (await dev()).screencapRaw(),
    recognize: (raw) => options.recognize(raw, signal),
    kicked: (raw) => options.kicked(raw),
    stopGame: async () => (await dev()).stopApp(gamePackage),
    launchGame: async () => (await dev()).startApp(gamePackage),
    foreground: async () => (await (await dev()).foregroundPackage()) ?? null,
    isGameRunning: async () => (await dev()).isAppRunning(gamePackage),
    log: options.log,
    signal,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : '';
}
