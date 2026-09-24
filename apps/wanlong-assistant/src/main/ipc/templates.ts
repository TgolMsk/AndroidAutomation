import { isAbsolute } from 'node:path';
import type { Rect, TemplateDraft } from '@avdm/automation';
import type { TemplatesApi, TemplateTestOptions } from '../../shared/ipc';
import type { AutomationHost } from '../automation/host';
import type { DomainHandlers } from './types';
import { asIndex, flag, game, patchObject, text } from './validate';

export interface TemplatesServices {
  automation: AutomationHost;
}

/** The page sends the main frame plus 1–3 diff frames. */
const MAX_ALPHA_FRAMES = 4;
const MAX_DIFF_FRAMES = 3;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function rect(value: unknown, label: string): Rect {
  if (!isRecord(value)) throw new Error(`${label}无效`);
  const { x, y, w, h } = value;
  if (![x, y, w, h].every((n) => typeof n === 'number' && Number.isFinite(n)) || (w as number) <= 0 || (h as number) <= 0) {
    throw new Error(`${label}无效`);
  }
  return { x: x as number, y: y as number, w: w as number, h: h as number };
}

function bytes(value: unknown, label: string): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new Error(`${label}无效`);
  return value;
}

function optionalNumber(value: unknown, label: string, min: number, max: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`${label}无效`);
  return value;
}

/** Keep only the draft fields the library understands, with their types checked. */
export function templateDraft(value: unknown): TemplateDraft {
  const draft = patchObject(value as Record<string, unknown>, '模板草稿');
  if (typeof draft.name !== 'string') throw new Error('模板名称无效');
  if (typeof draft.authoredWidth !== 'number' || typeof draft.authoredHeight !== 'number') throw new Error('截取画面尺寸无效');
  const out: TemplateDraft = {
    name: draft.name,
    image: bytes(draft.image, '模板图片'),
    authoredWidth: draft.authoredWidth,
    authoredHeight: draft.authoredHeight,
  };
  if (draft.id !== undefined && draft.id !== '') {
    if (typeof draft.id !== 'string' || draft.id.length > 96) throw new Error('模板 ID 无效');
    out.id = draft.id;
  }
  if (draft.crop !== undefined) out.crop = rect(draft.crop, '裁剪区域');
  if (draft.defaultRoi !== undefined) out.defaultRoi = rect(draft.defaultRoi, '默认搜索区域');
  const threshold = optionalNumber(draft.threshold, '匹配阈值', 0, 1);
  if (threshold !== undefined) out.threshold = threshold;
  if (draft.tags !== undefined) {
    if (!Array.isArray(draft.tags) || draft.tags.length > 20 || !draft.tags.every((tag) => typeof tag === 'string' && tag.length <= 40)) {
      throw new Error('模板标签无效');
    }
    out.tags = draft.tags as string[];
  }
  if (draft.note !== undefined) {
    if (typeof draft.note !== 'string' || draft.note.length > 500) throw new Error('模板备注无效');
    out.note = draft.note;
  }
  if (draft.alpha !== undefined) out.alpha = bytes(draft.alpha, '透明掩码');
  if (draft.diffFrames !== undefined) {
    if (!Array.isArray(draft.diffFrames) || draft.diffFrames.length > MAX_DIFF_FRAMES) throw new Error('去底差分帧无效');
    out.diffFrames = draft.diffFrames.map((frame) => bytes(frame, '去底差分帧'));
  }
  const tolerance = optionalNumber(draft.diffTolerance, '去底容差', 0, 255);
  if (tolerance !== undefined) out.diffTolerance = tolerance;
  if (draft.overwrite !== undefined) out.overwrite = flag(draft.overwrite, '覆盖确认');
  return out;
}

function testOptions(value: unknown): TemplateTestOptions {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) throw new Error('验证参数无效');
  const out: TemplateTestOptions = {};
  if (value.roi !== undefined && value.roi !== null) out.roi = rect(value.roi, '验证搜索区域');
  const threshold = optionalNumber(value.threshold, '验证阈值', 0, 1);
  if (threshold !== undefined) out.threshold = threshold;
  return out;
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
  async previewAutomationTemplateAlpha({ automation }, gameId, index, frames, crop, tolerance, previewWidth) {
    if (!Array.isArray(frames) || frames.length < 2 || frames.length > MAX_ALPHA_FRAMES || !frames.every((frame) => frame instanceof Uint8Array)) {
      throw new Error('去底截图无效：需要主帧加 1~3 帧差分帧');
    }
    const width = optionalNumber(previewWidth, '预览宽度', 16, 1200);
    return automation.previewTemplateAlpha(game(gameId), asIndex(index), frames, rect(crop, '去底裁剪区域'),
      optionalNumber(tolerance, '去底容差', 0, 255) ?? 24, width);
  },
  async saveAutomationTemplate({ automation }, gameId, index, draft) {
    return automation.saveTemplate(game(gameId), asIndex(index), templateDraft(draft));
  },
  async deleteAutomationTemplate({ automation }, gameId, index, id) {
    await automation.deleteTemplate(game(gameId), asIndex(index), text(id, '模板 ID'));
  },
  async testAutomationTemplate({ automation }, gameId, index, id, options) {
    return automation.testTemplate(game(gameId), asIndex(index), text(id, '模板 ID'), testOptions(options));
  },
  async automationTemplateCoverage({ automation }, gameId, index, compile) {
    return automation.templateCoverage(game(gameId), asIndex(index), flag(compile, '检查方式'));
  },
  async importAutomationTemplateSets({ automation }, gameId, sourceDir) {
    const directory = text(sourceDir, '导入目录');
    if (!isAbsolute(directory)) throw new Error('导入目录无效');
    return automation.importTemplateSets(game(gameId), directory);
  },
};
