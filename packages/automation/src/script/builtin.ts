/**
 * Built-in example scripts (wanlong-panel `src/scripts/builtin.ts`), read-only and shipped with the app.
 *
 * They only show how the generic abilities combine (waitFor / tapTemplate / if / loop / onFail / parameters)
 * and are deliberately free of game logic. Adapted for the Assistant's safety rules: the package is the game's
 * own (filled in per game), the placeholder template id is meant to be replaced, and the keep-alive example
 * waits for a template instead of sleeping blindly.
 *
 * Built-in ids start with `builtin_`; user scripts may not use that prefix.
 */
import { scriptMeta } from './validate.js';
import type { ScriptDef, ScriptMeta } from './types.js';

export const BUILTIN_SCRIPT_PREFIX = 'builtin_';

/** Fixed so the list never shows "just updated" or flickers on every start. */
const BUILTIN_UPDATED_AT = 1_757_000_000_000;
const REF_WIDTH = 2560;
const REF_HEIGHT = 1440;
/** Replace with a real template id from the instance's template set. */
export const BUILTIN_PLACEHOLDER_TEMPLATE = 'demo_target';

function waitTap(packageName: string | undefined): ScriptDef {
  return {
    id: `${BUILTIN_SCRIPT_PREFIX}wait_tap`,
    name: '示例·等模板出现后点击',
    description: '通用写法示例：等待模板出现 → 点击它 → 截图留痕。' +
      `使用前请「另存为」自己的脚本，把模板 id「${BUILTIN_PLACEHOLDER_TEMPLATE}」换成模板集里真实的模板，并按需调整 ROI。`,
    version: '1.0.0',
    ...(packageName ? { packageName } : {}),
    refWidth: REF_WIDTH,
    refHeight: REF_HEIGHT,
    params: [{ key: 'waitSeconds', label: '等待上限（秒）', type: 'number', default: 30, note: '模板迟迟不出现时最多等多久；超时按 onFail 处置。' }],
    steps: [
      { id: 'log_begin', kind: 'log', level: 'info', name: '开始', message: '示例脚本开始运行（等待上限 {{waitSeconds}} 秒）。请把 demo_target 换成你自己的模板 id。' },
      {
        id: 'wait_target', kind: 'waitFor', name: '等目标出现',
        // ROI is the cheapest speed-up (measured: full screen 62 ms → one key 1.45 ms); fill it in when you can.
        cond: { kind: 'template', templateId: BUILTIN_PLACEHOLDER_TEMPLATE, roi: { x: 0, y: 0, w: REF_WIDTH, h: REF_HEIGHT } },
        waitMs: 30_000, pollMs: 1000,
        // Nothing to tap: stop instead of tapping blindly.
        onFail: { kind: 'abort' },
      },
      {
        id: 'tap_target', kind: 'tapTemplate', name: '点击目标', templateId: BUILTIN_PLACEHOLDER_TEMPLATE,
        waitMs: 5000, pollMs: 500, afterDelayMs: 1200, retry: 1, retryDelayMs: 800,
      },
      { id: 'shot_after', kind: 'screenshot', name: '点击后留痕', label: 'after-tap' },
      { id: 'log_done', kind: 'log', level: 'info', name: '结束', message: '示例脚本执行完毕。' },
    ],
    updatedAt: BUILTIN_UPDATED_AT,
  };
}

function keepAlive(packageName: string | undefined): ScriptDef {
  const pkg = packageName ?? 'com.example.app';
  return {
    id: `${BUILTIN_SCRIPT_PREFIX}keep_alive`,
    name: '示例·应用保活巡检',
    description: '通用写法示例：检查游戏是否在前台，掉出前台就冷启动拉回来，并等主界面模板出现。' +
      `一轮跑完就结束，请用任务计划的「间隔触发」定时运行；使用前请「另存为」自己的脚本并把模板 id「${BUILTIN_PLACEHOLDER_TEMPLATE}」换成主界面上的真实模板。`,
    version: '1.0.0',
    packageName: pkg,
    refWidth: REF_WIDTH,
    refHeight: REF_HEIGHT,
    steps: [
      {
        id: 'check_foreground', kind: 'if', name: '检查前台应用',
        cond: { kind: 'not', of: { kind: 'foreground', packageName: pkg } },
        then: [
          { id: 'log_lost', kind: 'log', level: 'warn', message: '游戏不在前台，准备冷启动。' },
          // A failed launch must not end the whole patrol; the next round tries again.
          { id: 'relaunch', kind: 'launchApp', name: '冷启动游戏', cold: true, onFail: { kind: 'continue' } },
          {
            id: 'wait_main', kind: 'waitFor', name: '等主界面出现',
            cond: { kind: 'template', templateId: BUILTIN_PLACEHOLDER_TEMPLATE }, waitMs: 120_000, pollMs: 2000,
            onFail: { kind: 'continue' },
          },
          { id: 'shot_relaunched', kind: 'screenshot', name: '冷启动后留痕', label: 'relaunched', capture: true },
        ],
        else: [{ id: 'log_ok', kind: 'log', level: 'debug', message: '游戏在前台，正常。' }],
      },
    ],
    updatedAt: BUILTIN_UPDATED_AT,
  };
}

const BUILDERS = [waitTap, keepAlive] as const;

export function isBuiltinScriptId(id: string): boolean {
  return id.startsWith(BUILTIN_SCRIPT_PREFIX);
}

/**
 * A free id for the editable copy of a built-in example (「另存为」): `<name>_copy`, then `<name>_copy2`, `_copy3` …
 * Never one of `takenIds`, so saving the example again never overwrites a copy the user already edited.
 */
export function builtinCopyId(builtinId: string, takenIds: Iterable<string>): string {
  const name = builtinId.startsWith(BUILTIN_SCRIPT_PREFIX) ? builtinId.slice(BUILTIN_SCRIPT_PREFIX.length) : builtinId;
  const base = `${name || 'script'}_copy`;
  const taken = new Set(takenIds);
  for (let n = 1; ; n += 1) {
    const id = n === 1 ? base : `${base}${n}`;
    if (!taken.has(id)) return id;
  }
}

/** Fresh copies of every built-in script, targeting `packageName` (the current game). */
export function builtinScripts(packageName?: string): ScriptDef[] {
  return BUILDERS.map((build) => build(packageName));
}

/** One built-in script as a fresh copy (callers may modify it), or null. */
export function getBuiltinScript(id: string, packageName?: string): ScriptDef | null {
  return builtinScripts(packageName).find((script) => script.id === id) ?? null;
}

export function builtinScriptMetas(packageName?: string): ScriptMeta[] {
  return builtinScripts(packageName).map((script) => scriptMeta(script, true));
}
