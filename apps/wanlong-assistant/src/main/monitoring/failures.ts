import type { GatherCycleResult } from '@avdm/automation/wanlong';
import type { MonitorAlertKind, MonitorEvidence } from './types';

export interface FailureThresholds {
  consecutiveFailures: number;
  recoveryExhausted: number;
  stalledMinutes: number;
}

export const DEFAULT_FAILURE_THRESHOLDS: Readonly<FailureThresholds> = {
  consecutiveFailures: 3,
  recoveryExhausted: 2,
  stalledMinutes: 120,
};

interface Counters {
  failures: number;
  recoveryFailures: number;
  lastDispatchAt: number;
  stalledNotifiedAt: number | null;
}

export interface FailureSignal {
  kind: Extract<MonitorAlertKind, 'consecutiveFailures' | 'recoveryExhausted' | 'dispatchStalled'>;
  message: string;
  evidence: MonitorEvidence;
}

export type CycleResultFact = Pick<GatherCycleResult, 'outcome' | 'message' | 'dispatched' | 'error'>;

function scope(gameId: string, index: number): string { return `${gameId}:${index}`; }

function assertThreshold(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) throw new Error(`${name} 阈值无效`);
}

/** Counts actual failed cycles, never scheduler backoff or normal queue-full waiting. */
export class CycleFailureTracker {
  private readonly counters = new Map<string, Counters>();
  readonly thresholds: Readonly<FailureThresholds>;

  constructor(thresholds: Partial<FailureThresholds> = {}) {
    this.thresholds = { ...DEFAULT_FAILURE_THRESHOLDS, ...thresholds };
    assertThreshold(this.thresholds.consecutiveFailures, '连续失败');
    assertThreshold(this.thresholds.recoveryExhausted, '恢复失败');
    assertThreshold(this.thresholds.stalledMinutes, '派兵停滞');
  }

  reset(gameId: string, index: number): void { this.counters.delete(scope(gameId, index)); }

  peek(gameId: string, index: number): Readonly<Counters> | null {
    const current = this.counters.get(scope(gameId, index));
    return current ? { ...current } : null;
  }

  note(gameId: string, index: number, runId: string, result: CycleResultFact, at: number): FailureSignal | null {
    const key = scope(gameId, index);
    const c = this.counters.get(key) ?? {
      failures: 0, recoveryFailures: 0, lastDispatchAt: at, stalledNotifiedAt: null,
    };
    this.counters.set(key, c);
    if (result.dispatched.length > 0) {
      c.lastDispatchAt = at;
      c.stalledNotifiedAt = null;
    }

    if (result.outcome === 'error') {
      c.failures += 1;
      const step = result.error?.detail?.['step'];
      const failedStep = typeof step === 'string' ? step : null;
      c.recoveryFailures = failedStep === 'G0' ? c.recoveryFailures + 1 : 0;
      const evidence: MonitorEvidence = {
        source: 'cycle', runId, outcome: result.outcome,
        errorCode: result.error?.code ?? null, step: failedStep,
        consecutiveFailures: c.failures,
      };
      if (c.recoveryFailures >= this.thresholds.recoveryExhausted) {
        const count = c.recoveryFailures;
        c.failures = 0;
        c.recoveryFailures = 0;
        return { kind: 'recoveryExhausted',
          message: `连续 ${count} 轮无法回到世界地图，请检查游戏画面。`, evidence };
      }
      if (c.failures >= this.thresholds.consecutiveFailures) {
        const count = c.failures;
        c.failures = 0;
        c.recoveryFailures = 0;
        return { kind: 'consecutiveFailures',
          message: `连续 ${count} 轮采集失败；最近原因：${result.message.slice(0, 300)}`, evidence };
      }
      return null;
    }

    // A safety circuit breaker is already a separate Insights event. It is not evidence of a kicked account.
    if (result.outcome !== 'cancelled') {
      c.failures = 0;
      c.recoveryFailures = 0;
    }
    if (result.outcome === 'cancelled' || result.outcome === 'circuitBroken' || result.dispatched.length > 0) return null;
    const windowMs = this.thresholds.stalledMinutes * 60_000;
    if (at - c.lastDispatchAt < windowMs ||
        (c.stalledNotifiedAt !== null && at - c.stalledNotifiedAt < windowMs)) return null;
    c.stalledNotifiedAt = at;
    const minutes = Math.floor((at - c.lastDispatchAt) / 60_000);
    return {
      kind: 'dispatchStalled',
      message: `已 ${minutes} 分钟没有成功派出采集队；最近一轮：${result.message.slice(0, 300)}`,
      evidence: { source: 'cycle', runId, outcome: result.outcome },
    };
  }
}
