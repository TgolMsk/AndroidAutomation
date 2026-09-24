/**
 * The alerts hub and the Telegram bot wired together exactly as `src/main/index.ts` does (`linkBotToAlerts`, the
 * hub's `onConfigChanged` / `onViewChanged`, the bot's `onStatus`). ★ Pins the fix for a restart loop: the bot's
 * start / stop tells the hub whether alert buttons are answered, and that must never count as a settings save that
 * restarts the bot again. A fake Telegram behind an injected fetch: no network request is ever made.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MatchResult } from '@avdm/automation';
import { emptyInstanceState } from '@avdm/automation/wanlong/pure';
import { NotifyHub } from '../src/main/alerts/notifier';
import type { SecretCodec } from '../src/main/alerts/store';
import type { FetchLike } from '../src/main/alerts/telegram';
import { BotService, linkBotToAlerts } from '../src/main/bot';

// ★ Test data, not a credential: shape-valid but never valid at Telegram.
const FAKE_TOKEN = '123456789:AAFakeTokenForWiringCheckOnly_abcdefghij';
const CHAT = '100200300';
const USER = '987654321';
const GAME = 'com.lilithgames.samo.android.cn';

const codec: SecretCodec = {
  encrypt: async (plain) => `enc:${Buffer.from(plain).toString('base64')}`,
  decrypt: async (ciphertext) => Buffer.from(ciphertext.replace(/^enc:/, ''), 'base64').toString(),
};

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Answers every Bot API call; long polls return nothing after a short wait (like an idle chat). */
function fakeTelegram() {
  const calls: Array<{ method: string; body: string }> = [];
  const fetch: FetchLike = async (url, init) => {
    const method = url.slice(url.lastIndexOf('/') + 1);
    const body = typeof init.body === 'string' ? init.body : '[FormData]';
    calls.push({ method, body });
    if (method === 'getUpdates') {
      if ((JSON.parse(body) as { offset: number }).offset !== -1) await pause(5);
      return { status: 200, text: async () => JSON.stringify({ ok: true, result: [] }) };
    }
    return { status: 200, text: async () => JSON.stringify({ ok: true, result: true }) };
  };
  const count = (method: string, predicate: (body: Record<string, unknown>) => boolean = () => true) =>
    calls.filter((call) => call.method === method && (call.body === '[FormData]' || predicate(JSON.parse(call.body) as Record<string, unknown>))).length;
  return { calls, fetch, count };
}

describe('NotifyHub × BotService wired as in main/index.ts', () => {
  let home: string;
  beforeEach(async () => { home = await mkdtemp(path.join(tmpdir(), 'avdm-bot-wiring-')); });
  afterEach(async () => { await rm(home, { recursive: true, force: true }); });

  function wire() {
    const tg = fakeTelegram();
    const logs: string[] = [];
    const pushes: string[] = [];
    // Assigned after the hub, like `remoteBot` in main/index.ts (the link reads it lazily).
    let remoteBot: BotService | null = null;
    const botLink = linkBotToAlerts({ bot: () => remoteBot!, hub: () => hub, log: (message) => logs.push(`[alerts] ${message}`) });
    const hub: NotifyHub = new NotifyHub(home, {
      codec, fetch: tg.fetch, sleep: async () => undefined,
      onConfigChanged: () => { pushes.push('alert-config-changed'); botLink.configSaved(); },
      onViewChanged: () => pushes.push('alert-config-changed'),
    });
    const bot = new BotService({
      home, gamePackage: GAME, referenceSize: { width: 2560, height: 1440 },
      config: async () => { await hub.ready; return hub.currentTelegramConfig(); },
      accounts: async () => [],
      instances: async () => [{ index: 0, name: 'Pixel-0', status: 'running', createdAt: 'avd-0', base: false }],
      schedulerState: (index) => emptyInstanceState(index),
      pauseOf: () => ({ paused: false, reason: null }),
      pauseInstance: async () => undefined,
      resumeInstance: async () => undefined,
      exclusive: (_index, _what, fn) => fn({ signal: new AbortController().signal }),
      manager: async () => { throw new Error('not used'); },
      lane: async (_index, work) => work(),
      matchTemplates: async (): Promise<MatchResult[]> => [],
      shotPolicy: () => 'never',
      log: (_level, message) => logs.push(message),
      onStatus: (status) => { botLink.botStatus(status); pushes.push('bot-status'); },
      fetch: tg.fetch,
      encode: async () => ({ jpeg: new Uint8Array([0xff, 0xd8]) }),
    });
    remoteBot = bot;
    const starts = () => logs.filter((line) => line.includes('Telegram 机器人已启动')).length;
    const stops = () => logs.filter((line) => line.includes('Telegram 机器人已停止')).length;
    return { tg, logs, pushes, hub, bot, starts, stops };
  }

  it('★ a save starts the bot once and it stays running (no restart loop); only its own settings restart it', async () => {
    const { tg, logs, pushes, hub, bot, starts, stops } = wire();
    // Boot (main/index.ts restore step): both switches off → nothing runs.
    expect(await bot.start()).toBe(false);
    await hub.saveConfig({ telegram: { botToken: FAKE_TOKEN, chatId: CHAT, authorizedUserId: USER, remoteReadOnlyEnabled: true } });
    await expect.poll(() => bot.isRunning()).toBe(true);
    await pause(300);
    expect(starts()).toBe(1);
    expect(stops()).toBe(0);
    expect(bot.isRunning()).toBe(true);
    expect(tg.count('getUpdates', (body) => body.offset === -1)).toBe(1);
    expect(tg.count('setMyCommands')).toBe(1);
    expect(pushes.filter((push) => push === 'bot-status')).toHaveLength(1);
    // One push for the save, one for the handler turning on — and nothing more.
    expect(pushes.filter((push) => push === 'alert-config-changed')).toHaveLength(2);
    expect(hub.getConfigView().remoteControlAvailable).toBe(true);

    // An unrelated setting: the bot is left alone.
    await hub.saveConfig({ telegram: { cooldownSeconds: 1200 } });
    await pause(150);
    expect(starts()).toBe(1);
    expect(stops()).toBe(0);

    // A bot switch: exactly one restart, then stable again.
    await hub.saveConfig({ telegram: { remoteControlEnabled: true } });
    await expect.poll(() => starts()).toBe(2);
    await pause(300);
    expect(starts()).toBe(2);
    expect(stops()).toBe(1);
    expect(bot.isRunning()).toBe(true);
    expect(bot.status()).toMatchObject({ running: true, readEnabled: true, controlEnabled: true });
    expect(tg.count('setMyCommands')).toBe(2);
    expect(hub.getConfigView().remoteControlAvailable).toBe(true);

    // Both switches off: stops and stays stopped; alert buttons are no longer attached.
    await hub.saveConfig({ telegram: { remoteReadOnlyEnabled: false, remoteControlEnabled: false } });
    await expect.poll(() => bot.isRunning()).toBe(false);
    const requests = tg.calls.length;
    await pause(300);
    expect(bot.isRunning()).toBe(false);
    expect(starts()).toBe(2);
    expect(stops()).toBe(2);
    expect(tg.calls.length).toBe(requests);
    expect(hub.getConfigView().remoteControlAvailable).toBe(false);
    expect(logs.some((line) => line.includes('重启失败'))).toBe(false);
    expect(logs.find((line) => line.includes(FAKE_TOKEN) || line.includes(FAKE_TOKEN.split(':')[1]!)) ?? '').toBe('');
    await bot.dispose();
  });
});
