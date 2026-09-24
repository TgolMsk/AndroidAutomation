import type { AlertsApi } from '../../shared/ipc';
import type { DomainHandlers } from './types';

/** Services the alerts handlers need; the module that fills `AlertsApi` adds them here. */
export interface AlertsServices {}

export const alertsHandlers: DomainHandlers<AlertsApi, AlertsServices> = {};
