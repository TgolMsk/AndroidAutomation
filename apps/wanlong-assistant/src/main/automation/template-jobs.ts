import {
  buildDiffAlpha, buildTemplateAlpha, loadPreparedSet, matchTemplate, prepareFrame, prepareTemplate, serializeError, type MatchResult,
  type RawFrame, type Rect, type SerializedError, type TemplateDefinition, type TemplateSet,
} from '@avdm/automation';
import type { TemplateAlphaPreview, TemplateCompileFailure } from '../../shared/ipc';

/** 「立即验证」: prepare the fresh frame and the one template, match once on that same frame. */
export interface TemplateTestJob {
  kind: 'test';
  frame: RawFrame;
  set: TemplateSet;
  definition: TemplateDefinition;
  image: Uint8Array;
  roi?: Rect;
  threshold?: number;
  /** Downsampling factor (app settings `shrink`, as for script matching) for frame and template; the vision default when absent. */
  shrink?: number;
}

/** Full coverage check: compile every template of the set the way the gather flow does (glyphs at shrink 1). */
export interface TemplateCompileJob {
  kind: 'compile';
  directory: string;
}

/**
 * 透明底 preview on the page (re-run on every debounced crop / tolerance change): up to four whole-frame PNG decodes
 * plus per-pixel diff, 3×3 majority and alpha loops over the crop, so it never runs on the main thread.
 */
export interface TemplateAlphaPreviewJob {
  kind: 'alphaPreview';
  /** The main frame followed by 1–3 diff frames (whole-frame PNGs). */
  frames: Uint8Array[];
  crop: Rect;
  tolerance: number;
  previewWidth?: number;
}

/** The mask of a save with `diffFrames`, computed with the preview's algorithm; the save then gets it as `alpha`. */
export interface TemplateDiffAlphaJob {
  kind: 'diffAlpha';
  frames: Uint8Array[];
  crop: Rect;
  tolerance?: number;
}

export type TemplateJob = TemplateTestJob | TemplateCompileJob | TemplateAlphaPreviewJob | TemplateDiffAlphaJob;

export type TemplateJobOutput =
  | { ok: true; kind: 'test'; match: MatchResult }
  | { ok: true; kind: 'compile'; failed: TemplateCompileFailure[]; compiled: number }
  | { ok: true; kind: 'alphaPreview'; preview: TemplateAlphaPreview }
  | { ok: true; kind: 'diffAlpha'; alphaPng: Uint8Array; coverage: number }
  | { ok: false; error: SerializedError };

/** A copy of the job's byte arrays that can be transferred to the worker (the caller's arrays stay usable). */
export function transferableJob(job: TemplateJob): { message: TemplateJob; transfer: ArrayBuffer[] } {
  const transfer: ArrayBuffer[] = [];
  const own = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => {
    const copy = Uint8Array.from(bytes);
    transfer.push(copy.buffer);
    return copy;
  };
  switch (job.kind) {
    case 'test': return { message: { ...job, frame: { ...job.frame, data: own(job.frame.data) }, image: own(job.image) }, transfer };
    case 'alphaPreview':
    case 'diffAlpha': return { message: { ...job, frames: job.frames.map(own) }, transfer };
    default: return { message: job, transfer };
  }
}

/** Glyph templates (`tags: ['digit', <set>]`) are compiled at shrink 1 like `loadGatherTemplates`. */
export function jobShrinkFor(definition: Pick<TemplateDefinition, 'tags'>): number {
  return definition.tags?.includes('digit') ? 1 : 2;
}

/** Runs inside the template worker (and directly in tests). Never throws: failures carry their error code. */
export async function runTemplateJob(job: TemplateJob): Promise<TemplateJobOutput> {
  try {
    if (job.kind === 'compile') {
      const prepared = await loadPreparedSet(job.directory, { shrinkFor: jobShrinkFor, onWarn: () => undefined });
      return { ok: true, kind: 'compile', failed: prepared.failed, compiled: prepared.templates.size };
    }
    if (job.kind === 'alphaPreview') {
      const preview = await buildTemplateAlpha(job.frames, job.crop, { tolerance: job.tolerance, previewWidth: job.previewWidth });
      return { ok: true, kind: 'alphaPreview', preview };
    }
    if (job.kind === 'diffAlpha') {
      const diff = await buildDiffAlpha(job.frames, job.crop, { tolerance: job.tolerance });
      return { ok: true, kind: 'diffAlpha', alphaPng: diff.alphaPng, coverage: diff.coverage };
    }
    const template = await prepareTemplate(job.image, job.definition, job.set, job.shrink);
    const frame = await prepareFrame(job.frame, { refWidth: job.set.refWidth, refHeight: job.set.refHeight, shrink: template.shrink });
    const match = await matchTemplate(frame, template, { roi: job.roi, threshold: job.threshold });
    return { ok: true, kind: 'test', match };
  } catch (error) {
    return { ok: false, error: serializeError(error) };
  }
}
