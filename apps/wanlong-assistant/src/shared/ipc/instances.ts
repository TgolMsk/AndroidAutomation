/** Assistant-side instance operations: base instance, batch clone and occupancy checks. */
import type { Assert, ListsExactly } from './contract';

/** No methods yet; the accounts-login / instances module adds them here (and to `INSTANCES_METHODS`). */
export interface InstancesApi {}

export const INSTANCES_METHODS = [] as const satisfies readonly (keyof InstancesApi)[];

/** No push events yet; the accounts-login / instances module adds them here (and to `INSTANCES_EVENTS`). */
export interface InstancesEvents {}

export const INSTANCES_EVENTS = [] as const satisfies readonly (keyof InstancesEvents)[];

export type InstancesContractCheck = [
  Assert<ListsExactly<InstancesApi, typeof INSTANCES_METHODS>>,
  Assert<ListsExactly<InstancesEvents, typeof INSTANCES_EVENTS>>,
];
