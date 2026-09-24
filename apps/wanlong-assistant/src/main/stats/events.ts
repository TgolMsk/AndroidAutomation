/**
 * Hook payloads → StatsEvent (the original wiring in src/main/index.ts, moved into pure functions so the rules are
 * tested): which cycle outcomes are failures, what a trip is, what a pause is.
 */
import { ATTENTION_ERROR_CODES, type DispatchRecord, type GatherCycleFact } from '@avdm/automation/wanlong/pure';
import type {
  StatsAlertRaisedEvent, StatsCycleFailedEvent, StatsDispatchEvent, StatsPausedEvent, StatsResumedEvent,
  StatsTripCompletedEvent,
} from '../../shared/stats';

/** Every dispatch record of a cycle (also of a cycle that ended in an error: the troops are out either way). */
export function dispatchEvents(index: number, records: readonly DispatchRecord[], at: number): StatsDispatchEvent[] {
  return records.map((record) => ({
    kind: 'dispatch',
    at: Number.isFinite(record.at) && record.at > 0 ? record.at : at,
    instanceIndex: index,
    resource: record.resource,
    storage: record.storage,
    coord: record.coord,
    level: record.level,
    travelTimeSec: record.travelTimeSec,
  }));
}

/**
 * A failed cycle or a circuit break, or null. ★ GAME_UPDATE_REQUIRED / AI_RISK_BLOCKED are not failures (a human
 * must look; their own「需要人处理」alert covers them) and every other outcome (queueFull, giveUp …) is not either.
 */
export function cycleFailedEvent(index: number, fact: GatherCycleFact, at: number): StatsCycleFailedEvent | null {
  if (fact.outcome !== 'error' && fact.outcome !== 'circuitBroken') return null;
  if (fact.errorCode && ATTENTION_ERROR_CODES.has(fact.errorCode)) return null;
  return { kind: 'cycleFailed', at, instanceIndex: index, outcome: fact.outcome, message: fact.message, step: fact.step, errorCode: fact.errorCode };
}

/** Marches that were out at the last sample and are gone now: one completed trip each (resource resolved later). */
export function tripEvents(index: number, gone: ReadonlyArray<{ coord: string | null }>, at: number): StatsTripCompletedEvent[] {
  return gone.map((march) => ({ kind: 'tripCompleted', at, instanceIndex: index, coord: march.coord, resource: null }));
}

/** ★ The only source of pause / resume facts: the scheduler's real flip of the auto switch. */
export function autoChangedEvent(index: number, enabled: boolean, at: number, reason?: string | null): StatsPausedEvent | StatsResumedEvent {
  return enabled
    ? { kind: 'resumed', at, instanceIndex: index }
    : { kind: 'paused', at, instanceIndex: index, reason: reason ?? null };
}

export function alertRaisedEvent(index: number, alertType: string, at: number): StatsAlertRaisedEvent {
  return { kind: 'alertRaised', at, instanceIndex: index, alertType };
}
