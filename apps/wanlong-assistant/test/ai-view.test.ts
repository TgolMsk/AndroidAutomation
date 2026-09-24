import { describe, expect, it } from 'vitest';
import {
  AI_FORM_RANGE, AI_PAGE_SIZE, adviceSummary, applyPreset, configBadge, defaultDraft, draftDirty, draftFromView, draftProblems,
  mergeRecord, pageCount, pageOf, patchFromDraft, riskPolicyText, riskSummary, statusLine, testTitle,
} from '../src/renderer/views/ai/ai-view-model';
import {
  AI_PRESETS, AI_RANGE, aiContextLabel, defaultAiConfig, toAiConfigView, type AdvisorAdvice, type AdvisorRecord, type AdvisorStatus,
} from '../src/shared/ai';

const view = { ...toAiConfigView({ ...defaultAiConfig(), apiKey: 'sk-abcdef-1234' }), enabled: true };
const status: AdvisorStatus = {
  enabled: true, configured: true, model: 'qwen3.8-flash', baseUrl: view.baseUrl, callsLastHour: 3, maxCallsPerHour: 0,
  consultCount: 9, harvestedCount: 2, autoActions: false, autoHarvest: true, refine: true, lastRecord: null, loadWarning: null,
};
const advice: AdvisorAdvice = {
  screen: 'popup', action: 'tap_close', target: { x: 1800, y: 200, w: 80, h: 80 }, confidence: 0.91, reason: '有×',
  risk: { level: 'low', effect: 'dismiss', buttonText: '关闭', dialogText: '活动公告', consequence: '关闭弹窗', reason: '不花钱', hazards: [] },
  model: 'm', review: 'manual_review', reviewReason: '通过', space: 'reference', refined: true, riskRechecked: false,
};
function record(id: string): AdvisorRecord {
  return {
    id, at: 1, gameId: 'wanlong', index: 1, context: 'gather-g0', outcome: 'verified', message: 'ok', advice: null,
    templateProposal: null, harvestedTemplateId: null, latencyMs: 0, providerCalls: 1,
  };
}

describe('AI page view model', () => {
  it('uses the one authority for defaults and ranges', () => {
    expect(defaultDraft()).toMatchObject({ baseUrl: defaultAiConfig().baseUrl, model: 'qwen3.8-flash', timeoutSeconds: 40, autoActions: false, apiKey: '' });
    expect(AI_FORM_RANGE.maxCallsPerHour).toBe(AI_RANGE.maxCallsPerHour);
    expect(AI_FORM_RANGE.timeoutSeconds).toEqual([AI_RANGE.timeoutMs[0] / 1000, AI_RANGE.timeoutMs[1] / 1000]);
  });

  it('never sends the master switch from the form; an empty key keeps the saved one', () => {
    const draft = draftFromView(view);
    const patch = patchFromDraft(draft);
    expect('enabled' in patch).toBe(false);
    expect('apiKey' in patch).toBe(false);
    expect(patch.timeoutMs).toBe(40_000);
    expect(patchFromDraft({ ...draft, apiKey: ' sk-new ' }).apiKey).toBe('sk-new');
    expect(draftDirty(draft, view)).toBe(false);
    expect(draftDirty({ ...draft, refine: false }, view)).toBe(true);
  });

  it('presets fill address and first model; bad numbers are pointed out', () => {
    const draft = applyPreset(draftFromView(view), 2);
    expect(draft).toMatchObject({ baseUrl: AI_PRESETS[2]!.baseUrl, model: AI_PRESETS[2]!.models[0] });
    expect(applyPreset(draft, 99)).toBe(draft);
    expect(draftProblems({ ...draft, maxCallsPerHour: 501, timeoutSeconds: Number.NaN })).toHaveLength(2);
    expect(draftProblems({ ...draft, maxCallsPerHour: 0 })).toEqual([]);
  });

  it('badge: red when incomplete, amber when off, none when working; ∞ for an unlimited quota', () => {
    expect(configBadge({ ...status, configured: false }, view).tone).toBe('danger');
    expect(configBadge(status, { ...view, enabled: false }).tone).toBe('warning');
    expect(configBadge(status, view).tone).toBeNull();
    expect(statusLine(status)).toContain('3 / ∞');
    expect(statusLine({ ...status, maxCallsPerHour: 20 })).toContain('3 / 20');
    expect(statusLine(status)).toContain('自学模板 2 张');
  });

  it('test titles and the risk policy follow the actual switches', () => {
    expect(testTitle({ ok: true, vision: true, kind: null, model: 'm', latencyMs: 12, message: '', reply: 'W' })).toContain('✅');
    expect(testTitle({ ok: false, vision: false, kind: 'vision', model: 'm', latencyMs: 12, message: '', reply: 'x' })).toContain('不支持图片');
    expect(testTitle({ ok: false, vision: null, kind: 'timeout', model: 'm', latencyMs: 12, message: '', reply: null })).toContain('请求超时');
    expect(riskPolicyText(false, true)).toContain('不会点击设备');
    expect(riskPolicyText(true, true)).toContain('85%');
    expect(riskPolicyText(true, false)).toContain('只点不学');
  });

  it('records: pushes replace by id and cap at 50; 20 per page; labels for every chain', () => {
    let history: AdvisorRecord[] = [];
    for (let i = 0; i < 60; i++) history = mergeRecord(history, record(`r${i}`));
    expect(history).toHaveLength(50);
    expect(history[0]!.id).toBe('r59');
    expect(mergeRecord(history, { ...record('r59'), message: 'again' })).toHaveLength(50);
    expect(pageCount(history.length)).toBe(3);
    expect(pageOf(history, 2)).toHaveLength(50 - 2 * AI_PAGE_SIZE);
    expect(pageOf(history, 9)[0]!.id).toBe(history[40]!.id);
    expect(['gather-g0', 'scheduler-sample', 'script-run', 'manual', 'vision-test'].map(aiContextLabel))
      .toEqual(['采集流程', '调度采样', '脚本执行', '手动分析', '视觉能力测试']);
  });

  it('judgement and risk columns: refined, reference box, rechecked; a missing assessment is never low risk', () => {
    expect(adviceSummary(advice)).toContain('已精修');
    expect(adviceSummary(advice)).toContain('参考坐标');
    expect(riskSummary({ ...advice, riskRechecked: true })).toMatchObject({ tone: 'success', label: '低风险', text: '关闭 · 已复核' });
    expect(riskSummary(null)).toMatchObject({ text: '未评估（旧记录）', tone: 'neutral' });
    expect(riskSummary(advice).detail).toContain('依据：活动公告');
  });
});
