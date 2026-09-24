/**
 * scripts/resources-offline-check.ts 【四】【五】【六】 on REAL frames and templates.
 * Real screenshots and templates are private user data and never enter the repository, so this suite only runs when
 *   WANLONG_RES_SHOTS    = a directory with res_02_items.png, res_04_stats.png, res_05_back1.png, res_06_back2.png
 *   WANLONG_TEMPLATE_DIR = a Wanlong template set (manifest.json + PNGs); missing resource templates are seeded
 *                          into a temporary copy from the shots
 * are both set. Otherwise it is skipped.
 */
import { cp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TemplateLibrary, matchTemplate, prepareFrame, type AndroidKey, type RawFrame } from '../src/index.js';
import {
  RESOURCE_SEED_FRAMES, RESOURCE_SEED_LEGACY_FILES, RES_GLYPH, RES_TPL, loadGatherTemplates, readResourceStatsFromFrame,
  readResourceStatsPanel, seedResourceTemplates, type GatherIo, type GatherTemplates, type ResourceSeedFrame,
} from '../src/wanlong/index.js';
import { TRUTH } from './helpers/resource-fixture.js';
import { GAME, removeTempDirs, tempDir } from './helpers/synth.js';

const SHOTS = process.env.WANLONG_RES_SHOTS;
const TEMPLATE_DIR = process.env.WANLONG_TEMPLATE_DIR;
const enabled = Boolean(SHOTS && TEMPLATE_DIR);

const frameCache = new Map<string, RawFrame>();
async function frame(name: string): Promise<RawFrame> {
  let hit = frameCache.get(name);
  if (!hit) {
    const { data, info } = await sharp(await readFile(join(SHOTS!, name))).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    hit = { width: info.width, height: info.height, data: new Uint8Array(data), capturedAt: 0, format: 1 };
    frameCache.set(name, hit);
  }
  return hit;
}

class ScriptedIo implements GatherIo {
  cursor = 0;
  readonly actions: string[] = [];
  constructor(private readonly script: string[], private readonly fg = GAME) {}
  private advance(what: string): void { this.actions.push(what); if (this.cursor < this.script.length - 1) this.cursor++; }
  capture(): Promise<RawFrame> { return frame(this.script[this.cursor]!); }
  async tap(x: number, y: number): Promise<void> { this.advance(`tap ${x},${y}`); }
  async tapMany(p: [number, number][]): Promise<void> { this.advance(`tapMany x${p.length}`); }
  async swipe(): Promise<void> { this.advance('swipe'); }
  async key(k: AndroidKey): Promise<void> { this.advance(`key ${k}`); }
  async launchApp(): Promise<void> { this.advance('launchApp'); }
  async foregroundPackage(): Promise<string | null> { return this.fg; }
}

describe.skipIf(!enabled)('resource statistics on real frames (private fixtures)', () => {
  let dir: string;
  let templates: GatherTemplates;

  beforeAll(async () => {
    dir = await tempDir('avdm-res-real-');
    await cp(TEMPLATE_DIR!, dir, { recursive: true });
    templates = await loadGatherTemplates({ templateDir: dir });
    if (!templates.hasGlyphs(RES_GLYPH) || !templates.has(RES_TPL.titleResStats)) {
      const frames: Partial<Record<ResourceSeedFrame, Uint8Array>> = {};
      for (const role of RESOURCE_SEED_FRAMES) frames[role] = await readFile(join(SHOTS!, RESOURCE_SEED_LEGACY_FILES[role]));
      const seeded = await seedResourceTemplates({ library: new TemplateLibrary(await tempDir('avdm-home-')), templateDir: dir, frames });
      expect(seeded.failed).toEqual([]);
      templates = await loadGatherTemplates({ templateDir: dir });
    }
  }, 120_000);
  afterAll(removeTempDirs);

  it('UI templates: positive ≥ 0.9 on their own frame, negative < 0.6 elsewhere', async () => {
    const f2 = async (name: string) => prepareFrame(await frame(name), { refWidth: 2560, refHeight: 1440, shrink: 2 });
    const stats = await f2('res_04_stats.png');
    const items = await f2('res_02_items.png');
    const map = await f2('res_06_back2.png');
    const back1 = await f2('res_05_back1.png');
    const cases: Array<[string, typeof stats, typeof stats]> = [
      [RES_TPL.titleResStats, stats, map], [RES_TPL.btnResStats, items, map], [RES_TPL.btnCloseResStats, stats, items],
      [RES_TPL.titleItemsRes, items, stats], [RES_TPL.navItems, map, stats],
      ['tpl_label_res_gold', stats, items], ['tpl_label_res_mana', stats, map],
    ];
    for (const [id, pos, neg] of cases) {
      const tpl = templates.require(id);
      const p = await matchTemplate(pos, tpl);
      const n = await matchTemplate(neg, tpl, { threshold: 0.01 });
      expect(p.found && p.score >= 0.9, `${id} ${p.score}`).toBe(true);
      expect(n.score, id).toBeLessThan(0.6);
    }
    expect((await matchTemplate(back1, templates.require(RES_TPL.titleResStats))).found).toBe(false);
    expect((await matchTemplate(back1, templates.require(RES_TPL.btnResStats))).found).toBe(true);
    expect((await matchTemplate(map, templates.require('tpl_nav_city_toggle'))).found).toBe(true);
  });

  it('reads the 8 ground-truth cells from the stats frame and 8 explained nulls from the items frame', async () => {
    const snap = await readResourceStatsFromFrame(await frame('res_04_stats.png'), templates, 3, 1, { templateDir: dir });
    for (const row of snap.rows) {
      expect(row).toEqual({ type: row.type, itemTotal: TRUTH[row.type].item, total: TRUTH[row.type].total, rawItem: TRUTH[row.type].rawItem, rawTotal: TRUTH[row.type].rawTotal });
    }
    expect(snap.warnings).toEqual([]);
    const neg = await readResourceStatsFromFrame(await frame('res_02_items.png'), templates, 0, 1, { templateDir: dir });
    expect(neg.rows.every((r) => r.itemTotal === null && r.total === null)).toBe(true);
    expect(neg.warnings.filter((w) => w.includes('读不出'))).toHaveLength(8);
  });

  it('runs the whole flow on real frames and refuses without input off the main screen', async () => {
    let t = 0;
    const now = () => (t += 1000);
    const io = new ScriptedIo(['res_06_back2.png', 'res_02_items.png', 'res_04_stats.png', 'res_05_back1.png', 'res_06_back2.png']);
    const snap = await readResourceStatsPanel({ io, templates, templateDir: dir, instanceIndex: 1, log: () => undefined, now });
    expect(snap.rows.every((r) => r.itemTotal === TRUTH[r.type].item && r.total === TRUTH[r.type].total)).toBe(true);
    expect(io.actions).toHaveLength(4);
    for (const start of ['res_04_stats.png', 'res_02_items.png']) {
      const stuck = new ScriptedIo([start]);
      await expect(readResourceStatsPanel({ io: stuck, templates, templateDir: dir, instanceIndex: 1, log: () => undefined, now }))
        .rejects.toThrow('当前不在主界面');
      expect(stuck.actions).toEqual([]);
    }
  });
});
