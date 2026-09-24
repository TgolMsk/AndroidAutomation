import {
  loadPreparedSet, matchTemplate, prepareFrame, prepareTemplate, serializeError, type MatchResult, type RawFrame, type Rect,
  type SerializedError, type TemplateDefinition, type TemplateSet,
} from '@avdm/automation';
import type { TemplateCompileFailure } from '../../shared/ipc';

/** 「立即验证」: prepare the fresh frame and the one template, match once on that same frame. */
export interface TemplateTestJob {
  kind: 'test';
  frame: RawFrame;
  set: TemplateSet;
  definition: TemplateDefinition;
  image: Uint8Array;
  roi?: Rect;
  threshold?: number;
}

/** Full coverage check: compile every template of the set the way the gather flow does (glyphs at shrink 1). */
export interface TemplateCompileJob {
  kind: 'compile';
  directory: string;
}

export type TemplateJob = TemplateTestJob | TemplateCompileJob;

export type TemplateJobOutput =
  | { ok: true; kind: 'test'; match: MatchResult }
  | { ok: true; kind: 'compile'; failed: TemplateCompileFailure[]; compiled: number }
  | { ok: false; error: SerializedError };

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
    const frame = await prepareFrame(job.frame, { refWidth: job.set.refWidth, refHeight: job.set.refHeight });
    const template = await prepareTemplate(job.image, job.definition, job.set);
    const match = await matchTemplate(frame, template, { roi: job.roi, threshold: job.threshold });
    return { ok: true, kind: 'test', match };
  } catch (error) {
    return { ok: false, error: serializeError(error) };
  }
}
