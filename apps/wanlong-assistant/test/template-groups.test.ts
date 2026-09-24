import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TemplateDefinition } from '@avdm/automation';
import {
  FILTER_ALL, FILTER_UI, filterTemplates, groupTemplates, isGlyphTemplate, matchesTemplateQuery, pageButtons, pageContaining, pageOf,
  pickableTemplates, templateFilterOptions, templateGroupOf,
} from '../src/renderer/views/templates/template-groups';
import { ThumbCache } from '../src/renderer/views/templates/thumb-cache';

const manifest = JSON.parse(readFileSync(path.join(__dirname, '..', 'resources', 'templates', 'tset_mtugr5sx0iwc', 'manifest.json'), 'utf8')) as
  { templates: TemplateDefinition[] };
const bundled = manifest.templates;

const t = (id: string, name: string, tags?: string[]): Pick<TemplateDefinition, 'id' | 'name' | 'tags'> => ({ id, name, ...(tags ? { tags } : {}) });

describe('template groups (library list and script pickers)', () => {
  it('splits the bundled set into screen groups with the digit glyphs last, by glyph set', () => {
    const groups = groupTemplates(bundled);
    expect(groups.map((group) => group.label)).toEqual(['资源统计', '弹窗与异常', '导航与主界面', '搜索面板', '资源点卡片', '部队管理', '创建部队与行军', '数字字形']);
    expect(groups.reduce((sum, group) => sum + group.templates.length, 0)).toBe(bundled.length);
    const glyphs = groups.at(-1)!;
    expect(glyphs.templates.every(isGlyphTemplate)).toBe(true);
    expect(glyphs.subsets!.map((subset) => subset.name)).toContain('dig_panel_level');
    // A readable label from the first glyph with one (「等级数字-7」 → 等级数字), else the set name.
    expect(glyphs.subsets!.find((subset) => subset.name === 'dig_panel_level')!.label).toBe('等级数字');
    // Resource statistics before dialogs: 「资源统计-弹窗标题」 is not a popup.
    expect(templateGroupOf(bundled.find((item) => item.id === 'tpl_title_res_stats')!).label).toBe('资源统计');
    expect(templateGroupOf(bundled.find((item) => item.id === 'tpl_dlg_kicked')!).label).toBe('弹窗与异常');
  });

  it('groups templates of other sets by tags, id prefix, then the screen word of the name', () => {
    expect(templateGroupOf(t('x1', '随便', ['dialog'])).key).toBe('dialog');
    expect(templateGroupOf(t('tpl_nav_home', '主页按钮')).key).toBe('nav');
    expect(templateGroupOf(t('abc', '背包-整理按钮'))).toEqual({ key: 'name:背包', label: '背包' });
    expect(templateGroupOf(t('abc', '一个没有分隔符的名字'))).toEqual({ key: 'other', label: '未分组' });
    const groups = groupTemplates([t('a', '一个没有分隔符的名字'), t('b', '背包-整理'), t('c', '通用对话框-确定'), t('dig_x_1', 'dig_x 字形 1', ['digit', 'dig_x'])]);
    expect(groups.map((group) => group.key)).toEqual(['dialog', 'name:背包', 'other', 'glyph']);
  });

  it('filters by category and search, and pages the list', () => {
    const options = templateFilterOptions(bundled);
    const glyphCount = bundled.filter(isGlyphTemplate).length;
    expect(options.main[0]).toEqual({ value: FILTER_UI, label: '界面模板（不含数字字形）', count: bundled.length - glyphCount });
    expect(options.main.at(-1)).toMatchObject({ value: FILTER_ALL, count: bundled.length });
    expect(options.glyphs[0]).toMatchObject({ value: 'glyph', count: glyphCount });
    expect(filterTemplates(bundled, FILTER_UI, '').some(isGlyphTemplate)).toBe(false);
    expect(filterTemplates(bundled, 'glyph:dig_panel_level', '').map((item) => item.id)).toContain('dig_panel_level_7');
    // Several words must all match; tags, ids and the group label count.
    expect(filterTemplates(bundled, FILTER_ALL, '顶号 kicked').map((item) => item.id)).toEqual(['tpl_dlg_kicked']);
    expect(matchesTemplateQuery(bundled.find((item) => item.id === 'tpl_btn_gather')!, '资源点卡片')).toBe(true);

    const items = Array.from({ length: 30 }, (_, i) => ({ id: `t${i}`, name: `模板 ${i}` }));
    expect(pageOf(items, 0, 12)).toMatchObject({ page: 0, pages: 3, total: 30, from: 1, to: 12 });
    expect(pageOf(items, 9, 12)).toMatchObject({ page: 2, from: 25, to: 30 });
    expect(pageOf([], 3, 12)).toMatchObject({ page: 0, pages: 1, from: 0, to: 0 });
    expect(pageContaining(items, 't13', 12)).toBe(1);
    expect(pageContaining(items, 'nope', 12)).toBeNull();
    expect(pageButtons(0, 5)).toEqual([0, 1, 2, 3, 4]);
    expect(pageButtons(0, 12)).toEqual([0, 1, 2, 3, 'gap', 11]);
    expect(pageButtons(6, 12)).toEqual([0, 'gap', 5, 6, 7, 'gap', 11]);
    expect(pageButtons(11, 12)).toEqual([0, 'gap', 8, 9, 10, 11]);
  });

  it('script pickers leave the glyphs out unless already chosen or asked for', () => {
    const pickable = pickableTemplates(bundled);
    expect(pickable.some(isGlyphTemplate)).toBe(false);
    expect(pickableTemplates(bundled, ['dig_panel_level_7']).map((item) => item.id)).toContain('dig_panel_level_7');
    expect(pickableTemplates(bundled, [], 'dig_').some(isGlyphTemplate)).toBe(true);
    expect(pickableTemplates(bundled, [], '字形').some(isGlyphTemplate)).toBe(true);
  });

  it('caches thumbnails per id + version and revokes them on dispose', async () => {
    const loads: string[] = [];
    const revoked: string[] = [];
    let n = 0;
    const cache = new ThumbCache(async (id) => { loads.push(id); if (id === 'bad') throw new Error('missing'); return new Uint8Array([1]); },
      () => `blob:${++n}`, (url) => revoked.push(url));
    expect(cache.peek('a', 1)).toBeUndefined();
    const [first, second] = await Promise.all([cache.get('a', 1), cache.get('a', 1)]);
    expect(first).toBe('blob:1');
    expect(second).toBe('blob:1');
    expect(cache.peek('a', 1)).toBe('blob:1');
    expect(await cache.get('a', 2)).toBe('blob:2');
    expect(await cache.get('bad')).toBeNull();
    expect(cache.peek('bad')).toBeNull();
    expect(loads).toEqual(['a', 'a', 'bad']);
    cache.dispose();
    expect(revoked).toEqual(['blob:1', 'blob:2']);
    expect(cache.peek('a', 1)).toBeUndefined();
  });
});
