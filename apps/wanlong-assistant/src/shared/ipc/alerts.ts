/** Failure detection, automatic pauses, pause history and push notification settings. */
import type { Assert, ListsExactly } from './contract';

/** No methods yet; the alerts module adds them here (and to `ALERTS_METHODS`). */
export interface AlertsApi {}

export const ALERTS_METHODS = [] as const satisfies readonly (keyof AlertsApi)[];

/** No push events yet; the alerts module adds them here (and to `ALERTS_EVENTS`). */
export interface AlertsEvents {}

export const ALERTS_EVENTS = [] as const satisfies readonly (keyof AlertsEvents)[];

export type AlertsContractCheck = [
  Assert<ListsExactly<AlertsApi, typeof ALERTS_METHODS>>,
  Assert<ListsExactly<AlertsEvents, typeof ALERTS_EVENTS>>,
];
