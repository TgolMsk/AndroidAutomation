/** Template library: template sets, read-only captures, alpha previews, saves and match tests. */
import type { MatchResult, Rect, TemplateDraft, TemplateSaveResult, TemplateSet } from '@avdm/automation';
import type { Assert, ListsExactly } from './contract';

export interface TemplateCapture {
  png: Uint8Array;
  width: number;
  height: number;
  capturedAt: number;
  foregroundPackage: string | null;
}

export interface TemplateTestResult {
  match: MatchResult;
  preview: TemplateCapture;
}

export interface TemplateAlphaPreview {
  alphaPng: Uint8Array;
  previewPng: Uint8Array;
  coverage: number;
}

export interface TemplatesApi {
  automationTemplateSets(gameId: string): Promise<TemplateSet[]>;
  createAutomationTemplateSet(gameId: string, index: number, name: string): Promise<TemplateSet>;
  automationTemplateSet(gameId: string, index: number): Promise<TemplateSet | null>;
  automationTemplateImage(gameId: string, index: number, id: string): Promise<Uint8Array>;
  captureAutomationTemplate(gameId: string, index: number): Promise<TemplateCapture>;
  previewAutomationTemplateAlpha(gameId: string, index: number, frames: Uint8Array[], crop: Rect, tolerance: number): Promise<TemplateAlphaPreview>;
  saveAutomationTemplate(gameId: string, index: number, draft: TemplateDraft): Promise<TemplateSaveResult>;
  deleteAutomationTemplate(gameId: string, index: number, id: string): Promise<void>;
  testAutomationTemplate(gameId: string, index: number, id: string): Promise<TemplateTestResult>;
}

export const TEMPLATES_METHODS = [
  'automationTemplateSets', 'createAutomationTemplateSet', 'automationTemplateSet', 'automationTemplateImage',
  'captureAutomationTemplate', 'previewAutomationTemplateAlpha', 'saveAutomationTemplate', 'deleteAutomationTemplate',
  'testAutomationTemplate',
] as const satisfies readonly (keyof TemplatesApi)[];

/** No push events yet; the vision-templates module adds them here. */
export interface TemplatesEvents {}

export const TEMPLATES_EVENTS = [] as const satisfies readonly (keyof TemplatesEvents)[];

export type TemplatesContractCheck = [
  Assert<ListsExactly<TemplatesApi, typeof TEMPLATES_METHODS>>,
  Assert<ListsExactly<TemplatesEvents, typeof TEMPLATES_EVENTS>>,
];
