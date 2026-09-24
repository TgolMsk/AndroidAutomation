import type { ResourcesApi } from '../../shared/ipc';
import type { DomainHandlers } from './types';

/** Services the resources handlers need; the module that fills `ResourcesApi` adds them here. */
export interface ResourcesServices {}

export const resourcesHandlers: DomainHandlers<ResourcesApi, ResourcesServices> = {};
