import type { AppApi } from '../../shared/ipc';
import type { DomainHandlers } from './types';

/** Services the app handlers need; the module that fills `AppApi` adds them here. */
export interface AppServices {}

export const appHandlers: DomainHandlers<AppApi, AppServices> = {};
