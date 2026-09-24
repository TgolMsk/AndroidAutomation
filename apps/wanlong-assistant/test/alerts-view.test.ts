/**
 * The renderer side of the alerts module: the settings form's pure helpers (single defaults authority, three-state
 * token, guided preflight), the pause banner's text helpers and the store's reducers. Pure functions, no DOM.
 */
import { describe, expect, it } from 'vitest';
import {
  ALERT_RANGE, defaultAlertsConfig, emptyPauseState, makeAlertEvent, mergeAlertsConfig, pauseStateFromEvent, toAlertsConfigView,
  type AlertRecord,
} from '../src/shared/alerts';
import {
  defaultsKeepingContacts, draftFromView, durationText, isDirty, numberProblems, patchFromDraft, remotePreflight, saveProblems,
  telegramPreflight,
} from '../src/renderer/views/alerts/alert-form';
import { pauseMeta, pauseTone } from '../src/renderer/views/alerts/PauseBanner';
import { pauseOf, pausedIndexes, placeholderConfigView, prependRecord, upsertPause } from '../src/renderer/state/alerts';
import { BADGE_SOURCES } from '../src/renderer/badge-sources';
import { AlertsSettingsCard } from '../src/renderer/views/alerts/AlertsSettingsCard';
import { SETTINGS_CARDS } from '../src/renderer/views/settings/cards';

const TOKEN = '999888777:AAFakeTokenForOfflineCheckOnly_0123456789';
const savedView = () => toAlertsConfigView(mergeAlertsConfig(defaultAlertsConfig(), { telegram: { botToken: TOKEN, chatId: '123456789' } }));

describe('settings form helpers', () => {
  it('starts from the single defaults authority and never carries a token', () => {
    const view = placeholderConfigView();
    expect(view).toEqual(toAlertsConfigView(defaultAlertsConfig()));
    const draft = draftFromView(savedView());
    expect(JSON.stringify(draft)).not.toContain('AAFake');
    expect('botTokenMasked' in draft.telegram || 'botTokenSet' in draft.telegram).toBe(false);
    expect(isDirty(draft, savedView(), '')).toBe(false);
    expect(isDirty(draft, savedView(), ' x ')).toBe(true);
  });

  it('sends the token only when typed (absent = keep), trimmed with the contact fields', () => {
    const draft = draftFromView(savedView());
    draft.telegram.chatId = ' 42 ';
    expect(patchFromDraft(draft, '   ').telegram).not.toHaveProperty('botToken');
    expect(patchFromDraft(draft, ` ${TOKEN} `).telegram).toMatchObject({ botToken: TOKEN, chatId: '42' });
  });

  it('restores defaults but keeps the chat id and the authorized user', () => {
    const draft = draftFromView(savedView());
    draft.detect.cycleFailThreshold = 9;
    draft.telegram.authorizedUserId = '987';
    const reset = defaultsKeepingContacts(draft);
    expect(reset.detect).toEqual(defaultAlertsConfig().detect);
    expect(reset.telegram).toMatchObject({ chatId: '123456789', authorizedUserId: '987', enabled: false });
  });

  it('reports range problems in Chinese from ALERT_RANGE instead of clamping silently', () => {
    const draft = draftFromView(savedView());
    expect(numberProblems(draft)).toEqual([]);
    draft.detect.freezeMinutes = ALERT_RANGE.freezeMinutes[1] + 1;
    draft.telegram.retryCount = 1.5;
    expect(numberProblems(draft)).toEqual(['多久不动判卡死（分钟）应为 2–60 之间的整数', '失败重试次数应为 0–5 之间的整数']);
  });

  it('guides the Telegram and bot preflight; a saved token counts even when not retyped', () => {
    const empty = placeholderConfigView();
    const draft = draftFromView(empty);
    draft.telegram.enabled = true;
    expect(telegramPreflight(draft, empty, '').join('')).toContain('@BotFather');
    expect(saveProblems(draft, empty, '').length).toBe(2);
    const saved = savedView();
    const withSaved = draftFromView(saved);
    withSaved.telegram.enabled = true;
    expect(saveProblems(withSaved, saved, '')).toEqual([]);
    withSaved.telegram.remoteControlEnabled = true;
    expect(remotePreflight(withSaved, saved, '').join('')).toContain('授权用户 ID');
    expect(saveProblems(withSaved, saved, '')).toHaveLength(1);
  });

  it('words durations for the freeze evidence line', () => {
    expect(durationText(0)).toBe('0 秒');
    expect(durationText(45_000)).toBe('45 秒');
    expect(durationText(90_000)).toBe('1.5 分钟');
    expect(durationText(600_000)).toBe('10 分钟');
  });
});

describe('pause banner helpers', () => {
  it('uses the spec severity for its tone and states time and push outcome', () => {
    const at = Date.UTC(2026, 8, 18, 16, 5, 7);
    const event = makeAlertEvent({ type: 'schedulePaused', instanceIndex: 1, reason: '账号未检查', at });
    const pause = pauseStateFromEvent(event, { notified: true, notifyError: null });
    expect(pauseTone(pause)).toBe('warning');
    expect(pauseTone({ severity: null })).toBe('danger');
    expect(pauseMeta(pause)).toEqual(['暂停于 2026-09-19 00:05:07（北京时间）', '已推送']);
    expect(pauseMeta({ ...pause, notified: null, notifyError: '网络不通' })[1]).toBe('推送未完成');
    expect(pauseMeta({ ...pause, notified: null })[1]).toBe('未配置推送或正在推送');
  });
});

describe('alerts store reducers', () => {
  it('keeps one pause per instance, lists the paused ones ascending and falls back to 「not paused」', () => {
    const paused = pauseStateFromEvent(makeAlertEvent({ type: 'deviceOffline', instanceIndex: 4, reason: 'x' }), { notified: null, notifyError: null });
    let pauses = upsertPause({}, paused);
    pauses = upsertPause(pauses, { ...paused, instanceIndex: 1 });
    pauses = upsertPause(pauses, emptyPauseState(2));
    expect(pausedIndexes(pauses)).toEqual([1, 4]);
    expect(pauseOf(pauses, 7)).toEqual(emptyPauseState(7));
    expect(pauseOf(pauses, null)).toBeNull();
  });

  it('prepends history records without duplicates and caps the list', () => {
    const record = (i: number): AlertRecord => ({
      event: { ...makeAlertEvent({ type: 'dispatchStalled', instanceIndex: 0, reason: String(i) }), id: `alert_${i}` },
      results: [], suppressed: false, pausedNow: false,
    });
    let history: AlertRecord[] = [];
    for (let i = 0; i < 120; i += 1) history = prependRecord(history, record(i));
    expect(history).toHaveLength(100);
    expect(history[0]?.event.id).toBe('alert_119');
    expect(prependRecord(history, record(119))).toHaveLength(100);
  });

  it('is registered in the shell (badge) and the settings registry (the 「通知与推送」 card)', () => {
    expect(BADGE_SOURCES.some((source) => source.name === 'PausedInstancesBadge')).toBe(true);
    expect(SETTINGS_CARDS.find((card) => card.key === 'notifications')?.component).toBe(AlertsSettingsCard);
  });
});
