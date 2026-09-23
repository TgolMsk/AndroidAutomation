import { describe, expect, it, vi } from 'vitest';
import type { RawFrame } from '@avdm/automation';
import { ReadOnlyTelegramBot, type ReadOnlyBotConfig, type ReadOnlyBotPorts } from '../src/main/monitoring/telegram-readonly';

const token = '123456789:ABCDEFGHIJKLMNOPQRSTUVWXY1234567890';
const enabled: ReadOnlyBotConfig = { enabled: true, botToken: token, chatId: '-1001234567890', userId: '987654321' };

function frame(): RawFrame {
  const width = 32;
  const height = 20;
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 40; data[i + 1] = 120; data[i + 2] = 180; data[i + 3] = 255;
  }
  return { width, height, data, capturedAt: Date.parse('2026-09-23T10:00:00Z') };
}

function response(result: unknown): Pick<Response, 'status' | 'text'> {
  return { status: 200, text: async () => JSON.stringify({ ok: true, result }) };
}

function message(id: number, chat: number, sender: number, text: string): unknown {
  return { update_id: id, message: { chat: { id: chat }, from: { id: sender }, text } };
}

describe('read-only Telegram bot', () => {
  it('does nothing by default when remote access is disabled', async () => {
    const fetch = vi.fn(async () => response([]));
    const statuses = vi.fn(async () => []);
    const screenshot = vi.fn(async () => frame());
    const bot = new ReadOnlyTelegramBot({
      config: async () => ({ ...enabled, enabled: false }), statuses, screenshot, fetch,
    });
    expect(await bot.start()).toBe(false);
    expect(await bot.pollOnce()).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(statuses).not.toHaveBeenCalled();
    expect(screenshot).not.toHaveBeenCalled();
  });

  it('requires both the configured chat and sender before reading status or screenshots', async () => {
    const statuses = vi.fn(async () => [{ index: 1, name: '测试', instanceStatus: 'running', automationStatus: 'idle' }]);
    const screenshot = vi.fn(async () => frame());
    const calls: Array<{ method: string; body: RequestInit['body'] }> = [];
    const fetch: ReadOnlyBotPorts['fetch'] = async (url, init) => {
      const method = url.split('/').at(-1)!;
      calls.push({ method, body: init.body });
      if (method === 'getUpdates') return response([
        message(1, -1001234567891, 987654321, '/shot 1'),
        message(2, -1001234567890, 987654322, '/shot 1'),
        message(3, -1001234567890, 987654321, '/status'),
        message(4, -1001234567890, 987654321, '/shot 1'),
        message(5, -1001234567890, 987654321, '/restart 1'),
      ]);
      return response({ message_id: 99 });
    };
    const bot = new ReadOnlyTelegramBot({ config: async () => enabled, statuses, screenshot, fetch });
    expect(await bot.pollOnce()).toBe(5);
    expect(statuses).toHaveBeenCalledTimes(1);
    expect(screenshot).toHaveBeenCalledTimes(1);
    expect(calls.map((item) => item.method)).toEqual(['getUpdates', 'sendMessage', 'sendPhoto']);
    const statusBody = JSON.parse(calls[1]!.body as string) as { text: string };
    expect(statusBody.text).toContain('#1 测试');
    expect(calls[2]!.body).toBeInstanceOf(FormData);
  });

  it('validates credentials and never leaks a token-bearing URL through an error', async () => {
    const bot = new ReadOnlyTelegramBot({
      config: async () => ({ ...enabled, userId: '' }),
      statuses: async () => [], screenshot: async () => frame(),
    });
    await expect(bot.pollOnce()).rejects.toThrow('授权用户 ID');

    const fail = new ReadOnlyTelegramBot({
      config: async () => enabled,
      statuses: async () => [], screenshot: async () => frame(),
      fetch: async () => { throw new Error(`request failed: https://api.telegram.org/bot${token}/getUpdates`); },
    });
    let exposed = '';
    try { await fail.pollOnce(); } catch (error) { exposed = String(error); }
    expect(exposed).toContain('Telegram 网络请求失败');
    expect(exposed).not.toContain(token);
  });

  it('tests Bot API and Chat delivery only after an explicit request', async () => {
    const methods: string[] = [];
    const bot = new ReadOnlyTelegramBot({
      config: async () => enabled,
      statuses: async () => [], screenshot: async () => frame(),
      fetch: async (url) => {
        methods.push(url.split('/').at(-1)!);
        return response({ id: 1 });
      },
    });
    expect(methods).toEqual([]);
    expect(await bot.testConnection()).toMatchObject({ ok: true });
    expect(methods).toEqual(['getMe', 'sendMessage']);
    expect(bot.isRunning()).toBe(false);
  });
});
