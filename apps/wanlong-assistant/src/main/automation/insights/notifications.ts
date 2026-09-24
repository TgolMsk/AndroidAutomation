import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { withFileLock } from '@avdm/core';
import type { ReadOnlyBotConfig } from '../../monitoring/telegram-readonly';
import type { InsightAlert, InsightAlertKind, NotificationConfigPatch, NotificationConfigView, NotificationTestResult, RemoteBotConfigPatch, RemoteBotConfigView } from './contracts';

const VERSION = 1;
const MAX_CONFIG_BYTES = 128 * 1024;
const ALERT_KINDS: readonly InsightAlertKind[] = [
  'runFailed', 'circuitBroken', 'schedulePaused', 'consecutiveFailures',
  'recoveryExhausted', 'dispatchStalled', 'suspectedKicked',
  'maintenanceRequired', 'updateRequired', 'suspectedFreeze',
];
const TOKEN_SHAPE = /^\d{5,}:[A-Za-z0-9_-]{20,}$/;
const CHAT_SHAPE = /^-?\d{1,32}$/;
const USER_SHAPE = /^\d{1,32}$/;

interface ScopeConfig {
  localEnabled: boolean;
  telegramEnabled: boolean;
  subscribedKinds: InsightAlertKind[];
}

interface StoredConfig {
  version: 1;
  /** Electron safeStorage ciphertext, encoded as base64. No plaintext token is written to disk. */
  tokenCiphertext: string;
  chatId: string;
  cooldownSeconds: number;
  retryCount: number;
  timeoutMs: number;
  scopes: Record<string, ScopeConfig>;
  lastSentAt: Record<string, number>;
  /** Optional in v1 for backward compatibility. The inbox is disabled unless explicitly set. */
  remoteReadOnlyEnabled?: boolean;
  authorizedUserId?: string;
}

export interface SecretCodec {
  encrypt(plain: string): Promise<string>;
  decrypt(ciphertext: string): Promise<string>;
}

interface FetchResponse { status: number; }
type FetchPort = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<FetchResponse>;

export interface NotificationPorts {
  codec?: SecretCodec;
  fetch?: FetchPort;
  showLocal?: (title: string, body: string) => Promise<void>;
  now?: () => number;
  /** Redacted delivery status only; never receives the credential or URL. */
  onDelivery?: (alert: InsightAlert, result: NotificationTestResult) => void;
}

function assertScope(gameId: string, index: number): string {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(gameId) || !Number.isInteger(index) || index < 0 || index > 63) {
    throw new Error('通知实例范围无效');
  }
  return `${gameId}:${index}`;
}

function defaultScope(): ScopeConfig {
  return { localEnabled: false, telegramEnabled: false, subscribedKinds: [...ALERT_KINDS] };
}

function defaultConfig(): StoredConfig {
  return {
    version: VERSION, tokenCiphertext: '', chatId: '', cooldownSeconds: 600,
    retryCount: 2, timeoutMs: 15_000, scopes: {}, lastSentAt: {},
    remoteReadOnlyEnabled: false, authorizedUserId: '',
  };
}

function validConfig(raw: unknown): raw is StoredConfig {
  if (!raw || typeof raw !== 'object') return false;
  const value = raw as Partial<StoredConfig>;
  return value.version === VERSION && typeof value.tokenCiphertext === 'string' &&
    typeof value.chatId === 'string' && typeof value.cooldownSeconds === 'number' &&
    Number.isInteger(value.cooldownSeconds) && value.cooldownSeconds >= 0 && value.cooldownSeconds <= 86_400 &&
    typeof value.retryCount === 'number' && Number.isInteger(value.retryCount) && value.retryCount >= 0 && value.retryCount <= 5 &&
    typeof value.timeoutMs === 'number' && Number.isInteger(value.timeoutMs) && value.timeoutMs >= 2_000 && value.timeoutMs <= 120_000 &&
    !!value.scopes && typeof value.scopes === 'object' && !Array.isArray(value.scopes) &&
    Object.values(value.scopes).every((scope) => scope && typeof scope.localEnabled === 'boolean' &&
      typeof scope.telegramEnabled === 'boolean' && Array.isArray(scope.subscribedKinds) &&
      scope.subscribedKinds.every((kind) => ALERT_KINDS.includes(kind))) &&
    !!value.lastSentAt && typeof value.lastSentAt === 'object' && !Array.isArray(value.lastSentAt) &&
    Object.values(value.lastSentAt).every((at) => typeof at === 'number' && Number.isFinite(at)) &&
    (value.remoteReadOnlyEnabled === undefined || typeof value.remoteReadOnlyEnabled === 'boolean') &&
    (value.authorizedUserId === undefined || typeof value.authorizedUserId === 'string' && value.authorizedUserId.length <= 32);
}

/** The Keychain-backed codec (resolved per call). Exported so the composition root can wrap it. */
export async function safeStorageCodec(): Promise<SecretCodec> {
  const electron = await import('electron');
  if (!electron.safeStorage?.isEncryptionAvailable()) throw new Error('系统钥匙串不可用，暂时无法保存或读取 Bot Token');
  return {
    encrypt: async (plain) => electron.safeStorage.encryptString(plain).toString('base64'),
    decrypt: async (ciphertext) => electron.safeStorage.decryptString(Buffer.from(ciphertext, 'base64')),
  };
}

async function defaultFetch(url: string, init: Parameters<FetchPort>[1]): Promise<FetchResponse> {
  try {
    const electron = await import('electron');
    if (electron.net?.fetch) return electron.net.fetch(url, init);
  } catch { /* Node-based tests and CLI use global fetch. */ }
  return globalThis.fetch(url, init);
}

async function defaultShowLocal(title: string, body: string): Promise<void> {
  const electron = await import('electron');
  if (!electron.Notification?.isSupported()) throw new Error('当前系统不支持桌面通知');
  new electron.Notification({ title, body, silent: false }).show();
}

function safeError(error: unknown, token: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  return token ? raw.split(token).join('[已隐藏]') : raw;
}

function telegramProblem(status: number): string {
  if (status === 400) return 'Telegram 拒绝此 Chat ID，请检查数字会话 ID 与机器人权限。';
  if (status === 401 || status === 404) return 'Bot Token 无效，请重新从 BotFather 复制。';
  if (status === 403) return '机器人无权发送到该会话；请先向机器人发送一条消息或检查群权限。';
  if (status === 429) return 'Telegram 限流，请稍后重试。';
  return `Telegram 请求失败（HTTP ${status}）。`;
}

async function writePrivate(file: string, value: StoredConfig): Promise<void> {
  const data = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(data) > MAX_CONFIG_BYTES) throw new Error('通知配置超过大小上限');
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(data); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temp, file);
    await chmod(file, 0o600);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Transport credentials live once on this Mac; each game/instance opts in independently. */
export class NotificationHub {
  private readonly file: string;
  private queue: Promise<void> = Promise.resolve();
  private readonly now: () => number;

  constructor(home: string, private readonly ports: NotificationPorts = {}) {
    if (!path.isAbsolute(home)) throw new Error('通知数据目录必须是绝对路径');
    this.file = path.join(home, 'automation', 'insights', 'notifications.json');
    this.now = ports.now ?? Date.now;
  }

  private async read(): Promise<StoredConfig> {
    let value: unknown;
    try {
      if ((await stat(this.file)).size > MAX_CONFIG_BYTES) throw new Error('文件超过大小上限');
      value = JSON.parse(await readFile(this.file, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaultConfig();
      throw new Error('通知配置无法读取', { cause: error });
    }
    if (!validConfig(value)) throw new Error('通知配置格式不兼容');
    return value;
  }

  private view(gameId: string, index: number, config: StoredConfig): NotificationConfigView {
    const scope = config.scopes[assertScope(gameId, index)] ?? defaultScope();
    return {
      gameId, index, localEnabled: scope.localEnabled,
      telegram: {
        enabled: scope.telegramEnabled, botTokenSet: Boolean(config.tokenCiphertext),
        botTokenMasked: config.tokenCiphertext ? '••••••••' : '', chatId: config.chatId,
        cooldownSeconds: config.cooldownSeconds, retryCount: config.retryCount,
        timeoutMs: config.timeoutMs, subscribedKinds: [...scope.subscribedKinds],
      },
    };
  }

  async config(gameId: string, index: number): Promise<NotificationConfigView> {
    assertScope(gameId, index);
    return this.view(gameId, index, await this.read());
  }

  async remoteConfig(running = false): Promise<RemoteBotConfigView> {
    const config = await this.read();
    return {
      enabled: config.remoteReadOnlyEnabled === true,
      running,
      botTokenSet: Boolean(config.tokenCiphertext),
      chatId: config.chatId,
      authorizedUserId: config.authorizedUserId ?? '',
    };
  }

  async saveRemoteConfig(patch: RemoteBotConfigPatch, running = false): Promise<RemoteBotConfigView> {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('只读机器人配置补丁无效');
    if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') throw new Error('只读机器人开关无效');
    if (patch.authorizedUserId !== undefined &&
        (typeof patch.authorizedUserId !== 'string' || patch.authorizedUserId.length > 32)) {
      throw new Error('授权用户 ID 无效');
    }
    return withFileLock(`${this.file}.lock`, async () => {
      const current = await this.read();
      const authorizedUserId = patch.authorizedUserId === undefined
        ? current.authorizedUserId ?? '' : patch.authorizedUserId.trim();
      const enabled = patch.enabled ?? current.remoteReadOnlyEnabled === true;
      if (enabled && (!current.tokenCiphertext || !CHAT_SHAPE.test(current.chatId) || !USER_SHAPE.test(authorizedUserId))) {
        throw new Error('启用只读机器人前，请保存 Bot Token、数字 Chat ID 和授权用户 ID');
      }
      if (enabled) {
        const token = await (this.ports.codec ?? await safeStorageCodec()).decrypt(current.tokenCiphertext);
        if (!TOKEN_SHAPE.test(token)) throw new Error('已保存的 Bot Token 无效，请重新保存');
      }
      const next: StoredConfig = { ...current, remoteReadOnlyEnabled: enabled, authorizedUserId };
      await writePrivate(this.file, next);
      return { enabled, running, botTokenSet: Boolean(next.tokenCiphertext),
        chatId: next.chatId, authorizedUserId };
    });
  }

  /** Main process only. Never send this object across IPC or include it in logs. */
  async readOnlyBotConfig(): Promise<ReadOnlyBotConfig> {
    const config = await this.read();
    const enabled = config.remoteReadOnlyEnabled === true;
    if (!enabled) return { enabled: false, botToken: '', chatId: config.chatId, userId: config.authorizedUserId ?? '' };
    if (!config.tokenCiphertext || !CHAT_SHAPE.test(config.chatId) || !USER_SHAPE.test(config.authorizedUserId ?? '')) {
      throw new Error('只读机器人配置不完整');
    }
    const botToken = config.tokenCiphertext
      ? await (this.ports.codec ?? await safeStorageCodec()).decrypt(config.tokenCiphertext)
      : '';
    if (botToken && !TOKEN_SHAPE.test(botToken)) throw new Error('已保存的 Bot Token 无效');
    return { enabled, botToken, chatId: config.chatId, userId: config.authorizedUserId ?? '' };
  }

  async saveConfig(gameId: string, index: number, patch: NotificationConfigPatch): Promise<NotificationConfigView> {
    const key = assertScope(gameId, index);
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('通知配置补丁无效');
    if (patch.localEnabled !== undefined && typeof patch.localEnabled !== 'boolean') throw new Error('本地通知开关无效');
    const t = patch.telegram;
    if (t !== undefined && (!t || typeof t !== 'object' || Array.isArray(t))) throw new Error('Telegram 配置补丁无效');
    if (t?.enabled !== undefined && typeof t.enabled !== 'boolean') throw new Error('Telegram 开关无效');
    if (t?.botToken !== undefined && typeof t.botToken !== 'string') throw new Error('Bot Token 无效');
    if (t?.botToken !== undefined && t.botToken.trim() && !TOKEN_SHAPE.test(t.botToken.trim())) {
      throw new Error('Bot Token 格式无效，请从 BotFather 复制完整 Token');
    }
    if (t?.chatId !== undefined && (typeof t.chatId !== 'string' || t.chatId.length > 40)) throw new Error('Chat ID 无效');
    if (t?.cooldownSeconds !== undefined && (!Number.isInteger(t.cooldownSeconds) || t.cooldownSeconds < 0 || t.cooldownSeconds > 86_400)) throw new Error('冷却秒数无效');
    if (t?.retryCount !== undefined && (!Number.isInteger(t.retryCount) || t.retryCount < 0 || t.retryCount > 5)) throw new Error('重试次数无效');
    if (t?.timeoutMs !== undefined && (!Number.isInteger(t.timeoutMs) || t.timeoutMs < 2_000 || t.timeoutMs > 120_000)) throw new Error('超时毫秒数无效');
    if (t?.subscribedKinds !== undefined && (!Array.isArray(t.subscribedKinds) ||
      t.subscribedKinds.some((kind) => !ALERT_KINDS.includes(kind)))) throw new Error('通知事件订阅无效');
    // Encrypt before entering the lock; a failed Keychain operation leaves the previous config untouched.
    const encryptedToken = t?.botToken !== undefined && t.botToken.trim()
      ? await (this.ports.codec ?? await safeStorageCodec()).encrypt(t.botToken.trim())
      : undefined;
    return withFileLock(`${this.file}.lock`, async () => {
      const current = await this.read();
      const scope = current.scopes[key] ?? defaultScope();
      const next: StoredConfig = {
        ...current,
        tokenCiphertext: t?.botToken === undefined ? current.tokenCiphertext : encryptedToken ?? '',
        chatId: t?.chatId === undefined ? current.chatId : t.chatId.trim(),
        cooldownSeconds: t?.cooldownSeconds ?? current.cooldownSeconds,
        retryCount: t?.retryCount ?? current.retryCount,
        timeoutMs: t?.timeoutMs ?? current.timeoutMs,
        scopes: {
          ...current.scopes,
          [key]: {
            localEnabled: patch.localEnabled ?? scope.localEnabled,
            telegramEnabled: t?.enabled ?? scope.telegramEnabled,
            subscribedKinds: t?.subscribedKinds ? ALERT_KINDS.filter((kind) => t.subscribedKinds!.includes(kind)) : [...scope.subscribedKinds],
          },
        },
      };
      if (t?.botToken === '') {
        // The credential is shared, so clearing it must also switch off every dependent scope.
        for (const savedScope of Object.values(next.scopes)) savedScope.telegramEnabled = false;
        next.remoteReadOnlyEnabled = false;
      }
      if (next.remoteReadOnlyEnabled && (!next.tokenCiphertext || !CHAT_SHAPE.test(next.chatId) ||
          !USER_SHAPE.test(next.authorizedUserId ?? ''))) {
        throw new Error('只读机器人已启用，请保持有效的 Bot Token、Chat ID 和授权用户 ID');
      }
      if (next.scopes[key]!.telegramEnabled && (!next.tokenCiphertext || !CHAT_SHAPE.test(next.chatId))) {
        throw new Error('启用 Telegram 前请先保存有效 Bot Token 和数字 Chat ID');
      }
      await writePrivate(this.file, next);
      return this.view(gameId, index, next);
    });
  }

  async test(gameId: string, index: number, channel: 'local' | 'telegram'): Promise<NotificationTestResult> {
    assertScope(gameId, index);
    if (channel !== 'local' && channel !== 'telegram') throw new Error('通知通道无效');
    try {
      if (channel === 'local') {
        await (this.ports.showLocal ?? defaultShowLocal)('万龙助手 · 测试通知', `游戏 ${gameId} · 实例 #${index} 的本地通知可用。`);
        return { channel, ok: true, message: '已请求系统显示一条测试通知。', attempts: 1 };
      }
      const config = await this.read();
      return this.sendTelegram(config, `万龙助手 · 测试推送\n游戏 ${gameId} · 实例 #${index}\n收到此消息表示 Bot Token 与 Chat ID 可用。`);
    } catch (error) {
      // Never return transport exceptions: they can contain the token-bearing request URL.
      return { channel, ok: false, message: channel === 'telegram' ? '发送失败；请检查网络、代理和机器人设置。' : safeError(error, ''), attempts: 0 };
    }
  }

  /** Queue delivery independently from the run; a failing network must never turn a successful gather into failure. */
  enqueue(alert: InsightAlert): void {
    const next = this.queue.catch(() => undefined).then(() => this.deliver(alert));
    this.queue = next.catch(() => undefined);
  }

  async flush(): Promise<void> { await this.queue; }

  private async deliver(alert: InsightAlert): Promise<void> {
    try {
      const config = await this.read();
      const scopeKey = assertScope(alert.gameId, alert.index);
      const scope = config.scopes[scopeKey] ?? defaultScope();
      if (!scope.subscribedKinds.includes(alert.kind)) return;
      const title = alert.severity === 'critical' ? '自动化需要处理' : '自动化运行提醒';
      const body = `${alert.gameId} · 实例 #${alert.index}\n${alert.message}`;
      for (const channel of ['local', 'telegram'] as const) {
        if (channel === 'local' ? !scope.localEnabled : !scope.telegramEnabled) continue;
        const cooldownKey = `${channel}:${scopeKey}:${alert.kind}`;
        if (this.now() - (config.lastSentAt[cooldownKey] ?? 0) < config.cooldownSeconds * 1000) continue;
        let result: NotificationTestResult;
        if (channel === 'local') {
          try {
            await (this.ports.showLocal ?? defaultShowLocal)(title, body);
            result = { channel, ok: true, message: '已请求系统显示通知。', attempts: 1 };
          } catch {
            result = { channel, ok: false, message: '本地通知发送失败。', attempts: 1 };
          }
        } else {
          result = await this.sendTelegram(config, `${title}\n${body}`);
        }
        try { this.ports.onDelivery?.(alert, result); } catch { /* Observers cannot affect automation. */ }
        if (!result.ok) continue;
        // Another process can update the config while the network request is in flight.
        await withFileLock(`${this.file}.lock`, async () => {
          const fresh = await this.read();
          fresh.lastSentAt[cooldownKey] = this.now();
          await writePrivate(this.file, fresh);
        });
      }
    } catch {
      // Alert already lives in the local ledger. Notification outages never mutate device work.
    }
  }

  private async sendTelegram(config: StoredConfig, text: string): Promise<NotificationTestResult> {
    const channel = 'telegram';
    if (!config.tokenCiphertext || !CHAT_SHAPE.test(config.chatId)) {
      return { channel, ok: false, message: '请先填写 Bot Token 和数字 Chat ID。', attempts: 0 };
    }
    let token: string;
    try { token = await (this.ports.codec ?? await safeStorageCodec()).decrypt(config.tokenCiphertext); }
    catch { return { channel, ok: false, message: '系统钥匙串无法读取 Bot Token，请重新保存。', attempts: 0 }; }
    if (!TOKEN_SHAPE.test(token)) return { channel, ok: false, message: 'Bot Token 格式无效，请重新保存。', attempts: 0 };
    const fetcher = this.ports.fetch ?? defaultFetch;
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const body = JSON.stringify({ chat_id: config.chatId, text: text.slice(0, 3900), disable_web_page_preview: true });
    let last = 'Telegram 请求失败。';
    for (let attempt = 1; attempt <= config.retryCount + 1; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs);
      try {
        const response = await fetcher(url, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: controller.signal,
        });
        if (response.status >= 200 && response.status < 300) {
          return { channel, ok: true, message: 'Telegram 推送成功。', attempts: attempt };
        }
        last = telegramProblem(response.status);
        if (response.status !== 429 && response.status < 500) return { channel, ok: false, message: last, attempts: attempt };
      } catch {
        // Network errors may embed the full URL, including token. Discard the raw exception.
        last = controller.signal.aborted ? 'Telegram 请求超时。' : 'Telegram 网络连接失败，请检查代理。';
      } finally {
        clearTimeout(timer);
      }
      if (attempt <= config.retryCount) await new Promise((resolve) => setTimeout(resolve, Math.min(4_000, 500 * 2 ** (attempt - 1))));
    }
    return { channel, ok: false, message: last, attempts: config.retryCount + 1 };
  }
}
