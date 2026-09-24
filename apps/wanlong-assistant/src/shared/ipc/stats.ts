/** Daily statistics by Beijing date: dispatches, estimated harvest, failures, pauses and snapshots. */
import type { Assert, ListsExactly } from './contract';

/** No methods yet; the stats module adds them here (and to `STATS_METHODS`). */
export interface StatsApi {}

export const STATS_METHODS = [] as const satisfies readonly (keyof StatsApi)[];

/** No push events yet; the stats module adds them here (and to `STATS_EVENTS`). */
export interface StatsEvents {}

export const STATS_EVENTS = [] as const satisfies readonly (keyof StatsEvents)[];

export type StatsContractCheck = [
  Assert<ListsExactly<StatsApi, typeof STATS_METHODS>>,
  Assert<ListsExactly<StatsEvents, typeof STATS_EVENTS>>,
];
