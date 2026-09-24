/**
 * Render smoke test of the visual block editor (server-side markup, no DOM): every block kind opens its form,
 * branches, captions and the yellow tags show up, composite conditions stay read-only.
 */
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { TemplateDefinition } from '@avdm/automation';
import { BLOCK_CATALOG, makeBlock, type ScriptDef, type ScriptStep } from '@avdm/automation/script';
import { BlockEditor, type BlockEditorProps } from '../src/renderer/views/scripts/BlockEditor';

// The test transform compiles JSX with the classic runtime (the app build uses the automatic one).
(globalThis as { React?: unknown }).React = React;

const PKG = 'com.lilithgames.samo.android.cn';
const templates: TemplateDefinition[] = [
  { id: 'tpl_x', name: '联盟按钮', file: 'tpl_x.png', authoredWidth: 2560, authoredHeight: 1440, bounds: { x: 0, y: 0, w: 40, h: 40 } },
];

function render(steps: ScriptStep[], extra: Partial<BlockEditorProps> = {}): string {
  const script: ScriptDef = { id: 's', name: '示例', version: '0.1.0', packageName: PKG, templateSetId: 'set_a', refWidth: 2560, refHeight: 1440, steps, updatedAt: 0 };
  return renderToStaticMarkup(createElement(BlockEditor, {
    script, templates, gamePackage: PKG, appLabel: '万龙觉醒', selectedId: null, onSelect: () => undefined, revealSeq: 0,
    onChange: () => undefined, onCapture: () => undefined, captureBlocked: null, ...extra,
  }));
}

describe('visual block editor', () => {
  it('opens the form of every block kind', () => {
    for (const { kind, label } of BLOCK_CATALOG) {
      const step = makeBlock(kind, `${kind}-1`, 'tpl_x');
      const html = render([step], { selectedId: step.id });
      expect(html, kind).toContain(label);
      expect(html, kind).toContain('更多设置（起名、前置条件、失败处理）');
    }
    expect(render([makeBlock('tap', 't')], { selectedId: 't' })).toContain('参考分辨率 2560×1440');
    expect(render([makeBlock('tapTemplate', 't', 'tpl_x')], { selectedId: 't' })).toContain('0 = 只看当前这一帧');
    expect(render([makeBlock('key', 'k')], { selectedId: 'k' })).toContain('任务列表');
    expect(render([makeBlock('launchApp', 'l')], { selectedId: 'l' })).toContain(PKG);
  });

  it('keeps cards collapsed to one sentence unless selected', () => {
    const html = render([makeBlock('tapTemplate', 't', 'tpl_x'), makeBlock('sleep', 's')]);
    expect(html).toContain('找到「联盟按钮」就点它，最多等 3 秒');
    expect(html).not.toContain('更多设置');
    expect(html).toContain('没选中任何块，新块加在最后');
    expect(render([makeBlock('sleep', 's')], { selectedId: 's' })).toContain('新块会插在选中的那块后面');
  });

  it('draws branches with their captions, add buttons and the 否则 button', () => {
    const html = render([
      { id: 'i', kind: 'if', cond: { kind: 'template', templateId: 'tpl_x' }, then: [makeBlock('sleep', 's1')] },
      { id: 'l', kind: 'loop', repeat: 2, steps: [] },
    ]);
    expect(html).toContain('成立时');
    expect(html).toContain('往成立时加一块');
    expect(html).toContain('加一个「否则」分支');
    expect(html).toContain('循环体');
    expect(html).toContain('这个分支还是空的');
    const withElse = render([{ id: 'i', kind: 'if', cond: { kind: 'always' }, then: [], else: [] }]);
    expect(withElse).toContain('往否则加一块');
    expect(withElse).not.toContain('加一个「否则」分支');
  });

  it('shows the when mark and the yellow issue tag in the card header', () => {
    const html = render([{ ...makeBlock('tapTemplate', 't', ''), when: { kind: 'template', templateId: 'tpl_x' }, name: '点开联盟' }]);
    expect(html).toContain('有前置条件');
    expect(html).toContain('还没选模板');
    expect(html).toContain('点开联盟 —— ');
  });

  it('shows composite conditions read-only', () => {
    const html = render([{ id: 'w', kind: 'waitFor', waitMs: 1000, cond: { kind: 'or', any: [{ kind: 'always' }, { kind: 'never' }] } }], { selectedId: 'w' });
    expect(html).toContain('组合条件：满足 2 个条件之一');
    expect(html).toContain('这种条件要到 JSON 模式里改');
  });

  it('disables capturing with the reason, and explains the empty script', () => {
    const html = render([], { captureBlocked: '先给脚本选一个模板集' });
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*title="先给脚本选一个模板集"/);
    expect(html).toContain('还是空的。点「从画面截取」把游戏里的按钮框下来');
  });
});
