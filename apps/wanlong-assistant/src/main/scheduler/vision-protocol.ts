/** Messages between the main process and the long-lived per-instance vision worker. Types only. */
import type { AndroidKey, MatchResult, ProbeReport, RawFrame } from '@avdm/automation';
import type {
  GatherConfig, GatherCycleResult, GatherRuntimeState, PanelSample, SchedulerConfig, SerializedError, ShotPolicy,
} from '@avdm/automation/wanlong';

/** Whitelisted pre-approval taps (see troopPanel.ts SampleTapIntent). */
export type TapIntent = 'closePopup' | 'exitCancel';
/** The single blind BACK of the recovery ladder, always followed by the exit-dialog cancel. */
export type KeyIntent = 'probeBack';

export type VisionJobSpec =
  | {
    kind: 'sample';
    instanceIndex: number;
    templateDir: string;
    config: SchedulerConfig;
    deadlineAt: number;
    allowColdStart: boolean;
  }
  | {
    kind: 'gather';
    instanceIndex: number;
    templateDir: string;
    config: GatherConfig;
    state: GatherRuntimeState;
    allowColdStart: boolean;
    shotPolicy: ShotPolicy;
    /** Whether main offers the unknown-screen advisor (AI / update handling) at G0. */
    advisor: boolean;
  };

export type VisionJobResult =
  | { kind: 'sample'; sample: PanelSample }
  | { kind: 'gather'; result: GatherCycleResult };

/**
 * Read-only questions about a frame main already holds (AI click verification, kicked probe, freeze recovery). The
 * instance's worker answers them with its cached compiled set at any time — also while one of its jobs is running
 * and waiting on a main-side hook, which is exactly when those modules ask. No device access, no approval.
 */
export type VisionQuery =
  | { kind: 'recognize'; templateDir: string; frame: RawFrame }
  | {
    kind: 'match';
    templateDir: string;
    frame: RawFrame;
    /** UI template ids (shrink 2); an id missing from the set answers `found: false` with reason「模板缺失」. */
    templateIds: string[];
    /** Overrides each template's own threshold. */
    threshold?: number;
    /** Search region in reference coordinates; defaults to each template's own ROI (whole frame without one). */
    roi?: { x: number; y: number; w: number; h: number };
  }
  /**
   * Game-update verdict (ai module): the game-data `GameUpdateRecovery` of `templateDir` answers detect / progress for
   * a frame, so main can drive the update handling (tap, wait) without running OpenCV itself.
   */
  | { kind: 'update'; templateDir: string; frame: RawFrame }
  /**
   * AI executor frame comparisons (ai module; point-sampled grey, no templates), kept off the main thread: without
   * `box` the shrink-4 mean absolute difference of `frame` and `other`, with `box` (reference coordinates) whether the
   * button and its surroundings stayed put.
   */
  | { kind: 'frameDiff'; frame: RawFrame; other: RawFrame; refWidth: number; refHeight: number; box?: { x: number; y: number; w: number; h: number } };

export type VisionQueryResult =
  | { kind: 'recognize'; recognized: boolean }
  | { kind: 'match'; matches: MatchResult[] }
  /** Confirm button (2560×1440 reference) when the calibrated update prompt is shown; progress texts. */
  | { kind: 'update'; target: { x: number; y: number } | null; downloading: boolean; progress: boolean }
  /** `mean` without a box, `stable` with one (the other field is null). */
  | { kind: 'frameDiff'; mean: number | null; stable: boolean | null };

export type VisionRequest =
  | { op: 'capture'; args: [] }
  | { op: 'foregroundPackage'; args: [] }
  | { op: 'isAppRunning'; args: [] }
  /** Cold-start recovery in main: monkey launch of the game package only, then wait for the foreground. */
  | { op: 'ensureGame'; args: [] }
  | { op: 'tap'; args: [number, number, TapIntent?] }
  | { op: 'tapMany'; args: [[number, number][], number] }
  | { op: 'swipe'; args: [number, number, number, number, number] }
  | { op: 'key'; args: [AndroidKey, KeyIntent?] }
  | { op: 'launchApp'; args: [string, boolean?] }
  | { op: 'stopApp'; args: [string] }
  /** Sampler hand-off of an unrecognised frame to main hooks (kicked probe / AI / update). */
  | { op: 'unrecognized'; args: [RawFrame] }
  /**
   * Gather G0 unknown-screen advisor (AI / game update), before the blind BACK. Also offered before the probe gate
   * (DECISIONS C whitelist ④, a limited budget): the advisor acts in main under its own whitelist.
   */
  | { op: 'advise'; args: [RawFrame, number] };

export type VisionOp = VisionRequest['op'];

export type WorkerToMain =
  | ({ type: 'request'; jobId: number; id: number } & VisionRequest)
  /** The probe gate: approval is required before any non-whitelisted input of this job. */
  | { type: 'ready'; jobId: number; probe: ProbeReport }
  | { type: 'log'; jobId: number; level: 'debug' | 'info' | 'warn' | 'error'; message: string }
  | { type: 'shot'; jobId: number; label: string; raw: RawFrame }
  | { type: 'result'; jobId: number; result: VisionJobResult }
  | { type: 'failed'; jobId: number; error: SerializedError }
  | { type: 'queryResult'; queryId: number; ok: true; result: VisionQueryResult }
  | { type: 'queryResult'; queryId: number; ok: false; error: SerializedError };

export type MainToWorker =
  | { type: 'job'; jobId: number; spec: VisionJobSpec }
  | { type: 'response'; jobId: number; id: number; ok: true; value?: unknown }
  | { type: 'response'; jobId: number; id: number; ok: false; error: SerializedError }
  | { type: 'approved'; jobId: number }
  | { type: 'denied'; jobId: number; reason: string }
  | { type: 'abort'; jobId: number; error: SerializedError }
  /** Drop the compiled template cache (template library changed). */
  | { type: 'invalidate' }
  | { type: 'query'; queryId: number; query: VisionQuery };
