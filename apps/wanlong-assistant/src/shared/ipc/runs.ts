/** Script run monitoring: manual runs, live snapshots, pause / resume / stop, run logs, trace shots, input method. */
import type { LogEntry } from '@avdm/automation/script';
import type {
  ImeStatus, PlanRunEvent, RunLogQuery, RunLogsEvent, RunMatchesEvent, ScriptRunOptions, ScriptRunSnapshot,
} from '../../main/plans/types';
import type { Assert, ListsExactly } from './contract';

export interface RunsApi {
  /** Run any script on one instance now (account optional); resolves once admitted, with the `starting` snapshot. */
  scriptRun(gameId: string, index: number, scriptId: string, options?: ScriptRunOptions): Promise<ScriptRunSnapshot>;
  /** Active and recently finished script runs of the game (in memory, newest first). */
  runList(gameId: string): Promise<ScriptRunSnapshot[]>;
  /** Pause at the next step boundary (the instance stays reserved; pause time counts toward the run limit). */
  runPause(gameId: string, runId: string): Promise<void>;
  runResume(gameId: string, runId: string): Promise<void>;
  /** Stop a queued, running or paused run (a running step finishes first). */
  runStop(gameId: string, runId: string): Promise<void>;
  /** Stored log lines of one run (newest `limit`, in time order). */
  runLogs(gameId: string, query: RunLogQuery): Promise<LogEntry[]>;
  /** A trace shot (`LogEntry.shot`) as JPEG/PNG bytes. */
  runShot(gameId: string, runId: string, shot: string): Promise<Uint8Array>;
  /** Push this run's template matches as `run-matches` events (debug overlay). */
  runDebugMatches(gameId: string, runId: string, enabled: boolean): Promise<void>;
  /** Whether the instance can type non-ASCII text (ADBKeyboard). */
  imeStatus(index: number): Promise<ImeStatus>;
  /** Pick an ADBKeyboard APK, install it on the instance and enable it; null when the dialog was cancelled. */
  imeSetup(index: number): Promise<ImeStatus | null>;
}

export const RUNS_METHODS = [
  'scriptRun', 'runList', 'runPause', 'runResume', 'runStop', 'runLogs', 'runShot', 'runDebugMatches', 'imeStatus', 'imeSetup',
] as const satisfies readonly (keyof RunsApi)[];

export interface RunsEvents {
  /** A script run snapshot changed (≤ 4/s per run), or a plan queue record changed. */
  'plan-run': PlanRunEvent;
  /** A batch of run log lines (≈ every 100 ms per run). */
  'run-logs': RunLogsEvent;
  /** Template matches of a run whose debug overlay is on (≤ 3/s). */
  'run-matches': RunMatchesEvent;
}

export const RUNS_EVENTS = ['plan-run', 'run-logs', 'run-matches'] as const satisfies readonly (keyof RunsEvents)[];

export type RunsContractCheck = [
  Assert<ListsExactly<RunsApi, typeof RUNS_METHODS>>,
  Assert<ListsExactly<RunsEvents, typeof RUNS_EVENTS>>,
];
