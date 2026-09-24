/**
 * Pure helpers of the template library page (no React, no IPC), so the wording and the rules are testable.
 * Ported from wanlong-panel's TemplateEditor: σ / 透明底 badges, coverage interpretation, the variance-guard
 * guidance, fixed-id validation and the save draft.
 */
import type { MatchResult, Rect, SeedResult, TemplateDefinition, TemplateDraft } from '@avdm/automation';
import {
  ALPHA_TOLERANCE_RANGE, DEFAULT_ALPHA_DIFF_TOLERANCE, LOW_TEMPLATE_STD_WARNING, MIN_TEMPLATE_CROP, MIN_TEMPLATE_STD,
  TEMPLATE_ID_PATTERN,
} from '@avdm/automation/constants';
import type { TemplateCoverage } from '../../../shared/ipc';

export type Tone = 'danger' | 'warning' | 'success' | 'info';

/** Match-speed advice shown under the editor (measured on the original panel's 1440p instance). */
export const ROI_ADVICE = {
  title: '强烈建议顺手拉一个默认搜索区域（ROI）',
  detail: '实测全屏匹配 62ms，缩到导航条 5.2ms，缩到单个按钮 1.45ms —— 限定搜索区域是最划算的一档加速（约 40 倍），而且能顺带避开画面别处长得像的元素。',
} as const;

export const DELETE_WARNING = '引用它的脚本会在运行时报「模板不存在」。';
export const MISS_FALLBACK_HINT = '画面上没有这个元素，或者阈值定得太高。可以先把阈值降到 0.8 试试，但别低于 0.7。';

/** The σ badge: warning below MIN_TEMPLATE_STD × 1.5 (18). */
export function stdBadge(std: number | undefined): { tone: 'success' | 'warning'; label: string; hint: string } | null {
  if (typeof std !== 'number' || !Number.isFinite(std)) return null;
  const low = std < LOW_TEMPLATE_STD_WARNING;
  return {
    tone: low ? 'warning' : 'success',
    label: `σ ${std.toFixed(1)}`,
    hint: low
      ? `标准差只有 ${std.toFixed(1)}，纹理偏单调，匹配容易误判。建议换一块有图标或文字的区域重截。`
      : `灰度标准差 ${std.toFixed(1)}，纹理充足`,
  };
}

/** The 透明底 badge of a masked template. */
export function maskBadge(coverage: number | undefined): { label: string; hint: string } | null {
  if (typeof coverage !== 'number' || !Number.isFinite(coverage)) return null;
  const percent = Math.round(coverage * 100);
  return {
    label: `透明底 ${percent}%`,
    hint: `透明底模板：只有 ${percent}% 的像素参与匹配，其余是会变的背景，已抠掉（多帧差分去底）。`,
  };
}

/** One-line list summary: size｜ROI or full-frame search｜threshold. */
export function templateSummary(t: Pick<TemplateDefinition, 'bounds' | 'defaultRoi' | 'threshold'>): string {
  return `${t.bounds.w}×${t.bounds.h}${t.defaultRoi ? '｜已设 ROI' : '｜全屏搜索'}${typeof t.threshold === 'number' ? `｜阈值 ${t.threshold}` : ''}`;
}

export function rectText(r: Rect | undefined): string {
  return r ? `${r.x},${r.y} · ${r.w}×${r.h}` : '';
}

/** How to read the opaque fraction of a diff-alpha preview. */
export function describeCoverage(coverage: number): { tone: Tone; hint: string } {
  if (coverage < 0.1) return { tone: 'danger', hint: '几乎全被抠掉了：几帧之间控件位置对不上？或者容差太小。保存会被拒绝。' };
  if (coverage < 0.3) return { tone: 'warning', hint: '留下的本体很少，匹配可能不稳；试试调大容差或重抓差分帧。' };
  if (coverage >= 0.97) return { tone: 'info', hint: '几乎整块不透明：这个控件是实心的，不需要去底，保存后按普通模板处理。' };
  return { tone: 'success', hint: '洋红 = 抠掉（不参与匹配）；剩下的就是控件本体。' };
}

export function clampTolerance(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_ALPHA_DIFF_TOLERANCE;
  return Math.min(ALPHA_TOLERANCE_RANGE.max, Math.max(ALPHA_TOLERANCE_RANGE.min, Math.round(value)));
}

/** Guidance for a TEMPLATE_LOW_VARIANCE failure, built from the coded error's message. */
export interface LowVarianceGuidance {
  kind: 'std' | 'mask';
  title: string;
  paragraphs: string[];
}

export function lowVarianceGuidance(code: string | undefined, message: string): LowVarianceGuidance | null {
  if (code !== 'TEMPLATE_LOW_VARIANCE') return null;
  if (message.includes('透明底')) {
    const opaque = /只剩 (\d+) 个不透明像素（(\d+)%）/.exec(message);
    return {
      kind: 'mask',
      title: '透明底抠得太狠，剩下的像素不够匹配',
      paragraphs: [
        opaque ? `去底后只剩 ${opaque[1]} 个不透明像素（${opaque[2]}%），低于下限 64 个 / 10%。` : '去底后剩下的不透明像素太少。',
        '请调大容差、重抓一帧背景差异更明显的画面，或把框收紧到图标里不透明的那一块。',
      ],
    };
  }
  const std = /std=([\d.]+)/.exec(message);
  return {
    kind: 'std',
    title: '这块区域纹理太单调，不能当模板',
    paragraphs: [
      `灰度标准差${std ? ` 只有 ${Number(std[1]).toFixed(1)}` : '过低'}（下限 ${MIN_TEMPLATE_STD}）。纯色块或渐变背景会让匹配算法彻底失效 —— ` +
        '实测这类模板对任意画面都返回 1.0000 的满分，脚本会在完全错误的位置疯狂点击。',
      '请换一块有图标、有文字、有明显边缘的区域重新框选，并尽量把框贴紧图标本身，别把大片背景框进去。',
    ],
  };
}

/** A fixed id typed in the page: optional, but when given it must be 3–64 of [A-Za-z0-9_-]. */
export function templateIdProblem(id: string): string | null {
  const value = id.trim();
  if (!value || TEMPLATE_ID_PATTERN.test(value)) return null;
  return '模板 ID 只能用字母、数字、下划线、短横线，3~64 位，例如 tpl_btn_close_popup';
}

/** Comma / whitespace separated tags, de-duplicated. */
export function parseTags(text: string): string[] {
  return [...new Set(text.split(/[,，\s]+/).map((tag) => tag.trim()).filter(Boolean))].slice(0, 20);
}

export function validCrop(crop: Rect | null | undefined, width: number, height: number): boolean {
  return Boolean(crop && [crop.x, crop.y, crop.w, crop.h].every(Number.isSafeInteger) && crop.x >= 0 && crop.y >= 0 &&
    crop.w >= MIN_TEMPLATE_CROP && crop.h >= MIN_TEMPLATE_CROP && crop.x + crop.w <= width && crop.y + crop.h <= height);
}

export interface DraftInput {
  templateId: string;
  selectedId: string | null;
  name: string;
  frame: { png: Uint8Array; width: number; height: number };
  crop: Rect;
  roi: Rect | null;
  threshold: number;
  note: string;
  tags: string;
  diffFrames: Uint8Array[];
  tolerance: number;
  /** The user confirmed replacing an existing template with this id. */
  confirmOverwrite: boolean;
}

/**
 * The save request. Editing the selected template (same id) is an explicit overwrite; any other existing id needs
 * the user's confirmation. Diff frames go to the main process, which recomputes the mask with the preview's algorithm.
 */
export function buildTemplateDraft(input: DraftInput): TemplateDraft {
  const id = input.templateId.trim();
  const tags = parseTags(input.tags);
  const note = input.note.trim();
  return {
    ...(id ? { id } : {}),
    name: input.name.trim(),
    image: input.frame.png,
    authoredWidth: input.frame.width,
    authoredHeight: input.frame.height,
    crop: input.crop,
    ...(input.roi ? { defaultRoi: input.roi } : {}),
    threshold: input.threshold,
    ...(note ? { note } : {}),
    ...(tags.length ? { tags } : {}),
    ...(input.diffFrames.length > 0 ? { diffFrames: input.diffFrames, diffTolerance: clampTolerance(input.tolerance) } : {}),
    ...(id && (id === input.selectedId || input.confirmOverwrite) ? { overwrite: true } : {}),
  };
}

/** The existing template a typed id would replace, unless it is the one being edited. */
export function overwriteTarget(templateId: string, selectedId: string | null, templates: readonly Pick<TemplateDefinition, 'id' | 'name'>[]): Pick<TemplateDefinition, 'id' | 'name'> | null {
  const id = templateId.trim();
  if (!id || id === selectedId) return null;
  return templates.find((item) => item.id === id) ?? null;
}

export function saveSuccessDetail(name: string, std: number, maskCoverage?: number): string {
  return `模板「${name}」已保存（标准差 ${std.toFixed(1)}${typeof maskCoverage === 'number' ? `，透明底 ${Math.round(maskCoverage * 100)}%` : ''}）`;
}

export function testVerdict(match: MatchResult): { found: boolean; title: string; detail: string } {
  if (match.found) {
    return {
      found: true,
      title: `命中：得分 ${match.score.toFixed(4)}（阈值 ${match.threshold}）`,
      detail: `落点（参考坐标）${match.centerX},${match.centerY}，耗时 ${match.elapsedMs}ms`,
    };
  }
  return {
    found: false,
    title: `未命中：最高得分 ${match.score.toFixed(4)}，阈值 ${match.threshold}`,
    detail: match.reason ?? MISS_FALLBACK_HINT,
  };
}

/** Frames below the set's reference size are upscaled before matching; small glyphs and icons get unreliable. */
export function resolutionWarning(frame: { width: number; height: number }, set: { refWidth: number; refHeight: number }): string | null {
  if (frame.width >= set.refWidth) return null;
  const k = set.refWidth / frame.width;
  return `当前截图 ${frame.width}×${frame.height} 低于模板集参考分辨率 ${set.refWidth}×${set.refHeight}，模板匹配时会被放大 ${k.toFixed(2)} 倍，` +
    '小图标和数字字形可能不可靠。建议把实例建成 2560×1440（至少 1920×1080）再截模板。';
}

export interface QuickPick {
  key: string;
  id: string;
  name: string;
  group: 'critical' | 'optional' | 'glyph';
  detail: string;
  tags?: string[];
  threshold?: number;
}

/** Quick picks for the ids the set still lacks: one click fills the fixed id, name, tags and threshold. */
export function quickPicks(coverage: TemplateCoverage | null): QuickPick[] {
  if (!coverage) return [];
  const picks: QuickPick[] = [];
  for (const item of coverage.critical) {
    picks.push({ key: item.id, id: item.id, name: item.label.split('（')[0]!, group: 'critical',
      detail: item.state === 'failed' ? `编译失败：${item.reason ?? ''}` : item.label });
  }
  for (const item of coverage.optional) {
    picks.push({ key: item.id, id: item.id, name: item.label.split('（')[0]!, group: 'optional',
      detail: item.state === 'failed' ? `编译失败：${item.reason ?? ''}` : item.label });
  }
  for (const glyph of coverage.glyphs) {
    // Only sets that exist at all: an absent glyph set is reported by its critical / optional users.
    if (glyph.present.length === 0) continue;
    for (const digit of glyph.missingDigits) {
      picks.push({ key: `${glyph.name}_${digit}`, id: `${glyph.name}_${digit}`, name: `${glyph.name} 字形 ${digit}`, group: 'glyph',
        detail: `${glyph.label}：缺数字 ${digit}`, tags: ['digit', glyph.name], threshold: 0.78 });
    }
  }
  return picks;
}

/** The import result as Chinese lines for the page. */
export function importSummary(result: SeedResult): { title: string; lines: string[]; changed: boolean } {
  const lines: string[] = [];
  for (const [setId, count] of Object.entries(result.copiedSets)) lines.push(`新增模板集 ${setId}（${count} 个文件）`);
  for (const [setId, ids] of Object.entries(result.addedTemplates)) lines.push(`${setId} 补进 ${ids.length} 张：${ids.join('、')}`);
  for (const [setId, reason] of Object.entries(result.skipped)) lines.push(`跳过 ${setId}：${reason}`);
  const changed = Object.keys(result.copiedSets).length + Object.keys(result.addedTemplates).length > 0;
  const title = changed ? '导入完成（只增不改，已有模板一个字节都没动）' : Object.keys(result.skipped).length ? '没有可导入的模板' : '没有新模板：已有的模板集都已包含这些模板';
  return { title, lines, changed };
}
