/** In-app update from GitHub Releases. */
import type { Assert, ListsExactly } from './contract';

/** No methods yet; the app-update module adds them here (and to `UPDATE_METHODS`). */
export interface UpdateApi {}

export const UPDATE_METHODS = [] as const satisfies readonly (keyof UpdateApi)[];

/** No push events yet; the app-update module adds them here (and to `UPDATE_EVENTS`). */
export interface UpdateEvents {}

export const UPDATE_EVENTS = [] as const satisfies readonly (keyof UpdateEvents)[];

export type UpdateContractCheck = [
  Assert<ListsExactly<UpdateApi, typeof UPDATE_METHODS>>,
  Assert<ListsExactly<UpdateEvents, typeof UPDATE_EVENTS>>,
];
