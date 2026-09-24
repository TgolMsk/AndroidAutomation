import sharp, { type OutputInfo } from 'sharp';
import type { Rect } from './contracts.js';
import { DEFAULT_ALPHA_DIFF_TOLERANCE } from './constants.js';
import { AppError } from './errors.js';
import { asBuffer } from './vision.js';

/*
 * Transparent-background (masked) templates.
 *
 * Some controls are not solid: a ring button shows the city terrain through its middle, so a plain template scores
 * only 0.79–0.89 once the background moves. Capture the same control over 2–4 different backgrounds: pixels that
 * never change are the control, everything else becomes transparent (alpha 0) and is ignored by the match
 * (0.97–0.98 on the same frames).
 */

const MAX_FRAMES = 8;
const MAX_FRAME_BYTES = 32 * 1024 * 1024;
const MAX_CROP_PIXELS = 8_000_000;

export interface DiffAlphaOptions {
  /** A pixel is unchanged when every RGB channel differs by at most this (rounded, clamped 0..255). Default 24. */
  tolerance?: number;
  /** 3×3 majority filter against isolated noise (default on). */
  smooth?: boolean;
}

export interface DiffAlphaResult {
  /** One-channel PNG the size of the crop: 255 takes part in matching, 0 is ignored. */
  alphaPng: Buffer;
  /** Opaque fraction 0..1. Below 0.1 the control itself did not line up between frames. */
  coverage: number;
  width: number;
  height: number;
}

export interface AlphaPreviewOptions extends DiffAlphaOptions {
  /** Preview width cap (default 360; never below 16 or above 4× the crop). */
  previewWidth?: number;
}

export interface AlphaPreviewResult {
  coverage: number;
  /** Crop size in frame pixels. */
  width: number;
  height: number;
  /** The crop flattened on magenta (magenta = removed), nearest-neighbour upscaled. */
  previewPng: Buffer;
}

function cropOf(crop: Rect): { x: number; y: number; w: number; h: number } {
  const x = Math.round(crop?.x);
  const y = Math.round(crop?.y);
  const w = Math.round(crop?.w);
  const h = Math.round(crop?.h);
  if (![x, y, w, h].every(Number.isFinite) || !(w > 0) || !(h > 0) || x < 0 || y < 0 || w * h > MAX_CROP_PIXELS) {
    throw new AppError('INVALID_ARGUMENT', `差分去底的裁剪区尺寸非法：${w}x${h}`, { crop });
  }
  return { x, y, w, h };
}

/**
 * Multi-frame difference background removal.
 *
 * @param frames at least two whole-frame PNGs (same control at the same place, different backgrounds); the first is
 *   the frame the template's colours come from
 * @param crop the crop in the frames' own pixels (same convention as the template save's `crop`)
 */
export async function buildDiffAlpha(frames: readonly Uint8Array[], crop: Rect, opts: DiffAlphaOptions = {}): Promise<DiffAlphaResult> {
  if (!Array.isArray(frames) || frames.length < 2) {
    throw new AppError('INVALID_ARGUMENT', '差分去底至少需要两帧（同一控件、不同背景）', { frames: frames?.length ?? 0 });
  }
  if (frames.length > MAX_FRAMES) throw new AppError('INVALID_ARGUMENT', `差分去底最多 ${MAX_FRAMES} 帧`, { frames: frames.length });
  const tol = Math.min(255, Math.max(0, Math.round(Number.isFinite(opts.tolerance) ? opts.tolerance! : DEFAULT_ALPHA_DIFF_TOLERANCE)));
  const { x, y, w, h } = cropOf(crop);

  // Every diff frame must match the main frame's size, otherwise "the same place" means nothing.
  let refSize: { w: number; h: number } | null = null;
  for (const [i, frame] of frames.entries()) {
    if (!(frame instanceof Uint8Array) || frame.byteLength < 8 || frame.byteLength > MAX_FRAME_BYTES) {
      throw new AppError('INVALID_ARGUMENT', `差分去底：第 ${i + 1} 帧无效或超过 32 MiB`, { frame: i });
    }
    let fw = 0;
    let fh = 0;
    try {
      const meta = await sharp(asBuffer(frame)).metadata();
      fw = meta.width ?? 0;
      fh = meta.height ?? 0;
    } catch (error) {
      throw new AppError('TEMPLATE_DECODE_FAILED', `差分去底：第 ${i + 1} 帧无法解码：${error instanceof Error ? error.message : String(error)}`, { frame: i });
    }
    if (!refSize) refSize = { w: fw, h: fh };
    else if (fw !== refSize.w || fh !== refSize.h) {
      throw new AppError('INVALID_ARGUMENT',
        `差分去底：第 ${i + 1} 帧尺寸 ${fw}x${fh} 与主帧 ${refSize.w}x${refSize.h} 不一致。请在同一实例、同一分辨率下重新抓差分帧。`,
        { frame: i, size: { w: fw, h: fh }, ref: refSize });
    }
  }
  if (refSize && (x + w > refSize.w || y + h > refSize.h)) {
    throw new AppError('INVALID_ARGUMENT', `差分去底的裁剪区 ${x},${y} ${w}x${h} 超出画面 ${refSize.w}x${refSize.h}`, { crop });
  }

  const rgbs: Buffer[] = [];
  for (const [i, frame] of frames.entries()) {
    let data: Buffer;
    let info: OutputInfo;
    try {
      ({ data, info } = await sharp(asBuffer(frame)).extract({ left: x, top: y, width: w, height: h })
        .removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true }));
    } catch (error) {
      throw new AppError('TEMPLATE_DECODE_FAILED',
        `差分去底：第 ${i + 1} 帧裁剪失败（裁剪区 ${x},${y} ${w}x${h} 可能超出画面）：${error instanceof Error ? error.message : String(error)}`,
        { frame: i, crop });
    }
    if (info.channels !== 3 || data.length !== w * h * 3) {
      throw new AppError('TEMPLATE_DECODE_FAILED',
        `差分去底：第 ${i + 1} 帧解码异常，期望 ${w}x${h} 3 通道，实得 ${info.width}x${info.height} ${info.channels} 通道`, { frame: i });
    }
    rgbs.push(data);
  }

  const n = w * h;
  const raw = new Uint8Array(n);
  const ref = rgbs[0]!;
  for (let i = 0; i < n; i++) {
    let d = 0;
    for (let k = 1; k < rgbs.length; k++) {
      const other = rgbs[k]!;
      for (let c = 0; c < 3; c++) {
        const v = Math.abs(ref[i * 3 + c]! - other[i * 3 + c]!);
        if (v > d) d = v;
      }
    }
    raw[i] = d <= tol ? 255 : 0;
  }
  const mask = opts.smooth === false ? raw : majority3x3(raw, w, h);
  let opaque = 0;
  for (let i = 0; i < n; i++) if (mask[i]) opaque++;
  const alphaPng = await sharp(mask, { raw: { width: w, height: h, channels: 1 } }).png({ compressionLevel: 9 }).toBuffer();
  return { alphaPng, coverage: opaque / n, width: w, height: h };
}

/**
 * Merge a one-channel alpha image into a template PNG as its fourth channel (RGBA PNG out). The alpha image must
 * have the template's size; a multi-channel alpha uses its first channel and a grayscale template is replicated to RGB.
 */
export async function applyAlpha(png: Uint8Array, alphaPng: Uint8Array): Promise<Buffer> {
  let base: { data: Buffer; info: OutputInfo };
  let alpha: { data: Buffer; info: OutputInfo };
  try {
    base = await sharp(asBuffer(png)).removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
    alpha = await sharp(asBuffer(alphaPng)).toColourspace('b-w').raw().toBuffer({ resolveWithObject: true });
  } catch (error) {
    throw new AppError('TEMPLATE_DECODE_FAILED', `透明底合成失败：${error instanceof Error ? error.message : String(error)}`);
  }
  const w = base.info.width;
  const h = base.info.height;
  if (alpha.info.width !== w || alpha.info.height !== h) {
    throw new AppError('INVALID_ARGUMENT', `透明底 α 图尺寸 ${alpha.info.width}x${alpha.info.height} 与模板 ${w}x${h} 不一致`,
      { alpha: { w: alpha.info.width, h: alpha.info.height }, template: { w, h } });
  }
  const bc = base.info.channels;
  const ac = alpha.info.channels;
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = base.data[i * bc]!;
    rgba[i * 4 + 1] = base.data[i * bc + (bc >= 3 ? 1 : 0)]!;
    rgba[i * 4 + 2] = base.data[i * bc + (bc >= 3 ? 2 : 0)]!;
    rgba[i * 4 + 3] = alpha.data[i * ac]!;
  }
  return sharp(rgba, { raw: { width: w, height: h, channels: 4 } }).png({ compressionLevel: 9 }).toBuffer();
}

/** Preview: the main frame's crop with the diff alpha, flattened on magenta (magenta = removed) and upscaled. */
export async function renderAlphaPreview(frames: readonly Uint8Array[], crop: Rect, opts: AlphaPreviewOptions = {}): Promise<AlphaPreviewResult> {
  const result = await buildDiffAlpha(frames, crop, opts);
  const { previewPng } = await previewFromAlpha(frames[0]!, crop, result, opts.previewWidth);
  return { coverage: result.coverage, width: result.width, height: result.height, previewPng };
}

async function previewFromAlpha(frame: Uint8Array, crop: Rect, result: DiffAlphaResult, previewWidth?: number): Promise<{ previewPng: Buffer }> {
  const { x, y } = cropOf(crop);
  const cropPng = await sharp(asBuffer(frame)).extract({ left: x, top: y, width: result.width, height: result.height }).png().toBuffer();
  const rgba = await applyAlpha(cropPng, result.alphaPng);
  const width = Math.max(16, Math.min(Number.isFinite(previewWidth) ? Math.round(previewWidth!) : 360, result.width * 4));
  const previewPng = await sharp(rgba).flatten({ background: '#ff00ff' }).resize({ width, kernel: 'nearest' }).png().toBuffer();
  return { previewPng };
}

/**
 * The template page's preview in one call: the alpha PNG (still accepted by the template save), the magenta
 * preview and the coverage. `options` may be the tolerance alone (older callers).
 */
export async function buildTemplateAlpha(
  frames: readonly Uint8Array[], crop: Rect, options: number | AlphaPreviewOptions = {},
): Promise<{ alphaPng: Uint8Array; previewPng: Uint8Array; coverage: number; width: number; height: number }> {
  const opts: AlphaPreviewOptions = typeof options === 'number' ? { tolerance: options } : options;
  const result = await buildDiffAlpha(frames, crop, opts);
  const { previewPng } = await previewFromAlpha(frames[0]!, crop, result, opts.previewWidth);
  return { alphaPng: result.alphaPng, previewPng, coverage: result.coverage, width: result.width, height: result.height };
}

/** 3×3 majority: opaque only when at least 5 of the up-to-9 neighbours are (the fixed 5 also erodes crop edges). */
function majority3x3(src: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let count = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          if (src[yy * w + xx]) count++;
        }
      }
      out[y * w + x] = count >= 5 ? 255 : 0;
    }
  }
  return out;
}
