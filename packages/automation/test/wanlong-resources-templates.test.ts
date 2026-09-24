/**
 * Port of scripts/resources-offline-check.ts 【三】 on a synthetic template set:
 * the glyph set builds from dig_resstat_*, the 亿 unit compiles separately at shrink=1,
 * seeding crops frames through TemplateLibrary.save (std guard), and missing material is skipped.
 */
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { TemplateLibrary, loadTemplateSet, readTemplatePng } from '../src/index.js';
import {
  RES_GLYPH, RES_TPL, invalidateResourceUnitTemplates, loadGatherTemplates, loadResourceUnitTemplates,
  resourceSeedPlan, seedResourceTemplates, type ResourceSeedFrame,
} from '../src/wanlong/index.js';
import { writeResourceTemplateSet } from './helpers/resource-fixture.js';
import { Screen, blockPatch, glyphPatch, writeTemplateSet, type Gray } from './helpers/synth.js';

describe('resource templates in a gather template set', () => {
  it('builds dig_resstat from the digit-tagged glyphs and keeps units out of it', async () => {
    const dir = await writeResourceTemplateSet();
    const warns: string[] = [];
    const templates = await loadGatherTemplates({ templateDir: dir, onWarn: (m) => warns.push(m) });
    expect(templates.hasGlyphs(RES_GLYPH)).toBe(true);
    const chars = templates.requireGlyphs(RES_GLYPH).glyphs.map((g) => g.char).sort().join('');
    expect(chars).toBe('.01234679');
    expect(templates.has(RES_TPL.btnResStats) && templates.has(RES_TPL.titleResStats)).toBe(true);
    expect([RES_TPL.navItems, RES_TPL.btnCloseResStats, 'tpl_label_res_gold', 'tpl_label_res_mana'].every((id) => templates.has(id))).toBe(true);
    expect(warns.some((w) => w.includes('resstat'))).toBe(false);
    const set = await loadTemplateSet(dir);
    expect(set.templates.find((t) => t.id === RES_TPL.unitYi)!.tags).not.toContain('digit');
  });

  it('compiles the unit characters at shrink=1, lists 万 as missing and caches per directory', async () => {
    const dir = await writeResourceTemplateSet();
    invalidateResourceUnitTemplates();
    const units = await loadResourceUnitTemplates(dir);
    expect(units.units.get(RES_TPL.unitYi)?.shrink).toBe(1);
    expect(units.missing).toEqual([RES_TPL.unitWan]);
    expect(await loadResourceUnitTemplates(dir)).toBe(units);
    invalidateResourceUnitTemplates();
    const again = await loadResourceUnitTemplates(dir);
    expect(again).not.toBe(units);
    expect(again.units.has(RES_TPL.unitYi)).toBe(true);
  });

  it('reloads automatically when the unit definition changes, and tolerates a broken unit image', async () => {
    const dir = await writeResourceTemplateSet();
    const first = await loadResourceUnitTemplates(dir);
    const manifestFile = join(dir, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    manifest.templates.find((t: { id: string }) => t.id === RES_TPL.unitYi).file = 'missing-file.png';
    const { writeFile } = await import('node:fs/promises');
    await writeFile(manifestFile, JSON.stringify(manifest));
    const warns: string[] = [];
    const second = await loadResourceUnitTemplates(dir, (m) => warns.push(m));
    expect(second).not.toBe(first);
    expect(second.units.size).toBe(0);
    expect(second.missing).toEqual([RES_TPL.unitYi, RES_TPL.unitWan]);
    expect(warns[0]).toContain('编译失败');
  });
});

describe('seedResourceTemplates', () => {
  it('crops the spec bounds out of role-named frames through TemplateLibrary.save, byte-exact', async () => {
    const home = await mkdtemp(join(tmpdir(), 'avdm-res-seed-'));
    const library = new TemplateLibrary(home);
    const set = await library.createSet('wanlong', '万龙觉醒', 'com.lilithgames.samo.android.cn', 2560, 1440);
    // One frame per role with a distinct texture painted exactly inside every planned crop.
    const plan = resourceSeedPlan();
    const painted = new Map<string, Gray>();
    const frames: Partial<Record<ResourceSeedFrame, Screen>> = {};
    plan.drafts.forEach((d, i) => {
      const screen = frames[d.frame] ??= new Screen(2560, 1440, 40 + i).fill({ x: 410, y: 200, w: 1735, h: 1050 }, 246);
      const img = d.id.startsWith('dig_resstat_') ? glyphPatch(d.id, d.crop.w, d.crop.h) : blockPatch(d.crop.w, d.crop.h, 500 + i, 4);
      screen.paste(img, d.crop.x, d.crop.y);
      painted.set(d.id, img);
    });
    const result = await seedResourceTemplates({
      library, templateDir: set.directory,
      frames: Object.fromEntries(await Promise.all(Object.entries(frames).map(async ([k, v]) => [k, await v.png()]))),
    });
    expect(result.failed).toEqual([]);
    expect(result.saved.sort()).toEqual(plan.drafts.map((d) => d.id).sort());
    expect(result.saved.length).toBeGreaterThanOrEqual(18);
    expect(result.skipped.map((s) => s.id).sort()).toEqual(['dig_resstat_5', 'dig_resstat_8', 'dig_resstat_comma', RES_TPL.unitWan].sort());

    const manifest = await loadTemplateSet(set.directory);
    const yi = manifest.templates.find((t) => t.id === RES_TPL.unitYi)!;
    expect(yi.bounds).toEqual({ x: 1291, y: 434, w: 37, h: 37 });
    expect(yi.tags).toEqual(['resstat_unit']);
    expect(manifest.templates.find((t) => t.id === RES_TPL.titleResStats)!.defaultRoi).toEqual({ x: 1000, y: 100, w: 560, h: 160 });
    expect(manifest.templates.find((t) => t.id === 'dig_resstat_dot')!.tags).toEqual(['digit', 'dig_resstat']);
    for (const id of [RES_TPL.unitYi, 'dig_resstat_dot', 'dig_resstat_4', RES_TPL.navItems, RES_TPL.btnResStats]) {
      const { data, info } = await sharp(await readTemplatePng(manifest, id)).greyscale().raw().toBuffer({ resolveWithObject: true });
      const expected = painted.get(id)!;
      expect([info.width, info.height], id).toEqual([expected.w, expected.h]);
      expect(Buffer.from(data).equals(Buffer.from(expected.px)), id).toBe(true);
    }
    // The unit cache sees the freshly seeded 亿.
    expect((await loadResourceUnitTemplates(set.directory)).units.has(RES_TPL.unitYi)).toBe(true);
  });

  it('scales the spec crops to smaller 16:9 frames (AVD resolution) and keeps bounds in reference space', async () => {
    const home = await mkdtemp(join(tmpdir(), 'avdm-res-seed-'));
    const library = new TemplateLibrary(home);
    const set = await library.createSet('wanlong', '万龙觉醒', 'com.lilithgames.samo.android.cn', 2560, 1440);
    const items = new Screen(2560, 1440, 5);
    items.paste(blockPatch(200, 62, 71, 8), 1480, 234).paste(blockPatch(122, 66, 72, 8), 133, 33);
    const half = await items.rawResized(1280, 720);
    const png = await sharp(Buffer.from(half.data), { raw: { width: 1280, height: 720, channels: 4 } }).png().toBuffer();
    const result = await seedResourceTemplates({ library, templateDir: set.directory, frames: { items: png } });
    expect(result.saved.sort()).toEqual([RES_TPL.btnResStats, RES_TPL.titleItemsRes].sort());
    const btn = (await loadTemplateSet(set.directory)).templates.find((t) => t.id === RES_TPL.btnResStats)!;
    expect(btn.authoredWidth).toBe(1280);
    expect(btn.bounds).toEqual({ x: 1480, y: 234, w: 200, h: 62 });
  });

  it('skips entries whose frame was not provided and reports low-variance crops as failures', async () => {
    const home = await mkdtemp(join(tmpdir(), 'avdm-res-seed-'));
    const library = new TemplateLibrary(home);
    const set = await library.createSet('wanlong', '万龙觉醒', 'com.lilithgames.samo.android.cn', 2560, 1440);
    const flat = new Screen(2560, 1440, 1);
    flat.px.fill(128);
    const result = await seedResourceTemplates({ library, templateDir: set.directory, frames: { items: await flat.png() } });
    expect(result.saved).toEqual([]);
    expect(result.failed.map((f) => f.id).sort()).toEqual([RES_TPL.btnResStats, RES_TPL.titleItemsRes].sort());
    expect(result.failed[0]!.reason).toContain('纹理不足');
    expect(result.skipped.some((s) => s.id === RES_TPL.titleResStats && s.reason.includes('没有提供'))).toBe(true);
    expect((await loadTemplateSet(set.directory)).templates).toEqual([]);
  });

  it('rejects frames that are not 16:9 screenshots', async () => {
    const dir = await writeTemplateSet([]);
    const library = new TemplateLibrary(await mkdtemp(join(tmpdir(), 'avdm-res-seed-')));
    const odd = new Screen(800, 800, 3);
    const result = await seedResourceTemplates({ library, templateDir: dir, frames: { stats: await odd.png() } });
    expect(result.saved).toEqual([]);
    expect(result.skipped.find((s) => s.id === RES_TPL.titleResStats)!.reason).toContain('不是 16:9');
  });
});
