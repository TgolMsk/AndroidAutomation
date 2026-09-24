/** Gather automation: game catalogue, per-instance settings, read-only probe, runs and auto-resume schedules. */
import type { Assert, ListsExactly } from './contract';

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
  /**
   * Set when `config` is the copy stored on the account bound to this instance (original
   * `Account.scriptParams.gather`): it is read and saved there and follows the account to another instance. Absent
   * for an instance without a current account, whose config lives in the instance's own settings file.
   */
  configAccount?: { id: string; name: string };
  /**
   * The instance's own config (no `configAccount`) was saved for another AVD that used to sit at this index: shown,
   * but flagged so the user checks and re-saves it (never inherited by index alone; binding does not move it).
   */
  configReplaced?: boolean;
  /**
   * The gather config stored on the bound account cannot be parsed (Chinese reason). `config` is then empty (the page
   * shows defaults) and saving writes a fresh copy to the account; runs refuse until then.
   */
  accountConfigError?: string;
  /**
   * The instance's own settings file cannot be read or is incompatible (Chinese reason). `templateDir` / `config` are
   * a salvage (the template set is kept when the file still names one); saving a gather config rebuilds the file.
   */
  settingsError?: string;
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

export interface AutomationApi {
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
}

export const AUTOMATION_METHODS = [
  'automationGames', 'pickAutomationTemplateSet', 'getAutomationSettings', 'saveAutomationSettings',
  'probeAutomation', 'runAutomation', 'stopAutomation', 'automationRuns', 'automationSchedules', 'setAutomationSchedule',
] as const satisfies readonly (keyof AutomationApi)[];

export interface AutomationEvents {
  'automation-run': AutomationRun;
  'automation-schedule': AutomationSchedule;
}

export const AUTOMATION_EVENTS = ['automation-run', 'automation-schedule'] as const satisfies readonly (keyof AutomationEvents)[];

export type AutomationContractCheck = [
  Assert<ListsExactly<AutomationApi, typeof AUTOMATION_METHODS>>,
  Assert<ListsExactly<AutomationEvents, typeof AUTOMATION_EVENTS>>,
];
