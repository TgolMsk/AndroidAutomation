import { randomUUID } from 'node:crypto';
import type { GatherCycleResult } from '@avdm/automation/wanlong';
import type { AutomationRun } from '../../shared/ipc';
import { MonitorEvidenceStore } from './evidence';
import { CycleFailureTracker, type CycleResultFact, type FailureThresholds } from './failures';
import { FreezeGuard, type FreezeThresholds, type FreezeVerdict } from './freeze';
import { probeSpecificScene } from './kicked';
import type { MonitorAlert, MonitorPorts, MonitorTarget } from './types';

export interface MonitoringOptions {
  failureThresholds?: Partial<FailureThresholds>;
  freezeThresholds?: Partial<FreezeThresholds>;
  /** 30-600 seconds. Polling is only enabled when start() is called. */
  pollSeconds?: number;
}

function scope(gameId: string, index: number): string { return `${gameId}:${index}`; }

/** The assistant's optional observer. It never taps, restarts, or owns an emulator process. */
export class MonitoringService {
  readonly failures: CycleFailureTracker;
  readonly freeze: FreezeGuard;
  private readonly evidence: MonitorEvidenceStore;
  private readonly identities = new Map<string, string>();
  private readonly now: () => number;
  private readonly pollMs: number;
  private timer: NodeJS.Timeout | null = null;
  private polling: Promise<void> | null = null;
  private disposed = false;

  constructor(home: string, private readonly ports: MonitorPorts, options: MonitoringOptions = {}) {
    this.failures = new CycleFailureTracker(options.failureThresholds);
    this.freeze = new FreezeGuard(options.freezeThresholds);
    this.evidence = new MonitorEvidenceStore(home);
    this.now = ports.now ?? Date.now;
    const seconds = options.pollSeconds ?? 60;
    if (!Number.isSafeInteger(seconds) || seconds < 30 || seconds > 600) throw new Error('监控轮询间隔应为 30–600 秒');
    this.pollMs = seconds * 1_000;
  }

  /** Hook after a completed cycle. Optional scene probes use the existing host's isolated template-test worker. */
  async recordCycle(run: AutomationRun, result: GatherCycleResult): Promise<void> {
    await this.recordFact(run, result);
  }

  /** Runner exceptions also participate in the same consecutive-failure counter. */
  async recordFailure(run: AutomationRun, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await this.recordFact(run, {
      outcome: 'error', message: message.slice(0, 300), dispatched: [],
      error: { code: 'RUNNER_EXCEPTION', message: message.slice(0, 300) },
    });
  }

  private async recordFact(run: AutomationRun, result: CycleResultFact): Promise<void> {
    if (this.disposed || run.status === 'cancelled') return;
    const at = run.endedAt ?? this.now();
    const signal = this.failures.note(run.gameId, run.index, run.runId, result, at);
    let specific: Awaited<ReturnType<typeof probeSpecificScene>> = null;
    if (result.outcome === 'error') {
      try {
        const set = await this.ports.templateSet(run.gameId, run.index);
        specific = await probeSpecificScene(run.gameId, run.index, set, this.ports);
      } catch {
        // Optional scene evidence cannot break the failure tracker or a completed gather run.
      }
    }
    if (specific) {
      this.failures.reset(run.gameId, run.index);
      const screenshotPath = await this.evidence.savePng(run.gameId, run.index, specific.screenshot, at).catch(() => undefined);
      await this.ports.onAlert({
        id: `${run.gameId}:${run.index}:${specific.kind}:${run.runId}`,
        gameId: run.gameId, index: run.index, at, kind: specific.kind, severity: 'critical',
        message: specific.message,
        evidence: {
          source: 'cycle', runId: run.runId, outcome: result.outcome,
          errorCode: result.error?.code ?? null,
          templateId: specific.templateId, score: specific.score, threshold: specific.threshold,
          ...(screenshotPath ? { screenshotPath } : {}),
        },
      });
      return;
    }
    if (!signal) return;
    await this.ports.onAlert({
      id: `${run.gameId}:${run.index}:${signal.kind}:${run.runId}`,
      gameId: run.gameId, index: run.index, at, kind: signal.kind,
      severity: signal.kind === 'dispatchStalled' ? 'warning' : 'critical',
      message: signal.message,
      evidence: signal.evidence,
    });
  }

  /** One read-only sample of all currently scheduled targets; a busy instance is skipped and reset. */
  async pollOnce(): Promise<void> {
    if (this.disposed) return;
    if (this.polling) return this.polling;
    const pending = this.pollTargets();
    this.polling = pending;
    try { await pending; }
    finally { if (this.polling === pending) this.polling = null; }
  }

  start(): void {
    if (this.disposed) throw new Error('监控服务已关闭');
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.pollOnce().catch((error: unknown) =>
        console.warn('[wanlong/monitoring] 只读巡检失败', error instanceof Error ? error.message : String(error)));
    }, this.pollMs);
    this.timer.unref();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.polling?.catch(() => undefined);
  }

  private async pollTargets(): Promise<void> {
    const targets = await this.ports.targets();
    const seen = new Set<string>();
    for (const target of targets) {
      if (!validTarget(target)) continue;
      const key = scope(target.gameId, target.index);
      if (seen.has(key)) continue;
      seen.add(key);
      const identity = this.identities.get(key);
      if (identity && identity !== target.instanceIdentity) this.reset(key, target);
      this.identities.set(key, target.instanceIdentity);
      if (!target.instanceRunning || target.busy) {
        this.freeze.reset(target.gameId, target.index);
        if (!target.instanceRunning) this.failures.reset(target.gameId, target.index);
        continue;
      }
      const at = this.now();
      let verdict: FreezeVerdict | null;
      let frame: import('@avdm/automation').RawFrame | undefined;
      try {
        const captured = await this.ports.capture(target.gameId, target.index);
        if (captured.foregroundPackage !== target.packageName) {
          this.freeze.reset(target.gameId, target.index);
          continue;
        }
        frame = captured.frame;
        verdict = this.freeze.observe(target.gameId, target.index, captured.frame, at);
      } catch (error) {
        // Foreground switches, permissions, and other unknown failures are not freeze evidence.
        if (this.ports.classifyCaptureError?.(error) !== 'device') {
          this.freeze.reset(target.gameId, target.index);
          continue;
        }
        verdict = this.freeze.captureFailed(target.gameId, target.index, at);
      }
      if (verdict) await this.emitFreeze(target, verdict, at, frame);
    }
    for (const key of this.identities.keys()) {
      if (seen.has(key)) continue;
      const [gameId, index] = key.split(':');
      if (gameId && index) { this.failures.reset(gameId, Number(index)); this.freeze.reset(gameId, Number(index)); }
      this.identities.delete(key);
    }
  }

  private reset(key: string, target: MonitorTarget): void {
    this.failures.reset(target.gameId, target.index);
    this.freeze.reset(target.gameId, target.index);
    this.identities.delete(key);
  }

  private async emitFreeze(target: MonitorTarget, verdict: FreezeVerdict, at: number, frame?: import('@avdm/automation').RawFrame): Promise<void> {
    const screenshotPath = frame
      ? await this.evidence.saveFrame(target.gameId, target.index, frame, at).catch(() => undefined)
      : undefined;
    await this.ports.onAlert({
      id: `${target.gameId}:${target.index}:suspectedFreeze:${at}:${randomUUID()}`,
      gameId: target.gameId, index: target.index, at,
      kind: 'suspectedFreeze', severity: 'critical', message: verdict.message,
      evidence: {
        source: verdict.kind === 'static' ? 'frame' : 'capture', runId: null,
        staticFrames: verdict.evidence.staticFrames,
        staticForMs: verdict.evidence.staticForMs,
        captureFailures: verdict.evidence.captureFailures,
        captureFailingForMs: verdict.evidence.captureFailingForMs,
        ...(screenshotPath ? { screenshotPath } : {}),
      },
    });
  }
}

function validTarget(value: MonitorTarget): boolean {
  return /^[a-z][a-z0-9-]{0,63}$/.test(value.gameId) &&
    Number.isSafeInteger(value.index) && value.index >= 0 && value.index <= 63 &&
    typeof value.packageName === 'string' && /^[a-zA-Z0-9_.]+$/.test(value.packageName) &&
    typeof value.instanceIdentity === 'string' && value.instanceIdentity.length > 0 &&
    typeof value.instanceRunning === 'boolean' && typeof value.busy === 'boolean';
}

export type { MonitorAlert, MonitorAlertKind, MonitorEvidence, MonitorPorts, MonitorTarget } from './types';
export { RESERVED_ALERT_TEMPLATES, probeSpecificScene } from './kicked';
export { ReadOnlyTelegramBot } from './telegram-readonly';
export type { ReadOnlyBotConfig, ReadOnlyBotPorts, ReadOnlyInstanceStatus } from './telegram-readonly';
