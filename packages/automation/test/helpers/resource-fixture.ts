/**
 * Synthetic 「道具 → 资源 → 资源统计」 screens and a matching template set, laid out per resource-stats.json.
 * Glyphs, the 亿 unit and every UI anchor are generated textures; nothing is cropped from the real game.
 */
import type { RawFrame } from '../../src/index.js';
import type { ResourceType } from '../../src/wanlong/index.js';
import { RESOURCE_STATS_LAYOUT } from '../../src/wanlong/index.js';
import {
  REF_H, REF_W, Screen, blockPatch, criticalTemplates, glyphPatch, writeTemplateSet, type Gray, type SynthTemplate,
} from './synth.js';

export const TRUTH: Record<ResourceType, { item: number; total: number; rawItem: string; rawTotal: string }> = {
  gold: { item: 290_000_000, total: 1_110_000_000, rawItem: '2.9亿', rawTotal: '11.1亿' },
  wood: { item: 320_000_000, total: 410_000_000, rawItem: '3.2亿', rawTotal: '4.1亿' },
  iron: { item: 200_000_000, total: 2_240_000_000, rawItem: '2.0亿', rawTotal: '22.4亿' },
  mana: { item: 620_000_000, total: 720_000_000, rawItem: '6.2亿', rawTotal: '7.2亿' },
};

const GLYPH_SIZE: Record<string, [number, number]> = {
  '0': [21, 31], '1': [19, 30], '2': [21, 30], '3': [21, 31], '4': [23, 30], '5': [21, 30],
  '6': [21, 31], '7': [21, 30], '8': [21, 31], '9': [21, 30], '.': [12, 12], ',': [12, 16],
};
const UNIT_SIZE = 37;

const glyphCache = new Map<string, Gray>();
export function glyphImage(char: string): Gray {
  let g = glyphCache.get(char);
  if (!g) {
    const [w, h] = GLYPH_SIZE[char] ?? [UNIT_SIZE, UNIT_SIZE];
    g = glyphPatch(char, w, h);
    glyphCache.set(char, g);
  }
  return g;
}

/** Paste a value such as `2.9亿` centred in a table cell, with the spacing measured on the real table. */
export function drawValue(screen: Screen, text: string, centerX: number, centerY: number): void {
  const parts = [...text].map((char) => ({ char, img: glyphImage(char) }));
  const gapBefore = (i: number): number => (i === 0 ? 0 : parts[i]!.char === '亿' || parts[i]!.char === '万' ? 4 : 5);
  const total = parts.reduce((sum, p, i) => sum + gapBefore(i) + p.img.w, 0);
  let x = Math.round(centerX - total / 2);
  parts.forEach((p, i) => {
    x += gapBefore(i);
    const top = p.char === '亿' || p.char === '万' ? centerY - 18
      : p.char === '.' || p.char === ',' ? centerY + 3
        : centerY - 15;
    screen.paste(p.img, x, top);
    x += p.img.w;
  });
}

/** UI anchors: even-aligned so shrink=2 point sampling and cubic template downsampling agree. */
export const UI = {
  cityToggle: { id: 'tpl_nav_city_toggle', bounds: { x: 50, y: 1270, w: 150, h: 140 }, roi: { x: 10, y: 1230, w: 280, h: 210 } },
  navItems: { id: 'tpl_nav_items', bounds: { x: 2046, y: 1312, w: 108, h: 66 }, roi: { x: 1980, y: 1270, w: 240, h: 170 } },
  btnResStats: { id: 'tpl_btn_res_stats', bounds: { x: 1480, y: 234, w: 200, h: 62 }, roi: { x: 1380, y: 200, w: 400, h: 130 } },
  titleItemsRes: { id: 'tpl_title_items_res', bounds: { x: 134, y: 34, w: 122, h: 66 }, roi: { x: 100, y: 10, w: 220, h: 110 } },
  titleResStats: { id: 'tpl_title_res_stats', bounds: { x: 1156, y: 144, w: 236, h: 66 }, roi: { x: 1000, y: 100, w: 560, h: 160 } },
  closeResStats: { id: 'tpl_btn_close_res_stats', bounds: { x: 2068, y: 142, w: 102, h: 102 }, roi: { x: 2000, y: 90, w: 260, h: 220 } },
  labelGold: { id: 'tpl_label_res_gold', bounds: { x: 808, y: 432, w: 78, h: 42 }, roi: { x: 780, y: 412, w: 200, h: 80 } },
  labelWood: { id: 'tpl_label_res_wood', bounds: { x: 808, y: 626, w: 82, h: 44 }, roi: { x: 780, y: 608, w: 200, h: 80 } },
  labelIron: { id: 'tpl_label_res_iron', bounds: { x: 808, y: 822, w: 118, h: 44 }, roi: { x: 780, y: 804, w: 200, h: 80 } },
  labelMana: { id: 'tpl_label_res_mana', bounds: { x: 808, y: 1018, w: 82, h: 42 }, roi: { x: 780, y: 1000, w: 200, h: 80 } },
} as const;

type UiKey = keyof typeof UI;
const uiImage = (key: UiKey): Gray => {
  const b = UI[key].bounds;
  return blockPatch(b.w, b.h, 100 + Object.keys(UI).indexOf(key));
};

export type TableValues = Record<ResourceType, { item: string; total: string }>;
export const TRUTH_VALUES: TableValues = Object.fromEntries(
  Object.entries(TRUTH).map(([type, t]) => [type, { item: t.rawItem, total: t.rawTotal }]),
) as TableValues;

export interface ResourceScreens {
  map: Screen;
  items: Screen;
  dialog: Screen;
  blank: Screen;
}

export function buildScreens(values: TableValues = TRUTH_VALUES, options: { labels?: boolean } = {}): ResourceScreens {
  const paste = (screen: Screen, key: UiKey): Screen => screen.paste(uiImage(key), UI[key].bounds.x, UI[key].bounds.y);
  const map = paste(paste(new Screen(REF_W, REF_H, 11), 'cityToggle'), 'navItems');
  const items = paste(paste(new Screen(REF_W, REF_H, 12), 'btnResStats'), 'titleItemsRes');
  const dialog = new Screen(REF_W, REF_H, 13).fill({ x: 410, y: 200, w: 1735, h: 1050 }, 246);
  paste(dialog, 'titleResStats');
  paste(dialog, 'closeResStats');
  if (options.labels !== false) {
    paste(dialog, 'labelGold'); paste(dialog, 'labelWood'); paste(dialog, 'labelIron'); paste(dialog, 'labelMana');
  }
  for (const row of RESOURCE_STATS_LAYOUT.rows) {
    const v = values[row.type];
    if (v.item) drawValue(dialog, v.item, RESOURCE_STATS_LAYOUT.columns.item.centerX, row.centerY);
    if (v.total) drawValue(dialog, v.total, RESOURCE_STATS_LAYOUT.columns.total.centerX, row.centerY);
  }
  return { map, items, dialog, blank: new Screen(REF_W, REF_H, 14) };
}

export interface FixtureOptions {
  /** Template ids left out of the set. */
  omit?: string[];
  /** Glyph characters present in dig_resstat (default: the real set, missing 5 / 8 / comma). */
  glyphChars?: string;
  /** Include the 万 unit template (the real set does not have it). */
  withWan?: boolean;
  /** Leave the whole glyph set out. */
  noGlyphs?: boolean;
  /** Extra templates (e.g. a popup close button). */
  extra?: SynthTemplate[];
}

export const REAL_GLYPH_CHARS = '01234679.';

/** Write a template set matching buildScreens(). Returns the directory. */
export async function writeResourceTemplateSet(options: FixtureOptions = {}): Promise<string> {
  const omit = new Set(options.omit ?? []);
  const entries: SynthTemplate[] = [...criticalTemplates()];
  for (const key of Object.keys(UI) as UiKey[]) {
    const t = UI[key];
    entries.push({ id: t.id, image: uiImage(key), bounds: t.bounds, defaultRoi: t.roi, threshold: 0.8 });
  }
  entries.push({
    id: 'tpl_resstat_unit_yi', image: glyphImage('亿'), bounds: { x: 1291, y: 434, w: UNIT_SIZE, h: UNIT_SIZE },
    tags: ['resstat_unit'],
  });
  if (options.withWan) {
    entries.push({
      id: 'tpl_resstat_unit_wan', image: glyphImage('万'), bounds: { x: 1291, y: 434, w: UNIT_SIZE, h: UNIT_SIZE },
      tags: ['resstat_unit'],
    });
  }
  if (!options.noGlyphs) {
    for (const char of options.glyphChars ?? REAL_GLYPH_CHARS) {
      const suffix = char === '.' ? 'dot' : char === ',' ? 'comma' : char;
      const img = glyphImage(char);
      entries.push({ id: `dig_resstat_${suffix}`, image: img, bounds: { x: 1233, y: 437, w: img.w, h: img.h }, tags: ['digit', 'dig_resstat'] });
    }
  }
  entries.push(...(options.extra ?? []));
  return writeTemplateSet(entries.filter((e) => !omit.has(e.id)));
}

export function frames(screens: ResourceScreens): Record<keyof ResourceScreens, RawFrame> {
  return {
    map: screens.map.raw(), items: screens.items.raw(), dialog: screens.dialog.raw(), blank: screens.blank.raw(),
  };
}
