/** Script run monitoring: active runs, step logs, match records and run screenshots. */
import type { Assert, ListsExactly } from './contract';

/** No methods yet; the script-engine module adds them here (and to `RUNS_METHODS`). */
export interface RunsApi {}

export const RUNS_METHODS = [] as const satisfies readonly (keyof RunsApi)[];

/** No push events yet; the script-engine module adds them here (and to `RUNS_EVENTS`). */
export interface RunsEvents {}

export const RUNS_EVENTS = [] as const satisfies readonly (keyof RunsEvents)[];

export type RunsContractCheck = [
  Assert<ListsExactly<RunsApi, typeof RUNS_METHODS>>,
  Assert<ListsExactly<RunsEvents, typeof RUNS_EVENTS>>,
];
