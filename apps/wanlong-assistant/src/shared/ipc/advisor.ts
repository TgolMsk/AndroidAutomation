/** AI advisor: configuration, status, history, connection test and manual consults, plus its push events. */
import type { AdvisorConfigPatch, AdvisorConfigView, AdvisorRecord, AdvisorStatus, AdvisorTestResult } from '../ai';
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

/** Original `ai:configChanged` / `ai:consulted`. The config push is the masked view only (never the key). */
export interface AdvisorEvents {
  'ai-config-changed': AdvisorConfigView;
  /** Every record, blocked or skipped ones included (the AI page inserts it and refreshes the status line). */
  'ai-consulted': AdvisorRecord;
}

export const ADVISOR_EVENTS = ['ai-config-changed', 'ai-consulted'] as const satisfies readonly (keyof AdvisorEvents)[];

export type AdvisorContractCheck = [
  Assert<ListsExactly<AdvisorApi, typeof ADVISOR_METHODS>>,
  Assert<ListsExactly<AdvisorEvents, typeof ADVISOR_EVENTS>>,
];
