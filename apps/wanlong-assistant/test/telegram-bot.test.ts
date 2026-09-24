/**
 * The Telegram bot channel: port of wanlong-panel scripts/alerts-offline-check.ts section 七 (checkBotChannel) plus
 * the earlier read-only bot's cases (default off, Chat ID + user authorization, token never leaks, test on request)
 * and this app's additions (permission switches, backlog drop, answer-before-work, status).
 * A fake Telegram behind an injected fetch: no network request is ever made.
 */
import { describe, expect, it } from 'vitest';
import { defaultAlertsConfig, type TelegramConfig } from '../src/shared/alerts';
import {
  BOT_MENU_BUTTON, type BotAction, type BotActionPort, type BotActionResult, type BotInstanceRef, type BotStatusView,
} from '../src/shared/bot';
import type { FetchLike } from '../src/main/alerts/telegram';
import { TelegramBot } from '../src/main/bot';

const FAKE_TOKEN = '123456789:AAFakeTokenForOfflineCheck_abcdefghij';
const CHAT = '100200300';
const USER = '987654321';

function config(patch: Partial<TelegramConfig> = {}): TelegramConfig {
  return {
    ...defaultAlertsConfig().telegram, botToken: FAKE_TOKEN, chatId: CHAT, authorizedUserId: USER,
    remoteReadOnlyEnabled: true, remoteControlEnabled: true, ...patch,
  };
}

const leaks = (text: string): boolean => text.includes(FAKE_TOKEN) || text.includes(FAKE_TOKEN.split(':')[1]!);

interface Call {
  method: string;
  url: string;
  body: string;
  headers: Record<string, string>;
  form?: Record<string, string>;
}

type Update = Record<string, unknown>;

class FakeTelegram {
  calls: Call[] = [];
  updates: Update[] = [];
  private nextId = 100;
  /** Per-method canned failures. */
  failures = new Map<string, { status: number; description: string } | Error>();

  push(update: Update): void {
    this.nextId += 1;
    this.updates.push({ update_id: this.nextId, ...update });
  }

  message(text: string, chat = CHAT, user = USER): void {
    this.push({ message: { chat: { id: Number(chat) }, from: { id: Number(user) }, text } });
  }

  callback(data: string, id = 'cbq-1', chat = CHAT, user = USER): void {
    this.push({ callback_query: { id, data, from: { id: Number(user) }, message: { chat: { id: Number(chat) } } } });
  }

  sent(method: string): Call[] {
    return this.calls.filter((call) => call.method === method);
  }

  texts(): string[] {
    return this.sent('sendMessage').map((call) => String((JSON.parse(call.body) as { text: string }).text));
  }

  readonly fetch: FetchLike = async (url, init) => {
    const method = url.slice(url.lastIndexOf('/') + 1);
    const call: Call = { method, url, body: typeof init.body === 'string' ? init.body : '[FormData]', headers: { ...(init.headers ?? {}) } };
    if (typeof init.body !== 'string') {
      call.form = {};
      for (const [key, value] of init.body.entries()) call.form[key] = typeof value === 'string' ? value : `[blob ${value.size}B ${value.type}]`;
    }
    this.calls.push(call);
    const failure = this.failures.get(method);
    if (failure instanceof Error) throw failure;
    if (failure) return { status: failure.status, text: async () => JSON.stringify({ ok: false, description: failure.description }) };
    if (method === 'getUpdates') {
      const body = JSON.parse(call.body) as { offset: number; limit: number };
      let result: Update[];
      if (body.offset === -1) {
        // Telegram forgets everything before the newest update and returns only that one.
        result = this.updates.slice(-1);
        this.updates = [];
      } else {
        result = this.updates.splice(0, body.limit);
      }
      if (result.length === 0) await new Promise((resolve) => setTimeout(resolve, 2));
      return { status: 200, text: async () => JSON.stringify({ ok: true, result }) };
    }
    return { status: 200, text: async () => JSON.stringify({ ok: true, result: method === 'getMe' ? { id: 1 } : { message_id: 1 } }) };
  };
}

function fakePort(performed: Array<[BotAction, number | null]>, instances: () => BotInstanceRef[]): BotActionPort {
  return {
    async perform(action, index): Promise<BotActionResult> {
      performed.push([action, index]);
      if (action === 'shot') {
        return { text: '', photo: { jpeg: new Uint8Array(1024).fill(0xd8), caption: `实例 ${index}「小号」截图`, filename: `inst${index}-20260909-212233.jpg` } };
      }
      if (action === 'resources') return { text: `【资源统计】实例 ${index}` };
      if (action === 'menu') return { text: '菜单已刷新。', showMenu: true };
      if (action === 'status') return { text: `状态 ${index ?? '全部'}` };
      return { text: `${action} 已执行` };
    },
    async listInstances() { return instances(); },
  };
}

function setup(patch: Partial<TelegramConfig> = {}, port?: BotActionPort) {
  const tg = new FakeTelegram();
  const logs: string[] = [];
  const performed: Array<[BotAction, number | null]> = [];
  let instances: BotInstanceRef[] = [{ index: 0, name: '主号' }, { index: 1, name: '小号' }];
  const statuses: BotStatusView[] = [];
  let cfg = config(patch);
  const waits: number[] = [];
  const bot = new TelegramBot({
    config: async () => cfg,
    actions: port ?? fakePort(performed, () => instances),
    fetch: tg.fetch,
    log: (level, message) => logs.push(`[${level}] ${message}`),
    onStatus: (status) => statuses.push(status),
    sleep: async (ms) => { waits.push(ms); await new Promise((resolve) => setTimeout(resolve, 1)); },
  });
  return {
    tg, bot, logs, performed, statuses, waits,
    setInstances: (list: BotInstanceRef[]) => { instances = list; },
    setConfig: (next: Partial<TelegramConfig>) => { cfg = config(next); },
    /** One poll plus the queued work. */
    poll: async () => { await bot.pollOnce(); await bot.idle(); },
  };
}

function bodyOf(call: Call): Record<string, unknown> {
  return JSON.parse(call.body) as Record<string, unknown>;
}

describe('七、机器人通道：菜单键盘 / 账号选择 / sendPhoto 走 FormData / 未授权忽略', () => {
  it('/start answers the help text with the six menu literals, a persistent keyboard and no parse_mode', async () => {
    const { tg, poll } = setup();
    tg.message('/start');
    await poll();
    const start = tg.sent('sendMessage')[0]!;
    const body = bodyOf(start);
    expect(String(body.text)).toContain('/accounts');
    const markup = body.reply_markup as { keyboard: Array<Array<{ text: string }>>; resize_keyboard: boolean; is_persistent: boolean };
    const flat = markup.keyboard.flat().map((key) => key.text);
    expect(flat).toHaveLength(6);
    for (const literal of Object.values(BOT_MENU_BUTTON)) expect(flat).toContain(literal);
    expect(markup.resize_keyboard).toBe(true);
    expect(markup.is_persistent).toBe(true);
    expect('parse_mode' in body).toBe(false);
    expect(body.disable_web_page_preview).toBe(true);
  });

  it('a menu button with two instances sends the account picker instead of running', async () => {
    const { tg, poll, performed } = setup();
    tg.message(BOT_MENU_BUTTON.shot);
    await poll();
    const pick = bodyOf(tg.sent('sendMessage')[0]!);
    const keyboard = (pick.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }).inline_keyboard;
    expect(performed.some(([action]) => action === 'shot')).toBe(false);
    expect(String(pick.text)).toContain('请选择账号');
    expect(keyboard.flat().map((button) => button.callback_data)).toEqual(['shot:0', 'shot:1']);
    expect(keyboard.flat().some((button) => button.text.includes('小号'))).toBe(true);
  });

  it('callback shot:1 is answered first (same id), then the photo goes as FormData without a content-type', async () => {
    const { tg, poll, performed } = setup();
    tg.callback('shot:1', 'cbq-shot');
    await poll();
    const order = tg.calls.map((call) => call.method).filter((method) => method !== 'getUpdates');
    expect(order[0]).toBe('answerCallbackQuery');
    expect(order).toContain('sendPhoto');
    expect(bodyOf(tg.sent('answerCallbackQuery')[0]!).callback_query_id).toBe('cbq-shot');
    expect(String(bodyOf(tg.sent('answerCallbackQuery')[0]!).text)).toContain('正在操作模拟器');
    expect(performed).toContainEqual(['shot', 1]);
    const photo = tg.sent('sendPhoto')[0]!;
    expect(photo.body).toBe('[FormData]');
    expect('content-type' in photo.headers).toBe(false);
    expect(Object.keys(photo.form!).sort()).toEqual(['caption', 'chat_id', 'photo']);
    expect(photo.form!.photo).toBe('[blob 1024B image/jpeg]');
    expect(photo.form!.chat_id).toBe(CHAT);
    expect(photo.form!.caption).toContain('实例 1「小号」');
    // A photo-only result sends no empty text.
    expect(tg.sent('sendMessage')).toHaveLength(0);
  });

  it('answers a button before the slow work finishes', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const port: BotActionPort = {
      async perform() { await gate; return { text: '好了' }; },
      async listInstances() { return [{ index: 0, name: null }]; },
    };
    const { tg, bot } = setup({}, port);
    tg.callback('relaunch:0', 'cbq-slow');
    await bot.pollOnce();
    expect(tg.sent('answerCallbackQuery')).toHaveLength(1);
    expect(tg.sent('sendMessage')).toHaveLength(0);
    release();
    await bot.idle();
    expect(tg.texts()).toEqual(['好了']);
  });

  it('★ an unauthorized chat or user gets nothing and runs nothing (one log per chat/user); a callback only gets 「未授权的会话。」', async () => {
    const { tg, poll, performed, logs } = setup();
    tg.message('/status', '42');
    tg.message('/status', '42');
    tg.message('/status', CHAT, '111');
    await poll();
    expect(tg.sent('sendMessage')).toHaveLength(0);
    expect(performed).toHaveLength(0);
    expect(logs.filter((line) => line.includes('未授权'))).toHaveLength(2);
    tg.callback('shot:0', 'cbq-bad', '42');
    await poll();
    expect(performed).toHaveLength(0);
    const answer = tg.sent('answerCallbackQuery')[0]!;
    expect(bodyOf(answer)).toMatchObject({ callback_query_id: 'cbq-bad', text: '未授权的会话。' });
    expect(tg.sent('sendMessage')).toHaveLength(0);
  });

  it('res:<idx> routes to resources; one instance runs a required action directly', async () => {
    const { tg, poll, performed, setInstances } = setup();
    tg.callback('res:0', 'cbq-res');
    await poll();
    expect(performed).toContainEqual(['resources', 0]);
    expect(tg.texts().some((text) => text.includes('【资源统计】实例 0'))).toBe(true);
    setInstances([{ index: 3, name: null }]);
    tg.message('/resources');
    await poll();
    expect(performed).toContainEqual(['resources', 3]);
  });

  it('/shot 2 runs directly, /shot@bot 1 drops the suffix, /menu carries the keyboard, unknown commands get help', async () => {
    const { tg, poll, performed } = setup();
    tg.message('/shot 2');
    tg.message('/shot@wanlong_bot 1');
    tg.message('/menu');
    tg.message('/reboot');
    tg.message('随便说一句');
    await poll();
    expect(performed).toContainEqual(['shot', 2]);
    expect(performed).toContainEqual(['shot', 1]);
    const menu = tg.sent('sendMessage').find((call) => String(bodyOf(call).text).includes('菜单已刷新'))!;
    expect(Array.isArray((bodyOf(menu).reply_markup as { keyboard?: unknown }).keyboard)).toBe(true);
    const unknown = tg.texts().find((text) => text.startsWith('不认识的命令「/reboot」'));
    expect(unknown).toContain('/help');
    expect(tg.texts()).toHaveLength(2);
  });

  it('a thrown action answers 「操作失败：<reason>」 with the token scrubbed', async () => {
    const port: BotActionPort = {
      async perform() { throw new Error(`实例 #0 正在运行脚本，截图稍后再试。 https://api.telegram.org/bot${FAKE_TOKEN}/x`); },
      async listInstances() { return [{ index: 0, name: null }]; },
    };
    const { tg, poll } = setup({}, port);
    tg.callback('shot:0', 'cbq-fail');
    await poll();
    const fail = tg.texts().find((text) => text.startsWith('操作失败：'))!;
    expect(fail).toContain('稍后再试');
    expect(leaks(fail)).toBe(false);
  });

  it('a failed upload falls back to a text with the caption; over 10 MB sends no photo at all', async () => {
    const { tg, poll } = setup();
    tg.failures.set('sendPhoto', { status: 400, description: `Bad Request: photo https://api.telegram.org/bot${FAKE_TOKEN}/sendPhoto` });
    tg.callback('shot:1', 'cbq-photo-fail');
    await poll();
    const fallback = tg.texts().find((text) => text.includes('截图发送失败'))!;
    expect(fallback).toContain('小号');
    expect(leaks(fallback)).toBe(false);

    const huge: BotActionPort = {
      async perform() { return { text: '', photo: { jpeg: new Uint8Array(11 * 1024 * 1024), caption: '巨图', filename: 'huge.jpg' } }; },
      async listInstances() { return [{ index: 0, name: null }]; },
    };
    const second = setup({}, huge);
    second.tg.callback('shot:0', 'cbq-huge');
    await second.poll();
    expect(second.tg.sent('sendPhoto')).toHaveLength(0);
    expect(second.tg.texts().some((text) => text.includes('10MB') && text.includes('巨图'))).toBe(true);
  });

  it('★ leak scan: request bodies, form fields and logs never contain the token', async () => {
    const { tg, poll, logs } = setup();
    tg.failures.set('sendPhoto', new Error(`fetch failed: https://api.telegram.org/bot${FAKE_TOKEN}/sendPhoto`));
    tg.message('/start');
    tg.callback('shot:1', 'cbq-leak');
    tg.message('/status', '42');
    await poll();
    expect(tg.calls.length).toBeGreaterThan(2);
    for (const call of tg.calls) {
      expect(leaks(call.body)).toBe(false);
      expect(leaks(JSON.stringify(call.form ?? {}))).toBe(false);
    }
    expect(logs.length).toBeGreaterThanOrEqual(2);
    expect(logs.find((line) => leaks(line)) ?? '').toBe('');
  });
});

describe('permission switches (DECISIONS A.3)', () => {
  it('control actions are refused while 「允许手机远程操作」 is off; read actions still work', async () => {
    const { tg, poll, performed } = setup({ remoteControlEnabled: false });
    tg.message('/pause 0');
    tg.message('/relaunch 0');
    tg.message(BOT_MENU_BUTTON.resources);
    tg.callback('resume:0', 'cbq-resume');
    tg.message('/status');
    await poll();
    expect(performed).toEqual([['status', null]]);
    const refusals = tg.texts().filter((text) => text.includes('在手机上还没有开放') && text.includes('允许手机远程操作'));
    expect(refusals).toHaveLength(4);
    expect(bodyOf(tg.sent('answerCallbackQuery')[0]!).text).toBe('这个操作在手机上还没有开放。');
  });

  it('read actions are refused while 「允许手机查看状态与截图」 is off; control and the menu still work', async () => {
    const { tg, poll, performed } = setup({ remoteReadOnlyEnabled: false });
    tg.message('/shot 0');
    tg.message('/accounts');
    tg.callback('status:0', 'cbq-status');
    tg.message('/resume 0');
    tg.message('/menu');
    tg.message('/help');
    await poll();
    expect(performed).toEqual([['resume', 0], ['menu', null]]);
    expect(tg.texts().filter((text) => text.includes('在手机上还没有开放') && text.includes('允许手机查看状态与截图'))).toHaveLength(3);
  });
});

describe('lifecycle (the earlier read-only bot’s cases and this app’s additions)', () => {
  it('does nothing while both switches are off', async () => {
    const { tg, bot, performed, statuses } = setup({ remoteReadOnlyEnabled: false, remoteControlEnabled: false });
    expect(await bot.start()).toBe(false);
    expect(await bot.pollOnce()).toBe(0);
    expect(tg.calls).toHaveLength(0);
    expect(performed).toHaveLength(0);
    expect(bot.isRunning()).toBe(false);
    expect(statuses).toEqual([]);
  });

  it('refuses to start with incomplete credentials and says why (never the token)', async () => {
    const { bot, statuses } = setup({ authorizedUserId: '' });
    await expect(bot.start()).rejects.toThrow('授权用户 ID');
    expect(statuses.at(-1)).toMatchObject({ running: false, controlEnabled: true });
    expect(leaks(JSON.stringify(statuses))).toBe(false);
  });

  it('drops the backlog at start (a stale /relaunch never replays), registers the command menu, polls, and stops', async () => {
    const { tg, bot, performed, statuses } = setup();
    tg.message('/relaunch 0');
    tg.message('/pause 0');
    await bot.start();
    await expect.poll(() => tg.sent('setMyCommands').length).toBe(1);
    const first = bodyOf(tg.sent('getUpdates')[0]!);
    expect(first).toMatchObject({ offset: -1, allowed_updates: ['message', 'callback_query'] });
    const commands = (bodyOf(tg.sent('setMyCommands')[0]!).commands as Array<{ command: string }>).map((item) => item.command);
    for (const name of ['accounts', 'shot', 'resources', 'stats', 'menu', 'help']) expect(commands).toContain(name);
    tg.message('/status 0');
    await expect.poll(() => performed.length).toBe(1);
    expect(performed).toEqual([['status', 0]]);
    await bot.stop();
    expect(bot.isRunning()).toBe(false);
    expect(statuses.map((status) => status.running)).toEqual([true, false]);
  });

  it('backs off on failures (409 waits 60 s and explains) and reports the problem', async () => {
    const { tg, bot, waits, logs, statuses } = setup();
    tg.failures.set('getUpdates', { status: 409, description: 'Conflict: terminated by other getUpdates request' });
    await bot.start();
    await expect.poll(() => waits.length).toBeGreaterThanOrEqual(2);
    expect(waits[0]).toBe(60_000);
    expect(logs.some((line) => line.includes('另有一个进程在用同一个 Bot Token 轮询'))).toBe(true);
    expect(statuses.some((status) => status.running && status.problem?.includes('另有一个进程'))).toBe(true);
    tg.failures.set('getUpdates', new Error(`connect ECONNREFUSED https://api.telegram.org/bot${FAKE_TOKEN}/getUpdates`));
    await expect.poll(() => logs.some((line) => line.includes('Telegram 轮询失败'))).toBe(true);
    await bot.stop();
    expect(logs.find((line) => leaks(line)) ?? '').toBe('');
    expect(leaks(JSON.stringify(statuses))).toBe(false);
  });

  it('never leaks a token-bearing URL through a thrown error', async () => {
    const { tg, bot } = setup();
    tg.failures.set('getUpdates', new Error(`request failed: https://api.telegram.org/bot${FAKE_TOKEN}/getUpdates`));
    let exposed = '';
    try { await bot.pollOnce(); } catch (error) { exposed = String(error); }
    expect(exposed).toContain('getUpdates 请求失败');
    expect(leaks(exposed)).toBe(false);
  });

  it('tests the connection only when asked: getMe, then one message to the chat; failures stay token-free', async () => {
    const { tg, bot } = setup({ remoteReadOnlyEnabled: false, remoteControlEnabled: false });
    expect(tg.calls).toHaveLength(0);
    const ok = await bot.testConnection();
    expect(ok.ok).toBe(true);
    expect(tg.calls.map((call) => call.method)).toEqual(['getMe', 'sendMessage']);
    expect(bodyOf(tg.calls[1]!).chat_id).toBe(CHAT);
    tg.failures.set('getMe', new Error(`fetch failed ${FAKE_TOKEN}`));
    const failed = await bot.testConnection();
    expect(failed.ok).toBe(false);
    expect(leaks(failed.message)).toBe(false);
  });
});
