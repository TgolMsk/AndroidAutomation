import type { SchedulerApi } from '../../shared/ipc';
import type { DomainHandlers } from './types';

/** Services the scheduler handlers need; the module that fills `SchedulerApi` adds them here. */
export interface SchedulerServices {}

export const schedulerHandlers: DomainHandlers<SchedulerApi, SchedulerServices> = {};
