/** Wanlong Assistant's IPC contract. The emulator contract remains game agnostic. */
import type { MatchResult, Rect, TemplateDraft, TemplateSaveResult, TemplateSet } from '@avdm/automation';
import type { AvdmApi, AvdmEvents } from '@avdm/emulator-shell/shared/ipc';
import type { AccountDetails, AccountLoginCommand, AccountLoginSession, GameAccount } from '../main/automation/accounts/types';
import type { AdvisorConfigPatch, AdvisorConfigView, AdvisorRecord, AdvisorStatus, AdvisorTestResult } from '../main/automation/advisor/types';
import type { InsightAlert, InsightDay, NotificationConfigPatch, NotificationConfigView, NotificationTestResult, RemoteBotConfigPatch, RemoteBotConfigView, RemoteBotTestResult } from '../main/automation/insights/contracts';
import type { AccountPlan, PlanConfig, PlanOverview, PlanRun, ScriptDef, ScriptIssue, ScriptMeta } from '../main/plans/types';

export interface AutomationGameSummary {
  id: string;
  name: string;
  version: string;
  packageName: string;
  tasks: { id: string; name: string; description: string }[];
}

export interface AutomationSettings {
  templateDir: string;
  /** Game-owned configuration, normalized before a task starts. */
  config: Record<string, unknown>;
}

export interface AutomationProbeMatch {
  templateId: string;
  found: boolean;
  score: number;
  threshold: number;
  x: number;
  y: number;
  w: number;
  h: number;
  reason?: string;
}

export interface AutomationProbeReport {
  gameId: string;
  packageName: string;
  foregroundPackage: string | null;
  deviceWidth: number;
  deviceHeight: number;
  capturedAt: number;
  matches: AutomationProbeMatch[];
  launchReady: boolean;
  launchReason: string;
  timingsMs: Record<string, number>;
}

export interface AutomationSchedule {
  gameId: string;
  index: number;
  enabled: boolean;
  nextWakeAt: number | null;
  failureCount: number;
}

export interface AutomationRun {
  runId: string;
  gameId: string;
  taskId: string;
  index: number;
  status: 'running' | 'stopping' | 'succeeded' | 'failed' | 'cancelled';
  startedAt: number;
  endedAt: number | null;
  message: string;
  nextWakeAt?: number | null;
}

export interface TemplateCapture {
  png: Uint8Array;
  width: number;
  height: number;
  capturedAt: number;
  foregroundPackage: string | null;
}

export interface TemplateTestResult {
  match: MatchResult;
  preview: TemplateCapture;
}

export interface TemplateAlphaPreview {
  alphaPng: Uint8Array;
  previewPng: Uint8Array;
  coverage: number;
}

export interface WanlongEvents {
  'automation-run': AutomationRun;
  'automation-schedule': AutomationSchedule;
}

/** The Assistant can call the emulator's published API plus its own game services. */
export interface WanlongApi extends AvdmApi {
  automationGames(): Promise<AutomationGameSummary[]>;
  pickAutomationTemplateSet(): Promise<string | null>;
  getAutomationSettings(gameId: string, index: number): Promise<AutomationSettings>;
  saveAutomationSettings(gameId: string, index: number, patch: Partial<AutomationSettings>): Promise<AutomationSettings>;
  probeAutomation(gameId: string, index: number): Promise<AutomationProbeReport>;
  runAutomation(gameId: string, taskId: string, index: number): Promise<AutomationRun>;
  stopAutomation(runId: string): Promise<void>;
  automationRuns(): Promise<AutomationRun[]>;
  automationSchedules(): Promise<AutomationSchedule[]>;
  setAutomationSchedule(gameId: string, index: number, enabled: boolean): Promise<AutomationSchedule>;

  automationTemplateSets(gameId: string): Promise<TemplateSet[]>;
  createAutomationTemplateSet(gameId: string, index: number, name: string): Promise<TemplateSet>;
  automationTemplateSet(gameId: string, index: number): Promise<TemplateSet | null>;
  automationTemplateImage(gameId: string, index: number, id: string): Promise<Uint8Array>;
  captureAutomationTemplate(gameId: string, index: number): Promise<TemplateCapture>;
  previewAutomationTemplateAlpha(gameId: string, index: number, frames: Uint8Array[], crop: Rect, tolerance: number): Promise<TemplateAlphaPreview>;
  saveAutomationTemplate(gameId: string, index: number, draft: TemplateDraft): Promise<TemplateSaveResult>;
  deleteAutomationTemplate(gameId: string, index: number, id: string): Promise<void>;
  testAutomationTemplate(gameId: string, index: number, id: string): Promise<TemplateTestResult>;

  accountList(gameId: string): Promise<GameAccount[]>;
  accountCreate(gameId: string, details: AccountDetails): Promise<GameAccount>;
  accountUpdate(id: string, patch: Partial<AccountDetails>): Promise<GameAccount>;
  accountDelete(id: string): Promise<void>;
  accountBind(id: string, index: number | null): Promise<GameAccount>;
  accountSetEnabled(id: string, enabled: boolean): Promise<GameAccount>;
  accountBeginLogin(gameId: string, index: number, id: string): Promise<AccountLoginSession>;
  accountLoginSession(index: number): Promise<AccountLoginSession | null>;
  accountLoginCommand(sessionId: string, command: AccountLoginCommand): Promise<AccountLoginSession>;
  accountVerifyLogin(sessionId: string, identityConfirmed: boolean): Promise<AccountLoginSession>;
  accountCancelLogin(sessionId: string): Promise<void>;

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

  insightDays(gameId: string, index: number | null, days?: number): Promise<InsightDay[]>;
  insightAlerts(gameId: string, index: number | null, limit?: number): Promise<InsightAlert[]>;
  getNotificationConfig(gameId: string, index: number): Promise<NotificationConfigView>;
  saveNotificationConfig(gameId: string, index: number, patch: NotificationConfigPatch): Promise<NotificationConfigView>;
  testNotification(gameId: string, index: number, channel: 'local' | 'telegram'): Promise<NotificationTestResult>;
  remoteBotConfig(): Promise<RemoteBotConfigView>;
  saveRemoteBotConfig(patch: RemoteBotConfigPatch): Promise<RemoteBotConfigView>;
  testRemoteBot(): Promise<RemoteBotTestResult>;

  advisorConfig(): Promise<AdvisorConfigView>;
  saveAdvisorConfig(patch: AdvisorConfigPatch): Promise<AdvisorConfigView>;
  advisorStatus(): Promise<AdvisorStatus>;
  advisorHistory(limit?: number): Promise<AdvisorRecord[]>;
  testAdvisor(): Promise<AdvisorTestResult>;
  consultAdvisor(gameId: string, index: number): Promise<AdvisorRecord>;

  on<C extends keyof (AvdmEvents & WanlongEvents)>(channel: C, listener: (payload: (AvdmEvents & WanlongEvents)[C]) => void): () => void;
}

export type WanlongInvokeMethod = Exclude<keyof WanlongApi, keyof AvdmApi>;

export const WANLONG_INVOKE_METHODS: WanlongInvokeMethod[] = [
  'automationGames', 'pickAutomationTemplateSet', 'getAutomationSettings', 'saveAutomationSettings',
  'probeAutomation', 'runAutomation', 'stopAutomation', 'automationRuns', 'automationSchedules', 'setAutomationSchedule',
  'automationTemplateSets', 'createAutomationTemplateSet', 'automationTemplateSet', 'automationTemplateImage',
  'captureAutomationTemplate', 'previewAutomationTemplateAlpha', 'saveAutomationTemplate', 'deleteAutomationTemplate',
  'testAutomationTemplate',
  'accountList', 'accountCreate', 'accountUpdate', 'accountDelete', 'accountBind', 'accountSetEnabled',
  'accountBeginLogin', 'accountLoginSession', 'accountLoginCommand', 'accountVerifyLogin', 'accountCancelLogin',
  'planOverview', 'planSaveConfig', 'planSave', 'planRunNow', 'planCancelRun',
  'scriptList', 'scriptGet', 'scriptValidate', 'scriptSave', 'scriptDelete',
  'insightDays', 'insightAlerts', 'getNotificationConfig', 'saveNotificationConfig', 'testNotification',
  'remoteBotConfig', 'saveRemoteBotConfig', 'testRemoteBot',
  'advisorConfig', 'saveAdvisorConfig', 'advisorStatus', 'advisorHistory', 'testAdvisor', 'consultAdvisor',
];

export const WANLONG_EVENT_CHANNEL = 'wanlong:event';
export const wanlongInvokeChannel = (method: WanlongInvokeMethod): string => `wanlong:${method}`;
