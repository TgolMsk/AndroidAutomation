import type { RawFrame } from '@avdm/automation';
import type { AdvisorAdvice, AdvisorFailureKind, AdvisorOutcome, AdvisorScreen } from '../../../shared/ai';

/** Renderer-visible contracts live in `src/shared/ai.ts` (pure, one source of defaults and ranges). */
export type {
  AdvisorAction, AdvisorAdvice, AdvisorBox, AdvisorConfig, AdvisorConfigPatch, AdvisorConfigView, AdvisorEffect,
  AdvisorFailureKind, AdvisorOutcome, AdvisorRecord, AdvisorRisk, AdvisorRiskLevel, AdvisorScreen, AdvisorStatus,
  AdvisorTemplateProposal, AdvisorTestResult,
} from '../../../shared/ai';

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

/**
 * One question from an automatic chain (gather G0, troop-panel sampler, script run) about a frame main already holds.
 * The box comes back in reference coordinates (`refWidth` × `refHeight`), ready for a reference-space tap.
 */
export interface FrameConsultInput {
  gameId: string;
  instanceIndex: number | null;
  /** gather-g0 / scheduler-sample / script-run: records only. */
  context: string;
  raw: RawFrame;
  refWidth: number;
  refHeight: number;
  /** Which attempt of the caller's fallback ladder; the prompt tells the model the earlier ones failed. */
  attempt: number;
  /** A fresh-frame second opinion before a confirmation: skips the per-instance cooldown, still counts in the quota. */
  recheck?: boolean;
}

export interface FrameConsultResult {
  advice: AdvisorAdvice | null;
  /** Why `advice` is null (Chinese). */
  reason: string;
  /** null with no advice = the advisor is off: nothing was sent and nothing is recorded (original iron rule 4). */
  outcome: Extract<AdvisorOutcome, 'skipped' | 'failed' | 'unparsable'> | null;
  latencyMs: number;
  /** Provider requests actually sent (stage one + refine). */
  providerCalls: number;
  failureKind?: AdvisorFailureKind | null;
}

/** A result the executor records (the advisor adds id / time, scrubs and caps the message, persists and emits it). */
export interface AdvisorNote {
  gameId: string;
  index: number | null;
  context: string;
  outcome: AdvisorOutcome;
  message: string;
  advice: AdvisorAdvice | null;
  harvestedTemplateId: string | null;
  requiresAttention?: boolean;
  latencyMs: number;
  providerCalls: number;
}

/** Per-game prompts and screen vocabulary (original stage1Prompt / refinePrompt; see ./profiles.ts). */
export interface AdvisorPromptProfile {
  /** Screen classes the model may use (unknown values are recorded as 'unknown'). */
  screens: readonly AdvisorScreen[];
  /** Screens that are the game's own known main screens: back / none there never escalates to「需要人处理」. */
  mainScreens: readonly AdvisorScreen[];
  /** Screens where a confirmation is never automatic (account / login / unreadable). */
  noConfirmScreens: readonly AdvisorScreen[];
  system: string;
  stage1(input: { gameName: string; width: number; height: number; attempt: number | null; recheck: boolean }): string;
  refine(width: number, height: number): string;
}
