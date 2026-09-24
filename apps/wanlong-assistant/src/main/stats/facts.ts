/**
 * The statistics ledger: one Beijing day = a list of facts. Buckets (`DailyStats`) are computed from the facts when
 * read (./aggregate.ts), so a repeated delivery never doubles a count (facts are keyed by `id`) and a pause across
 * midnight needs no stored running state. Facts are validated one by one when read: one bad record is skipped, it
 * never makes the whole day (or a 14-day range) unreadable.
 */
import { isResourceType, normalizeResourceSnapshot, type ResourceSnapshot, type ResourceType } from '@avdm/automation/wanlong/pure';

interface FactBase {
  /** Unique within the day; deterministic where the source has a natural key (snapshot, carry, migrated records). */
  id: string;
  at: number;
  index: number;
  /** Identity (`record.createdAt`) of the AVD at `index` when the fact was recorded; null when it could not be read. */
  instance: string | null;
  /** Name of the account bound to that AVD at the time; null when none. */
  account: string | null;
}

export interface DispatchFact extends FactBase {
  kind: 'dispatch';
  resource: ResourceType;
  storage: number | null;
  coord: string | null;
  level: number | null;
  travelTimeSec: number | null;
}

export interface CycleFailedFact extends FactBase {
  kind: 'cycleFailed';
  outcome: 'error' | 'circuitBroken';
  message: string;
  step: string | null;
  errorCode: string | null;
}

/** How a completed trip's resource was found (the original's resolution chain). */
export type TripResolution = 'event' | 'coord' | 'instanceTop' | 'globalTop';

export interface TripCompletedFact extends FactBase {
  kind: 'tripCompleted';
  coord: string | null;
  /** Always resolved when stored: a trip that cannot be attributed is dropped with a warning, never guessed. */
  resource: ResourceType;
  via: TripResolution;
}

export interface AlertRaisedFact extends FactBase {
  kind: 'alertRaised';
  alertType: string;
}

export interface PausedFact extends FactBase {
  kind: 'paused';
  reason: string | null;
}

export interface ResumedFact extends FactBase {
  kind: 'resumed';
}

/**
 * A pause still open at this day's Beijing midnight (at = the day start). Written at the rollover (and backfilled at
 * start for days the app was closed), so every day file is self-contained: a past day always closes its pauses at
 * 24:00 and never shows an open pause.
 */
export interface PauseCarryFact extends FactBase {
  kind: 'pauseCarry';
  /** When the pause really started (an earlier day). */
  since: number;
}

export interface SnapshotFact extends FactBase {
  kind: 'snapshot';
  snapshot: ResourceSnapshot;
}

export type StatsFact =
  | DispatchFact
  | CycleFailedFact
  | TripCompletedFact
  | AlertRaisedFact
  | PausedFact
  | ResumedFact
  | PauseCarryFact
  | SnapshotFact;

export type StatsFactKind = StatsFact['kind'];

export const FACT_KINDS: readonly StatsFactKind[] = [
  'dispatch', 'cycleFailed', 'tripCompleted', 'alertRaised', 'paused', 'resumed', 'pauseCarry', 'snapshot',
];

const TRIP_RESOLUTIONS: readonly TripResolution[] = ['event', 'coord', 'instanceTop', 'globalTop'];

/** Caps that keep one bad or oversized record from bloating a day file. */
export const FACT_LIMITS = {
  id: 160, instance: 64, account: 120, coord: 32, message: 300, step: 40, errorCode: 60, alertType: 60, reason: 200,
} as const;

/** Instance indices the assistant manages (same range as `asIndex`). */
export function validIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 63;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown, max: number): string | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return undefined;
  return value.length <= max ? value : undefined;
}

function nonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function optionalNumber(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return null;
  return nonNegative(value) ? value : undefined;
}

/** Cut a user-visible text to its storage cap. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * One stored record → a fact, or null when its shape is wrong (the caller skips it and warns once with a count).
 * Never throws.
 */
export function parseFact(value: unknown): StatsFact | null {
  if (!isRecord(value)) return null;
  const id = str(value['id'], FACT_LIMITS.id);
  const instance = str(value['instance'], FACT_LIMITS.instance);
  const account = str(value['account'], FACT_LIMITS.account);
  const at = value['at'];
  const index = value['index'];
  if (!id || instance === undefined || account === undefined || !nonNegative(at) || !validIndex(index)) return null;
  const base: FactBase = { id, at, index, instance, account };
  switch (value['kind']) {
    case 'dispatch': {
      const resource = value['resource'];
      const storage = optionalNumber(value['storage']);
      const coord = str(value['coord'], FACT_LIMITS.coord);
      const level = optionalNumber(value['level']);
      const travelTimeSec = optionalNumber(value['travelTimeSec']);
      if (!isResourceType(resource) || storage === undefined || coord === undefined || level === undefined || travelTimeSec === undefined) return null;
      return { ...base, kind: 'dispatch', resource, storage, coord, level, travelTimeSec };
    }
    case 'cycleFailed': {
      const outcome = value['outcome'];
      const message = str(value['message'], FACT_LIMITS.message);
      const step = str(value['step'], FACT_LIMITS.step);
      const errorCode = str(value['errorCode'], FACT_LIMITS.errorCode);
      if ((outcome !== 'error' && outcome !== 'circuitBroken') || message === undefined || step === undefined || errorCode === undefined) return null;
      return { ...base, kind: 'cycleFailed', outcome, message: message ?? '', step, errorCode };
    }
    case 'tripCompleted': {
      const coord = str(value['coord'], FACT_LIMITS.coord);
      const resource = value['resource'];
      const via = value['via'];
      if (coord === undefined || !isResourceType(resource) || !TRIP_RESOLUTIONS.includes(via as TripResolution)) return null;
      return { ...base, kind: 'tripCompleted', coord, resource, via: via as TripResolution };
    }
    case 'alertRaised': {
      const alertType = str(value['alertType'], FACT_LIMITS.alertType);
      if (!alertType) return null;
      return { ...base, kind: 'alertRaised', alertType };
    }
    case 'paused': {
      const reason = str(value['reason'], FACT_LIMITS.reason);
      if (reason === undefined) return null;
      return { ...base, kind: 'paused', reason };
    }
    case 'resumed':
      return { ...base, kind: 'resumed' };
    case 'pauseCarry': {
      const since = value['since'];
      if (!nonNegative(since) || since > at) return null;
      return { ...base, kind: 'pauseCarry', since };
    }
    case 'snapshot': {
      const snapshot = normalizeResourceSnapshot(value['snapshot']);
      if (!snapshot || snapshot.instanceIndex !== index) return null;
      return { ...base, kind: 'snapshot', snapshot };
    }
    default:
      return null;
  }
}

/** Parse a list of stored records, keeping the valid ones (first occurrence of an id wins). */
export function parseFacts(values: readonly unknown[]): { facts: StatsFact[]; skipped: number } {
  const facts: StatsFact[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const value of values) {
    const fact = parseFact(value);
    if (!fact) { skipped++; continue; }
    if (seen.has(fact.id)) continue;
    seen.add(fact.id);
    facts.push(fact);
  }
  return { facts, skipped };
}
