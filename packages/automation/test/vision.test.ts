import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PreparedTemplate, RawFrame, Rect } from '../src/contracts.js';
import {
  clearTemplateCache, detect, grayShrink, isCvReady, matchTemplate, prepareFrame, prepareTemplate, stdDev, stdDevMasked,
  templateCacheSize, toDevice, withMats,
} from '../src/vision.js';
import { MIN_TEMPLATE_STD } from '../src/constants.js';

/** Smooth, non-repeating texture (cubic templates and point-sampled frames agree on it). */
function smooth(x: number, y: number): [number, number, number] {
  const v = 128 + 60 * Math.sin(x / 7) * Math.cos(y / 9) + 50 * Math.sin((x + 2 * y) / 13);
  const u = 128 + 70 * Math.cos(x / 11 + y / 5);
  return [Math.round(v), Math.round(u), Math.round((v + u) / 2)];
}

function lcg(seed: number): (x: number, y: number) => [number, number, number] {
  let value = seed;
  return () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff];
  };
}

function rawFrame(width: number, height: number, pixel: (x: number, y: number) => [number, number, number], capturedAt = 1): RawFrame {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      const i = (y * width + x) * 4;
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
    }
  }
  return { width, height, data, capturedAt };
}

async function crop(frame: RawFrame, rect: Rect): Promise<Buffer> {
  return sharp(Buffer.from(frame.data), { raw: { width: frame.width, height: frame.height, channels: 4 } })
    .extract({ left: rect.x, top: rect.y, width: rect.w, height: rect.h }).removeAlpha().png().toBuffer();
}

async function flatPng(width: number, height: number, value = 180): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: value, g: value, b: value } } }).png().toBuffer();
}

afterEach(() => clearTemplateCache());

describe('prepareTemplate', () => {
  it('normalizes a template cut on a smaller frame to the reference canvas (k = refW / authoredWidth)', async () => {
    // Blurred noise: smooth enough for cubic vs point sampling, never repeating.
    const noise = rawFrame(640, 360, lcg(11));
    const blurred = await sharp(Buffer.from(noise.data), { raw: { width: 640, height: 360, channels: 4 } }).blur(2).normalise().raw().toBuffer();
    const scene: RawFrame = { width: 640, height: 360, data: new Uint8Array(blurred), capturedAt: 1 };
    // The same scene captured at 480×270 (a smaller instance); the template is cut there.
    const small = await sharp(Buffer.from(scene.data), { raw: { width: 640, height: 360, channels: 4 } })
      .resize(480, 270, { kernel: 'cubic' }).raw().toBuffer();
    const authored: RawFrame = { width: 480, height: 270, data: new Uint8Array(small), capturedAt: 1 };
    const png = await crop(authored, { x: 120, y: 90, w: 60, h: 45 });
    const tpl = await prepareTemplate(png, { id: 'norm', name: '归一化', refW: 640, refH: 360, authoredWidth: 480, shrink: 2 });
    expect([tpl.refW, tpl.refH]).toEqual([80, 60]);
    const frame = await prepareFrame(scene, { refW: 640, refH: 360, shrink: 2 });
    const hit = await matchTemplate(frame, tpl, { threshold: 0.8 });
    expect(hit.found).toBe(true);
    expect(hit.score).toBeGreaterThan(0.9);
    expect(Math.abs(hit.x - 160)).toBeLessThanOrEqual(4);
    expect(Math.abs(hit.y - 120)).toBeLessThanOrEqual(4);
    // Without normalization (k = 1) the same template would be matched at the wrong scale.
    const raw = await prepareTemplate(png, { id: 'raw', name: '未归一化', refW: 640, shrink: 2 });
    expect(raw.refW).toBe(60);
  });

  it('rejects low-variance, oversized and too-small templates with codes', async () => {
    await expect(prepareTemplate(await flatPng(40, 40), { id: 'flat', name: '纯色', refW: 640 }))
      .rejects.toMatchObject({ code: 'TEMPLATE_LOW_VARIANCE', detail: { std: 0, min: MIN_TEMPLATE_STD } });
    const wide = await crop(rawFrame(200, 20, smooth), { x: 0, y: 0, w: 200, h: 20 });
    await expect(prepareTemplate(wide, { id: 'wide', name: '过宽', refW: 400, authoredWidth: 100 }))
      .rejects.toMatchObject({ code: 'TEMPLATE_TOO_LARGE' });
    const tiny = await crop(rawFrame(20, 20, smooth), { x: 0, y: 0, w: 4, h: 4 });
    await expect(prepareTemplate(tiny, { id: 'tiny', name: '过小', refW: 640, shrink: 2 }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringContaining('降采样后只剩') });
    await expect(prepareTemplate(Buffer.from('not a png at all'), { id: 'bad', name: '坏图', refW: 640 }))
      .rejects.toMatchObject({ code: 'TEMPLATE_DECODE_FAILED' });
  });

  it('computes the std over opaque pixels only, rejects fully transparent masks and treats full opacity as plain', async () => {
    const w = 40;
    const h = 30;
    const rgba = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const opaque = x < 20;
        const v = opaque ? 120 : (x * 37 + y * 91) % 256; // flat where it counts, textured where it is ignored
        rgba[i] = v; rgba[i + 1] = v; rgba[i + 2] = v; rgba[i + 3] = opaque ? 255 : 0;
      }
    }
    const masked = await sharp(rgba, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
    await expect(prepareTemplate(masked, { id: 'masked-flat', name: '掩码纯色', refW: 640, shrink: 1 }))
      .rejects.toMatchObject({ code: 'TEMPLATE_LOW_VARIANCE' });

    const transparent = Buffer.from(rgba);
    for (let i = 3; i < transparent.length; i += 4) transparent[i] = 0;
    await expect(prepareTemplate(await sharp(transparent, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer(),
      { id: 'clear', name: '全透明', refW: 640, shrink: 1 })).rejects.toMatchObject({ code: 'TEMPLATE_LOW_VARIANCE' });

    const opaque = Buffer.from(rgba);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const v = (x * 37 + y * 91) % 256;
        opaque[i] = v; opaque[i + 1] = v; opaque[i + 2] = v; opaque[i + 3] = 255;
      }
    }
    const plain = await prepareTemplate(await sharp(opaque, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer(),
      { id: 'opaque', name: '不透明', refW: 640, shrink: 1 });
    expect(plain.mask).toBeUndefined();
    expect(plain.maskCoverage).toBeUndefined();

    const half = Buffer.from(opaque);
    for (let y = 0; y < h; y++) for (let x = 20; x < w; x++) half[(y * w + x) * 4 + 3] = 0;
    const halfMasked = await prepareTemplate(await sharp(half, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer(),
      { id: 'half', name: '半透明', refW: 640, shrink: 1 });
    expect(halfMasked.maskCoverage).toBe(0.5);
    expect(halfMasked.std).toBeCloseTo(stdDevMasked(halfMasked.gray, halfMasked.mask!), 6);
    expect(halfMasked.std).not.toBeCloseTo(stdDev(halfMasked.gray), 3);
  });

  it('compiles once per content fingerprint but always takes threshold and ROI from the current call', async () => {
    const png = await crop(rawFrame(64, 64, smooth), { x: 4, y: 4, w: 40, h: 30 });
    const first = await prepareTemplate(png, { id: 'cached', name: '缓存', refW: 640, threshold: 0.9, defaultRoi: { x: 0, y: 0, w: 100, h: 100 } });
    expect(templateCacheSize()).toBe(1);
    const second = await prepareTemplate(png, { id: 'cached', name: '缓存', refW: 640, threshold: 0.7 });
    expect(templateCacheSize()).toBe(1);
    expect(second.gray).toBe(first.gray);
    expect(second.threshold).toBe(0.7);
    expect(second.defaultRoi).toBeUndefined(); // a ROI cleared in the panel never comes back from the cache
    const edited = await crop(rawFrame(64, 64, smooth), { x: 6, y: 4, w: 40, h: 30 });
    await prepareTemplate(edited, { id: 'cached', name: '缓存', refW: 640 });
    expect(templateCacheSize()).toBe(2);
    expect((await prepareTemplate(png, { id: 'cached', name: '缓存', refW: 640, threshold: 7 })).threshold).toBe(1);
    clearTemplateCache();
    expect(templateCacheSize()).toBe(0);
  });
});

describe('matchTemplate', () => {
  async function fixture(): Promise<{ frame: Awaited<ReturnType<typeof prepareFrame>>; tpl: PreparedTemplate }> {
    const raw = rawFrame(160, 120, lcg(7));
    const png = await crop(raw, { x: 41, y: 33, w: 17, h: 13 });
    const tpl = await prepareTemplate(png, { id: 'anchor', name: '锚点', refW: 160, refH: 120, shrink: 1, threshold: 0.9 });
    return { frame: await prepareFrame(raw, { refWidth: 160, refHeight: 120, shrink: 1 }), tpl };
  }

  it('finds an exact crop with integer centers and reports misses with Chinese reasons instead of throwing', async () => {
    const { frame, tpl } = await fixture();
    const hit = await matchTemplate(frame, tpl);
    expect(hit).toMatchObject({ found: true, x: 41, y: 33, w: 17, h: 13, centerX: 50, centerY: 40 });
    expect(Number.isInteger(hit.centerX) && Number.isInteger(hit.centerY)).toBe(true);
    expect(hit.score).toBeGreaterThan(0.95); // sharp's greyscale weights differ slightly from the frame's BT.601
    expect(isCvReady()).toBe(true);

    const outside = await matchTemplate(frame, tpl, { roi: { x: 500, y: 500, w: 50, h: 50 } });
    expect(outside).toMatchObject({ found: false, score: 0, x: -1, y: -1, centerX: -1, centerY: -1, reason: 'ROI 超出画面范围' });
    const small = await matchTemplate(frame, tpl, { roi: { x: 0, y: 0, w: 10, h: 10 } });
    expect(small.reason).toBe('ROI 小于模板（搜索区 10x10，模板 17x13，均为参考分辨率坐标）');
    const invalid = await matchTemplate(frame, tpl, { roi: { x: Number.NaN, y: 0, w: 10, h: 10 } });
    expect(invalid).toMatchObject({ found: false, score: 0 });
    const elsewhere = await matchTemplate(frame, tpl, { roi: { x: 90, y: 60, w: 60, h: 50 } });
    expect(elsewhere.found).toBe(false);
    expect(elsewhere.reason).toMatch(/^最高分 -?\d\.\d{4} 低于阈值 0\.9（搜索区 90,60 60x50，若目标不在此区内请检查 ROI）$/);
    expect(elsewhere.score).toBeLessThan(0.9);
    const clamped = await matchTemplate(frame, tpl, { threshold: 5 });
    expect(clamped.threshold).toBe(1);
  });

  it('throws on a shrink mismatch and batches detect() with per-template isolation in spec order', async () => {
    const { frame, tpl } = await fixture();
    const other = { ...tpl, id: 'other', shrink: 2 };
    await expect(matchTemplate(frame, other)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    const byId = new Map<string, PreparedTemplate>([[tpl.id, tpl], [other.id, other]]);
    const results = await detect(frame, [
      { templateId: 'missing' }, { templateId: 'anchor' }, { templateId: 'other' }, { templateId: 'throws' },
    ], (id) => {
      if (id === 'throws') throw new Error('查找炸了');
      return byId.get(id);
    });
    expect(results.map((r) => r.templateId)).toEqual(['missing', 'anchor', 'other', 'throws']);
    expect(results[0]).toMatchObject({ found: false, score: 0, reason: '模板「missing」不在已加载的模板集里' });
    expect(results[1]).toMatchObject({ found: true, x: 41, y: 33 });
    expect(results[2]!.found).toBe(false);
    expect(results[2]!.reason).toContain('shrink=2');
    expect(results[3]!.reason).toBe('模板「throws」查找失败：查找炸了');
  });

  it('cleans NaN/Inf from masked matches so a flat window never beats the real hit', async () => {
    // A flat frame with the masked template pasted once: every other window is flat inside the mask.
    const w = 30;
    const h = 24;
    const rgba = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const v = 40 + ((x * 29 + y * 47) % 180);
        rgba[i] = v; rgba[i + 1] = v; rgba[i + 2] = v; rgba[i + 3] = (x - 15) ** 2 + (y - 12) ** 2 <= 100 ? 255 : 0;
      }
    }
    const tpl = await prepareTemplate(await sharp(rgba, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer(),
      { id: 'ring', name: '圆环', refW: 200, shrink: 1, threshold: 0.95 });
    expect(tpl.mask).toBeDefined();
    const frameRaw = rawFrame(200, 120, (x, y) => {
      const tx = x - 120;
      const ty = y - 70;
      if (tx >= 0 && tx < w && ty >= 0 && ty < h && (tx - 15) ** 2 + (ty - 12) ** 2 <= 100) {
        const v = 40 + ((tx * 29 + ty * 47) % 180);
        return [v, v, v];
      }
      return [90, 90, 90];
    });
    const frame = await prepareFrame(frameRaw, { refWidth: 200, refHeight: 120, shrink: 1 });
    const hit = await matchTemplate(frame, tpl);
    expect(hit).toMatchObject({ found: true, x: 120, y: 70 });
    expect(hit.score).toBeLessThanOrEqual(1);
  });
});

describe('frames and Mat lifecycle', () => {
  it('prepares frames through the point-sampled fast path and rejects malformed data', async () => {
    const raw = rawFrame(64, 48, lcg(3));
    const fast = await prepareFrame(raw, { refW: 64, refH: 48, shrink: 2 });
    expect(fast.gray).toEqual(grayShrink(raw.data, 64, 48, 2).data);
    expect([fast.w, fast.h, fast.deviceWidth]).toEqual([32, 24, 64]);
    const slow = await prepareFrame(raw, { refWidth: 128, refHeight: 96, shrink: 2 });
    expect([slow.w, slow.h, slow.gray.length]).toEqual([64, 48, 64 * 48]);
    expect(toDevice(slow, 128, 96)).toEqual({ x: 64, y: 48 });
    await expect(prepareFrame({ ...raw, data: raw.data.subarray(4) }, { refW: 64, refH: 48 }))
      .rejects.toMatchObject({ code: 'CAPTURE_BAD_FRAME' });
  });

  it('deletes every Mat even when one delete throws, without masking the original error', async () => {
    const spy = vi.fn();
    await expect(withMats((keep) => {
      keep({ delete: spy });
      keep({ delete: () => { throw new Error('已释放'); } });
      keep({ delete: spy });
      throw new Error('原始错误');
    })).rejects.toThrow('原始错误');
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
