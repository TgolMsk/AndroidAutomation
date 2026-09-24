/**
 * Pure helpers of the「AI 处理」page (tested in Node). Defaults, ranges and labels come from `shared/ai.ts` only:
 * this file never repeats a default or a bound.
 */
import {
  AI_ACTION_LABEL, AI_FAILURE_LABEL, AI_HISTORY_LIMIT, AI_PRESETS, AI_RANGE, AI_RISK_LABEL, AI_SCREEN_LABEL, defaultAiConfig,
  toAiConfigView,
  type AdvisorAdvice, type AdvisorConfigPatch, type AdvisorConfigView, type AdvisorRecord, type AdvisorStatus, type AdvisorTestResult,
} from '../../../shared/ai';

/** Records per table page (original: 20). */
export const AI_PAGE_SIZE = 20;

/** The form: every field except the master switch (it is saved by the switch at the top of the page, never here). */
export interface AiDraft {
  baseUrl: string;
  /** Newly typed key; empty = keep the saved one. */
  apiKey: string;
  model: string;
  /** Seconds in the form; saved as ms. */
  timeoutSeconds: number;
  maxCallsPerHour: number;
  cooldownSeconds: number;
  imageWidth: number;
  minConfidence: number;
  refine: boolean;
  autoHarvest: boolean;
  autoActions: boolean;
}

/** Form bounds, straight from `AI_RANGE` (the timeout shown in seconds). */
export const AI_FORM_RANGE = {
  timeoutSeconds: [AI_RANGE.timeoutMs[0] / 1000, AI_RANGE.timeoutMs[1] / 1000],
  maxCallsPerHour: AI_RANGE.maxCallsPerHour,
  cooldownSeconds: AI_RANGE.cooldownSeconds,
  imageWidth: AI_RANGE.imageWidth,
  minConfidence: AI_RANGE.minConfidence,
} as const;

export function draftFromView(view: AdvisorConfigView): AiDraft {
  return {
    baseUrl: view.baseUrl,
    apiKey: '',
    model: view.model,
    timeoutSeconds: Math.round(view.timeoutMs / 1000),
    maxCallsPerHour: view.maxCallsPerHour,
    cooldownSeconds: view.cooldownSeconds,
    imageWidth: view.imageWidth,
    minConfidence: view.minConfidence,
    refine: view.refine,
    autoHarvest: view.autoHarvest,
    autoActions: view.autoActions,
  };
}

/** 「恢复默认值」: the one authoritative default (`defaultAiConfig`) — the key is left untouched (still needs 保存). */
export function defaultDraft(): AiDraft {
  return draftFromView(toAiConfigView(defaultAiConfig()));
}

/** The save patch. The master switch is never part of it; an empty key field keeps the stored key. */
export function patchFromDraft(draft: AiDraft): AdvisorConfigPatch {
  const key = draft.apiKey.trim();
  return {
    baseUrl: draft.baseUrl.trim(),
    model: draft.model.trim(),
    timeoutMs: Math.round(draft.timeoutSeconds * 1000),
    maxCallsPerHour: draft.maxCallsPerHour,
    cooldownSeconds: draft.cooldownSeconds,
    imageWidth: draft.imageWidth,
    minConfidence: draft.minConfidence,
    refine: draft.refine,
    autoHarvest: draft.autoHarvest,
    autoActions: draft.autoActions,
    ...(key ? { apiKey: key } : {}),
  };
}

export function draftDirty(draft: AiDraft, view: AdvisorConfigView): boolean {
  return JSON.stringify(draft) !== JSON.stringify(draftFromView(view));
}

/** Form problems (Chinese) that make 保存 pointless; bounds from `AI_FORM_RANGE`. */
export function draftProblems(draft: AiDraft): string[] {
  const problems: string[] = [];
  if (!draft.baseUrl.trim()) problems.push('必须填写接口地址');
  if (!draft.model.trim()) problems.push('必须填写模型名');
  const inRange = (value: number, [min, max]: readonly [number, number]): boolean => Number.isFinite(value) && value >= min && value <= max;
  if (!inRange(draft.timeoutSeconds, AI_FORM_RANGE.timeoutSeconds)) problems.push(`请求超时应在 ${AI_FORM_RANGE.timeoutSeconds[0]}–${AI_FORM_RANGE.timeoutSeconds[1]} 秒之间`);
  if (!inRange(draft.maxCallsPerHour, AI_FORM_RANGE.maxCallsPerHour)) problems.push(`每小时次数应在 ${AI_FORM_RANGE.maxCallsPerHour[0]}–${AI_FORM_RANGE.maxCallsPerHour[1]} 之间（0 = 不限）`);
  if (!inRange(draft.cooldownSeconds, AI_FORM_RANGE.cooldownSeconds)) problems.push(`冷却应在 ${AI_FORM_RANGE.cooldownSeconds[0]}–${AI_FORM_RANGE.cooldownSeconds[1]} 秒之间`);
  if (!inRange(draft.imageWidth, AI_FORM_RANGE.imageWidth)) problems.push(`截图宽度应在 ${AI_FORM_RANGE.imageWidth[0]}–${AI_FORM_RANGE.imageWidth[1]} 之间`);
  if (!inRange(draft.minConfidence, AI_FORM_RANGE.minConfidence)) problems.push('最低置信度应在 0–1 之间');
  return problems;
}

/** 「快速填入平台预设」: the address and the first model; the form becomes dirty (still needs 保存). */
export function applyPreset(draft: AiDraft, index: number): AiDraft {
  const preset = AI_PRESETS[index];
  if (!preset) return draft;
  return { ...draft, baseUrl: preset.baseUrl, model: preset.models[0] ?? draft.model };
}

export function presetLabel(index: number): string {
  const preset = AI_PRESETS[index];
  return preset ? `${preset.label}（${preset.models.join(' / ')}）` : '';
}

/** The badge on「接口配置」: red = not complete, amber = complete but switched off, none = working. */
export function configBadge(status: AdvisorStatus | null, view: AdvisorConfigView | null): { tone: 'danger' | 'warning' | null; text: string } {
  const configured = status ? status.configured : Boolean(view?.baseUrl && view.apiKeySet && view.model);
  const enabled = view?.enabled ?? status?.enabled ?? false;
  if (!configured) return { tone: 'danger', text: '还没配完：接口地址、API Key、模型名三样齐了才能用。点开填。' };
  if (!enabled) return { tone: 'warning', text: '接口已配好，但总开关没开 —— 认不出界面时不会问模型。' };
  return { tone: null, text: '接口配置正常。点开可以改地址 / 模型 / 限额，或测一次视觉能力。' };
}

export function quotaLabel(max: number): string {
  return max > 0 ? String(max) : '∞';
}

/** The status line under the master switch (original AiView). */
export function statusLine(status: AdvisorStatus | null): string {
  if (!status) return '还没拿到状态。';
  const state = status.configured ? (status.enabled ? '已启用' : '已配置但未启用') : '尚未配置完整';
  return `最近一小时 ${status.callsLastHour} / ${quotaLabel(status.maxCallsPerHour)} 次 · 累计问询 ${status.consultCount} 次 · ` +
    `自学模板 ${status.harvestedCount} 张 · 自动处理${status.autoActions ? '已开启' : '未开启'} · ${state}`;
}

/** What the AI may do right now, in one sentence (the risk-policy note follows the actual switches). */
export function riskPolicyText(autoActions: boolean, autoHarvest: boolean): string {
  if (!autoActions) {
    return '「自动处理」未开启：采集、采样或脚本认不出界面时，AI 只看图并记录建议（界面、动作、风险），不会点击设备，原来的兜底阶梯照常继续。' +
      '截图会发送到你填写的 AI 接口。';
  }
  return 'AI 会结合正文、按钮和点击后果判断风险。低风险的关闭、取消、确认更新、重试连接、继续加载、信息确认可自动处理。' +
    '确认动作要求两次判断一致、置信度至少 85%，并在点击前检查画面和前台应用；相同确认 60 秒内不重复执行。' +
    '购买、消耗资源、删除、账号或权限变更、战斗等操作，以及风险不明的情况会暂停并说明原因，不会再按返回键绕过。' +
    '已校准的游戏更新仍优先使用本地流程；其它布局可由 AI 评估后确认，再等待加载完成。' +
    (autoHarvest ? '只有关闭按钮会自动学习成模板（每套最多 8 张），确认按钮每次重新评估。' : '模板自学已关闭：只点不学。') +
    '截图会发送到你填写的 AI 接口。';
}

/** Title of the connection test result (original: ✅ 支持图片 / ❌ 不支持图片 / ❌ 连接失败（kind）). */
export function testTitle(result: AdvisorTestResult): string {
  if (result.ok) return `✅ 模型「${result.model}」支持图片输入（${result.latencyMs}ms）`;
  if (result.vision === false) return `❌ 模型「${result.model}」不支持图片输入`;
  return `❌ 连接失败（${result.kind ? AI_FAILURE_LABEL[result.kind] : '未知'}）`;
}

/** A pushed record goes on top (replacing the same id), capped like the main-process history. */
export function mergeRecord(history: readonly AdvisorRecord[], record: AdvisorRecord): AdvisorRecord[] {
  return [record, ...history.filter((item) => item.id !== record.id)].slice(0, AI_HISTORY_LIMIT);
}

export function pageCount(total: number, size = AI_PAGE_SIZE): number {
  return Math.max(1, Math.ceil(total / size));
}

export function pageOf<T>(items: readonly T[], page: number, size = AI_PAGE_SIZE): T[] {
  const last = pageCount(items.length, size) - 1;
  const current = Math.min(Math.max(0, page), last);
  return items.slice(current * size, current * size + size);
}

/** 「模型判断」: screen / action / confidence / target box / refined (original table column). */
export function adviceSummary(advice: AdvisorAdvice | null): string {
  if (!advice) return '—';
  const parts = [
    AI_SCREEN_LABEL[advice.screen] ?? advice.screen,
    AI_ACTION_LABEL[advice.action] ?? advice.action,
    `置信 ${advice.confidence.toFixed(2)}`,
  ];
  if (advice.target) parts.push(`目标 (${advice.target.x},${advice.target.y} ${advice.target.w}×${advice.target.h}${advice.space === 'reference' ? ' 参考坐标' : ''})`);
  if (advice.refined) parts.push('已精修');
  return parts.join(' / ');
}

/** 「风险评估」: level + the button's own text + rechecked; a missing assessment is never shown as low risk. */
export function riskSummary(advice: AdvisorAdvice | null): { tone: 'success' | 'warning' | 'neutral'; label: string; text: string; detail: string } {
  const risk = advice?.risk;
  if (!advice || !risk) return { tone: 'neutral', label: '未评估', text: '未评估（旧记录）', detail: '' };
  const detail = [
    risk.reason && `理由：${risk.reason}`,
    risk.consequence && `点击后：${risk.consequence}`,
    risk.dialogText && `依据：${risk.dialogText}`,
    risk.hazards.length ? `潜在后果：${risk.hazards.join('；')}` : '',
  ].filter(Boolean).join('\n');
  return {
    tone: risk.level === 'low' ? 'success' : 'warning',
    label: AI_RISK_LABEL[risk.level] ?? '风险不明',
    text: `${risk.buttonText || '无点击'}${advice.riskRechecked ? ' · 已复核' : ''}`,
    detail,
  };
}

export function latencyLabel(ms: number): string {
  return ms > 0 ? `${(ms / 1000).toFixed(1)}s` : '本地拦截';
}
