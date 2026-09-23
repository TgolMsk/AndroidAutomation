import type { ScriptDef, ScriptStep } from '../../../main/plans/types';

export interface TemplateInsertRequest {
  id: string;
  gameId: string;
  index: number;
  scriptId: string;
  stepId: string;
  stepKind: 'tapTemplate' | 'waitFor';
  expectedTemplateSetId?: string;
  /** When true, saving the template appends a new block; cancellation leaves the script unchanged. */
  createStep?: boolean;
  waitForPresent?: boolean;
}

export interface TemplateSavedForScript {
  templateId: string;
  templateName: string;
  templateSetId: string;
}

export interface TemplateInsertResult extends TemplateInsertRequest, TemplateSavedForScript {}

/** A callback may arrive after navigation or another edit; only patch its exact draft step. */
export function insertSavedTemplate(script: ScriptDef, result: TemplateInsertResult): ScriptDef | null {
  if (script.id !== result.scriptId ||
    (script.templateSetId && script.templateSetId !== result.templateSetId) ||
    (result.expectedTemplateSetId && result.expectedTemplateSetId !== result.templateSetId)) return null;
  if (result.createStep) {
    if (script.steps.some((step) => step.id === result.stepId)) return null;
    const nextStep: ScriptStep = result.stepKind === 'tapTemplate'
      ? { id: result.stepId, kind: 'tapTemplate', templateId: result.templateId, waitMs: 3000 }
      : { id: result.stepId, kind: 'waitFor', cond: { kind: 'template', templateId: result.templateId,
        present: result.waitForPresent !== false }, waitMs: 3000 };
    return { ...script, templateSetId: result.templateSetId, steps: [...script.steps, nextStep] };
  }
  const index = script.steps.findIndex((step) => step.id === result.stepId && step.kind === result.stepKind);
  if (index < 0) return null;
  const step = script.steps[index]!;
  let nextStep: ScriptStep;
  if (step.kind === 'tapTemplate') nextStep = { ...step, templateId: result.templateId };
  else if (step.kind === 'waitFor' && step.cond.kind === 'template') {
    nextStep = { ...step, cond: { ...step.cond, templateId: result.templateId } };
  } else return null;
  const steps = [...script.steps];
  steps[index] = nextStep;
  return { ...script, templateSetId: result.templateSetId, steps };
}
