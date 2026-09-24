/** Task plans (accounts × scripts × Beijing-time triggers) and the script library. */
import type { ScriptDef, ScriptIssue, ScriptMeta } from '../../main/plans/types';
import type { AccountPlan, PlanConfig, PlanConfigEvent, PlanOverview, PlanRun } from '../plan';
import type { Assert, ListsExactly } from './contract';

export interface PlansApi {
  /** Plan table, runtime, run history and the flattened rows / queues of the 任务计划 page (original plan:state). */
  planOverview(gameId: string): Promise<PlanOverview>;
  planSaveConfig(gameId: string, patch: Partial<PlanConfig>): Promise<PlanConfig>;
  /** Whole-plan overwrite of one account (the task dialog). */
  planSave(gameId: string, plan: AccountPlan): Promise<AccountPlan>;
  /** 「立即运行」: queued like a due run (preemption included); a task already queued or running is refused. */
  planRunNow(gameId: string, accountId: string, taskId: string): Promise<PlanRun>;
  /** Stop by run id (执行监控): dequeue a queued run, stop a running one. */
  planCancelRun(gameId: string, runId: string): Promise<void>;
  scriptList(gameId: string): Promise<ScriptMeta[]>;
  scriptGet(gameId: string, id: string): Promise<ScriptDef>;
  /** With an instance, missing templates and a template-set canvas mismatch are reported too. */
  scriptValidate(gameId: string, raw: unknown, index?: number | null): Promise<ScriptIssue[]>;
  scriptSave(gameId: string, raw: unknown): Promise<ScriptMeta>;
  scriptDelete(gameId: string, id: string): Promise<void>;
  /** One account's plan; an empty, disabled one when it has none (original plan:get). */
  planGet(gameId: string, accountId: string): Promise<AccountPlan>;
  /** The row's checkbox only (original plan:setTaskEnabled); off takes a queued round off the queue at once. */
  planSetTaskEnabled(gameId: string, accountId: string, taskId: string, enabled: boolean): Promise<PlanOverview>;
  /** The account switch (original plan:setAccountEnabled); creates the plan when missing. */
  planSetAccountEnabled(gameId: string, accountId: string, enabled: boolean): Promise<PlanOverview>;
  /** Stop by task (original plan:cancel): dequeue, stop the running one, drop a pending retry. */
  planCancel(gameId: string, accountId: string, taskId: string): Promise<PlanOverview>;
  /** Delete one task (works for a plan whose account was deleted too). */
  planRemoveTask(gameId: string, accountId: string, taskId: string): Promise<PlanOverview>;
  /** Original plan:config. */
  planConfig(gameId: string): Promise<PlanConfig>;
}

export const PLANS_METHODS = [
  'planOverview', 'planSaveConfig', 'planSave', 'planRunNow', 'planCancelRun',
  'scriptList', 'scriptGet', 'scriptValidate', 'scriptSave', 'scriptDelete',
  'planGet', 'planSetTaskEnabled', 'planSetAccountEnabled', 'planCancel', 'planRemoveTask', 'planConfig',
] as const satisfies readonly (keyof PlansApi)[];

export interface PlansEvents {
  /** The plan table or its runtime changed (due, queued, started, ended, switches, saves) — original plan:changed. */
  'plan-changed': PlanOverview;
  /** The plan config was saved — original plan:configChanged. */
  'plan-config-changed': PlanConfigEvent;
}

export const PLANS_EVENTS = ['plan-changed', 'plan-config-changed'] as const satisfies readonly (keyof PlansEvents)[];

export type PlansContractCheck = [
  Assert<ListsExactly<PlansApi, typeof PLANS_METHODS>>,
  Assert<ListsExactly<PlansEvents, typeof PLANS_EVENTS>>,
];
