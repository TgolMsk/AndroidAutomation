/**
 * Groups of a template set for the template library list and the script editor's template pickers (pure, tested in
 * `test/template-groups.test.ts`). A set easily holds 130+ templates, more than half of them digit glyphs that only
 * the OCR reads, so a flat list makes picking the one button a script taps hard.
 *
 * A template's group comes from its tags first (the bundled sets tag every template by screen), then from its id
 * prefix, then from the screen word at the start of its name (「资源统计-行标签」 → 资源统计). Nothing is stored:
 * editing a template's tags or name moves it, and templates of older sets group the same way.
 */
import type { TemplateDefinition } from '@avdm/automation';

export type TemplateLike = Pick<TemplateDefinition, 'id' | 'name'> & Partial<Pick<TemplateDefinition, 'tags' | 'note'>>;

export const GLYPH_GROUP = 'glyph';
export const UNGROUPED = 'other';

interface GroupRule {
  key: string;
  label: string;
  tags?: readonly string[];
  id?: RegExp;
  name?: RegExp;
}

/** Order matters: the first rule that matches wins (resource statistics before dialogs: 「资源统计-弹窗标题」). */
const RULES: readonly GroupRule[] = [
  { key: 'resstat', label: '资源统计', tags: ['resstat_unit', 'resstat'], id: /res_?stats|items_res|label_res_|resstat/, name: /^资源统计/ },
  { key: 'dialog', label: '弹窗与异常', tags: ['dialog', '顶号', '异常检测', 'game_update', 'popup-close', 'ai-harvest'],
    id: /^(tpl_dlg_|tpl_btn_close_popup|game-update-)/, name: /^(通用对话框|弹窗|顶号|网络断开|游戏资源更新)/ },
  { key: 'nav', label: '导航与主界面', tags: ['nav', 'worldmap', 'city', '入口'], id: /^tpl_(nav|world)_|^tpl_btn_back/, name: /^(世界地图|城内|主界面)/ },
  { key: 'search', label: '搜索面板', tags: ['search'], name: /^搜索面板/ },
  { key: 'card', label: '资源点卡片', tags: ['card', 'restype'], name: /^(资源点)?卡片/ },
  { key: 'troop', label: '部队管理', tags: ['troop-panel', 'troop', '部队管理'], name: /^部队管理/ },
  { key: 'dispatch', label: '创建部队与行军', tags: ['createtroop', 'dispatch'], name: /^(创建部队|地图气泡)/ },
];

const RULE_ORDER = new Map(RULES.map((rule, i) => [rule.key, i]));
const RULE_LABEL = new Map(RULES.map((rule) => [rule.key, rule.label]));

/** Digit glyph templates: read by the OCR as a set, never tapped by a script. */
export function isGlyphTemplate(template: TemplateLike): boolean {
  return Boolean(template.tags?.includes('digit')) || template.id.startsWith('dig_');
}

/** The glyph set a digit template belongs to: its `dig_*` tag, else the id without the last part (dig_dark20_7 → dig_dark20). */
export function glyphSetOf(template: TemplateLike): string {
  const tagged = template.tags?.find((tag) => tag.startsWith('dig_'));
  if (tagged) return tagged;
  const cut = template.id.lastIndexOf('_');
  return cut > 0 ? template.id.slice(0, cut) : template.id;
}

/** The screen word at the start of a name: 「资源统计-行标签」 → 资源统计; nothing when the name has no separator. */
function namePrefix(name: string): string | null {
  const match = /^([^-－—·:：（(\s]{1,10})\s*[-－—·:：]/.exec(name.trim());
  return match ? match[1]! : null;
}

export interface TemplateGroupKey {
  key: string;
  label: string;
}

export function templateGroupOf(template: TemplateLike): TemplateGroupKey {
  if (isGlyphTemplate(template)) return { key: GLYPH_GROUP, label: '数字字形' };
  const tags = template.tags ?? [];
  for (const rule of RULES) {
    if (rule.tags?.some((tag) => tags.includes(tag)) || rule.id?.test(template.id) || rule.name?.test(template.name.trim())) {
      return { key: rule.key, label: rule.label };
    }
  }
  const prefix = namePrefix(template.name);
  return prefix ? { key: `name:${prefix}`, label: prefix } : { key: UNGROUPED, label: '未分组' };
}

export interface GlyphSubset<T extends TemplateLike = TemplateLike> {
  name: string;
  /** A readable label: the part of the first glyph's name before the digit (「等级数字-7」 → 等级数字). */
  label: string;
  templates: T[];
}

export interface TemplateGroup<T extends TemplateLike = TemplateLike> {
  key: string;
  label: string;
  templates: T[];
  /** Only the glyph group: its templates split by glyph set. */
  subsets?: GlyphSubset<T>[];
}

function glyphLabel(template: TemplateLike, set: string): string {
  const name = template.name.trim();
  const match = /^(.+?)[\s-－·]*(?:字形\s*)?[^\s-－·]{1,2}$/.exec(name);
  const base = match?.[1]?.replace(/[\s-－·]+$/, '').replace(/\s*字形$/, '');
  return base && base !== set && !base.startsWith('dig_') ? base : set;
}

function groupRank(key: string): number {
  if (key === GLYPH_GROUP) return 3000;
  if (key === UNGROUPED) return 2000;
  return RULE_ORDER.get(key) ?? 1000;
}

/**
 * The set's templates in groups: the known screens in a fixed order, then groups named after a name prefix
 * (alphabetical), 未分组, and the digit glyphs last (split by glyph set). Templates keep the set's order inside a group.
 */
export function groupTemplates<T extends TemplateLike>(templates: readonly T[]): TemplateGroup<T>[] {
  const groups = new Map<string, TemplateGroup<T>>();
  for (const template of templates) {
    const { key, label } = templateGroupOf(template);
    const group = groups.get(key) ?? { key, label, templates: [] };
    group.templates.push(template);
    groups.set(key, group);
  }
  const glyphs = groups.get(GLYPH_GROUP);
  if (glyphs) {
    const subsets = new Map<string, GlyphSubset<T>>();
    for (const template of glyphs.templates) {
      const name = glyphSetOf(template);
      const subset = subsets.get(name) ?? { name, label: name, templates: [] };
      // The first glyph with a readable name labels the set (some sets only have 「dig_x 字形 7」 names).
      if (subset.label === name) subset.label = glyphLabel(template, name);
      subset.templates.push(template);
      subsets.set(name, subset);
    }
    glyphs.subsets = [...subsets.values()];
  }
  return [...groups.values()].sort((a, b) => groupRank(a.key) - groupRank(b.key) || a.label.localeCompare(b.label, 'zh-CN'));
}

/** Search text: name, id, tags and note, case-insensitive; several words must all match. */
export function matchesTemplateQuery(template: TemplateLike, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = [template.name, template.id, ...(template.tags ?? []), template.note ?? '', templateGroupOf(template).label].join(' ').toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/** The groups narrowed to a query (empty groups and glyph subsets dropped). */
export function filterTemplateGroups<T extends TemplateLike>(groups: readonly TemplateGroup<T>[], query: string): TemplateGroup<T>[] {
  if (!query.trim()) return groups as TemplateGroup<T>[];
  const out: TemplateGroup<T>[] = [];
  for (const group of groups) {
    const templates = group.templates.filter((template) => matchesTemplateQuery(template, query));
    if (templates.length === 0) continue;
    const subsets = group.subsets?.map((subset) => ({ ...subset, templates: subset.templates.filter((t) => templates.includes(t)) }))
      .filter((subset) => subset.templates.length > 0);
    out.push({ ...group, templates, ...(subsets ? { subsets } : {}) });
  }
  return out;
}

/**
 * Templates a script step can reasonably pick: everything except digit glyphs, which only the OCR reads. A glyph that
 * is already referenced (or asked for by the filter text) stays, so an existing script never loses its choice.
 */
export function pickableTemplates<T extends TemplateLike>(templates: readonly T[], keep: readonly string[] = [], query = ''): T[] {
  const wantsGlyphs = /\bdig_|字形|digit/i.test(query);
  return templates.filter((template) => !isGlyphTemplate(template) || wantsGlyphs || keep.includes(template.id));
}

export function groupLabel(key: string): string {
  if (key === GLYPH_GROUP) return '数字字形';
  if (key === UNGROUPED) return '未分组';
  return RULE_LABEL.get(key) ?? key.replace(/^name:/, '');
}

// ── the template library list: category filter, search and pages ──

/** Rows per page of the template library list (a page fits the editor's height without scrolling). */
export const TEMPLATE_PAGE_SIZE = 12;

/** 界面模板 = everything but the digit glyphs (the default view); `all`; a group key; or `glyph:<set>`. */
export const FILTER_UI = 'ui';
export const FILTER_ALL = 'all';

export interface TemplateFilterOption {
  value: string;
  label: string;
  count: number;
}

export interface TemplateFilterOptions {
  /** 界面模板 / 全部 and one entry per screen group. */
  main: TemplateFilterOption[];
  /** All glyphs, then one entry per glyph set. Empty when the set has no glyphs. */
  glyphs: TemplateFilterOption[];
}

export function templateFilterOptions(templates: readonly TemplateLike[]): TemplateFilterOptions {
  const groups = groupTemplates(templates);
  const glyph = groups.find((group) => group.key === GLYPH_GROUP);
  const screens = groups.filter((group) => group.key !== GLYPH_GROUP);
  const ui = templates.length - (glyph?.templates.length ?? 0);
  return {
    main: [
      { value: FILTER_UI, label: '界面模板（不含数字字形）', count: ui },
      ...screens.map((group) => ({ value: group.key, label: group.label, count: group.templates.length })),
      { value: FILTER_ALL, label: '全部模板', count: templates.length },
    ],
    glyphs: glyph ? [
      { value: GLYPH_GROUP, label: '全部数字字形', count: glyph.templates.length },
      ...(glyph.subsets ?? []).map((subset) => ({ value: `${GLYPH_GROUP}:${subset.name}`, label: subset.label === subset.name ? subset.name : `${subset.label}（${subset.name}）`, count: subset.templates.length })),
    ] : [],
  };
}

/** Whether a template belongs to a filter value (see `FILTER_UI`). Unknown values show everything. */
export function inTemplateFilter(template: TemplateLike, filter: string): boolean {
  if (filter === FILTER_ALL) return true;
  if (filter === FILTER_UI) return !isGlyphTemplate(template);
  if (filter.startsWith(`${GLYPH_GROUP}:`)) return isGlyphTemplate(template) && glyphSetOf(template) === filter.slice(GLYPH_GROUP.length + 1);
  return templateGroupOf(template).key === filter;
}

/** The templates of a filter + search, in the set's order. */
export function filterTemplates<T extends TemplateLike>(templates: readonly T[], filter: string, query: string): T[] {
  return templates.filter((template) => inTemplateFilter(template, filter) && matchesTemplateQuery(template, query));
}

export interface TemplatePage<T> {
  items: T[];
  /** 0-based, clamped into range. */
  page: number;
  pages: number;
  total: number;
  /** 1-based range shown, 0–0 when empty. */
  from: number;
  to: number;
}

export function pageOf<T>(items: readonly T[], page: number, size = TEMPLATE_PAGE_SIZE): TemplatePage<T> {
  const pages = Math.max(1, Math.ceil(items.length / size));
  const current = Math.min(pages - 1, Math.max(0, Math.trunc(Number.isFinite(page) ? page : 0)));
  const start = current * size;
  const slice = items.slice(start, start + size);
  return { items: slice, page: current, pages, total: items.length, from: slice.length ? start + 1 : 0, to: start + slice.length };
}

/**
 * Page buttons of a pager (0-based page numbers; 'gap' = an ellipsis): every page up to 7, otherwise the first,
 * the last and the current one with its neighbours.
 */
export function pageButtons(page: number, pages: number): Array<number | 'gap'> {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i);
  const keep = new Set([0, pages - 1, page - 1, page, page + 1].filter((n) => n >= 0 && n < pages));
  if (page <= 2) [1, 2, 3].forEach((n) => keep.add(n));
  if (page >= pages - 3) [pages - 4, pages - 3, pages - 2].forEach((n) => keep.add(n));
  const sorted = [...keep].sort((a, b) => a - b);
  const out: Array<number | 'gap'> = [];
  sorted.forEach((n, i) => {
    if (i > 0 && n - sorted[i - 1]! > 1) out.push('gap');
    out.push(n);
  });
  return out;
}

/** The page that shows `id`, or null when the list does not contain it. */
export function pageContaining(items: readonly Pick<TemplateLike, 'id'>[], id: string | null, size = TEMPLATE_PAGE_SIZE): number | null {
  if (!id) return null;
  const at = items.findIndex((item) => item.id === id);
  return at < 0 ? null : Math.floor(at / size);
}
