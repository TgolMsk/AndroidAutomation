import { describe, expect, it } from 'vitest';
import type { TemplateDefinition, TemplateSet } from '@avdm/automation';
import {
  SCRIPT_ID, fatalIssues, getAt, updateAt, validateScript,
  type ScriptDef, type ScriptIssue, type ScriptMeta, type ScriptStep,
} from '@avdm/automation/script';
import {
  CAPTURE_KINDS, CAPTURE_NOTE, EDIT_MODE_KEY, captureDraft, captureIdPrefix, captureProblem, collectLabels, insertCapturedBlock,
  isUnreadableMeta, makeScriptId, mergeTemplateSets, newScriptDef, normRect, overwriteClash, parseScriptObject, parseScriptText, placeBlock,
  prettyScript, readEditMode, saveGate, scriptListDetail, scriptToSave, stepIdRange, summarizeIssues, targetAfter, templatesOfSet,
  withSavedTemplate, writeEditMode, type CaptureRequest,
} from '../src/renderer/views/scripts/script-editor';

const PKG = 'com.lilithgames.samo.android.cn';

function tree(): ScriptStep[] {
  return [
    { id: 'a', kind: 'tap', at: { x: 10, y: 20 } },
    {
      id: 'b', kind: 'if', cond: { kind: 'template', templateId: 'tpl_x' },
      then: [{ id: 'b1', kind: 'sleep', ms: 100 }, { id: 'tap-1', kind: 'tapTemplate', templateId: 'tpl_y' }],
    },
    { id: 'c', kind: 'loop', repeat: 3, steps: [{ id: 'c1', kind: 'screenshot' }] },
  ];
}

function script(steps = tree(), extra: Partial<ScriptDef> = {}): ScriptDef {
  return { id: 'demo', name: '示例', version: '0.1.0', packageName: PKG, templateSetId: 'set_a', refWidth: 2560, refHeight: 1440, steps, updatedAt: 0, ...extra };
}

const template = (id: string, name: string): TemplateDefinition => ({ id, name, file: `${id}.png`, authoredWidth: 2560, authoredHeight: 1440, bounds: { x: 0, y: 0, w: 40, h: 40 } });
const set = (id: string, name: string, templates: TemplateDefinition[] = []): TemplateSet => ({ id, name, refWidth: 2560, refHeight: 1440, templates, directory: `/sets/${id}` });

describe('the JSON text is the single source of truth (iron rule 1)', () => {
  it('parses a script and explains why it cannot, in Chinese', () => {
    expect(parseScriptText('')).toEqual({ def: null, error: null });
    expect(parseScriptText('[1]').error).toBe('顶层必须是一个 JSON 对象');
    expect(parseScriptText('null').error).toBe('顶层必须是一个 JSON 对象');
    expect(parseScriptText('{"id":"x"}').error).toBe('steps 必须是一个数组');
    expect(parseScriptText('{"id":').error).toMatch(/^JSON 解析失败：/);
    expect(parseScriptText(prettyScript(script())).def?.id).toBe('demo');
    // Save / validate / format only need an object: the main-process validation reports the rest as issues.
    expect(parseScriptObject('{"id":"x"}')).toEqual({ value: { id: 'x' }, error: null });
    expect(parseScriptObject('[]').error).toBe('顶层必须是一个 JSON 对象');
    expect(parseScriptObject('{').error).toMatch(/^JSON 解析失败：/);
  });

  it('never loses an edit when switching between the visual and the JSON mode', () => {
    // Visual edit → text.
    let text = prettyScript(script());
    const visual = parseScriptText(text).def!;
    text = prettyScript({ ...visual, steps: updateAt(visual.steps, [1, 'then', 0], { id: 'b1', kind: 'sleep', ms: 999 }) });
    // JSON edit on that text (the user types in the text area).
    text = text.replace('"name": "示例"', '"name": "改过的名字"');
    // Back in the visual mode, both edits are there; a round trip through the visual mode changes nothing else.
    const back = parseScriptText(text).def!;
    expect(back.name).toBe('改过的名字');
    expect(getAt(back.steps, [1, 'then', 0])).toEqual({ id: 'b1', kind: 'sleep', ms: 999 });
    expect(prettyScript(back)).toBe(text);
  });

  it('remembers the edit mode, and survives a storage that throws', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); } };
    expect(readEditMode(() => storage)).toBe('visual');
    writeEditMode(() => storage, 'json');
    expect(store.get(EDIT_MODE_KEY)).toBe('json');
    expect(readEditMode(() => storage)).toBe('json');
    const broken = () => { throw new Error('SecurityError'); };
    expect(readEditMode(broken)).toBe('visual');
    expect(() => writeEditMode(broken, 'json')).not.toThrow();
    const throwing = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(readEditMode(() => throwing)).toBe('visual');
    expect(() => writeEditMode(() => throwing, 'visual')).not.toThrow();
  });
});

describe('new / save / validation summary', () => {
  it('creates an empty script for the game that saves without structural problems', () => {
    const def = newScriptDef(PKG, 1_700_000_000_000, () => 0.5);
    expect(def).toMatchObject({ name: '未命名脚本', version: '0.1.0', packageName: PKG, refWidth: 2560, refHeight: 1440, steps: [] });
    expect(SCRIPT_ID.test(def.id)).toBe(true);
    expect(makeScriptId(1, () => 0)).toBe('script_10000');
    expect(fatalIssues(validateScript(def, { expectedPackage: PKG }))).toEqual([]);
  });

  it('saves a built-in example as a copy, never over it', () => {
    const plain = scriptToSave({ id: 'mine', name: '我的' }, []);
    expect(plain).toEqual({ value: { id: 'mine', name: '我的' }, copiedFrom: null });
    const copy = scriptToSave({ id: 'builtin_keep_alive', name: '保活' }, ['builtin_keep_alive', 'keep_alive_copy']);
    expect(copy.copiedFrom).toBe('builtin_keep_alive');
    expect(copy.value).toMatchObject({ id: 'keep_alive_copy2', name: '保活（副本）' });
  });

  it('never saves over another script by id', () => {
    const listed: ScriptMeta[] = [
      { id: 'daily', name: '日常', version: '1.0.0', stepCount: 3, updatedAt: 0 },
      { id: 'builtin_keep_alive', name: '保活', version: '1.0.0', stepCount: 3, updatedAt: 0, builtin: true },
    ];
    expect(overwriteClash({ id: 'daily' }, 'daily', listed)).toBeNull(); // saving the opened script
    expect(overwriteClash({ id: 'fresh' }, null, listed)).toBeNull();
    expect(overwriteClash({ id: 'daily' }, null, listed)).toContain('脚本「日常」在用');
    expect(overwriteClash({ id: 'daily' }, 'other', listed)).toContain('保存会覆盖它');
  });

  it('counts issues and gates saving on structural errors only', () => {
    const issues: ScriptIssue[] = [
      { level: 'error', stepId: 'a', message: '坏了', fatal: true },
      { level: 'error', stepId: 'b', message: '模板不存在' },
      { level: 'warn', stepId: null, message: '提醒' },
    ];
    expect(summarizeIssues(issues)).toEqual({ errors: 2, warnings: 1, fatal: 1 });
    expect(summarizeIssues(null)).toEqual({ errors: 0, warnings: 0, fatal: 0 });
    expect(saveGate(issues).refuse).toBe('有 1 个必须修复的问题，已在下方列出');
    expect(saveGate(issues.slice(1))).toEqual({ refuse: null, draftWarning: '还有 1 个错误，已存为草稿；修好之前不能运行' });
    expect(saveGate(issues.slice(2))).toEqual({ refuse: null, draftWarning: null });
  });
});

describe('「点问题定位」 and goto suggestions', () => {
  it('selects the step id itself in the JSON text, not an earlier mention', () => {
    const def = script([
      { id: 'l', kind: 'log', level: 'info', message: 'tap-9 就在下面' },
      { id: 'tap-9', kind: 'tap', at: { x: 1, y: 1 } },
    ]);
    const text = prettyScript(def);
    const range = stepIdRange(text, 'tap-9')!;
    expect(text.slice(range.start, range.end)).toBe('"tap-9"');
    expect(text.slice(0, range.start)).toMatch(/"id": $/);
    expect(range.line).toBe(text.slice(0, range.start).split('\n').length);
    expect(stepIdRange(text, 'missing')).toBeNull();
  });

  it('lists label names anywhere in the tree', () => {
    const steps: ScriptStep[] = [
      { id: 'l1', kind: 'label', label: '落点1' },
      { id: 'lp', kind: 'loop', repeat: 1, steps: [{ id: 'l2', kind: 'label', label: '回城' }] },
    ];
    expect(collectLabels(steps)).toEqual(['落点1', '回城']);
  });
});

describe('template sets of a script', () => {
  it('merges the instance set, finds templates by the script\'s set and adds a fresh capture', () => {
    const managed = [set('set_a', 'A', [template('tpl_x', '联盟按钮')])];
    const outside = set('set_b', 'B');
    const merged = mergeTemplateSets(managed, [outside, null, undefined, set('set_a', 'stale copy')]);
    expect(merged.map((item) => item.id)).toEqual(['set_b', 'set_a']);
    expect(merged.find((item) => item.id === 'set_a')?.name).toBe('A'); // fresh managed data wins
    expect(templatesOfSet(merged, 'set_a').map((t) => t.id)).toEqual(['tpl_x']);
    expect(templatesOfSet(merged, undefined)).toEqual([]);
    expect(templatesOfSet(merged, 'gone')).toEqual([]);
    const added = withSavedTemplate(merged, 'set_a', template('tpl_new', '确定'));
    expect(templatesOfSet(added, 'set_a').map((t) => t.id)).toEqual(['tpl_x', 'tpl_new']);
    expect(withSavedTemplate(added, 'set_a', template('tpl_new', '确定 2'))).toHaveLength(2);
  });

  it('describes list entries like the original', () => {
    const meta: ScriptMeta = { id: 's', name: 'S', version: '1.0.0', packageName: PKG, templateSetId: 'set_a', stepCount: 7, updatedAt: 0 };
    expect(scriptListDetail(meta, [set('set_a', '主号模板')])).toBe(`7 步｜${PKG}｜模板集 主号模板`);
    expect(scriptListDetail({ ...meta, templateSetId: 'gone', packageName: undefined }, [])).toBe('7 步｜模板集 gone');
    expect(isUnreadableMeta({ ...meta, version: '0' })).toBe(true);
    expect(isUnreadableMeta({ ...meta, version: '0', builtin: true })).toBe(false);
    expect(isUnreadableMeta(meta)).toBe(false);
  });
});

describe('placing a new block', () => {
  const block: ScriptStep = { id: 'new', kind: 'sleep', ms: 1 };

  it('appends at the end, or after the selected block at any depth', () => {
    const steps = tree();
    expect(placeBlock(steps, { kind: 'end' }, block)).toMatchObject({ path: [3], fellBack: false });
    const nested = placeBlock(steps, targetAfter(steps, [1, 'then', 0]), block);
    expect(nested.path).toEqual([1, 'then', 1]);
    expect(getAt(nested.steps, [1, 'then', 1])?.id).toBe('new');
    expect(getAt(nested.steps, [1, 'then', 2])?.id).toBe('tap-1');
    expect(targetAfter(steps, null)).toEqual({ kind: 'end' });
    expect(targetAfter(steps, [9])).toEqual({ kind: 'end' });
  });

  it('follows a block that moved, and falls back to the end when it is gone', () => {
    const steps = tree();
    const moved = placeBlock(steps, { kind: 'after', path: [0], stepId: 'c1' }, block);
    expect(moved).toMatchObject({ path: [2, 'steps', 1], fellBack: false });
    const gone = placeBlock(steps, { kind: 'after', path: [1, 'then', 0], stepId: 'removed' }, block);
    expect(gone).toMatchObject({ path: [3], fellBack: true });
    expect(gone.steps[3]).toBe(block);
  });

  it('appends into branches, creating 否则 on demand, and refuses a branch the block cannot have', () => {
    const steps = tree();
    const intoElse = placeBlock(steps, { kind: 'branch', parentPath: [1], parentId: 'b', branch: 'else' }, block);
    expect(intoElse).toMatchObject({ path: [1, 'else', 0], fellBack: false });
    expect(getAt(intoElse.steps, [1, 'else', 0])?.id).toBe('new');
    const intoLoop = placeBlock(steps, { kind: 'branch', parentPath: [2], parentId: 'c', branch: 'steps' }, block);
    expect(intoLoop.path).toEqual([2, 'steps', 1]);
    expect(placeBlock(steps, { kind: 'branch', parentPath: [2], parentId: 'c', branch: 'then' }, block).fellBack).toBe(true);
    expect(placeBlock(steps, { kind: 'branch', parentPath: [0], parentId: 'a', branch: 'then' }, block).fellBack).toBe(true);
  });
});

describe('「从画面截取」: stale-safe insertion (the target\'s protection kept)', () => {
  const request = (extra: Partial<CaptureRequest> = {}): CaptureRequest =>
    ({ id: 'r1', scriptId: 'demo', templateSetId: 'set_a', target: { kind: 'after', path: [1, 'then', 0], stepId: 'b1' }, ...extra });

  it('inserts a tap block after the selected block with an id generated at insertion time', () => {
    const outcome = insertCapturedBlock(script(), request(), { templateId: 'tpl_new', templateSetId: 'set_a', kind: 'tapTemplate' })!;
    expect(outcome.path).toEqual([1, 'then', 1]);
    // tap-1 is already taken inside the if: the new id never collides.
    expect(getAt(outcome.def.steps, outcome.path)).toEqual({ id: 'tap-2', kind: 'tapTemplate', templateId: 'tpl_new', waitMs: 3000, retry: 1 });
    expect(fatalIssues(validateScript(outcome.def, { expectedPackage: PKG }))).toEqual([]);
  });

  it('builds 等它消失 with present:false and the 10 s default', () => {
    const outcome = insertCapturedBlock(script(), request({ target: { kind: 'end' } }), { templateId: 'tpl_new', templateSetId: 'set_a', kind: 'waitDisappear' })!;
    expect(outcome.def.steps[3]).toEqual({ id: 'wait-1', kind: 'waitFor', cond: { kind: 'template', templateId: 'tpl_new', present: false }, waitMs: 10_000 });
    expect(captureIdPrefix('waitAppear')).toBe('wait');
    expect(CAPTURE_KINDS.map((k) => k.label)).toEqual(['点这张图', '等它出现', '等它消失']);
  });

  it('refuses a result for another script or another template set', () => {
    const saved = { templateId: 'tpl_new', templateSetId: 'set_a', kind: 'tapTemplate' as const };
    expect(insertCapturedBlock(script(undefined, { id: 'other' }), request(), saved)).toBeNull();
    expect(insertCapturedBlock(script(), request(), { ...saved, templateSetId: '（/elsewhere）' })).toBeNull();
    expect(insertCapturedBlock(script(undefined, { templateSetId: 'set_b' }), request(), saved)).toBeNull();
    // A script without a set is bound to the one the template went into.
    const bound = insertCapturedBlock(script(undefined, { templateSetId: undefined }), request(), saved)!;
    expect(bound.def.templateSetId).toBe('set_a');
  });

  it('falls back to the end when the target block disappeared meanwhile', () => {
    const outcome = insertCapturedBlock(script(), request({ target: { kind: 'after', path: [5], stepId: 'gone' } }),
      { templateId: 'tpl_new', templateSetId: 'set_a', kind: 'waitAppear' })!;
    expect(outcome.fellBack).toBe(true);
    expect(outcome.path).toEqual([3]);
  });
});

describe('capture dialog checks', () => {
  const frame = { width: 2560, height: 1440 };

  it('says what stops 「保存并插入」, in the original words', () => {
    expect(captureProblem({ hasSet: false, frame, crop: null, name: '' })).toBe('这个脚本还没选模板集，先在上面选一个');
    expect(captureProblem({ hasSet: true, frame: null, crop: null, name: '' })).toBe('先抓一帧画面');
    expect(captureProblem({ hasSet: true, frame, crop: { x: 0, y: 0, w: 7, h: 30 }, name: 'x' })).toBe('在画面上拉一个至少 8×8 像素的框，框住要认的图标或文字');
    expect(captureProblem({ hasSet: true, frame, crop: { x: 2555, y: 0, w: 8, h: 8 }, name: 'x' })).toContain('至少 8×8');
    expect(captureProblem({ hasSet: true, frame, crop: { x: 0, y: 0, w: 8, h: 8 }, name: '  ' })).toBe('给它起个名字，例如「联盟按钮」');
    expect(captureProblem({ hasSet: true, frame, crop: { x: 0, y: 0, w: 8, h: 8 }, name: '长'.repeat(41) })).toBe('名字最长 40 个字');
    expect(captureProblem({ hasSet: true, frame, crop: { x: 0, y: 0, w: 8, h: 8 }, name: '联盟按钮' })).toBeNull();
  });

  it('normalises a drag in any direction', () => {
    expect(normRect({ x: 50.4, y: 80 }, { x: 10, y: 20.6 })).toEqual({ x: 10, y: 21, w: 40, h: 59 });
  });

  it('saves the crop in PNG pixels with the note and WITHOUT a defaultRoi (the main process widens one)', () => {
    const png = new Uint8Array([1, 2, 3]);
    const draft = captureDraft({ png, width: 1280, height: 720 }, { x: 1, y: 2, w: 30, h: 40 }, ' 联盟按钮 ');
    expect(draft).toEqual({ name: '联盟按钮', image: png, authoredWidth: 1280, authoredHeight: 720, crop: { x: 1, y: 2, w: 30, h: 40 }, note: CAPTURE_NOTE });
    expect('defaultRoi' in draft).toBe(false);
    expect('threshold' in draft).toBe(false);
  });
});
