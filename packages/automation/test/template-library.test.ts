import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { TemplateLibrary } from '../src/template-library.js';
import { loadTemplateSet } from '../src/templates.js';

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'avdm-template-library-'));
  homes.push(home);
  return home;
}

async function checker(width = 64, height = 64, options: { flat?: boolean; changed?: boolean } = {}): Promise<Uint8Array> {
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      let value = options.flat ? 180 : ((Math.floor(x / 4) + Math.floor(y / 4)) % 2 ? 220 : 35);
      // The "changed" frame differs in the right half of the crop area only (a moving background).
      if (options.changed && x >= 20 && x < 32 && y >= 8 && y < 32) value = 255 - value;
      pixels[offset] = value;
      pixels[offset + 1] = value;
      pixels[offset + 2] = value;
      pixels[offset + 3] = 255;
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

async function manifestOf(directory: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as Record<string, any>;
}

describe('TemplateLibrary', () => {
  it('creates a private set and atomically publishes only validated templates', async () => {
    const home = await tempHome();
    const library = new TemplateLibrary(home);
    const set = await library.createSet('wanlong', '游戏主界面', 'com.example.game', 256, 256);
    expect((await library.managedSets('wanlong')).map((item) => item.id)).toEqual([set.id]);

    const input = { id: 'tpl_button', name: '按钮', image: await checker(),
      authoredWidth: 64, authoredHeight: 64, crop: { x: 8, y: 8, w: 24, h: 24 }, threshold: 0.9, note: '备注一', tags: ['ui', 'ui', ' '] };
    const saved = await library.save(set.directory, input);
    expect(saved.std).toBeGreaterThan(12);
    expect(saved.replaced).toBe(false);
    expect(saved.definition).toMatchObject({ file: 'tpl_button.png', bounds: { x: 32, y: 32, w: 96, h: 96 },
      defaultRoi: { x: 0, y: 0, w: 208, h: 208 }, threshold: 0.9, note: '备注一', tags: ['ui'] });
    expect((await library.image(set.directory, 'tpl_button')).byteLength).toBeGreaterThan(50);
    const file = join(set.directory, saved.definition.file);
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
    const created = (await manifestOf(set.directory)).templates[0].createdAt as number;

    // The variance guard runs before any write: manifest and files stay byte-identical.
    const beforeManifest = await readFile(join(set.directory, 'manifest.json'), 'utf8');
    const beforeFiles = (await readdir(set.directory)).sort();
    await expect(library.save(set.directory, { ...input, id: 'tpl_flat', image: await checker(64, 64, { flat: true }) }))
      .rejects.toMatchObject({ code: 'TEMPLATE_LOW_VARIANCE', message: expect.stringContaining('方差过低') });
    expect(await readFile(join(set.directory, 'manifest.json'), 'utf8')).toBe(beforeManifest);
    expect((await readdir(set.directory)).sort()).toEqual(beforeFiles);
    await expect(library.save(set.directory, { ...input, id: 'tpl_out', crop: { x: 60, y: 60, w: 24, h: 24 } }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringContaining('裁剪区域') });

    // A fixed id that already exists needs an explicit overwrite.
    await expect(library.save(set.directory, { ...input, name: '新按钮' })).rejects.toMatchObject({ code: 'TEMPLATE_EXISTS' });
    await library.save(set.directory, { ...input, id: 'tpl_second', name: '第二个' });
    const updated = await library.save(set.directory, { ...input, name: '新按钮', overwrite: true });
    expect(updated.replaced).toBe(true);
    const manifest = await manifestOf(set.directory);
    expect(manifest.templates.map((item: { id: string }) => item.id)).toEqual(['tpl_button', 'tpl_second']);
    expect(manifest.templates[0]).toMatchObject({ name: '新按钮', createdAt: created });
    expect(manifest.templates[0].updatedAt).toBeGreaterThanOrEqual(created);

    await library.delete(set.directory, 'tpl_button');
    expect((await library.load(set.directory)).templates.map((item) => item.id)).toEqual(['tpl_second']);
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(library.delete(set.directory, 'tpl_button')).rejects.toMatchObject({ code: 'TEMPLATE_NOT_FOUND' });
  });

  it('computes the diff mask on the server and persists maskCoverage, std, note and timestamps', async () => {
    const library = new TemplateLibrary(await tempHome());
    const set = await library.createSet('wanlong', '透明底', 'com.example.game', 256, 256);
    const saved = await library.save(set.directory, {
      id: 'tpl_ring', name: '圆环', image: await checker(), authoredWidth: 64, authoredHeight: 64,
      crop: { x: 8, y: 8, w: 24, h: 24 }, diffFrames: [await checker(64, 64, { changed: true })], diffTolerance: 0,
    });
    expect(saved.maskCoverage).toBeGreaterThan(0.1);
    expect(saved.maskCoverage).toBeLessThan(1);
    expect(saved.diffCoverage).toBeGreaterThan(0.3);
    const loaded = (await loadTemplateSet(set.directory)).templates[0]!;
    expect(loaded).toMatchObject({ id: 'tpl_ring', maskCoverage: saved.maskCoverage });
    expect(loaded.std).toBe(Math.round(saved.std * 10) / 10);
    expect(typeof loaded.createdAt).toBe('number');
    expect(typeof loaded.updatedAt).toBe('number');
    const png = await library.image(set.directory, 'tpl_ring');
    expect((await sharp(png).metadata()).hasAlpha).toBe(true);
    await expect(library.save(set.directory, {
      id: 'tpl_nocrop', name: '无裁剪', image: await checker(), authoredWidth: 64, authoredHeight: 64,
      diffFrames: [await checker(64, 64, { changed: true })],
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringContaining('差分去底必须给裁剪区域') });
  });

  it('scales bounds with one uniform k and accepts an already cropped image', async () => {
    const library = new TemplateLibrary(await tempHome());
    const set = await library.createSet('wanlong', '归一化', 'com.example.game', 2560, 1440);
    const frame = await checker(1280, 800);
    const uniform = await library.save(set.directory, {
      id: 'tpl_uniform', name: '统一系数', image: frame, authoredWidth: 1280, authoredHeight: 800, crop: { x: 100, y: 50, w: 40, h: 30 },
    });
    // k = 2560 / 1280 for x, y, w and h alike (a separate y factor would give 90, not 100).
    expect(uniform.definition.bounds).toEqual({ x: 200, y: 100, w: 80, h: 60 });

    const cropped = await sharp(frame).extract({ left: 100, top: 50, width: 40, height: 30 }).png().toBuffer();
    const precut = await library.save(set.directory, { id: 'tpl_precut', name: '已裁好', image: cropped, authoredWidth: 1280, authoredHeight: 800 });
    expect(precut.definition.bounds).toEqual({ x: 0, y: 0, w: 80, h: 60 });
    await expect(library.save(set.directory, { id: 'tpl_mismatch', name: '尺寸不符', image: cropped, authoredWidth: 1280, authoredHeight: 800,
      crop: { x: 0, y: 0, w: 20, h: 20 } })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringContaining('请重新截图') });
  });

  it('serializes concurrent saves, keeps reading legacy randomized files and never reuses another template\'s file', async () => {
    const library = new TemplateLibrary(await tempHome());
    const set = await library.createSet('wanlong', '并发', 'com.example.game', 256, 256);
    const image = await checker();
    await Promise.all(Array.from({ length: 5 }, (_, i) => library.save(set.directory, {
      id: `tpl_${i}`, name: `模板 ${i}`, image, authoredWidth: 64, authoredHeight: 64, crop: { x: 4 * i, y: 8, w: 24, h: 24 },
    })));
    expect((await library.load(set.directory)).templates.map((item) => item.id).sort()).toEqual(['tpl_0', 'tpl_1', 'tpl_2', 'tpl_3', 'tpl_4']);

    // A hand-made legacy entry with a randomized name, and another entry that owns "tpl_new.png".
    const manifest = await manifestOf(set.directory);
    const legacyPng = await library.image(set.directory, 'tpl_0');
    await writeFile(join(set.directory, 'tpl_old.abcdef1234.png'), legacyPng);
    await writeFile(join(set.directory, 'tpl_new.png'), legacyPng);
    manifest.templates.push({ ...manifest.templates[0], id: 'tpl_old', file: 'tpl_old.abcdef1234.png' });
    manifest.templates.push({ ...manifest.templates[0], id: 'tpl_owner', file: 'tpl_new.png' });
    await writeFile(join(set.directory, 'manifest.json'), JSON.stringify(manifest));
    expect((await library.image(set.directory, 'tpl_old')).byteLength).toBe(legacyPng.byteLength);

    const replaced = await library.save(set.directory, { id: 'tpl_old', name: '旧模板', image, authoredWidth: 64, authoredHeight: 64,
      crop: { x: 8, y: 8, w: 24, h: 24 }, overwrite: true });
    expect(replaced.definition.file).toBe('tpl_old.png');
    await expect(stat(join(set.directory, 'tpl_old.abcdef1234.png'))).rejects.toMatchObject({ code: 'ENOENT' });
    const fresh = await library.save(set.directory, { id: 'tpl_new', name: '新模板', image, authoredWidth: 64, authoredHeight: 64,
      crop: { x: 8, y: 8, w: 24, h: 24 } });
    expect(fresh.definition.file).toMatch(/^tpl_new\.[0-9a-f]{10}\.png$/);
    expect(await readFile(join(set.directory, 'tpl_new.png'))).toEqual(legacyPng);
  });

  it('loads the legacy wanlong-panel manifest shape with its metadata and ignores bad optional values', async () => {
    const directory = await tempHome();
    const png = await checker(32, 32);
    await writeFile(join(directory, 'dig_dark20_0.png'), png);
    await writeFile(join(directory, 'tpl_world_search_icon.png'), png);
    await writeFile(join(directory, 'manifest.json'), JSON.stringify({
      id: 'tset_mtugr5sx0iwc', name: '万龙觉醒', packageName: 'com.lilithgames.samo.android.cn', refWidth: 2560, refHeight: 1440,
      updatedAt: 1757000000000,
      templates: [
        { id: 'tpl_world_search_icon', name: '世界地图-放大镜', file: 'tpl_world_search_icon.png', authoredWidth: 2560, authoredHeight: 1440,
          bounds: { x: 60, y: 1180, w: 110, h: 110 }, defaultRoi: { x: 0, y: 1100, w: 260, h: 340 }, std: 41.3, maskCoverage: 0.343,
          note: '两帧去底', createdAt: 1756000000000, updatedAt: 1756500000000 },
        { id: 'dig_dark20_0', name: 'dig_dark20 字形 0', file: 'dig_dark20_0.png', authoredWidth: 2560, authoredHeight: 1440,
          bounds: { x: 10, y: 10, w: 21, h: 29 }, threshold: 0.78, tags: ['digit', 'dig_dark20'], std: 'bad', maskCoverage: 7,
          createdAt: 1, updatedAt: 2 },
      ],
    }));
    const set = await loadTemplateSet(directory);
    expect(set.updatedAt).toBe(1757000000000);
    expect(set.templates[0]).toMatchObject({ std: 41.3, maskCoverage: 0.343, note: '两帧去底', createdAt: 1756000000000, updatedAt: 1756500000000 });
    expect(set.templates[1]).toMatchObject({ tags: ['digit', 'dig_dark20'], threshold: 0.78, createdAt: 1, updatedAt: 2 });
    expect(set.templates[1]!.std).toBeUndefined();
    expect(set.templates[1]!.maskCoverage).toBeUndefined();
  });

  it('imports legacy sets into the managed root and deletes only managed sets', async () => {
    const home = await tempHome();
    const library = new TemplateLibrary(home);
    const legacy = join(home, 'legacy', 'templates', 'tset_legacy');
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, 'tpl_a.png'), await checker(32, 32));
    await writeFile(join(legacy, 'manifest.json'), JSON.stringify({
      id: 'tset_legacy', name: '旧模板集', packageName: 'com.example.game', refWidth: 2560, refHeight: 1440, updatedAt: 1,
      templates: [{ id: 'tpl_a', name: 'A', file: 'tpl_a.png', authoredWidth: 2560, authoredHeight: 1440,
        bounds: { x: 0, y: 0, w: 32, h: 32 }, createdAt: 1, updatedAt: 1 }],
    }));
    const result = await library.importSets('wanlong', join(home, 'legacy', 'templates'), { packageName: 'com.example.game' });
    expect(result).toEqual({ copiedSets: { tset_legacy: 2 }, addedTemplates: {}, skipped: {} });
    const [imported] = await library.managedSets('wanlong');
    expect(imported).toMatchObject({ id: 'tset_legacy', name: '旧模板集' });
    expect(await library.importSets('wanlong', legacy)).toEqual({ copiedSets: {}, addedTemplates: {}, skipped: {} });
    await expect(library.importSets('wanlong', imported!.directory)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });

    await expect(library.deleteSet('wanlong', legacy)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await library.deleteSet('wanlong', imported!.directory);
    expect(await library.managedSets('wanlong')).toEqual([]);
  });
});
