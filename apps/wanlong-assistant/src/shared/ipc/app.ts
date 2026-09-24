/** Assistant application settings, data paths, self-check, logs and legacy data import. */
import type { Assert, ListsExactly } from './contract';

/** No methods yet; the app-shell module adds them here (and to `APP_METHODS`). */
export interface AppApi {}

export const APP_METHODS = [] as const satisfies readonly (keyof AppApi)[];

/** No push events yet; the app-shell module adds them here (and to `APP_EVENTS`). */
export interface AppEvents {}

export const APP_EVENTS = [] as const satisfies readonly (keyof AppEvents)[];

export type AppContractCheck = [
  Assert<ListsExactly<AppApi, typeof APP_METHODS>>,
  Assert<ListsExactly<AppEvents, typeof APP_EVENTS>>,
];
