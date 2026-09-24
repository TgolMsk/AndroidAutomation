/**
 * Template self-learning (original src/main/ai/harvest.ts): the close button the AI found is cut from the frame
 * **before** the click and saved into the user's template set through the template library (variance guard, atomic
 * write, per-directory writer, change notification). A flat crop fails the library's std < 12 guard — exactly what
 * must not be learnt — and is reported as a skip.
 *
 * Ids: the first one is `tpl_btn_close_popup` (the template gather always lacked), then `tpl_btn_close_popup_ai2`,
 * `_ai3` … up to 8 in the family. Gather G0, the sampler and the pre-gate ladder all scan「equals or starts with
 * tpl_btn_close_popup_」, so a new variant needs no code change.
 */
import type { RawFrame, Rect, TemplateDraft } from '@avdm/automation';
import type { AdvisorBox } from '../../../shared/ai';
import { rawFrameToPng } from '../template-tools';

export const CLOSE_POPUP_TEMPLATE_ID = 'tpl_btn_close_popup';
/** At most this many learnt variants: past it a human should check what is being learnt. */
export const MAX_HARVESTED_VARIANTS = 8;
/** Extra pixels around the AI's box so the button's edge is not cut off. */
const HARVEST_MARGIN_PX = 3;
/** Template size range (reference coordinates): smaller has no discriminating power, larger is not a button. */
const MIN_TEMPLATE_PX = 16;
const MAX_TEMPLATE_PX = 420;

/** Whether a template id belongs to the close-button family (the original one or an AI variant). */
export function isClosePopupTemplateId(id: string): boolean {
  return id === CLOSE_POPUP_TEMPLATE_ID || id.startsWith(`${CLOSE_POPUP_TEMPLATE_ID}_`);
}

/** Id for a new learnt template: the original id while free, then _ai2 / _ai3 …; null once the family is full. */
export function nextHarvestId(existingIds: readonly string[]): string | null {
  if (!existingIds.includes(CLOSE_POPUP_TEMPLATE_ID)) return CLOSE_POPUP_TEMPLATE_ID;
  const family = existingIds.filter(isClosePopupTemplateId);
  if (family.length >= MAX_HARVESTED_VARIANTS) return null;
  for (let n = 2; n < MAX_HARVESTED_VARIANTS + 2; n++) {
    const id = `${CLOSE_POPUP_TEMPLATE_ID}_ai${n}`;
    if (!existingIds.includes(id)) return id;
  }
  return null;
}

export interface HarvestInput {
  /** The raw frame before the click (the button is still on screen). */
  raw: RawFrame;
  /** Button box in reference coordinates. */
  box: AdvisorBox;
  refWidth: number;
  refHeight: number;
  /** Written into the template note: the model's reason, confidence, source chain. */
  note: string;
}

/** Where learnt templates go (the executor's template set). */
export interface HarvestPort {
  /** Ids currently in the set (read fresh: the library overwrites nothing without `overwrite`). */
  existingIds(): Promise<string[]>;
  /** Save through the template library (variance guard, atomic write, change notification → caches invalidated). */
  save(draft: TemplateDraft): Promise<{ id: string; std: number }>;
}

export interface HarvestResult {
  id: string;
  std: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Cut and save the close button. Returns `{id, std}`, or null with the Chinese reason given to `onSkip` (family
 * full, flat crop, box out of range, read / save failure). Never throws.
 */
export async function harvestCloseButton(input: HarvestInput, port: HarvestPort, onSkip: (reason: string) => void): Promise<HarvestResult | null> {
  const { raw, box } = input;
  if (box.w < MIN_TEMPLATE_PX || box.h < MIN_TEMPLATE_PX) {
    onSkip(`目标框太小（${box.w}x${box.h}），不够当模板。`);
    return null;
  }
  if (box.w > MAX_TEMPLATE_PX || box.h > MAX_TEMPLATE_PX) {
    onSkip(`目标框太大（${box.w}x${box.h}），不像一个按钮，不学。`);
    return null;
  }
  let existingIds: string[];
  try { existingIds = await port.existingIds(); }
  catch (error) {
    onSkip(`读模板集失败：${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  const id = nextHarvestId(existingIds);
  if (!id) {
    onSkip(`已经自学了 ${MAX_HARVESTED_VARIANTS} 张关闭按钮变体，不再新增。请到「模板」页看看是不是学错了东西。`);
    return null;
  }

  // Reference → device pixels, a small margin, clamped into the frame.
  const kx = raw.width / input.refWidth;
  const ky = raw.height / input.refHeight;
  const left = clamp(Math.floor(box.x * kx) - HARVEST_MARGIN_PX, 0, raw.width - 2);
  const top = clamp(Math.floor(box.y * ky) - HARVEST_MARGIN_PX, 0, raw.height - 2);
  const right = clamp(Math.ceil((box.x + box.w) * kx) + HARVEST_MARGIN_PX, left + 2, raw.width);
  const bottom = clamp(Math.ceil((box.y + box.h) * ky) + HARVEST_MARGIN_PX, top + 2, raw.height);
  const crop: Rect = { x: left, y: top, w: right - left, h: bottom - top };

  // The whole frame as PNG (the library crops it, so bounds and the default ROI land in the right place).
  let framePng: Buffer;
  try { framePng = await rawFrameToPng(raw); }
  catch (error) {
    onSkip(`截图编码失败：${error instanceof Error ? error.message : String(error)}`);
    return null;
  }

  // Search region: the box padded generously (close buttons of different popups sit slightly apart).
  const roiPad = Math.max(160, Math.round(Math.max(box.w, box.h) * 2));
  const roiX = clamp(box.x - roiPad, 0, input.refWidth - 1);
  const roiY = clamp(box.y - roiPad, 0, input.refHeight - 1);
  const defaultRoi: Rect = {
    x: roiX, y: roiY,
    w: clamp(box.x + box.w + roiPad, roiX + 1, input.refWidth) - roiX,
    h: clamp(box.y + box.h + roiPad, roiY + 1, input.refHeight) - roiY,
  };

  const seq = id === CLOSE_POPUP_TEMPLATE_ID ? 1 : Number(id.slice(id.lastIndexOf('ai') + 2)) || 0;
  try {
    return await port.save({
      id,
      name: `弹窗关闭·AI 自学 #${seq}`,
      image: framePng,
      authoredWidth: raw.width,
      authoredHeight: raw.height,
      crop,
      defaultRoi,
      tags: ['ai-harvest', 'popup-close'],
      note: input.note.slice(0, 300),
    });
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    const message = error instanceof Error ? error.message : String(error);
    onSkip(code === 'TEMPLATE_LOW_VARIANCE'
      ? `裁出来的区域方差太低（纯色 / 渐变），视觉层拒绝入库：${message}`
      : `保存模板失败：${message}`);
    return null;
  }
}
