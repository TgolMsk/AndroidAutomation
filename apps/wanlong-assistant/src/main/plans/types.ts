import type { MatchResult, RawFrame } from '@avdm/automation';
import type {
  AiAssistResult, LogEntry, LogLevel, RunSnapshot, ScriptParamValue, ShotPolicy,
} from '@avdm/automation/script';
import type { GameAccount } from '../automation/accounts/types';

/**
 * The JSON script DSL lives in `@avdm/automation/script` (game agnostic, renderer safe); it is re-exported
 * here so existing imports keep working. Coordinates use the script's reference canvas.
 */
export type {
  AiAssistResult, AiConsultRequest, AndroidKey, Condition, FailPolicy, LogEntry, LogLevel, LogQuery, RunSnapshot, RunStats,
  RunStatus, ScriptDef, ScriptIssue, ScriptMeta, ScriptParamDef, ScriptParamValue, ScriptStep, ShotPolicy, StepBase, StepKind,
} from '@avdm/automation/script';

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
export interface PlanConfig {
  version: 1; enabled: boolean; catchUpMs: number; queueWaitMs: number; retry: number; retryDelayMs: number;
  /** Script runs across all instances at once (gather rounds not counted); default 4, range 1–16. */
  maxConcurrentScripts?: number;
}
export interface TaskRuntime { accountId: string; taskId: string; lastClaimedAt: number | null; lastStartedAt: number | null; lastEndedAt: number | null; lastResult: 'succeeded' | 'failed' | 'cancelled' | 'skipped' | null; lastError: string | null; runs: number; fails: number }
export interface PlanRun { runId: string; gameId: string; accountId: string; accountName: string; instanceIndex: number; taskId: string; scriptId: string; priority: number; status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'skipped'; queuedAt: number; startedAt: number | null; endedAt: number | null; message: string; stepId: string | null }
export interface PlanOverview { config: PlanConfig; plans: AccountPlan[]; runtime: TaskRuntime[]; runs: PlanRun[]; at: number }

/** App settings defaults for script matching (original `matchOnce`): see `PlanHostPort.matchDefaults`. */
export interface ScriptMatchDefaults {
  /** Threshold of templates that set none of their own. */
  threshold: number;
  /** Frame and template downsampling factor (1–4). */
  shrink: number;
}

/** The assistant resolves real devices through the emulator's public manager; tests inject this port. */
export interface ScriptDevice {
  screencapRaw(): Promise<RawFrame>;
  /** Unused by the script executor (shots are encoded from the last raw frame, never `screencap -p`). */
  screencapPng?(): Promise<Uint8Array>;
  foregroundPackage(): Promise<string | undefined>;
  tap(x: number, y: number): Promise<void>;
  swipe(x1: number, y1: number, x2: number, y2: number, durationMs: number): Promise<void>;
  keyevent(key: string): Promise<void>;
  /** beforeEach is called before every adb text/key subcommand. */
  text(value: string, beforeEach?: () => Promise<void>): Promise<void>;
  startApp(packageName: string): Promise<void>;
  stopApp(packageName: string): Promise<void>;
  shell(command: string, options?: { timeoutMs?: number }): Promise<string>;
  /** `adb install -r` (only the IME setup uses it). */
  install?(apkPaths: string[], options?: { grantAll?: boolean; timeoutMs?: number }): Promise<string>;
}
export interface PlanHostPort {
  accounts(gameId: string): Promise<GameAccount[]>;
  instance(index: number): Promise<{ status: string; record: { createdAt: string } }>;
  device(index: number): Promise<ScriptDevice>;
  templateDir(gameId: string, index: number): Promise<string>;
  gatherScheduleEnabled(gameId: string, index: number): Promise<boolean>;
  onRun?(run: PlanRun): void;
  /**
   * Scripts take priority over gathering (original plan rule 1): pause the instance's gather schedule for the
   * run and return the function that gives it back. Wired by the scheduler; without it a manual run refuses to
   * start while the instance's gather schedule is enabled.
   */
  suspendForScript?(gameId: string, index: number, reason: string): Promise<() => void>;
  /** Default trace-shot policy (the app settings' `shotPolicy`); `onFail` when absent. */
  shotPolicy?(): Promise<ShotPolicy> | ShotPolicy;
  /**
   * App settings defaults for script matching (`matchThreshold` / `shrink`): the hit threshold of templates without
   * their own (a step's own threshold still wins) and the frame / template downsampling factor. Absent = the
   * vision defaults (0.85, 1/2).
   */
  matchDefaults?(): Promise<ScriptMatchDefaults> | ScriptMatchDefaults;
}

// ── Script runs (execution monitor) ──────────────────────────────────────────

export type ScriptRunSource = 'plan' | 'manual';

/** One execution as the monitor shows it: the engine's snapshot plus where it came from. */
export interface ScriptRunSnapshot extends RunSnapshot {
  gameId: string;
  source: ScriptRunSource;
  /** Plan task id (plan runs only). */
  taskId: string | null;
  shotPolicy: ShotPolicy;
  /** Whole-run limit; null = unlimited. */
  maxRunMs: number | null;
}

/** Options of a manual run of any script on one instance. */
export interface ScriptRunOptions {
  /** Optional account: its script params apply and it must be bound to the instance and logged in. */
  accountId?: string;
  params?: Record<string, ScriptParamValue>;
  shotPolicy?: ShotPolicy;
  /** 0 = unlimited; default 60, at most 720. */
  maxRunMinutes?: number;
}

export interface RunLogQuery {
  runId: string;
  minLevel?: LogLevel;
  /** Only lines after this timestamp. */
  since?: number;
  instanceIndex?: number;
  /** Default 500, at most 5000. */
  limit?: number;
}

export interface RunLogSummary { runId: string; size: number; updatedAt: number }

/** `plan-run` push event: a live script snapshot, or a plan queue record that changed. */
export type PlanRunEvent =
  | { kind: 'snapshot'; snapshot: ScriptRunSnapshot }
  | { kind: 'plan'; run: PlanRun };

/** `run-logs` push event: one batch (≈ every 100 ms per run). */
export interface RunLogsEvent { gameId: string; runId: string; entries: LogEntry[] }

/** `run-matches` push event: template matches of a run whose debug overlay is on (≤ 3/s). */
export interface RunMatchesEvent { gameId: string; runId: string; instanceIndex: number; results: MatchResult[] }

/** Whether an instance can type non-ASCII text (ADBKeyboard installed, enabled and selected). */
export interface ImeStatus {
  index: number;
  installed: boolean;
  enabled: boolean;
  selected: boolean;
  /** installed && enabled && selected. */
  available: boolean;
  message: string;
}

/** What the executor asks the AI advisor when a step exhausted its retries (wired by the ai module). */
export interface ScriptAiRequest {
  gameId: string;
  runId: string;
  instanceIndex: number;
  scriptId: string;
  templateSetId: string | null;
  templateDir: string | null;
  stepId: string | null;
  reason: string;
  expectTemplateIds: string[];
  /**
   * Aborted when the run is stopped (user stop, whole-run limit, shutdown) or ends: from then on the advisor must
   * not touch the device. The run's lease waits for the handler, at most a few seconds after the abort.
   */
  signal: AbortSignal;
}

/**
 * Should not throw (the runner answers the worker even if it does). Runs inside the run's device queue, so the
 * handler may use the instance while the worker waits; it is bounded by 180 s.
 */
export type ScriptAiAssist = (request: ScriptAiRequest) => Promise<AiAssistResult>;
