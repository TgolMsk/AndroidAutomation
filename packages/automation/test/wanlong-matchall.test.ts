import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { applyAlpha, buildDiffAlpha } from '../src/template-alpha.js';
import { prepareTemplate } from '../src/vision.js';
import { matchAllInCrop } from '../src/wanlong/vision/matchAll.js';

/** Port of scripts/vision-offline-check.ts (masked repeated glyphs, negatives, malformed / sparse masks). */
const w = 24;
const h = 20;
function background(seed: number): Buffer {
  const pixels = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const foreground = x >= 6 && x < 18 && y >= 4 && y < 16;
      pixels.fill(foreground ? 30 + ((x * 31 + y * 53) % 200) : seed, (y * w + x) * 3, (y * w + x + 1) * 3);
    }
  }
  return pixels;
}
const makePng = (data: Buffer) => sharp(data, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();

describe('masked templates and matchAllInCrop (vision offline check)', () => {
  it('finds a masked glyph twice, nothing on a flat crop, and rejects malformed or sparse masks', async () => {
    const [first, second] = await Promise.all([makePng(background(5)), makePng(background(240))]);
    const diff = await buildDiffAlpha([first, second], { x: 0, y: 0, w, h }, { tolerance: 0, smooth: false });
    expect(diff.coverage).toBe(144 / 480);
    const templ = await prepareTemplate(await applyAlpha(first, diff.alphaPng), { id: 'offline-mask', name: 'offline mask', refW: 2560, shrink: 1 });
    expect(templ.mask).toBeDefined();

    const cw = 90;
    const ch = 44;
    const crop = { x: 100, y: 200, w: cw, h: ch, gray: new Uint8Array(cw * ch).fill(210) };
    const spots = [{ x: 3, y: 8 }, { x: 53, y: 12 }];
    for (const p of spots) {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const idx = y * w + x;
          if (templ.mask![idx]) crop.gray[(p.y + y) * cw + p.x + x] = templ.gray[idx]!;
        }
      }
    }
    const peaks = await matchAllInCrop(crop, templ, { minScore: 0.98 });
    expect(peaks).toHaveLength(2);
    for (const p of spots) expect(peaks.some((hit) => hit.x === p.x + 100 && hit.y === p.y + 200)).toBe(true);
    expect(await matchAllInCrop({ ...crop, gray: new Uint8Array(cw * ch).fill(120) }, templ)).toHaveLength(0);
    await expect(matchAllInCrop(crop, { ...templ, mask: new Uint8Array(1) })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(matchAllInCrop(crop, { ...templ, mask: new Uint8Array(w * h) })).rejects.toMatchObject({ code: 'TEMPLATE_LOW_VARIANCE' });

    const sparse = Buffer.alloc(w * h);
    sparse[10] = 255;
    const sparsePng = await sharp(sparse, { raw: { width: w, height: h, channels: 1 } }).png().toBuffer();
    await expect(prepareTemplate(await applyAlpha(first, sparsePng), { id: 'sparse', name: 'sparse', refW: 2560 }))
      .rejects.toMatchObject({ code: 'TEMPLATE_LOW_VARIANCE' });

    const opaque = await prepareTemplate(second, { id: 'opaque', name: 'opaque', refW: 2560, shrink: 1 });
    const exact = await matchAllInCrop({ x: 0, y: 0, w, h, gray: opaque.gray }, opaque);
    expect(exact).toHaveLength(1);
    expect(exact[0]!.score).toBeGreaterThan(0.99);
  });
});
