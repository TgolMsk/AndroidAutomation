/** ETA scheduler: queue snapshots, immediate samples, pause and resume. */
import type { InstanceQueueState, SchedulerConfig, WakeInfo } from '@avdm/automation/wanlong/pure';
import type { Assert, ListsExactly } from './contract';

export type {
  InstanceQueueState, MarchPhase, MarchResourceType, MarchState, MarchStatus, MarchView, SchedulerConfig,
  StaminaValue, TravelTimeSource, WakeInfo,
} from '@avdm/automation/wanlong/pure';

/** Why an instance's automatic schedule is paused (filled by the alerts module; null while running or never paused). */
export interface SchedulerPauseInfo {
  reason: string;
  at: number;
  /** Alert kind that paused it, e.g. deviceOffline / kicked / needsAttention. */
  kind?: string;
}

/** One instance's queue as the renderer sees it: the game's queue model plus the assistant's bookkeeping. */
export interface SchedulerQueueState extends InstanceQueueState {
  gameId: string;
  /** Consecutive real failures (samples or cycles); non-failure outcomes reset it. */
  failureCount: number;
  /** Set when an alert paused the instance; null otherwise. */
  pause: SchedulerPauseInfo | null;
  /** Another process owns the scheduler for this game; this window only shows state. */
  readOnly?: boolean;
}

/**
 * Whether this window schedules. Only one assistant process owns the scheduler (a lease under the data directory);
 * another one only shows state and keeps retrying, so a lease left behind by a crash expires on its own (≈ 30 s).
 */
export interface SchedulerServiceStatus {
  gameId: string;
  /** This process arms wakes, samples and dispatches. */
  owner: boolean;
  /** Chinese explanation while read-only; null for the owner. */
  message: string | null;
  /** When this process became read-only (ms); null for the owner. */
  since: number | null;
}

export interface SchedulerApi {
  /** Every instance the scheduler knows about, sorted by index. */
  schedulerStates(gameId: string): Promise<SchedulerQueueState[]>;
  schedulerState(gameId: string, index: number): Promise<SchedulerQueueState>;
  /** Open the troop panel, read it and close it; never dispatches. Throttled by `minSampleIntervalMs`. */
  schedulerSample(gameId: string, index: number): Promise<SchedulerQueueState>;
  /** Same path as `setAutomationSchedule`: readiness gate + one read-only sample (cold-starts the game); disabling always works. */
  schedulerSetAuto(gameId: string, index: number, enabled: boolean): Promise<SchedulerQueueState>;
  schedulerConfig(gameId: string): Promise<SchedulerConfig>;
  saveSchedulerConfig(gameId: string, patch: Partial<SchedulerConfig>): Promise<SchedulerConfig>;
  schedulerWakes(gameId: string): Promise<WakeInfo[]>;
  /** Drop the pending wake but keep auto on (the next sample or config change re-arms). */
  schedulerCancelWake(gameId: string, index: number): Promise<void>;
  /** Turn auto off and forget all bookkeeping (queue, marches, travel hints) of the instance. */
  schedulerForget(gameId: string, index: number): Promise<void>;
  /** Owner or read-only (and why), for the gather overview's schedule card. */
  schedulerStatus(gameId: string): Promise<SchedulerServiceStatus>;
}

export const SCHEDULER_METHODS = [
  'schedulerStates', 'schedulerState', 'schedulerSample', 'schedulerSetAuto', 'schedulerConfig', 'saveSchedulerConfig',
  'schedulerWakes', 'schedulerCancelWake', 'schedulerForget', 'schedulerStatus',
] as const satisfies readonly (keyof SchedulerApi)[];

export interface SchedulerEvents {
  /** An instance's queue changed (sample, auto switch, wake re-armed, operating flag). */
  'scheduler-changed': SchedulerQueueState;
  'scheduler-config-changed': SchedulerConfig;
  /** This window became read-only or took the scheduler over. */
  'scheduler-status': SchedulerServiceStatus;
}

export const SCHEDULER_EVENTS = ['scheduler-changed', 'scheduler-config-changed', 'scheduler-status'] as const satisfies readonly (keyof SchedulerEvents)[];

export type SchedulerContractCheck = [
  Assert<ListsExactly<SchedulerApi, typeof SCHEDULER_METHODS>>,
  Assert<ListsExactly<SchedulerEvents, typeof SCHEDULER_EVENTS>>,
];
