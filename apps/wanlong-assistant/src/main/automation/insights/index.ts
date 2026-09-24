import type { GatherCycleResult } from '@avdm/automation/wanlong';
import type { AutomationRun } from '../../../shared/ipc';
import type { InsightAlert, InsightDay } from './contracts';
import type { InsightCycleFact } from './stats';
import { InsightStore } from './store';

function terminalAt(run: AutomationRun): number {
  return run.endedAt !== null && Number.isFinite(run.endedAt) ? run.endedAt : Date.now();
}

/**
 * Durable daily insights (cycles, dispatches, alert counts). Notifications, pauses and alert conclusions belong to
 * the alerts module (`src/main/alerts`), which writes its alerts into this ledger through `recordAlert`. This service
 * never sends ADB input or owns a device.
 * ★ A failed run is a cycle fact (`failed` in the day), never a ledger alert: the original alerts only on thresholds
 *   (FailureTracker), so 「告警记录」 and the daily alert count hold real alert conclusions only. The earlier per-run
 *   `runFailed` rows of old day files stay readable (`LEGACY_LEDGER_KINDS`).
 */
export class InsightsService {
  private readonly store: InsightStore;

  constructor(home: string) {
    this.store = new InsightStore(home);
  }

  async days(gameId: string, index: number | null, count = 7): Promise<InsightDay[]> {
    return this.store.days(gameId, index, count);
  }

  async alerts(gameId: string, index: number | null, limit = 50): Promise<InsightAlert[]> {
    return this.store.alerts(gameId, index, limit);
  }

  /** Called after the game worker produced a result; duplicate run IDs are idempotent. */
  async recordCycle(run: AutomationRun, result: GatherCycleResult, source: 'manual' | 'scheduled'): Promise<void> {
    const endedAt = terminalAt(run);
    // ★ circuitBroken is a designed stop, not a failure (original alerts iron rule 1): it is counted apart as
    //   `circuitBreaks` and raises no alert; the scheduler simply looks again in 10 minutes.
    const status: InsightCycleFact['status'] = result.outcome === 'cancelled' ? 'cancelled' :
      result.outcome === 'error' ? 'failed' : 'succeeded';
    const fact: InsightCycleFact = {
      runId: run.runId, gameId: run.gameId, index: run.index, source,
      startedAt: run.startedAt, endedAt, outcome: result.outcome, status,
      dispatches: result.dispatched.map((dispatch) => ({
        at: dispatch.at, resource: dispatch.resource,
        storage: typeof dispatch.storage === 'number' && Number.isFinite(dispatch.storage) && dispatch.storage >= 0
          ? dispatch.storage : null,
      })),
    };
    await this.store.addCycle(fact);
  }

  /** Runner exceptions have no GatherCycleResult but must still appear in daily failure totals. */
  async recordFailure(run: AutomationRun, _error: unknown, source: 'manual' | 'scheduled'): Promise<void> {
    const endedAt = terminalAt(run);
    await this.store.addCycle({
      runId: run.runId, gameId: run.gameId, index: run.index, source,
      startedAt: run.startedAt, endedAt, outcome: 'error', status: 'failed', dispatches: [],
    });
  }

  /**
   * One alert conclusion of the alerts module into the day ledger (statistics: alerts per day). Idempotent by id.
   * @returns false when the id was already recorded
   */
  async recordAlert(alert: InsightAlert): Promise<boolean> {
    return this.store.addAlert(alert);
  }

  async dispose(): Promise<void> { /* Every write is awaited by its caller. */ }
}

export type { InsightAlert, InsightDay, NotificationConfigPatch, NotificationConfigView, NotificationTestResult, RemoteBotConfigPatch, RemoteBotConfigView } from './contracts';
