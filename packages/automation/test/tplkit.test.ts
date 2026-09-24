import { describe, expect, it } from 'vitest';
import { stdDev } from '../src/vision.js';
import {
  GATHER_CRITICAL_TEMPLATES, GATHER_OPTIONAL_TEMPLATES, GLYPH, TPL, gatherTemplateCoverage, glyphCharOf, tplkit,
} from '../src/wanlong/index.js';

/** A light background with dark vertical bars: one bar per glyph, `widths[i]` wide, 2 px gaps. */
function strip(widths: number[], height = 12): { w: number; h: number; gray: Uint8Array } {
  const w = widths.reduce((sum, width) => sum + width + 3, 3);
  const gray = new Uint8Array(w * height).fill(220);
  let x = 3;
  for (const width of widths) {
    for (let y = 3; y < height - 3; y++) for (let i = 0; i < width; i++) gray[y * w + x + i] = 20 + ((i * 37 + y * 11) % 40);
    x += width + 3;
  }
  return { w, h: height, gray };
}

describe('tplkit glyph kits', () => {
  it('cuts one job per character with equal heights, digit tags and loader-compatible ids', () => {
    const chars = '0123456789:,/.%';
    const g = strip([...chars].map((_, i) => 3 + (i % 3)));
    const result = tplkit.cutGlyphJobs(g, {
      frame: '/tmp/frames/panel.png', rect: { x: 100, y: 200, w: g.w, h: g.h }, polarity: 'dark', thr: 60, chars, prefix: 'dig_panel_level',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ids).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'colon', 'comma', 'slash', 'dot', 'percent']
      .map((suffix) => `dig_panel_level_${suffix}`));
    expect(new Set(result.jobs.map((job) => job.crop.h))).toEqual(new Set([result.glyphH]));
    expect(result.glyphH).toBe(6 + 4); // rows 3..8 plus pad 2 on both sides
    for (const job of result.jobs) {
      expect(job).toMatchObject({ threshold: 0.78, tags: ['digit', 'dig_panel_level'], frame: '/tmp/frames/panel.png' });
      expect(job.note).toContain('panel.png 的 100,200');
      // Round trip: the gather loader turns every generated id back into its character.
      const char = glyphCharOf(job.id, 'dig_panel_level');
      expect(char).not.toBeNull();
      expect(tplkit.glyphTemplateId('dig_panel_level', char!)).toBe(job.id);
      expect(tplkit.glyphIdToChar(job.id, 'dig_panel_level')).toBe(char);
    }
    expect(result.jobs[0]!.crop).toEqual({ x: 100 + 3 - 2, y: 200 + 3 - 2, w: 3 + 4, h: 10 });
  });

  it('skips duplicate characters and reports a segment-count mismatch instead of emitting half a set', () => {
    const g = strip([3, 3, 3]);
    const dup = tplkit.cutGlyphJobs(g, { frame: 'f.png', rect: { x: 0, y: 0, w: g.w, h: g.h }, polarity: 'dark', thr: 60, chars: '101', prefix: 'dig_x' });
    expect(dup.ok && dup.ids).toEqual(['dig_x_1', 'dig_x_0']);
    const wrong = tplkit.cutGlyphJobs(g, { frame: 'f.png', rect: { x: 0, y: 0, w: g.w, h: g.h }, polarity: 'dark', thr: 60, chars: '12', prefix: 'dig_x' });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) {
      expect(wrong.warn).toContain('段数与给定字符数不符');
      expect(wrong.segs).toHaveLength(3);
    }
    expect(() => tplkit.cutGlyphJobs({ w: 5, h: 5, gray: new Uint8Array(25).fill(9) },
      { frame: 'f.png', rect: { x: 0, y: 0, w: 5, h: 5 }, polarity: 'dark', thr: 60, chars: '1', prefix: 'dig_x' })).toThrow('没有前景像素');
    expect(() => tplkit.charSuffix('#')).toThrow('未支持的字符');
  });

  it('analyzes a region like the variance guard and pads OCR search windows past the widest glyph', () => {
    const g = strip([4, 4]);
    const report = tplkit.analyzeRegion(g, { x: 10, y: 20, w: g.w, h: g.h }, 'dark', 45);
    const sw = Math.floor(g.w / 2);
    const sh = Math.floor(g.h / 2);
    const small = new Uint8Array(sw * sh);
    for (let j = 0; j < sh; j++) for (let i = 0; i < sw; i++) small[j * sw + i] = g.gray[j * 2 * g.w + i * 2]!;
    expect(report.stdShrink2).toBe(Number(stdDev(small).toFixed(1)));
    expect(report.bg).toBe(220);
    expect(report.colSegs).toEqual([{ x: 13, w: 4 }, { x: 20, w: 4 }]);
    expect(report.tight).toEqual({ x: 13, y: 23, w: 11, h: 6 });
    expect(tplkit.ocrSegmentRoi({ x0: 5, x1: 6 }, { x: 100, y: 50, w: 40, h: 20 }, 20))
      .toEqual({ x: 100 + 5 - 12, y: 46, w: 2 + 24, h: 28 });
    expect(tplkit.pickBest([{ id: 'a', score: 0.5 }, { id: 'b', score: 0.9 }, { id: 'c', score: 0.7 }]))
      .toMatchObject({ id: 'b', score: 0.9, second: 0.7 });
  });

  it('applies the verify criteria: score ≥ 0.95, within ±2 px, and every negative misses', () => {
    const hit = { found: true, score: 0.96, x: 101, y: 52 };
    expect(tplkit.verifyVerdict(hit, [100, 50], [{ found: false }]).ok).toBe(true);
    expect(tplkit.verifyVerdict(hit, [100, 49], [{ found: false }]).posOk).toBe(false);
    expect(tplkit.verifyVerdict({ ...hit, score: 0.949 }, undefined, []).ok).toBe(false);
    expect(tplkit.verifyVerdict(hit, undefined, [{ found: false }, { found: true }])).toMatchObject({ ok: false, negOk: false, posOk: true });
  });
});

describe('gather template coverage', () => {
  it('lists missing critical / optional templates, compile failures and glyph digits', () => {
    const templates = [
      ...GATHER_CRITICAL_TEMPLATES.filter((id) => id !== TPL.btnMarch).map((id) => ({ id })),
      { id: TPL.navMapToggle },
      ...['0', '1', '2', '3', '4', '5', '6', '7', '8'].map((d) => ({ id: `${GLYPH.panelLevel}_${d}`, tags: ['digit', GLYPH.panelLevel] })),
      { id: `${GLYPH.dark20}_d5`, tags: ['digit', GLYPH.dark20] }, // the original tplkit's suffix: not loadable
    ];
    const coverage = gatherTemplateCoverage(templates, [{ id: TPL.btnSearch, reason: '方差过低' }]);
    expect(coverage.ready).toBe(false);
    expect(coverage.critical.map((item) => [item.id, item.state])).toEqual([[TPL.btnSearch, 'failed'], [TPL.btnMarch, 'missing']]);
    expect(coverage.critical[1]!.label).toContain('行军按钮');
    expect(coverage.optional.map((item) => item.id)).not.toContain(TPL.navMapToggle);
    expect(coverage.optional).toHaveLength(GATHER_OPTIONAL_TEMPLATES.length - 1);
    const panel = coverage.glyphs.find((item) => item.name === GLYPH.panelLevel)!;
    expect(panel.missingDigits).toEqual(['9']);
    expect(coverage.glyphs.find((item) => item.name === GLYPH.dark20)!.missingDigits).toHaveLength(10);
    expect(gatherTemplateCoverage(GATHER_CRITICAL_TEMPLATES.map((id) => ({ id }))).ready).toBe(true);
  });
});
