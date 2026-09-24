/** Template library: template sets, read-only captures, alpha previews, saves, match tests, coverage and imports. */
import type { MatchResult, Rect, SeedResult, TemplateDraft, TemplateSaveResult, TemplateSet } from '@avdm/automation';
import type { GatherTemplateCoverage } from '@avdm/automation/wanlong';
import type { Assert, ListsExactly } from './contract';

export interface TemplateCapture {
  png: Uint8Array;
  width: number;
  height: number;
  capturedAt: number;
  foregroundPackage: string | null;
}

/** Overrides for 「立即验证」 (reference-canvas ROI and threshold); omitted: the template's own. */
export interface TemplateTestOptions {
  roi?: Rect;
  threshold?: number;
}

export interface TemplateTestResult {
  match: MatchResult;
  preview: TemplateCapture;
}

export interface TemplateAlphaPreview {
  alphaPng: Uint8Array;
  previewPng: Uint8Array;
  /** Opaque fraction 0..1 of the crop. */
  coverage: number;
  /** Crop size in frame pixels. */
  width: number;
  height: number;
}

/** One template that failed to compile in a full check. */
export interface TemplateCompileFailure {
  id: string;
  name: string;
  reason: string;
  code?: string;
}

/**
 * Which templates the game still needs in the instance's set: missing critical / optional gather templates and
 * glyph digits (quick picks in the template page), plus compile failures when `compiled` is true.
 */
export interface TemplateCoverage extends GatherTemplateCoverage {
  directory: string;
  templateCount: number;
  /** True when every template was compiled in a worker (a full check); false: manifest ids only. */
  compiled: boolean;
  failed: TemplateCompileFailure[];
}

export interface TemplateImportResult {
  result: SeedResult;
  /** The game's managed sets after the import. */
  sets: TemplateSet[];
}

/** A template set's content changed: compiled-template caches for `directory` are stale. */
export interface TemplatesChange {
  gameId: string;
  directory: string;
  reason: 'save' | 'delete' | 'import';
  templateIds: string[];
  at: number;
}

export interface TemplatesApi {
  automationTemplateSets(gameId: string): Promise<TemplateSet[]>;
  createAutomationTemplateSet(gameId: string, index: number, name: string): Promise<TemplateSet>;
  automationTemplateSet(gameId: string, index: number): Promise<TemplateSet | null>;
  automationTemplateImage(gameId: string, index: number, id: string): Promise<Uint8Array>;
  captureAutomationTemplate(gameId: string, index: number): Promise<TemplateCapture>;
  /** `frames` = the main frame followed by 1–3 diff frames. */
  previewAutomationTemplateAlpha(gameId: string, index: number, frames: Uint8Array[], crop: Rect, tolerance: number, previewWidth?: number): Promise<TemplateAlphaPreview>;
  /** A draft whose `id` already exists needs `overwrite: true` (otherwise the error code is TEMPLATE_EXISTS). */
  saveAutomationTemplate(gameId: string, index: number, draft: TemplateDraft): Promise<TemplateSaveResult>;
  deleteAutomationTemplate(gameId: string, index: number, id: string): Promise<void>;
  testAutomationTemplate(gameId: string, index: number, id: string, options?: TemplateTestOptions): Promise<TemplateTestResult>;
  automationTemplateCoverage(gameId: string, index: number, compile: boolean): Promise<TemplateCoverage | null>;
  /** Only-add merge of legacy template sets (a templates root or one set folder) into the game's managed library. */
  importAutomationTemplateSets(gameId: string, sourceDir: string): Promise<TemplateImportResult>;
}

export const TEMPLATES_METHODS = [
  'automationTemplateSets', 'createAutomationTemplateSet', 'automationTemplateSet', 'automationTemplateImage',
  'captureAutomationTemplate', 'previewAutomationTemplateAlpha', 'saveAutomationTemplate', 'deleteAutomationTemplate',
  'testAutomationTemplate', 'automationTemplateCoverage', 'importAutomationTemplateSets',
] as const satisfies readonly (keyof TemplatesApi)[];

export interface TemplatesEvents {
  'templates-changed': TemplatesChange;
}

export const TEMPLATES_EVENTS = ['templates-changed'] as const satisfies readonly (keyof TemplatesEvents)[];

export type TemplatesContractCheck = [
  Assert<ListsExactly<TemplatesApi, typeof TEMPLATES_METHODS>>,
  Assert<ListsExactly<TemplatesEvents, typeof TEMPLATES_EVENTS>>,
];
