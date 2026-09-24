import type { GatherCycleResult } from '@avdm/automation/wanlong';
import type { AutomationRun } from '../../../shared/ipc';
import type { MonitorAlert } from '../../monitoring/types';
import type { ReadOnlyBotConfig } from '../../monitoring/telegram-readonly';
import type { InsightAlert, InsightDay, NotificationConfigPatch, NotificationConfigView, NotificationTestResult, RemoteBotConfigPatch, RemoteBotConfigView } from './contracts';
import { NotificationHub, type NotificationPorts } from './notifications';
import { cstDateKey, type InsightCycleFact } from './stats';
import { InsightStore } from './store';

function safeMessage(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value);
  return text.trim().slice(0, 900) || '自动化运行失败';
}

function terminalAt(run: AutomationRun): number {
  return run.endedAt !== null && Number.isFinite(run.endedAt) ? run.endedAt : Date.now();
}

/** Durable insights and opt-in notifications. This service never sends ADB input or owns a device. */
export class InsightsService {
  private readonly store: InsightStore;
  private readonly notifications: NotificationHub;

  constructor(home: string, ports: NotificationPorts = {}) {
    this.store = new InsightStore(home);
    this.notifications = new NotificationHub(home, ports);
  }

  async days(gameId: string, index: number | null, count = 7): Promise<InsightDay[]> {
    return this.store.days(gameId, index, count);
  }

  async alerts(gameId: string, index: number | null, limit = 50): Promise<InsightAlert[]> {
    return this.store.alerts(gameId, index, limit);
  }

  config(gameId: string, index: number): Promise<NotificationConfigView> {
    return this.notifications.config(gameId, index);
  }

  saveConfig(gameId: string, index: number, patch: NotificationConfigPatch): Promise<NotificationConfigView> {
    return this.notifications.saveConfig(gameId, index, patch);
  }

  test(gameId: string, index: number, channel: 'local' | 'telegram'): Promise<NotificationTestResult> {
    return this.notifications.test(gameId, index, channel);
  }

  remoteBotConfig(running = false): Promise<RemoteBotConfigView> {
    return this.notifications.remoteConfig(running);
  }

  saveRemoteBotConfig(patch: RemoteBotConfigPatch, running = false): Promise<RemoteBotConfigView> {
    return this.notifications.saveRemoteConfig(patch, running);
  }

  /** Main process only: decrypted credential must never cross the renderer IPC bridge. */
  readOnlyBotConfig(): Promise<ReadOnlyBotConfig> {
    return this.notifications.readOnlyBotConfig();
  }

  /** Called after the game worker produced a result; duplicate run IDs are idempotent. */
  async recordCycle(run: AutomationRun, result: GatherCycleResult, source: 'manual' | 'scheduled'): Promise<void> {
    const endedAt = terminalAt(run);
    const status: InsightCycleFact['status'] = result.outcome === 'cancelled' ? 'cancelled' :
      result.outcome === 'error' || result.outcome === 'circuitBroken' ? 'failed' : 'succeeded';
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
    if (status !== 'failed') return;
    const kind = result.outcome === 'circuitBroken' ? 'circuitBroken' : 'runFailed';
    await this.raise({
      id: `${run.gameId}:${run.index}:${kind}:${run.runId}`,
      gameId: run.gameId, index: run.index, kind,
      severity: kind === 'circuitBroken' ? 'critical' : 'warning',
      at: endedAt, message: safeMessage(result.message), runId: run.runId,
    });
  }

  /** Runner exceptions have no GatherCycleResult but must still appear in daily failure totals. */
  async recordFailure(run: AutomationRun, error: unknown, source: 'manual' | 'scheduled'): Promise<void> {
    const endedAt = terminalAt(run);
    await this.store.addCycle({
      runId: run.runId, gameId: run.gameId, index: run.index, source,
      startedAt: run.startedAt, endedAt, outcome: 'error', status: 'failed', dispatches: [],
    });
    await this.raise({
      id: `${run.gameId}:${run.index}:runFailed:${run.runId}`,
      gameId: run.gameId, index: run.index, kind: 'runFailed', severity: 'warning',
      at: endedAt, message: safeMessage(error), runId: run.runId,
    });
  }

  /** Call only when scheduler persisted an automatic disable after repeated failures. */
  async recordScheduleStop(gameId: string, index: number, failureCount: number): Promise<void> {
    if (!Number.isInteger(failureCount) || failureCount < 1) throw new Error('调度失败次数无效');
    const at = Date.now();
    await this.raise({
      id: `${gameId}:${index}:schedulePaused:${cstDateKey(at)}`,
      gameId, index, kind: 'schedulePaused', severity: 'critical', at,
      message: `连续 ${failureCount} 次失败，自动续跑已暂停。请查看最近运行和模拟器画面后再启用。`, runId: null,
    });
  }

  /**
   * A schedule paused by a gate that is not a failure (the bound account needs a login check, a login is running,
   * the base instance). A warning, at most once a day per instance, never counted as a failed cycle.
   */
  async recordSchedulePause(gameId: string, index: number, reason: string): Promise<void> {
    const at = Date.now();
    await this.raise({
      id: `${gameId}:${index}:schedulePaused:gate:${cstDateKey(at)}`,
      gameId, index, kind: 'schedulePaused', severity: 'warning', at,
      message: `自动续跑已暂停（不计为失败）：${safeMessage(reason)}`, runId: null,
    });
  }

  /** Read-only monitor findings use the same durable ledger and opt-in channels as run alerts. */
  async recordMonitorAlert(alert: MonitorAlert): Promise<void> {
    await this.raise({
      id: alert.id, gameId: alert.gameId, index: alert.index, kind: alert.kind,
      severity: alert.severity, at: alert.at, message: alert.message,
      runId: alert.evidence.runId, evidence: alert.evidence,
    });
  }

  private async raise(alert: InsightAlert): Promise<void> {
    if (await this.store.addAlert(alert)) this.notifications.enqueue(alert);
  }

  async dispose(): Promise<void> { await this.notifications.flush(); }
}

export type { InsightAlert, InsightDay, NotificationConfigPatch, NotificationConfigView, NotificationTestResult, RemoteBotConfigPatch, RemoteBotConfigView } from './contracts';
