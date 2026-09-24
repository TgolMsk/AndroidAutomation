/**
 * Pure helpers of the 脚本 page (wanlong-panel `views/ScriptsView.tsx` + `features/blocks/CaptureBlockModal.tsx`):
 * the JSON text ⇄ script parsing, the edit-mode memory, validation summaries, JSON-mode step lookup, the capture
 * checks and the stale-safe insertion of a captured block. No React, no IPC, so the tests run them directly.
 */
import type { Rect, TemplateDefinition, TemplateDraft, TemplateSet } from '@avdm/automation';
import { MIN_TEMPLATE_CROP } from '@avdm/automation/constants';
import {
  appendToBranch, blockMeta, builtinCopyId, childrenOf, findPathById, getAt, insertAfter, isBuiltinScriptId, makeBlock, nextStepId,
  walkSteps, type BlockPath, type Branch, type ScriptDef, type ScriptIssue, type ScriptMeta, type ScriptStep,
} from '@avdm/automation/script';

// ── Edit mode (visual / JSON) ──────────────────────────────────────────────

export type EditMode = 'visual' | 'json';

/** Remembered on this machine, so the page reopens in the same mode. */
export const EDIT_MODE_KEY = 'wanlong.scriptEditMode';

/**
 * localStorage throws in private windows or when site data is blocked: reading falls back to the visual mode and
 * writing is skipped, never an error.
 */
export function readEditMode(storage: () => Pick<Storage, 'getItem'>): EditMode {
  try {
    return storage().getItem(EDIT_MODE_KEY) === 'json' ? 'json' : 'visual';
  } catch {
    return 'visual';
  }
}

export function writeEditMode(storage: () => Pick<Storage, 'setItem'>, mode: EditMode): void {
  try {
    storage().setItem(EDIT_MODE_KEY, mode);
  } catch {
    // Not remembered; the page works the same.
  }
}

// ── The single source of truth: the JSON text ──────────────────────────────

export function prettyScript(def: unknown): string {
  return JSON.stringify(def, null, 2);
}

export interface ParsedScript {
  def: ScriptDef | null;
  /** Chinese reason when the text cannot drive the visual mode; null for an empty text. */
  error: string | null;
}

function jsonError(error: unknown): string {
  return `JSON 解析失败：${error instanceof Error ? error.message : String(error)}`;
}

/**
 * text → script for the visual mode. It must never throw: on failure the visual mode falls back to
 * 「先切到 JSON 模式把语法修好」.
 */
export function parseScriptText(text: string): ParsedScript {
  if (!text.trim()) return { def: null, error: null };
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return { def: null, error: '顶层必须是一个 JSON 对象' };
    if (!Array.isArray((value as { steps?: unknown }).steps)) return { def: null, error: 'steps 必须是一个数组' };
    return { def: value as ScriptDef, error: null };
  } catch (error) {
    return { def: null, error: jsonError(error) };
  }
}

/**
 * text → object for validate / save / format: only the JSON syntax and the top-level object are checked here; the
 * main-process validation reports everything else (a missing steps array included) as issues.
 */
export function parseScriptObject(text: string): { value: Record<string, unknown> | null; error: string | null } {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return { value: null, error: '顶层必须是一个 JSON 对象' };
    return { value: value as Record<string, unknown>, error: null };
  } catch (error) {
    return { value: null, error: jsonError(error) };
  }
}

/** A short unique id for a new script (the original `makeId('script')`). */
export function makeScriptId(now = Date.now(), random = Math.random): string {
  return `script_${now.toString(36)}${Math.floor(random() * 0x10000).toString(36).padStart(4, '0')}`;
}

/** 「新建」: an empty script for the current game (the original `emptyScript`, version 0.1.0, 2560×1440). */
export function newScriptDef(packageName: string, now = Date.now(), random = Math.random): ScriptDef {
  return { id: makeScriptId(now, random), name: '未命名脚本', version: '0.1.0', packageName, refWidth: 2560, refHeight: 1440, steps: [], updatedAt: now };
}

/**
 * What 「保存」 writes. Built-in examples are read-only: the edit is stored as a copy under a free id (the list is
 * read right before, so an earlier copy the user edited is never overwritten).
 */
export function scriptToSave(value: Record<string, unknown>, takenIds: Iterable<string>): { value: Record<string, unknown>; copiedFrom: string | null } {
  const id = typeof value.id === 'string' ? value.id : '';
  if (!isBuiltinScriptId(id)) return { value, copiedFrom: null };
  const name = typeof value.name === 'string' && value.name.trim() ? value.name : id;
  return { value: { ...value, id: builtinCopyId(id, takenIds), name: `${name}（副本）` }, copiedFrom: id };
}

/**
 * Saving under an id another script already uses would silently replace that script (the store overwrites by id):
 * refused unless it is the script that was opened. The id only changes in the JSON mode.
 */
export function overwriteClash(value: Record<string, unknown>, openedId: string | null, listed: readonly ScriptMeta[]): string | null {
  const id = typeof value.id === 'string' ? value.id : '';
  const other = id && id !== openedId ? listed.find((meta) => meta.id === id && !meta.builtin) : undefined;
  return other ? `id「${id}」已经是脚本「${other.name}」在用，保存会覆盖它。请在 JSON 模式里把 id 改成别的再保存。` : null;
}

// ── Validation summary ─────────────────────────────────────────────────────

export interface IssueSummary {
  errors: number;
  warnings: number;
  /** Structural errors: the script cannot be saved. */
  fatal: number;
}

export function summarizeIssues(issues: readonly ScriptIssue[] | null): IssueSummary {
  const list = issues ?? [];
  return {
    errors: list.filter((issue) => issue.level === 'error').length,
    warnings: list.filter((issue) => issue.level === 'warn').length,
    fatal: list.filter((issue) => issue.level === 'error' && issue.fatal === true).length,
  };
}

/**
 * The save gate. As in the original, error-level problems are listed and fixing them is required — the Assistant
 * refuses only structural ones outright and keeps the rest as a draft that cannot run until fixed.
 */
export function saveGate(issues: readonly ScriptIssue[]): { refuse: string | null; draftWarning: string | null } {
  const { errors, fatal } = summarizeIssues(issues);
  if (fatal > 0) return { refuse: `有 ${fatal} 个必须修复的问题，已在下方列出`, draftWarning: null };
  return { refuse: null, draftWarning: errors > 0 ? `还有 ${errors} 个错误，已存为草稿；修好之前不能运行` : null };
}

// ── 「点问题定位」 ───────────────────────────────────────────────────────────

/** Where a step id sits in the JSON text (the quoted id is selected), or null. */
export function stepIdRange(text: string, stepId: string): { start: number; end: number; line: number } | null {
  const quoted = JSON.stringify(stepId);
  const keyed = text.search(new RegExp(`"id"\\s*:\\s*${escapeRegExp(quoted)}`));
  const start = keyed >= 0 ? text.indexOf(quoted, keyed + 4) : text.indexOf(quoted);
  if (start < 0) return null;
  return { start, end: start + quoted.length, line: text.slice(0, start).split('\n').length };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Every label name in the tree, for the goto target suggestions (scope is still the validator's call). */
export function collectLabels(steps: readonly ScriptStep[]): string[] {
  const out = new Set<string>();
  walkSteps(steps, (step) => { if (step.kind === 'label' && step.label) out.add(step.label); });
  return [...out];
}

// ── Template sets ──────────────────────────────────────────────────────────

/**
 * The game's managed sets plus sets known from elsewhere (the current instance's set, a set picked in the capture
 * dialog) when they live outside the managed library (a folder the user picked). Fresh managed data wins.
 */
export function mergeTemplateSets(managed: readonly TemplateSet[], extra: readonly (TemplateSet | null | undefined)[]): TemplateSet[] {
  const out = [...managed];
  for (const set of extra) if (set && !out.some((item) => item.id === set.id)) out.unshift(set);
  return out;
}

/** The sets with `definition` added to (or replaced in) the set `setId`: a new capture shows up without a reload. */
export function withSavedTemplate(sets: readonly TemplateSet[], setId: string, definition: TemplateDefinition): TemplateSet[] {
  return sets.map((set) => set.id === setId ? { ...set, templates: [...set.templates.filter((t) => t.id !== definition.id), definition] } : set);
}

/** The templates of the set the script is bound to (dropdowns, card texts, 「不在模板集里」 tags). */
export function templatesOfSet(sets: readonly TemplateSet[], setId: string | null | undefined): TemplateDefinition[] {
  if (!setId) return [];
  return sets.find((set) => set.id === setId)?.templates ?? [];
}

/** The list line under a script's name: 「N 步｜包名｜模板集 X」. */
export function scriptListDetail(meta: ScriptMeta, sets: readonly Pick<TemplateSet, 'id' | 'name'>[]): string {
  const set = meta.templateSetId ? sets.find((item) => item.id === meta.templateSetId)?.name ?? meta.templateSetId : null;
  return `${meta.stepCount} 步${meta.packageName ? `｜${meta.packageName}` : ''}${set ? `｜模板集 ${set}` : ''}`;
}

/** An unreadable file is listed (never hidden) with version 0 and a ⚠ name. */
export function isUnreadableMeta(meta: ScriptMeta): boolean {
  return meta.version === '0' && !meta.builtin;
}

// ── Capturing a block from the screen ──────────────────────────────────────

/** Only these three blocks can be made straight from the screen (all of them "do something with one picture"). */
export type CaptureKind = 'tapTemplate' | 'waitAppear' | 'waitDisappear';

export const CAPTURE_KINDS: ReadonlyArray<{ value: CaptureKind; label: string; hint: string }> = [
  { value: 'tapTemplate', label: blockMeta('tapTemplate').label, hint: '找到它就点下去' },
  { value: 'waitAppear', label: blockMeta('waitAppear').label, hint: '一直等到它出现再往下走' },
  { value: 'waitDisappear', label: blockMeta('waitDisappear').label, hint: '等它从画面上消失（加载圈转完）' },
];

/** Ids of captured blocks read `tap-N` / `wait-N`. */
export function captureIdPrefix(kind: CaptureKind): string {
  return kind === 'tapTemplate' ? 'tap' : 'wait';
}

export const CAPTURE_NOTE = '在脚本编辑器里截取';
export const MAX_CAPTURE_NAME = 40;

/** Where a new block goes. After / branch targets remember the block ids, so a moved block is still found. */
export type InsertTarget =
  | { kind: 'end' }
  | { kind: 'after'; path: BlockPath; stepId: string }
  | { kind: 'branch'; parentPath: BlockPath; parentId: string; branch: Branch };

/** 「插在选中的那块后面」, or at the end when nothing is selected. */
export function targetAfter(steps: ScriptStep[], selected: BlockPath | null): InsertTarget {
  const step = selected ? getAt(steps, selected) : null;
  return selected && step ? { kind: 'after', path: selected, stepId: step.id } : { kind: 'end' };
}

function resolvePath(steps: ScriptStep[], path: BlockPath, id: string): BlockPath | null {
  return getAt(steps, path)?.id === id ? path : findPathById(steps, id);
}

/**
 * Insert `step` at `target`. A target that no longer exists (its block was removed meanwhile) falls back to the
 * end of the top level and says so (`fellBack`). Returns the new tree and the new block's path.
 */
export function placeBlock(steps: ScriptStep[], target: InsertTarget, step: ScriptStep): { steps: ScriptStep[]; path: BlockPath; fellBack: boolean } {
  const atEnd = (fellBack: boolean) => ({ steps: [...steps, step], path: [steps.length] as BlockPath, fellBack });
  if (target.kind === 'end') return atEnd(false);
  if (target.kind === 'after') {
    const path = resolvePath(steps, target.path, target.stepId);
    if (!path) return atEnd(true);
    const last = path[path.length - 1] as number;
    return { steps: insertAfter(steps, path, [step]), path: [...path.slice(0, -1), last + 1], fellBack: false };
  }
  const parentPath = resolvePath(steps, target.parentPath, target.parentId);
  const parent = parentPath ? getAt(steps, parentPath) : null;
  const fits = parent && ((parent.kind === 'if' && target.branch !== 'steps') || (parent.kind === 'loop' && target.branch === 'steps'));
  if (!parentPath || !parent || !fits) return atEnd(true);
  return {
    steps: appendToBranch(steps, parentPath, target.branch, [step]),
    path: [...parentPath, target.branch, childrenOf(parent, target.branch).length],
    fellBack: false,
  };
}

/** One 「从画面截取」 session: which script, which set the template must land in, and where the block goes. */
export interface CaptureRequest {
  id: string;
  scriptId: string;
  templateSetId: string;
  target: InsertTarget;
}

export interface CapturedTemplate {
  templateId: string;
  templateSetId: string;
  kind: CaptureKind;
}

/**
 * Stale-safe insertion of a captured block (the target's protection, kept): the result only lands in the script it
 * was captured for and only when the template went into that script's set. The new id is generated against the
 * script as it is NOW, so it never collides.
 */
export function insertCapturedBlock(def: ScriptDef, request: CaptureRequest, saved: CapturedTemplate): { def: ScriptDef; path: BlockPath; fellBack: boolean } | null {
  if (def.id !== request.scriptId || saved.templateSetId !== request.templateSetId) return null;
  if (def.templateSetId && def.templateSetId !== saved.templateSetId) return null;
  const step = makeBlock(saved.kind, nextStepId(def.steps, captureIdPrefix(saved.kind)), saved.templateId);
  const placed = placeBlock(def.steps, request.target, step);
  return { def: { ...def, templateSetId: def.templateSetId ?? saved.templateSetId, steps: placed.steps }, path: placed.path, fellBack: placed.fellBack };
}

/** A drag from `a` to `b` in frame pixels, normalised and rounded. */
export function normRect(a: { x: number; y: number }, b: { x: number; y: number }): Rect {
  return {
    x: Math.round(Math.min(a.x, b.x)),
    y: Math.round(Math.min(a.y, b.y)),
    w: Math.round(Math.abs(a.x - b.x)),
    h: Math.round(Math.abs(a.y - b.y)),
  };
}

/** The first thing that stops 「保存并插入」, as the original's Chinese hints; null when ready. */
export function captureProblem(input: {
  hasSet: boolean;
  frame: { width: number; height: number } | null;
  crop: Rect | null;
  name: string;
}): string | null {
  if (!input.hasSet) return '这个脚本还没选模板集，先在上面选一个';
  if (!input.frame) return '先抓一帧画面';
  const { crop } = input;
  if (!crop || crop.w < MIN_TEMPLATE_CROP || crop.h < MIN_TEMPLATE_CROP ||
    crop.x < 0 || crop.y < 0 || crop.x + crop.w > input.frame.width || crop.y + crop.h > input.frame.height) {
    return `在画面上拉一个至少 ${MIN_TEMPLATE_CROP}×${MIN_TEMPLATE_CROP} 像素的框，框住要认的图标或文字`;
  }
  if (!input.name.trim()) return '给它起个名字，例如「联盟按钮」';
  if (input.name.trim().length > MAX_CAPTURE_NAME) return `名字最长 ${MAX_CAPTURE_NAME} 个字`;
  return null;
}

/**
 * The template save request. ★ No defaultRoi: the main process widens one around the template's position (up to
 * 43× faster than a full-screen search) and the author does not have to draw a second box. The crop is in the
 * PNG's own pixels, as the save contract requires.
 */
export function captureDraft(frame: { png: Uint8Array; width: number; height: number }, crop: Rect, name: string): TemplateDraft {
  return { name: name.trim(), image: frame.png, authoredWidth: frame.width, authoredHeight: frame.height, crop, note: CAPTURE_NOTE };
}
