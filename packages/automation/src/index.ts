export type {
  AndroidKey, DetectResponse, DetectSpec, DevicePort, GamePlugin, MatchOptions, MatchResult, Point, PreparedFrame,
  PreparedTemplate, ProbeReport, RawFrame, ReadOnlyDevicePort, Rect, TemplateDefinition, TemplateSet, VisionPort,
} from './contracts.js';
export type { ProbeOptions } from './probe.js';
export { probeGame } from './probe.js';
export { loadTemplateSet, parseTemplateDefinition, parseTemplateSetHeader, readTemplatePng, SAFE_TEMPLATE_ID } from './templates.js';
export { deriveRoi, TemplateLibrary } from './template-library.js';
export type { TemplateDraft, TemplateSaveResult } from './template-library.js';
export { applyAlpha, buildDiffAlpha, buildTemplateAlpha, renderAlphaPreview } from './template-alpha.js';
export type { AlphaPreviewOptions, AlphaPreviewResult, DiffAlphaOptions, DiffAlphaResult } from './template-alpha.js';
export { mergeTemplateSets } from './template-seed.js';
export type { MergeTemplateSetsOptions, SeedLog, SeedResult } from './template-seed.js';
export { loadPrepared, loadPreparedSet } from './prepared.js';
export type { LoadPreparedOptions, PreparedFailure, PreparedSet } from './prepared.js';
export {
  asBuffer, clampShrink, clearTemplateCache, defaultVision, detect, getCv, grayShrink, isCvReady, matchIn, matchTemplate,
  prepareFrame, prepareTemplate, refToDevice, stdDev, stdDevMasked, templateCacheSize, toDevice, withMats,
} from './vision.js';
export type { PrepareTemplateOptions } from './vision.js';
export { AppError, errorCodeOf, isSerializedError, serializeError, VISION_ERROR_CODES } from './errors.js';
export type { SerializedError, VisionErrorCode } from './errors.js';
export * from './constants.js';
