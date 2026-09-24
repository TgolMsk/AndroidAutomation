/**
 * Pure helpers of the 「通知与推送」 settings card (tested in Node).
 * ★ Defaults come from `defaultAlertsConfig()` only; the numbers below are ranges from `ALERT_RANGE`, not defaults.
 * ★ The form never holds the saved token: `tokenInput` is what the user typed now; empty = keep the saved one.
 */
import {
  ALERT_RANGE, FIELD_LABEL, defaultAlertsConfig, toAlertsConfigView, validateRemoteBotConfig, validateTelegramConfig,
  type AlertDetectConfig, type AlertType, type AlertsConfigPatch, type AlertsConfigView,
} from '../../../shared/alerts';

/** The editable part of the view (masked token fields excluded). */
export interface AlertsDraft {
  detect: AlertDetectConfig;
  telegram: {
    enabled: boolean;
    chatId: string;
    cooldownSeconds: number;
    retryCount: number;
    timeoutMs: number;
    subscribedTypes: AlertType[];
    remoteControlEnabled: boolean;
    remoteReadOnlyEnabled: boolean;
    authorizedUserId: string;
  };
  local: { enabled: boolean };
}

/** Local shape check only: a saved-but-not-retyped token is represented by a shape-valid placeholder. */
const SHAPE_OK_PLACEHOLDER = '00000000:PLACEHOLDER_LOCAL_SHAPE_CHECK_ONLY';

export function draftFromView(view: AlertsConfigView): AlertsDraft {
  const { botTokenMasked: _masked, botTokenSet: _set, ...telegram } = view.telegram;
  return { detect: { ...view.detect }, telegram: { ...telegram, subscribedTypes: [...telegram.subscribedTypes] }, local: { ...view.local } };
}

/** The defaults (single authority), keeping the contact fields the user already entered. */
export function defaultsKeepingContacts(draft: AlertsDraft): AlertsDraft {
  const defaults = draftFromView(toAlertsConfigView(defaultAlertsConfig()));
  return {
    ...defaults,
    telegram: { ...defaults.telegram, chatId: draft.telegram.chatId, authorizedUserId: draft.telegram.authorizedUserId },
  };
}

/** Save patch. ★ `botToken` only when the user typed one (absent = keep); clearing is a separate explicit action. */
export function patchFromDraft(draft: AlertsDraft, tokenInput: string): AlertsConfigPatch {
  const token = tokenInput.trim();
  return {
    detect: { ...draft.detect },
    telegram: { ...draft.telegram, chatId: draft.telegram.chatId.trim(), authorizedUserId: draft.telegram.authorizedUserId.trim(), ...(token ? { botToken: token } : {}) },
    local: { ...draft.local },
  };
}

export function isDirty(draft: AlertsDraft, view: AlertsConfigView, tokenInput: string): boolean {
  return tokenInput.trim() !== '' || JSON.stringify(draft) !== JSON.stringify(draftFromView(view));
}

type RangedKey = keyof typeof ALERT_RANGE;

/** Range problems of the numeric fields (Chinese, one per field) — shown before saving instead of silent clamping. */
export function numberProblems(draft: AlertsDraft): string[] {
  const values: Record<RangedKey, number> = {
    cycleFailThreshold: draft.detect.cycleFailThreshold, recoveryFailThreshold: draft.detect.recoveryFailThreshold,
    sampleFailThreshold: draft.detect.sampleFailThreshold, stalledMinutes: draft.detect.stalledMinutes,
    freezeMinutes: draft.detect.freezeMinutes, freezeRestartLimit: draft.detect.freezeRestartLimit,
    freezeRestartWindowMin: draft.detect.freezeRestartWindowMin, cooldownSeconds: draft.telegram.cooldownSeconds,
    retryCount: draft.telegram.retryCount, timeoutMs: draft.telegram.timeoutMs,
  };
  const problems: string[] = [];
  for (const [key, [lo, hi]] of Object.entries(ALERT_RANGE) as [RangedKey, readonly [number, number]][]) {
    const value = values[key];
    if (!Number.isInteger(value) || value < lo || value > hi) problems.push(`${FIELD_LABEL[key] ?? key}应为 ${lo}–${hi} 之间的整数`);
  }
  return problems;
}

/** Guided Telegram problems for the current draft (a saved token counts even when not retyped). */
export function telegramPreflight(draft: AlertsDraft, view: AlertsConfigView, tokenInput: string): string[] {
  const typed = tokenInput.trim();
  const token = typed || (view.telegram.botTokenSet ? SHAPE_OK_PLACEHOLDER : '');
  return validateTelegramConfig({ botToken: token, chatId: draft.telegram.chatId });
}

/** The bot switches additionally need the authorized user id. */
export function remotePreflight(draft: AlertsDraft, view: AlertsConfigView, tokenInput: string): string[] {
  const typed = tokenInput.trim();
  const token = typed || (view.telegram.botTokenSet ? SHAPE_OK_PLACEHOLDER : '');
  return validateRemoteBotConfig({ botToken: token, chatId: draft.telegram.chatId, authorizedUserId: draft.telegram.authorizedUserId });
}

/** Problems that block saving: bad numbers, or a switch on whose credentials are incomplete. */
export function saveProblems(draft: AlertsDraft, view: AlertsConfigView, tokenInput: string): string[] {
  const problems = numberProblems(draft);
  if (draft.telegram.enabled) problems.push(...telegramPreflight(draft, view, tokenInput));
  if (draft.telegram.remoteControlEnabled || draft.telegram.remoteReadOnlyEnabled) {
    for (const problem of remotePreflight(draft, view, tokenInput)) if (!problems.includes(problem)) problems.push(problem);
  }
  return problems;
}

/** 「3 分钟」 / 「45 秒」 for the freeze evidence line. */
export function durationText(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0 秒';
  if (ms < 60_000) return `${Math.round(ms / 1000)} 秒`;
  const minutes = ms / 60_000;
  return `${minutes >= 10 ? Math.round(minutes) : minutes.toFixed(1).replace(/\.0$/, '')} 分钟`;
}
