/** Reading the in-game resource statistics table (道具 → 资源统计). */
import type { Assert, ListsExactly } from './contract';

/** No methods yet; the resources module adds them here (and to `RESOURCES_METHODS`). */
export interface ResourcesApi {}

export const RESOURCES_METHODS = [] as const satisfies readonly (keyof ResourcesApi)[];

/** No push events yet; the resources module adds them here (and to `RESOURCES_EVENTS`). */
export interface ResourcesEvents {}

export const RESOURCES_EVENTS = [] as const satisfies readonly (keyof ResourcesEvents)[];

export type ResourcesContractCheck = [
  Assert<ListsExactly<ResourcesApi, typeof RESOURCES_METHODS>>,
  Assert<ListsExactly<ResourcesEvents, typeof RESOURCES_EVENTS>>,
];
