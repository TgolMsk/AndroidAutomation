import type { InsightAlert, InsightDay, InsightResource, InsightResourceTotals } from './contracts';

export const INSIGHT_RESOURCES: readonly InsightResource[] = ['wood', 'gold', 'iron', 'mana'];
const CST_OFFSET_MS = 8 * 60 * 60 * 1000;

/** The game uses Beijing dates regardless of the Mac's configured time zone. */
export function cstDateKey(at: number): string {
  if (!Number.isFinite(at)) throw new Error('统计时间无效');
  return new Date(at + CST_OFFSET_MS).toISOString().slice(0, 10);
}

export function shiftDateKey(key: string, days: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || !Number.isInteger(days)) throw new Error('统计日期无效');
  const at = Date.parse(`${key}T00:00:00.000Z`);
  if (!Number.isFinite(at) || new Date(at).toISOString().slice(0, 10) !== key) throw new Error('统计日期无效');
  return new Date(at + days * 86_400_000).toISOString().slice(0, 10);
}

export interface InsightDispatchFact {
  at: number;
  resource: InsightResource;
  storage: number | null;
}

export interface InsightCycleFact {
  runId: string;
  gameId: string;
  index: number;
  startedAt: number;
  endedAt: number;
  outcome: string;
  status: 'succeeded' | 'failed' | 'cancelled';
  source: 'manual' | 'scheduled';
  dispatches: InsightDispatchFact[];
}

function emptyResource(): InsightResourceTotals {
  return { dispatches: 0, estimatedAmount: 0, unknownStorageDispatches: 0 };
}

export function emptyDay(dateKey: string, gameId: string, index: number | null): InsightDay {
  return {
    dateKey, gameId, index, cycles: 0, succeeded: 0, failed: 0, cancelled: 0,
    circuitBreaks: 0, dispatches: 0, estimatedAmount: 0, unknownStorageDispatches: 0,
    byResource: { wood: emptyResource(), gold: emptyResource(), iron: emptyResource(), mana: emptyResource() },
    alerts: 0,
  };
}

/** Aggregate recorded facts only. A dispatched card's storage is an estimate, never a completed harvest. */
export function aggregateDay(
  dateKey: string, gameId: string, index: number | null,
  cycles: readonly InsightCycleFact[], alerts: readonly InsightAlert[],
): InsightDay {
  const day = emptyDay(dateKey, gameId, index);
  for (const cycle of cycles) {
    if (cycle.gameId !== gameId || (index !== null && cycle.index !== index)) continue;
    if (cstDateKey(cycle.endedAt) === dateKey) {
      day.cycles++;
      day[cycle.status]++;
      if (cycle.outcome === 'circuitBroken') day.circuitBreaks++;
    }
    for (const dispatch of cycle.dispatches) {
      if (cstDateKey(dispatch.at) !== dateKey) continue;
      const resource = day.byResource[dispatch.resource];
      if (!resource) continue;
      resource.dispatches++;
      day.dispatches++;
      if (dispatch.storage !== null && Number.isFinite(dispatch.storage) && dispatch.storage >= 0) {
        resource.estimatedAmount += dispatch.storage;
        day.estimatedAmount += dispatch.storage;
      } else {
        resource.unknownStorageDispatches++;
        day.unknownStorageDispatches++;
      }
    }
  }
  for (const alert of alerts) {
    if (alert.gameId === gameId && (index === null || alert.index === index) && cstDateKey(alert.at) === dateKey) day.alerts++;
  }
  return day;
}
