import type { StatsApi } from '../../shared/ipc';
import type { DomainHandlers } from './types';

/** Services the stats handlers need; the module that fills `StatsApi` adds them here. */
export interface StatsServices {}

export const statsHandlers: DomainHandlers<StatsApi, StatsServices> = {};
