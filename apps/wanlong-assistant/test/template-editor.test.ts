import { describe, expect, it } from 'vitest';
import type { MatchResult } from '@avdm/automation';
import {
  buildTemplateDraft, clampTolerance, describeCoverage, importSummary, lowVarianceGuidance, maskBadge, overwriteTarget,
  parseTags, quickPicks, resolutionWarning, saveSuccessDetail, stdBadge, templateIdProblem, templateSummary, testVerdict, validCrop,
} from '../src/renderer/views/templates/template-editor';
import type { TemplateCoverage } from '../src/shared/ipc';

const png = new Uint8Array([1, 2, 3]);
const base = {
  templateId: '', selectedId: null, name: ' 联盟按钮 ', frame: { png, width: 2560, height: 1440 }, crop: { x: 10, y: 20, w: 30, h: 40 },
  roi: null, threshold: 0.85, note: '', tags: '', diffFrames: [], tolerance: 24, confirmOverwrite: false,
};

describe('template page helpers', () => {
  it('interprets the diff-alpha coverage like the original panel', () => {
    expect(describeCoverage(0.05)).toMatchObject({ tone: 'danger', hint: expect.stringContaining('保存会被拒绝') });
    expect(describeCoverage(0.2)).toMatchObject({ tone: 'warning', hint: expect.stringContaining('调大容差') });
    expect(describeCoverage(0.5)).toMatchObject({ tone: 'success', hint: expect.stringContaining('洋红 = 抠掉') });
    expect(describeCoverage(0.98)).toMatchObject({ tone: 'info', hint: expect.stringContaining('不需要去底') });
    expect(clampTolerance(2)).toBe(4);
    expect(clampTolerance(200)).toBe(96);
    expect(clampTolerance(Number.NaN)).toBe(24);
  });

  it('turns TEMPLATE_LOW_VARIANCE into guidance, with the std or the mask numbers', () => {
    const std = lowVarianceGuidance('TEMPLATE_LOW_VARIANCE', '模板「x」方差过低 std=7.46 < 12：TM_CCOEFF_NORMED 会……');
    expect(std).toMatchObject({ kind: 'std', title: '这块区域纹理太单调，不能当模板' });
    expect(std!.paragraphs[0]).toContain('只有 7.5（下限 12）');
    expect(std!.paragraphs.join('')).toContain('有图标、有文字、有明显边缘');
    const mask = lowVarianceGuidance('TEMPLATE_LOW_VARIANCE', '模板「x」透明底抠得太狠：降采样后只剩 30 个不透明像素（4%），低于下限……');
    expect(mask).toMatchObject({ kind: 'mask' });
    expect(mask!.paragraphs[0]).toContain('30 个不透明像素（4%）');
    expect(lowVarianceGuidance('IO_ERROR', 'std=1')).toBeNull();
    expect(lowVarianceGuidance(undefined, 'std=1')).toBeNull();
  });

  it('sends id, note, tags and diff frames on save, and marks explicit overwrites', () => {
    expect(buildTemplateDraft(base)).toEqual({ name: '联盟按钮', image: png, authoredWidth: 2560, authoredHeight: 1440,
      crop: base.crop, threshold: 0.85 });
    const diff = new Uint8Array([9]);
    const draft = buildTemplateDraft({ ...base, templateId: ' dig_panel_level_9 ', note: ' 补字形 ', tags: 'digit, dig_panel_level，digit',
      roi: { x: 0, y: 0, w: 100, h: 100 }, diffFrames: [diff], tolerance: 200 });
    expect(draft).toEqual({ id: 'dig_panel_level_9', name: '联盟按钮', image: png, authoredWidth: 2560, authoredHeight: 1440, crop: base.crop,
      defaultRoi: { x: 0, y: 0, w: 100, h: 100 }, threshold: 0.85, note: '补字形', tags: ['digit', 'dig_panel_level'],
      diffFrames: [diff], diffTolerance: 96 });
    expect(buildTemplateDraft({ ...base, templateId: 'tpl_a', selectedId: 'tpl_a' }).overwrite).toBe(true);
    expect(buildTemplateDraft({ ...base, templateId: 'tpl_a', confirmOverwrite: true }).overwrite).toBe(true);
    expect(buildTemplateDraft({ ...base, templateId: 'tpl_a' }).overwrite).toBeUndefined();
    expect(parseTags('a b,c，a')).toEqual(['a', 'b', 'c']);
  });

  it('validates fixed ids, finds the template an id would replace and checks the 8×8 crop floor', () => {
    expect(templateIdProblem('')).toBeNull();
    expect(templateIdProblem('tpl_btn_close_popup')).toBeNull();
    expect(templateIdProblem('ab')).toContain('3~64 位');
    expect(templateIdProblem('tpl.dot')).toContain('字母、数字、下划线、短横线');
    const templates = [{ id: 'tpl_a', name: 'A' }, { id: 'tpl_b', name: 'B' }];
    expect(overwriteTarget('tpl_b', 'tpl_a', templates)).toEqual({ id: 'tpl_b', name: 'B' });
    expect(overwriteTarget('tpl_a', 'tpl_a', templates)).toBeNull();
    expect(overwriteTarget('tpl_new', null, templates)).toBeNull();
    expect(validCrop({ x: 0, y: 0, w: 8, h: 8 }, 10, 10)).toBe(true);
    expect(validCrop({ x: 0, y: 0, w: 7, h: 8 }, 10, 10)).toBe(false);
    expect(validCrop({ x: 3, y: 0, w: 8, h: 8 }, 10, 10)).toBe(false);
  });

  it('renders badges, summaries, verdicts and resolution warnings in Chinese', () => {
    expect(stdBadge(17.9)).toMatchObject({ tone: 'warning', label: 'σ 17.9', hint: expect.stringContaining('换一块有图标或文字的区域') });
    expect(stdBadge(18)).toMatchObject({ tone: 'success' });
    expect(stdBadge(undefined)).toBeNull();
    expect(maskBadge(0.343)).toMatchObject({ label: '透明底 34%' });
    expect(templateSummary({ bounds: { x: 0, y: 0, w: 110, h: 90 }, defaultRoi: { x: 0, y: 0, w: 1, h: 1 }, threshold: 0.78 })).toBe('110×90｜已设 ROI｜阈值 0.78');
    expect(templateSummary({ bounds: { x: 0, y: 0, w: 110, h: 90 } })).toBe('110×90｜全屏搜索');
    expect(saveSuccessDetail('按钮', 41.26, 0.5)).toBe('模板「按钮」已保存（标准差 41.3，透明底 50%）');
    const hit = { templateId: 'a', found: true, score: 0.97654, threshold: 0.85, x: 1, y: 2, w: 3, h: 4, centerX: 3, centerY: 4, elapsedMs: 1.5 } as MatchResult;
    expect(testVerdict(hit)).toEqual({ found: true, title: '命中：得分 0.9765（阈值 0.85）', detail: '落点（参考坐标）3,4，耗时 1.5ms' });
    expect(testVerdict({ ...hit, found: false, score: 0 }).detail).toContain('别低于 0.7');
    expect(testVerdict({ ...hit, found: false, reason: 'ROI 超出画面范围' }).detail).toBe('ROI 超出画面范围');
    expect(resolutionWarning({ width: 960, height: 540 }, { refWidth: 2560, refHeight: 1440 })).toContain('放大 2.67 倍');
    expect(resolutionWarning({ width: 2560, height: 1440 }, { refWidth: 2560, refHeight: 1440 })).toBeNull();
  });

  it('builds quick picks from the coverage and summarizes an import', () => {
    const coverage: TemplateCoverage = {
      directory: '/x', templateCount: 3, compiled: false, failed: [], ready: false,
      critical: [{ id: 'tpl_btn_march', label: '创建部队页：行军按钮（页面锚点）', state: 'missing' }],
      optional: [{ id: 'tpl_btn_close_popup', label: '活动弹窗右上角 ×（建议两帧去底）', state: 'failed', reason: '方差过低' }],
      glyphs: [
        { name: 'dig_panel_level', label: '搜索面板「等级 N」', present: ['1', '2'], missingDigits: ['0', '9'] },
        { name: 'dig_light16', label: '白字深底', present: [], missingDigits: ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'] },
      ],
    };
    const picks = quickPicks(coverage);
    expect(picks.map((pick) => [pick.group, pick.id])).toEqual([
      ['critical', 'tpl_btn_march'], ['optional', 'tpl_btn_close_popup'], ['glyph', 'dig_panel_level_0'], ['glyph', 'dig_panel_level_9'],
    ]);
    expect(picks[0]!.name).toBe('创建部队页：行军按钮');
    expect(picks[1]!.detail).toBe('编译失败：方差过低');
    expect(picks[3]).toMatchObject({ name: 'dig_panel_level 字形 9', tags: ['digit', 'dig_panel_level'], threshold: 0.78 });
    expect(quickPicks(null)).toEqual([]);

    const summary = importSummary({ copiedSets: { tset_a: 128 }, addedTemplates: { tset_b: ['tpl_x', 'tpl_y'] }, skipped: { tset_c: '源 manifest 不合法' } });
    expect(summary.changed).toBe(true);
    expect(summary.lines).toEqual(['新增模板集 tset_a（128 个文件）', 'tset_b 补进 2 张：tpl_x、tpl_y', '跳过 tset_c：源 manifest 不合法']);
    expect(importSummary({ copiedSets: {}, addedTemplates: {}, skipped: {} })).toMatchObject({ changed: false, title: expect.stringContaining('没有新模板') });
  });
});
