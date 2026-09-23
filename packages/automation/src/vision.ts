import sharp from 'sharp';
import { createRequire } from 'node:module';
import type {
  MatchResult, Point, PreparedFrame, PreparedTemplate, RawFrame, Rect,
  TemplateDefinition, TemplateSet, VisionPort,
} from './contracts.js';

sharp.concurrency(1);
sharp.cache(false);

const MIN_TEMPLATE_STD = 12;
const MAX_FRAME_PIXELS = 100_000_000;
const DEFAULT_THRESHOLD = 0.85;
type Cv = any; // opencv-js exposes runtime Mat views absent from its TypeScript declarations.
let cvPromise: Promise<Cv> | undefined;
const requireRuntime = createRequire(import.meta.url);

export async function getCv(): Promise<Cv> {
  cvPromise ??= (async () => {
    // The package's CJS export is a thenable Emscripten Module. Vitest/Vite tries
    // to await its namespace and invokes `then` with the wrong receiver, so use
    // createRequire and call `then` on that Module explicitly.
    const candidate = requireRuntime('@techstark/opencv-js') as Cv;
    const cv = await new Promise<Cv>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('OpenCV 初始化超时')), 60_000);
      const finish = (value: Cv): void => { clearTimeout(timer); resolve(value); };
      const fail = (error: unknown): void => { clearTimeout(timer); reject(error); };
      if (typeof candidate.then === 'function') candidate.then.call(candidate, finish, fail);
      else finish(candidate);
    });
    if (!cv || typeof (cv as Cv).Mat !== 'function' || typeof (cv as Cv).matchTemplate !== 'function') {
      throw new Error('OpenCV 模块缺少 Mat 或 matchTemplate');
    }
    return cv;
  })().catch((error) => {
    cvPromise = undefined;
    throw error;
  });
  return cvPromise;
}

/** Ensure WASM Mats are released even when matching throws. */
export async function withMats<T>(fn: (keep: <M extends { delete(): void }>(mat: M) => M) => T | Promise<T>): Promise<T> {
  const owned: Array<{ delete(): void }> = [];
  const keep = <M extends { delete(): void }>(mat: M): M => { owned.push(mat); return mat; };
  try { return await fn(keep); }
  finally { for (let i = owned.length - 1; i >= 0; i--) owned[i]!.delete(); }
}

function asBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function clampShrink(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 8) throw new Error('shrink 必须是 1 到 8 的整数');
  return value;
}

function threshold(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error('匹配阈值必须在 0 到 1 之间');
  return value;
}

function dimension(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1 || value > 16_384) throw new Error(`${label} 无效`);
  return value;
}

function stdDev(gray: Uint8Array, mask?: Uint8Array): number {
  let count = 0;
  let sum = 0;
  let square = 0;
  for (let i = 0; i < gray.length; i++) {
    if (mask && !mask[i]) continue;
    const value = gray[i]!;
    count++;
    sum += value;
    square += value * value;
  }
  if (count < 16) return 0;
  const mean = sum / count;
  return Math.sqrt(Math.max(0, square / count - mean * mean));
}

function grayShrink(rgba: Uint8Array, width: number, height: number, shrink: number): Uint8Array {
  const outWidth = Math.max(1, Math.floor(width / shrink));
  const outHeight = Math.max(1, Math.floor(height / shrink));
  const out = new Uint8Array(outWidth * outHeight);
  for (let y = 0; y < outHeight; y++) {
    let src = y * shrink * width * 4;
    let dst = y * outWidth;
    for (let x = 0; x < outWidth; x++) {
      out[dst++] = ((77 * rgba[src]! + 151 * rgba[src + 1]! + 28 * rgba[src + 2]!) >>> 8);
      src += shrink * 4;
    }
  }
  return out;
}

export async function prepareFrame(
  raw: RawFrame,
  options: { refWidth: number; refHeight: number; shrink?: number } | { refW: number; refH: number; shrink?: number },
): Promise<PreparedFrame> {
  const width = dimension(raw.width, '帧宽度');
  const height = dimension(raw.height, '帧高度');
  const refWidth = dimension('refWidth' in options ? options.refWidth : options.refW, '参考宽度');
  const refHeight = dimension('refHeight' in options ? options.refHeight : options.refH, '参考高度');
  const shrink = clampShrink(options.shrink ?? 2);
  if (width * height > MAX_FRAME_PIXELS || raw.data.byteLength !== width * height * 4) {
    throw new Error(`原始帧长度与 ${width}×${height} RGBA8888 不符`);
  }
  const targetWidth = Math.max(1, Math.floor(refWidth / shrink));
  const targetHeight = Math.max(1, Math.floor(refHeight / shrink));
  let gray: Uint8Array;
  if (width === refWidth && height === refHeight) {
    gray = grayShrink(raw.data, width, height, shrink);
  } else {
    const { data, info } = await sharp(asBuffer(raw.data), { raw: { width, height, channels: 4 } })
      .resize(targetWidth, targetHeight, { kernel: 'cubic', fit: 'fill' })
      .greyscale().toColourspace('b-w').raw().toBuffer({ resolveWithObject: true });
    if (info.channels !== 1 || data.byteLength !== targetWidth * targetHeight) {
      throw new Error('帧缩放未生成单通道灰度图');
    }
    gray = data;
  }
  return {
    gray,
    width: targetWidth,
    height: targetHeight,
    w: targetWidth,
    h: targetHeight,
    shrink,
    refWidth,
    refHeight,
    deviceWidth: width,
    deviceHeight: height,
    capturedAt: raw.capturedAt,
  };
}

export async function prepareTemplate(
  image: Uint8Array,
  definition: TemplateDefinition,
  set: TemplateSet,
  shrinkValue = 2,
): Promise<PreparedTemplate> {
  const shrink = clampShrink(shrinkValue);
  const imageBytes = asBuffer(image);
  const metadata = await sharp(imageBytes).metadata();
  const imageWidth = dimension(metadata.width ?? 0, '模板图片宽度');
  const imageHeight = dimension(metadata.height ?? 0, '模板图片高度');
  const factor = set.refWidth / dimension(definition.authoredWidth, '模板原画面宽度');
  const refWidth = Math.max(1, Math.round(imageWidth * factor));
  const refHeight = Math.max(1, Math.round(imageHeight * factor));
  if (refWidth > set.refWidth || refHeight > set.refHeight) {
    throw new Error(`模板 ${definition.id} 大于参考画面`);
  }
  const width = Math.max(1, Math.round(refWidth / shrink));
  const height = Math.max(1, Math.round(refHeight / shrink));
  if (width < 3 || height < 3) throw new Error(`模板 ${definition.id} 降采样后过小`);
  const resized = sharp(imageBytes).removeAlpha().resize(width, height, { kernel: 'cubic', fit: 'fill' });
  const { data, info } = await resized.greyscale().toColourspace('b-w').raw().toBuffer({ resolveWithObject: true });
  if (info.channels !== 1 || data.byteLength !== width * height) throw new Error(`模板 ${definition.id} 灰度解码失败`);

  let mask: Uint8Array | undefined;
  if (metadata.hasAlpha) {
    const alpha = await sharp(imageBytes).resize(width, height, { kernel: 'nearest', fit: 'fill' })
      .ensureAlpha().extractChannel(3).raw().toBuffer();
    if (alpha.byteLength !== width * height) throw new Error(`模板 ${definition.id} 透明掩码长度错误`);
    const binary = Uint8Array.from(alpha, (value) => value >= 128 ? 255 : 0);
    const visible = binary.reduce((count, value) => count + (value ? 1 : 0), 0);
    if (visible > 0 && visible < width * height) {
      if (visible < 16 || visible / binary.length < 0.05) throw new Error(`模板 ${definition.id} 有效像素过少`);
      mask = binary;
    }
  }
  const variation = stdDev(data, mask);
  if (variation < MIN_TEMPLATE_STD) throw new Error(`模板 ${definition.id} 纹理不足，标准差 ${variation.toFixed(2)}`);
  return {
    id: definition.id,
    name: definition.name,
    gray: data,
    width,
    height,
    w: width,
    h: height,
    refWidth,
    refHeight,
    refW: refWidth,
    refH: refHeight,
    shrink,
    threshold: threshold(definition.threshold ?? DEFAULT_THRESHOLD),
    defaultRoi: definition.defaultRoi,
    mask,
    std: variation,
  };
}

function searchRect(frame: PreparedFrame, roi?: Rect): { x: number; y: number; w: number; h: number } {
  if (!roi) return { x: 0, y: 0, w: frame.width, h: frame.height };
  if (![roi.x, roi.y, roi.w, roi.h].every(Number.isFinite) || roi.w <= 0 || roi.h <= 0) {
    throw new Error('ROI 无效');
  }
  const x0 = Math.max(0, Math.floor(roi.x / frame.shrink));
  const y0 = Math.max(0, Math.floor(roi.y / frame.shrink));
  const x1 = Math.min(frame.width, Math.ceil((roi.x + roi.w) / frame.shrink));
  const y1 = Math.min(frame.height, Math.ceil((roi.y + roi.h) / frame.shrink));
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

export async function matchTemplate(
  frame: PreparedFrame,
  template: PreparedTemplate,
  options: { roi?: Rect; threshold?: number } = {},
): Promise<MatchResult> {
  const started = performance.now();
  const limit = threshold(options.threshold ?? template.threshold);
  if (frame.shrink !== template.shrink) throw new Error('帧与模板的 shrink 不一致');
  if (frame.gray.byteLength !== frame.width * frame.height ||
      template.gray.byteLength !== template.width * template.height) throw new Error('帧或模板像素长度错误');
  const region = searchRect(frame, options.roi ?? template.defaultRoi);
  const missed = (reason: string, score = -1): MatchResult => ({
    templateId: template.id, found: false, score,
    x: -1, y: -1, w: template.refWidth, h: template.refHeight,
    centerX: -1, centerY: -1, threshold: limit,
    elapsedMs: Math.round((performance.now() - started) * 100) / 100, reason,
  });
  if (region.w < template.width || region.h < template.height) return missed('搜索区域小于模板');
  const cv = await getCv();
  const owned: Cv[] = [];
  const keep = <T>(mat: T): T => { owned.push(mat); return mat; };
  try {
    const source = keep(new cv.Mat(region.h, region.w, cv.CV_8UC1));
    const sourcePixels = source.data as Uint8Array;
    for (let y = 0; y < region.h; y++) {
      const from = (region.y + y) * frame.width + region.x;
      sourcePixels.set(frame.gray.subarray(from, from + region.w), y * region.w);
    }
    const needle = keep(new cv.Mat(template.height, template.width, cv.CV_8UC1));
    (needle.data as Uint8Array).set(template.gray);
    const result = keep(new cv.Mat());
    if (template.mask) {
      const mask = keep(new cv.Mat(template.height, template.width, cv.CV_8UC1));
      (mask.data as Uint8Array).set(template.mask);
      cv.matchTemplate(source, needle, result, cv.TM_CCOEFF_NORMED, mask);
      for (const [i, value] of (result.data32F as Float32Array).entries()) {
        if (!Number.isFinite(value) || value > 1.001) (result.data32F as Float32Array)[i] = 0;
      }
    } else {
      cv.matchTemplate(source, needle, result, cv.TM_CCOEFF_NORMED);
    }
    const peak = cv.minMaxLoc(result) as { maxVal: number; maxLoc: { x: number; y: number } };
    const score = Number.isFinite(peak.maxVal) ? Math.max(-1, Math.min(1, peak.maxVal)) : -1;
    if (score < limit) return missed('低于阈值', Math.round(score * 10_000) / 10_000);
    const x = (region.x + peak.maxLoc.x) * frame.shrink;
    const y = (region.y + peak.maxLoc.y) * frame.shrink;
    return {
      templateId: template.id, found: true,
      score: Math.round(score * 10_000) / 10_000,
      x, y, w: template.refWidth, h: template.refHeight,
      centerX: x + template.refWidth / 2,
      centerY: y + template.refHeight / 2,
      threshold: limit,
      elapsedMs: Math.round((performance.now() - started) * 100) / 100,
    };
  } finally {
    for (let i = owned.length - 1; i >= 0; i--) owned[i].delete();
  }
}

export function refToDevice(frame: PreparedFrame, point: Point): Point {
  return {
    x: Math.round(point.x * frame.deviceWidth / frame.refWidth),
    y: Math.round(point.y * frame.deviceHeight / frame.refHeight),
  };
}

/** Default OpenCV/sharp implementation. Tests and future engines can supply another VisionPort. */
export const defaultVision: VisionPort = {
  prepareFrame,
  prepareTemplate,
  match: matchTemplate,
};

/** Names used by the migrated game flow. */
export const matchIn = matchTemplate;
