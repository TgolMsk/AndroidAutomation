/**
 * Port of the original `scripts/alerts-offline-check.ts` sections 三 / 四 / 五: the Telegram channel's failure
 * classification, the ★ token leak test (a token-bearing URL stuffed into every possible exit) and NotifyHub's three
 * gates with the persisted cooldown. Fake fetch, fake codec, fake sleep: no network, no Keychain, no waiting.
 */
import { mkdtemp, readFile, readdir, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  TELEGRAM_PHOTO_MAX_BYTES, defaultAlertsConfig, makeAlertEvent, type AlertEvent, type TelegramConfig,
} from '../src/shared/alerts';
import { NotifyHub } from '../src/main/alerts/notifier';
import type { SecretCodec } from '../src/main/alerts/store';
import { TelegramNotifier, describeThrown, type FetchLike } from '../src/main/alerts/telegram';

// ★ Test data, not a credential: shape-valid (passes validateTelegramConfig) but never valid at Telegram.
const FAKE_TOKEN = '999888777:AAFakeTokenForOfflineCheckOnly_0123456789';
/** Its second half, scanned on its own so a half-scrubbed token is caught as well. */
const FAKE_TOKEN_TAIL = 'AAFakeTokenForOfflineCheckOnly_0123456789';
const FAKE_CHAT_ID = '123456789';

function leaks(text: string): boolean {
  return text.includes(FAKE_TOKEN) || text.includes(FAKE_TOKEN_TAIL);
}

interface FakeCall {
  url: string;
  headers: Record<string, string>;
  /** JSON body text; '[FormData]' for multipart (fields in formFields). */
  body: string;
  form?: FormData;
  formFields?: Record<string, string>;
}

interface FakeReply {
  status: number;
  json: unknown;
  /** Throw instead (transport failure). */
  throwWith?: (url: string) => Error;
  /** Throw while reading the body. */
  bodyThrows?: (url: string) => Error;
}

/** Records every request and answers from a script (then the fallback). */
class FakeTelegram {
  readonly calls: FakeCall[] = [];
  private script: FakeReply[] = [];
  private fallback: FakeReply = { status: 200, json: { ok: true, result: { message_id: 1 } } };

  queue(...replies: FakeReply[]): void { this.script = [...replies]; }
  setFallback(reply: FakeReply): void { this.fallback = reply; }
  reset(): void {
    this.calls.length = 0;
    this.script = [];
    this.fallback = { status: 200, json: { ok: true, result: { message_id: 1 } } };
  }

  readonly impl: FetchLike = async (url, init) => {
    if (typeof init.body === 'string') {
      this.calls.push({ url, headers: { ...(init.headers ?? {}) }, body: init.body });
    } else {
      const formFields: Record<string, string> = {};
      for (const [key, value] of init.body.entries()) formFields[key] = typeof value === 'string' ? value : `[blob ${value.size}B]`;
      this.calls.push({ url, headers: { ...(init.headers ?? {}) }, body: '[FormData]', form: init.body, formFields });
    }
    const reply = this.script.shift() ?? this.fallback;
    if (reply.throwWith) throw reply.throwWith(url);
    return {
      status: reply.status,
      text: async () => {
        if (reply.bodyThrows) throw reply.bodyThrows(url);
        return JSON.stringify(reply.json);
      },
    };
  };
}

function telegramConfig(p: Partial<TelegramConfig> = {}): TelegramConfig {
  return { ...defaultAlertsConfig().telegram, enabled: true, botToken: FAKE_TOKEN, chatId: FAKE_CHAT_ID, retryCount: 0, timeoutMs: 5_000, ...p };
}

function sampleEvent(): AlertEvent {
  return makeAlertEvent({
    type: 'needsAttention', instanceIndex: 3, reason: '连续 2 轮都回不到世界地图',
    // ★ Markdown metacharacters on purpose: the reason there is no parse_mode.
    accountName: '主号-王朝A_区[测试]',
  });
}

const tg = new FakeTelegram();
let waits: number[] = [];

function notifier(logs: string[], p: Partial<TelegramConfig> = {}, fetch: FetchLike = tg.impl, controlHandled = false): TelegramNotifier {
  return new TelegramNotifier({
    config: () => telegramConfig(p),
    fetch,
    sleep: async (ms) => { waits.push(ms); },
    log: (level, message) => logs.push(`[${level}] ${message}`),
    controlHandled: () => controlHandled,
  });
}

beforeEach(() => { tg.reset(); waits = []; });

// ══════════════════════════════════════════════════════════════════════════
// 三、Telegram 通道：失败分类与中文话术
// ══════════════════════════════════════════════════════════════════════════

describe('Telegram channel (original section 三)', () => {
  it('sends one plain-text request with the configured chat, account, reason, Beijing time and advice', async () => {
    const result = await notifier([]).send(sampleEvent());
    expect(result).toMatchObject({ ok: true, attempts: 1, failure: null, channel: 'telegram' });
    expect(tg.calls).toHaveLength(1);
    expect(tg.calls[0]!.url).toBe(`https://api.telegram.org/bot${FAKE_TOKEN}/sendMessage`);
    expect(tg.calls[0]!.headers['content-type']).toBe('application/json');
    const body = JSON.parse(tg.calls[0]!.body) as Record<string, unknown>;
    expect(body.chat_id).toBe(FAKE_CHAT_ID);
    expect('parse_mode' in body).toBe(false);
    expect(body.disable_web_page_preview).toBe(true);
    expect('reply_markup' in body).toBe(false);
    const text = String(body.text);
    for (const part of ['实例 #3', '主号-王朝A_区[测试]', '需要人工介入', '连续 2 轮都回不到世界地图', '（北京时间）', '处置：']) {
      expect(text).toContain(part);
    }
  });

  it('adds the remote-control buttons only when remote control is on AND a bot handles their callbacks', async () => {
    const buttons = (call: number): string[] | undefined =>
      (JSON.parse(tg.calls[call]!.body) as { reply_markup?: { inline_keyboard: Array<Array<{ callback_data: string }>> } })
        .reply_markup?.inline_keyboard.flat().map((button) => button.callback_data);
    await notifier([], { remoteControlEnabled: true, remoteReadOnlyEnabled: true }, tg.impl, true).send(sampleEvent());
    expect(buttons(0)).toEqual(['resume:3', 'relaunch:3', 'status:3']);
    // ★ No bot running: a button nobody answers would spin forever on the phone.
    await notifier([], { remoteControlEnabled: true, remoteReadOnlyEnabled: true }, tg.impl, false).send(sampleEvent());
    expect(buttons(1)).toBeUndefined();
    await notifier([], { remoteControlEnabled: false }, tg.impl, true).send(sampleEvent());
    expect(buttons(2)).toBeUndefined();
    // Each switch attaches only its own buttons (the bot refuses the others).
    await notifier([], { remoteControlEnabled: true, remoteReadOnlyEnabled: false }, tg.impl, true).send(sampleEvent());
    expect(buttons(3)).toEqual(['resume:3', 'relaunch:3']);
    await notifier([], { remoteControlEnabled: false, remoteReadOnlyEnabled: true }, tg.impl, true).send(sampleEvent());
    expect(buttons(4)).toEqual(['status:3']);
  });

  it.each([401, 404])('HTTP %i is a bad token: guidance names @BotFather, one request only, attempts = 1', async (status) => {
    tg.setFallback({ status, json: { ok: false, description: 'Unauthorized' } });
    const result = await notifier([], { retryCount: 2 }).send(sampleEvent());
    expect(result.failure).toBe('badToken');
    expect(result.message).toContain('BotFather');
    expect(tg.calls).toHaveLength(1);
    expect(result.attempts).toBe(1);
  });

  it('400 chat not found is a bad chat id with guidance; 403 has its own sentence', async () => {
    tg.setFallback({ status: 400, json: { ok: false, description: 'Bad Request: chat not found' } });
    const chat = await notifier([]).send(sampleEvent());
    expect(chat.failure).toBe('badChat');
    expect(chat.message).toContain('userinfobot');
    tg.setFallback({ status: 403, json: { ok: false, description: 'Forbidden: bot was blocked by the user' } });
    const forbidden = await notifier([]).send(sampleEvent());
    expect(forbidden.failure).toBe('badChat');
    expect(forbidden.message).toContain('/start');
  });

  it('429 waits what Telegram asked and retries until it works', async () => {
    tg.queue({ status: 429, json: { ok: false, description: 'Too Many Requests', parameters: { retry_after: 3 } } });
    const result = await notifier([], { retryCount: 2 }).send(sampleEvent());
    expect(result).toMatchObject({ ok: true, attempts: 2 });
    expect(result.message).toContain('第 2 次');
    expect(tg.calls).toHaveLength(2);
    expect(waits).toEqual([3_000]);
  });

  it('a transport failure is network with the errno kept, and is retried on the backoff ladder', async () => {
    tg.setFallback({
      status: 0, json: null,
      throwWith: () => {
        const inner = Object.assign(new Error('getaddrinfo ENOTFOUND api.telegram.org'), { code: 'ENOTFOUND' });
        return Object.assign(new Error('fetch failed'), { cause: inner });
      },
    });
    const result = await notifier([], { retryCount: 1 }).send(sampleEvent());
    expect(result.failure).toBe('network');
    expect(result.message).toContain('api.telegram.org');
    expect(result.message).toContain('代理');
    expect(result.message).toContain('ENOTFOUND');
    expect(tg.calls).toHaveLength(2);
    expect(result.attempts).toBe(2);
    expect(waits).toEqual([1_000]);
  });

  it('5xx is retried; a 2xx without ok:true (a proxy page) is not a success', async () => {
    tg.queue({ status: 502, json: { ok: false } }, { status: 502, json: { ok: false } });
    const server = await notifier([], { retryCount: 1 }).send(sampleEvent());
    expect(server).toMatchObject({ ok: false, failure: 'serverError', attempts: 2 });
    tg.reset();
    tg.setFallback({ status: 200, json: { hello: 'proxy' } });
    const proxy = await notifier([], { retryCount: 2 }).send(sampleEvent());
    expect(proxy).toMatchObject({ ok: false, failure: 'unknown', attempts: 1 });
  });

  it('caps the total retry wait (a slow push never holds the caller for minutes)', async () => {
    tg.setFallback({ status: 429, json: { ok: false, parameters: { retry_after: 50 } } });
    const result = await notifier([], { retryCount: 5 }).send(sampleEvent());
    expect(result.failure).toBe('rateLimited');
    expect(result.retryAfterSec).toBe(50);
    expect(waits.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(60_000);
    expect(tg.calls).toHaveLength(2);
  });

  it('answers notConfigured / disabled without a request; the test push ignores the switch on purpose', async () => {
    const half = await notifier([], { botToken: '', chatId: '' }).send(sampleEvent());
    expect(half.failure).toBe('notConfigured');
    expect(half.message).toContain('BotFather');
    expect(half.message).toContain('userinfobot');
    const off = notifier([], { enabled: false });
    expect((await off.send(sampleEvent())).failure).toBe('disabled');
    expect(tg.calls).toHaveLength(0);
    const test = await off.test();
    expect(test.ok).toBe(true);
    expect(String((JSON.parse(tg.calls[0]!.body) as { text: string }).text)).toContain('实例 #-1');
  });

  it('sendPhoto: FormData with a fresh body per retry, never a hand-written content-type', async () => {
    tg.queue({ status: 500, json: { ok: false } });
    const image = new Uint8Array(2048).fill(7);
    const result = await notifier([], { retryCount: 1 }).sendPhoto('', image, '实例 #1 现场', 'inst1.jpg');
    expect(result).toMatchObject({ ok: true, attempts: 2 });
    expect(tg.calls).toHaveLength(2);
    for (const call of tg.calls) {
      expect(call.url).toContain('/sendPhoto');
      expect(Object.keys(call.headers).map((key) => key.toLowerCase())).not.toContain('content-type');
      expect(call.formFields).toEqual({ chat_id: FAKE_CHAT_ID, caption: '实例 #1 现场', photo: '[blob 2048B]' });
    }
    expect(tg.calls[0]!.form).not.toBe(tg.calls[1]!.form);
  });

  it('sendPhoto over 10 MB fails without a request (the caller falls back to text)', async () => {
    const result = await notifier([]).sendPhoto('', new Uint8Array(TELEGRAM_PHOTO_MAX_BYTES + 1), 'x');
    expect(result).toMatchObject({ ok: false, attempts: 0 });
    expect(result.message).toContain('10MB');
    expect(tg.calls).toHaveLength(0);
  });

  it('describeThrown keeps message and two levels of cause with errno, never the stack', () => {
    const error = Object.assign(new Error('outer'), {
      cause: Object.assign(new Error('inner'), { code: 'ECONNRESET', cause: new Error('deepest') }),
    });
    error.stack = 'Error: outer\n    at secret-frame';
    expect(describeThrown(error)).toBe('outer ← inner（ECONNRESET） ← deepest');
    expect(describeThrown('plain')).toBe('plain');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 四、★ token 泄露实测
// ══════════════════════════════════════════════════════════════════════════

/** Reversible fake of safeStorage: the stored text never contains the plaintext. */
const codec: SecretCodec = {
  encrypt: async (plain) => `enc:${Buffer.from(plain).toString('base64')}`,
  decrypt: async (ciphertext) => Buffer.from(ciphertext.replace(/^enc:/, ''), 'base64').toString(),
};

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await filesUnder(full));
    else out.push(full);
  }
  return out;
}

describe('★ token leak (original section 四)', () => {
  let home: string;
  beforeEach(async () => { home = await mkdtemp(path.join(tmpdir(), 'avdm-alerts-leak-')); });
  afterEach(async () => { await rm(home, { recursive: true, force: true }); });

  it('keeps the token out of results, logs, views and every file on disk', async () => {
    const logs: string[] = [];
    // ① undici-style: message, cause and stack all carry the token-bearing URL.
    tg.setFallback({
      status: 0, json: null,
      throwWith: (url) => {
        const inner = Object.assign(new Error(`connect ECONNREFUSED 149.154.167.220:443 ${url}`), { code: 'ECONNREFUSED' });
        const outer = Object.assign(new Error(`fetch failed: ${url}`), { cause: inner });
        outer.stack = `Error: fetch failed: ${url}\n    at Object.fetch (node:internal/deps/undici/undici:13502:13)`;
        return outer;
      },
    });
    const r1 = await notifier(logs).send(sampleEvent());
    expect(tg.calls[0]!.url).toContain(FAKE_TOKEN);
    expect(leaks(r1.message)).toBe(false);
    expect(leaks(JSON.stringify(r1))).toBe(false);
    expect(r1.message).toContain('ECONNREFUSED');
    expect(r1.message).toContain('bot***/sendMessage');

    // ② The response body echoes the token (a proxy might).
    tg.reset();
    tg.setFallback({ status: 400, json: { ok: false, description: `Bad Request: something about https://api.telegram.org/bot${FAKE_TOKEN}/sendMessage` } });
    const r2 = await notifier(logs).send(sampleEvent());
    expect(leaks(r2.message)).toBe(false);

    // ③ The body read breaks midway.
    tg.reset();
    tg.setFallback({ status: 200, json: null, bodyThrows: (url) => new Error(`aborted while reading ${url}`) });
    const r3 = await notifier(logs).send(sampleEvent());
    expect(r3.failure).toBe('network');
    expect(leaks(r3.message)).toBe(false);

    // ④ The retry path writes 「第 N 次失败，X 秒后重试」 lines into the log.
    tg.reset();
    tg.queue({ status: 0, json: null, throwWith: (url) => Object.assign(new Error(`fetch failed ${url}`), { cause: new Error(`getaddrinfo ENOTFOUND ${url}`) }) });
    await notifier(logs, { retryCount: 1 }).send(sampleEvent());

    // ⑤ The hub: save the token, push through a failing channel, then scan its logs, view and files.
    const hubLogs: string[] = [];
    tg.reset();
    tg.setFallback({ status: 0, json: null, throwWith: (url) => new Error(`fetch failed ${url}`) });
    const hub = new NotifyHub(home, { codec, fetch: tg.impl, sleep: async () => undefined, log: (level, message) => hubLogs.push(`[${level}] ${message}`) });
    await hub.saveConfig({ telegram: { botToken: FAKE_TOKEN, chatId: FAKE_CHAT_ID, enabled: true, retryCount: 1 } });
    const outcome = await hub.dispatch(sampleEvent());
    expect(outcome.results[0]?.ok).toBe(false);
    expect(leaks(JSON.stringify(outcome))).toBe(false);
    const test = await hub.test('telegram');
    expect(leaks(JSON.stringify(test))).toBe(false);
    await hub.flush();

    const allLogs = [...logs, ...hubLogs];
    expect(allLogs.filter(leaks)).toEqual([]);
    expect(allLogs.length).toBeGreaterThanOrEqual(3);

    // ⑥ The IPC exit: the masked view, no botToken key at all, not even the last four characters.
    const view = hub.getConfigView();
    expect(leaks(JSON.stringify(view))).toBe(false);
    expect('botToken' in view.telegram).toBe(false);
    expect(view.telegram).toMatchObject({ botTokenSet: true, botTokenMasked: '••••••••' });
    expect(view.telegram.botTokenMasked).not.toContain(FAKE_TOKEN.slice(-4));
    expect(JSON.stringify(await hub.legacyNotificationView('wanlong', 0))).not.toContain(FAKE_TOKEN_TAIL);
    expect(JSON.stringify(await hub.remoteBotConfig())).not.toContain(FAKE_TOKEN_TAIL);

    // ⑦ Disk: nothing holds the plaintext — config.json keeps the safeStorage ciphertext only (stricter than the
    //    original, whose alerts.json held the plaintext).
    const files = await filesUnder(home);
    expect(files.some((file) => file.endsWith(path.join('alerts', 'config.json')))).toBe(true);
    for (const file of files) expect(leaks(await readFile(file, 'utf8')), file).toBe(false);
    const stored = JSON.parse(await readFile(path.join(home, 'automation', 'alerts', 'config.json'), 'utf8')) as { telegram: Record<string, unknown> };
    expect(stored.telegram.tokenCiphertext).toBe(await codec.encrypt(FAKE_TOKEN));
    expect('botToken' in stored.telegram).toBe(false);
    if (process.platform !== 'win32') expect((await stat(path.join(home, 'automation', 'alerts', 'config.json'))).mode & 0o777).toBe(0o600);

    // The runtime config for the bot (main process only) is the one place with the plaintext.
    expect(hub.currentTelegramConfig().botToken).toBe(FAKE_TOKEN);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 五、三道闸（开关 / 订阅 / 冷却）与落盘往返
// ══════════════════════════════════════════════════════════════════════════

describe('NotifyHub gates and cooldown (original section 五)', () => {
  let home: string;
  let now: number;
  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'avdm-alerts-hub-'));
    now = Date.parse('2026-09-24T04:00:00Z');
  });
  afterEach(async () => { await rm(home, { recursive: true, force: true }); });

  const makeHub = (extra: Partial<ConstructorParameters<typeof NotifyHub>[1]> = {}) =>
    new NotifyHub(home, { codec, fetch: tg.impl, sleep: async () => undefined, now: () => now, ...extra });
  const text = (index: number) => String((JSON.parse(tg.calls[index]!.body) as { text: string }).text);

  it('switch → subscription → cooldown, per instance and type; failures never eat the window; the cooldown survives a restart', async () => {
    const hub = makeHub();
    await hub.saveConfig({ telegram: { botToken: FAKE_TOKEN, chatId: FAKE_CHAT_ID } });

    // Gate 1: the switch.
    const off = await hub.dispatch(makeAlertEvent({ type: 'needsAttention', instanceIndex: 7, reason: '开关关着' }));
    expect(tg.calls).toHaveLength(0);
    expect(off.suppressed).toBe(true);
    expect(off.results.map((result) => result.failure)).toEqual(['disabled', 'disabled']);

    // Gate 2: the subscription.
    await hub.saveConfig({ telegram: { enabled: true, subscribedTypes: ['deviceOffline'] } });
    const unsubscribed = await hub.dispatch(makeAlertEvent({ type: 'needsAttention', instanceIndex: 7, reason: '没订阅' }));
    expect(tg.calls).toHaveLength(0);
    expect(unsubscribed.results[0]?.failure).toBe('unsubscribed');
    // Chinese for the banner and the history: the type's title, never its id.
    expect(unsubscribed.results[0]?.message).toContain('「需要人工介入」');
    expect(unsubscribed.results[0]?.message).not.toContain('needsAttention');

    // Gate 3: the cooldown.
    await hub.saveConfig({ telegram: { subscribedTypes: [...defaultAlertsConfig().telegram.subscribedTypes], cooldownSeconds: 600 } });
    expect((await hub.dispatch(makeAlertEvent({ type: 'needsAttention', instanceIndex: 7, reason: '第一次' }))).results[0]?.ok).toBe(true);
    const second = await hub.dispatch(makeAlertEvent({ type: 'needsAttention', instanceIndex: 7, reason: '第二次' }));
    expect(tg.calls).toHaveLength(1);
    expect(second.results[0]?.failure).toBe('throttled');
    expect(second.suppressed).toBe(true);
    expect((await hub.dispatch(makeAlertEvent({ type: 'deviceOffline', instanceIndex: 7, reason: '换个类型' }))).results[0]?.ok).toBe(true);
    expect((await hub.dispatch(makeAlertEvent({ type: 'needsAttention', instanceIndex: 8, reason: '换个实例' }))).results[0]?.ok).toBe(true);
    expect(tg.calls).toHaveLength(3);

    // The suppressed count is announced with the next allowed send.
    await hub.dispatch(makeAlertEvent({ type: 'needsAttention', instanceIndex: 7, reason: '第三次' }));
    now += 601_000;
    expect((await hub.dispatch(makeAlertEvent({ type: 'needsAttention', instanceIndex: 7, reason: '冷却过后' }))).results[0]?.ok).toBe(true);
    expect(text(tg.calls.length - 1).split('\n').at(-1)).toContain('冷却期内还发生过 2 次同类事件');

    // The cooldown is persisted and restored by a new hub (a restart must not re-spam a still broken instance).
    await hub.flush();
    const throttleFile = JSON.parse(await readFile(path.join(home, 'automation', 'alerts', 'throttle.json'), 'utf8')) as { throttle: Record<string, unknown> };
    expect(Object.keys(throttleFile.throttle)).toContain('telegram|7:needsAttention');
    const restarted = makeHub();
    await restarted.ready;
    expect(restarted.getConfigView().telegram).toMatchObject({ enabled: true, cooldownSeconds: 600, botTokenSet: true });
    expect(restarted.currentTelegramConfig().botToken).toBe(FAKE_TOKEN);
    expect((await restarted.dispatch(makeAlertEvent({ type: 'needsAttention', instanceIndex: 7, reason: '重启后' }))).results[0]?.failure).toBe('throttled');

    // A failed send does not restart the window.
    tg.setFallback({ status: 500, json: { ok: false, description: 'Internal Server Error' } });
    await restarted.saveConfig({ telegram: { retryCount: 0 } });
    const failed = await restarted.dispatch(makeAlertEvent({ type: 'needsAttention', instanceIndex: 11, reason: '发失败' }));
    expect(failed.suppressed).toBe(false);
    expect(failed.results[0]?.ok).toBe(false);
    tg.setFallback({ status: 200, json: { ok: true } });
    expect((await restarted.dispatch(makeAlertEvent({ type: 'needsAttention', instanceIndex: 11, reason: '再来一次' }))).results[0]?.ok).toBe(true);

    // Resume clears every channel's cooldown of that instance.
    await restarted.resetThrottleForInstance(7);
    expect((await restarted.dispatch(makeAlertEvent({ type: 'needsAttention', instanceIndex: 7, reason: '恢复后' }))).results[0]?.ok).toBe(true);
  });

  it('keeps the local channel apart: its success does not swallow a Telegram retry', async () => {
    const shown: string[] = [];
    const hub = makeHub({ showLocal: async (title, body) => { shown.push(`${title}|${body}`); } });
    await hub.saveConfig({ telegram: { botToken: FAKE_TOKEN, chatId: FAKE_CHAT_ID, enabled: true, retryCount: 0 }, local: { enabled: true } });
    tg.setFallback({ status: 500, json: { ok: false } });
    const first = await hub.dispatch(makeAlertEvent({ type: 'deviceOffline', instanceIndex: 2, reason: 'x' }));
    expect(first.results.map((result) => [result.channel, result.ok])).toEqual([['telegram', false], ['local', true]]);
    tg.setFallback({ status: 200, json: { ok: true } });
    const second = await hub.dispatch(makeAlertEvent({ type: 'deviceOffline', instanceIndex: 2, reason: 'x' }));
    expect(second.results.map((result) => [result.channel, result.ok ? 'ok' : result.failure])).toEqual([['telegram', 'ok'], ['local', 'throttled']]);
    expect(shown).toHaveLength(1);
  });

  it('validates saves in Chinese: bad patches, bad token shapes, switches without credentials', async () => {
    const hub = makeHub();
    await expect(hub.saveConfig({ detect: { cycleFailThreshold: 0 } })).rejects.toThrow('告警设置无效');
    await expect(hub.saveConfig({ telegram: { botToken: 'HTTP API: 123' } })).rejects.toThrow('格式不对');
    await expect(hub.saveConfig({ telegram: { enabled: true } })).rejects.toThrow('开启 Telegram 推送前请先补齐');
    await hub.saveConfig({ telegram: { botToken: FAKE_TOKEN, chatId: FAKE_CHAT_ID } });
    await expect(hub.saveConfig({ telegram: { remoteReadOnlyEnabled: true } })).rejects.toThrow('授权用户 ID');
    const view = await hub.saveConfig({ telegram: { remoteReadOnlyEnabled: true, authorizedUserId: '987654321' } });
    expect(view.telegram).toMatchObject({ remoteReadOnlyEnabled: true, authorizedUserId: '987654321' });
    expect(await hub.readOnlyBotConfig()).toEqual({ enabled: true, botToken: FAKE_TOKEN, chatId: FAKE_CHAT_ID, userId: '987654321' });
    // ★ Each bot switch means only what it says: remote control alone never starts the read-only /status + /shot bot.
    await hub.saveConfig({ telegram: { remoteReadOnlyEnabled: false, remoteControlEnabled: true } });
    expect(await hub.readOnlyBotConfig()).toMatchObject({ enabled: false, botToken: '' });
    expect(await hub.remoteBotConfig()).toMatchObject({ enabled: false });
    // Buttons follow the handler the bot module registers; the view tells the settings card.
    expect(hub.getConfigView().remoteControlAvailable).toBe(false);
    const pushedViews: boolean[] = [];
    hub.onConfigChanged((changed) => pushedViews.push(changed.remoteControlAvailable === true));
    hub.setRemoteControlHandler(true);
    hub.setRemoteControlHandler(true);
    expect(pushedViews).toEqual([true]);
    expect(hub.getConfigView().remoteControlAvailable).toBe(true);
    hub.setRemoteControlHandler(false);
    // Clearing the token switches every Telegram function off.
    const cleared = await hub.saveConfig({ telegram: { botToken: '' } });
    expect(cleared.telegram).toMatchObject({ botTokenSet: false, enabled: false, remoteReadOnlyEnabled: false, remoteControlEnabled: false });
    expect(await hub.readOnlyBotConfig()).toMatchObject({ enabled: false, botToken: '' });
  });

  it('test push: preflight answers at once without a request', async () => {
    const hub = makeHub();
    const result = await hub.test('telegram');
    expect(result).toMatchObject({ ok: false, failure: 'notConfigured', attempts: 0 });
    expect(tg.calls).toHaveLength(0);
  });

  it('tolerates a corrupt config file (moved aside, defaults, pushes off) and an unreadable saved token', async () => {
    const dir = path.join(home, 'automation', 'alerts');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'config.json'), '{ not json');
    const logs: string[] = [];
    const hub = makeHub({ log: (_level, message) => logs.push(message) });
    await hub.ready;
    expect(hub.getConfigView()).toEqual(expect.objectContaining({ detect: defaultAlertsConfig().detect }));
    expect((await readdir(dir)).some((name) => name.startsWith('config.json.bad-'))).toBe(true);
    expect(logs.join('\n')).toContain('已改名为');

    await hub.saveConfig({ telegram: { botToken: FAKE_TOKEN, chatId: FAKE_CHAT_ID, enabled: true } });
    const broken = makeHub({ codec: { encrypt: codec.encrypt, decrypt: async () => { throw new Error('钥匙串不可用'); } } });
    await broken.ready;
    // Still shown as saved, never sent, and saving other fields keeps the ciphertext.
    expect(broken.getConfigView().telegram.botTokenSet).toBe(true);
    const result = await broken.dispatch(makeAlertEvent({ type: 'deviceOffline', instanceIndex: 1, reason: 'x' }));
    expect(result.results[0]).toMatchObject({ failure: 'notConfigured' });
    expect(result.results[0]?.message).toContain('重新填写');
    await broken.saveConfig({ detect: { cycleFailThreshold: 4 } });
    const stored = JSON.parse(await readFile(path.join(dir, 'config.json'), 'utf8')) as { telegram: { tokenCiphertext: string } };
    expect(stored.telegram.tokenCiphertext).toBe(await codec.encrypt(FAKE_TOKEN));
  });

  it('migrates the earlier per-instance notifications.json once, keeping the ciphertext and the read-only bot settings', async () => {
    const legacyDir = path.join(home, 'automation', 'insights');
    await mkdir(legacyDir, { recursive: true });
    await writeFile(path.join(legacyDir, 'notifications.json'), JSON.stringify({
      version: 1, tokenCiphertext: await codec.encrypt(FAKE_TOKEN), chatId: '-1001234567890', cooldownSeconds: 300,
      retryCount: 1, timeoutMs: 10_000, lastSentAt: {},
      scopes: {
        'wanlong:1': { localEnabled: false, telegramEnabled: true, subscribedKinds: ['consecutiveFailures', 'suspectedFreeze'] },
        'wanlong:2': { localEnabled: true, telegramEnabled: false, subscribedKinds: ['schedulePaused'] },
      },
      remoteReadOnlyEnabled: true, authorizedUserId: '987654321',
    }));
    const logs: string[] = [];
    const hub = makeHub({ log: (_level, message) => logs.push(message) });
    await hub.ready;
    const view = hub.getConfigView();
    expect(view.telegram).toMatchObject({
      enabled: true, chatId: '-1001234567890', cooldownSeconds: 300, retryCount: 1, timeoutMs: 10_000, botTokenSet: true,
      remoteReadOnlyEnabled: true, remoteControlEnabled: false, authorizedUserId: '987654321',
    });
    expect(view.telegram.subscribedTypes).toEqual(expect.arrayContaining(['consecutiveFailures', 'suspectedFreeze', 'emulatorFrozen', 'schedulePaused']));
    expect(view.local.enabled).toBe(true);
    expect(hub.currentTelegramConfig().botToken).toBe(FAKE_TOKEN);
    expect(logs.join('\n')).toContain('迁移');
    const names = await readdir(legacyDir);
    expect(names).toContain('notifications.json.migrated');
    expect(names).not.toContain('notifications.json');
    const stored = JSON.parse(await readFile(path.join(home, 'automation', 'alerts', 'config.json'), 'utf8')) as { telegram: { tokenCiphertext: string } };
    expect(stored.telegram.tokenCiphertext).toBe(await codec.encrypt(FAKE_TOKEN));
    // The legacy IPC adapters keep working on the global settings.
    const legacy = await hub.saveLegacyNotification('wanlong', 3, { localEnabled: false, telegram: { cooldownSeconds: 900 } });
    expect(legacy).toMatchObject({ gameId: 'wanlong', index: 3, localEnabled: false, telegram: { cooldownSeconds: 900, botTokenMasked: '••••••••' } });
    expect((await hub.saveRemoteBotConfig({ enabled: false })).enabled).toBe(false);
  });
});
