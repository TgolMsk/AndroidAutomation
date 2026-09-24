/** Failure detection, automatic pauses, pause history and push notification settings, and the freeze watchdog. */
import type {
  AlertRecord, AlertsConfigPatch, AlertsConfigView, InstancePauseState, NotifierId, NotifyResult,
} from '../alerts';
import type { Assert, ListsExactly } from './contract';

export type {
  AlertDetail, AlertDetectConfig, AlertEvent, AlertRecord, AlertSeverity, AlertsConfigPatch, AlertsConfigView, AlertType,
  InstancePauseState, NotifierId, NotifyFailureKind, NotifyResult, TelegramConfigView,
} from '../alerts';

/** What the freeze watchdog currently sees for one instance (read-only, for the settings card). */
export interface FreezeInstanceStatus {
  index: number;
  staticForMs: number;
  staticFrames: number;
  lastFrameAt: number | null;
  lastChangeAt: number | null;
  captureFailures: number;
  captureFailingForMs: number;
  lastCaptureError: string | null;
  /** Automatic restarts inside the current window / the limit / the window (minutes). */
  restartsUsed: number;
  restartLimit: number;
  restartWindowMin: number;
  /** A restart + relaunch is running right now. */
  recovering: boolean;
}

export interface AlertsApi {
  /** The masked config view (★ the token never crosses IPC: the type has no `botToken` key). */
  alertsConfig(): Promise<AlertsConfigView>;
  /** Save a partial config (three-state token: absent keep / non-empty replace / '' clear). */
  saveAlertsConfig(patch: AlertsConfigPatch): Promise<AlertsConfigView>;
  /** Send a synthetic test event now on one channel, bypassing the switch, subscriptions and cooldown. */
  testAlertPush(channel: NotifierId): Promise<NotifyResult>;
  /** Every instance's pause record (paused or cleared), sorted by index. */
  alertPauses(): Promise<InstancePauseState[]>;
  /** Clear the pause (counters, cooldown) and switch automatic scheduling back on. */
  resumeAlertPause(index: number): Promise<InstancePauseState>;
  /** Recent alerts with their delivery results, newest first (1–100). */
  alertHistory(limit?: number): Promise<AlertRecord[]>;
  /** A scene screenshot (JPEG / PNG bytes) by the relative path stored in a pause or alert. */
  alertScreenshot(shotPath: string): Promise<Uint8Array>;
  /** The freeze watchdog's evidence and restart budget per instance it has seen. */
  freezeStatus(): Promise<FreezeInstanceStatus[]>;
}

export const ALERTS_METHODS = [
  'alertsConfig', 'saveAlertsConfig', 'testAlertPush', 'alertPauses', 'resumeAlertPause', 'alertHistory',
  'alertScreenshot', 'freezeStatus',
] as const satisfies readonly (keyof AlertsApi)[];

export interface AlertsEvents {
  /** An instance was paused or resumed (or its pause got the push result). */
  'alert-pause-changed': InstancePauseState;
  /** A new alert (paused or not, pushed or not). */
  'alert-raised': AlertRecord;
  /** The masked config changed. */
  'alert-config-changed': AlertsConfigView;
}

export const ALERTS_EVENTS = ['alert-pause-changed', 'alert-raised', 'alert-config-changed'] as const satisfies readonly (keyof AlertsEvents)[];

export type AlertsContractCheck = [
  Assert<ListsExactly<AlertsApi, typeof ALERTS_METHODS>>,
  Assert<ListsExactly<AlertsEvents, typeof ALERTS_EVENTS>>,
];
