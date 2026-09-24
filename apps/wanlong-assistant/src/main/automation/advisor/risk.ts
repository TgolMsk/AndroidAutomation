/**
 * Reply parsing and the local risk gate (original src/main/ai/advisor.ts parseAdvice / extractJson / readBox and
 * src/main/ai/risk.ts). Pure functions: shared by the read-only advisor and the device-writing executor.
 * The gate never trusts the model's own label: a「low」 purchase is still a purchase.
 */
import {
  AI_ACTIONS, AI_EFFECTS, AI_LOW_EFFECTS, AI_RISK_LABEL, AI_RISK_LEVELS, AI_SCREEN_KINDS,
  type AdvisorAction, type AdvisorAdvice, type AdvisorBox, type AdvisorEffect, type AdvisorRisk, type AdvisorRiskLevel, type AdvisorScreen,
} from '../../../shared/ai';

/** Largest believable button, as a fraction of the image (bigger is not a button). */
const MAX_TARGET_FRACTION = 0.4;
/** Smallest believable button, in pixels of the image that was sent. */
const MIN_TARGET_PX = 6;
/** Confirmations need at least this confidence whatever the configured floor (docs/ai-risk-control.md). */
export const CONFIRM_MIN_CONFIDENCE = 0.85;
const DEFAULT_NO_CONFIRM: readonly AdvisorScreen[] = ['kicked', 'login', 'unknown'];

const ACTIONS: ReadonlySet<string> = new Set(AI_ACTIONS);
const LEVELS: ReadonlySet<string> = new Set(AI_RISK_LEVELS);
const EFFECTS: ReadonlySet<string> = new Set(AI_EFFECTS);
const LOW_EFFECTS: ReadonlySet<string> = new Set(AI_LOW_EFFECTS);
const ALL_SCREENS: ReadonlySet<string> = new Set(AI_SCREEN_KINDS);

function obj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function short(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/** First JSON object in a reply: every ```json fence and the chatter around it are dropped. */
export function extractJson(text: string): unknown {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { return null; }
}

/**
 * A button box in pixels of the image that was sent. Accepts `{x,y,w|width,h|height}`, `{bbox:[x1,y1,x2,y2]}` and
 * `{x1,y1,x2,y2}` (Qwen models like the last two). Too small, too large or off-image boxes are refused.
 */
export function parseBox(raw: unknown, width: number, height: number): AdvisorBox | null {
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
  if (box.w < MIN_TARGET_PX || box.h < MIN_TARGET_PX || box.w > width * MAX_TARGET_FRACTION || box.h > height * MAX_TARGET_FRACTION ||
    box.x < 0 || box.y < 0 || box.x + box.w > width + 2 || box.y + box.h > height + 2) return null;
  return box;
}

/** The risk block: unknown enums become 'unknown'; a missing or invalid hazard list makes the level 'unknown'. */
export function parseRisk(raw: unknown): AdvisorRisk {
  const value = obj(raw) ?? {};
  const validHazards = Array.isArray(value['hazards']) && value['hazards'].length <= 20 &&
    value['hazards'].every((item) => typeof item === 'string' && item.trim());
  const level = LEVELS.has(value['level'] as string) ? value['level'] as AdvisorRiskLevel : 'unknown';
  const effect = EFFECTS.has(value['effect'] as string) ? value['effect'] as AdvisorEffect : 'unknown';
  return {
    level: validHazards ? level : 'unknown',
    effect,
    buttonText: short(value['buttonText'], 80),
    dialogText: short(value['dialogText'], 600),
    consequence: short(value['consequence'], 240),
    reason: short(value['reason'], 240),
    hazards: validHazards ? (value['hazards'] as string[]).map((item) => item.trim().slice(0, 120)) : ['缺少有效风险清单'],
  };
}

export const isLowEffect = (effect: string): boolean => LOW_EFFECTS.has(effect);

export type ParsedAdvice = Omit<AdvisorAdvice, 'model' | 'review' | 'reviewReason'>;

/**
 * Stage-one reply. The action must be on the whitelist (lower-cased), a tap needs a believable box, other actions
 * carry no target; an unknown screen class is recorded as 'unknown'; the confidence may be a string (clamped 0..1).
 * @param screens the game profile's screen vocabulary (default: every known class)
 */
export function parseAdvice(text: string, imageWidth: number, imageHeight: number, screens?: readonly AdvisorScreen[]):
  | { ok: true; value: ParsedAdvice }
  | { ok: false; reason: string } {
  const value = obj(extractJson(text));
  if (!value) return { ok: false, reason: '回复里没有 JSON 对象' };
  const action = short(value['action'], 32).toLowerCase();
  if (!ACTIONS.has(action)) return { ok: false, reason: `动作「${action || '空'}」不在白名单里` };
  const screenRaw = short(value['screen'], 32).toLowerCase();
  const allowed: ReadonlySet<string> = screens ? new Set(screens) : ALL_SCREENS;
  const confidence = typeof value['confidence'] === 'number' ? value['confidence'] : Number(value['confidence']);
  const target = parseBox(value['target'], imageWidth, imageHeight);
  if (action.startsWith('tap_') && !target) return { ok: false, reason: `动作是 ${action} 但没有给出合理的目标框` };
  return {
    ok: true,
    value: {
      action: action as AdvisorAction,
      screen: (allowed.has(screenRaw) ? screenRaw : 'unknown') as AdvisorScreen,
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
      target: action.startsWith('tap_') ? target : null,
      reason: short(value['reason'], 200),
      risk: parseRisk(value['risk']),
    },
  };
}

/**
 * The local gate (original riskRejection), independent of the provider's self-reported label. Returns the Chinese
 * refusal, or null when the click's consequence is acceptable. Confidence and target are checked separately
 * (`confidenceFloor`), exactly like the original recover flow.
 */
export function riskRejection(
  advice: Pick<AdvisorAdvice, 'action' | 'screen' | 'risk'> & { risk?: AdvisorRisk },
  noConfirmScreens: readonly AdvisorScreen[] = DEFAULT_NO_CONFIRM,
): string | null {
  const risk = advice.risk;
  if (!risk) return '模型未提供操作风险评估。';
  if (advice.action === 'tap_confirm' && noConfirmScreens.includes(advice.screen)) return '涉及账号登录或界面不明，需要人工处理。';
  if (risk.level !== 'low') return `${AI_RISK_LABEL[risk.level] ?? '风险不明'}：${risk.reason || '无法确认点击后果'}。`;
  if (!LOW_EFFECTS.has(risk.effect)) return `操作涉及 ${risk.effect}，需要人工处理。`;
  if (risk.hazards.length) return `仍存在风险：${risk.hazards.join('；')}。`;
  if (!risk.buttonText || !risk.dialogText || !risk.consequence || !risk.reason) return '按钮、界面证据或点击后果不完整。';
  if (advice.action === 'tap_confirm' && risk.effect === 'dismiss') return '确认动作与关闭/取消的后果描述不一致。';
  if ((advice.action === 'tap_close' || advice.action === 'tap_cancel') && risk.effect !== 'dismiss') return '关闭/取消动作与后果描述不一致。';
  return null;
}

/** Confidence floor of an action: confirmations need max(0.85, configured floor). */
export function confidenceFloor(action: AdvisorAction, minConfidence: number): number {
  return action === 'tap_confirm' ? Math.max(CONFIRM_MIN_CONFIDENCE, minConfidence) : minConfidence;
}

/**
 * The full verdict of a tap suggestion for display and manual review: a target, the confidence floor and the risk
 * gate. back / none are never taps (null).
 */
export function adviceRejection(
  advice: Pick<AdvisorAdvice, 'action' | 'screen' | 'risk' | 'target' | 'confidence'>,
  minConfidence: number,
  noConfirmScreens: readonly AdvisorScreen[] = DEFAULT_NO_CONFIRM,
): string | null {
  if (advice.action === 'back' || advice.action === 'none') return null;
  if (!advice.target) return '模型建议点击但没有给出目标框。';
  const floor = confidenceFloor(advice.action, minConfidence);
  if (advice.confidence < floor) return `模型置信度 ${advice.confidence.toFixed(2)} 低于阈值 ${floor}。`;
  return riskRejection(advice, noConfirmScreens);
}

/**
 * back / none on a risky screen must not fall through to BACK (original recover.ts) — except when the model says
 * this is one of the game's own main screens: those two actions are never clicked, so the risk of an imagined click
 * cannot pause the instance (2026-09-18: a guide bubble over the world map paused an instance).
 */
export function backNoneNeedsAttention(advice: Pick<AdvisorAdvice, 'action' | 'screen' | 'risk'>, mainScreens: readonly AdvisorScreen[]): boolean {
  if (advice.action !== 'back' && advice.action !== 'none') return false;
  const risk = advice.risk;
  if (!risk) return false;
  const risky = risk.level !== 'low' || risk.hazards.length > 0 || !isLowEffect(risk.effect);
  return risky && !mainScreens.includes(advice.screen);
}

/** Scale a box between two pixel spaces (image sent → reference canvas or device frame). */
export function scaleBox(box: AdvisorBox, fromWidth: number, fromHeight: number, toWidth: number, toHeight: number): AdvisorBox {
  return {
    x: Math.round(box.x * toWidth / fromWidth), y: Math.round(box.y * toHeight / fromHeight),
    w: Math.max(1, Math.round(box.w * toWidth / fromWidth)),
    h: Math.max(1, Math.round(box.h * toHeight / fromHeight)),
  };
}
