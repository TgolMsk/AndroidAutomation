/**
 * Block layer: the pure logic behind the visual script editor (ported from wanlong-panel `src/shared/blocks.ts`).
 *
 * Two things, both independent of the UI (no React, no DOM, no IPC), so the offline tests run them directly:
 *
 *   1. Block-tree editing. A script's steps form a tree (if has then/else, loop has steps). Every block on screen
 *      is addressed by a PATH: [2] = the third top-level block, [2, 'then', 0] = the first block of that if's
 *      「成立时」 branch. Every operation returns new arrays (never mutates), so React state comparisons hold.
 *
 *   2. The block catalog. DSL kinds (tapTemplate / waitFor / onFail) ⇄ the Chinese blocks on the panel
 *      (「点这张图」「等它出现」「失败了怎么办」). The mapping between the two vocabularies lives ONLY here; no
 *      component translates on its own.
 *
 * ★ Why the UI does not edit JSON directly: one wrong comma and the whole script no longer parses. Path operations
 *   are structural and cannot break it; the JSON mode stays for people who hand-write complex logic.
 *
 * Renderer-safe: part of `@avdm/automation/script`, type-only imports.
 */
import type { TemplateDefinition } from '../contracts.js';
import type { AndroidKey, Condition, FailPolicy, ScriptStep } from './types.js';
import { SCRIPT_LIMITS } from './validate.js';

// ═══════════════════════════════════════════════════════════════════════════
// 1. Block tree
// ═══════════════════════════════════════════════════════════════════════════

/** Branch names. Leaf blocks have none. */
export type Branch = 'then' | 'else' | 'steps';

/** Block path: numbers are sibling positions, strings are branch names, e.g. [1, 'then', 0]. */
export type BlockPath = (number | Branch)[];

/** What the templates in a block need: an id and a display name. */
export type TemplateRef = Pick<TemplateDefinition, 'id' | 'name'>;

export function pathKey(path: BlockPath): string {
  return path.join('/');
}

export function samePath(a: BlockPath, b: BlockPath): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** The branches under a block, in display order. */
export function branchesOf(step: ScriptStep): Branch[] {
  if (step.kind === 'if') return step.else ? ['then', 'else'] : ['then'];
  if (step.kind === 'loop') return ['steps'];
  return [];
}

export function childrenOf(step: ScriptStep, branch: Branch): ScriptStep[] {
  if (step.kind === 'if') {
    if (branch === 'then') return step.then;
    if (branch === 'else') return step.else ?? [];
  }
  if (step.kind === 'loop' && branch === 'steps') return step.steps;
  return [];
}

export function withChildren(step: ScriptStep, branch: Branch, children: ScriptStep[]): ScriptStep {
  if (step.kind === 'if' && branch === 'then') return { ...step, then: children };
  if (step.kind === 'if' && branch === 'else') return { ...step, else: children };
  if (step.kind === 'loop' && branch === 'steps') return { ...step, steps: children };
  return step;
}

interface Located {
  list: ScriptStep[];
  index: number;
  rebuild: (list: ScriptStep[]) => ScriptStep[];
}

/**
 * Split a path into "the array that holds the block" + "its index there".
 * Null means the path points nowhere (the UI just removed a block and an old button was clicked): callers then
 * return the tree unchanged instead of failing.
 */
function locate(steps: ScriptStep[], path: BlockPath): Located | null {
  if (path.length === 0) return null;
  const [head, ...rest] = path;
  if (typeof head !== 'number' || !Number.isInteger(head) || head < 0 || head >= steps.length) return null;

  if (rest.length === 0) return { list: steps, index: head, rebuild: (list) => list };

  const [branch, ...tail] = rest;
  if (typeof branch !== 'string') return null;
  const parent = steps[head]!;
  // A branch the block does not have yields no children, so the inner lookup fails (null) as it should.
  const inner = locate(childrenOf(parent, branch), tail);
  if (!inner) return null;
  return {
    list: inner.list,
    index: inner.index,
    rebuild: (list) => {
      const nextChildren = inner.rebuild(list);
      const next = [...steps];
      next[head] = withChildren(parent, branch, nextChildren);
      return next;
    },
  };
}

export function getAt(steps: ScriptStep[], path: BlockPath): ScriptStep | null {
  const at = locate(steps, path);
  return at ? (at.list[at.index] ?? null) : null;
}

export function updateAt(steps: ScriptStep[], path: BlockPath, next: ScriptStep): ScriptStep[] {
  const at = locate(steps, path);
  if (!at) return steps;
  const list = [...at.list];
  list[at.index] = next;
  return at.rebuild(list);
}

export function removeAt(steps: ScriptStep[], path: BlockPath): ScriptStep[] {
  const at = locate(steps, path);
  if (!at) return steps;
  const list = [...at.list];
  list.splice(at.index, 1);
  return at.rebuild(list);
}

/** Insert AFTER the given position. An empty (or stale) path appends to the end of the top level. */
export function insertAfter(steps: ScriptStep[], path: BlockPath, added: ScriptStep[]): ScriptStep[] {
  if (path.length === 0) return [...steps, ...added];
  const at = locate(steps, path);
  if (!at) return [...steps, ...added];
  const list = [...at.list];
  list.splice(at.index + 1, 0, ...added);
  return at.rebuild(list);
}

/** Append to the end of a branch (the 「往这个分支里加一块」 buttons). */
export function appendToBranch(steps: ScriptStep[], parentPath: BlockPath, branch: Branch, added: ScriptStep[]): ScriptStep[] {
  const parent = getAt(steps, parentPath);
  if (!parent) return steps;
  if (parent.kind !== 'loop' && parent.kind !== 'if') return steps;
  if ((parent.kind === 'loop') !== (branch === 'steps')) return steps;
  const children = [...childrenOf(parent, branch), ...added];
  return updateAt(steps, parentPath, withChildren(parent, branch, children));
}

/** Move up or down among siblings. At the top / bottom the tree comes back unchanged. */
export function moveAt(steps: ScriptStep[], path: BlockPath, delta: -1 | 1): ScriptStep[] {
  const at = locate(steps, path);
  if (!at) return steps;
  const to = at.index + delta;
  if (to < 0 || to >= at.list.length) return steps;
  const list = [...at.list];
  const [moved] = list.splice(at.index, 1);
  list.splice(to, 0, moved!);
  return at.rebuild(list);
}

/** Where a block is after moving (the panel moves the selection along). */
export function movedPath(path: BlockPath, delta: -1 | 1): BlockPath {
  const next = [...path];
  const last = next[next.length - 1];
  if (typeof last === 'number') next[next.length - 1] = last + delta;
  return next;
}

/** The path of the block right after `path` among its siblings (where a block inserted after it lands). */
export function nextSiblingPath(path: BlockPath): BlockPath {
  return movedPath(path, 1);
}

/** Nesting depth of a block: 0 on the top level, +1 per if / loop body around it. */
export function pathDepth(path: BlockPath): number {
  return path.filter((part) => typeof part === 'string').length;
}

/** Path of the block with this id anywhere in the tree (「点问题定位」 in the visual mode), or null. */
export function findPathById(steps: ScriptStep[], id: string, base: BlockPath = []): BlockPath | null {
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const path: BlockPath = [...base, i];
    if (step.id === id) return path;
    for (const branch of branchesOf(step)) {
      const found = findPathById(childrenOf(step, branch), id, [...path, branch]);
      if (found) return found;
    }
  }
  return null;
}

/** Every step id already used anywhere in the tree; new ids must avoid them. */
export function collectIds(steps: ScriptStep[], into = new Set<string>()): Set<string> {
  for (const s of steps) {
    into.add(s.id);
    for (const b of branchesOf(s)) collectIds(childrenOf(s, b), into);
  }
  return into;
}

function freshId(used: Set<string>, prefix: string): string {
  for (let n = 1; n < 10_000; n++) {
    const id = `${prefix}-${n}`;
    if (!used.has(id)) return id;
  }
  return `${prefix}-${Date.now()}`;
}

/**
 * An id that collides with no block in the tree, shaped like `tap-3`: the block kind as prefix, so a log line
 * tells at a glance which step it is.
 */
export function nextStepId(steps: ScriptStep[], prefix: string): string {
  return freshId(collectIds(steps), prefix);
}

/**
 * Deep copy of a block (children included) with EVERY id inside replaced by an unused one — the 「复制」 button.
 * ★ Children too: otherwise copying an if block makes saving fail with duplicate step ids. Ids are registered as
 *   they are generated, so the copy never collides with itself either.
 */
export function cloneWithNewIds(steps: ScriptStep[], step: ScriptStep): ScriptStep {
  const used = collectIds(steps);
  const fresh = (prefix: string): string => {
    const id = freshId(used, prefix);
    used.add(id);
    return id;
  };
  const walk = (s: ScriptStep): ScriptStep => {
    const copy: ScriptStep = { ...s, id: fresh(s.kind) };
    if (copy.kind === 'if') {
      return { ...copy, then: copy.then.map(walk), ...(copy.else ? { else: copy.else.map(walk) } : {}) };
    }
    if (copy.kind === 'loop') return { ...copy, steps: copy.steps.map(walk) };
    return copy;
  };
  // A detached copy first: conditions, points and offsets of the clone never share objects with the source.
  return walk(JSON.parse(JSON.stringify(step)) as ScriptStep);
}

/** How many blocks the whole tree has (children included) — 「共 N 块」 on the panel. */
export function countBlocks(steps: ScriptStep[]): number {
  let n = 0;
  for (const s of steps) {
    n += 1;
    for (const b of branchesOf(s)) n += countBlocks(childrenOf(s, b));
  }
  return n;
}

/** Every template id the tree references (the panel checks they are still in the template set). */
export function collectTemplateIds(steps: ScriptStep[], into = new Set<string>()): Set<string> {
  const fromCond = (c: unknown): void => {
    if (typeof c !== 'object' || c === null) return;
    const o = c as Record<string, unknown>;
    if (typeof o.templateId === 'string') into.add(o.templateId);
    if (Array.isArray(o.templateIds)) {
      for (const id of o.templateIds) if (typeof id === 'string') into.add(id);
    }
    for (const key of ['all', 'any'] as const) {
      const list = o[key];
      if (Array.isArray(list)) for (const sub of list) fromCond(sub);
    }
    if (o.of) fromCond(o.of);
  };
  for (const s of steps) {
    if (s.kind === 'tapTemplate') into.add(s.templateId);
    if (s.kind === 'waitFor') fromCond(s.cond);
    // ★ An if condition and a loop's while reference templates too; missing them loses a whole branch's dependencies.
    if (s.kind === 'if') fromCond(s.cond);
    if (s.kind === 'loop' && s.while) fromCond(s.while);
    if (s.when) fromCond(s.when);
    for (const b of branchesOf(s)) collectTemplateIds(childrenOf(s, b), into);
  }
  return into;
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. Block catalog (DSL ⇄ Chinese blocks)
// ═══════════════════════════════════════════════════════════════════════════

/** Block kinds on the panel. Mostly one-to-one with DSL kinds; waitFor is split into 「等出现 / 等消失」. */
export type BlockKind =
  | 'tapTemplate'
  | 'waitAppear'
  | 'waitDisappear'
  | 'tap'
  | 'swipe'
  | 'longPress'
  | 'text'
  | 'key'
  | 'sleep'
  | 'launchApp'
  | 'stopApp'
  | 'screenshot'
  | 'log'
  | 'if'
  | 'loop'
  | 'label'
  | 'goto';

export type BlockGroup = '画面' | '操作' | '应用' | '流程';

/** The four groups of the 「加一块」 menu, in display order. */
export const BLOCK_GROUPS: readonly BlockGroup[] = ['画面', '操作', '应用', '流程'];

export interface BlockMeta {
  kind: BlockKind;
  /** Block name on the panel. */
  label: string;
  /** One sentence on what it does, shown on hover. */
  hint: string;
  /** Group: which column of the 「加一块」 menu it sits in. */
  group: BlockGroup;
  /** Needs a template in the template set. */
  needsTemplate?: boolean;
}

export const BLOCK_CATALOG: readonly BlockMeta[] = [
  { kind: 'tapTemplate', label: '点这张图', hint: '在画面里找这张模板，找到就点它。自动化里 90% 的动作都是这一块。', group: '画面', needsTemplate: true },
  { kind: 'waitAppear', label: '等它出现', hint: '一直等到这张模板出现为止；等过头了算这一步失败。', group: '画面', needsTemplate: true },
  { kind: 'waitDisappear', label: '等它消失', hint: '等到这张模板从画面上消失（等加载圈转完最常用）。', group: '画面', needsTemplate: true },
  { kind: 'tap', label: '点固定坐标', hint: '点画面上的一个固定位置。界面一改版就会点空，能用模板就别用它。', group: '操作' },
  { kind: 'swipe', label: '滑动', hint: '从一个点滑到另一个点。', group: '操作' },
  { kind: 'longPress', label: '长按', hint: '按住不放一段时间。', group: '操作' },
  { kind: 'text', label: '输入文字', hint: '往当前输入框里打字；中文要先给实例装好并启用 ADBKeyboard 输入法。', group: '操作' },
  { kind: 'key', label: '按系统键', hint: '返回 / 主页 / 回车这类系统按键。', group: '操作' },
  { kind: 'sleep', label: '等一会儿', hint: '干等一段时间。能用「等它出现」就别用死等。', group: '操作' },
  { kind: 'launchApp', label: '启动应用', hint: '把当前游戏拉到前台（只能启动当前游戏）；勾上「冷启动」会先杀掉再重开。', group: '应用' },
  { kind: 'stopApp', label: '关闭应用', hint: '强制停止当前游戏。', group: '应用' },
  { kind: 'screenshot', label: '留一张截图', hint: '主动存一张现场图，方便事后排查。', group: '应用' },
  { kind: 'log', label: '记一行日志', hint: '往运行日志里写一句话，标记跑到哪了。', group: '应用' },
  { kind: 'if', label: '条件分支', hint: '条件成立走一条路，不成立走另一条。', group: '流程' },
  { kind: 'loop', label: '循环', hint: '把里面的块重复跑若干次，或一直跑到条件不成立。', group: '流程' },
  { kind: 'label', label: '落点', hint: '给「跳转」用的落脚点，本身什么都不做。', group: '流程' },
  { kind: 'goto', label: '跳转', hint: '跳到某个落点。只能跳到同级或外层。', group: '流程' },
];

export function blockMeta(kind: BlockKind): BlockMeta {
  return BLOCK_CATALOG.find((b) => b.kind === kind) ?? BLOCK_CATALOG[0]!;
}

/** The other way round: which panel block an existing step is. */
export function kindOfStep(step: ScriptStep): BlockKind {
  if (step.kind === 'waitFor') {
    const c = step.cond;
    if (c.kind === 'template' && c.present === false) return 'waitDisappear';
    return 'waitAppear';
  }
  return step.kind as BlockKind;
}

/** Id prefix for a new block of this kind: both wait blocks share `wait`, the rest use their kind. */
export function idPrefixOf(kind: BlockKind): string {
  return kind === 'waitAppear' || kind === 'waitDisappear' ? 'wait' : kind;
}

/** Flow blocks that open a nested body (they may not sit deeper than the validator's nesting limit). */
export function opensBranch(kind: BlockKind): boolean {
  return kind === 'if' || kind === 'loop';
}

/**
 * Whether a block of `kind` may be added at nesting depth `depth` (0 = top level). If / loop bodies count one
 * level each and the validator refuses more than `SCRIPT_LIMITS.maxDepth`, so an if / loop cannot sit at the limit.
 */
export function canAddAtDepth(kind: BlockKind, depth: number): boolean {
  return depth <= SCRIPT_LIMITS.maxDepth && (!opensBranch(kind) || depth < SCRIPT_LIMITS.maxDepth);
}

/** A new block's default content. `templateId` is only used by the screen blocks. */
export function makeBlock(kind: BlockKind, id: string, templateId?: string): ScriptStep {
  const tpl = templateId ?? '';
  switch (kind) {
    case 'tapTemplate': return { id, kind: 'tapTemplate', templateId: tpl, waitMs: 3000, retry: 1 };
    case 'waitAppear': return { id, kind: 'waitFor', cond: { kind: 'template', templateId: tpl }, waitMs: 10_000 };
    case 'waitDisappear': return { id, kind: 'waitFor', cond: { kind: 'template', templateId: tpl, present: false }, waitMs: 10_000 };
    // (0, 0) on purpose: blockIssue flags it, so the author does not forget to fill it in.
    case 'tap': return { id, kind: 'tap', at: { x: 0, y: 0 } };
    case 'swipe': return { id, kind: 'swipe', from: { x: 0, y: 0 }, to: { x: 0, y: 0 }, durationMs: 300 };
    case 'longPress': return { id, kind: 'longPress', at: { x: 0, y: 0 }, durationMs: 800 };
    case 'text': return { id, kind: 'text', text: '' };
    case 'key': return { id, kind: 'key', key: 'BACK' };
    case 'sleep': return { id, kind: 'sleep', ms: 1000 };
    case 'launchApp': return { id, kind: 'launchApp', cold: false };
    case 'stopApp': return { id, kind: 'stopApp' };
    case 'screenshot': return { id, kind: 'screenshot' };
    case 'log': return { id, kind: 'log', level: 'info', message: '' };
    case 'if': return { id, kind: 'if', cond: { kind: 'template', templateId: tpl }, then: [] };
    case 'loop': return { id, kind: 'loop', steps: [], repeat: 3 };
    case 'label': return { id, kind: 'label', label: DEFAULT_LABEL };
    case 'goto': return { id, kind: 'goto', label: DEFAULT_LABEL, maxTimes: 10 };
  }
}

/** Default label of new 落点 / 跳转 blocks and of onFail=goto (any non-empty text is a valid label). */
export const DEFAULT_LABEL = '落点1';

/** The one template a block mainly uses (tapTemplate, a template waitFor or if), or null. */
export function templateIdOf(step: ScriptStep): string | null {
  if (step.kind === 'tapTemplate') return step.templateId;
  if (step.kind === 'waitFor' && step.cond.kind === 'template') return step.cond.templateId;
  if (step.kind === 'if' && step.cond.kind === 'template') return step.cond.templateId;
  return null;
}

/** Replace the template a block mainly uses. */
export function withTemplateId(step: ScriptStep, templateId: string): ScriptStep {
  if (step.kind === 'tapTemplate') return { ...step, templateId };
  if (step.kind === 'waitFor' && step.cond.kind === 'template') return { ...step, cond: { ...step.cond, templateId } };
  if (step.kind === 'if' && step.cond.kind === 'template') return { ...step, cond: { ...step.cond, templateId } };
  return step;
}

export const ANDROID_KEY_TEXT: Readonly<Record<AndroidKey, string>> = {
  BACK: '返回',
  HOME: '主页',
  ENTER: '回车',
  MENU: '菜单',
  APP_SWITCH: '任务列表',
  DEL: '退格',
  ESCAPE: 'Esc',
  VOLUME_UP: '音量 +',
  VOLUME_DOWN: '音量 −',
};

export const FAIL_POLICY_TEXT: Readonly<Record<FailPolicy['kind'], string>> = {
  abort: '停止整个脚本',
  continue: '跳过，继续下一块',
  goto: '跳到某个落点',
  restartApp: '重启应用，从头再来',
};

/** Branch captions under an if / loop card. */
export const BRANCH_TEXT: Readonly<Record<Branch, string>> = {
  then: '成立时',
  else: '否则',
  steps: '循环体',
};

/**
 * The step's onFail after picking a policy in the form: abort is stored as undefined (the default, keeps the JSON
 * clean), goto starts at the default label.
 */
export function failPolicyFor(kind: FailPolicy['kind'], current?: FailPolicy): FailPolicy | undefined {
  if (kind === 'abort') return undefined;
  if (kind === 'goto') return current?.kind === 'goto' ? current : { kind: 'goto', label: DEFAULT_LABEL };
  return { kind };
}

/** Template id → Chinese name. Unknown ids show as themselves (the template was deleted). */
export function templateName(templates: readonly TemplateRef[], id: string | null): string {
  if (!id) return '（还没选模板）';
  return templates.find((t) => t.id === id)?.name ?? id;
}

/** A condition in Chinese. Composite ones (and / or / not) only get a summary; editing them needs the JSON mode. */
export function describeCond(cond: Condition, templates: readonly TemplateRef[]): string {
  switch (cond.kind) {
    case 'always': return '总是成立';
    case 'never': return '永不成立';
    case 'template':
      return cond.present === false
        ? `画面上没有「${templateName(templates, cond.templateId)}」`
        : `画面上有「${templateName(templates, cond.templateId)}」`;
    case 'anyTemplate': return `出现任意一张：${cond.templateIds.map((id) => templateName(templates, id)).join('、')}`;
    case 'foreground': return cond.equals === false ? `前台不是「${cond.packageName}」` : `前台是「${cond.packageName}」`;
    case 'and': return `同时满足 ${cond.all.length} 个条件`;
    case 'or': return `满足 ${cond.any.length} 个条件之一`;
    case 'not': return '不满足某个条件';
  }
}

export interface DescribeOptions {
  /**
   * How launchApp / stopApp name the app when the step names none (the Assistant only runs the game's own
   * package). Default: the original's 「脚本指定的应用」.
   */
  appLabel?: string;
}

/** The sentence a block shows on its card. The more it reads like speech the better: it is the panel's most frequent text. */
export function describeBlock(step: ScriptStep, templates: readonly TemplateRef[], options: DescribeOptions = {}): string {
  const app = (pkg: string | undefined): string => pkg ? `「${pkg}」` : options.appLabel ? `「${options.appLabel}」` : '脚本指定的应用';
  switch (step.kind) {
    case 'tapTemplate': {
      const name = templateName(templates, step.templateId);
      const wait = step.waitMs ? `，最多等 ${Math.round(step.waitMs / 1000)} 秒` : '，只看当前这一帧';
      const off = step.offset && (step.offset.x || step.offset.y) ? `，偏移 (${step.offset.x}, ${step.offset.y})` : '';
      return `找到「${name}」就点它${wait}${off}`;
    }
    case 'waitFor': return `${describeCond(step.cond, templates)}，最多等 ${Math.round(step.waitMs / 1000)} 秒`;
    case 'tap': return `点 (${step.at.x}, ${step.at.y})`;
    case 'swipe': return `从 (${step.from.x}, ${step.from.y}) 滑到 (${step.to.x}, ${step.to.y})，用时 ${step.durationMs ?? 300}ms`;
    case 'longPress': return `在 (${step.at.x}, ${step.at.y}) 按住 ${step.durationMs}ms`;
    case 'text': return step.text ? `输入「${step.text}」` : '输入（内容还没填）';
    case 'key': return `按「${ANDROID_KEY_TEXT[step.key] ?? step.key}」键`;
    case 'sleep': return `等 ${step.ms}ms`;
    case 'launchApp': return `${step.cold ? '冷启动' : '启动'}${app(step.packageName)}`;
    case 'stopApp': return `关闭${app(step.packageName)}`;
    case 'screenshot': return step.label ? `留一张截图（${step.label}）` : '留一张截图';
    case 'log': return `日志：${step.message || '（还没填内容）'}`;
    case 'if': return `如果${describeCond(step.cond, templates)}`;
    case 'loop': {
      if (step.repeat != null && step.while) return `重复 ${step.repeat} 次，且只在「${describeCond(step.while, templates)}」时继续`;
      if (step.repeat != null) return `重复 ${step.repeat} 次`;
      if (step.while) return `只要「${describeCond(step.while, templates)}」就一直重复`;
      return '循环（还没设次数或条件）';
    }
    case 'label': return `落点「${step.label}」`;
    case 'goto': return `跳到落点「${step.label}」${step.maxTimes ? `，最多 ${step.maxTimes} 次` : ''}`;
  }
}

/**
 * An obvious problem with this block (the yellow tag on its card), or null.
 * Only what is visible at a glance; the real checks (reference integrity, goto targets …) stay in the main
 * process's script validation — the same rule is never written twice.
 */
export function blockIssue(step: ScriptStep, templateIds: ReadonlySet<string>): string | null {
  const tpl = templateIdOf(step);
  if (tpl !== null) {
    if (!tpl) return '还没选模板';
    if (!templateIds.has(tpl)) return `模板「${tpl}」不在这个脚本的模板集里`;
  }
  if (step.kind === 'text' && !step.text) return '还没填要输入的内容';
  if (step.kind === 'log' && !step.message) return '还没填日志内容';
  if (step.kind === 'loop' && step.repeat == null && !step.while) return '既没设次数也没设条件，会一直转下去';
  if (step.kind === 'tap' && step.at.x === 0 && step.at.y === 0) return '坐标还是 (0, 0)';
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. Condition editor modes
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The condition editor covers everyday use; and / or / not / never are `complex`: shown read-only, edited in
 * the JSON mode (a visual expression tree for a few percent of cases is not worth it).
 */
export type CondMode = 'none' | 'has' | 'hasNot' | 'anyOf' | 'foreground' | 'always' | 'complex';

export const COND_MODE_TEXT: Readonly<Record<Exclude<CondMode, 'complex'>, string>> = {
  none: '不设条件',
  has: '画面上有',
  hasNot: '画面上没有',
  anyOf: '出现任意一张',
  foreground: '前台应用是',
  always: '总是成立',
};

export function condModeOf(cond: Condition | undefined): CondMode {
  if (!cond) return 'none';
  switch (cond.kind) {
    case 'template': return cond.present === false ? 'hasNot' : 'has';
    case 'anyTemplate': return 'anyOf';
    case 'foreground': return 'foreground';
    case 'always': return 'always';
    default: return 'complex';
  }
}

/**
 * The condition a mode switch starts with: the set's first template for the template modes, the given package for
 * the foreground mode (the Assistant only checks the game's own package), null for 「不设条件」 and `complex`.
 */
export function seedCondition(mode: CondMode, templates: readonly TemplateRef[], packageName = ''): Condition | null {
  const first = templates[0]?.id ?? '';
  switch (mode) {
    case 'has': return { kind: 'template', templateId: first };
    case 'hasNot': return { kind: 'template', templateId: first, present: false };
    case 'anyOf': return { kind: 'anyTemplate', templateIds: first ? [first] : [] };
    case 'foreground': return { kind: 'foreground', packageName };
    case 'always': return { kind: 'always' };
    default: return null;
  }
}
