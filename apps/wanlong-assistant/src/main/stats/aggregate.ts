/**
 * Facts of one Beijing day → `DailyStats` (the original reducer `applyStatsEvent` + `rolloverDay`, evaluated on read).
 *
 * ★ Pure: no clock reads (`now` is passed in, only for the pause still running today), no host time zone
 *   (`cstDateKey` / `dateKeyToDayStart` from shared/time). Facts from another day are ignored.
 */
import { RESOURCE_TYPES, type ResourceSnapshot, type ResourceType } from '@avdm/automation/wanlong/pure';
import {
  STATS_SNAPSHOTS_PER_DAY, emptyDailyStats, emptyInstanceDailyStats, type DailyResourceStat, type DailyStats,
  type InstanceDailyStats,
} from '../../shared/stats';
import { DAY_MS, cstDateKey, dateKeyToDayStart, type DateKey } from '../../shared/time';
import type { StatsFact } from './facts';

/** Facts in time order (stable for equal times, so the stored order breaks ties). */
export function sortFacts<T extends { at: number }>(facts: readonly T[]): T[] {
  return facts.map((fact, i) => ({ fact, i })).sort((a, b) => a.fact.at - b.fact.at || a.i - b.i).map(({ fact }) => fact);
}

/** The resource dispatched most often among these facts (one instance, or all when `index` is null); null when none. */
export function mostDispatchedResource(facts: readonly StatsFact[], index: number | null): ResourceType | null {
  const counts: Record<ResourceType, number> = { gold: 0, wood: 0, iron: 0, mana: 0 };
  for (const fact of facts) if (fact.kind === 'dispatch' && (index === null || fact.index === index)) counts[fact.resource]++;
  let best: ResourceType | null = null;
  let bestCount = 0;
  for (const t of RESOURCE_TYPES) {
    if (counts[t] > bestCount) { best = t; bestCount = counts[t]; }
  }
  return best;
}

/** Keep at most `STATS_SNAPSHOTS_PER_DAY` snapshot facts (the newest); other facts are untouched. */
export function capSnapshots(facts: readonly StatsFact[]): StatsFact[] {
  const snapshots = facts.filter((fact) => fact.kind === 'snapshot');
  if (snapshots.length <= STATS_SNAPSHOTS_PER_DAY) return [...facts];
  const drop = new Set(sortFacts(snapshots).slice(0, snapshots.length - STATS_SNAPSHOTS_PER_DAY).map((fact) => fact.id));
  return facts.filter((fact) => !drop.has(fact.id));
}

function addDispatch(stat: DailyResourceStat, storage: number | null): void {
  stat.dispatches += 1;
  if (storage === null || !Number.isFinite(storage) || storage < 0) stat.unknownStorageDispatches += 1;
  else stat.estimatedAmount += storage;
}

/**
 * Aggregate one day. Counting rules are the original reducer's:
 *   dispatch       dispatches +1 (total, instance, resource); storage ≥ 0 → estimatedAmount, else unknownStorage +1
 *   cycleFailed    'error' → failures, 'circuitBroken' → circuitBreaks (never both)
 *   tripCompleted  byResource[r].completed +1
 *   alertRaised    alerts +1
 *   paused         opens a pause unless one is open (a repeated paused never moves the start later)
 *   resumed        closes the open pause (span → pausedMs); a resumed without an open pause is ignored
 *   pauseCarry     a pause open at 00:00 of this day
 *   snapshot       sorted, the newest 48 kept
 * A pause still open at the end of the day: today → `pausedSince` (live); a past day → closed at 24:00.
 * An instance index whose AVD was replaced during the day gets a separate `replaced` bucket for the earlier identity.
 */
export function aggregateDay(gameId: string, dateKey: DateKey, facts: readonly StatsFact[], now: number): DailyStats {
  const day = emptyDailyStats(dateKey, 0, gameId);
  const dayStart = dateKeyToDayStart(dateKey);
  if (!Number.isFinite(dayStart)) return day;
  const dayEnd = dayStart + DAY_MS;
  const own = sortFacts(facts.filter((fact) => Number.isFinite(fact.at) && cstDateKey(fact.at) === dateKey));

  // The identity each index ends the day with: its bucket keeps the plain key.
  const current = new Map<number, string>();
  for (const fact of own) if (fact.instance !== null) current.set(fact.index, fact.instance);

  const bucketOf = (index: number, instance: string | null): InstanceDailyStats => {
    const latest = current.get(index) ?? null;
    const replaced = instance !== null && latest !== null && instance !== latest;
    const key = replaced ? `${index}@${instance}` : String(index);
    let bucket = day.byInstance[key];
    if (!bucket) {
      bucket = emptyInstanceDailyStats(index, key);
      bucket.instanceCreatedAt = replaced ? instance : latest;
      bucket.replaced = replaced;
      day.byInstance[key] = bucket;
    }
    return bucket;
  };

  const openPauses = new Map<number, number>();
  const snapshots: ResourceSnapshot[] = [];

  for (const fact of own) {
    // Pause time belongs to the index (the auto switch is per index), counted in its current bucket.
    const pauseFact = fact.kind === 'paused' || fact.kind === 'resumed' || fact.kind === 'pauseCarry';
    const bucket = bucketOf(fact.index, pauseFact ? null : fact.instance);
    // ★ A pause fact lands in the index's current bucket whatever AVD raised it: it names that bucket's account only
    //   when it came from that same AVD, so a recreated instance never borrows the old one's account.
    if (fact.account !== null && (!pauseFact || fact.instance === bucket.instanceCreatedAt)) bucket.accountName = fact.account;
    switch (fact.kind) {
      case 'dispatch':
        addDispatch(day.byResource[fact.resource], fact.storage);
        addDispatch(bucket.byResource[fact.resource], fact.storage);
        day.dispatches += 1;
        bucket.dispatches += 1;
        break;
      case 'cycleFailed':
        if (fact.outcome === 'circuitBroken') { day.circuitBreaks += 1; bucket.circuitBreaks += 1; }
        else { day.failures += 1; bucket.failures += 1; }
        break;
      case 'tripCompleted':
        day.byResource[fact.resource].completed += 1;
        bucket.byResource[fact.resource].completed += 1;
        break;
      case 'alertRaised':
        day.alerts += 1;
        bucket.alerts += 1;
        break;
      case 'pauseCarry':
        if (!openPauses.has(fact.index)) openPauses.set(fact.index, Math.max(dayStart, fact.at));
        break;
      case 'paused':
        if (!openPauses.has(fact.index)) openPauses.set(fact.index, fact.at);
        break;
      case 'resumed': {
        const since = openPauses.get(fact.index);
        if (since === undefined) break;
        const span = Math.max(0, fact.at - since);
        bucket.pausedMs += span;
        day.pausedMs += span;
        openPauses.delete(fact.index);
        break;
      }
      case 'snapshot':
        snapshots.push(fact.snapshot);
        break;
      default: {
        // Exhaustive: a new fact kind fails to compile here until it is counted.
        const never: never = fact;
        void never;
      }
    }
    day.updatedAt = Math.max(day.updatedAt, fact.at);
  }

  const live = dateKey >= cstDateKey(now);
  for (const [index, since] of openPauses) {
    const bucket = bucketOf(index, null);
    if (live) {
      bucket.pausedSince = since;
    } else {
      // A past day never keeps an open pause: it ends at 24:00 (the next day carries it on from 00:00).
      const span = Math.max(0, dayEnd - since);
      bucket.pausedMs += span;
      day.pausedMs += span;
    }
  }

  const seen = new Set<string>();
  day.snapshots = sortFacts(snapshots).filter((snap) => {
    const key = `${snap.instanceIndex}:${snap.at}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(-STATS_SNAPSHOTS_PER_DAY);
  return day;
}

/** Nothing worth showing (original isDayEmpty): no counter, no pause (open or closed), no trip, no snapshot. */
export function isDayEmpty(day: DailyStats): boolean {
  if (day.dispatches || day.failures || day.circuitBreaks || day.alerts || day.pausedMs || day.snapshots.length > 0) return false;
  for (const inst of Object.values(day.byInstance)) {
    if (inst.pausedSince != null || inst.pausedMs || inst.dispatches || inst.failures || inst.alerts) return false;
    for (const t of RESOURCE_TYPES) if (inst.byResource[t].completed) return false;
  }
  for (const t of RESOURCE_TYPES) if (day.byResource[t].completed) return false;
  return true;
}
