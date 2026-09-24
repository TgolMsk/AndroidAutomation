/**
 * Wanlong Assistant's IPC contract, aggregated from one file per domain under `./ipc/`. The emulator contract
 * (`AvdmApi`) remains game agnostic. Types and constants only.
 *
 * To add a method: declare it in the domain's `XxxApi`, append its name to `XXX_METHODS` (the compile-time
 * check in that file fails otherwise) and implement it in `src/main/ipc/<domain>.ts`. Nothing here changes.
 */
import type { AvdmApi, AvdmEvents } from '@avdm/emulator-shell/shared/ipc';
import { ACCOUNTS_EVENTS, ACCOUNTS_METHODS, type AccountsApi, type AccountsEvents } from './ipc/accounts';
import { ADVISOR_EVENTS, ADVISOR_METHODS, type AdvisorApi, type AdvisorEvents } from './ipc/advisor';
import { ALERTS_EVENTS, ALERTS_METHODS, type AlertsApi, type AlertsEvents } from './ipc/alerts';
import { APP_EVENTS, APP_METHODS, type AppApi, type AppEvents } from './ipc/app';
import { AUTOMATION_EVENTS, AUTOMATION_METHODS, type AutomationApi, type AutomationEvents } from './ipc/automation';
import { BOT_EVENTS, BOT_METHODS, type BotApi, type BotEvents } from './ipc/bot';
import type { Assert, EnvelopedApi, Exact, ListsExactly } from './ipc/contract';
import { INSIGHTS_EVENTS, INSIGHTS_METHODS, type InsightsApi, type InsightsEvents } from './ipc/insights';
import { INSTANCES_EVENTS, INSTANCES_METHODS, type InstancesApi, type InstancesEvents } from './ipc/instances';
import { PLANS_EVENTS, PLANS_METHODS, type PlansApi, type PlansEvents } from './ipc/plans';
import { RESOURCES_EVENTS, RESOURCES_METHODS, type ResourcesApi, type ResourcesEvents } from './ipc/resources';
import { RUNS_EVENTS, RUNS_METHODS, type RunsApi, type RunsEvents } from './ipc/runs';
import { SCHEDULER_EVENTS, SCHEDULER_METHODS, type SchedulerApi, type SchedulerEvents } from './ipc/scheduler';
import { STATS_EVENTS, STATS_METHODS, type StatsApi, type StatsEvents } from './ipc/stats';
import { TEMPLATES_EVENTS, TEMPLATES_METHODS, type TemplatesApi, type TemplatesEvents } from './ipc/templates';
import { UPDATE_EVENTS, UPDATE_METHODS, type UpdateApi, type UpdateEvents } from './ipc/update';

export * from './ipc/accounts';
export * from './ipc/advisor';
export * from './ipc/alerts';
export * from './ipc/app';
export * from './ipc/automation';
export * from './ipc/bot';
export * from './ipc/contract';
export * from './ipc/insights';
export * from './ipc/instances';
export * from './ipc/plans';
export * from './ipc/resources';
export * from './ipc/runs';
export * from './ipc/scheduler';
export * from './ipc/stats';
export * from './ipc/templates';
export * from './ipc/update';

/** Every assistant-only invoke method, grouped by domain. */
export interface WanlongDomainApi extends
  AutomationApi, TemplatesApi, AccountsApi, PlansApi, RunsApi, InsightsApi, StatsApi, AlertsApi, BotApi,
  ResourcesApi, AdvisorApi, SchedulerApi, InstancesApi, AppApi, UpdateApi {}

/** Every assistant push event (delivered on `wanlong:event`), grouped by domain. */
export interface WanlongEvents extends
  AutomationEvents, TemplatesEvents, AccountsEvents, PlansEvents, RunsEvents, InsightsEvents, StatsEvents, AlertsEvents,
  BotEvents, ResourcesEvents, AdvisorEvents, SchedulerEvents, InstancesEvents, AppEvents, UpdateEvents {}

export type WanlongEventChannel = keyof WanlongEvents;
/** Events the assistant renderer can subscribe to: the shell's plus its own. */
export type WanlongAllEvents = AvdmEvents & WanlongEvents;

/** The Assistant can call the emulator's published API plus its own game services. */
export interface WanlongApi extends AvdmApi, WanlongDomainApi {
  on<C extends keyof WanlongAllEvents>(channel: C, listener: (payload: WanlongAllEvents[C]) => void): () => void;
}

export type WanlongInvokeMethod = keyof WanlongDomainApi;

export const WANLONG_INVOKE_METHODS = [
  ...AUTOMATION_METHODS, ...TEMPLATES_METHODS, ...ACCOUNTS_METHODS, ...PLANS_METHODS, ...RUNS_METHODS,
  ...INSIGHTS_METHODS, ...STATS_METHODS, ...ALERTS_METHODS, ...BOT_METHODS, ...RESOURCES_METHODS,
  ...ADVISOR_METHODS, ...SCHEDULER_METHODS, ...INSTANCES_METHODS, ...APP_METHODS, ...UPDATE_METHODS,
] as const satisfies readonly WanlongInvokeMethod[];

/** Runtime list of every assistant event name (tests assert it never collides with the shell's `AvdmEvents`). */
export const WANLONG_EVENT_NAMES = [
  ...AUTOMATION_EVENTS, ...TEMPLATES_EVENTS, ...ACCOUNTS_EVENTS, ...PLANS_EVENTS, ...RUNS_EVENTS,
  ...INSIGHTS_EVENTS, ...STATS_EVENTS, ...ALERTS_EVENTS, ...BOT_EVENTS, ...RESOURCES_EVENTS,
  ...ADVISOR_EVENTS, ...SCHEDULER_EVENTS, ...INSTANCES_EVENTS, ...APP_EVENTS, ...UPDATE_EVENTS,
] as const satisfies readonly WanlongEventChannel[];

/** The preload's view of the API: shell methods throw as before, assistant methods resolve to envelopes. */
export interface WanlongBridge extends AvdmApi, EnvelopedApi<WanlongDomainApi> {
  on<C extends keyof WanlongAllEvents>(channel: C, listener: (payload: WanlongAllEvents[C]) => void): () => void;
}

/** The aggregated lists cover every domain method and event, and no assistant name shadows a shell name. */
export type WanlongContractCheck = [
  Assert<ListsExactly<WanlongDomainApi, typeof WANLONG_INVOKE_METHODS>>,
  Assert<ListsExactly<WanlongEvents, typeof WANLONG_EVENT_NAMES>>,
  Assert<Exact<Extract<keyof WanlongDomainApi, keyof AvdmApi>, never>>,
  Assert<Exact<Extract<keyof WanlongEvents, keyof AvdmEvents>, never>>,
];

export const WANLONG_EVENT_CHANNEL = 'wanlong:event';
export const wanlongInvokeChannel = (method: WanlongInvokeMethod): string => `wanlong:${method}`;
