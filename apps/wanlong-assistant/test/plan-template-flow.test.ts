import { describe, expect, it } from 'vitest';
import type { ScriptDef } from '../src/main/plans/types';
import { insertSavedTemplate, type TemplateInsertResult } from '../src/renderer/views/automation/script-template-flow';

const script: ScriptDef = {
  id: 'route-1', name: '回城', version: '1.0.0', packageName: 'game.example',
  refWidth: 2560, refHeight: 1440, updatedAt: 0,
  steps: [
    { id: 'start', kind: 'tapTemplate', templateId: 'old', waitMs: 4000, offset: { x: 4, y: -2 } },
    { id: 'wait', kind: 'waitFor', cond: { kind: 'template', templateId: 'old', present: false }, waitMs: 2500 },
  ],
};
const result: TemplateInsertResult = {
  id: 'request-1', gameId: 'wanlong', index: 1, scriptId: script.id, stepId: 'start',
  stepKind: 'tapTemplate', templateId: 'fresh', templateName: '联盟按钮', templateSetId: 'set-1',
};

describe('visual script template insertion', () => {
  it('fills only the requested block and preserves its click settings', () => {
    const next = insertSavedTemplate(script, result);
    expect(next?.templateSetId).toBe('set-1');
    expect(next?.steps[0]).toEqual({ ...script.steps[0], templateId: 'fresh' });
    expect(next?.steps[1]).toEqual(script.steps[1]);
    expect(script.steps[0]).toHaveProperty('templateId', 'old');
  });

  it('can append a wait-for-disappearance block only after a template is saved', () => {
    const next = insertSavedTemplate(script, { ...result, id: 'request-2', stepId: 'new-wait', stepKind: 'waitFor',
      createStep: true, waitForPresent: false });
    expect(next?.steps).toHaveLength(3);
    expect(next?.steps[2]).toEqual({ id: 'new-wait', kind: 'waitFor',
      cond: { kind: 'template', templateId: 'fresh', present: false }, waitMs: 3000 });
    expect(script.steps).toHaveLength(2);
  });

  it('rejects stale step callbacks and a save into another template set', () => {
    const bound = { ...script, templateSetId: 'set-1' };
    expect(insertSavedTemplate(bound, { ...result, stepId: 'deleted' })).toBeNull();
    expect(insertSavedTemplate(bound, { ...result, scriptId: 'another-script' })).toBeNull();
    expect(insertSavedTemplate(bound, { ...result, templateSetId: 'set-2' })).toBeNull();
    expect(insertSavedTemplate(bound, { ...result, createStep: true })).toBeNull();
  });

  it('keeps waiting mode and other condition fields when replacing its template', () => {
    const next = insertSavedTemplate(script, { ...result, stepId: 'wait', stepKind: 'waitFor' });
    expect(next?.steps[1]).toEqual({ ...script.steps[1], cond: { kind: 'template', templateId: 'fresh', present: false } });
  });
});
