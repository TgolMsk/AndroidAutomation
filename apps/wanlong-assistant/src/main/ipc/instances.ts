import type { InstancesApi } from '../../shared/ipc';
import type { DomainHandlers } from './types';

/** Services the instances handlers need; the module that fills `InstancesApi` adds them here. */
export interface InstancesServices {}

export const instancesHandlers: DomainHandlers<InstancesApi, InstancesServices> = {};
