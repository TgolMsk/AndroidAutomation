/**
 * Offline checks of the visual editor's block layer (wanlong-panel `scripts/blocks-offline-check.ts`, 56 assertions
 * in six sections), plus the Assistant's additions (validator alignment, condition modes, id lookup, depth limit).
 *
 * Why it matters: these functions are ALL of "a click on the panel → what the script JSON becomes". One wrong
 * index and the user sees "I deleted block 3 and block 4 vanished" — hard to reproduce in the UI, two lines here.
 */
import { describe, expect, it } from 'vitest';
import {
  ANDROID_KEY_TEXT, BLOCK_CATALOG, BLOCK_GROUPS, BRANCH_TEXT, COND_MODE_TEXT, DEFAULT_LABEL, FAIL_POLICY_TEXT, SCRIPT_LIMITS,
  appendToBranch, blockIssue, blockMeta, branchesOf, canAddAtDepth, childrenOf, cloneWithNewIds, collectIds, collectTemplateIds,
  condModeOf, countBlocks, describeBlock, describeCond, failPolicyFor, fatalIssues, findPathById, getAt, idPrefixOf, insertAfter,
  kindOfStep, makeBlock, moveAt, movedPath, nextSiblingPath, nextStepId, pathDepth, pathKey, removeAt, samePath, seedCondition,
  templateIdOf, templateName, updateAt, validateScript, withTemplateId,
  type BlockKind, type Condition, type ScriptStep, type TemplateRef,
} from '../src/script/index.js';

const PKG = 'com.lilithgames.samo.android.cn';

/** A nested sample tree: tap / if (then two blocks, else one) / loop (one block). */
function sample(): ScriptStep[] {
  return [
    { id: 'a', kind: 'tap', at: { x: 10, y: 20 } },
    {
      id: 'b',
      kind: 'if',
      cond: { kind: 'template', templateId: 'tpl_x' },
      then: [
        { id: 'b1', kind: 'sleep', ms: 100 },
        { id: 'b2', kind: 'tapTemplate', templateId: 'tpl_y' },
      ],
      else: [{ id: 'b3', kind: 'key', key: 'BACK' }],
    },
    { id: 'c', kind: 'loop', repeat: 3, steps: [{ id: 'c1', kind: 'screenshot' }] },
  ];
}

const templates: TemplateRef[] = [
  { id: 'tpl_x', name: '联盟按钮' },
  { id: 'tpl_y', name: '确定按钮' },
];

const kinds = BLOCK_CATALOG.map((b) => b.kind);

describe('一、路径定位', () => {
  const t = sample();

  it('finds blocks on the top level and in every branch', () => {
    expect(getAt(t, [1])?.id).toBe('b'); // 顶层取块
    expect(getAt(t, [1, 'then', 1])?.id).toBe('b2'); // 分支里取块
    expect(getAt(t, [1, 'else', 0])?.id).toBe('b3'); // else 分支
    expect(getAt(t, [2, 'steps', 0])?.id).toBe('c1'); // 循环体
  });

  it('returns null for a path that points nowhere', () => {
    expect(getAt(t, [9])).toBeNull(); // 越界
    expect(getAt(t, [0, 'then', 0])).toBeNull(); // 走错分支
    expect(getAt(t, [])).toBeNull(); // 空路径
    expect(getAt(t, [1, 'steps', 0])).toBeNull(); // an if has no loop body
    expect(getAt(t, [1, 'then'])).toBeNull(); // a branch is not a block
  });

  it('compares paths', () => {
    expect(samePath([1, 'then', 0], [1, 'then', 0])).toBe(true);
    expect(samePath([1, 'then', 0], [1, 'else', 0])).toBe(false);
    expect(pathKey([1, 'then', 0])).toBe('1/then/0');
  });

  it('lists branches and children', () => {
    expect(branchesOf(t[1]!).join(',')).toBe('then,else'); // if 两个分支
    expect(branchesOf({ ...t[1]!, else: undefined } as ScriptStep).join(',')).toBe('then'); // 没有 else 时只报一个
    expect(branchesOf(t[2]!).join(',')).toBe('steps'); // loop 一个分支
    expect(branchesOf(t[0]!)).toHaveLength(0); // 叶子没有分支
    expect(childrenOf(t[1]!, 'then')).toHaveLength(2); // childrenOf 拿到子块
  });
});

describe('二、增删改（每次都返回新数组，绝不原地改）', () => {
  it('updates a block inside a branch without touching the original tree', () => {
    const t = sample();
    const frozen = JSON.stringify(t);
    const updated = updateAt(t, [1, 'then', 0], { id: 'b1', kind: 'sleep', ms: 999 });
    const changed = getAt(updated, [1, 'then', 0]);
    expect(changed?.kind === 'sleep' && changed.ms === 999).toBe(true); // 改分支里的块
    expect(JSON.stringify(t)).toBe(frozen); // ★ 原数组没被动过
    expect(getAt(updated, [1, 'then', 1])?.id).toBe('b2'); // 没动到的兄弟块还在
    expect(updated[0]).toBe(t[0]); // untouched siblings are shared, not copied
  });

  it('removes blocks in a branch and on the top level', () => {
    const t = sample();
    const removed = removeAt(t, [1, 'then', 0]);
    expect(childrenOf(getAt(removed, [1])!, 'then')).toHaveLength(1); // 删分支里的块
    expect(getAt(removed, [1, 'then', 0])?.id).toBe('b2'); // 删完剩下的是原来的第二块
    const removedTop = removeAt(t, [0]);
    expect(removedTop.length === 2 && removedTop[0]!.id === 'b').toBe(true); // 删顶层第一块
    expect(removeAt(t, [7])).toBe(t); // a stale path changes nothing
  });

  it('inserts after a block, and appends on an empty path', () => {
    const t = sample();
    const inserted = insertAfter(t, [0], [{ id: 'new', kind: 'sleep', ms: 1 }]);
    expect(inserted[1]!.id === 'new' && inserted[2]!.id === 'b').toBe(true); // 插在指定块之后
    const appended = insertAfter(t, [], [{ id: 'tail', kind: 'sleep', ms: 1 }]);
    expect(appended[appended.length - 1]!.id).toBe('tail'); // 空路径 = 追加到末尾
    const nested = insertAfter(t, [1, 'then', 0], [{ id: 'mid', kind: 'sleep', ms: 1 }]);
    expect(childrenOf(getAt(nested, [1])!, 'then').map((s) => s.id)).toEqual(['b1', 'mid', 'b2']);
    const stale = insertAfter(t, [5, 'then', 0], [{ id: 'x', kind: 'sleep', ms: 1 }]);
    expect(stale[stale.length - 1]!.id).toBe('x'); // a stale path appends to the end
  });

  it('appends into a branch', () => {
    const t = sample();
    const intoBranch = appendToBranch(t, [1], 'else', [{ id: 'e2', kind: 'sleep', ms: 1 }]);
    expect(childrenOf(getAt(intoBranch, [1])!, 'else')).toHaveLength(2); // 往分支末尾加块
    const intoLoop = appendToBranch(t, [2], 'steps', [{ id: 'c2', kind: 'sleep', ms: 1 }]);
    expect(childrenOf(getAt(intoLoop, [2])!, 'steps')).toHaveLength(2); // 往循环体加块
    const noElse: ScriptStep[] = [{ id: 'i', kind: 'if', cond: { kind: 'always' }, then: [] }];
    const created = appendToBranch(noElse, [0], 'else', [{ id: 'e', kind: 'sleep', ms: 1 }]);
    expect(childrenOf(created[0]!, 'else').map((s) => s.id)).toEqual(['e']); // else created on demand
    expect(appendToBranch(t, [0], 'then', [{ id: 'z', kind: 'sleep', ms: 1 }])).toBe(t); // a leaf has no branch
  });
});

describe('三、上下移动', () => {
  it('moves among siblings and stops at the ends', () => {
    const t = sample();
    const down = moveAt(t, [0], 1);
    expect(down[0]!.id === 'b' && down[1]!.id === 'a').toBe(true); // 顶层下移
    const up = moveAt(t, [2], -1);
    expect(up[1]!.id === 'c' && up[2]!.id === 'b').toBe(true); // 顶层上移
    expect(moveAt(t, [0], -1)[0]!.id).toBe('a'); // 到顶了就不动
    expect(moveAt(t, [2], 1)[2]!.id).toBe('c'); // 到底了就不动
  });

  it('moves inside a branch without touching the outer level', () => {
    const t = sample();
    const inBranch = moveAt(t, [1, 'then', 1], -1);
    expect(getAt(inBranch, [1, 'then', 0])?.id).toBe('b2'); // 分支内上移
    expect(inBranch[0]!.id === 'a' && inBranch[2]!.id === 'c').toBe(true); // 分支内移动不影响外层
    expect(samePath(movedPath([1, 'then', 1], -1), [1, 'then', 0])).toBe(true); // movedPath 跟着挪
    expect(nextSiblingPath([1, 'then', 0])).toEqual([1, 'then', 1]);
  });
});

describe('四、id 生成与统计', () => {
  it('collects ids and counts blocks including children', () => {
    const t = sample();
    const ids = collectIds(t);
    expect(ids.size).toBe(7); // 收集到全部 id（含子块）
    expect(countBlocks(t)).toBe(7); // 统计块数（含子块）
  });

  it('generates readable ids that never collide', () => {
    const t = sample();
    expect(collectIds(t).has(nextStepId(t, 'tap'))).toBe(false); // 新 id 不与现有冲突
    expect(nextStepId(t, 'tap')).toBe('tap-1');
    const withTap1: ScriptStep[] = [...t, { id: 'tap-1', kind: 'sleep', ms: 1 }];
    expect(nextStepId(withTap1, 'tap')).toBe('tap-2'); // 已被占用就往后找
    const nestedTaken: ScriptStep[] = [{ id: 'l', kind: 'loop', repeat: 1, steps: [{ id: 'wait-1', kind: 'sleep', ms: 1 }] }];
    expect(nextStepId(nestedTaken, 'wait')).toBe('wait-2'); // ids inside bodies count too
  });

  it('clones a block with fresh ids for the block AND every child (★ else saving reports duplicate ids)', () => {
    const t = sample();
    const ids = collectIds(t);
    const copy = cloneWithNewIds(t, t[1]!);
    expect(copy.id).not.toBe('b'); // 复制出来的块换了 id
    expect(copy.kind === 'if' && copy.then.every((s) => !ids.has(s.id))).toBe(true); // ★ 子块的 id 也全换了
    expect(copy.kind === 'if' && copy.then.length === 2).toBe(true); // 复制保留了内容
    const all = copy.kind === 'if' ? [copy.id, ...copy.then.map((s) => s.id), ...(copy.else ?? []).map((s) => s.id)] : [];
    expect(new Set(all).size).toBe(4); // no collision inside the copy itself
    expect(all.some((id) => ids.has(id))).toBe(false);
    // The clone shares no objects with the source: editing it never changes the original block.
    expect(copy.kind === 'if' && t[1]!.kind === 'if' && copy.cond !== t[1]!.cond).toBe(true);
  });

  it('collects every referenced template, conditions included', () => {
    const t = sample();
    const tplIds = collectTemplateIds(t);
    expect(tplIds.has('tpl_x') && tplIds.has('tpl_y')).toBe(true); // 收集到引用的模板
    const deep: ScriptStep[] = [
      { id: 'l', kind: 'loop', while: { kind: 'template', templateId: 'while_tpl' }, steps: [] },
      { id: 's', kind: 'sleep', ms: 1, when: { kind: 'not', of: { kind: 'template', templateId: 'when_tpl' } } },
      {
        id: 'w', kind: 'waitFor', waitMs: 1,
        cond: { kind: 'and', all: [{ kind: 'anyTemplate', templateIds: ['any_a', 'any_b'] }, { kind: 'or', any: [{ kind: 'template', templateId: 'or_tpl' }] }] },
      },
    ];
    expect([...collectTemplateIds(deep)].sort()).toEqual(['any_a', 'any_b', 'or_tpl', 'when_tpl', 'while_tpl']);
  });

  it('finds a block by id anywhere in the tree (issue list → card)', () => {
    const t = sample();
    expect(findPathById(t, 'b2')).toEqual([1, 'then', 1]);
    expect(findPathById(t, 'b3')).toEqual([1, 'else', 0]);
    expect(findPathById(t, 'c1')).toEqual([2, 'steps', 0]);
    expect(findPathById(t, 'nope')).toBeNull();
    expect(pathDepth([1, 'then', 1])).toBe(1);
    expect(pathDepth([0])).toBe(0);
  });
});

describe('五、块目录：DSL ⇄ 中文块', () => {
  it('has no duplicate kinds and covers the four groups', () => {
    expect(new Set(kinds).size).toBe(kinds.length); // 目录里没有重复的块
    expect(kinds).toHaveLength(17);
    expect(new Set(BLOCK_CATALOG.map((b) => b.group))).toEqual(new Set(BLOCK_GROUPS));
    expect(BLOCK_CATALOG.filter((b) => b.needsTemplate).map((b) => b.kind)).toEqual(['tapTemplate', 'waitAppear', 'waitDisappear']);
    expect(blockMeta('nope' as BlockKind)).toBe(BLOCK_CATALOG[0]); // unknown falls back to the first entry
  });

  it('★ every block kind survives makeBlock → kindOfStep, and has a Chinese summary', () => {
    const bad: string[] = [];
    for (const kind of kinds) {
      const step = makeBlock(kind, `${kind}-1`, 'tpl_x');
      if (kindOfStep(step) !== kind) bad.push(`${kind}→${kindOfStep(step)}`);
      if (!describeBlock(step, templates)) bad.push(`${kind} 没有摘要`);
    }
    expect(bad).toEqual([]); // 每种块「建出来再认回去」都还是同一种；每种块都有一句中文摘要
  });

  it('splits waitFor into 等它出现 / 等它消失', () => {
    const wait = makeBlock('waitAppear', 'w1', 'tpl_x');
    expect(wait.kind === 'waitFor' && wait.cond.kind === 'template').toBe(true); // 等它出现 → waitFor + present 默认
    const gone = makeBlock('waitDisappear', 'w2', 'tpl_x');
    expect(gone.kind === 'waitFor' && gone.cond.kind === 'template' && gone.cond.present === false).toBe(true); // 等它消失
    expect(gone.kind === 'waitFor' && gone.waitMs).toBe(10_000);
    expect(idPrefixOf('waitAppear')).toBe('wait');
    expect(idPrefixOf('waitDisappear')).toBe('wait');
    expect(idPrefixOf('tapTemplate')).toBe('tapTemplate');
  });

  it('uses the Chinese template name, and the raw id once the template is gone', () => {
    const tap = makeBlock('tapTemplate', 't1', 'tpl_x');
    expect(describeBlock(tap, templates)).toContain('联盟按钮'); // 摘要里是模板的中文名，不是 id
    expect(describeBlock(tap, [])).toContain('tpl_x'); // 模板被删了就原样显示 id
    expect(describeBlock(tap, templates)).toBe('找到「联盟按钮」就点它，最多等 3 秒');
    expect(describeBlock({ id: 'z', kind: 'tapTemplate', templateId: 'tpl_x', waitMs: 0, offset: { x: 5, y: 0 } }, templates))
      .toBe('找到「联盟按钮」就点它，只看当前这一帧，偏移 (5, 0)');
    expect(templateName(templates, '')).toBe('（还没选模板）');
  });

  it('reads and replaces a block\'s main template', () => {
    const tap = makeBlock('tapTemplate', 't1', 'tpl_x');
    expect(templateIdOf(tap)).toBe('tpl_x'); // templateIdOf 取得到
    expect(templateIdOf(withTemplateId(tap, 'tpl_y'))).toBe('tpl_y'); // 换模板
    expect(templateIdOf(makeBlock('sleep', 's1'))).toBeNull(); // 没有模板的块返回 null
    expect(templateIdOf(withTemplateId(makeBlock('if', 'i1', 'tpl_x'), 'tpl_y'))).toBe('tpl_y');
    expect(templateIdOf(withTemplateId(makeBlock('waitDisappear', 'w', 'tpl_x'), 'tpl_y'))).toBe('tpl_y');
  });

  it('describes keys, apps, conditions and loops in Chinese', () => {
    expect(describeBlock(makeBlock('key', 'k'), templates)).toBe('按「返回」键');
    expect(Object.keys(ANDROID_KEY_TEXT)).toHaveLength(9);
    expect(describeBlock(makeBlock('launchApp', 'l'), templates)).toBe('启动脚本指定的应用');
    expect(describeBlock(makeBlock('stopApp', 's'), templates, { appLabel: '万龙觉醒' })).toBe('关闭「万龙觉醒」');
    expect(describeBlock({ id: 'c', kind: 'launchApp', cold: true, packageName: PKG }, templates)).toBe(`冷启动「${PKG}」`);
    expect(describeCond({ kind: 'anyTemplate', templateIds: ['tpl_x', 'gone'] }, templates)).toBe('出现任意一张：联盟按钮、gone');
    expect(describeCond({ kind: 'foreground', packageName: PKG, equals: false }, templates)).toBe(`前台不是「${PKG}」`);
    expect(describeCond({ kind: 'and', all: [{ kind: 'always' }, { kind: 'never' }] }, templates)).toBe('同时满足 2 个条件');
    expect(describeBlock({ id: 'l', kind: 'loop', steps: [], while: { kind: 'template', templateId: 'tpl_y' } }, templates))
      .toBe('只要「画面上有「确定按钮」」就一直重复');
    expect(describeBlock({ id: 'l', kind: 'loop', steps: [] }, templates)).toBe('循环（还没设次数或条件）');
    expect(describeBlock(makeBlock('goto', 'g'), templates)).toBe(`跳到落点「${DEFAULT_LABEL}」，最多 10 次`);
    expect(BRANCH_TEXT).toEqual({ then: '成立时', else: '否则', steps: '循环体' });
  });
});

describe('六、卡片上的黄标（一眼可见的问题）', () => {
  const have = new Set(['tpl_x', 'tpl_y']);
  it('flags what is visible at a glance', () => {
    expect(blockIssue(makeBlock('tapTemplate', 't', ''), have)).toBe('还没选模板'); // 没选模板要标出来
    expect(blockIssue(makeBlock('tapTemplate', 't', 'tpl_gone'), have)?.includes('不在')).toBe(true); // 模板不在模板集里
    expect(blockIssue(makeBlock('tapTemplate', 't', 'tpl_x'), have)).toBeNull(); // 选对了就不标
    expect(blockIssue(makeBlock('text', 't'), have)).not.toBeNull(); // 空文本要标
    expect(blockIssue(makeBlock('tap', 't'), have)).not.toBeNull(); // 坐标还是 0,0 要标
    expect(blockIssue({ id: 'l', kind: 'loop', steps: [] }, have)?.includes('一直转')).toBe(true); // 循环既没次数也没条件
    expect(blockIssue(makeBlock('loop', 'l'), have)).toBeNull(); // 正常的循环不标
  });

  it('also checks if conditions and empty logs', () => {
    expect(blockIssue(makeBlock('if', 'i', ''), have)).toBe('还没选模板');
    expect(blockIssue(makeBlock('waitDisappear', 'w', 'gone'), have)).toContain('不在这个脚本的模板集里');
    expect(blockIssue(makeBlock('log', 'g'), have)).toBe('还没填日志内容');
    expect(blockIssue({ id: 't', kind: 'tap', at: { x: 1, y: 0 } }, have)).toBeNull();
  });
});

describe('Assistant: new blocks line up with the validator', () => {
  const script = (steps: ScriptStep[]) => ({ id: 'demo', name: '示例', version: '0.1.0', packageName: PKG, refWidth: 2560, refHeight: 1440, updatedAt: 0, steps });

  it('every default block (with a template picked) saves and runs without errors', () => {
    const steps = kinds.map((kind) => makeBlock(kind, nextStepId([], idPrefixOf(kind)).replace('-1', `-${kind}`), 'tpl_x'));
    const issues = validateScript(script(steps), { expectedPackage: PKG, availableTemplateIds: ['tpl_x'] });
    expect(issues.filter((issue) => issue.level === 'error')).toEqual([]);
  });

  it('a screen block without a template cannot be saved, with a message that says so', () => {
    const issues = validateScript(script([makeBlock('tapTemplate', 'tap-1'), makeBlock('if', 'if-1')]), { expectedPackage: PKG });
    expect(fatalIssues(issues).map((issue) => [issue.stepId, issue.message])).toEqual([
      ['tap-1', expect.stringContaining('还没选模板')],
      ['if-1', expect.stringContaining('还没选模板')],
    ]);
  });

  it('a copied if / loop with children keeps every id unique (no 「步骤 id 重复」)', () => {
    let steps = sample();
    steps = insertAfter(steps, [1], [cloneWithNewIds(steps, steps[1]!)]);
    steps = insertAfter(steps, [3], [cloneWithNewIds(steps, steps[3]!)]);
    const issues = validateScript(script(steps), { expectedPackage: PKG });
    expect(fatalIssues(issues)).toEqual([]);
    expect(countBlocks(steps)).toBe(7 + 4 + 2); // the if (4 blocks) and the loop (2 blocks) were copied
    expect(collectIds(steps).size).toBe(13);
  });

  it('refuses if / loop blocks at the nesting limit, leaves fit one level deeper', () => {
    expect(canAddAtDepth('if', SCRIPT_LIMITS.maxDepth - 1)).toBe(true);
    expect(canAddAtDepth('if', SCRIPT_LIMITS.maxDepth)).toBe(false);
    expect(canAddAtDepth('loop', SCRIPT_LIMITS.maxDepth)).toBe(false);
    expect(canAddAtDepth('tap', SCRIPT_LIMITS.maxDepth)).toBe(true);
    expect(canAddAtDepth('tap', SCRIPT_LIMITS.maxDepth + 1)).toBe(false);
    // The rule matches the validator: an if at depth maxDepth is fatal, one level up is fine.
    const nest = (depth: number, leaf: ScriptStep): ScriptStep => depth === 0 ? leaf
      : { id: `n${depth}`, kind: 'loop', repeat: 1, steps: [nest(depth - 1, leaf)] };
    const deepIf = nest(SCRIPT_LIMITS.maxDepth, { id: 'deep', kind: 'if', cond: { kind: 'always' }, then: [] });
    expect(fatalIssues(validateScript(script([deepIf]), { expectedPackage: PKG })).length).toBeGreaterThan(0);
    const okIf = nest(SCRIPT_LIMITS.maxDepth - 1, { id: 'deep', kind: 'if', cond: { kind: 'always' }, then: [] });
    expect(fatalIssues(validateScript(script([okIf]), { expectedPackage: PKG }))).toEqual([]);
  });

  it('normalises the onFail choice like the original form', () => {
    expect(failPolicyFor('abort')).toBeUndefined();
    expect(failPolicyFor('goto')).toEqual({ kind: 'goto', label: DEFAULT_LABEL });
    expect(failPolicyFor('goto', { kind: 'goto', label: '回城' })).toEqual({ kind: 'goto', label: '回城' });
    expect(failPolicyFor('restartApp')).toEqual({ kind: 'restartApp' });
    expect(Object.keys(FAIL_POLICY_TEXT)).toEqual(['abort', 'continue', 'goto', 'restartApp']);
  });
});

describe('Assistant: condition editor modes', () => {
  it('maps conditions to modes, composite ones read-only', () => {
    const cases: Array<[Condition | undefined, string]> = [
      [undefined, 'none'],
      [{ kind: 'template', templateId: 'a' }, 'has'],
      [{ kind: 'template', templateId: 'a', present: true }, 'has'],
      [{ kind: 'template', templateId: 'a', present: false }, 'hasNot'],
      [{ kind: 'anyTemplate', templateIds: ['a'] }, 'anyOf'],
      [{ kind: 'foreground', packageName: PKG }, 'foreground'],
      [{ kind: 'always' }, 'always'],
      [{ kind: 'never' }, 'complex'],
      [{ kind: 'not', of: { kind: 'always' } }, 'complex'],
      [{ kind: 'and', all: [] }, 'complex'],
      [{ kind: 'or', any: [] }, 'complex'],
    ];
    for (const [cond, mode] of cases) expect(condModeOf(cond)).toBe(mode);
    expect(Object.keys(COND_MODE_TEXT)).toEqual(['none', 'has', 'hasNot', 'anyOf', 'foreground', 'always']);
  });

  it('seeds a mode switch with the first template, and the game package for the foreground mode', () => {
    expect(seedCondition('has', templates)).toEqual({ kind: 'template', templateId: 'tpl_x' });
    expect(seedCondition('hasNot', templates)).toEqual({ kind: 'template', templateId: 'tpl_x', present: false });
    expect(seedCondition('anyOf', templates)).toEqual({ kind: 'anyTemplate', templateIds: ['tpl_x'] });
    expect(seedCondition('anyOf', [])).toEqual({ kind: 'anyTemplate', templateIds: [] });
    expect(seedCondition('foreground', templates, PKG)).toEqual({ kind: 'foreground', packageName: PKG });
    expect(seedCondition('always', templates)).toEqual({ kind: 'always' });
    expect(seedCondition('none', templates)).toBeNull();
    expect(seedCondition('complex', templates)).toBeNull();
    // Every seeded condition round-trips to its own mode.
    for (const mode of ['has', 'hasNot', 'anyOf', 'foreground', 'always'] as const) {
      expect(condModeOf(seedCondition(mode, templates, PKG) ?? undefined)).toBe(mode);
    }
  });
});
