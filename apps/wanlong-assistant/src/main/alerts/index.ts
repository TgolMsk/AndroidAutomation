/**
 * The alerts module (anomaly detection, automatic pauses, notifications, freeze watchdog) as one service with ports.
 * Built in `src/main/index.ts` (`// ── alerts / freeze ──`), which plugs `schedulerHooks()` into the ETA scheduler and
 * `hostHooks()` / `probeKicked` into the automation host. See ./README.md.
 *
 *   FailureTracker  (detect.ts)            counts only: failed cycles, exhausted recovery ladders, failed samples, stalls
 *   AlertCenter     (center.ts)            acts only: pause, pause records, history, UI pushes, hand-off to the hub
 *   NotifyHub       (notifier.ts)          pushes only: gates, cooldown, Telegram + local channels, the config
 *   FreezeController (freeze-controller.ts) frozen-emulator verdicts and the opt-in restart
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { MatchResult, RawFrame } from '@avdm/automation';
import type { FreezeRecoveryIo, GatherCycleFact, KickedProbeResult } from '@avdm/automation/wanlong';
import {
  makeAlertEvent, pausesInstance, type AlertEvent, type AlertRecord, type AlertsConfigView, type InstancePauseState,
} from '../../shared/alerts';
import type { FreezeInstanceStatus } from '../../shared/ipc/alerts';
import type { AutomationHostHooks } from '../automation/host';
import type { InsightAlert } from '../automation/insights/contracts';
import type { SchedulerHooks } from '../scheduler/types';
import { AlertCenter } from './center';
import { FailureTracker } from './detect';
import { FreezeController } from './freeze-controller';
import { KICKED_CANDIDATES, probeKickedFrame } from './kicked';
import { NotifyHub, type AlertLogLevel, type NotifyHubPorts } from './notifier';

/** Codes whose handler already raised a dedicated 「需要人工介入」 (the scheduler paused the instance). */
const ATTENTION_CODES = new Set(['GAME_UPDATE_REQUIRED', 'AI_RISK_BLOCKED']);
/** Scene screenshots may only be read back from these directories (relative to the data root). */
const SHOT_ROOTS = [['automation', 'wanlong', 'shots'], ['automation', 'monitoring', 'shots']];
const MAX_SHOT_BYTES = 16 * 1024 * 1024;

export interface AlertsServicePorts extends Omit<NotifyHubPorts, 'log' | 'onConfigChanged'> {
  /** `EtaScheduler.setAuto` — pause (false, never takes the lock) and resume (true; IPC only). */
  setAuto(index: number, enabled: boolean, reason?: string): Promise<unknown>;
  /** `EtaScheduler.exclusive` (freeze restarts inside the instance lock). */
  exclusive<T>(index: number, what: string, fn: (ctx: { signal: AbortSignal }) => Promise<T>, signal?: AbortSignal): Promise<T>;
  /** The account bound to the AVD (index + identity). */
  accountOf(index: number): Promise<{ id: string; name: string } | null>;
  /** `record.createdAt`; null when no instance exists. */
  identityOf(index: number): Promise<string | null>;
  /** The emulator process is alive (running, or booting with a pid) — the precondition of a freeze. */
  instanceAlive(index: number): Promise<{ alive: boolean; status: string; identity?: string | null }>;
  /** AVD restart / relaunch adapter for one recovery. */
  recoveryIo(index: number, signal: AbortSignal): FreezeRecoveryIo;
  /** Match UI templates on a frame main already holds (`AutomationHost.matchTemplates`; missing → found: false). */
  matchTemplates(index: number, raw: RawFrame, templateIds: string[]): Promise<MatchResult[]>;
  /** Whether the instance's template set holds any reserved kicked template (skip the match query otherwise). */
  hasKickedTemplates?(index: number): Promise<boolean>;
  /** Save a scene shot under the app's shot policy: relative path, or null when not kept. */
  saveShot(index: number, label: string, raw: RawFrame): Promise<string | null>;
  /** Daily ledger row (statistics). */
  ledger?(record: AlertRecord): Promise<void>;
  log(level: AlertLogLevel, message: string, index?: number): void;
  onPauseChanged?(pause: InstancePauseState): void;
  /** `EtaScheduler.refreshView`: republish the queue view after a pause record changed (its `pause` field). */
  refreshSchedulerView?(index: number): void;
  onRaised?(record: AlertRecord): void;
  onConfigChanged?(view: AlertsConfigView): void;
  gamePackage: string;
}

export class AlertsService {
  readonly hub: NotifyHub;
  readonly center: AlertCenter;
  readonly failures: FailureTracker;
  readonly freeze: FreezeController;
  private readonly root: string;

  constructor(home: string, private readonly ports: AlertsServicePorts) {
    if (!path.isAbsolute(home)) throw new Error('告警数据目录必须是绝对路径');
    this.root = home;
    const log = (level: AlertLogLevel, message: string, index?: number): void => {
      try { ports.log(level, message, index); } catch { /* A log sink never breaks alerts. */ }
    };
    this.hub = new NotifyHub(home, {
      ...(ports.codec ? { codec: ports.codec } : {}),
      ...(ports.fetch ? { fetch: ports.fetch } : {}),
      ...(ports.showLocal ? { showLocal: ports.showLocal } : {}),
      ...(ports.sleep ? { sleep: ports.sleep } : {}),
      ...(ports.now ? { now: ports.now } : {}),
      log: (level, message) => log(level, `[推送] ${message}`),
      ...(ports.onConfigChanged ? { onConfigChanged: ports.onConfigChanged } : {}),
    });
    this.center = new AlertCenter(home, {
      notify: () => this.hub,
      setAuto: (index, enabled, reason) => ports.setAuto(index, enabled, reason),
      accountOf: (index) => ports.accountOf(index),
      identityOf: (index) => ports.identityOf(index),
      resetCounters: (index) => {
        this.failures.reset(index);
        this.freeze.guard.reset(index);
      },
      log,
      ...(ports.onPauseChanged ? { onPauseChanged: ports.onPauseChanged } : {}),
      ...(ports.refreshSchedulerView ? { refreshScheduler: ports.refreshSchedulerView } : {}),
      ...(ports.onRaised ? { onRaised: ports.onRaised } : {}),
      ...(ports.ledger ? { ledger: ports.ledger } : {}),
    }, ports.now ?? Date.now);
    this.failures = new FailureTracker({ config: () => this.center.detectConfig(), log, ...(ports.now ? { now: ports.now } : {}) });
    this.freeze = new FreezeController({
      config: () => this.center.detectConfig(),
      isPaused: (index) => this.center.isPaused(index),
      instanceAlive: (index) => ports.instanceAlive(index),
      exclusive: (index, what, fn, signal) => ports.exclusive(index, what, fn, signal),
      recoveryIo: (index, signal) => ports.recoveryIo(index, signal),
      saveShot: (index, label, raw) => this.saveShot(index, label, raw),
      raise: (event) => this.center.raiseInLock(event),
      resetFailures: (index) => this.failures.reset(index),
      log,
      gamePackage: ports.gamePackage,
      ...(ports.now ? { now: ports.now } : {}),
    });
  }

  /** Scheduler hooks (`EtaScheduler.setHooks`). Every one of them runs inside the instance lock. */
  schedulerHooks(): Partial<SchedulerHooks> {
    return {
      // Consecutive sample failures = emulator or game offline. Awaited in the lock: before pausing as offline ask
      // the freeze watchdog — a picture unchanged during the failures (or captures timing out) with the process
      // alive is a freeze, restarted in place (when enabled); only an unrecovered one pauses.
      onSampleResult: async (index, ok, message, ctx) => {
        if (ok) { this.failures.noteSampleOk(index); return; }
        // An instance already paused (e.g. by the kicked probe) is neither counted nor pushed again.
        if (this.center.isPaused(index)) return;
        const event = this.failures.noteSampleFailed(index, message ?? '原因未知');
        if (!event) return;
        const attempt = await this.freeze.tryRecover(index, '连续采样失败', ctx.signal, false);
        if (attempt.outcome === 'recovered') return;
        await this.center.raiseInLock(attempt.outcome === 'skipped' ? event : { ...event, reason: `${event.reason} ${attempt.note}` });
      },
      // Every frame feeds the watchdog (pixel sampling, tens of microseconds); failed captures too.
      onFrameCaptured: (index, raw) => this.freeze.onFrame(index, raw),
      onCaptureFailed: (index, error) => this.freeze.onCaptureFailed(index, error.message),
      // The health probe could not even capture: adb may be hung. Full threshold.
      onHealthProbeFailed: async (index, _error, ctx) => {
        await this.freeze.tryRecover(index, '健康探针取帧失败', ctx.signal, true);
      },
      // ★ An unrecognised sampler frame: the same frame goes to the kicked probe first (zero extra screenshots).
      //   A hit pauses and stops the sampler (no blind BACK on a kicked dialog).
      probeUnrecognizedFrame: (index, raw) => this.probeFrame(index, raw, '采样时'),
      // ★ The health probe (one frame, no panel) bounds the discovery delay of kicked / exited games.
      onHealthProbe: async (index, raw, ctx) => {
        if (await this.probeFrame(index, raw, '健康探针')) return;
        if (ctx.running === false && !this.center.isPaused(index)) {
          const shotPath = await this.saveShot(index, 'health-probe', raw);
          await this.center.raiseInLock(makeAlertEvent({
            type: 'deviceOffline', instanceIndex: index, shotPath,
            reason: `健康探针发现游戏进程已退出（当前前台：${ctx.foreground ?? '未知'}）。顶号后点了「确定」游戏会直接退出，这也是它最常见的成因。`,
            detail: { 前台包名: ctx.foreground ?? '未知', 游戏进程: '不在' },
          }));
          return;
        }
        // The game is alive but the picture stands still: the only place a freeze shows while the queue is full for
        // hours and nothing samples.
        await this.freeze.tryRecover(index, '健康探针', ctx.signal, true);
      },
      // A human must look (game update prompt, AI judged a confirm risky): the scheduler already paused it.
      onNeedsAttention: (index, info) => this.raiseAttention(index, info),
      pauseOf: (index) => this.center.pauseInfo(index),
    };
  }

  /** Automation host hooks (`AutomationHost.setHooks`). */
  hostHooks(): Partial<AutomationHostHooks> {
    return {
      // One scheduled cycle's facts → verdict → pause when due. ★ Runs inside the instance lock, before a failed
      // cycle throws: the pause (never the push) is awaited so the scheduler sees auto off before it re-arms.
      onCycleResult: async (index, fact, source) => this.onCycleResult(index, fact, source),
      // The scheduler's consecutive-failure safety pause (8 real failures) — this app's extra backstop.
      onScheduleStop: async (_gameId, index, failureCount) => {
        await this.center.raise(makeAlertEvent({
          type: 'consecutiveFailures', instanceIndex: index,
          reason: `连续 ${failureCount} 次真失败（采样或采集），调度器的安全阀已关闭自动调度。请查看最近的运行记录和模拟器画面后再恢复。`,
          detail: { 连续失败次数: failureCount, 来源: '调度器安全阀' },
        }), { schedulerPaused: true });
      },
      // The readiness gate refused a scheduled wake (account not checked, login running, base instance).
      onSchedulePause: async (_gameId, index, reason) => {
        await this.center.raise(makeAlertEvent({ type: 'schedulePaused', instanceIndex: index, reason, detail: { 计为失败: false } }), { schedulerPaused: true });
      },
      onNeedsAttention: async (_gameId, index, info) => { this.raiseAttention(index, info); },
    };
  }

  /** `AutomationHostPorts.probeKicked`: layer 2 on a gather failure frame; null when templates are missing. */
  async probeKicked(index: number, raw: RawFrame): Promise<KickedProbeResult | null> {
    if (!this.center.detectConfig().kickedProbeEnabled) return null;
    const hit = await this.kickedHit(index, raw);
    if (!hit) return null;
    const templateId = typeof hit.detail['命中模板'] === 'string' ? hit.detail['命中模板'] : undefined;
    const score = typeof hit.detail['匹配分'] === 'number' ? hit.detail['匹配分'] : undefined;
    return { type: hit.type, reason: hit.reason, ...(templateId ? { templateId } : {}), ...(score !== undefined ? { score } : {}) };
  }

  async onCycleResult(index: number, fact: GatherCycleFact, source: 'manual' | 'scheduled'): Promise<void> {
    // Update prompts and AI risk refusals raise their own 「需要人工介入」; a manual round is watched by the user.
    if (fact.errorCode && ATTENTION_CODES.has(fact.errorCode)) return;
    if (source !== 'scheduled') return;
    const event = this.failures.noteCycle(index, fact);
    if (!event) return;
    if (pausesInstance(event.type)) await this.center.raiseInLock(event);
    // A warning (dispatchStalled) need not hold the lock for a network request.
    else this.center.raiseQuietly(event);
  }

  /** IPC `resumeAlertPause` / the bot. ★ Never from inside the instance lock. @throws Chinese when not paused. */
  resume(index: number): Promise<InstancePauseState> {
    return this.center.resume(index);
  }

  freezeStatus(): FreezeInstanceStatus[] {
    return this.freeze.status();
  }

  /**
   * A scene screenshot by its stored relative path, only from the shot directories (no traversal, no symlink escape
   * through `..`). @throws Chinese when missing or outside.
   */
  async screenshot(shotPath: string): Promise<Uint8Array> {
    if (typeof shotPath !== 'string' || !shotPath.trim() || shotPath.length > 400 || shotPath.includes('\0')) throw new Error('截图路径无效');
    const resolved = path.resolve(this.root, shotPath.trim());
    const inside = SHOT_ROOTS.some((segments) => {
      const dir = path.join(this.root, ...segments);
      return resolved.startsWith(`${dir}${path.sep}`) && path.dirname(resolved) === dir;
    });
    if (!inside || !/\.(jpe?g|png)$/i.test(resolved)) throw new Error('只能查看告警现场截图目录里的图片');
    try {
      const info = await stat(resolved);
      if (!info.isFile() || info.size > MAX_SHOT_BYTES) throw new Error('截图文件无效');
      return new Uint8Array(await readFile(resolved));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('现场截图已经不在了（超过 14 天会自动清理，或留痕策略当时是「不留痕」）');
      throw error;
    }
  }

  async dispose(): Promise<void> {
    this.freeze.dispose();
    await this.center.dispose();
    await this.hub.flush();
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private raiseAttention(index: number, info: { code: string; message: string }): void {
    this.center.raiseQuietly(makeAlertEvent({
      type: 'needsAttention', instanceIndex: index, reason: info.message,
      detail: { 阶段: info.code === 'AI_RISK_BLOCKED' ? 'AI 操作风险评估' : '游戏资源更新', 自动操作: '已停止，处理后可恢复' },
    }), { schedulerPaused: true });
  }

  /**
   * Layer 2 on one frame; a hit keeps the scene, raises the pausing alert (awaited in the lock) and returns true.
   * Already paused instances are skipped (no second push).
   */
  private async probeFrame(index: number, raw: RawFrame, where: string): Promise<boolean> {
    if (!this.center.detectConfig().kickedProbeEnabled || this.center.isPaused(index)) return false;
    const hit = await this.kickedHit(index, raw);
    if (!hit) return false;
    const shotPath = await this.saveShot(index, 'kicked', raw);
    await this.center.raiseInLock(makeAlertEvent({
      type: hit.type, instanceIndex: index, reason: `${where}命中：${hit.reason}`, shotPath, detail: hit.detail,
    }));
    return true;
  }

  private async kickedHit(index: number, raw: RawFrame): Promise<Awaited<ReturnType<typeof probeKickedFrame>>> {
    try {
      if (this.ports.hasKickedTemplates && !await this.ports.hasKickedTemplates(index)) return null;
    } catch {
      return null;
    }
    return probeKickedFrame((ids) => this.ports.matchTemplates(index, raw, ids), (level, message) => this.ports.log(level, message, index));
  }

  private async saveShot(index: number, label: string, raw: RawFrame): Promise<string | null> {
    try { return await this.ports.saveShot(index, label, raw); }
    catch (error) {
      this.ports.log('warn', `[告警] 实例 #${index} 现场截图没能保存（不影响告警）：${error instanceof Error ? error.message : String(error)}`, index);
      return null;
    }
  }
}

/** The reserved template ids, for the `hasKickedTemplates` port. */
export const KICKED_TEMPLATE_IDS: readonly string[] = KICKED_CANDIDATES.map((candidate) => candidate.id);

/**
 * One alert record as a daily-ledger row (statistics). Info events (resume, test) are not ledger alerts: null.
 * The id is unique per event, so a replay never counts twice.
 */
export function ledgerAlertOf(record: AlertRecord, gameId: string): InsightAlert | null {
  const e = record.event;
  if (e.type === 'instanceResumed' || e.type === 'test' || e.instanceIndex < 0 || e.instanceIndex > 63) return null;
  return {
    id: `${gameId}:${e.instanceIndex}:${e.type}:${e.id}`.slice(0, 180),
    gameId, index: e.instanceIndex, kind: e.type, severity: e.severity === 'critical' ? 'critical' : 'warning', at: e.at,
    message: e.reason.slice(0, 1000), runId: null,
    ...(e.shotPath ? { evidence: { source: 'frame' as const, runId: null, screenshotPath: e.shotPath } } : {}),
  };
}

export type { AlertEvent };
export { AlertCenter } from './center';
export { FailureTracker } from './detect';
export { FreezeController } from './freeze-controller';
export { createAvdFreezeRecoveryIo } from './freeze-io';
export { NotifyHub } from './notifier';
export { safeStorageCodec } from './safe-storage';
