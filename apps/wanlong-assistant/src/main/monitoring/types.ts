import type { MatchResult, RawFrame, TemplateSet } from '@avdm/automation';
import type { GatherCycleResult } from '@avdm/automation/wanlong';
import type { AutomationRun } from '../../shared/ipc';

/** Monitoring is game-scoped, even when two games reuse the same emulator index. */
export interface MonitorTarget {
  gameId: string;
  index: number;
  packageName: string;
  /** InstanceRecord.createdAt prevents inheriting a deleted instance's old evidence. */
  instanceIdentity: string;
  /** Only a running emulator may be called frozen. */
  instanceRunning: boolean;
  /** A gather or login owns the device while busy; the monitor must yield. */
  busy: boolean;
}

export type MonitorAlertKind =
  | 'consecutiveFailures'
  | 'recoveryExhausted'
  | 'dispatchStalled'
  | 'suspectedKicked'
  | 'maintenanceRequired'
  | 'updateRequired'
  | 'suspectedFreeze';

export interface MonitorEvidence {
  source: 'cycle' | 'frame' | 'capture';
  runId: string | null;
  outcome?: GatherCycleResult['outcome'];
  errorCode?: string | null;
  step?: string | null;
  consecutiveFailures?: number;
  staticFrames?: number;
  staticForMs?: number;
  captureFailures?: number;
  captureFailingForMs?: number;
  templateId?: string;
  score?: number;
  threshold?: number;
  /** Local private screenshot path; never upload or publish implicitly. */
  screenshotPath?: string;
}

export interface MonitorAlert {
  id: string;
  gameId: string;
  index: number;
  at: number;
  kind: MonitorAlertKind;
  severity: 'warning' | 'critical';
  message: string;
  evidence: MonitorEvidence;
}

export interface MonitorCapture { frame: RawFrame; foregroundPackage: string | null }

/** All device access comes from AutomationHost; monitoring never constructs an ADB driver. */
export interface MonitorPorts {
  targets(): Promise<MonitorTarget[]>;
  capture(gameId: string, index: number): Promise<MonitorCapture>;
  /** Unknown or foreground-switch errors are not evidence that Android is frozen. */
  classifyCaptureError?(error: unknown): 'device' | 'foreground' | 'unknown';
  templateSet(gameId: string, index: number): Promise<TemplateSet | null>;
  /** Must match on a fresh, foreground-checked capture in an isolated vision worker. */
  testTemplate(gameId: string, index: number, id: string): Promise<{ match: MatchResult; preview: { png: Uint8Array } }>;
  onAlert(alert: MonitorAlert): Promise<void>;
  /** App settings `shotPolicy`: whether alert scene screenshots are written at all (absent = always). */
  keepEvidence?(): boolean;
  now?(): number;
  sleep?(ms: number): Promise<void>;
}

export type MonitorCycle = { run: AutomationRun; result: GatherCycleResult };
