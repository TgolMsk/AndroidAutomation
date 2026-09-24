/**
 * Synthetic frames and template sets for offline Wanlong tests.
 * Real game screenshots and templates never enter the repository, so every picture here is generated.
 * All pixels are neutral gray (R = G = B) so every grayscale formula agrees.
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import type { RawFrame, Rect } from '../../src/index.js';

export const REF_W = 2560;
export const REF_H = 1440;
export const GAME = 'com.lilithgames.samo.android.cn';

/** Deterministic LCG in [0, 1). */
export function rng(seed: number): () => number {
  let value = (seed * 2654435761) >>> 0 || 1;
  return () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value / 0x1_0000_0000;
  };
}

/** A gray image stored as one byte per pixel. */
export interface Gray { w: number; h: number; px: Uint8Array }

/** High-texture block noise; blocks stay aligned to the patch origin so shrink=2 sampling is stable. */
export function blockPatch(w: number, h: number, seed: number, block = 8): Gray {
  const next = rng(seed);
  const cols = Math.ceil(w / block);
  const rows = Math.ceil(h / block);
  const values = Array.from({ length: cols * rows }, () => 30 + Math.floor(next() * 200));
  const px = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) px[y * w + x] = values[Math.floor(y / block) * cols + Math.floor(x / block)]!;
  }
  return { w, h, px };
}

/** A dark-on-light "glyph": random 3 px dark strokes inside a light cell, seeded by the character. */
export function glyphPatch(char: string, w: number, h: number): Gray {
  const next = rng(char.charCodeAt(0) * 7919 + w * 31 + h);
  const px = new Uint8Array(w * h).fill(246);
  const block = w < 16 ? 2 : 3;
  for (let by = 1; by * block < h - 1; by++) {
    for (let bx = 1; bx * block < w - 1; bx++) {
      if (next() > 0.45) continue;
      const v = Math.floor(next() * 34);
      for (let y = by * block; y < Math.min(h - 1, by * block + block); y++) {
        for (let x = bx * block; x < Math.min(w - 1, bx * block + block); x++) px[y * w + x] = v;
      }
    }
  }
  return { w, h, px };
}

export function flat(w: number, h: number, value: number): Gray {
  return { w, h, px: new Uint8Array(w * h).fill(value) };
}

export async function toPng(g: Gray): Promise<Buffer> {
  const rgb = Buffer.alloc(g.w * g.h * 3);
  for (let i = 0; i < g.px.length; i++) rgb[i * 3] = rgb[i * 3 + 1] = rgb[i * 3 + 2] = g.px[i]!;
  return sharp(rgb, { raw: { width: g.w, height: g.h, channels: 3 } }).png().toBuffer();
}

/** A mutable screen in reference pixels. */
export class Screen {
  readonly px: Uint8Array;
  constructor(readonly w = REF_W, readonly h = REF_H, seed = 1) {
    // Low-contrast background noise: never zero variance, never similar to a template.
    const bg = blockPatch(w, h, seed, 16);
    this.px = bg.px.map((v) => 90 + Math.floor(v / 12));
  }

  paste(g: Gray, x: number, y: number): this {
    for (let row = 0; row < g.h; row++) {
      const ty = y + row;
      if (ty < 0 || ty >= this.h) continue;
      for (let col = 0; col < g.w; col++) {
        const tx = x + col;
        if (tx < 0 || tx >= this.w) continue;
        this.px[ty * this.w + tx] = g.px[row * g.w + col]!;
      }
    }
    return this;
  }

  fill(r: Rect, value: number): this {
    return this.paste(flat(r.w, r.h, value), r.x, r.y);
  }

  clone(): Screen {
    const copy = new Screen(this.w, this.h);
    copy.px.set(this.px);
    return copy;
  }

  raw(capturedAt = 0): RawFrame {
    const data = new Uint8Array(this.w * this.h * 4);
    for (let i = 0; i < this.px.length; i++) {
      const v = this.px[i]!;
      data[i * 4] = v; data[i * 4 + 1] = v; data[i * 4 + 2] = v; data[i * 4 + 3] = 255;
    }
    return { width: this.w, height: this.h, data, capturedAt, format: 1 };
  }

  async png(): Promise<Buffer> {
    return toPng({ w: this.w, h: this.h, px: this.px });
  }

  /** Gray crop of this screen after resizing it to width×height (an AVD-resolution capture). */
  async cropResized(width: number, height: number, r: Rect): Promise<Gray> {
    const { data } = await sharp(await this.png()).resize(width, height, { fit: 'fill' })
      .extract({ left: r.x, top: r.y, width: r.w, height: r.h }).greyscale().raw().toBuffer({ resolveWithObject: true });
    return { w: r.w, h: r.h, px: new Uint8Array(data) };
  }

  /** Resize (for scaled-frame tests). */
  async rawResized(width: number, height: number): Promise<RawFrame> {
    const { data, info } = await sharp(await this.png()).resize(width, height, { fit: 'fill' })
      .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { width: info.width, height: info.height, data: new Uint8Array(data), capturedAt: 0, format: 1 };
  }
}

export interface SynthTemplate {
  id: string;
  name?: string;
  image: Gray;
  /** Source-frame size the crop came from (defaults to the set reference size). */
  authoredWidth?: number;
  authoredHeight?: number;
  bounds: Rect;
  defaultRoi?: Rect;
  threshold?: number;
  tags?: string[];
}

/** Write a manifest.json + PNGs in the wanlong-panel template-set shape. */
export async function writeTemplateSet(
  entries: SynthTemplate[],
  options: { dir?: string; id?: string; packageName?: string | null; refWidth?: number; refHeight?: number } = {},
): Promise<string> {
  const dir = options.dir ?? await mkdtemp(join(tmpdir(), 'avdm-wanlong-synth-'));
  await mkdir(dir, { recursive: true });
  const templates = [];
  for (const entry of entries) {
    const file = `${entry.id}.png`;
    await writeFile(join(dir, file), await toPng(entry.image));
    templates.push({
      id: entry.id, name: entry.name ?? entry.id, file,
      authoredWidth: entry.authoredWidth ?? options.refWidth ?? REF_W,
      authoredHeight: entry.authoredHeight ?? options.refHeight ?? REF_H,
      bounds: entry.bounds,
      ...(entry.defaultRoi ? { defaultRoi: entry.defaultRoi } : {}),
      ...(entry.threshold !== undefined ? { threshold: entry.threshold } : {}),
      ...(entry.tags ? { tags: entry.tags } : {}),
    });
  }
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({
    id: options.id ?? 'tset_synthetic', name: '合成模板集',
    ...(options.packageName === null ? {} : { packageName: options.packageName ?? GAME }),
    refWidth: options.refWidth ?? REF_W, refHeight: options.refHeight ?? REF_H, templates,
  }, null, 2));
  return dir;
}

/** Templates loadGatherTemplates insists on; they are generated but never shown on any synthetic screen. */
export const CRITICAL_IDS = [
  'tpl_world_search_icon', 'tpl_btn_search', 'tpl_label_level', 'tpl_btn_gather', 'tpl_value_none',
  'tpl_btn_create_troop', 'tpl_btn_march', 'tpl_panel_title_troop', 'tpl_queue_icon_panel',
];

export function criticalTemplates(seedBase = 9000): SynthTemplate[] {
  return CRITICAL_IDS.map((id, i) => ({
    id, image: blockPatch(64, 48, seedBase + i), bounds: { x: 100 + i * 80, y: 60, w: 64, h: 48 }, threshold: 0.85,
  }));
}
