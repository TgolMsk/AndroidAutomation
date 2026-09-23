import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { buildTemplateAlpha } from '../src/template-alpha';

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

describe('template alpha difference', () => {
  it('masks moving pixels while retaining stable background', async () => {
    const preview = await buildTemplateAlpha([await frame(false), await frame(true)], { x: 3, y: 3, w: 14, h: 14 }, 12);
    expect(preview.coverage).toBeGreaterThan(0.5);
    expect(preview.coverage).toBeLessThan(0.8);
    const mask = await sharp(preview.alphaPng).greyscale().toColourspace('b-w').raw().toBuffer({ resolveWithObject: true });
    expect(mask.info.width).toBe(14);
    expect(mask.data[7 * 14 + 7]).toBe(0);
    expect(mask.data[0]).toBe(255);
  });
});
