/**
 * Messages between ScriptRunner (main) and script-worker (worker thread). Types only.
 *
 * Lifecycle: start → (worker loads and compiles the referenced templates) → ready → main checks instance
 * identity, account and foreground → go → status / logs / requests … → finished → terminate.
 * The worker never touches adb or files: every device operation and every trace shot is a request that main
 * validates (identity + foreground before each input) and serializes.
 */
import type { AndroidKey, MatchResult, RawFrame } from '@avdm/automation';
import type { AiAssistResult, LogEntry, RunSnapshot, ScriptDef, ScriptParamValue, ShotPolicy } from '@avdm/automation/script';

export interface ScriptWorkerInput {
  runId: string;
  instanceIndex: number;
  script: ScriptDef;
  params: Record<string, ScriptParamValue>;
  accountId: string | null;
  accountName: string | null;
  /** Absolute template set directory of the instance, or null when none is configured. */
  templateDir: string | null;
  shotPolicy: ShotPolicy;
  maxRunMs: number | null;
  /** Relay failed steps to the AI advisor (aiConsult / aiResult). */
  consultAi: boolean;
  debugMatches: boolean;
  /** Trace shots already saved under this run id (a retried plan run continues the numbering). */
  shotSeqStart?: number;
  /** Pacing overrides (tests); defaults are the original 400 ms + 0–120 ms jitter. */
  minCaptureIntervalMs?: number;
  captureJitterMs?: number;
  restartGapMs?: number;
  restartSettleMs?: number;
}

export type ScriptDeviceRequest =
  | { type: 'request'; id: number; op: 'capture' | 'foregroundPackage'; args: [] }
  | { type: 'request'; id: number; op: 'tap'; args: [number, number] }
  | { type: 'request'; id: number; op: 'swipe'; args: [number, number, number, number, number] }
  | { type: 'request'; id: number; op: 'longPress'; args: [number, number, number] }
  | { type: 'request'; id: number; op: 'text'; args: [string] }
  | { type: 'request'; id: number; op: 'key'; args: [AndroidKey] }
  | { type: 'request'; id: number; op: 'launchApp'; args: [string, boolean] }
  | { type: 'request'; id: number; op: 'stopApp'; args: [string] }
  | { type: 'request'; id: number; op: 'shot'; args: [string, Uint8Array] };

export type ScriptDeviceOp = ScriptDeviceRequest['op'];

/** Operations that change the device (checked against the start gate and the foreground). */
export const INPUT_OPS: ReadonlySet<ScriptDeviceOp> = new Set(['tap', 'swipe', 'longPress', 'text', 'key', 'launchApp', 'stopApp']);

export type ScriptWorkerToMain =
  | ScriptDeviceRequest
  | { type: 'ready'; templates: number; refWidth: number; refHeight: number; shrink: number }
  | { type: 'status'; snapshot: RunSnapshot }
  | { type: 'logs'; entries: LogEntry[] }
  | { type: 'matches'; results: MatchResult[] }
  | { type: 'aiConsult'; requestId: string; stepId: string | null; reason: string; expectTemplateIds: string[] }
  | { type: 'finished'; snapshot: RunSnapshot }
  /** Setup failed before the engine ran (templates, bad input). */
  | { type: 'failed'; error: string };

export type ScriptMainToWorker =
  | { type: 'start'; input: ScriptWorkerInput }
  /** The start gate passed: execute. */
  | { type: 'go' }
  | { type: 'response'; id: number; ok: true; value?: RawFrame | string | null }
  /** `guard` marks an ExecutionGuardError: retries, onFail and the AI advisor must not route around it. */
  | { type: 'response'; id: number; ok: false; error: string; guard?: boolean }
  | { type: 'pause' }
  | { type: 'resume' }
  /** Graceful stop: the current step ends, then the run finishes as aborted. */
  | { type: 'stop'; reason: string }
  /** Hard stop: pending requests fail at once. */
  | { type: 'abort'; reason: string }
  | { type: 'debugMatches'; enabled: boolean }
  | { type: 'aiResult'; requestId: string; result: AiAssistResult };

/** A worker as the runner sees it (node:worker_threads Worker, or an in-process fake in tests). */
export interface ScriptWorkerLike {
  on(event: 'message', listener: (message: ScriptWorkerToMain) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
  postMessage(message: ScriptMainToWorker, transferList?: ArrayBuffer[]): void;
  terminate(): Promise<number>;
}

/** The worker's side of the channel (node's `parentPort`, or an in-process fake in tests). */
export interface ScriptWorkerPort {
  on(event: 'message', listener: (message: ScriptMainToWorker) => void): unknown;
  postMessage(message: ScriptWorkerToMain, transferList?: ArrayBuffer[]): void;
}

/** A worker waits this long for the advisor; a late answer is dropped. */
export const AI_CONSULT_TIMEOUT_MS = 180_000;
