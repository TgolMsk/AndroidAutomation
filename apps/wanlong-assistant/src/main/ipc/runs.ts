import type { RunsApi } from '../../shared/ipc';
import type { DomainHandlers } from './types';

/** Services the runs handlers need; the module that fills `RunsApi` adds them here. */
export interface RunsServices {}

export const runsHandlers: DomainHandlers<RunsApi, RunsServices> = {};
