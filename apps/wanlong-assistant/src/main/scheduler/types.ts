/**
 * Contracts of the ETA scheduler service (main process only). Other modules register hooks with
 * `EtaScheduler.setHooks()` and lend the instance lock with `EtaScheduler.exclusive()`; see ./README.md.
 */
import type { RawFrame } from '@avdm/automation';
import type { MarchResourceType, PanelSample, SchedulerConfig, TravelTimeSource } from '@avdm/automation/wanlong/pure';
import type { SchedulerPauseInfo, SchedulerQueueState } from '../../shared/ipc/scheduler';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** What the scheduler needs from a troop-panel sample, run in the long-lived vision worker. */
export interface SampleRequest {
  reason: string;
  config: SchedulerConfig;
  /** Absolute deadline (Date.now clock); the sampler extends its own copy in place for cold start / updates. */
  deadlineAt: number;
  signal: AbortSignal;
  /** Cold-start recovery (monkey launch of the game package only) is allowed for this sample. */
  allowColdStart: boolean;
  /** Every captured frame (freeze watchdog). Synchronous; must not throw. */
  onFrame(raw: RawFrame): void;
  /** Capture failures (ADB timeout, device gone). Synchronous; must not throw. */
  onCaptureFailed(error: unknown): void;
  /** The sampler cannot recognise the screen: kicked probe / AI / game update get the same frame. */
  onUnrecognized(raw: RawFrame): Promise<boolean | 'recovered' | 'updated'>;
  log(level: LogLevel, message: string): void;
}

export interface HealthFrame {
  raw: RawFrame;
  foreground: string | null;
  /** Whether the game process is alive (pidof); null when unknown. */
  running: boolean | null;
}

/** Device-facing ports, implemented by the automation host (AVD + vision worker) and faked in tests. */
export interface EtaSchedulerPorts {
  sample(index: number, request: SampleRequest): Promise<PanelSample>;
  /** One frame, the foreground package and the game process state (health probe; no panel). */
  healthFrame(index: number, signal: AbortSignal): Promise<HealthFrame>;
  /** The AVD at `index`: null when no instance record exists. `createdAt` is the identity. */
  instance(index: number): Promise<{ status: string; createdAt: string } | null>;
  /** Readiness gate before enabling auto (account ready and bound to this AVD, not a base instance…). Throws Chinese. */
  ensureReady?(index: number): Promise<void>;
  /** Account bound to the instance (shown in the queue view). */
  accountIdOf?(index: number): Promise<string | null>;
  /** Another writer owns the instance (script run, login, provisioning): a Chinese label such as「运行脚本计划」. */
  externalBusy?(index: number): string | null;
}

export interface FrameContext {
  signal: AbortSignal;
}

/**
 * Context of `onUnrecognizedFrame`. The vision job's hard timeout is suspended while the hook runs (capped at
 * 30 min per call), so a game-update download handled here does not consume the sample's own budget.
 */
export type UnrecognizedContext = FrameContext;

/**
 * Hooks for later modules. All are optional and isolated: a throwing hook is logged and never breaks scheduling.
 * Hooks marked "in lock" run inside the instance lock: they may call `exclusive()` (re-enters) but must never
 * await `setAuto(true)` / `sampleNow()` (they would wait for the lock they are running in).
 */
export interface SchedulerHooks {
  onStateChange?(state: SchedulerQueueState): void;
  onConfigChange?(config: SchedulerConfig): void;
  log?(level: LogLevel, message: string): void;
  /** In lock, awaited. Every real panel read (not throttled / yielded / aborted / attention codes). */
  onSampleResult?(index: number, ok: boolean, message: string | null, ctx: FrameContext): void | Promise<void>;
  /** In lock, synchronous. Every sampler and health-probe frame. */
  onFrameCaptured?(index: number, raw: RawFrame): void;
  /** In lock, synchronous. Capture failures, including "device not available"; never for aborts. */
  onCaptureFailed?(index: number, error: { code: string; message: string }): void;
  /** In lock, awaited. true = kicked/offline taken over by alerts; 'recovered' = overlay closed; 'updated' = update done. */
  onUnrecognizedFrame?(index: number, raw: RawFrame, ctx: UnrecognizedContext): Promise<boolean | 'recovered' | 'updated' | void>;
  /** In lock, awaited. Health probe frame with foreground package and process state. */
  onHealthProbe?(index: number, raw: RawFrame, ctx: FrameContext & { foreground: string | null; running: boolean | null }): Promise<void>;
  /** In lock, awaited. The health probe could not even capture a frame. */
  onHealthProbeFailed?(index: number, error: { code: string; message: string }, ctx: FrameContext): Promise<void>;
  /** In lock, synchronous. Marches that were out last time and are gone now (trips completed; a reference metric). */
  onMarchGone?(index: number, gone: Array<{ slot: number; coord: string | null }>, at: number): void;
  /** The only source of pause/resume events: fires only when auto really flips. */
  onAutoChanged?(index: number, enabled: boolean, at: number, reason?: string): void;
  /** GAME_UPDATE_REQUIRED / AI_RISK_BLOCKED: a human must look. The scheduler has already paused the instance. */
  onNeedsAttention?(index: number, info: { code: string; message: string }): void;
  /** Pause record shown in the queue view (alerts module). */
  pauseOf?(index: number): SchedulerPauseInfo | null;
}

/** Result of one queue-free hand-off (the gather cycle). */
export interface QueueFreeResult {
  dispatched: number;
  /** Do not wake before this (circuit breaker: 10 min; give-up cooldown). */
  notBefore?: number | null;
  reason?: string;
}

/**
 * Called inside the instance lock when a sample shows a free slot. The scheduler decides when to look; the hook
 * decides where to send troops, reports each dispatch through `noteDispatches` (which re-samples) and throws on a
 * failed cycle (after reporting it).
 */
export type QueueFreeHook = (state: SchedulerQueueState, ctx: { signal: AbortSignal }) => Promise<QueueFreeResult | void>;

export interface DispatchNote {
  /** Travel time read from the march button; null when unread (the default fallback is recorded instead). */
  travelTimeMs: number | null;
  coord?: string | null;
  source?: TravelTimeSource;
  resourceType?: MarchResourceType | null;
}
