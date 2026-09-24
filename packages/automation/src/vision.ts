import sharp, { type OutputInfo } from 'sharp';
import { createRequire } from 'node:module';
import type {
  DetectSpec, MatchOptions, MatchResult, Point, PreparedFrame, PreparedTemplate, RawFrame, Rect,
  TemplateDefinition, TemplateSet, VisionPort,
} from './contracts.js';
import {
  DEFAULT_MATCH_THRESHOLD, DEFAULT_SHRINK, MIN_MASK_COVERAGE, MIN_MASK_PIXELS, MIN_TEMPLATE_STD,
} from './constants.js';
import { AppError } from './errors.js';

/*
 * The only module that touches OpenCV (and, with template-alpha.ts, sharp) at match time.
 *
 * sharp is configured once at import: one libvips thread and no operation cache. Every frame is used once, so the
 * cache only costs memory. Note that with worker_threads the setting is process-wide: all workers in the Electron
 * main process share one libvips pool, which keeps concurrent captures from fighting over cores.
 */
sharp.concurrency(1);
sharp.cache(false);

const MAX_FRAME_PIXELS = 100_000_000;
/** Templates below this edge after shrinking have no discriminating power. */
const MIN_PREPARED_EDGE = 3;
/** Compile cache size. Templates are a few KB; eviction is by insertion order. */
const MAX_CACHE_ENTRIES = 256;
/** A timeout for the legacy onRuntimeInitialized path, which otherwise hangs forever. */
const CV_INIT_TIMEOUT_MS = 60_000;

type Cv = any; // opencv-js exposes runtime Mat views absent from its TypeScript declarations.
let cvPromise: Promise<Cv> | undefined;
let cvReady: Cv | undefined;
const requireRuntime = createRequire(import.meta.url);

/**
 * The ready OpenCV handle (singleton; concurrent callers share one initialization, a failure can be retried).
 * Supports the three export shapes seen across opencv-js releases: a thenable Emscripten Module, an already
 * initialized object, and the old `onRuntimeInitialized` callback (with a timeout).
 */
export async function getCv(): Promise<Cv> {
  if (cvReady) return cvReady;
  cvPromise ??= initCv().then((cv) => { cvReady = cv; return cv; }).catch((error) => {
    cvPromise = undefined;
    throw error;
  });
  return cvPromise;
}

/** Whether OpenCV is already initialized (synchronous health query; never triggers loading). */
export function isCvReady(): boolean {
  return cvReady !== undefined;
}

async function initCv(): Promise<Cv> {
  let candidate: Cv;
  try {
    // The package's CJS export is a thenable Emscripten Module. Vitest/Vite tries to await its namespace and
    // invokes `then` with the wrong receiver, so use createRequire and call `then` on that Module explicitly.
    candidate = requireRuntime('@techstark/opencv-js') as Cv;
  } catch (error) {
    throw new AppError('CV_INIT_FAILED',
      'OpenCV(WASM) 模块加载失败。打包后若报此错，多半是 asarUnpack 没包含 @techstark/opencv-js。',
      { cause: error instanceof Error ? error.message : String(error) });
  }
  const cv = await new Promise<Cv>((resolve, reject) => {
    const timer = setTimeout(() => reject(new AppError('CV_INIT_FAILED',
      `OpenCV(WASM) 初始化超过 ${CV_INIT_TIMEOUT_MS / 1000} 秒仍未就绪。`)), CV_INIT_TIMEOUT_MS);
    const finish = (value: Cv): void => { clearTimeout(timer); resolve(value); };
    const fail = (error: unknown): void => {
      clearTimeout(timer);
      reject(new AppError('CV_INIT_FAILED', `OpenCV(WASM) 初始化失败：${error instanceof Error ? error.message : String(error)}`));
    };
    if (candidate && typeof candidate.then === 'function') candidate.then.call(candidate, finish, fail);
    else if (candidate && typeof candidate.Mat === 'function') finish(candidate);
    else if (candidate && typeof candidate === 'object') candidate.onRuntimeInitialized = () => finish(candidate);
    else fail(new Error(`导出形态无法识别（${typeof candidate}）`));
  });
  if (!cv || typeof cv.Mat !== 'function' || typeof cv.matchTemplate !== 'function') {
    throw new AppError('CV_INIT_FAILED', 'OpenCV(WASM) 已加载但缺少 Mat / matchTemplate 接口。');
  }
  // Cheap self-check: without the constant, matchTemplate would silently receive `undefined`.
  if (typeof cv.TM_CCOEFF_NORMED !== 'number') {
    throw new AppError('CV_INIT_FAILED', 'OpenCV(WASM) 缺少 TM_CCOEFF_NORMED 常量。');
  }
  return cv;
}

interface Deletable { delete(): void }

/**
 * ★ Every Mat lives in WASM memory that the GC never frees: create them only through `keep`. They are deleted in
 * reverse order, each delete in its own try/catch, so one failing delete neither leaks the others nor replaces the
 * original error.
 */
export async function withMats<T>(fn: (keep: <M extends Deletable>(mat: M) => M) => T | Promise<T>): Promise<T> {
  const owned: Deletable[] = [];
  const keep = <M extends Deletable>(mat: M): M => { owned.push(mat); return mat; };
  try { return await fn(keep); }
  finally {
    for (let i = owned.length - 1; i >= 0; i--) {
      try { owned[i]!.delete(); }
      catch { /* Already deleted or invalid; the remaining Mats must still be released. */ }
    }
  }
}

/** Zero-copy Uint8Array → Buffer view (sharp only accepts Buffers; frames are ~14 MB). */
export function asBuffer(bytes: Uint8Array): Buffer {
  if (Buffer.isBuffer(bytes)) return bytes;
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Downscale factor: an integer 1..8 (non-finite → 1). */
export function clampShrink(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(8, Math.max(1, Math.floor(value)));
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MATCH_THRESHOLD;
  return Math.min(1, Math.max(0, value));
}

function dimension(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1 || value > 16_384) throw new AppError('INVALID_ARGUMENT', `${label}无效：${value}`);
  return value;
}

/**
 * Grayscale plus integer point-sampled downscale in one pass: (r*77 + g*151 + b*28) >> 8 (BT.601).
 *
 * ★ Point sampling is deliberate, not a shortcut. With cubic-resized templates, the worst crop phase scores 0.92
 * with a point-sampled frame, but only 0.81 (a miss) with 2×2 averaging, which is also 5× slower. We need the
 * floor, not the peak. Do not change this kernel. 2560×1440 → 1280×720 takes about 2 ms.
 */
export function grayShrink(px: Uint8Array, width: number, height: number, factor: number): { data: Uint8Array; w: number; h: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new AppError('CAPTURE_BAD_FRAME', `帧尺寸非法：${width}x${height}`);
  }
  const shrink = clampShrink(factor);
  const need = width * height * 4;
  if (px.length < need) {
    throw new AppError('CAPTURE_BAD_FRAME', `像素数据长度不足：期望 ${need} 字节（${width}x${height}x4），实得 ${px.length} 字节`,
      { width, height, expected: need, actual: px.length });
  }
  const w = Math.floor(width / shrink);
  const h = Math.floor(height / shrink);
  if (w < 1 || h < 1) throw new AppError('INVALID_ARGUMENT', `降采样倍率 ${shrink} 对 ${width}x${height} 的帧过大`);
  const out = new Uint8Array(w * h);
  const rowStride = width * 4;
  const colStride = shrink * 4;
  let o = 0;
  for (let y = 0; y < h; y++) {
    let i = y * shrink * rowStride;
    for (let x = 0; x < w; x++) {
      out[o++] = (px[i]! * 77 + px[i + 1]! * 151 + px[i + 2]! * 28) >> 8;
      i += colStride;
    }
  }
  return { data: out, w, h };
}

/** Grayscale standard deviation (the variance guard and the template page's quality hint). */
export function stdDev(gray: Uint8Array): number {
  const n = gray.length;
  if (n === 0) return 0;
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const v = gray[i]!;
    sum += v;
    sumSq += v * v;
  }
  const mean = sum / n;
  return Math.sqrt(Math.max(0, sumSq / n - mean * mean));
}

/** Standard deviation over the pixels where `mask` is non-zero (transparent-background templates). */
export function stdDevMasked(gray: Uint8Array, mask: Uint8Array): number {
  const n = Math.min(gray.length, mask.length);
  let sum = 0;
  let sumSq = 0;
  let k = 0;
  for (let i = 0; i < n; i++) {
    if (mask[i] === 0) continue;
    const v = gray[i]!;
    sum += v;
    sumSq += v * v;
    k++;
  }
  if (k === 0) return 0;
  const mean = sum / k;
  return Math.sqrt(Math.max(0, sumSq / k - mean * mean));
}

/**
 * Prepare a frame once, then feed it to every template of the tick.
 * Fast path when the device size equals the reference size; otherwise a sharp cubic resize (about 64 ms at 1440p;
 * a 960×540 AVD always takes this path).
 */
export async function prepareFrame(
  raw: RawFrame,
  options: { refWidth: number; refHeight: number; shrink?: number } | { refW: number; refH: number; shrink?: number },
): Promise<PreparedFrame> {
  const refWidth = dimension('refWidth' in options ? options.refWidth : options.refW, '参考宽度');
  const refHeight = dimension('refHeight' in options ? options.refHeight : options.refH, '参考高度');
  const shrink = clampShrink(options.shrink ?? DEFAULT_SHRINK);
  const width = raw.width;
  const height = raw.height;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || width > 16_384 || height > 16_384) {
    throw new AppError('CAPTURE_BAD_FRAME', `截图尺寸非法：${width}x${height}`, { format: raw.format });
  }
  // Do not trust the screencap header's format: derive bytes per pixel from the length (RGBA/RGBX_8888 only).
  if (width * height > MAX_FRAME_PIXELS || raw.data.byteLength !== width * height * 4) {
    throw new AppError('CAPTURE_BAD_FRAME',
      `截图数据长度 ${raw.data.byteLength} 字节与 ${width}x${height}x4 = ${width * height * 4} 不符（format=${raw.format ?? '未知'}），` +
      '本引擎只支持 4 字节/像素的 RGBA_8888 / RGBX_8888 裸帧。',
      { width, height, format: raw.format, byteLength: raw.data.byteLength });
  }
  let gray: Uint8Array;
  let w: number;
  let h: number;
  if (width === refWidth && height === refHeight) {
    ({ data: gray, w, h } = grayShrink(raw.data, width, height, shrink));
  } else {
    w = Math.max(1, Math.floor(refWidth / shrink));
    h = Math.max(1, Math.floor(refHeight / shrink));
    // ★ sharp silently promotes a resized raw buffer to 3 channels: force one channel back and check it again.
    const { data, info } = await sharp(asBuffer(raw.data), { raw: { width, height, channels: 4 } })
      .resize(w, h, { kernel: 'cubic', fit: 'fill' })
      .greyscale().toColourspace('b-w').raw().toBuffer({ resolveWithObject: true });
    if (info.channels !== 1 || data.byteLength !== w * h) {
      throw new AppError('CAPTURE_BAD_FRAME',
        `帧缩放输出异常：期望 ${w}x${h} 单通道共 ${w * h} 字节，实得 ${info.width}x${info.height} ${info.channels} 通道共 ${data.byteLength} 字节`);
    }
    gray = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return {
    gray, width: w, height: h, w, h, shrink, refWidth, refHeight,
    deviceWidth: width, deviceHeight: height, capturedAt: raw.capturedAt,
  };
}

/** Compile options (the original panel's form; tplkit and the AI harvest use it directly). */
export interface PrepareTemplateOptions {
  id: string;
  /** Display name, used only in error messages. */
  name: string;
  /** Reference canvas width; the template is normalized to it. */
  refW: number;
  /** Reference canvas height; when given, a template taller than it is rejected. */
  refH?: number;
  /** Width of the frame the template was cut from (not the template's own width). Missing or 0 means k = 1. */
  authoredWidth?: number;
  shrink?: number;
  threshold?: number;
  defaultRoi?: Rect;
}

const cache = new Map<string, PreparedTemplate>();

/**
 * Compile a PNG into a template ready for matching. Accepts either a manifest definition plus its set, or the
 * original option object.
 *
 * ★ Normalization: k = refW / authoredWidth, so a template cut on a 1920-wide frame matches a 2560 frame (0.62 →
 *   1.0000 in the original panel's measurement). Alpha PNGs become a mask (alpha < 128 is ignored).
 * ★ Compiled results are cached by content fingerprint (templates are compiled once, gather rule 10). `threshold`
 *   and `defaultRoi` always come from the current call, so a ROI cleared in the panel never comes back.
 *   The returned pixel buffers are shared with the cache: never mutate or transfer them.
 *
 * @throws AppError TEMPLATE_LOW_VARIANCE (std < 12, or a mask that is too sparse or fully transparent),
 *   TEMPLATE_TOO_LARGE, TEMPLATE_DECODE_FAILED, INVALID_ARGUMENT (fewer than 3 px per edge after shrinking)
 */
export function prepareTemplate(image: Uint8Array, definition: TemplateDefinition, set: TemplateSet, shrink?: number): Promise<PreparedTemplate>;
export function prepareTemplate(image: Uint8Array, options: PrepareTemplateOptions): Promise<PreparedTemplate>;
export function prepareTemplate(
  image: Uint8Array, source: TemplateDefinition | PrepareTemplateOptions, set?: TemplateSet, shrink?: number,
): Promise<PreparedTemplate> {
  if ('refW' in source) return compileTemplate(image, source);
  if (!set) throw new AppError('INVALID_ARGUMENT', `模板「${source.name}」缺少所属模板集`);
  return compileTemplate(image, {
    id: source.id, name: source.name, refW: set.refWidth, refH: set.refHeight, authoredWidth: source.authoredWidth,
    shrink: shrink ?? DEFAULT_SHRINK, threshold: source.threshold, defaultRoi: source.defaultRoi,
  });
}

async function compileTemplate(png: Uint8Array, opts: PrepareTemplateOptions): Promise<PreparedTemplate> {
  const shrink = clampShrink(opts.shrink ?? DEFAULT_SHRINK);
  const threshold = clamp01(opts.threshold ?? DEFAULT_MATCH_THRESHOLD);
  const refLimitW = dimension(opts.refW, '参考宽度');
  const refLimitH = opts.refH === undefined ? undefined : dimension(opts.refH, '参考高度');
  const key = `${opts.id}|${refLimitW}|${refLimitH ?? 0}|${opts.authoredWidth ?? 0}|${shrink}|${png.byteLength}|${fingerprint(png)}`;
  const hit = cache.get(key);
  if (hit) return { ...hit, name: opts.name, threshold, defaultRoi: opts.defaultRoi };

  const buf = asBuffer(png);
  let w0: number;
  let h0: number;
  let hasAlpha: boolean;
  try {
    const meta = await sharp(buf).metadata();
    if (!meta.width || !meta.height) throw new AppError('TEMPLATE_DECODE_FAILED', `模板「${opts.name}」的图片缺少宽高信息`);
    w0 = meta.width;
    h0 = meta.height;
    hasAlpha = Boolean(meta.hasAlpha);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('TEMPLATE_DECODE_FAILED', `模板「${opts.name}」图片解码失败：${error instanceof Error ? error.message : String(error)}`,
      { templateId: opts.id });
  }

  const k = opts.authoredWidth && opts.authoredWidth > 0 && opts.authoredWidth !== refLimitW ? refLimitW / opts.authoredWidth : 1;
  const refW = Math.max(1, Math.round(w0 * k));
  const refH = Math.max(1, Math.round(h0 * k));
  if (refW > refLimitW || (refLimitH !== undefined && refH > refLimitH)) {
    throw new AppError('TEMPLATE_TOO_LARGE',
      `模板「${opts.name}」归一化后 ${refW}x${refH} 超过参考分辨率 ${refLimitW}x${refLimitH ?? '?'}，无法匹配`,
      { templateId: opts.id, refW, refH, limit: refLimitW });
  }
  const tw = Math.max(1, Math.round(refW / shrink));
  const th = Math.max(1, Math.round(refH / shrink));
  if (tw < MIN_PREPARED_EDGE || th < MIN_PREPARED_EDGE) {
    throw new AppError('INVALID_ARGUMENT',
      `模板「${opts.name}」降采样后只剩 ${tw}x${th} 像素，太小无法可靠匹配。请截取更大的区域，或把降采样倍率调小。`,
      { templateId: opts.id, tw, th, shrink });
  }

  // ★ Resize before greyscale (a resized 1-channel raw buffer silently becomes 3 channels). Cubic, not point
  //   sampling: a point-sampled template is a phase lottery (1.0000 or 0.75 depending on the crop's odd/even
  //   origin); cubic keeps all four phases at 0.92–0.96. Alpha goes through its own mask pipeline below.
  let pipeline = sharp(buf).removeAlpha();
  if (tw !== w0 || th !== h0) pipeline = pipeline.resize(tw, th, { kernel: 'cubic', fit: 'fill' });
  let data: Buffer;
  let info: OutputInfo;
  try {
    ({ data, info } = await pipeline.greyscale().toColourspace('b-w').raw().toBuffer({ resolveWithObject: true }));
  } catch (error) {
    throw new AppError('TEMPLATE_DECODE_FAILED', `模板「${opts.name}」图片解码失败：${error instanceof Error ? error.message : String(error)}`,
      { templateId: opts.id });
  }
  if (info.channels !== 1 || data.byteLength !== tw * th) {
    throw new AppError('TEMPLATE_DECODE_FAILED',
      `模板「${opts.name}」灰度化输出异常：期望 ${tw}x${th} 单通道共 ${tw * th} 字节，实得 ${info.width}x${info.height} ${info.channels} 通道共 ${data.byteLength} 字节`,
      { templateId: opts.id });
  }
  const gray = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const masked = hasAlpha ? await buildMask(buf, opts, tw, th, w0, h0) : null;
  const std = masked ? stdDevMasked(gray, masked.mask) : stdDev(gray);

  // ★★★ The most important check in this module: see MIN_TEMPLATE_STD. Without it a script clicks wildly at wrong
  //   places while every log line says 「命中」.
  if (std < MIN_TEMPLATE_STD) {
    throw new AppError('TEMPLATE_LOW_VARIANCE',
      `模板「${opts.name}」方差过低 std=${std.toFixed(1)} < ${MIN_TEMPLATE_STD}：` +
      'TM_CCOEFF_NORMED 会对它恒定给出高分导致必然误匹配，请改选纹理更丰富的区域',
      { templateId: opts.id, std, min: MIN_TEMPLATE_STD });
  }
  const prepared: PreparedTemplate = {
    id: opts.id, name: opts.name, gray, width: tw, height: th, w: tw, h: th,
    refWidth: refW, refHeight: refH, refW, refH, shrink, std, threshold, defaultRoi: opts.defaultRoi,
    ...(masked ? { mask: masked.mask, maskCoverage: masked.coverage } : {}),
  };
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, prepared);
  return prepared;
}

/** Drop every compiled template (for example after changing the reference size, or under memory pressure). */
export function clearTemplateCache(): void {
  cache.clear();
}

/** Number of cached compiled templates (diagnostics). */
export function templateCacheSize(): number {
  return cache.size;
}

/**
 * The alpha channel as a mask in the shrunk space: the same cubic resize as the gray pipeline, binarized at 128.
 * Fully opaque → null (a plain template); too sparse or fully transparent → TEMPLATE_LOW_VARIANCE.
 */
async function buildMask(buf: Buffer, opts: PrepareTemplateOptions, tw: number, th: number, w0: number, h0: number):
  Promise<{ mask: Uint8Array; coverage: number } | null> {
  let pipeline = sharp(buf).ensureAlpha().extractChannel('alpha');
  if (tw !== w0 || th !== h0) pipeline = pipeline.resize(tw, th, { kernel: 'cubic', fit: 'fill' });
  const { data, info } = await pipeline.toColourspace('b-w').raw().toBuffer({ resolveWithObject: true });
  if (info.channels !== 1 || data.byteLength !== tw * th) {
    throw new AppError('TEMPLATE_DECODE_FAILED',
      `模板「${opts.name}」α 通道输出异常：期望 ${tw}x${th} 单通道共 ${tw * th} 字节，实得 ${info.width}x${info.height} ${info.channels} 通道共 ${data.byteLength} 字节`,
      { templateId: opts.id });
  }
  const mask = new Uint8Array(tw * th);
  let opaque = 0;
  for (let i = 0; i < mask.length; i++) {
    if (data[i]! >= 128) { mask[i] = 255; opaque++; }
  }
  if (opaque === mask.length) return null;
  const coverage = opaque / mask.length;
  if (opaque < MIN_MASK_PIXELS || coverage < MIN_MASK_COVERAGE) {
    throw new AppError('TEMPLATE_LOW_VARIANCE',
      `模板「${opts.name}」透明底抠得太狠：降采样后只剩 ${opaque} 个不透明像素` +
      `（${(coverage * 100).toFixed(0)}%），低于下限 ${MIN_MASK_PIXELS} 个 / ${MIN_MASK_COVERAGE * 100}%。` +
      '请放宽差分容差、多截一帧背景差异更大的画面，或改框图标里不透明的那部分。',
      { templateId: opts.id, opaque, coverage, minPixels: MIN_MASK_PIXELS, minCoverage: MIN_MASK_COVERAGE });
  }
  return { mask, coverage: Math.round(coverage * 1000) / 1000 };
}

/** FNV-1a 32-bit over the whole PNG (templates are a few KB). */
function fingerprint(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

interface PixelRect { x: number; y: number; w: number; h: number }

/** Reference-space ROI → integer rect in the shrunk space, rounded outward and clamped to the frame. */
function toPixelRect(frame: PreparedFrame, roi?: Rect): PixelRect | null {
  if (!roi) return { x: 0, y: 0, w: frame.w, h: frame.h };
  if (![roi.x, roi.y, roi.w, roi.h].every(Number.isFinite)) return null;
  const s = frame.shrink;
  const x0 = Math.max(0, Math.min(frame.w, Math.floor(roi.x / s)));
  const y0 = Math.max(0, Math.min(frame.h, Math.floor(roi.y / s)));
  const x1 = Math.max(0, Math.min(frame.w, Math.ceil((roi.x + roi.w) / s)));
  const y1 = Math.max(0, Math.min(frame.h, Math.ceil((roi.y + roi.h) / s)));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Copy only the ROI rows into the WASM heap view (not the whole frame, then .roi()). */
function copyRegion(frame: PreparedFrame, r: PixelRect, dst: Uint8Array): void {
  if (r.x === 0 && r.w === frame.w) {
    dst.set(frame.gray.subarray(r.y * frame.w, (r.y + r.h) * frame.w));
    return;
  }
  for (let row = 0; row < r.h; row++) {
    const from = (r.y + row) * frame.w + r.x;
    dst.set(frame.gray.subarray(from, from + r.w), row * r.w);
  }
}

function describeRoi(roi?: Rect): string {
  return roi ? `（搜索区 ${roi.x},${roi.y} ${roi.w}x${roi.h}，若目标不在此区内请检查 ROI）` : '';
}

function elapsed(started: number): number {
  return Math.round((performance.now() - started) * 100) / 100;
}

function miss(tpl: PreparedTemplate, threshold: number, started: number, score: number, reason: string): MatchResult {
  return {
    templateId: tpl.id, found: false, score, x: -1, y: -1, w: tpl.refW, h: tpl.refH,
    centerX: -1, centerY: -1, threshold, elapsedMs: elapsed(started), reason,
  };
}

/**
 * Find one template in a prepared frame. ★ TM_CCOEFF_NORMED only (TM_CCORR / TM_SQDIFF score unrelated frames at
 * 0.97–0.99). The ROI (reference space) is the cheapest speed-up: full frame 18 ms → one button 1 ms.
 * Hits are quantized to the shrink factor (±shrink px). A ROI outside the frame or smaller than the template is a
 * miss with a reason, never an exception.
 */
export async function matchTemplate(frame: PreparedFrame, tpl: PreparedTemplate, options: MatchOptions = {}): Promise<MatchResult> {
  const started = performance.now();
  const threshold = clamp01(options.threshold ?? tpl.threshold ?? DEFAULT_MATCH_THRESHOLD);
  if (tpl.shrink !== frame.shrink) {
    throw new AppError('INVALID_ARGUMENT',
      `模板「${tpl.name}」是按 shrink=${tpl.shrink} 编译的，与当前帧的 shrink=${frame.shrink} 不一致，` +
      '请用相同的降采样倍率重新编译模板（loadPrepared 的 shrink）。',
      { templateId: tpl.id, templateShrink: tpl.shrink, frameShrink: frame.shrink });
  }
  if (frame.gray.length !== frame.w * frame.h) {
    throw new AppError('INVALID_ARGUMENT', `帧像素长度 ${frame.gray.length} 与声明尺寸 ${frame.w}x${frame.h} 不符`);
  }
  if (tpl.gray.length !== tpl.w * tpl.h) {
    throw new AppError('INVALID_ARGUMENT', `模板「${tpl.name}」像素长度 ${tpl.gray.length} 与声明尺寸 ${tpl.w}x${tpl.h} 不符`,
      { templateId: tpl.id });
  }
  if (tpl.mask && tpl.mask.length !== tpl.w * tpl.h) {
    throw new AppError('INVALID_ARGUMENT', `模板「${tpl.name}」透明底掩码长度 ${tpl.mask.length} 与声明尺寸 ${tpl.w}x${tpl.h} 不符`,
      { templateId: tpl.id });
  }
  const roiRef = options.roi ?? tpl.defaultRoi;
  const region = toPixelRect(frame, roiRef);
  if (!region) return miss(tpl, threshold, started, 0, 'ROI 坐标无效（不是有限数字）');
  if (region.w <= 0 || region.h <= 0) return miss(tpl, threshold, started, 0, 'ROI 超出画面范围');
  if (region.w < tpl.w || region.h < tpl.h) {
    return miss(tpl, threshold, started, 0,
      `ROI 小于模板（搜索区 ${region.w * frame.shrink}x${region.h * frame.shrink}，模板 ${tpl.refW}x${tpl.refH}，均为参考分辨率坐标）`);
  }
  const cv = await getCv();
  const { score, locX, locY } = await withMats((keep) => {
    const src = keep(new cv.Mat(region.h, region.w, cv.CV_8UC1));
    copyRegion(frame, region, src.data as Uint8Array);
    const needle = keep(new cv.Mat(tpl.h, tpl.w, cv.CV_8UC1));
    (needle.data as Uint8Array).set(tpl.gray);
    const dst = keep(new cv.Mat());
    if (tpl.mask) {
      const mask = keep(new cv.Mat(tpl.h, tpl.w, cv.CV_8UC1));
      (mask.data as Uint8Array).set(tpl.mask);
      cv.matchTemplate(src, needle, dst, cv.TM_CCOEFF_NORMED, mask);
      // ★ A window that is flat inside the mask yields NaN/±Inf (zero denominator) and would win minMaxLoc over
      //   the real hit. Non-finite and clearly >1 values become 0; float noise just above 1 is clamped to 1.
      const values = dst.data32F as Float32Array;
      for (let i = 0; i < values.length; i++) {
        const v = values[i]!;
        if (!Number.isFinite(v) || v > 1.01) values[i] = 0;
        else if (v > 1) values[i] = 1;
      }
    } else {
      cv.matchTemplate(src, needle, dst, cv.TM_CCOEFF_NORMED);
    }
    const peak = cv.minMaxLoc(dst) as { maxVal: number; maxLoc: { x: number; y: number } };
    return { score: peak.maxVal, locX: peak.maxLoc.x, locY: peak.maxLoc.y };
  });
  if (!Number.isFinite(score)) {
    return miss(tpl, threshold, started, 0, '匹配得分非有限值：搜索区域可能是纯色，无法用相关系数判别');
  }
  const rounded = Math.round(Math.min(1, score) * 10_000) / 10_000;
  if (rounded < threshold) {
    return miss(tpl, threshold, started, rounded, `最高分 ${rounded.toFixed(4)} 低于阈值 ${threshold}` + describeRoi(roiRef));
  }
  const x = (region.x + locX) * frame.shrink;
  const y = (region.y + locY) * frame.shrink;
  return {
    templateId: tpl.id, found: true, score: rounded, x, y, w: tpl.refW, h: tpl.refH,
    centerX: Math.round(x + tpl.refW / 2), centerY: Math.round(y + tpl.refH / 2),
    threshold, elapsedMs: elapsed(started),
  };
}

/** The original panel's name for `matchTemplate`, used by the migrated game flow. */
export const matchIn = matchTemplate;

function notFound(spec: DetectSpec, started: number, reason: string): MatchResult {
  return {
    templateId: spec.templateId, found: false, score: 0, x: -1, y: -1, w: 0, h: 0, centerX: -1, centerY: -1,
    threshold: clamp01(spec.threshold ?? DEFAULT_MATCH_THRESHOLD), elapsedMs: elapsed(started), reason,
  };
}

/**
 * Match several templates on one prepared frame. Results keep the order of `specs`; a lookup failure, an unknown
 * id or a throwing match becomes `found: false` with the reason, so one bad template never fails the whole tick.
 */
export async function detect(
  frame: PreparedFrame, specs: readonly DetectSpec[], resolve: (id: string) => PreparedTemplate | undefined,
): Promise<MatchResult[]> {
  const out: MatchResult[] = [];
  for (const spec of specs) {
    const started = performance.now();
    let tpl: PreparedTemplate | undefined;
    try { tpl = resolve(spec.templateId); }
    catch (error) {
      out.push(notFound(spec, started, `模板「${spec.templateId}」查找失败：${error instanceof Error ? error.message : String(error)}`));
      continue;
    }
    if (!tpl) {
      out.push(notFound(spec, started, `模板「${spec.templateId}」不在已加载的模板集里`));
      continue;
    }
    try { out.push(await matchTemplate(frame, tpl, { roi: spec.roi, threshold: spec.threshold })); }
    catch (error) { out.push(notFound(spec, started, error instanceof Error ? error.message : String(error))); }
  }
  return out;
}

/** Reference coordinates → device pixels, using the frame's own reference size. Only for `input tap`. */
export function refToDevice(frame: PreparedFrame, point: Point): Point {
  return {
    x: Math.round(point.x * frame.deviceWidth / frame.refWidth),
    y: Math.round(point.y * frame.deviceHeight / frame.refHeight),
  };
}

/** The original panel's signature of `refToDevice`. */
export function toDevice(frame: PreparedFrame, x: number, y: number): Point {
  return refToDevice(frame, { x, y });
}

/** Default OpenCV/sharp implementation. Tests and future engines can supply another VisionPort. */
export const defaultVision: VisionPort = {
  prepareFrame,
  prepareTemplate: (image, definition, set, shrink) => prepareTemplate(image, definition, set, shrink),
  match: matchTemplate,
};
