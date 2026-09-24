import type { UpdateApi } from '../../shared/ipc';
import type { DomainHandlers } from './types';

/** Services the update handlers need; the module that fills `UpdateApi` adds them here. */
export interface UpdateServices {}

export const updateHandlers: DomainHandlers<UpdateApi, UpdateServices> = {};
