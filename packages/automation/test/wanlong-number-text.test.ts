/**
 * 列投影数字识别 readNumberText（原版 scheduler/digits.ts）与解析器。
 * 真机字形不能进仓库，这里用种子位图字体合成：每个字位的前景列连续、字与字之间有空列，与游戏位图字体同构。
 */
import { describe, expect, it } from 'vitest';
import {
  CLOCK_PATTERN, COORD_PATTERN, FRACTION_PATTERN, buildGlyphSet, glyphChars, parseAmount, parseClockMs,
  parseCoord, parseFraction, readNumberText,
} from '../src/wanlong/index.js';
import { glyphEntries, grayFrame, makeFont, type Font } from './helpers/synthetic.js';

const font = makeFont(7);

function draw(frame: ReturnType<typeof grayFrame>, f: Font, text: string, x: number, y: number, ink: number, gap = 3): void {
  let cx = x;
  for (const ch of text) {
    const g = f.glyphs.get(ch)!;
    for (let j = 0; j < g.h; j++) for (let i = 0; i < g.w; i++) if (g.bits[j * g.w + i]) frame.set(cx + i, y + j, ink);
    cx += g.w + gap;
  }
}

const darkSet = () => buildGlyphSet('dig_dark20', '通用数字(浅底深字)', 'dark', glyphEntries('dig_dark20', font, 200, 40));

describe('readNumberText', () => {
  it('reads a clock by column projection and argmax, confidently', async () => {
    const frame = grayFrame(320, 60, 200);
    draw(frame, font, '01:44:06', 20, 20, 40);
    const r = await readNumberText(frame, { x: 10, y: 16, w: 260, h: 26 }, darkSet(), { pattern: CLOCK_PATTERN });
    expect(r.text).toBe('01:44:06');
    expect(r.confident).toBe(true);
    expect(r.reason).toBeUndefined();
    expect(r.detail).toHaveLength(8);
    expect(parseClockMs(r.text)).toBe((1 * 3600 + 44 * 60 + 6) * 1000);
  });

  it('splits two glyphs glued into one segment at the valley column', async () => {
    const frame = grayFrame(320, 60, 200);
    draw(frame, font, '0', 20, 20, 40);
    draw(frame, font, '44', 34, 20, 40, 0);
    draw(frame, font, '8', 59, 20, 40);
    const r = await readNumberText(frame, { x: 10, y: 16, w: 100, h: 26 }, darkSet());
    expect(r.text).toBe('0448');
  });

  it('flattens a half-green / half-gray background under light digits (the 01:44:06 progress-bar case)', async () => {
    const light = buildGlyphSet('dig_light16', '进度条数字(深底白字)', 'light', glyphEntries('dig_light16', font, 170, 245));
    const frame = grayFrame(320, 60, 170);
    // Green part of the load bar (darker gray) ends in the middle of the second "4".
    for (let y = 0; y < 60; y++) for (let x = 0; x < 70; x++) frame.set(x, y, 60);
    draw(frame, font, '01:44:06', 20, 20, 245);
    const roi = { x: 10, y: 16, w: 260, h: 26 };
    const flat = await readNumberText(frame, roi, light, { pattern: CLOCK_PATTERN, binarize: true });
    expect(flat.text).toBe('01:44:06');
    const twoPass = await readNumberText(frame, roi, light, { pattern: CLOCK_PATTERN });
    expect(twoPass.text).toBe('01:44:06');
    const plain = await readNumberText(frame, roi, light, { pattern: CLOCK_PATTERN, binarize: false });
    const straddled = (r: typeof plain) => r.detail.find((d) => d.x <= 70 && d.x + d.w > 70)?.score ?? -1;
    expect(straddled(flat)).toBeGreaterThan(straddled(plain));
  });

  it('flips polarity automatically when the set was declared with the wrong one', async () => {
    const wrong = buildGlyphSet('dig_dark20', '极性写错的字形', 'light', glyphEntries('dig_dark20', font, 200, 40));
    const frame = grayFrame(200, 60, 200);
    draw(frame, font, '2/5', 20, 20, 40);
    const r = await readNumberText(frame, { x: 10, y: 16, w: 120, h: 26 }, wrong, { pattern: FRACTION_PATTERN });
    expect(r.text).toBe('2/5');
    expect(parseFraction(r.text)).toEqual({ used: 2, total: 5 });
  });

  it('never guesses: a glyph missing from the set yields null and names the characters it has', async () => {
    const partial = buildGlyphSet('dig_dark20', '缺字的字形', 'dark', glyphEntries('dig_dark20', font, 200, 40, '0123568:'));
    expect(glyphChars(partial)).toBe('0123568:');
    const frame = grayFrame(320, 60, 200);
    draw(frame, font, '01:44:06', 20, 20, 40);
    const r = await readNumberText(frame, { x: 10, y: 16, w: 260, h: 26 }, partial, { pattern: CLOCK_PATTERN });
    expect(r.text).toBeNull();
    expect(r.reason).toContain('本套字形只有 0123568:');
    expect(r.reason).toContain('认不出来');
  });

  it('rejects implausible segmentations, patterns and lengths', async () => {
    const frame = grayFrame(600, 60, 200);
    draw(frame, font, '12345678901234567890', 10, 20, 40, 3);
    const many = await readNumberText(frame, { x: 0, y: 16, w: 600, h: 26 }, darkSet());
    expect(many.text).toBeNull();
    expect(many.reason).toContain('切出了');

    const clock = grayFrame(200, 60, 200);
    draw(clock, font, '12:3', 20, 20, 40);
    const bad = await readNumberText(clock, { x: 10, y: 16, w: 120, h: 26 }, darkSet(), { pattern: CLOCK_PATTERN });
    expect(bad.text).toBeNull();
    expect(bad.reason).toContain('不符合预期格式');

    const count = await readNumberText(clock, { x: 10, y: 16, w: 120, h: 26 }, darkSet(), { expectChars: 5 });
    expect(count.text).toBeNull();

    const empty = await readNumberText(grayFrame(200, 60, 200), { x: 10, y: 16, w: 120, h: 26 }, darkSet());
    expect(empty.text).toBeNull();
    expect(empty.reason).toContain('没有找到任何字形');

    const outside = await readNumberText(clock, { x: 500, y: 16, w: 120, h: 26 }, darkSet());
    expect(outside.reason).toContain('超出画面范围');
  });

  it('refuses shrink≠1 frames and templates, and an empty glyph set', async () => {
    const frame = { ...grayFrame(100, 40, 200), shrink: 2 };
    await expect(readNumberText(frame, { x: 0, y: 0, w: 50, h: 20 }, darkSet())).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    const [id, tpl] = glyphEntries('dig_dark20', font, 200, 40, '1')[0]!;
    expect(() => buildGlyphSet('dig_dark20', 'x', 'dark', [[id, { ...tpl, shrink: 2 }]])).toThrow(/shrink=2/);
    expect(() => buildGlyphSet('dig_missing', '不存在', 'dark', [])).toThrow(expect.objectContaining({ code: 'TEMPLATE_NOT_FOUND' }));
  });
});

describe('scheduler number parsers', () => {
  it('parse clocks, fractions, coordinates and amounts strictly', () => {
    expect(parseClockMs('00:01:04')).toBe(64_000);
    expect(parseClockMs('01:04')).toBe(64_000);
    expect(parseClockMs('00:60:00')).toBeNull();
    expect(parseClockMs('00:00:60')).toBeNull();
    expect(parseClockMs('1:2:3:4')).toBeNull();
    expect(parseClockMs(null)).toBeNull();
    expect(parseFraction('0/5')).toEqual({ used: 0, total: 5 });
    expect(parseFraction('3/0')).toBeNull();
    expect(parseFraction('1234/5')).toBeNull();
    expect(parseCoord('1231,717')).toBe('1231,717');
    expect(parseCoord('12345,1')).toBeNull();
    expect(parseAmount('1,260,000')).toBe(1_260_000);
    expect(parseAmount('12a')).toBeNull();
    expect(COORD_PATTERN.test('615,535')).toBe(true);
  });
});
