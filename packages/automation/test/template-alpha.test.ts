import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { applyAlpha, buildDiffAlpha, buildTemplateAlpha, renderAlphaPreview } from '../src/template-alpha.js';

function frame(changing: boolean): Promise<Buffer> {
  const pixels = Buffer.alloc(20 * 20 * 3, 80);
  for (let y = 6; y < 14; y++) {
    for (let x = 6; x < 14; x++) {
      const i = (y * 20 + x) * 3;
      pixels[i] = changing ? 180 : 80;
    }
  }
  return sharp(pixels, { raw: { width: 20, height: 20, channels: 3 } }).png().toBuffer();
}

/** vision-offline-check fixture: a textured 12×12 foreground on a background that changes everywhere. */
const W = 24;
const H = 20;
function textured(seed: number): Promise<Buffer> {
  const pixels = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const foreground = x >= 6 && x < 18 && y >= 4 && y < 16;
      pixels.fill(foreground ? 30 + ((x * 31 + y * 53) % 200) : seed, (y * W + x) * 3, (y * W + x + 1) * 3);
    }
  }
  return sharp(pixels, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
}

describe('multi-frame diff alpha', () => {
  it('keeps exactly the unchanged foreground with tolerance 0 and no smoothing (144 / 480)', async () => {
    const diff = await buildDiffAlpha([await textured(5), await textured(240)], { x: 0, y: 0, w: W, h: H }, { tolerance: 0, smooth: false });
    expect(diff.coverage).toBe(144 / 480);
    expect([diff.width, diff.height]).toEqual([W, H]);
  });

  it('applies the fixed ≥5-of-9 majority filter, which also erodes crop edges', async () => {
    const preview = await buildTemplateAlpha([await frame(false), await frame(true)], { x: 3, y: 3, w: 14, h: 14 }, 12);
    const mask = await sharp(preview.alphaPng).greyscale().toColourspace('b-w').raw().toBuffer({ resolveWithObject: true });
    expect(mask.info.width).toBe(14);
    expect(mask.data[7 * 14 + 7]).toBe(0); // the changing square
    expect(mask.data[1 * 14 + 1]).toBe(255); // stable interior
    expect(mask.data[0]).toBe(0); // a corner has only 4 neighbours, so it can never reach 5
    expect(mask.data[1]).toBe(255); // an edge pixel with 6 stable neighbours survives
    expect(preview.coverage).toBeGreaterThan(0.5);
    expect(preview.coverage).toBeLessThan(0.8);
  });

  it('rounds and clamps the tolerance instead of throwing, and rejects mismatched frame sizes', async () => {
    const a = await textured(5);
    const b = await textured(240);
    const clamped = await buildDiffAlpha([a, b], { x: 0, y: 0, w: W, h: H }, { tolerance: 999, smooth: false });
    expect(clamped.coverage).toBe(1);
    const other = await sharp({ create: { width: 30, height: 20, channels: 3, background: '#123456' } }).png().toBuffer();
    await expect(buildDiffAlpha([a, other], { x: 0, y: 0, w: 10, h: 10 })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT', message: expect.stringContaining('第 2 帧尺寸 30x20'),
    });
    await expect(buildDiffAlpha([a], { x: 0, y: 0, w: 10, h: 10 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(buildDiffAlpha([a, b], { x: 20, y: 0, w: 10, h: 10 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('merges the alpha into the template and renders a magenta preview at the requested width', async () => {
    const first = await textured(5);
    const diff = await buildDiffAlpha([first, await textured(240)], { x: 0, y: 0, w: W, h: H }, { tolerance: 0, smooth: false });
    const rgba = await applyAlpha(first, diff.alphaPng);
    const meta = await sharp(rgba).metadata();
    expect(meta.channels).toBe(4);
    expect(meta.hasAlpha).toBe(true);
    await expect(applyAlpha(first, await sharp(Buffer.alloc(9, 255), { raw: { width: 3, height: 3, channels: 1 } }).png().toBuffer()))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    // A grayscale base is replicated to RGB.
    const gray = await sharp(first).greyscale().png().toBuffer();
    expect((await sharp(await applyAlpha(gray, diff.alphaPng)).metadata()).channels).toBe(4);

    const preview = await renderAlphaPreview([first, await textured(240)], { x: 0, y: 0, w: W, h: H }, { tolerance: 0, previewWidth: 60 });
    expect((await sharp(preview.previewPng).metadata()).width).toBe(60);
    const tiny = await renderAlphaPreview([first, await textured(240)], { x: 0, y: 0, w: 3, h: 3 }, { previewWidth: 360 });
    expect((await sharp(tiny.previewPng).metadata()).width).toBe(16); // 4× the crop is 12, but never below 16
  });
});
