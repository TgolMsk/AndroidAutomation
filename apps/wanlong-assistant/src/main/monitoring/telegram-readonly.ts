import sharp from 'sharp';
import type { RawFrame } from '@avdm/automation';

const TOKEN_SHAPE = /^\d{5,}:[A-Za-z0-9_-]{20,}$/;
const NUMERIC_ID = /^\d{1,32}$/;
const CHAT_ID = /^-?\d{1,32}$/;
const MAX_MESSAGE = 3900;
const MAX_PHOTO_BYTES = 9 * 1024 * 1024;

export interface ReadOnlyBotConfig {
  /** Must be explicitly enabled; this module has no setting that defaults to true. */
  enabled: boolean;
  botToken: string;
  chatId: string;
  /** Require sender identity as well as the Chat ID, especially for group chats. */
  userId: string;
}

export interface ReadOnlyInstanceStatus {
  index: number;
  name: string;
  instanceStatus: string;
  automationStatus: string;
}

type FetchPort = (url: string, init: RequestInit) => Promise<Pick<Response, 'status' | 'text'>>;

async function defaultFetch(url: string, init: RequestInit): Promise<Pick<Response, 'status' | 'text'>> {
  try {
    const electron = await import('electron');
    if (electron.net?.fetch) return electron.net.fetch(url, init);
  } catch { /* Node-based tests use global fetch. */ }
  return globalThis.fetch(url, init);
}

export interface ReadOnlyBotPorts {
  config(): Promise<ReadOnlyBotConfig>;
  statuses(): Promise<ReadOnlyInstanceStatus[]>;
  /** The application must use AutomationHost.captureReadOnly and select the bound game. */
  screenshot(index: number): Promise<RawFrame>;
  fetch?: FetchPort;
  log?(message: string): void;
}

interface TelegramUpdate {
  update_id?: unknown;
  message?: { chat?: { id?: unknown }; from?: { id?: unknown }; text?: unknown };
}

interface TelegramResult {
  ok?: unknown;
  result?: unknown;
}

function validate(config: ReadOnlyBotConfig): void {
  if (!config || typeof config !== 'object' || !config.enabled ||
      !TOKEN_SHAPE.test(config.botToken) || !CHAT_ID.test(config.chatId) || !NUMERIC_ID.test(config.userId)) {
    throw new Error('只读机器人配置无效：需显式启用并填写 Bot Token、Chat ID 和授权用户 ID');
  }
}

function numeric(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (typeof value === 'string' && CHAT_ID.test(value)) return value;
  return null;
}

/** No action port exists for taps, scripts, restarts, or login. */
export class ReadOnlyTelegramBot {
  private active = false;
  private offset = 0;
  private abort: AbortController | null = null;
  private loopPromise: Promise<void> | null = null;

  constructor(private readonly ports: ReadOnlyBotPorts) {}

  isRunning(): boolean { return this.active; }

  async start(): Promise<boolean> {
    if (this.active) return true;
    const config = await this.ports.config();
    if (!config.enabled) return false;
    validate(config);
    this.abort = new AbortController();
    try {
      // Discard queued commands from before startup; a reconnect must not replay an old screenshot request.
      const last = await this.updates(config, -1, 0);
      this.offset = Math.max(this.offset, ...last.map((item) => item.update_id).filter((id): id is number =>
        typeof id === 'number' && Number.isSafeInteger(id)).map((id) => id + 1));
    } catch (error) {
      this.abort = null;
      throw error;
    }
    this.active = true;
    this.loopPromise = this.loop(config);
    return true;
  }

  async stop(): Promise<void> {
    this.active = false;
    this.abort?.abort();
    await this.loopPromise?.catch(() => undefined);
    this.loopPromise = null;
    this.abort = null;
  }

  async restart(): Promise<boolean> {
    await this.stop();
    return this.start();
  }

  /** Explicit UI action; verifies Bot API access and delivery to the configured Chat ID. */
  async testConnection(): Promise<{ ok: boolean; message: string }> {
    try {
      const config = await this.ports.config();
      validate(config);
      await this.api(config, 'getMe', {}, 15_000);
      await this.sendText(config, '万龙助手只读查询测试成功。可使用 /status 或 /shot <实例编号>。');
      return { ok: true, message: '机器人与目标会话可用，已发送一条测试消息。' };
    } catch {
      return { ok: false, message: '测试失败：请检查 Bot Token、Chat ID、授权用户 ID、网络和机器人会话权限。' };
    }
  }

  /** Exposed for deterministic tests and manual diagnostics; still requires explicit opt-in. */
  async pollOnce(): Promise<number> {
    const config = await this.ports.config();
    if (!config.enabled) return 0;
    validate(config);
    const updates = await this.updates(config, this.offset, 0);
    for (const update of updates) {
      const id = update.update_id;
      if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < this.offset) continue;
      this.offset = id + 1;
      await this.handle(config, update);
    }
    return updates.length;
  }

  private async loop(config: ReadOnlyBotConfig): Promise<void> {
    let backoff = 1_000;
    while (this.active) {
      try {
        const updates = await this.updates(config, this.offset, 25);
        backoff = 1_000;
        for (const update of updates) {
          const id = update.update_id;
          if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < this.offset) continue;
          this.offset = id + 1;
          try { await this.handle(config, update); }
          catch { this.ports.log?.('只读机器人处理一条消息失败'); }
        }
      } catch (error) {
        if (!this.active || this.abort?.signal.aborted) break;
        const conflict = error instanceof TelegramHttpError && error.status === 409;
        this.ports.log?.(conflict ? '另一个进程正在轮询此 Telegram Bot，稍后重试' : 'Telegram 轮询失败，稍后重试');
        await this.pause(conflict ? 60_000 : backoff);
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  }

  private async pause(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.abort?.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }

  private async updates(config: ReadOnlyBotConfig, offset: number, timeout: number): Promise<TelegramUpdate[]> {
    const result = await this.api(config, 'getUpdates',
      { offset, timeout, allowed_updates: ['message'], limit: 50 }, (timeout + 10) * 1_000);
    return Array.isArray(result) ? result.slice(0, 50) as TelegramUpdate[] : [];
  }

  private async handle(config: ReadOnlyBotConfig, update: TelegramUpdate): Promise<void> {
    const message = update.message;
    if (!message) return;
    const chatId = numeric(message.chat?.id);
    const userId = numeric(message.from?.id);
    if (chatId !== config.chatId || userId !== config.userId) return;
    const text = typeof message.text === 'string' ? message.text.trim().slice(0, 100) : '';
    const [rawCommand, rawIndex] = text.split(/\s+/, 2);
    const command = (rawCommand?.split('@')[0] ?? '').toLowerCase();
    if (command === '/start' || command === '/help') {
      await this.sendText(config, '只读命令：/status 查看实例状态；/shot <编号> 查看当前游戏画面。');
      return;
    }
    if (command === '/status') {
      const list = await this.ports.statuses();
      const lines = list.filter((item) => Number.isSafeInteger(item.index) && item.index >= 0 && item.index <= 63)
        .map((item) => `#${item.index} ${item.name.slice(0, 50)} · ${item.instanceStatus.slice(0, 40)} · ${item.automationStatus.slice(0, 40)}`);
      await this.sendText(config, lines.length ? lines.join('\n') : '暂无实例。');
      return;
    }
    if (command === '/shot') {
      if (!rawIndex || !/^\d{1,2}$/.test(rawIndex) || Number(rawIndex) > 63) {
        await this.sendText(config, '请使用 /shot <0–63 的实例编号>。');
        return;
      }
      const index = Number(rawIndex);
      try {
        const raw = await this.ports.screenshot(index);
        if (raw.data.byteLength !== raw.width * raw.height * 4) throw new Error('截图格式无效');
        const jpeg = await sharp(Buffer.from(raw.data.buffer, raw.data.byteOffset, raw.data.byteLength),
          { raw: { width: raw.width, height: raw.height, channels: 4 }, limitInputPixels: 100_000_000 })
          .resize({ width: 1600, withoutEnlargement: true }).jpeg({ quality: 78 }).toBuffer();
        if (jpeg.byteLength > MAX_PHOTO_BYTES) throw new Error('截图超过发送大小上限');
        const form = new FormData();
        form.append('chat_id', config.chatId);
        form.append('caption', `万龙助手 · 实例 #${index} · ${new Date(raw.capturedAt).toISOString()}`);
        form.append('photo', new Blob([new Uint8Array(jpeg)], { type: 'image/jpeg' }), `instance-${index}.jpg`);
        await this.api(config, 'sendPhoto', form, 30_000);
      } catch {
        await this.sendText(config, `实例 #${index} 暂时无法取得游戏前台截图，请在本机检查实例与游戏状态。`);
      }
    }
  }

  private async sendText(config: ReadOnlyBotConfig, message: string): Promise<void> {
    await this.api(config, 'sendMessage',
      { chat_id: config.chatId, text: message.slice(0, MAX_MESSAGE), disable_web_page_preview: true }, 15_000);
  }

  private async api(config: ReadOnlyBotConfig, method: 'getUpdates' | 'sendMessage' | 'sendPhoto' | 'getMe',
    body: Record<string, unknown> | FormData, timeoutMs: number): Promise<unknown> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = this.abort ? AbortSignal.any([timeout, this.abort.signal]) : timeout;
    const fetcher = this.ports.fetch ?? defaultFetch;
    let response: Pick<Response, 'status' | 'text'>;
    try {
      response = await fetcher(`https://api.telegram.org/bot${config.botToken}/${method}`, {
        method: 'POST',
        ...(body instanceof FormData ? {} : { headers: { 'content-type': 'application/json' } }),
        body: body instanceof FormData ? body : JSON.stringify(body),
        signal,
      });
    } catch {
      // Undici can include the token-bearing URL in its error message. Never return it.
      throw new Error('Telegram 网络请求失败');
    }
    let parsed: TelegramResult;
    try { parsed = JSON.parse((await response.text()).slice(0, 1_000_000)) as TelegramResult; }
    catch { throw new TelegramHttpError(response.status); }
    if (response.status < 200 || response.status >= 300 || parsed.ok !== true) throw new TelegramHttpError(response.status);
    return parsed.result;
  }
}

class TelegramHttpError extends Error {
  constructor(readonly status: number) { super(`Telegram HTTP ${status}`); }
}
