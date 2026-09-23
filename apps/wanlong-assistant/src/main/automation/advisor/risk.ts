import type { AdvisorAction, AdvisorAdvice, AdvisorBox, AdvisorEffect, AdvisorRisk, AdvisorRiskLevel, AdvisorScreen } from './types';

const ACTIONS: ReadonlySet<string> = new Set(['tap_close', 'tap_cancel', 'tap_confirm', 'back', 'none']);
const SCREENS: ReadonlySet<string> = new Set(['gameplay', 'popup', 'dialog', 'login', 'network', 'maintenance', 'update', 'loading', 'other', 'unknown']);
const LEVELS: ReadonlySet<string> = new Set(['low', 'medium', 'high', 'unknown']);
const EFFECTS: ReadonlySet<string> = new Set([
  'dismiss', 'acknowledge', 'retry_connection', 'continue_loading', 'download_update',
  'navigate', 'purchase', 'spend_resource', 'delete', 'account_change',
  'permission_change', 'send_message', 'combat', 'exit_game', 'unknown',
]);
const LOW_EFFECTS: ReadonlySet<string> = new Set([
  'dismiss', 'acknowledge', 'retry_connection', 'continue_loading', 'download_update', 'navigate',
]);

function obj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function short(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}
function parseBox(raw: unknown, width: number, height: number): AdvisorBox | null {
  const value = obj(raw);
  if (!value) return null;
  let x = value['x']; let y = value['y'];
  let w = value['w'] ?? value['width']; let h = value['h'] ?? value['height'];
  if ((x === undefined || w === undefined) && Array.isArray(value['bbox']) && value['bbox'].length === 4) {
    const [x1, y1, x2, y2] = value['bbox'] as unknown[];
    if ([x1, y1, x2, y2].every((n) => typeof n === 'number' && Number.isFinite(n))) {
      x = x1; y = y1; w = (x2 as number) - (x1 as number); h = (y2 as number) - (y1 as number);
    }
  }
  if (x === undefined && typeof value['x1'] === 'number' && typeof value['x2'] === 'number' &&
    typeof value['y1'] === 'number' && typeof value['y2'] === 'number') {
    x = value['x1']; y = value['y1'];
    w = value['x2'] - value['x1']; h = value['y2'] - value['y1'];
  }
  if (![x, y, w, h].every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  const box = { x: x as number, y: y as number, w: w as number, h: h as number };
  if (box.w < 6 || box.h < 6 || box.w > width * .4 || box.h > height * .4 ||
    box.x < 0 || box.y < 0 || box.x + box.w > width + 2 || box.y + box.h > height + 2) return null;
  return box;
}

function parseRisk(raw: unknown): AdvisorRisk {
  const value = obj(raw) ?? {};
  const hazards = Array.isArray(value['hazards']) && value['hazards'].length <= 20 &&
    value['hazards'].every((item) => typeof item === 'string' && item.trim())
    ? (value['hazards'] as string[]).map((item) => item.trim().slice(0, 120))
    : ['缺少有效的风险清单'];
  const level = LEVELS.has(value['level'] as string) ? value['level'] as AdvisorRiskLevel : 'unknown';
  const effect = EFFECTS.has(value['effect'] as string) ? value['effect'] as AdvisorEffect : 'unknown';
  return {
    level: hazards[0] === '缺少有效的风险清单' ? 'unknown' : level,
    effect,
    buttonText: short(value['buttonText'], 80),
    dialogText: short(value['dialogText'], 600),
    consequence: short(value['consequence'], 240),
    reason: short(value['reason'], 240),
    hazards,
  };
}

/** A local gate independent of the provider's self-reported risk label. */
export function riskRejection(advice: Pick<AdvisorAdvice, 'action' | 'screen' | 'risk' | 'target' | 'confidence'>, minConfidence: number): string | null {
  if (advice.action === 'back' || advice.action === 'none') return null;
  if (!advice.target) return '没有可信的目标范围。';
  const min = advice.action === 'tap_confirm' ? Math.max(.85, minConfidence) : minConfidence;
  if (advice.confidence < min) return `模型置信度低于 ${min.toFixed(2)}。`;
  if (advice.action === 'tap_confirm' && (advice.screen === 'login' || advice.screen === 'unknown')) {
    return '登录或未知界面需要人工处理。';
  }
  const risk = advice.risk;
  if (risk.level !== 'low') return `风险等级为${risk.level}：${risk.reason || '后果不明'}。`;
  if (!LOW_EFFECTS.has(risk.effect)) return `操作后果 ${risk.effect} 不在低风险范围内。`;
  if (risk.hazards.length) return `仍有潜在不利后果：${risk.hazards.join('；')}。`;
  if (!risk.buttonText || !risk.dialogText || !risk.consequence || !risk.reason) return '缺少按钮、界面正文或后果证据。';
  if ((advice.action === 'tap_close' || advice.action === 'tap_cancel') && risk.effect !== 'dismiss') return '关闭/取消动作与后果描述不一致。';
  if (advice.action === 'tap_confirm' && risk.effect === 'dismiss') return '确认动作与关闭后果描述不一致。';
  return null;
}

function extractJson(text: string): unknown {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = cleaned.indexOf('{'); const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { return null; }
}

export function parseAdvice(text: string, imageWidth: number, imageHeight: number):
  | { ok: true; value: Omit<AdvisorAdvice, 'model' | 'review' | 'reviewReason'> }
  | { ok: false; reason: string } {
  const value = obj(extractJson(text));
  if (!value) return { ok: false, reason: '模型回复没有可解析的 JSON 对象。' };
  const action = short(value['action'], 32).toLowerCase();
  if (!ACTIONS.has(action)) return { ok: false, reason: '模型给出了白名单外的动作。' };
  const screen = short(value['screen'], 32).toLowerCase();
  const confidence = Number(value['confidence']);
  const target = parseBox(value['target'], imageWidth, imageHeight);
  if (action.startsWith('tap_') && !target) return { ok: false, reason: '点击建议没有合理的目标范围。' };
  return {
    ok: true,
    value: {
      action: action as AdvisorAction,
      screen: (SCREENS.has(screen) ? screen : 'unknown') as AdvisorScreen,
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
      target: action.startsWith('tap_') ? target : null,
      reason: short(value['reason'], 200),
      risk: parseRisk(value['risk']),
    },
  };
}

export function scaleBox(box: AdvisorBox, fromWidth: number, fromHeight: number, toWidth: number, toHeight: number): AdvisorBox {
  return {
    x: Math.round(box.x * toWidth / fromWidth), y: Math.round(box.y * toHeight / fromHeight),
    w: Math.max(1, Math.round(box.w * toWidth / fromWidth)),
    h: Math.max(1, Math.round(box.h * toHeight / fromHeight)),
  };
}
