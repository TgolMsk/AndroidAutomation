import type { Point, Rect, RawFrame } from '@avdm/automation';
import type { GameAccount } from '../automation/accounts/types';

/** JSON script format retained from wanlong-panel. Coordinates use the script's reference canvas. */
export type Condition =
  | { kind: 'always' | 'never' }
  | { kind: 'foreground'; packageName: string; equals?: boolean }
  | { kind: 'template'; templateId: string; roi?: Rect; threshold?: number; present?: boolean }
  | { kind: 'anyTemplate'; templateIds: string[]; roi?: Rect; threshold?: number }
  | { kind: 'and'; all: Condition[] }
  | { kind: 'or'; any: Condition[] }
  | { kind: 'not'; of: Condition };

export type FailPolicy = { kind: 'abort' | 'continue' | 'restartApp' } | { kind: 'goto'; label: string };
export interface StepBase {
  id: string;
  name?: string;
  when?: Condition;
  timeoutMs?: number;
  retry?: number;
  retryDelayMs?: number;
  onFail?: FailPolicy;
  afterDelayMs?: number;
  capture?: boolean;
}
export type ScriptStep = StepBase & (
  | { kind: 'tap'; at: Point }
  | { kind: 'tapTemplate'; templateId: string; roi?: Rect; threshold?: number; offset?: Point; waitMs?: number; pollMs?: number }
  | { kind: 'waitFor'; cond: Condition; waitMs: number; pollMs?: number }
  | { kind: 'swipe'; from: Point; to: Point; durationMs?: number }
  | { kind: 'longPress'; at: Point; durationMs: number }
  | { kind: 'text'; text: string }
  | { kind: 'key'; key: 'BACK' | 'HOME' | 'ENTER' | 'MENU' | 'APP_SWITCH' | 'DEL' | 'ESCAPE' | 'VOLUME_UP' | 'VOLUME_DOWN' }
  | { kind: 'sleep'; ms: number }
  | { kind: 'launchApp'; packageName?: string; cold?: boolean }
  | { kind: 'stopApp'; packageName?: string }
  | { kind: 'screenshot'; label?: string }
  | { kind: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string }
  | { kind: 'label'; label: string }
  | { kind: 'goto'; label: string; maxTimes?: number }
  | { kind: 'if'; cond: Condition; then: ScriptStep[]; else?: ScriptStep[] }
  | { kind: 'loop'; steps: ScriptStep[]; repeat?: number; while?: Condition; maxIterations?: number }
);
export interface ScriptDef {
  id: string;
  name: string;
  description?: string;
  version: string;
  packageName?: string;
  templateSetId?: string;
  refWidth: number;
  refHeight: number;
  params?: Array<{ key: string; label: string; type: 'string' | 'number' | 'boolean' | 'enum'; options?: Array<{ value: string; label: string }>; default?: string | number | boolean; note?: string }>;
  steps: ScriptStep[];
  loop?: boolean;
  loopIntervalMs?: number;
  updatedAt: number;
}
export interface ScriptMeta { id: string; name: string; version: string; description?: string; stepCount: number; updatedAt: number }
export interface ScriptIssue { level: 'error' | 'warn'; stepId: string | null; message: string }

export type TaskTrigger = { kind: 'manual' } | { kind: 'daily'; at: string[] } | { kind: 'interval'; everyMinutes: number; window?: { from: string; to: string } };
export interface PlanTask {
  id: string;
  scriptId: string;
  enabled: boolean;
  trigger: TaskTrigger;
  priority: number;
  params?: Record<string, string | number | boolean>;
  maxRunMinutes: number;
  note?: string;
}
export interface AccountPlan { accountId: string; enabled: boolean; tasks: PlanTask[]; updatedAt: number }
export interface PlanConfig { version: 1; enabled: boolean; catchUpMs: number; queueWaitMs: number; retry: number; retryDelayMs: number }
export interface TaskRuntime { accountId: string; taskId: string; lastClaimedAt: number | null; lastStartedAt: number | null; lastEndedAt: number | null; lastResult: 'succeeded' | 'failed' | 'cancelled' | 'skipped' | null; lastError: string | null; runs: number; fails: number }
export interface PlanRun { runId: string; gameId: string; accountId: string; accountName: string; instanceIndex: number; taskId: string; scriptId: string; priority: number; status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'skipped'; queuedAt: number; startedAt: number | null; endedAt: number | null; message: string; stepId: string | null }
export interface PlanOverview { config: PlanConfig; plans: AccountPlan[]; runtime: TaskRuntime[]; runs: PlanRun[]; at: number }

/** The assistant resolves real devices through the emulator's public manager; tests inject this port. */
export interface ScriptDevice {
  screencapRaw(): Promise<RawFrame>;
  screencapPng(): Promise<Uint8Array>;
  foregroundPackage(): Promise<string | undefined>;
  tap(x: number, y: number): Promise<void>;
  swipe(x1: number, y1: number, x2: number, y2: number, durationMs: number): Promise<void>;
  keyevent(key: string): Promise<void>;
  /** beforeEach is called before every adb text/key subcommand. */
  text(value: string, beforeEach?: () => Promise<void>): Promise<void>;
  startApp(packageName: string): Promise<void>;
  stopApp(packageName: string): Promise<void>;
  shell(command: string, options?: { timeoutMs?: number }): Promise<string>;
}
export interface PlanHostPort {
  accounts(gameId: string): Promise<GameAccount[]>;
  instance(index: number): Promise<{ status: string; record: { createdAt: string } }>;
  device(index: number): Promise<ScriptDevice>;
  templateDir(gameId: string, index: number): Promise<string>;
  gatherScheduleEnabled(gameId: string, index: number): Promise<boolean>;
  onRun?(run: PlanRun): void;
}
