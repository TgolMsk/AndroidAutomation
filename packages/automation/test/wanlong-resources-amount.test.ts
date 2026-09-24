/** Port of scripts/resources-offline-check.ts 【一】 plus the pure snapshot contract (renderer-safe module). */
import { describe, expect, it } from 'vitest';
import {
  CN_AMOUNT_CASES, PANEL_AMOUNT_PRECISION, PANEL_PRECISION_NOTE, RESOURCE_NAME, RESOURCE_PANEL_ROW_ORDER,
  RESOURCE_TYPES, emptyResourceSnapshot, formatCnAmount, isResourceType, normalizeResourceSnapshot, parseCnAmount,
  renderResourceSnapshotText, snapshotRow,
} from '../src/wanlong/resources/pure.js';
import { RESOURCE_LABEL } from '../src/wanlong/index.js';
import { TRUTH } from './helpers/resource-fixture.js';

describe('parseCnAmount (single-source case table)', () => {
  it.each(CN_AMOUNT_CASES)('parseCnAmount(%j) = %s', (input, expected) => {
    expect(parseCnAmount(input)).toBe(expected);
  });

  it('never throws on null / undefined', () => {
    expect(parseCnAmount(null)).toBeNull();
    expect(parseCnAmount(undefined)).toBeNull();
  });
});

describe('formatCnAmount', () => {
  it('formats in the game style', () => {
    expect(formatCnAmount(1_110_000_000)).toBe('11.1亿');
    expect(formatCnAmount(300_000_000)).toBe('3亿');
    expect(formatCnAmount(91_290_000)).toBe('9129万');
    expect(formatCnAmount(59_677)).toBe('6万');
    expect(formatCnAmount(9_999)).toBe('9,999');
    expect(formatCnAmount(null)).toBe('—');
    expect(formatCnAmount(Number.NaN)).toBe('—');
  });

  it.each(Object.values(TRUTH))('round-trips the ground-truth value $rawTotal / $rawItem', (t) => {
    expect(formatCnAmount(parseCnAmount(t.rawTotal))).toBe(t.rawTotal.replace('.0亿', '亿'));
    expect(formatCnAmount(parseCnAmount(t.rawItem))).toBe(t.rawItem.replace('.0亿', '亿'));
  });
});

describe('resource contract', () => {
  it('has one Chinese label table and the fixed panel row order', () => {
    expect(RESOURCE_TYPES).toEqual(['gold', 'wood', 'iron', 'mana']);
    expect(RESOURCE_PANEL_ROW_ORDER).toEqual(['gold', 'wood', 'iron', 'mana']);
    for (const type of RESOURCE_TYPES) expect(RESOURCE_NAME[type]).toBe(RESOURCE_LABEL[type].resource);
    expect(Object.values(RESOURCE_NAME)).toEqual(['金币', '木材', '铁矿石', '魔水']);
    expect(isResourceType('mana')).toBe(true);
    expect(isResourceType('gem')).toBe(false);
    expect(isResourceType(3)).toBe(false);
    expect(PANEL_AMOUNT_PRECISION).toBe(10_000_000);
  });

  it('builds a full-shape empty snapshot and finds rows', () => {
    const snap = emptyResourceSnapshot(2, 1234);
    expect(snap).toMatchObject({ at: 1234, instanceIndex: 2, source: 'panel', warnings: [] });
    expect(snap.rows.map((r) => r.type)).toEqual(['gold', 'wood', 'iron', 'mana']);
    expect(snap.rows.every((r) => r.itemTotal === null && r.total === null && r.rawItem === '' && r.rawTotal === '')).toBe(true);
    expect(snapshotRow(snap, 'iron')?.type).toBe('iron');
    expect(snapshotRow({ ...snap, rows: [] }, 'iron')).toBeNull();
  });

  it('normalizes untrusted snapshots tolerantly (drops the item, never the ledger)', () => {
    expect(normalizeResourceSnapshot(null)).toBeNull();
    expect(normalizeResourceSnapshot({ at: 'x', instanceIndex: 0, rows: [] })).toBeNull();
    expect(normalizeResourceSnapshot({ at: 1, instanceIndex: -1, rows: [] })).toBeNull();
    expect(normalizeResourceSnapshot({ at: 1, instanceIndex: 0 })).toBeNull();
    const snap = normalizeResourceSnapshot({
      at: 5, instanceIndex: 1, source: 'weird',
      rows: [
        { type: 'mana', itemTotal: 620_000_000, total: 1e15, rawItem: '6.2亿', rawTotal: 'x'.repeat(100) },
        { type: 'gem', itemTotal: 1 },
        'junk',
      ],
      warnings: ['a', 3, 'b'.repeat(500), ...Array.from({ length: 50 }, () => 'w')],
    })!;
    expect(snap.source).toBe('panel');
    expect(snap.rows.map((r) => r.type)).toEqual(['gold', 'wood', 'iron', 'mana']);
    expect(snapshotRow(snap, 'mana')).toEqual({ type: 'mana', itemTotal: 620_000_000, total: null, rawItem: '6.2亿', rawTotal: 'x'.repeat(40) });
    expect(snapshotRow(snap, 'gold')?.itemTotal).toBeNull();
    expect(snap.warnings).toHaveLength(32);
    expect(snap.warnings[1]).toHaveLength(200);
  });
});

describe('renderResourceSnapshotText', () => {
  const cst = (at: number): string => `CST(${at})`;

  it('renders header, four rows in panel order, precision footer and no warning line when clean', () => {
    const snap = emptyResourceSnapshot(0, 42);
    for (const row of snap.rows) {
      row.itemTotal = TRUTH[row.type].item; row.rawItem = TRUTH[row.type].rawItem;
      row.total = TRUTH[row.type].total; row.rawTotal = TRUTH[row.type].rawTotal;
    }
    const lines = renderResourceSnapshotText(snap, { accountName: '主号', formatTime: cst }).split('\n');
    expect(lines).toEqual([
      '实例 0「主号」资源统计（北京时间 CST(42)）',
      '金币　道具 2.9亿　资源 11.1亿',
      '木材　道具 3.2亿　资源 4.1亿',
      '铁矿石　道具 2亿　资源 22.4亿',
      '魔水　道具 6.2亿　资源 7.2亿',
      PANEL_PRECISION_NOTE,
    ]);
    expect(PANEL_PRECISION_NOTE).toContain('0.1亿');
  });

  it('falls back to raw text, then 读不出, and appends warnings', () => {
    const snap = emptyResourceSnapshot(3, 7);
    snapshotRow(snap, 'gold')!.rawItem = '2.?亿';
    snap.warnings.push('金币·道具总量读不出：x', '本套字形缺 5/8');
    const text = renderResourceSnapshotText(snap, { formatTime: cst });
    expect(text.split('\n')[0]).toBe('实例 3资源统计（北京时间 CST(7)）');
    expect(text).toContain('金币　道具 2.?亿　资源 读不出');
    expect(text).toContain('魔水　道具 读不出　资源 读不出');
    expect(text.split('\n').at(-1)).toBe('⚠️ 金币·道具总量读不出：x；本套字形缺 5/8');
  });
});
