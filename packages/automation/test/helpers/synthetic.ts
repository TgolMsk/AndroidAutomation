/**
 * Synthetic frames and templates for Wanlong vision tests. No real game art: every "control" is a seeded noise
 * patch and every digit is a seeded bitmap, drawn into a 2560×1440 RGBA canvas at the reference size so
 * prepareFrame takes the exact point-sampling path and templates cut from it score 1.0 where they were drawn.
 */
import type { PreparedFrame, PreparedTemplate, RawFrame } from '../../src/contracts.js';

export const W = 2560;
export const H = 1440;

type Rgb = [number, number, number];

/** Deterministic LCG in [0, 1). */
export function rng(seed: number): () => number {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function seedOf(id: string): number {
  let h = 2166136261;
  for (const ch of id) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return h;
}

export class Canvas {
  readonly data: Uint8Array;
  constructor(readonly width = W, readonly height = H, fill: Rgb = [200, 200, 200]) {
    this.data = new Uint8Array(width * height * 4);
    this.rect(0, 0, width, height, fill);
  }

  rect(x: number, y: number, w: number, h: number, [r, g, b]: Rgb): this {
    for (let j = Math.max(0, y); j < Math.min(this.height, y + h); j++) {
      for (let i = Math.max(0, x); i < Math.min(this.width, x + w); i++) {
        const o = (j * this.width + i) * 4;
        this.data[o] = r; this.data[o + 1] = g; this.data[o + 2] = b; this.data[o + 3] = 255;
      }
    }
    return this;
  }

  /** A high-variance texture unique to `id` (a stand-in for a UI control). Blocks of 2 px survive shrink=2. */
  stamp(id: string, x: number, y: number, w: number, h: number): this {
    const next = rng(seedOf(id));
    for (let j = 0; j < h; j += 2) {
      for (let i = 0; i < w; i += 2) {
        const v = Math.floor(next() * 256);
        this.rect(x + i, y + j, 2, 2, [v, v, v]);
      }
    }
    return this;
  }

  /** Draw a glyph bitmap (1 = ink) with the given ink gray; background pixels are left untouched. */
  glyph(bitmap: Glyph, x: number, y: number, ink: number): this {
    for (let j = 0; j < bitmap.h; j++) {
      for (let i = 0; i < bitmap.w; i++) if (bitmap.bits[j * bitmap.w + i]) this.rect(x + i, y + j, 1, 1, [ink, ink, ink]);
    }
    return this;
  }

  /** Draw a string of glyphs with `gap` blank columns between them; returns the x after the last glyph. */
  text(font: Font, text: string, x: number, y: number, ink: number, gap = 3): number {
    let cx = x;
    for (const ch of text) {
      const g = font.glyphs.get(ch);
      if (!g) throw new Error(`font has no ${ch}`);
      this.glyph(g, cx, y, ink);
      cx += g.w + gap;
    }
    return cx - gap;
  }

  raw(capturedAt = 1): RawFrame {
    return { width: this.width, height: this.height, data: Uint8Array.from(this.data), capturedAt, format: 1 };
  }
}

export interface Glyph { w: number; h: number; bits: Uint8Array }
export interface Font { glyphs: Map<string, Glyph>; height: number }

/**
 * A seeded bitmap font: each glyph has ink in every column (so column projection yields one segment) and
 * random interior strokes (so glyphs are mutually uncorrelated under TM_CCOEFF_NORMED).
 */
export function makeFont(seed: number, chars = '0123456789:/,.', height = 18): Font {
  const glyphs = new Map<string, Glyph>();
  let k = 0;
  for (const ch of chars) {
    const w = ch === ':' || ch === ',' || ch === '.' ? 5 : 11;
    const next = rng(seed * 131 + k++ * 7919 + 1);
    const bits = new Uint8Array(w * height);
    for (let i = 0; i < w; i++) {
      bits[Math.floor(next() * height) * w + i] = 1;
      // Edge columns carry a single ink pixel, like real anti-aliased glyph edges: two glyphs glued together
      // then have an obvious valley where splitWideSegments cuts them apart.
      if (i === 0 || i === w - 1) continue;
      for (let j = 0; j < height; j++) if (next() < 0.45) bits[j * w + i] = 1;
    }
    glyphs.set(ch, { w, h: height, bits });
  }
  return { glyphs, height };
}

export const SUFFIX: Record<string, string> = { ':': 'colon', '/': 'slash', ',': 'comma', '.': 'dot' };

/** A shrink=1 glyph template: the bitmap with a 2 px background margin, exactly as a crop would be. */
export function glyphTemplate(prefix: string, ch: string, g: Glyph, bg: number, ink: number): PreparedTemplate {
  const m = 2;
  const w = g.w + m * 2;
  const h = g.h + m * 2;
  const gray = new Uint8Array(w * h).fill(bg);
  for (let j = 0; j < g.h; j++) for (let i = 0; i < g.w; i++) if (g.bits[j * g.w + i]) gray[(j + m) * w + i + m] = ink;
  const id = `${prefix}_${SUFFIX[ch] ?? ch}`;
  return {
    id, name: id, gray, width: w, height: h, w, h, refWidth: w, refHeight: h, refW: w, refH: h,
    shrink: 1, threshold: 0.8, std: 50,
  };
}

/** All glyph templates of a font as [id, template] entries. */
export function glyphEntries(prefix: string, font: Font, bg: number, ink: number, only?: string): [string, PreparedTemplate][] {
  return [...font.glyphs].filter(([ch]) => only === undefined || only.includes(ch))
    .map(([ch, g]) => { const t = glyphTemplate(prefix, ch, g, bg, ink); return [t.id, t]; });
}

/** Cut a UI template out of a prepared (shrink=2) frame. Coordinates are reference pixels. */
export function uiTemplate(frame: PreparedFrame, id: string, x: number, y: number, w: number, h: number, threshold = 0.85): PreparedTemplate {
  const s = frame.shrink;
  const tw = Math.round(w / s);
  const th = Math.round(h / s);
  const gray = new Uint8Array(tw * th);
  for (let j = 0; j < th; j++) {
    const from = (Math.round(y / s) + j) * frame.width + Math.round(x / s);
    gray.set(frame.gray.subarray(from, from + tw), j * tw);
  }
  return {
    id, name: id, gray, width: tw, height: th, w: tw, h: th, refWidth: w, refHeight: h, refW: w, refH: h,
    shrink: s, threshold, std: 60,
  };
}

/** A shrink=1 prepared frame built directly from gray values (for OCR unit tests). */
export function grayFrame(width: number, height: number, fill: number): PreparedFrame & { set(x: number, y: number, v: number): void } {
  const gray = new Uint8Array(width * height).fill(fill);
  return {
    gray, width, height, w: width, h: height, shrink: 1, refWidth: width, refHeight: height,
    deviceWidth: width, deviceHeight: height, capturedAt: 1,
    set(x: number, y: number, v: number) { gray[y * width + x] = v; },
  };
}
