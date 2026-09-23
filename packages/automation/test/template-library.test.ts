import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { TemplateLibrary } from '../src/template-library.js';

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function fixture(flat = false): Promise<Uint8Array> {
  const pixels = Buffer.alloc(64 * 64 * 4);
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 64; x++) {
      const offset = (y * 64 + x) * 4;
      const value = flat ? 180 : ((Math.floor(x / 4) + Math.floor(y / 4)) % 2 ? 220 : 35);
      pixels[offset] = value;
      pixels[offset + 1] = value;
      pixels[offset + 2] = value;
      pixels[offset + 3] = 255;
    }
  }
  return sharp(pixels, { raw: { width: 64, height: 64, channels: 4 } }).png().toBuffer();
}

describe('TemplateLibrary', () => {
  it('creates a private set and atomically publishes only validated templates', async () => {
    const home = await mkdtemp(join(tmpdir(), 'avdm-template-library-'));
    homes.push(home);
    const library = new TemplateLibrary(home);
    const set = await library.createSet('wanlong', '游戏主界面', 'com.example.game', 256, 256);
    expect((await library.managedSets('wanlong')).map((item) => item.id)).toEqual([set.id]);

    const input = { id: 'tpl_button', name: '按钮', image: await fixture(),
      authoredWidth: 64, authoredHeight: 64, crop: { x: 8, y: 8, w: 24, h: 24 } };
    const saved = await library.save(set.directory, input);
    expect(saved.std).toBeGreaterThan(12);
    expect(saved.definition.bounds).toEqual({ x: 32, y: 32, w: 96, h: 96 });
    expect(saved.definition.defaultRoi).toEqual({ x: 0, y: 0, w: 208, h: 208 });
    expect((await library.image(set.directory, 'tpl_button')).byteLength).toBeGreaterThan(50);
    const file = join(set.directory, saved.definition.file);
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);

    await expect(library.save(set.directory, { ...input, image: await fixture(true) }))
      .rejects.toThrow('纹理不足');
    expect((await library.load(set.directory)).templates[0]?.file).toBe(saved.definition.file);
    await expect(library.save(set.directory, { ...input, crop: { x: 60, y: 60, w: 24, h: 24 } }))
      .rejects.toThrow('裁剪区域');

    const updated = await library.save(set.directory, { ...input, name: '新按钮' });
    expect(updated.definition.file).not.toBe(saved.definition.file);
    expect((await library.load(set.directory)).templates).toMatchObject([{ id: 'tpl_button', name: '新按钮' }]);
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
    await library.delete(set.directory, 'tpl_button');
    expect((await library.load(set.directory)).templates).toEqual([]);
  });
});
