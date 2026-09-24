/**
 * Port of the original `scripts/alerts-offline-check.ts` sections 一 / 二 (counting, thresholds, layer-2 degradation)
 * plus the contract helpers (single defaults authority, three-state token, masking, scrubbing, Beijing time, texts,
 * throttle persistence, callback data). No emulator, no network.
 */
import { describe, expect, it, vi } from 'vitest';
import type { GatherCycleFact } from '@avdm/automation/wanlong';
import type { MatchResult } from '@avdm/automation';
import {
  ALERT_RANGE, ALERT_SPECS, ALERT_TYPES, AlertThrottle, SUBSCRIBABLE_ALERT_TYPES, alertCallbackData, alertsPatchProblems,
  buildAlertKeyboard, defaultAlertsConfig, deliveryText, describeTelegramFailure, isRetriableFailure, ledgerKindLabel,
  makeAlertEvent, mapLegacyKinds, maskToken, mergeAlertsConfig, normalizeAlertsConfig, parseAlertCallbackData,
  pausesInstance, redactAlertsConfig, renderAlertSummary, renderAlertText, renderSuppressedNote, scrubSecret,
  toAlertsConfigView, validateRemoteBotConfig, validateTelegramConfig, type AlertDetectConfig, type NotifyResult,
} from '../src/shared/alerts';
import { FailureTracker } from '../src/main/alerts/detect';
import { KICKED_CANDIDATES, probeKickedFrame } from '../src/main/alerts/kicked';

/** ★ Test data, not a credential: shape-valid, never valid at Telegram. */
const FAKE_TOKEN = '999888777:AAFakeTokenForOfflineCheckOnly_0123456789';

function factOf(p: Partial<GatherCycleFact> = {}): GatherCycleFact {
  return {
    outcome: 'error', message: '第 G7 步失败：找不到「创建部队」页', step: null, errorCode: 'STEP_FAILED',
    dispatched: 0, captures: 1, shotPath: null, kicked: null, ...p,
  };
}

const detectDefaults = defaultAlertsConfig().detect;

function trackerOf(cfg: AlertDetectConfig = detectDefaults, now: () => number = () => Date.now()): FailureTracker {
  return new FailureTracker({ config: () => cfg, log: () => undefined, now });
}

describe('alert types: one table', () => {
  it('has a spec row for every type, and only the documented types pause', () => {
    for (const type of ALERT_TYPES) expect(ALERT_SPECS[type].type).toBe(type);
    expect(ALERT_TYPES.filter((type) => pausesInstance(type)).sort()).toEqual(
      ['consecutiveFailures', 'deviceOffline', 'needsAttention', 'schedulePaused', 'suspectedKicked'],
    );
    // Warnings never pause (freeze restarted / suspected freeze / stalled dispatch).
    for (const type of ['emulatorFrozen', 'suspectedFreeze', 'dispatchStalled'] as const) {
      expect(ALERT_SPECS[type]).toMatchObject({ severity: 'warning', pauses: false });
    }
    expect(SUBSCRIBABLE_ALERT_TYPES).not.toContain('test');
  });

  it('labels legacy ledger kinds and maps old subscriptions (newer types are added, not lost)', () => {
    expect(ledgerKindLabel('runFailed')).toBe('运行失败');
    expect(ledgerKindLabel('deviceOffline')).toBe(ALERT_SPECS.deviceOffline.title);
    const mapped = mapLegacyKinds(['consecutiveFailures', 'suspectedFreeze']);
    expect(mapped).toEqual(expect.arrayContaining(['consecutiveFailures', 'suspectedFreeze', 'emulatorFrozen']));
    expect(mapped).not.toContain('test');
  });
});

describe('config: single defaults authority, normalize / merge / validate', () => {
  it('ships the documented defaults (DECISIONS A.3: freeze restart and remote control opt-in)', () => {
    const cfg = defaultAlertsConfig();
    expect(cfg.detect).toMatchObject({
      autoPauseEnabled: true, cycleFailThreshold: 3, recoveryFailThreshold: 2, sampleFailThreshold: 3,
      freezeRestartEnabled: false, freezeMinutes: 5, freezeRestartLimit: 3, freezeRestartWindowMin: 60,
      // User request: a kicked account closes its emulator unless switched off.
      stopOnKicked: true,
    });
    expect(normalizeAlertsConfig({ detect: { stopOnKicked: 'no' } }).detect.stopOnKicked).toBe(true);
    expect(normalizeAlertsConfig({ detect: { stopOnKicked: false } }).detect.stopOnKicked).toBe(false);
    expect(cfg.telegram).toMatchObject({ enabled: false, cooldownSeconds: 600, retryCount: 2, remoteControlEnabled: false, remoteReadOnlyEnabled: false });
    expect(cfg.local.enabled).toBe(false);
    // Every default lies inside its range.
    const flat: Record<string, number> = { ...cfg.detect, ...cfg.telegram } as never;
    for (const [key, [lo, hi]] of Object.entries(ALERT_RANGE)) {
      expect(flat[key], key).toBeGreaterThanOrEqual(lo);
      expect(flat[key], key).toBeLessThanOrEqual(hi);
    }
  });

  it('normalizes per field: one bad field falls back alone, out-of-range values are clamped', () => {
    const cfg = normalizeAlertsConfig({
      detect: { cycleFailThreshold: 'x', sampleFailThreshold: 999, freezeRestartEnabled: true },
      telegram: { chatId: '  -100123  ', retryCount: -3, subscribedTypes: ['deviceOffline', 'test', 'nope', 'deviceOffline'] },
      extra: true,
    });
    expect(cfg.detect.cycleFailThreshold).toBe(detectDefaults.cycleFailThreshold);
    expect(cfg.detect.sampleFailThreshold).toBe(ALERT_RANGE.sampleFailThreshold[1]);
    expect(cfg.detect.freezeRestartEnabled).toBe(true);
    expect(cfg.telegram.chatId).toBe('-100123');
    expect(cfg.telegram.retryCount).toBe(0);
    expect(cfg.telegram.subscribedTypes).toEqual(['deviceOffline']);
    expect(normalizeAlertsConfig(null)).toEqual(defaultAlertsConfig());
  });

  it('adds newer subscription types to a file saved before freeze alerts existed (original migration rule)', () => {
    const old = normalizeAlertsConfig({ detect: {}, telegram: { subscribedTypes: ['consecutiveFailures'] } });
    expect(old.telegram.subscribedTypes).toEqual(expect.arrayContaining(['consecutiveFailures', 'emulatorFrozen', 'deviceOffline']));
    const current = normalizeAlertsConfig({ detect: { freezeRestartEnabled: false }, telegram: { subscribedTypes: ['consecutiveFailures'] } });
    expect(current.telegram.subscribedTypes).toEqual(['consecutiveFailures']);
  });

  it('merges the token in three states: absent keeps, a value replaces, empty clears and switches Telegram off', () => {
    const base = mergeAlertsConfig(defaultAlertsConfig(), {
      telegram: { botToken: FAKE_TOKEN, chatId: '123', enabled: true, remoteReadOnlyEnabled: true, remoteControlEnabled: true },
    });
    expect(base.telegram.botToken).toBe(FAKE_TOKEN);
    expect(mergeAlertsConfig(base, { telegram: { chatId: '456' } }).telegram).toMatchObject({ botToken: FAKE_TOKEN, chatId: '456', enabled: true });
    expect(mergeAlertsConfig(base, { telegram: { botToken: '111111:BBBBBBBBBBBBBBBBBBBBBBBB' } }).telegram.botToken).toBe('111111:BBBBBBBBBBBBBBBBBBBBBBBB');
    const cleared = mergeAlertsConfig(base, { telegram: { botToken: '' } });
    expect(cleared.telegram).toMatchObject({ botToken: '', enabled: false, remoteControlEnabled: false, remoteReadOnlyEnabled: false });
  });

  it('rejects unknown keys, wrong types and out-of-range numbers in a patch (Chinese, one line each)', () => {
    expect(alertsPatchProblems({ detect: { cycleFailThreshold: 3 } })).toEqual([]);
    const problems = alertsPatchProblems({ detect: { cycleFailThreshold: 0, nope: 1 }, telegram: { enabled: 'yes', subscribedTypes: ['test'] }, other: {} });
    expect(problems).toHaveLength(5);
    expect(problems.join('\n')).toMatch(/1–20/);
    expect(alertsPatchProblems('x')).toEqual(['告警设置无效']);
  });

  it('guides the Telegram and remote-bot preflight with distinct Chinese sentences', () => {
    expect(validateTelegramConfig({ botToken: FAKE_TOKEN, chatId: '-1001234567890' })).toEqual([]);
    const [token, chat] = validateTelegramConfig({ botToken: 'HTTP API: 123', chatId: '@me' });
    expect(token).toContain('格式不对');
    expect(chat).toContain('只能是数字');
    expect(validateTelegramConfig({ botToken: '', chatId: '' }).join('')).toContain('@BotFather');
    expect(validateRemoteBotConfig({ botToken: FAKE_TOKEN, chatId: '1', authorizedUserId: '' })).toHaveLength(1);
    expect(validateRemoteBotConfig({ botToken: FAKE_TOKEN, chatId: '1', authorizedUserId: '42' })).toEqual([]);
  });
});

describe('credentials: masked views and scrubbing', () => {
  it('never puts the token into a view or a redacted copy', () => {
    const cfg = mergeAlertsConfig(defaultAlertsConfig(), { telegram: { botToken: FAKE_TOKEN, chatId: '1' } });
    const view = toAlertsConfigView(cfg);
    expect('botToken' in view.telegram).toBe(false);
    expect(view.telegram).toMatchObject({ botTokenSet: true, botTokenMasked: '••••••••' });
    expect(JSON.stringify(view)).not.toContain('AAFake');
    expect(JSON.stringify(redactAlertsConfig(cfg))).not.toContain('AAFake');
    expect(maskToken('')).toBe('');
    expect(toAlertsConfigView(defaultAlertsConfig()).telegram).toMatchObject({ botTokenSet: false, botTokenMasked: '' });
  });

  it('scrubs every occurrence, and leaves text alone for empty or tiny secrets', () => {
    const url = `https://api.telegram.org/bot${FAKE_TOKEN}/sendMessage`;
    expect(scrubSecret(`fetch ${url} failed; again ${url}`, FAKE_TOKEN)).toBe('fetch https://api.telegram.org/bot***/sendMessage failed; again https://api.telegram.org/bot***/sendMessage');
    expect(scrubSecret('abc', '')).toBe('abc');
    expect(scrubSecret('a short one', 'short')).toBe('a short one');
  });
});

describe('texts: Beijing time, plain text, account enrichment', () => {
  it('renders the push in Beijing time whatever the host zone (host was America/Los_Angeles)', () => {
    const previous = process.env.TZ;
    process.env.TZ = 'America/Los_Angeles';
    try {
      const at = Date.UTC(2026, 8, 18, 16, 5, 7); // Beijing 2026-09-19 00:05:07
      const event = makeAlertEvent({
        type: 'deviceOffline', instanceIndex: 2, reason: '连续 3 次打不开部队管理面板', accountName: '主号_[1]*',
        shotPath: 'automation/wanlong/shots/inst2-health-probe-1.jpg', detail: { 连续采样失败次数: 3, 空: null }, at,
      });
      const text = renderAlertText(event);
      expect(text).toContain('2026-09-19 00:05:07（北京时间）');
      expect(text).toContain('实例 #2（主号_[1]*）');
      expect(text).toContain('【需要人工介入】模拟器或游戏掉线');
      expect(text).toContain('现场：连续采样失败次数=3');
      expect(text).not.toContain('空=');
      expect(text).toContain('截图：automation/wanlong/shots/inst2-health-probe-1.jpg');
      expect(text).toContain(`处置：${ALERT_SPECS.deviceOffline.advice}`);
      expect(renderAlertText({ ...event, accountName: null })).toContain('实例 #2（未绑定账号）');
      expect(renderAlertSummary(event)).toBe('实例 #2｜模拟器或游戏掉线｜连续 3 次打不开部队管理面板');
      // A title equal to its level is not written twice.
      expect(renderAlertText(makeAlertEvent({ type: 'needsAttention', instanceIndex: 0, reason: 'x', at }))).toMatch(/^【需要人工介入】\n/);
    } finally {
      if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous;
    }
  });

  it('builds events only through makeAlertEvent (severity from the table, dedupe key per instance + type)', () => {
    const event = makeAlertEvent({ type: 'emulatorFrozen', instanceIndex: 4, reason: 'x', at: 1 });
    expect(event).toMatchObject({ severity: 'warning', dedupeKey: '4:emulatorFrozen', accountName: null, shotPath: null });
    expect(event.id).toMatch(/^alert_/);
    expect(makeAlertEvent({ type: 'test', instanceIndex: -1, reason: 'x' }).id).not.toBe(event.id);
  });

  it('describes deliveries for lists', () => {
    const ok: NotifyResult = { ok: true, channel: 'telegram', failure: null, message: '', attempts: 1, elapsedMs: 1, at: 1, retryAfterSec: null };
    expect(deliveryText({ results: [], suppressed: false })).toBe('未配置推送');
    expect(deliveryText({ results: [ok], suppressed: false })).toBe('已推送（Telegram）');
    expect(deliveryText({ results: [{ ...ok, ok: false, failure: 'throttled' }], suppressed: true })).toBe('冷却期内已去重，未推送');
    expect(renderSuppressedNote(0)).toBe('');
    expect(renderSuppressedNote(2)).toContain('2 次');
  });
});

describe('throttle', () => {
  it('suppresses within the cooldown, reads the cooldown live, survives a snapshot round trip and resets per instance', () => {
    let cooldown = 600;
    const throttle = new AlertThrottle(() => cooldown);
    const key = 'telegram|1:deviceOffline';
    expect(throttle.check(key, 0).allow).toBe(true);
    throttle.markSent(key, 0);
    expect(throttle.check(key, 1_000).allow).toBe(false);
    throttle.markSuppressed(key, 1_000);
    expect(throttle.check(key, 600_000)).toMatchObject({ allow: true, suppressedCount: 1 });
    cooldown = 0;
    expect(throttle.check(key, 1_001).allow).toBe(true);
    cooldown = 600;
    const restored = new AlertThrottle(() => cooldown);
    restored.restore(JSON.parse(JSON.stringify(throttle.snapshot())));
    expect(restored.check(key, 2_000).allow).toBe(false);
    restored.markSent('local|1:consecutiveFailures', 0);
    restored.markSent('telegram|10:deviceOffline', 0);
    restored.resetInstance(1);
    expect(restored.check(key, 2_000).allow).toBe(true);
    expect(restored.check('local|1:consecutiveFailures', 2_000).allow).toBe(true);
    expect(restored.check('telegram|10:deviceOffline', 2_000).allow).toBe(false);
    restored.restore({ bad: null as never, ok: { lastSentAt: 'x' as never, suppressedCount: -2, lastSuppressedAt: null } });
    expect(restored.snapshot()).toEqual({ ok: { lastSentAt: 0, suppressedCount: 0, lastSuppressedAt: null } });
  });
});

describe('Telegram failure classification (pure part)', () => {
  it('gives bad token, bad chat, network, timeout, rate limit and server errors their own guidance', () => {
    expect(describeTelegramFailure({ status: 401, description: 'Unauthorized', retryAfterSec: null, transportError: null }).kind).toBe('badToken');
    expect(describeTelegramFailure({ status: 404, description: 'Not Found', retryAfterSec: null, transportError: null }).message).toContain('不存在');
    expect(describeTelegramFailure({ status: 400, description: 'Bad Request: chat not found', retryAfterSec: null, transportError: null }).kind).toBe('badChat');
    expect(describeTelegramFailure({ status: 403, description: 'Forbidden', retryAfterSec: null, transportError: null }).message).toContain('/start');
    expect(describeTelegramFailure({ status: 429, description: null, retryAfterSec: 7, transportError: null }).message).toContain('7 秒');
    expect(describeTelegramFailure({ status: 502, description: null, retryAfterSec: null, transportError: null }).kind).toBe('serverError');
    expect(describeTelegramFailure({ status: null, description: null, retryAfterSec: null, transportError: 'The operation was aborted due to timeout' }).kind).toBe('timeout');
    const network = describeTelegramFailure({ status: null, description: null, retryAfterSec: null, transportError: 'fetch failed ← getaddrinfo ENOTFOUND（ENOTFOUND）' });
    expect(network.kind).toBe('network');
    expect(network.message).toContain('ENOTFOUND');
    expect(['network', 'timeout', 'serverError', 'rateLimited'].every((kind) => isRetriableFailure(kind as never))).toBe(true);
    expect(isRetriableFailure('badToken') || isRetriableFailure('badChat')).toBe(false);
  });
});

describe('remote-control buttons (callback data shared with the bot)', () => {
  it('uses the original `action:index` format and only shows buttons while remote control is on', () => {
    expect(alertCallbackData('resume', 3)).toBe('resume:3');
    expect(parseAlertCallbackData('relaunch:12')).toEqual({ action: 'relaunch', instanceIndex: 12 });
    for (const bad of ['resume:', 'resume:x', 'delete:1', 'resume:64', 'resume:1:2', '']) expect(parseAlertCallbackData(bad)).toBeNull();
    const pause = { type: 'deviceOffline' as const, instanceIndex: 2 };
    expect(buildAlertKeyboard(pause, { remoteControlEnabled: false })).toBeUndefined();
    const keyboard = buildAlertKeyboard(pause, { remoteControlEnabled: true });
    expect(keyboard?.inline_keyboard.flat().map((button) => button.callback_data)).toEqual(['resume:2', 'relaunch:2', 'status:2']);
    expect(buildAlertKeyboard({ type: 'instanceResumed', instanceIndex: 2 }, { remoteControlEnabled: true })?.inline_keyboard.flat()).toHaveLength(1);
    expect(buildAlertKeyboard({ type: 'test', instanceIndex: -1 }, { remoteControlEnabled: true })).toBeUndefined();
    expect(buildAlertKeyboard({ type: 'dispatchStalled', instanceIndex: 1 }, { remoteControlEnabled: true })).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 一、失败计数与阈值 (original section 1)
// ══════════════════════════════════════════════════════════════════════════

describe('FailureTracker (original section 一)', () => {
  it('raises consecutiveFailures at the threshold and restarts the chain afterwards', () => {
    const t = trackerOf();
    expect(t.noteCycle(0, factOf())).toBeNull();
    expect(t.noteCycle(0, factOf())).toBeNull();
    const event = t.noteCycle(0, factOf({ shotPath: 'automation/wanlong/shots/a.jpg' }));
    expect(event).toMatchObject({ type: 'consecutiveFailures', shotPath: 'automation/wanlong/shots/a.jpg' });
    expect(event?.reason).toContain('找不到「创建部队」页');
    expect(t.noteCycle(0, factOf())).toBeNull();
  });

  it('raises needsAttention earlier for exhausted recovery ladders (G0) and names kicked / maintenance / update', () => {
    const t = trackerOf();
    expect(t.noteCycle(0, factOf({ step: 'G0' }))).toBeNull();
    const event = t.noteCycle(0, factOf({ step: 'G0' }));
    expect(event?.type).toBe('needsAttention');
    expect(event?.reason).toContain('顶号');
  });

  it('★ queueFull / noResourceWanted / giveUp / staminaLow / circuitBroken are not failures and reset the counters', () => {
    const t = trackerOf();
    for (const outcome of ['queueFull', 'noResourceWanted', 'giveUp', 'staminaLow', 'circuitBroken'] as const) {
      t.noteCycle(9, factOf());
      t.noteCycle(9, factOf());
      expect(t.noteCycle(9, factOf({ outcome, message: outcome }))).toBeNull();
      expect(t.peek(9)?.cycleFail).toBe(0);
    }
    // A cancelled cycle neither counts nor resets.
    t.noteCycle(9, factOf());
    t.noteCycle(9, factOf({ outcome: 'cancelled' }));
    expect(t.peek(9)?.cycleFail).toBe(1);
  });

  it('turns a layer-2 hit into an event at once and merges its detail', () => {
    const t = trackerOf();
    const event = t.noteCycle(0, factOf({ kicked: { type: 'suspectedKicked', reason: '画面上出现了「账号已在其他设备登录」的提示框', templateId: 'tpl_dlg_kicked', score: 0.97 } }));
    expect(event).toMatchObject({ type: 'suspectedKicked', detail: { 命中模板: 'tpl_dlg_kicked', 匹配分: 0.97 } });
    // Maintenance / update hits (and unknown types) become needsAttention.
    expect(t.noteCycle(0, factOf({ kicked: { type: 'maintenance', reason: '维护' } }))?.type).toBe('needsAttention');
  });

  it('counts failed samples to deviceOffline; a good sample restarts the count', () => {
    const t = trackerOf();
    expect(t.noteSampleFailed(1, 'adb 连不上')).toBeNull();
    expect(t.noteSampleFailed(1, 'adb 连不上')).toBeNull();
    t.noteSampleOk(1);
    expect(t.noteSampleFailed(1, 'adb 连不上')).toBeNull();
    t.noteSampleFailed(1, 'adb 连不上');
    const event = t.noteSampleFailed(1, 'adb 连不上');
    expect(event?.type).toBe('deviceOffline');
    expect(event?.reason).toContain('adb 连不上');
  });

  it('warns once per stall window when nothing was dispatched for a long time (never pauses)', () => {
    let clock = 1_700_000_000_000;
    const t = trackerOf(detectDefaults, () => clock);
    t.noteCycle(2, factOf({ outcome: 'dispatched', dispatched: 1, message: '派出 1 支' }));
    clock += (detectDefaults.stalledMinutes + 1) * 60_000;
    const event = t.noteCycle(2, factOf({ outcome: 'staminaLow', message: '指挥官耐力不足' }));
    expect(event).toMatchObject({ type: 'dispatchStalled', severity: 'warning' });
    expect(pausesInstance(event!.type)).toBe(false);
    expect(t.noteCycle(2, factOf({ outcome: 'staminaLow', message: '指挥官耐力不足' }))).toBeNull();
  });

  it('reads thresholds live from the config (a settings change applies without a restart)', () => {
    let cfg: AlertDetectConfig = { ...detectDefaults };
    const t = new FailureTracker({ config: () => cfg, log: () => undefined });
    expect(t.noteCycle(5, factOf())).toBeNull();
    cfg = { ...detectDefaults, cycleFailThreshold: 1 };
    expect(t.noteCycle(5, factOf())).not.toBeNull();
    t.noteCycle(6, factOf());
    t.reset(6);
    expect(t.peek(6)).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 二、第二层：模板缺失必须静默降级 (original section 2)
// ══════════════════════════════════════════════════════════════════════════

function match(templateId: string, score: number, found = true, threshold = 0.85): MatchResult {
  return { templateId, found, score, x: 0, y: 0, w: 1, h: 1, centerX: 0, centerY: 0, threshold, elapsedMs: 1 };
}

describe('layer-2 kicked probe (original section 二)', () => {
  it('★ returns null and never throws while the reserved templates are missing', async () => {
    const missing = vi.fn(async (ids: string[]) => ids.map((id) => ({ ...match(id, 0, false), reason: '模板缺失' })));
    await expect(probeKickedFrame(missing)).resolves.toBeNull();
    expect(missing).toHaveBeenCalledWith(KICKED_CANDIDATES.map((candidate) => candidate.id));
    const logs: string[] = [];
    await expect(probeKickedFrame(async () => { throw new Error('视觉进程没有启动'); }, (_level, message) => logs.push(message))).resolves.toBeNull();
    expect(logs.join('')).toContain('降级');
  });

  it('needs max(0.92, template threshold) and answers the candidates in priority order', async () => {
    await expect(probeKickedFrame(async () => [match('tpl_dlg_kicked', 0.9)])).resolves.toBeNull();
    await expect(probeKickedFrame(async () => [match('tpl_dlg_kicked', 0.94, true, 0.95)])).resolves.toBeNull();
    const hit = await probeKickedFrame(async () => [match('tpl_dlg_update', 0.99), match('tpl_login_screen', 0.95)]);
    expect(hit).toMatchObject({ type: 'suspectedKicked', detail: { 命中模板: 'tpl_login_screen' } });
    const update = await probeKickedFrame(async () => [match('tpl_dlg_update', 0.99)]);
    expect(update?.type).toBe('needsAttention');
  });
});
