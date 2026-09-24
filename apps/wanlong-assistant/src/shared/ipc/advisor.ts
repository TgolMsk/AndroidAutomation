/** AI advisor: configuration, status, history, connection test and manual consults. */
import type { AdvisorConfigPatch, AdvisorConfigView, AdvisorRecord, AdvisorStatus, AdvisorTestResult } from '../../main/automation/advisor/types';
import type { Assert, ListsExactly } from './contract';

export interface AdvisorApi {
  advisorConfig(): Promise<AdvisorConfigView>;
  saveAdvisorConfig(patch: AdvisorConfigPatch): Promise<AdvisorConfigView>;
  advisorStatus(): Promise<AdvisorStatus>;
  advisorHistory(limit?: number): Promise<AdvisorRecord[]>;
  testAdvisor(): Promise<AdvisorTestResult>;
  consultAdvisor(gameId: string, index: number): Promise<AdvisorRecord>;
}

export const ADVISOR_METHODS = [
  'advisorConfig', 'saveAdvisorConfig', 'advisorStatus', 'advisorHistory', 'testAdvisor', 'consultAdvisor',
] as const satisfies readonly (keyof AdvisorApi)[];

/** No push events yet; the ai module adds them here (and to `ADVISOR_EVENTS`). */
export interface AdvisorEvents {}

export const ADVISOR_EVENTS = [] as const satisfies readonly (keyof AdvisorEvents)[];

export type AdvisorContractCheck = [
  Assert<ListsExactly<AdvisorApi, typeof ADVISOR_METHODS>>,
  Assert<ListsExactly<AdvisorEvents, typeof ADVISOR_EVENTS>>,
];
