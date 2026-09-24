import type { TemplatesApi } from '../../shared/ipc';
import type { AutomationHost } from '../automation/host';
import type { DomainHandlers } from './types';
import { asIndex, game, patchObject, text } from './validate';

export interface TemplatesServices {
  automation: AutomationHost;
}

export const templatesHandlers: DomainHandlers<TemplatesApi, TemplatesServices> = {
  async automationTemplateSets({ automation }, gameId) {
    return automation.templateSets(game(gameId));
  },
  async createAutomationTemplateSet({ automation }, gameId, index, name) {
    return automation.createTemplateSet(game(gameId), asIndex(index), text(name, '模板集名称'));
  },
  async automationTemplateSet({ automation }, gameId, index) {
    return automation.templateSet(game(gameId), asIndex(index));
  },
  async automationTemplateImage({ automation }, gameId, index, id) {
    return automation.templateImage(game(gameId), asIndex(index), text(id, '模板 ID'));
  },
  async captureAutomationTemplate({ automation }, gameId, index) {
    return automation.captureTemplate(game(gameId), asIndex(index));
  },
  async previewAutomationTemplateAlpha({ automation }, gameId, index, frames, crop, tolerance) {
    if (!Array.isArray(frames) || !frames.every((frame) => frame instanceof Uint8Array)) throw new Error('去底截图无效');
    return automation.previewTemplateAlpha(game(gameId), asIndex(index), frames, crop, tolerance);
  },
  async saveAutomationTemplate({ automation }, gameId, index, draft) {
    return automation.saveTemplate(game(gameId), asIndex(index), patchObject(draft, '模板草稿'));
  },
  async deleteAutomationTemplate({ automation }, gameId, index, id) {
    await automation.deleteTemplate(game(gameId), asIndex(index), text(id, '模板 ID'));
  },
  async testAutomationTemplate({ automation }, gameId, index, id) {
    return automation.testTemplate(game(gameId), asIndex(index), text(id, '模板 ID'));
  },
};
