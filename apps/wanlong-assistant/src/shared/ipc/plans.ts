/** Task plans (accounts × scripts × Beijing-time triggers) and the script library. */
import type { AccountPlan, PlanConfig, PlanOverview, PlanRun, ScriptDef, ScriptIssue, ScriptMeta } from '../../main/plans/types';
import type { Assert, ListsExactly } from './contract';

export interface PlansApi {
  planOverview(gameId: string): Promise<PlanOverview>;
  planSaveConfig(gameId: string, patch: Partial<PlanConfig>): Promise<PlanConfig>;
  planSave(gameId: string, plan: AccountPlan): Promise<AccountPlan>;
  planRunNow(gameId: string, accountId: string, taskId: string): Promise<PlanRun>;
  planCancelRun(gameId: string, runId: string): Promise<void>;
  scriptList(gameId: string): Promise<ScriptMeta[]>;
  scriptGet(gameId: string, id: string): Promise<ScriptDef>;
  scriptValidate(gameId: string, raw: unknown): Promise<ScriptIssue[]>;
  scriptSave(gameId: string, raw: unknown): Promise<ScriptMeta>;
  scriptDelete(gameId: string, id: string): Promise<void>;
}

export const PLANS_METHODS = [
  'planOverview', 'planSaveConfig', 'planSave', 'planRunNow', 'planCancelRun',
  'scriptList', 'scriptGet', 'scriptValidate', 'scriptSave', 'scriptDelete',
] as const satisfies readonly (keyof PlansApi)[];

/** No push events yet; the plans module adds them here (and to `PLANS_EVENTS`), e.g. `'plan-run'`. */
export interface PlansEvents {}

export const PLANS_EVENTS = [] as const satisfies readonly (keyof PlansEvents)[];

export type PlansContractCheck = [
  Assert<ListsExactly<PlansApi, typeof PLANS_METHODS>>,
  Assert<ListsExactly<PlansEvents, typeof PLANS_EVENTS>>,
];
