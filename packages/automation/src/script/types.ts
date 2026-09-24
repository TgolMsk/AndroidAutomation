/**
 * Script DSL contract (ported from wanlong-panel `src/shared/script.ts`).
 *
 * Rules carried over from the original:
 *  1. A script is pure JSON data, never code, so it can be edited visually, stored and reused across instances.
 *  2. Coordinates live in the script's own reference canvas (`refWidth` × `refHeight`); the executor converts them.
 *  3. The DSL is game agnostic: game logic goes into templates and steps, never into new step kinds.
 *
 * Types only: this module is part of the renderer-safe `@avdm/automation/script` entry.
 */
import type { AndroidKey, MatchResult, Point, Rect } from '../contracts.js';

export type { AndroidKey, Point, Rect };

// ── Conditions ─────────────────────────────────────────────────────────────

export type Condition =
  | { kind: 'always' }
  | { kind: 'never' }
  /** Whether a template is visible. `present` defaults to true; false means "absent". */
  | { kind: 'template'; templateId: string; roi?: Rect; threshold?: number; present?: boolean }
  /** Any one of several templates (e.g. "one of these pop-ups"). */
  | { kind: 'anyTemplate'; templateIds: string[]; roi?: Rect; threshold?: number }
  /** Current foreground package. `equals` defaults to true. */
  | { kind: 'foreground'; packageName: string; equals?: boolean }
  | { kind: 'and'; all: Condition[] }
  | { kind: 'or'; any: Condition[] }
  | { kind: 'not'; of: Condition };

// ── Steps ──────────────────────────────────────────────────────────────────

/** What happens after a step exhausted its retries. Defaults to `abort`. */
export type FailPolicy =
  | { kind: 'abort' }
  | { kind: 'continue' }
  | { kind: 'goto'; label: string }
  /** Cold-start the app, then rerun the script from the top. */
  | { kind: 'restartApp' };

export interface StepBase {
  /** Unique within the script; logs and shots are filed by it. */
  id: string;
  /** Chinese display name used in logs and the UI. */
  name?: string;
  /** The step runs only when this holds; otherwise it is skipped (not a failure). */
  when?: Condition;
  /** Timeout for one attempt of the step. */
  timeoutMs?: number;
  /** Retries after the first attempt. */
  retry?: number;
  retryDelayMs?: number;
  onFail?: FailPolicy;
  /** Fixed wait after the step succeeded (UI animations). */
  afterDelayMs?: number;
  /** Force (true) or suppress (false) a trace shot for this step, overriding the run's shot policy. */
  capture?: boolean;
}

export type ScriptStep =
  | (StepBase & { kind: 'tap'; at: Point })
  | (StepBase & {
    kind: 'tapTemplate';
    templateId: string;
    roi?: Rect;
    threshold?: number;
    /** Offset from the match centre, in script coordinates. */
    offset?: Point;
    /** How long to keep looking; 0 judges one frame only. */
    waitMs?: number;
    pollMs?: number;
  })
  | (StepBase & { kind: 'waitFor'; cond: Condition; waitMs: number; pollMs?: number })
  /** `input swipe` blocks for the whole duration (≈ duration + 30 ms). */
  | (StepBase & { kind: 'swipe'; from: Point; to: Point; durationMs?: number })
  /** ★ Long press is motionevent DOWN; sleep; UP in ONE adb shell, never a swipe (a swipe holds the queue). */
  | (StepBase & { kind: 'longPress'; at: Point; durationMs: number })
  /** ★ Non-ASCII text needs the ADBKeyboard base64 broadcast: `input text` cannot type it. */
  | (StepBase & { kind: 'text'; text: string })
  | (StepBase & { kind: 'key'; key: AndroidKey })
  | (StepBase & { kind: 'sleep'; ms: number })
  /** `cold` force-stops first. ★ The game is launched only through monkey. */
  | (StepBase & { kind: 'launchApp'; packageName?: string; cold?: boolean })
  | (StepBase & { kind: 'stopApp'; packageName?: string })
  | (StepBase & { kind: 'screenshot'; label?: string })
  | (StepBase & { kind: 'log'; level: LogLevel; message: string })
  /** Target of goto; a no-op itself. Any non-empty text (including Chinese) is allowed. */
  | (StepBase & { kind: 'label'; label: string })
  /** Unconditional jump to a label in the same or an outer block. Exceeding `maxTimes` fails the run. */
  | (StepBase & { kind: 'goto'; label: string; maxTimes?: number })
  | (StepBase & { kind: 'if'; cond: Condition; then: ScriptStep[]; else?: ScriptStep[] })
  /** `repeat` and/or `while`; whichever ends first wins. `maxIterations` (default 1000) fails the run when hit. */
  | (StepBase & { kind: 'loop'; steps: ScriptStep[]; repeat?: number; while?: Condition; maxIterations?: number });

export type StepKind = ScriptStep['kind'];

export const STEP_KINDS: readonly StepKind[] = [
  'tap', 'tapTemplate', 'waitFor', 'swipe', 'longPress', 'text', 'key', 'sleep', 'launchApp', 'stopApp',
  'screenshot', 'log', 'label', 'goto', 'if', 'loop',
];

export const ANDROID_KEYS: readonly AndroidKey[] = [
  'BACK', 'HOME', 'ENTER', 'MENU', 'APP_SWITCH', 'DEL', 'ESCAPE', 'VOLUME_UP', 'VOLUME_DOWN',
];

// ── Script definition ──────────────────────────────────────────────────────

export type ScriptParamValue = string | number | boolean;

export interface ScriptParamDef {
  key: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'enum';
  /** Choices for `enum`. */
  options?: Array<{ value: string; label: string }>;
  default?: ScriptParamValue;
  note?: string;
}

export interface ScriptDef {
  id: string;
  name: string;
  description?: string;
  /** Bump when steps change, to explain "it worked yesterday". */
  version: string;
  /** Target app package. */
  packageName?: string;
  templateSetId?: string;
  /** Reference canvas the script's coordinates were authored in. */
  refWidth: number;
  refHeight: number;
  params?: ScriptParamDef[];
  steps: ScriptStep[];
  /** Rerun the steps after every round (idle scripts). */
  loop?: boolean;
  /** Gap between rounds in loop mode (at least 1000 ms). */
  loopIntervalMs?: number;
  updatedAt: number;
}

/** List entry without steps. */
export interface ScriptMeta {
  id: string;
  name: string;
  description?: string;
  version: string;
  packageName?: string;
  templateSetId?: string;
  /** Every step, counting the bodies of if / loop. */
  stepCount: number;
  updatedAt: number;
  /** Shipped with the app, read-only (`builtin_` ids). */
  builtin?: boolean;
  /** Script-level loop mode. */
  loop?: boolean;
}

export interface ScriptIssue {
  level: 'error' | 'warn';
  /** The step at fault; null for script-level problems. */
  stepId: string | null;
  /** Chinese explanation. */
  message: string;
  /** A structural error: the script cannot be saved (or loaded) at all. Other errors still block execution. */
  fatal?: boolean;
}

// ── Execution ──────────────────────────────────────────────────────────────

export type RunStatus = 'pending' | 'starting' | 'running' | 'paused' | 'stopping' | 'succeeded' | 'failed' | 'aborted';

export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ['succeeded', 'failed', 'aborted'];

/** Trace screenshot policy: failure shots are taken unless `never` (or the step says `capture: false`). */
export type ShotPolicy = 'never' | 'onFail' | 'always';

export const SHOT_POLICIES: readonly ShotPolicy[] = ['never', 'onFail', 'always'];

export interface RunStats {
  captures: number;
  matches: number;
  matchHits: number;
  taps: number;
  retries: number;
  /** Duration of the last complete step, to spot a slow screencap. */
  lastTickMs: number;
  avgCaptureMs: number;
}

/** Progress of one execution as the engine sees it. */
export interface RunSnapshot {
  runId: string;
  scriptId: string;
  scriptName: string;
  instanceIndex: number;
  accountId: string | null;
  accountName: string | null;
  status: RunStatus;
  startedAt: number;
  endedAt: number | null;
  /** Completed top-level steps. */
  stepDone: number;
  /** Top-level step count; null in loop mode. */
  stepTotal: number | null;
  currentStepId: string | null;
  currentStepName: string | null;
  /** Completed rounds in loop mode. */
  iteration: number;
  /** Chinese failure explanation. */
  error: string | null;
  stats: RunStats;
}

// ── Logs ───────────────────────────────────────────────────────────────────

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

export const LOG_LEVEL_ORDER: Readonly<Record<LogLevel, number>> = { debug: 0, info: 1, warn: 2, error: 3 };

/** One line of a run log (stored as ndjson). */
export interface LogEntry {
  ts: number;
  level: LogLevel;
  /** null for app-level lines. */
  runId: string | null;
  instanceIndex: number | null;
  /** Producer: engine, script, runner, logger, ai … */
  scope: string;
  stepId?: string;
  message: string;
  /** Structured detail; must be JSON-serializable. */
  data?: Record<string, unknown>;
  /** Trace shot path relative to the run (`<runId>/<file>`). */
  shot?: string;
}

export interface LogQuery {
  runId?: string;
  instanceIndex?: number;
  minLevel?: LogLevel;
  /** Only lines strictly after this timestamp. */
  since?: number;
  limit?: number;
}

// ── AI assistance ──────────────────────────────────────────────────────────

/** What the engine tells the AI advisor when a step exhausted its retries. */
export interface AiConsultRequest {
  stepId: string | null;
  /** Chinese reason, logged and given to the model. */
  reason: string;
  /** Templates this step was waiting for: the "known screen" the advisor re-verifies against. */
  expectTemplateIds: string[];
}

/** The advisor's answer. */
export interface AiAssistResult {
  /** The screen was changed (pop-up closed); the engine retries the step once. */
  handled: boolean;
  /** Chinese explanation for the run log. */
  message: string;
  /** Needs a human (high risk / game updating): the step fails without a retry. */
  requiresAttention?: boolean;
  /** Template learnt on the way, for the log only. */
  harvestedTemplateId?: string | null;
}

/** Match results pushed to the run monitor while its debug overlay is on. */
export type RunMatches = MatchResult[];
