import { readFile, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { withFileLock } from '@avdm/core';
import {
  AlertThrottle, defaultAlertsConfig, mapLegacyKinds, normalizeAlertsConfig, type AlertsConfig, type ThrottleEntry,
} from '../../shared/alerts';
import { writePrivateFile } from '../app/private-file';

/** Keychain-backed codec for the bot token (electron safeStorage in the app; a fake in tests). */
export interface SecretCodec {
  encrypt(plain: string): Promise<string>;
  decrypt(ciphertext: string): Promise<string>;
}

const VERSION = 1;
const MAX_CONFIG_BYTES = 128 * 1024;
const MAX_THROTTLE_BYTES = 256 * 1024;

/** What `config.json` holds: the normalized config without the token, plus its safeStorage ciphertext (base64). */
interface StoredConfig {
  version: 1;
  detect: AlertsConfig['detect'];
  telegram: Omit<AlertsConfig['telegram'], 'botToken'> & { tokenCiphertext: string };
  local: AlertsConfig['local'];
}

export interface LoadedAlertsConfig {
  /** Normalized config with `botToken` left empty: the caller decrypts `tokenCiphertext` itself. */
  config: AlertsConfig;
  tokenCiphertext: string;
  /** Chinese load problems (never contain the token): logged at startup. */
  warnings: string[];
  /** The config was taken over from the earlier per-instance notification settings this time. */
  migrated: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stamp(at: number): string {
  return new Date(at).toISOString().replace(/[:.]/g, '-');
}

/**
 * `~/.avdm/automation/alerts/{config.json, throttle.json}` (original `<dataDir>/alerts.json`).
 * ★ The token is never written in plaintext: config.json holds its safeStorage ciphertext only. Error messages carry
 *   the path, never the content.
 * ★ Loading is tolerant per field (normalizeAlertsConfig): a broken field falls back alone; an unreadable file is
 *   moved aside and the defaults are used, so a bad file never blocks startup or silently disables pushes for good.
 * On first start the earlier `automation/insights/notifications.json` (per-instance scopes) is migrated once and
 * renamed to `notifications.json.migrated`; its ciphertext is kept as is.
 */
export class AlertsConfigStore {
  readonly file: string;
  readonly throttleFile: string;
  private readonly legacyFile: string;

  constructor(home: string, private readonly now: () => number = Date.now) {
    if (!path.isAbsolute(home)) throw new Error('告警数据目录必须是绝对路径');
    this.file = path.join(home, 'automation', 'alerts', 'config.json');
    this.throttleFile = path.join(home, 'automation', 'alerts', 'throttle.json');
    this.legacyFile = path.join(home, 'automation', 'insights', 'notifications.json');
  }

  async load(): Promise<LoadedAlertsConfig> {
    const warnings: string[] = [];
    const raw = await this.readJson(this.file, MAX_CONFIG_BYTES, warnings, '告警配置');
    if (raw !== undefined) {
      const o = isRecord(raw) ? raw : {};
      if (raw !== null && (!isRecord(raw) || raw['version'] !== VERSION)) {
        warnings.push(`告警配置文件的版本不认识，已按能读懂的字段加载，其余用默认值：${this.file}`);
      }
      const telegram = isRecord(o['telegram']) ? o['telegram'] : {};
      const tokenCiphertext = typeof telegram['tokenCiphertext'] === 'string' ? telegram['tokenCiphertext'] : '';
      return { config: normalizeAlertsConfig({ ...o, telegram: { ...telegram, botToken: '' } }), tokenCiphertext, warnings, migrated: false };
    }
    const legacy = await this.readJson(this.legacyFile, MAX_CONFIG_BYTES, warnings, '旧版通知配置');
    if (legacy !== undefined && legacy !== null) {
      const migrated = migrateLegacy(legacy);
      try {
        await this.save(migrated.config, migrated.tokenCiphertext);
        await rename(this.legacyFile, `${this.legacyFile}.migrated`).catch(() => undefined);
        warnings.push('已把原来按实例保存的通知设置迁移为全局告警推送设置（Bot Token 仍用系统钥匙串加密保存）。');
      } catch (error) {
        warnings.push(`迁移旧版通知配置失败，本次按旧文件的内容运行：${error instanceof Error ? error.message : String(error)}`);
      }
      return { ...migrated, warnings, migrated: true };
    }
    return { config: defaultAlertsConfig(), tokenCiphertext: '', warnings, migrated: false };
  }

  /** Atomic 0600 write under the file lock. `config.telegram.botToken` is ignored: only `tokenCiphertext` is stored. */
  async save(config: AlertsConfig, tokenCiphertext: string): Promise<void> {
    const normalized = normalizeAlertsConfig(config);
    const { botToken: _plain, ...telegram } = normalized.telegram;
    const stored: StoredConfig = { version: VERSION, detect: normalized.detect, telegram: { ...telegram, tokenCiphertext }, local: normalized.local };
    const json = `${JSON.stringify(stored, null, 2)}\n`;
    if (Buffer.byteLength(json) > MAX_CONFIG_BYTES) throw new Error(`告警配置超过大小上限：${this.file}`);
    await withFileLock(`${this.file}.lock`, () => writePrivateFile(this.file, json));
  }

  /** Cooldown snapshot; a bad entry is dropped with a warning (the worst case is one early push). */
  async loadThrottle(): Promise<{ throttle: Record<string, ThrottleEntry>; warnings: string[] }> {
    const warnings: string[] = [];
    const raw = await this.readJson(this.throttleFile, MAX_THROTTLE_BYTES, warnings, '推送冷却记录');
    const entries = isRecord(raw) && isRecord(raw['throttle']) ? raw['throttle'] : {};
    const out: Record<string, ThrottleEntry> = {};
    let dropped = 0;
    for (const [key, value] of Object.entries(entries)) {
      if (!key || key.length > 80 || !isRecord(value)) { dropped++; continue; }
      out[key] = value as unknown as ThrottleEntry;
    }
    if (dropped > 0) warnings.push(`推送冷却记录里有 ${dropped} 条格式不对，已丢弃（最多导致早推一条）。`);
    const throttle = new AlertThrottle(() => 0);
    throttle.restore(out);
    return { throttle: throttle.snapshot(), warnings };
  }

  async saveThrottle(snapshot: Record<string, ThrottleEntry>): Promise<void> {
    const json = `${JSON.stringify({ version: VERSION, throttle: snapshot }, null, 2)}\n`;
    if (Buffer.byteLength(json) > MAX_THROTTLE_BYTES) throw new Error(`推送冷却记录超过大小上限：${this.throttleFile}`);
    await withFileLock(`${this.throttleFile}.lock`, () => writePrivateFile(this.throttleFile, json));
  }

  /**
   * undefined = no file; null = unreadable (moved aside as `.bad-<time>` with a warning so the next start is clean).
   * Messages carry the path only.
   */
  private async readJson(file: string, maxBytes: number, warnings: string[], label: string): Promise<unknown> {
    try {
      if ((await stat(file)).size > maxBytes) throw new Error('文件超过大小上限');
      return JSON.parse(await readFile(file, 'utf8')) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      const backup = `${file}.bad-${stamp(this.now())}`;
      await rename(file, backup).catch(() => undefined);
      warnings.push(`${label}文件无法读取，已改名为 ${path.basename(backup)} 并从默认值开始：${file}`);
      return null;
    }
  }
}

/**
 * The earlier `insights/notifications.json` (v1, per `game:index` scope) → one global config. Telegram / local are on
 * when any scope had them on; subscriptions are the union of the scopes (mapped to alert types); the ciphertext is
 * kept as is. The read-only bot settings carry over.
 */
export function migrateLegacy(raw: unknown): { config: AlertsConfig; tokenCiphertext: string } {
  const o = isRecord(raw) ? raw : {};
  const scopes = isRecord(o['scopes']) ? Object.values(o['scopes']).filter(isRecord) : [];
  const kinds = new Set<string>();
  for (const scope of scopes) {
    if (Array.isArray(scope['subscribedKinds'])) for (const kind of scope['subscribedKinds']) if (typeof kind === 'string') kinds.add(kind);
  }
  const base = defaultAlertsConfig();
  const config = normalizeAlertsConfig({
    version: 1,
    detect: base.detect,
    telegram: {
      ...base.telegram,
      enabled: scopes.some((scope) => scope['telegramEnabled'] === true),
      chatId: typeof o['chatId'] === 'string' ? o['chatId'] : '',
      cooldownSeconds: o['cooldownSeconds'],
      retryCount: o['retryCount'],
      timeoutMs: o['timeoutMs'],
      subscribedTypes: scopes.length > 0 ? mapLegacyKinds([...kinds]) : base.telegram.subscribedTypes,
      remoteReadOnlyEnabled: o['remoteReadOnlyEnabled'] === true,
      authorizedUserId: typeof o['authorizedUserId'] === 'string' ? o['authorizedUserId'] : '',
    },
    local: { enabled: scopes.some((scope) => scope['localEnabled'] === true) },
  });
  const tokenCiphertext = typeof o['tokenCiphertext'] === 'string' ? o['tokenCiphertext'] : '';
  if (!tokenCiphertext) {
    config.telegram.enabled = false;
    config.telegram.remoteReadOnlyEnabled = false;
  }
  return { config, tokenCiphertext };
}
