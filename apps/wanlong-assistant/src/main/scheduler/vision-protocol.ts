/** Messages between the main process and the long-lived per-instance vision worker. Types only. */
import type { AndroidKey, ProbeReport, RawFrame } from '@avdm/automation';
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
  }
  | {
    kind: 'recognize';
    instanceIndex: number;
    templateDir: string;
    frame: RawFrame;
  };

export type VisionJobResult =
  | { kind: 'sample'; sample: PanelSample }
  | { kind: 'gather'; result: GatherCycleResult }
  | { kind: 'recognize'; recognized: boolean };

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
  /** Gather G0 unknown-screen advisor (before the blind BACK). */
  | { op: 'advise'; args: [RawFrame, number] };

export type VisionOp = VisionRequest['op'];

export type WorkerToMain =
  | ({ type: 'request'; jobId: number; id: number } & VisionRequest)
  /** The probe gate: approval is required before any non-whitelisted input of this job. */
  | { type: 'ready'; jobId: number; probe: ProbeReport }
  | { type: 'log'; jobId: number; level: 'debug' | 'info' | 'warn' | 'error'; message: string }
  | { type: 'shot'; jobId: number; label: string; raw: RawFrame }
  | { type: 'result'; jobId: number; result: VisionJobResult }
  | { type: 'failed'; jobId: number; error: SerializedError };

export type MainToWorker =
  | { type: 'job'; jobId: number; spec: VisionJobSpec }
  | { type: 'response'; jobId: number; id: number; ok: true; value?: unknown }
  | { type: 'response'; jobId: number; id: number; ok: false; error: SerializedError }
  | { type: 'approved'; jobId: number }
  | { type: 'denied'; jobId: number; reason: string }
  | { type: 'abort'; jobId: number; error: SerializedError }
  /** Drop the compiled template cache (template library changed). */
  | { type: 'invalidate' };
