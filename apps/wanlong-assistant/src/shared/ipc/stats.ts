/** Daily statistics by Beijing date: dispatches, estimated harvest, failures, pauses and snapshots. */
import type { DailyStats, DateKey, ResourceSnapshot } from '../stats';
import type { Assert, ListsExactly } from './contract';

export type { DailyStats, DailyResourceStat, DateKey, InstanceDailyStats } from '../stats';

/** A resource-table snapshot was recorded (read from the page, the bot or another window). */
export interface StatsSnapshotPush {
  gameId: string;
  dateKey: DateKey;
  snapshot: ResourceSnapshot;
}

export interface StatsApi {
  /** One Beijing day; omitted (or null) = today. A day without data is an empty bucket, never null. */
  statsDaily(gameId: string, dateKey?: DateKey | null): Promise<DailyStats>;
  /** Every day in [from, to] (both included, at most 366); days without data are empty buckets. */
  statsRange(gameId: string, from: DateKey, to: DateKey): Promise<DailyStats[]>;
  /**
   * Read the in-game resource table of one instance now (the instance lock; refused while a script runs or the game is
   * not on the main screen) and record it as today's snapshot.
   */
  statsSnapshotNow(gameId: string, index: number): Promise<ResourceSnapshot>;
}

export const STATS_METHODS = ['statsDaily', 'statsRange', 'statsSnapshotNow'] as const satisfies readonly (keyof StatsApi)[];

export interface StatsEvents {
  /**
   * Today's bucket changed (throttled to at most one push per second). After Beijing midnight the push is the new,
   * empty day: the page follows it.
   */
  'stats-today': DailyStats;
  /** A snapshot was recorded into a day bucket. */
  'stats-snapshot': StatsSnapshotPush;
}

export const STATS_EVENTS = ['stats-today', 'stats-snapshot'] as const satisfies readonly (keyof StatsEvents)[];

export type StatsContractCheck = [
  Assert<ListsExactly<StatsApi, typeof STATS_METHODS>>,
  Assert<ListsExactly<StatsEvents, typeof STATS_EVENTS>>,
];
