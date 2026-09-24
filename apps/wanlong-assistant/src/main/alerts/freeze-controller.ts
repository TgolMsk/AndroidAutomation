/**
 * Freeze watchdog wiring (port of `tryFreezeRecovery` and friends from the original `src/main/index.ts`).
 *
 * The verdicts (FreezeGuard) and the recovery flow (recoverFrozenInstance) are pure and live in
 * `@avdm/automation/wanlong`; this controller only connects them:
 *   · every sampler / health-probe frame and capture failure feeds the guard (scheduler hooks)
 *   · two triggers: the health probe (full threshold, default 5 minutes unchanged) and 「consecutive sample failures,
 *     about to pause as offline」 (degraded gate). Both run inside the scheduler's instance lock; the restart goes
 *     through `exclusive()`, which re-enters there
 *   · success → an 「模拟器卡死已自动重启」 warning (no pause), failure counters cleared, scheduling goes on
 *   · failure / circuit breaker → the offline pause, the reason naming the stage that failed
 * ★ DECISIONS A.3: automatic restart is an explicit opt-in (`freezeRestartEnabled`, default off). Off, a verdict on
 *   the health-probe path only raises 「疑似模拟器卡死」 (once per frozen stretch) and never touches the emulator.
 * ★ Never `setAuto(true)` in here (it would wait for the lock this runs in). Recovery aborts on shutdown and when
 *   the instance's automatic schedule is switched off (the hook's signal).
 */
import type { RawFrame } from '@avdm/automation';
import {
  FREEZE_STAGE_TEXT, FreezeGuard, recoverFrozenInstance, type FreezeRecoveryIo, type FreezeRecoveryResult,
  type FreezeVerdict,
} from '@avdm/automation/wanlong';
import { makeAlertEvent, type AlertDetectConfig, type AlertEvent } from '../../shared/alerts';
import type { FreezeInstanceStatus } from '../../shared/ipc/alerts';
import type { AlertLogLevel } from './notifier';

export type FreezeAttempt =
  | { outcome: 'recovered' }
  | { outcome: 'skipped' }
  /** Judged frozen and restarted (or the breaker tripped) without success: `note` goes into the offline alert. */
  | { outcome: 'failed'; note: string }
  /** Judged frozen with automatic restart off: `note` goes into the offline alert. */
  | { outcome: 'detected'; note: string };

export interface FreezeControllerPorts {
  config(): AlertDetectConfig;
  isPaused(index: number): boolean;
  /**
   * Whether the emulator process is still alive (AVD `running`, or `booting` with a pid — a frozen guest can read as
   * booting to a fresh manager). A dead or crashed instance is not a freeze: the offline path owns it.
   */
  instanceAlive(index: number): Promise<{ alive: boolean; status: string; identity?: string | null }>;
  /** `EtaScheduler.exclusive` (re-enters from a hook in the lock). */
  exclusive<T>(index: number, what: string, fn: (ctx: { signal: AbortSignal }) => Promise<T>, signal?: AbortSignal): Promise<T>;
  /** The AVD recovery adapter for one attempt (see `freeze-io.ts`). */
  recoveryIo(index: number, signal: AbortSignal): FreezeRecoveryIo;
  /** Keep a scene shot under the app's shot policy; resolves to the relative path or null. Never throws. */
  saveShot(index: number, label: string, raw: RawFrame): Promise<string | null>;
  /** Raise an alert from inside the lock (the pause is awaited, the push is not). Never throws. */
  raise(event: AlertEvent): Promise<void>;
  /** Clear the failure counters after a successful recovery. */
  resetFailures(index: number): void;
  log(level: AlertLogLevel, message: string, index?: number): void;
  gamePackage: string;
  now?(): number;
  /** Test seam: the recovery flow. */
  recover?: typeof recoverFrozenInstance;
}

export class FreezeController {
  readonly guard: FreezeGuard;
  /** Each instance's latest frame: the 「纹丝不动」 evidence shot is saved from it before the restart. */
  private readonly lastFrames = new Map<number, RawFrame>();
  /** One recovery per instance at a time. */
  private readonly recovering = new Set<number>();
  /** Start of the frozen stretch already reported while auto restart is off (one alert per stretch). */
  private readonly reported = new Map<number, number>();
  /** AVD identity last seen per index (a new AVD forgets the old restart history). */
  private readonly identities = new Map<number, string>();
  private readonly shutdown = new AbortController();

  constructor(private readonly ports: FreezeControllerPorts) {
    this.guard = new FreezeGuard({
      config: () => ports.config(),
      log: (level, message) => ports.log(level, message),
      ...(ports.now ? { now: () => ports.now!() } : {}),
    });
  }

  private now(): number {
    return this.ports.now ? this.ports.now() : Date.now();
  }

  /** Scheduler hook `onFrameCaptured` (synchronous, in lock). Never throws. */
  onFrame(index: number, raw: RawFrame): void {
    try {
      this.lastFrames.set(index, raw);
      this.guard.observe(index, raw);
    } catch (error) {
      this.ports.log('warn', `[卡死][实例 #${index}] 记录画面失败（已忽略）：${messageOf(error)}`, index);
    }
  }

  /** Scheduler hook `onCaptureFailed` (synchronous, in lock). Never throws. */
  onCaptureFailed(index: number, message: string): void {
    try { this.guard.noteCaptureFailed(index, message); } catch { /* Evidence only. */ }
  }

  /** The instance was deleted or replaced: forget its evidence and restart history. */
  forget(index: number): void {
    this.guard.forget(index);
    this.lastFrames.delete(index);
    this.reported.delete(index);
  }

  /** Read-only evidence per instance for the settings card. */
  status(): FreezeInstanceStatus[] {
    return this.guard.indices().map((index) => {
      const evidence = this.guard.evidence(index);
      const budget = this.guard.restartBudget(index);
      return {
        index, ...evidence, restartsUsed: budget.used, restartLimit: budget.limit, restartWindowMin: budget.windowMin,
        recovering: this.recovering.has(index),
      };
    });
  }

  isRecovering(index: number): boolean {
    return this.recovering.has(index);
  }

  /** Abort every recovery in flight (quitting), so shutdown never waits minutes. */
  dispose(): void {
    this.shutdown.abort(new Error('助手正在退出'));
  }

  /**
   * Judge and, when allowed, restart. Must be called inside the scheduler's instance lock (both triggers are).
   * @param strict true = health-probe path (full threshold); false = samples are already failing (degraded gate).
   */
  async tryRecover(index: number, trigger: string, signal: AbortSignal | undefined, strict: boolean): Promise<FreezeAttempt> {
    const cfg = this.ports.config();
    if (this.ports.isPaused(index) || this.recovering.has(index)) return { outcome: 'skipped' };
    const verdict = strict ? this.guard.assess(index) : this.guard.assessAfterFailures(index);
    if (!verdict) return { outcome: 'skipped' };
    const tag = `[卡死][实例 #${index}]`;

    // Precondition: the emulator process is still there. A dead one is not frozen (maybe the user closed it).
    let alive: { alive: boolean; status: string; identity?: string | null };
    try { alive = await this.ports.instanceAlive(index); }
    catch (error) { this.ports.log('warn', `${tag} 读取实例状态失败，不按卡死处理：${messageOf(error)}`, index); return { outcome: 'skipped' }; }
    if (alive.identity) {
      // A recreated AVD at this index starts with a clean restart history (its evidence was fed by the new one).
      const known = this.identities.get(index);
      this.identities.set(index, alive.identity);
      if (known && known !== alive.identity) {
        this.forget(index);
        this.ports.log('info', `${tag} 实例已被替换，卡死证据与重启记录已清空，本次不做判定。`, index);
        return { outcome: 'skipped' };
      }
    }
    if (!alive.alive) {
      this.ports.log('info', `${tag} ${verdict.reason}，但实例状态是「${alive.status}」而不是运行中，不按卡死处理。`, index);
      return { outcome: 'skipped' };
    }

    if (!cfg.freezeRestartEnabled) return this.detectOnly(index, verdict, trigger, strict);

    const budget = this.guard.restartBudget(index);
    if (!budget.allowed) {
      const note = `${verdict.reason}，判定模拟器卡死；但 ${budget.windowMin} 分钟内已自动重启 ${budget.used} 次（上限 ${budget.limit}），不再重启。`;
      this.ports.log('warn', `${tag} ${note}`, index);
      if (strict) await this.raiseFrozenOffline(index, note);
      return { outcome: 'failed', note };
    }

    const shotPath = await this.saveFrozenShot(index);
    this.ports.log('warn', `${tag} ${verdict.reason}（触发：${trigger}），判定模拟器卡死，开始第 ${budget.used + 1}/${budget.limit} 次自动重启。`, index);
    // ★ Counted as soon as the restart is issued: a failed restart counts even more.
    this.guard.noteRestart(index);
    this.recovering.add(index);
    const startedAt = this.now();
    const combined = signal ? AbortSignal.any([signal, this.shutdown.signal]) : this.shutdown.signal;
    try {
      const recover = this.ports.recover ?? recoverFrozenInstance;
      const result: FreezeRecoveryResult = await this.ports.exclusive(index, '卡死重启', ({ signal: lockSignal }) =>
        recover(this.ports.recoveryIo(index, AbortSignal.any([combined, lockSignal])), { gamePackage: this.ports.gamePackage }), combined);
      if (result.ok) {
        const seconds = Math.round(result.elapsedMs / 1000);
        this.ports.log('info', `${tag} 自动重启完成（${result.steps.join(' → ')}，耗时 ${seconds}s），自动调度继续。`, index);
        this.ports.resetFailures(index);
        await this.ports.raise(makeAlertEvent({
          type: 'emulatorFrozen', instanceIndex: index, shotPath, at: this.now(),
          reason: `${verdict.reason}，判定模拟器卡死。已自动重启实例并重新拉起游戏（${result.steps.join(' → ')}，耗时 ${seconds}s），自动调度继续。`,
          detail: {
            触发: trigger,
            主界面: result.loaded ? '已认出' : '尚未认出，交给采样时的弹窗阶梯',
            本窗口重启次数: `${budget.used + 1}/${budget.limit}`,
          },
        }));
        return { outcome: 'recovered' };
      }
      const stage = result.stage === 'done' ? '收尾' : FREEZE_STAGE_TEXT[result.stage];
      const note = `${verdict.reason}，判定模拟器卡死；自动重启失败（卡在：${stage}）：${result.reason ?? '原因未知'}`;
      this.ports.log('error', `${tag} ${note}`, index);
      if (strict) await this.raiseFrozenOffline(index, note, shotPath);
      return { outcome: 'failed', note };
    } catch (error) {
      if (combined.aborted || codeOf(error) === 'RUN_ABORTED') {
        this.ports.log('warn', `${tag} 自动重启被中止（自动调度已关闭或助手正在退出）。`, index);
        return { outcome: 'skipped' };
      }
      const note = `${verdict.reason}，判定模拟器卡死；自动重启过程出错：${messageOf(error)}`;
      this.ports.log('error', `${tag} ${note}`, index);
      if (strict) await this.raiseFrozenOffline(index, note, shotPath);
      return { outcome: 'failed', note };
    } finally {
      this.recovering.delete(index);
      // Whatever happened, the picture timing starts over: the first frame after a restart is never compared with
      // the frozen one.
      this.guard.reset(index);
      this.reported.delete(index);
      this.ports.log('debug', `${tag} 恢复流程结束，耗时 ${Math.round((this.now() - startedAt) / 1000)}s。`, index);
    }
  }

  /** Auto restart off: say it once per frozen stretch (health-probe path); the degraded path adds a note. */
  private async detectOnly(index: number, verdict: FreezeVerdict, trigger: string, strict: boolean): Promise<FreezeAttempt> {
    const note = `${verdict.reason}，疑似模拟器卡死（没有开启「卡死自动重启」，不会自动重启）。`;
    if (!strict) return { outcome: 'detected', note };
    const stretch = this.now() - verdict.sinceMs;
    const already = this.reported.get(index);
    if (already !== undefined && Math.abs(already - stretch) < 1_000) return { outcome: 'detected', note };
    this.reported.set(index, stretch);
    const shotPath = await this.saveFrozenShot(index);
    this.ports.log('warn', `[卡死][实例 #${index}] ${note}（触发：${trigger}）`, index);
    await this.ports.raise(makeAlertEvent({
      type: 'suspectedFreeze', instanceIndex: index, shotPath, at: this.now(),
      reason: note,
      detail: { 触发: trigger, 判据: verdict.kind === 'static' ? '画面不动' : '截图失败', 持续分钟: Math.round(verdict.sinceMs / 60_000) },
    }));
    return { outcome: 'detected', note };
  }

  /** The health-probe path has no event of its own: an unrecovered freeze pauses as offline here. */
  private async raiseFrozenOffline(index: number, note: string, shotPath?: string | null): Promise<void> {
    if (this.ports.isPaused(index)) return;
    await this.ports.raise(makeAlertEvent({
      type: 'deviceOffline', instanceIndex: index, at: this.now(),
      reason: `${note} 请手动重启模拟器并把游戏拉起来后点「恢复」。`,
      shotPath: shotPath ?? await this.saveFrozenShot(index),
      detail: { 判定: '卡死', 自动重启: '未能恢复' },
    }));
  }

  /** The last 「纹丝不动」 frame as evidence (shot policy applies); never blocks the restart. */
  private async saveFrozenShot(index: number): Promise<string | null> {
    const raw = this.lastFrames.get(index);
    if (!raw) return null;
    try { return await this.ports.saveShot(index, 'frozen', raw); }
    catch (error) {
      this.ports.log('warn', `[卡死][实例 #${index}] 留痕失败（不影响重启）：${messageOf(error)}`, index);
      return null;
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : '';
}
