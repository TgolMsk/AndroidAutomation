import type { RawFrame } from '@avdm/automation';

export type AdvisorAction = 'tap_close' | 'tap_cancel' | 'tap_confirm' | 'back' | 'none';
export type AdvisorRiskLevel = 'low' | 'medium' | 'high' | 'unknown';
export type AdvisorEffect =
  | 'dismiss' | 'acknowledge' | 'retry_connection' | 'continue_loading'
  | 'download_update' | 'navigate' | 'purchase' | 'spend_resource'
  | 'delete' | 'account_change' | 'permission_change' | 'send_message'
  | 'combat' | 'exit_game' | 'unknown';
export type AdvisorScreen =
  | 'gameplay' | 'popup' | 'dialog' | 'login' | 'network'
  | 'maintenance' | 'update' | 'loading' | 'other' | 'unknown';

/** Pixel coordinates on the captured Android frame, never on the renderer window. */
export interface AdvisorBox { x: number; y: number; w: number; h: number }

export interface AdvisorRisk {
  level: AdvisorRiskLevel;
  effect: AdvisorEffect;
  buttonText: string;
  dialogText: string;
  consequence: string;
  reason: string;
  hazards: string[];
}

export interface AdvisorAdvice {
  screen: AdvisorScreen;
  action: AdvisorAction;
  target: AdvisorBox | null;
  confidence: number;
  reason: string;
  risk: AdvisorRisk;
  model: string;
  /** This is an interpretation only. The advisor has no device input capability. */
  review: 'no_action' | 'manual_review' | 'blocked';
  reviewReason: string;
}

/** Metadata for an editor draft. The editor must obtain and display a fresh frame. */
export interface AdvisorTemplateProposal {
  gameId: string;
  index: number;
  sourceCapturedAt: number;
  frameWidth: number;
  frameHeight: number;
  box: AdvisorBox;
  suggestedName: string;
  sourceRecordId: string;
}

export interface AdvisorRecord {
  id: string;
  at: number;
  gameId: string;
  index: number | null;
  context: string;
  outcome: 'skipped' | 'failed' | 'unparsable' | 'advised' | 'blocked' | 'no_action' | 'test_passed';
  message: string;
  advice: AdvisorAdvice | null;
  templateProposal: AdvisorTemplateProposal | null;
  latencyMs: number;
  /** Counts provider requests, including a failed response, for the hourly quota. */
  providerCalls: number;
}

export interface AdvisorConfig {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxCallsPerHour: number;
  cooldownSeconds: number;
  imageWidth: number;
  minConfidence: number;
}

export type AdvisorConfigPatch = Partial<AdvisorConfig>;
export interface AdvisorConfigView extends Omit<AdvisorConfig, 'apiKey'> {
  apiKeySet: boolean;
  apiKeyMasked: string;
}

export interface AdvisorStatus {
  enabled: boolean;
  configured: boolean;
  model: string;
  callsLastHour: number;
  maxCallsPerHour: number;
  consultCount: number;
  lastRecord: AdvisorRecord | null;
}

export interface AdvisorTestResult {
  ok: boolean;
  vision: boolean | null;
  model: string;
  latencyMs: number;
  message: string;
}

export interface AdvisorConsultTarget {
  gameId: string;
  gameName: string;
  packageName: string;
  index: number;
  context: string;
}

export interface AdvisorCapture {
  frame: RawFrame;
  foregroundPackage: string | null;
}

export type AdvisorCapturePort = (gameId: string, index: number) => Promise<AdvisorCapture>;
