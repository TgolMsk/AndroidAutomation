/**
 * Port of scripts/resources-offline-check.ts 【五】 on synthetic frames: the 8-cell table reads exactly,
 * a non-table frame yields 8 explained nulls without throwing, and a missing glyph never becomes a wrong value.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  emptyResourceSnapshot, loadGatherTemplates, loadResourceUnitTemplates, mergeSnapshots, readResourceStatsFromFrame,
  snapshotRow, type GatherTemplates, type ResourceSnapshot,
} from '../src/wanlong/index.js';
import { TRUTH, TRUTH_VALUES, buildScreens, writeResourceTemplateSet, type TableValues } from './helpers/resource-fixture.js';

let dir: string;
let templates: GatherTemplates;

beforeAll(async () => {
  dir = await writeResourceTemplateSet();
  templates = await loadGatherTemplates({ templateDir: dir });
});

const withValues = (patch: Partial<TableValues>): TableValues => ({ ...TRUTH_VALUES, ...patch });

describe('readResourceStatsFromFrame', () => {
  it('reads all 8 cells of the table exactly and cleanly', async () => {
    const at = 1_789_000_000_000;
    const snap = await readResourceStatsFromFrame(buildScreens().dialog.raw(), templates, 3, at, { templateDir: dir });
    expect(snap).toMatchObject({ instanceIndex: 3, at, source: 'panel' });
    expect(snap.rows.map((r) => r.type)).toEqual(['gold', 'wood', 'iron', 'mana']);
    for (const row of snap.rows) {
      const t = TRUTH[row.type];
      expect(row).toEqual({ type: row.type, itemTotal: t.item, total: t.total, rawItem: t.rawItem, rawTotal: t.rawTotal });
    }
    expect(snap.warnings).toEqual([]);
  });

  it('accepts pre-loaded units (the worker path) instead of a template directory', async () => {
    const units = await loadResourceUnitTemplates(dir);
    const snap = await readResourceStatsFromFrame(buildScreens().dialog.raw(), templates, 0, 1, { units });
    expect(snapshotRow(snap, 'iron')!.total).toBe(2_240_000_000);
  });

  it('gives 8 explained nulls on a frame without the table, and names the missing glyphs and unit', async () => {
    const neg = await readResourceStatsFromFrame(buildScreens().items.raw(), templates, 0, 1, { templateDir: dir });
    expect(neg.rows.every((r) => r.itemTotal === null && r.total === null)).toBe(true);
    expect(neg.warnings.filter((w) => w.includes('读不出')).length).toBe(8);
    expect(neg.warnings.some((w) => w.includes('缺 5/8'))).toBe(true);
    expect(neg.warnings.some((w) => w.includes('单位字模板缺「万」'))).toBe(true);
  });

  it('★ a missing glyph yields null with the raw text, never a wrong value', async () => {
    const snap = await readResourceStatsFromFrame(
      buildScreens(withValues({ gold: { item: '25.1亿', total: '8.1亿' } })).dialog.raw(), templates, 0, 1, { templateDir: dir },
    );
    const gold = snapshotRow(snap, 'gold')!;
    expect(gold.itemTotal).toBeNull();
    expect(gold.rawItem).toContain('?');
    expect(gold.total).toBeNull();
    expect(snap.warnings.some((w) => w.startsWith('金币·道具总量读不出：中间有认不出的字位'))).toBe(true);
    expect(snap.warnings.some((w) => w.startsWith('金币·资源总量读不出'))).toBe(true);
    // Other rows are unaffected.
    expect(snapshotRow(snap, 'wood')!.total).toBe(TRUTH.wood.total);
  });

  it('reads a full glyph set, including 5 / 8, once they are cropped', async () => {
    const full = await writeResourceTemplateSet({ glyphChars: '0123456789.' });
    const t = await loadGatherTemplates({ templateDir: full });
    const snap = await readResourceStatsFromFrame(
      buildScreens(withValues({ gold: { item: '25.1亿', total: '85.8亿' } })).dialog.raw(), t, 0, 1, { templateDir: full },
    );
    expect(snapshotRow(snap, 'gold')).toMatchObject({ itemTotal: 2_510_000_000, total: 8_580_000_000 });
    expect(snap.warnings).toEqual([]);
  });

  it('warns 疑似读错列 when total < itemTotal but keeps the values', async () => {
    const snap = await readResourceStatsFromFrame(
      buildScreens(withValues({ wood: { item: '4.1亿', total: '3.2亿' } })).dialog.raw(), templates, 0, 1, { templateDir: dir },
    );
    expect(snapshotRow(snap, 'wood')).toMatchObject({ itemTotal: 410_000_000, total: 320_000_000 });
    expect(snap.warnings).toEqual(['木材的资源总量（3.2亿）小于道具总量（4.1亿），疑似读错列']);
  });

  it('rejects shapes that are not table values (too many digits / two decimals)', async () => {
    const snap = await readResourceStatsFromFrame(
      buildScreens(withValues({ mana: { item: '12346.2亿', total: '7.22亿' } })).dialog.raw(), templates, 0, 1, { templateDir: dir },
    );
    const mana = snapshotRow(snap, 'mana')!;
    expect(mana.itemTotal).toBeNull();
    expect(mana.total).toBeNull();
    expect(snap.warnings.filter((w) => w.startsWith('魔水') && w.includes('形状不像')).length).toBe(2);
  });

  it('reads unit-less thousands once the comma glyph and 万 exist', async () => {
    const full = await writeResourceTemplateSet({ glyphChars: '0123456789.,', withWan: true });
    const t = await loadGatherTemplates({ templateDir: full });
    const snap = await readResourceStatsFromFrame(
      buildScreens(withValues({ iron: { item: '9,999', total: '9129万' } })).dialog.raw(), t, 0, 1, { templateDir: full },
    );
    expect(snapshotRow(snap, 'iron')).toMatchObject({ itemTotal: 9_999, rawItem: '9,999', total: 91_290_000, rawTotal: '9129万' });
  });

  it('throws only when the glyph set or the unit source is absent', async () => {
    const noGlyphs = await writeResourceTemplateSet({ noGlyphs: true });
    const t = await loadGatherTemplates({ templateDir: noGlyphs });
    await expect(readResourceStatsFromFrame(buildScreens().dialog.raw(), t, 0, 1, { templateDir: noGlyphs }))
      .rejects.toMatchObject({ code: 'TEMPLATE_NOT_FOUND' });
    await expect(readResourceStatsFromFrame(buildScreens().dialog.raw(), templates, 0, 1))
      .rejects.toMatchObject({ code: 'TEMPLATE_NOT_FOUND' });
  });
});

describe('mergeSnapshots', () => {
  const make = (cells: Record<string, [number | null, string]>, warnings: string[] = []): ResourceSnapshot => {
    const s = emptyResourceSnapshot(1, 100);
    for (const row of s.rows) {
      const item = cells[`${row.type}.item`];
      const total = cells[`${row.type}.total`];
      if (item) { row.itemTotal = item[0]; row.rawItem = item[1]; }
      if (total) { row.total = total[0]; row.rawTotal = total[1]; }
    }
    s.warnings = warnings;
    return s;
  };

  it('covers agree / disagree / one-frame / neither and keeps only the second frame\'s generic warnings', () => {
    const first = make({
      'gold.item': [290_000_000, '2.9亿'],
      'gold.total': [1_110_000_000, '11.1亿'],
      'wood.item': [320_000_000, '3.2亿'],
      'iron.item': [null, '2.?亿'],
    }, ['金币·资源总量读不出：x', '第一帧的整体说明']);
    const second: ResourceSnapshot = {
      ...make({
        'gold.item': [290_000_000, '2.9亿'],
        'gold.total': [1_010_000_000, '10.1亿'],
        'wood.total': [410_000_000, '4.1亿'],
      }, ['木材·道具总量读不出：y', '木材的资源总量（a）小于道具总量（b），疑似读错列', '本套字形缺 5/8']),
      at: 200,
      instanceIndex: 1,
    };
    const merged = mergeSnapshots(first, second);
    expect(merged.at).toBe(200);
    const gold = snapshotRow(merged, 'gold')!;
    expect(gold).toMatchObject({ itemTotal: 290_000_000, rawItem: '2.9亿', total: null, rawTotal: '11.1亿≠10.1亿' });
    expect(snapshotRow(merged, 'wood')).toMatchObject({ itemTotal: 320_000_000, rawItem: '3.2亿', total: 410_000_000 });
    expect(snapshotRow(merged, 'iron')).toMatchObject({ itemTotal: null, rawItem: '2.?亿' });
    expect(merged.warnings).toContain('金币·资源总量两帧读数不一致（11.1亿 / 10.1亿），已置空');
    expect(merged.warnings).toContain('铁矿石·道具总量两帧都读不出（2.?亿）');
    expect(merged.warnings).toContain('魔水·资源总量两帧都读不出（空）');
    expect(merged.warnings).toContain('本套字形缺 5/8');
    expect(merged.warnings.some((w) => w.includes('第一帧的整体说明'))).toBe(false);
    expect(merged.warnings.some((w) => w.includes('疑似读错列') || w.includes('读不出：'))).toBe(false);
  });
});
