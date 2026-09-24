/** Read-only contracts shared by the main process, IPC bridge, and insights panel. */
import type { LedgerAlertKind } from '../../../shared/alerts';

export type InsightResource = 'wood' | 'gold' | 'iron' | 'mana';
/** Alert kinds of the daily ledger: the alert types of `src/shared/alerts.ts` plus the legacy kinds of old day files. */
export type InsightAlertKind = LedgerAlertKind;

/** Evidence attached to a ledger alert (local only; screenshot paths stay on this Mac). */
export interface InsightEvidence {
  source: 'cycle' | 'frame' | 'capture';
  runId: string | null;
  outcome?: string;
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

export interface InsightResourceTotals {
  dispatches: number;
  /** Sum of card storage at dispatch time. This is an estimate, not actual gathered resources. */
  estimatedAmount: number;
  unknownStorageDispatches: number;
}

export interface InsightDay {
  /** Game day in China Standard Time (UTC+8). */
  dateKey: string;
  gameId: string;
  /** null means all instances of this game. */
  index: number | null;
  cycles: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  circuitBreaks: number;
  dispatches: number;
  estimatedAmount: number;
  unknownStorageDispatches: number;
  byResource: Record<InsightResource, InsightResourceTotals>;
  alerts: number;
}

export interface InsightAlert {
  id: string;
  gameId: string;
  index: number;
  kind: InsightAlertKind;
  severity: 'warning' | 'critical';
  at: number;
  message: string;
  runId: string | null;
  /** Local observer evidence; screenshot paths remain on this Mac. */
  evidence?: InsightEvidence;
}

export interface NotificationConfigView {
  gameId: string;
  index: number;
  /** Native macOS notification. Disabled until this instance opts in. */
  localEnabled: boolean;
  telegram: {
    /** Disabled until this instance opts in. Credentials are shared locally across instances. */
    enabled: boolean;
    botTokenSet: boolean;
    botTokenMasked: string;
    chatId: string;
    cooldownSeconds: number;
    retryCount: number;
    timeoutMs: number;
    subscribedKinds: InsightAlertKind[];
  };
}

export interface NotificationConfigPatch {
  localEnabled?: boolean;
  telegram?: {
    enabled?: boolean;
    /** Omitted preserves it; an empty string explicitly clears the saved token. */
    botToken?: string;
    chatId?: string;
    cooldownSeconds?: number;
    retryCount?: number;
    timeoutMs?: number;
    subscribedKinds?: InsightAlertKind[];
  };
}

export interface NotificationTestResult {
  channel: 'local' | 'telegram';
  ok: boolean;
  message: string;
  attempts: number;
}

/** Global, read-only Telegram inbox. Credentials are shared with outgoing notifications. */
export interface RemoteBotConfigView {
  enabled: boolean;
  running: boolean;
  botTokenSet: boolean;
  chatId: string;
  authorizedUserId: string;
}

export interface RemoteBotConfigPatch {
  enabled?: boolean;
  authorizedUserId?: string;
}

export interface RemoteBotTestResult {
  ok: boolean;
  message: string;
}
