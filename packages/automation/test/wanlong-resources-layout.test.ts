/**
 * Port of scripts/resources-offline-check.ts 【二】: the hand copies in layout.ts / ids.ts must equal
 * game-data/wanlong/resource-stats.json. Also pins the renderer-safe import graph of resources/pure.ts.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  RESOURCE_REQUIRED_TEMPLATES, RESOURCE_SEED_FRAMES, RESOURCE_STATS_LAYOUT, RESOURCE_TEMPLATE_CATALOG, RES_GLYPH,
  RES_GLYPH_TAGS, RES_LABEL_TPL, RES_TPL, RES_UNIT_CHAR, resourceGlyphId, resourceSeedPlan, rowRoi,
} from '../src/wanlong/resources/pure.js';

const here = dirname(fileURLToPath(import.meta.url));
const specFile = join(here, '..', 'game-data', 'wanlong', 'resource-stats.json');

interface SpecItem { id: string; name?: string; shot?: string | null; status?: string; bounds?: unknown; roi?: unknown; tags?: string[]; char?: string }

async function spec(): Promise<Record<string, any>> {
  return JSON.parse(await readFile(specFile, 'utf8'));
}

describe('layout.ts hand copy equals resource-stats.json', () => {
  it('matches nav / itemsPage / dialog / rows / cellRoi / columns', async () => {
    const s = await spec();
    const L = RESOURCE_STATS_LAYOUT;
    expect([L.refWidth, L.refHeight]).toEqual([s.refWidth, s.refHeight]);
    expect(L.nav.itemsTap).toEqual(s.nav.itemsTap);
    expect(L.itemsPage.statsButtonTap).toEqual(s.itemsPage.statsButtonTap);
    expect(L.itemsPage.resourceCategoryTap).toEqual(s.itemsPage.resourceCategoryTap);
    expect(L.dialog).toEqual({ closeTap: s.dialog.closeTap, backPresses: s.dialog.backPresses });
    expect(L.rows).toEqual(s.rows);
    expect(L.rowPitchY).toBe(s.rowPitchY);
    expect(L.cellRoi).toEqual(s.cellRoi);
    for (const c of ['item', 'total'] as const) {
      expect(L.columns[c]).toEqual({ centerX: s.columns[c].centerX, x: s.columns[c].x, w: s.columns[c].w });
    }
    expect(s.popupGeometry.rows.order).toEqual(L.rows.map((r) => r.type));
  });

  it('computes cell ROIs and throws on an unknown row', () => {
    expect(rowRoi('gold', 'item')).toEqual({ x: 1155, y: 429, w: 250, h: 46 });
    expect(rowRoi('mana', 'total')).toEqual({ x: 1681, y: 1017, w: 250, h: 46 });
    expect(() => rowRoi('gem' as never, 'item')).toThrow('资源统计表里没有');
  });

  it('keeps the recognition parameters documented in pipeline.readOptions', async () => {
    const { UNIT_THRESHOLD, DIGIT_MIN_SCORE } = await import('../src/wanlong/resources/read.js');
    const s = await spec();
    expect(UNIT_THRESHOLD).toBe(s.pipeline.readOptions.unitThreshold);
    expect(DIGIT_MIN_SCORE).toBe(s.pipeline.readOptions.digitMinScore);
  });
});

describe('template ids and catalog equal the spec', () => {
  it('uses the spec template ids and glyph set name', async () => {
    const s = await spec();
    const ids = (s.templates as SpecItem[]).map((t) => t.id);
    for (const id of [RES_TPL.btnResStats, RES_TPL.titleResStats, RES_TPL.btnCloseResStats, RES_TPL.titleItemsRes,
      RES_TPL.unitYi, RES_TPL.unitWan, RES_TPL.navItems, ...Object.values(RES_LABEL_TPL)]) {
      expect(ids).toContain(id);
    }
    expect(s.glyphs.setName).toBe(RES_GLYPH);
    expect(s.glyphs.tags).toEqual([...RES_GLYPH_TAGS]);
    expect(s.glyphs.tags).toContain('digit');
    expect(RESOURCE_REQUIRED_TEMPLATES).toEqual([RES_TPL.btnResStats, RES_TPL.titleResStats]);
    expect(RES_UNIT_CHAR[RES_TPL.unitYi]).toBe('亿');
    expect(RES_UNIT_CHAR[RES_TPL.unitWan]).toBe('万');
    // ★ The unit characters never carry the digit tag (the 亿 segmentation hazard).
    const unit = (s.templates as SpecItem[]).find((t) => t.id === RES_TPL.unitYi)!;
    expect(unit.tags).not.toContain('digit');
  });

  it('RESOURCE_TEMPLATE_CATALOG is a faithful copy of templates[] and glyphs.items[]', async () => {
    const s = await spec();
    const specItems: SpecItem[] = [
      ...(s.templates as SpecItem[]),
      ...(s.glyphs.items as SpecItem[]).map((g) => ({ ...g, tags: s.glyphs.tags })),
    ];
    expect(RESOURCE_TEMPLATE_CATALOG.map((t) => t.id).sort()).toEqual(specItems.map((t) => t.id).sort());
    for (const item of specItems) {
      const t = RESOURCE_TEMPLATE_CATALOG.find((x) => x.id === item.id)!;
      const missing = item.status === 'missing' || !item.shot;
      expect(t.frame, item.id).toBe(missing ? null : item.shot);
      if (!missing) expect(RESOURCE_SEED_FRAMES).toContain(t.frame);
      expect(t.bounds ?? null, item.id).toEqual(item.bounds ?? null);
      expect(t.roi ?? null, item.id).toEqual(item.roi ?? null);
      expect(t.tags ? [...t.tags] : null, item.id).toEqual(item.tags ?? null);
      if (item.char) expect(resourceGlyphId(item.char)).toBe(item.id);
      if (item.name && t.kind !== 'glyph') expect(t.name).toBe(item.name);
    }
  });

  it('plans the seed crops and skips the entries without material (5 / 8 / comma / 万)', () => {
    const plan = resourceSeedPlan();
    expect(plan.skipped.map((s) => s.id).sort()).toEqual(['dig_resstat_5', 'dig_resstat_8', 'dig_resstat_comma', RES_TPL.unitWan].sort());
    expect(plan.drafts.length).toBe(RESOURCE_TEMPLATE_CATALOG.length - 4);
    expect(plan.drafts.length).toBeGreaterThanOrEqual(18);
    const yi = plan.drafts.find((d) => d.id === RES_TPL.unitYi)!;
    expect(yi).toMatchObject({ frame: 'stats', crop: { x: 1291, y: 434, w: 37, h: 37 }, tags: ['resstat_unit'] });
    const dot = plan.drafts.find((d) => d.id === 'dig_resstat_dot')!;
    expect(dot.name).toBe('资源统计数字-.');
    expect(dot.tags).toEqual(['digit', 'dig_resstat']);
    expect(plan.drafts.find((d) => d.id === RES_TPL.navItems)!.frame).toBe('worldMap');
  });
});

describe('renderer-safe module graph', () => {
  async function impureImports(entry: string): Promise<{ bad: string[]; seen: Set<string> }> {
    const seen = new Set<string>();
    const bad: string[] = [];
    const visit = async (file: string): Promise<void> => {
      if (seen.has(file)) return;
      seen.add(file);
      const source = await readFile(file, 'utf8');
      for (const m of source.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+'([^']+)'/gm)) {
        const spec = m[1]!;
        const typeOnly = /^\s*(?:import|export)\s+type\s/.test(m[0]);
        if (!spec.startsWith('.')) { if (!typeOnly) bad.push(`${file}: ${spec}`); continue; }
        if (typeOnly) continue;
        await visit(resolve(dirname(file), spec.replace(/\.js$/, '.ts')));
      }
    };
    await visit(join(here, '..', 'src', 'wanlong', entry));
    return { bad, seen };
  }

  it.each(['resources/pure.ts', 'update-ids.ts', 'launch.ts'])('%s reaches no node:*, sharp, opencv or electron import', async (entry) => {
    const { bad, seen } = await impureImports(entry);
    expect(bad).toEqual([]);
    if (entry === 'resources/pure.ts') expect([...seen].some((f) => f.endsWith('config.ts'))).toBe(true);
  });
});
