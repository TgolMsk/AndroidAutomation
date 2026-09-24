import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunLogger } from '../src/index.js';
import {
  BUILTIN_SCRIPT_PREFIX, builtinScriptMetas, builtinScripts, countSteps, describeCondition, fatalIssues, formatIssues, getBuiltinScript,
  interpolate, isBuiltinScriptId, mergeParams, referencedTemplateIds, startsWithLaunch, validateScript,
  type LogEntry, type ScriptDef, type ScriptStep,
} from '../src/script/index.js';

const PKG = 'com.lilithgames.samo.android.cn';
const base = (steps: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ id: 'demo', name: '示例', version: '1.0.0', packageName: PKG, refWidth: 2560, refHeight: 1440, updatedAt: 0, steps, ...extra });
const messages = (raw: unknown, options = {}) => validateScript(raw, { expectedPackage: PKG, ...options });

describe('validateScript parity with the original (fatal / error / warn)', () => {
  it('accepts a clean script', () => {
    expect(messages(base([{ id: 'a', kind: 'tap', at: { x: 10, y: 10 } }]))).toEqual([]);
  });

  it('makes duplicate labels across different blocks fatal', () => {
    const issues = messages(base([
      { id: 'l1', kind: 'label', label: '落点1' },
      { id: 'if', kind: 'if', cond: { kind: 'always' }, then: [{ id: 'l2', kind: 'label', label: '落点1' }] },
    ]));
    expect(fatalIssues(issues).map((issue) => issue.message)).toEqual([expect.stringContaining('label 重复定义：「落点1」')]);
  });

  it('allows any non-empty label text, including Chinese', () => {
    const issues = messages(base([{ id: 'l1', kind: 'label', label: '落点 1（城内）' }, { id: 'g', kind: 'goto', label: '落点 1（城内）', maxTimes: 3 }]));
    expect(issues).toEqual([]);
  });

  it('distinguishes a goto into another branch from a missing label', () => {
    const issues = messages(base([
      { id: 'if', kind: 'if', cond: { kind: 'always' }, then: [{ id: 'inner', kind: 'label', label: 'inside' }] },
      { id: 'g1', kind: 'goto', label: 'inside' },
      { id: 'g2', kind: 'goto', label: 'nowhere' },
      { id: 'f', kind: 'tap', at: { x: 1, y: 1 }, onFail: { kind: 'goto', label: 'inside' } },
    ]));
    const fatal = fatalIssues(issues);
    expect(fatal.find((issue) => issue.stepId === 'g1')?.message).toContain('在别的分支/循环体内');
    expect(fatal.find((issue) => issue.stepId === 'g2')?.message).toContain('不存在');
    expect(fatal.find((issue) => issue.stepId === 'f')?.message).toContain('onFail 要跳到');
  });

  it('reports duplicate step ids, bad shapes and bad resolution as fatal', () => {
    const issues = messages(base([
      { id: 'a', kind: 'tap', at: { x: 1, y: 1 } },
      { id: 'a', kind: 'tap', at: { x: 1, y: 1 } },
      { id: 'b', kind: 'teleport' },
      { id: 'c', kind: 'key', key: 'POWER' },
    ], { refWidth: 0 }));
    const fatal = fatalIssues(issues).map((issue) => issue.message);
    expect(fatal).toEqual(expect.arrayContaining([
      expect.stringContaining('步骤 id 重复'), expect.stringContaining('步骤类型不受支持'),
      expect.stringContaining('按键不受支持'), expect.stringContaining('参考分辨率'),
    ]));
  });

  it('keeps the Assistant safety rules fatal: another package, depth and size', () => {
    const foreign = messages(base([{ id: 'l', kind: 'launchApp', packageName: 'com.example.other' },
      { id: 'w', kind: 'waitFor', waitMs: 10, cond: { kind: 'foreground', packageName: 'com.example.other' } }], { packageName: 'com.example.other' }));
    expect(fatalIssues(foreign)).toHaveLength(3);
    let nested: unknown[] = [{ id: 'leaf', kind: 'log', level: 'info', message: 'x' }];
    for (let depth = 0; depth < 10; depth++) nested = [{ id: `if${depth}`, kind: 'if', cond: { kind: 'always' }, then: nested }];
    expect(fatalIssues(messages(base(nested))).some((issue) => issue.message.includes('嵌套'))).toBe(true);
    const many = Array.from({ length: 301 }, (_v, i) => ({ id: `s${i}`, kind: 'sleep', ms: 1 }));
    expect(fatalIssues(messages(base(many))).some((issue) => issue.message.includes('300'))).toBe(true);
  });

  it('keeps ROI, missing templates and loop interval as non-fatal errors', () => {
    const issues = messages(base([
      { id: 't', kind: 'tapTemplate', templateId: 'missing', roi: { x: 2500, y: 0, w: 100, h: 10 } },
    ], { loop: true, loopIntervalMs: 500, templateSetId: 'set' }), { availableTemplateIds: ['present'] });
    const errors = issues.filter((issue) => issue.level === 'error');
    expect(errors.every((issue) => !issue.fatal)).toBe(true);
    expect(errors.map((issue) => issue.message)).toEqual(expect.arrayContaining([
      expect.stringContaining('超出参考分辨率'), expect.stringContaining('不存在的模板：「missing」'), expect.stringContaining('每轮间隔不能小于 1 秒'),
    ]));
  });

  it('restores the original warnings, none of which block saving', () => {
    const issues = messages(base([
      { id: 'w', kind: 'waitFor', waitMs: 0, cond: { kind: 'template', templateId: 'x' } },
      { id: 'if', kind: 'if', cond: { kind: 'always' }, then: [] },
      { id: 'loop', kind: 'loop', steps: [] },
      { id: 'p', kind: 'tap', at: { x: 3000, y: 10 } },
      { id: 'r', kind: 'tap', at: { x: 1, y: 1 }, retry: 12 },
      { id: 'lp', kind: 'longPress', at: { x: 1, y: 1 }, durationMs: 12_000 },
      { id: 'zh', kind: 'text', text: '你好 {{name}}' },
      { id: 'e', kind: 'text', text: '' },
    ]), { templateRef: { width: 1920, height: 1080 } });
    expect(issues.every((issue) => issue.level === 'warn')).toBe(true);
    const text = formatIssues(issues);
    for (const expected of ['只看一帧', '两个分支都是空的', '循环体是空的', '硬上限 1000', '画面之外', '偏大', '10 秒', 'ADBKeyboard',
      '未声明的参数', '文本为空', '没有绑定 templateSetId', '不一致']) {
      expect(text).toContain(expected);
    }
    expect(messages(base([{ id: 'zh', kind: 'text', text: '你好' }]), { unicodeInput: true })).toEqual([]);
  });

  it('allows a script-level loop with a sane interval', () => {
    expect(messages(base([{ id: 'a', kind: 'sleep', ms: 1 }], { loop: true, loopIntervalMs: 5000 }))).toEqual([]);
  });

  it('validates parameter definitions', () => {
    const issues = messages(base([], { params: [
      { key: 'n', label: '次数', type: 'number', default: '3' },
      { key: 'mode', label: '模式', type: 'enum', options: [{ value: 'a', label: 'A' }], default: 'b' },
      { key: 'n', label: '重复', type: 'string' },
    ] }));
    expect(issues.map((issue) => issue.message)).toEqual(expect.arrayContaining([
      expect.stringContaining('默认值类型应为 number'), expect.stringContaining('默认值不在候选项里'), expect.stringContaining('参数 key 重复'),
    ]));
  });
});

describe('script helpers', () => {
  const steps: ScriptStep[] = [
    { id: 'a', kind: 'waitFor', waitMs: 1, cond: { kind: 'or', any: [{ kind: 'template', templateId: 'x' }, { kind: 'anyTemplate', templateIds: ['y', 'z'] }] } },
    { id: 'b', kind: 'if', cond: { kind: 'not', of: { kind: 'template', templateId: 'w' } }, then: [{ id: 'c', kind: 'tapTemplate', templateId: 'x' }],
      else: [{ id: 'd', kind: 'loop', repeat: 1, steps: [{ id: 'e', kind: 'tap', at: { x: 1, y: 1 }, when: { kind: 'template', templateId: 'v' } }] }] },
  ];

  it('counts every step recursively and collects referenced templates', () => {
    expect(countSteps(steps)).toBe(5);
    expect(referencedTemplateIds({ steps }).sort()).toEqual(['v', 'w', 'x', 'y', 'z']);
  });

  it('interpolates {{ key }} with whitespace and keeps unknown keys', () => {
    expect(interpolate('{{a}}-{{ a }}-{{  b.c  }}-{{zz}}', { a: 1, 'b.c': true })).toBe('1-1-true-{{zz}}');
  });

  it('merges params: defaults < account < task < request', () => {
    const def = { params: [{ key: 'a', label: 'A', type: 'number', default: 1 }, { key: 'b', label: 'B', type: 'string', default: 'x' }] } as Pick<ScriptDef, 'params'>;
    expect(mergeParams(def, { a: 2 }, null, { b: 'task' }, { a: 9 })).toEqual({ a: 9, b: 'task' });
  });

  it('describes conditions in Chinese', () => {
    expect(describeCondition({ kind: 'and', all: [{ kind: 'template', templateId: 'x' }, { kind: 'not', of: { kind: 'foreground', packageName: PKG, equals: false } }] }))
      .toBe(`出现模板「x」 且 非(前台不是「${PKG}」)`);
  });

  it('detects a launchApp prologue', () => {
    expect(startsWithLaunch({ steps: [{ id: 'l', kind: 'log', level: 'info', message: 'x' }, { id: 'go', kind: 'launchApp', cold: true }] })).toBe(true);
    expect(startsWithLaunch({ steps: [{ id: 't', kind: 'tap', at: { x: 1, y: 1 } }, { id: 'go', kind: 'launchApp' }] })).toBe(false);
  });
});

describe('built-in example scripts', () => {
  it('are read-only examples with a reserved prefix, fixed timestamp and fresh copies', () => {
    const scripts = builtinScripts(PKG);
    expect(scripts.map((item) => item.id)).toEqual(['builtin_wait_tap', 'builtin_keep_alive']);
    expect(scripts.every((item) => isBuiltinScriptId(item.id) && item.id.startsWith(BUILTIN_SCRIPT_PREFIX) && item.updatedAt === 1_757_000_000_000)).toBe(true);
    const copy = getBuiltinScript('builtin_wait_tap', PKG)!;
    copy.steps.length = 0;
    expect(getBuiltinScript('builtin_wait_tap', PKG)!.steps.length).toBe(5);
    expect(builtinScriptMetas(PKG).every((meta) => meta.builtin)).toBe(true);
  });

  it('pass the Assistant validator without fatal issues (only placeholder warnings)', () => {
    for (const item of builtinScripts(PKG)) {
      const issues = validateScript(item, { expectedPackage: PKG });
      expect(issues.filter((issue) => issue.level === 'error')).toEqual([]);
    }
  });
});

describe('RunLogger (original logger.ts)', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('batches lines every 100 ms instead of one message per line', () => {
    vi.useFakeTimers();
    const batches: LogEntry[][] = [];
    const logger = new RunLogger('run-1', 2, (entries) => batches.push(entries));
    for (let i = 0; i < 5; i++) logger.push({ level: 'info', scope: 'engine', message: `line ${i}`, stepId: 's' });
    expect(batches).toHaveLength(0);
    vi.advanceTimersByTime(99);
    expect(batches).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(5);
    expect(batches[0]![0]).toMatchObject({ runId: 'run-1', instanceIndex: 2, scope: 'engine', stepId: 's', message: 'line 0' });
  });

  it('drops overflow beyond 4000 and reports it once as a warning', () => {
    vi.useFakeTimers();
    const batches: LogEntry[][] = [];
    const logger = new RunLogger('run-1', 0, (entries) => batches.push(entries));
    for (let i = 0; i < 4100; i++) logger.push({ level: 'debug', scope: 'engine', message: `l${i}` });
    logger.flush();
    expect(batches[0]).toHaveLength(4001);
    expect(batches[0]!.at(-1)).toMatchObject({ level: 'warn', scope: 'logger', message: expect.stringContaining('已丢弃 100 条') });
    logger.push({ level: 'info', scope: 'engine', message: 'after' });
    logger.dispose();
    expect(batches[1]).toHaveLength(1);
    logger.push({ level: 'info', scope: 'engine', message: 'ignored' });
    vi.advanceTimersByTime(500);
    expect(batches).toHaveLength(2);
  });
});
