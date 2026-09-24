/** ETA scheduler: queue snapshots, immediate samples, pause and resume. */
import type { Assert, ListsExactly } from './contract';

/** No methods yet; the scheduler module adds them here (and to `SCHEDULER_METHODS`). */
export interface SchedulerApi {}

export const SCHEDULER_METHODS = [] as const satisfies readonly (keyof SchedulerApi)[];

/** No push events yet; the scheduler module adds them here (and to `SCHEDULER_EVENTS`). */
export interface SchedulerEvents {}

export const SCHEDULER_EVENTS = [] as const satisfies readonly (keyof SchedulerEvents)[];

export type SchedulerContractCheck = [
  Assert<ListsExactly<SchedulerApi, typeof SCHEDULER_METHODS>>,
  Assert<ListsExactly<SchedulerEvents, typeof SCHEDULER_EVENTS>>,
];
