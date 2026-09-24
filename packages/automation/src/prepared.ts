import type { PreparedTemplate, TemplateDefinition, TemplateSet } from './contracts.js';
import { DEFAULT_SHRINK } from './constants.js';
import { errorCodeOf } from './errors.js';
import { loadTemplateSet, readTemplatePng } from './templates.js';
import { prepareTemplate } from './vision.js';

export interface LoadPreparedOptions {
  /** Downscale for every template (default 2). */
  shrink?: number;
  /** Per-template downscale, e.g. 1 for digit glyphs (`tags` contains 'digit'); overrides `shrink`. */
  shrinkFor?: (definition: TemplateDefinition) => number;
  /** Compile only matching definitions (for example one anchor list). */
  filter?: (definition: TemplateDefinition) => boolean;
  /** Called once per skipped template, in Chinese (default: console.warn). */
  onWarn?: (message: string, failure: PreparedFailure) => void;
  signal?: AbortSignal;
}

export interface PreparedFailure {
  id: string;
  name: string;
  code?: string;
  reason: string;
}

export interface PreparedSet {
  set: TemplateSet;
  templates: Map<string, PreparedTemplate>;
  /** Templates that failed to compile (missing PNG, low variance after a hand edit, …). */
  failed: PreparedFailure[];
}

/**
 * Compile a whole template set once (the compile cache makes repeated loads cheap). A template that fails is skipped
 * with a warning instead of failing the caller; `detect()` later reports it as 「不在已加载的模板集里」.
 */
export async function loadPreparedSet(source: string | TemplateSet, options: LoadPreparedOptions = {}): Promise<PreparedSet> {
  const set = typeof source === 'string' ? await loadTemplateSet(source) : source;
  const templates = new Map<string, PreparedTemplate>();
  const failed: PreparedFailure[] = [];
  for (const definition of set.templates) {
    if (options.signal?.aborted) throw options.signal.reason instanceof Error ? options.signal.reason : new Error('模板编译已取消');
    if (options.filter && !options.filter(definition)) continue;
    try {
      const png = await readTemplatePng(set, definition.id);
      const shrink = options.shrinkFor?.(definition) ?? options.shrink ?? DEFAULT_SHRINK;
      templates.set(definition.id, await prepareTemplate(png, definition, set, shrink));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const code = errorCodeOf(error);
      const failure: PreparedFailure = { id: definition.id, name: definition.name, reason, ...(code ? { code } : {}) };
      failed.push(failure);
      const warn = options.onWarn ?? ((message: string) => console.warn(`[vision] ${message}`));
      warn(`模板「${definition.name}」(${definition.id}) 编译失败，已跳过：${reason}`, failure);
    }
  }
  return { set, templates, failed };
}

/** The original panel's form: only the compiled map. */
export async function loadPrepared(source: string | TemplateSet, options: LoadPreparedOptions = {}): Promise<Map<string, PreparedTemplate>> {
  return (await loadPreparedSet(source, options)).templates;
}
