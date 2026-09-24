/**
 * NotifyHub — configuration, cooldown / dedupe and multi-channel dispatch (port of the original `notifier.ts`).
 *
 * It owns the alerts config (detect thresholds + Telegram + local notifications) and the cooldown, and pushes one
 * event through three gates per channel, in this order: switch on → type subscribed → outside the cooldown.
 * ★ It does not know about pauses: pausing, pause records and the red banner are the AlertCenter's job.
 * ★ `dispatch()` never throws: a failed push must never affect the pause.
 * ★★ The only in-memory plaintext token is `this.cfg.telegram.botToken`. The exits are closed: IPC gets
 *    `toAlertsConfigView()` (no botToken key), logs get `redactAlertsConfig()`, other modules get `getDetectConfig()`;
 *    only the bot module (main process) may call `currentTelegramConfig()`.
 */
import {
  AlertThrottle, TOKEN_SHAPE, alertsPatchProblems, defaultAlertsConfig, isSubscribed, mergeAlertsConfig,
  normalizeSubscriptions, redactAlertsConfig, renderAlertSummary, renderSuppressedNote, scrubSecret, skippedNotifyResult,
  toAlertsConfigView, validateRemoteBotConfig, validateTelegramConfig, type AlertDetectConfig, type AlertEvent, type AlertType,
  type AlertsConfig, type AlertsConfigPatch, type AlertsConfigView, type NotifierId, type NotifyResult, type TelegramConfig,
} from '../../shared/alerts';
import type {
  InsightAlertKind, NotificationConfigPatch, NotificationConfigView, NotificationTestResult, RemoteBotConfigPatch,
  RemoteBotConfigView,
} from '../automation/insights/contracts';
import type { ReadOnlyBotConfig } from '../monitoring/telegram-readonly';
import { LocalNotifier, type ShowLocalNotification } from './local';
import { AlertsConfigStore, type SecretCodec } from './store';
import { TelegramNotifier, type FetchLike } from './telegram';

export type AlertLogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Shape-valid stand-in for a saved token that could not be decrypted (validation only; never sent). */
const SHAPE_OK_PLACEHOLDER = '00000000:PLACEHOLDER_LOCAL_SHAPE_CHECK_ONLY';

export interface NotifyHubPorts {
  /** safeStorage codec (resolved lazily per call; a fake in tests). */
  codec?: SecretCodec | (() => Promise<SecretCodec>);
  fetch?: FetchLike;
  showLocal?: ShowLocalNotification;
  sleep?(ms: number): Promise<void>;
  now?(): number;
  /** ★ Every line is already token-free. */
  log?(level: AlertLogLevel, message: string): void;
  /** Masked view after every save (IPC push `alert-config-changed`). */
  onConfigChanged?(view: AlertsConfigView): void;
}

/** What `dispatch()` returns. */
export interface DispatchOutcome {
  results: NotifyResult[];
  /** Nothing was really attempted (every result has attempts === 0). */
  suppressed: boolean;
}

interface Channel {
  readonly id: NotifierId;
  readonly label: string;
  enabled(): boolean;
  send(event: AlertEvent, note?: string): Promise<NotifyResult>;
  test(): Promise<NotifyResult>;
}

export class NotifyHub {
  private cfg: AlertsConfig = defaultAlertsConfig();
  private tokenCiphertext = '';
  /** Why the saved token could not be decrypted (Keychain unavailable …); null when fine. */
  private tokenError: string | null = null;
  private readonly store: AlertsConfigStore;
  private readonly throttle = new AlertThrottle(() => this.cfg.telegram.cooldownSeconds);
  private readonly telegram: TelegramNotifier;
  private readonly local: LocalNotifier;
  private readonly channels: Channel[];
  private readonly listeners = new Set<(view: AlertsConfigView) => void>();
  /** Serializes config saves and throttle writes inside this process. */
  private chain: Promise<unknown> = Promise.resolve();
  private loaded = false;
  readonly ready: Promise<void>;

  constructor(home: string, private readonly ports: NotifyHubPorts = {}) {
    this.store = new AlertsConfigStore(home, ports.now ?? Date.now);
    this.telegram = new TelegramNotifier({
      config: () => this.cfg.telegram,
      ...(ports.fetch ? { fetch: ports.fetch } : {}),
      ...(ports.sleep ? { sleep: ports.sleep } : {}),
      ...(ports.now ? { now: ports.now } : {}),
      log: (level, message) => this.log(level, message),
    });
    this.local = new LocalNotifier({ config: () => this.cfg.local, ...(ports.showLocal ? { show: ports.showLocal } : {}), ...(ports.now ? { now: ports.now } : {}) });
    this.channels = [
      { id: 'telegram', label: 'Telegram', enabled: () => this.cfg.telegram.enabled, send: (e, n) => this.telegramSend(e, n), test: () => this.telegramTest() },
      { id: 'local', label: '本机通知', enabled: () => this.cfg.local.enabled, send: (e, n) => this.local.send(e, n), test: () => this.local.test() },
    ];
    // Eager load; a failure only means defaults (pushes off) and a logged reason — it never blocks the app.
    this.ready = this.load();
    void this.ready.catch(() => undefined);
  }

  private now(): number {
    return this.ports.now ? this.ports.now() : Date.now();
  }

  private async load(): Promise<void> {
    try {
      const loaded = await this.store.load();
      this.cfg = loaded.config;
      this.tokenCiphertext = loaded.tokenCiphertext;
      for (const warning of loaded.warnings) this.log('warn', warning);
      await this.decryptToken();
      const throttle = await this.store.loadThrottle();
      // ★ The cooldown survives restarts, otherwise every restart re-pushes an instance that is still broken.
      this.throttle.restore(throttle.throttle);
      for (const warning of throttle.warnings) this.log('warn', warning);
      this.log('info', `告警推送模块已就绪：${JSON.stringify(redactAlertsConfig(this.cfg))}`);
    } catch (error) {
      this.cfg = defaultAlertsConfig();
      this.log('error', `读取告警配置失败，本次从默认配置开始（推送处于关闭状态，不影响别的功能）：${this.safe(error)}`);
    } finally {
      this.loaded = true;
    }
  }

  private async codec(): Promise<SecretCodec> {
    const codec = this.ports.codec;
    if (!codec) {
      const { safeStorageCodec } = await import('./safe-storage');
      return safeStorageCodec();
    }
    return typeof codec === 'function' ? codec() : codec;
  }

  private async decryptToken(): Promise<void> {
    this.tokenError = null;
    this.cfg.telegram.botToken = '';
    if (!this.tokenCiphertext) return;
    try {
      const token = (await (await this.codec()).decrypt(this.tokenCiphertext)).trim();
      if (!TOKEN_SHAPE.test(token)) throw new Error('已保存的 Bot Token 格式无效');
      this.cfg.telegram.botToken = token;
    } catch (error) {
      this.tokenError = `系统钥匙串无法读取已保存的 Bot Token（${this.safe(error)}），请在设置里重新填写一次。`;
      this.log('warn', this.tokenError);
    }
  }

  // ── Config ────────────────────────────────────────────────────────────────

  /** ★ The renderer's only view (no token). */
  getConfigView(): AlertsConfigView {
    const view = toAlertsConfigView(this.cfg);
    // A saved but unreadable token still counts as「已配置」so the form keeps saying where it went.
    if (!view.telegram.botTokenSet && this.tokenCiphertext) view.telegram = { ...view.telegram, botTokenSet: true, botTokenMasked: '••••••••' };
    return view;
  }

  /** Thresholds for the detectors; ★ never the Telegram half. */
  getDetectConfig(): AlertDetectConfig {
    return { ...this.cfg.detect };
  }

  /** ★★ Main process only (the Telegram bot): plaintext token. Never send across IPC or log it. */
  currentTelegramConfig(): TelegramConfig {
    return { ...this.cfg.telegram, subscribedTypes: [...this.cfg.telegram.subscribedTypes] };
  }

  /** The Telegram channel (the bot module sends photos and replies through it; same retries and scrubbing). */
  telegramChannel(): TelegramNotifier {
    return this.telegram;
  }

  onConfigChanged(listener: (view: AlertsConfigView) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /**
   * Save a partial config, persist it and publish the masked view. ★ Three-state token (absent keep / non-empty
   * replace / '' clear); a new token is encrypted before the file lock; the patch itself is never logged.
   * Throws a Chinese message for an invalid patch or a switch that needs missing credentials.
   */
  async saveConfig(patch: AlertsConfigPatch): Promise<AlertsConfigView> {
    await this.ready;
    const problems = alertsPatchProblems(patch);
    if (problems.length > 0) throw new Error(`告警设置无效：${problems.join('；')}`);
    const newToken = typeof patch.telegram?.botToken === 'string' ? patch.telegram.botToken.trim() : undefined;
    if (newToken && !TOKEN_SHAPE.test(newToken)) {
      throw new Error('Bot Token 的格式不对：应该形如「123456789:AAE…」（冒号前是一串数字，冒号后是一长串字母数字），别把「HTTP API:」一起粘进来。');
    }
    const ciphertext = newToken ? await (await this.codec()).encrypt(newToken) : newToken === '' ? '' : undefined;
    return this.serialize(async () => {
      const next = mergeAlertsConfig(this.cfg, patch);
      // The token unchanged but unreadable (Keychain): keep its ciphertext, do not wipe it.
      const nextCiphertext = ciphertext ?? this.tokenCiphertext;
      // A saved token that only failed to decrypt still counts as present for the switches below.
      const credential = next.telegram.botToken || (ciphertext === undefined && nextCiphertext ? SHAPE_OK_PLACEHOLDER : '');
      if (next.telegram.enabled) {
        const issues = validateTelegramConfig({ botToken: credential, chatId: next.telegram.chatId });
        if (issues.length > 0) throw new Error(`开启 Telegram 推送前请先补齐：${issues.join('；')}`);
      }
      if (next.telegram.remoteReadOnlyEnabled || next.telegram.remoteControlEnabled) {
        const issues = validateRemoteBotConfig({ botToken: credential, chatId: next.telegram.chatId, authorizedUserId: next.telegram.authorizedUserId });
        if (issues.length > 0) throw new Error(`启用机器人前请先补齐：${issues.join('；')}`);
      }
      await this.store.save(next, nextCiphertext);
      this.cfg = next;
      this.tokenCiphertext = nextCiphertext;
      if (ciphertext !== undefined) this.tokenError = null;
      this.log('info', `告警配置已更新：${JSON.stringify(redactAlertsConfig(this.cfg))}`);
      const view = this.getConfigView();
      for (const listener of [...this.listeners]) {
        try { listener(view); } catch (error) { this.log('warn', `告警配置变更回调抛异常，已忽略：${this.safe(error)}`); }
      }
      try { this.ports.onConfigChanged?.(view); } catch { /* A UI push never breaks a save. */ }
      return view;
    });
  }

  // ── Test push ─────────────────────────────────────────────────────────────

  /**
   * The settings page's 「测试推送」. Preflight first: config problems answer at once without a request (waiting 15 s
   * to learn the token is empty is a poor experience). Bypasses subscriptions and cooldown. Never throws.
   */
  async test(channel: NotifierId = 'telegram'): Promise<NotifyResult> {
    await this.ready;
    const target = this.channels.find((item) => item.id === channel);
    if (!target) return skippedNotifyResult('telegram', 'unknown', '通知渠道无效', this.now());
    if (channel === 'telegram') {
      if (this.tokenError && !this.cfg.telegram.botToken) return skippedNotifyResult('telegram', 'notConfigured', this.tokenError, this.now());
      const problems = validateTelegramConfig(this.cfg.telegram);
      if (problems.length > 0) return skippedNotifyResult('telegram', 'notConfigured', problems.join('；'), this.now());
    }
    const result = await target.test();
    this.log(result.ok ? 'info' : 'warn', `${target.label}测试推送${result.ok ? '成功' : '失败'}：${result.message}`);
    return result;
  }

  // ── Dispatch ──────────────────────────────────────────────────────────────

  /**
   * Push one event on every channel. Never throws. Per channel, in this order:
   *   1. switch off / not configured → nothing sent ('disabled' / 'notConfigured')
   *   2. type not subscribed → nothing sent ('unsubscribed'; the pause happens anyway)
   *   3. inside the cooldown → nothing sent, suppressed count +1; the next allowed send carries
   *      「冷却期内还发生过 N 次同类事件」
   * ★ Only a successful send restarts the cooldown: a failure must not eat the window.
   */
  async dispatch(event: AlertEvent): Promise<DispatchOutcome> {
    await this.ready;
    const results: NotifyResult[] = [];
    let throttleChanged = false;
    for (const channel of this.channels) {
      let result: NotifyResult;
      try {
        if (!channel.enabled()) {
          result = skippedNotifyResult(channel.id, 'disabled', `${channel.label}开关没有打开，本条只记录在助手里，没有发出去。`, this.now());
        } else if (!isSubscribed(this.cfg.telegram, event.type)) {
          result = skippedNotifyResult(channel.id, 'unsubscribed', `「${event.type}」这类事件没有被订阅推送（可在设置页勾上）。`, this.now());
        } else {
          const key = `${channel.id}|${event.dedupeKey}`;
          const decision = this.throttle.check(key, this.now());
          if (!decision.allow) {
            this.throttle.markSuppressed(key, this.now());
            throttleChanged = true;
            result = skippedNotifyResult(channel.id, 'throttled', `${decision.reason}，本条只记录未推送（累计已压掉 ${decision.suppressedCount + 1} 条）。`, this.now());
          } else {
            const note = renderSuppressedNote(decision.suppressedCount);
            result = await channel.send(event, note || undefined);
            if (result.ok) { this.throttle.markSent(key, this.now()); throttleChanged = true; }
          }
        }
      } catch (error) {
        // Channels never throw by contract; if one does, it must not take the caller down.
        result = skippedNotifyResult(channel.id, 'unknown', `${channel.label}通道内部异常（这属于程序错误，请把日志发给开发者）：${this.safe(error)}`, this.now());
        this.log('error', `${channel.label}通道抛了异常，已兜住：${this.safe(error)}`);
      }
      results.push(result);
    }
    if (throttleChanged) await this.persistThrottle();
    const suppressed = results.length > 0 && results.every((result) => result.attempts === 0);
    const detail = results.map((result) => `${result.channel}:${result.ok ? 'ok' : (result.failure ?? 'fail')}`).join(' ');
    this.log(results.some((result) => result.ok) ? 'info' : 'debug',
      `告警推送${suppressed ? '未发送' : results.some((result) => result.ok) ? '已发送' : '发送失败'}｜${renderAlertSummary(event)}｜${detail}`);
    return { results, suppressed };
  }

  /** An instance was resumed: clear its cooldown on every channel so the next problem is pushed at once. */
  async resetThrottleForInstance(instanceIndex: number): Promise<void> {
    await this.ready;
    this.throttle.resetInstance(instanceIndex);
    await this.persistThrottle();
  }

  snapshotThrottle(): ReturnType<AlertThrottle['snapshot']> {
    return this.throttle.snapshot();
  }

  // ── Compatibility with the earlier per-instance notification IPC ───────────

  /** `getNotificationConfig(gameId, index)`: the global settings in the earlier per-instance shape. */
  async legacyNotificationView(gameId: string, index: number): Promise<NotificationConfigView> {
    await this.ready;
    const view = this.getConfigView();
    return {
      gameId, index, localEnabled: view.local.enabled,
      telegram: {
        enabled: view.telegram.enabled, botTokenSet: view.telegram.botTokenSet, botTokenMasked: view.telegram.botTokenMasked,
        chatId: view.telegram.chatId, cooldownSeconds: view.telegram.cooldownSeconds, retryCount: view.telegram.retryCount,
        timeoutMs: view.telegram.timeoutMs,
        subscribedKinds: view.telegram.subscribedTypes.filter((type): type is Extract<AlertType, InsightAlertKind> => type !== 'instanceResumed' && type !== 'test'),
      },
    };
  }

  /** `saveNotificationConfig(gameId, index, patch)`: the settings are global now; the patch applies to all instances. */
  async saveLegacyNotification(gameId: string, index: number, patch: NotificationConfigPatch): Promise<NotificationConfigView> {
    const t = patch.telegram;
    const next: AlertsConfigPatch = {};
    if (patch.localEnabled !== undefined) next.local = { enabled: patch.localEnabled };
    if (t) {
      next.telegram = {
        ...(t.enabled !== undefined ? { enabled: t.enabled } : {}),
        ...(t.botToken !== undefined ? { botToken: t.botToken } : {}),
        ...(t.chatId !== undefined ? { chatId: t.chatId } : {}),
        ...(t.cooldownSeconds !== undefined ? { cooldownSeconds: t.cooldownSeconds } : {}),
        ...(t.retryCount !== undefined ? { retryCount: t.retryCount } : {}),
        ...(t.timeoutMs !== undefined ? { timeoutMs: t.timeoutMs } : {}),
        ...(t.subscribedKinds !== undefined ? {
          subscribedTypes: normalizeSubscriptions([
            ...t.subscribedKinds, ...(this.cfg.telegram.subscribedTypes.includes('instanceResumed') ? ['instanceResumed'] : []),
          ]),
        } : {}),
      };
    }
    await this.saveConfig(next);
    return this.legacyNotificationView(gameId, index);
  }

  /** `testNotification(gameId, index, channel)`. */
  async legacyTest(channel: 'local' | 'telegram'): Promise<NotificationTestResult> {
    const result = await this.test(channel);
    return { channel, ok: result.ok, message: result.message, attempts: result.attempts };
  }

  async remoteBotConfig(running = false): Promise<RemoteBotConfigView> {
    await this.ready;
    const view = this.getConfigView();
    return {
      enabled: view.telegram.remoteReadOnlyEnabled, running, botTokenSet: view.telegram.botTokenSet,
      chatId: view.telegram.chatId, authorizedUserId: view.telegram.authorizedUserId,
    };
  }

  async saveRemoteBotConfig(patch: RemoteBotConfigPatch, running = false): Promise<RemoteBotConfigView> {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('只读机器人配置补丁无效');
    if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') throw new Error('只读机器人开关无效');
    if (patch.authorizedUserId !== undefined && (typeof patch.authorizedUserId !== 'string' || patch.authorizedUserId.length > 32)) {
      throw new Error('授权用户 ID 无效');
    }
    await this.saveConfig({
      telegram: {
        ...(patch.enabled !== undefined ? { remoteReadOnlyEnabled: patch.enabled } : {}),
        ...(patch.authorizedUserId !== undefined ? { authorizedUserId: patch.authorizedUserId.trim() } : {}),
      },
    });
    return this.remoteBotConfig(running);
  }

  /** ★ Main process only: the read-only bot's runtime config (plaintext token). */
  async readOnlyBotConfig(): Promise<ReadOnlyBotConfig> {
    await this.ready;
    const t = this.cfg.telegram;
    const enabled = t.remoteReadOnlyEnabled || t.remoteControlEnabled;
    if (!enabled) return { enabled: false, botToken: '', chatId: t.chatId, userId: t.authorizedUserId };
    if (validateRemoteBotConfig(t).length > 0) throw new Error('只读机器人配置不完整');
    return { enabled, botToken: t.botToken, chatId: t.chatId, userId: t.authorizedUserId };
  }

  /** The loaded flag (tests). */
  isLoaded(): boolean {
    return this.loaded;
  }

  /** Wait for queued writes (quit). */
  async flush(): Promise<void> {
    await this.chain.catch(() => undefined);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async telegramSend(event: AlertEvent, note?: string): Promise<NotifyResult> {
    if (this.tokenError && !this.cfg.telegram.botToken) return skippedNotifyResult('telegram', 'notConfigured', this.tokenError, this.now());
    return this.telegram.send(event, note);
  }

  private async telegramTest(): Promise<NotifyResult> {
    return this.telegram.test();
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** ★ A failed write is logged, never thrown: a disk problem must not fail a push or a pause. */
  private async persistThrottle(): Promise<void> {
    const snapshot = this.throttle.snapshot();
    await this.serialize(() => this.store.saveThrottle(snapshot)).catch((error: unknown) =>
      this.log('error', `保存推送冷却记录失败：${this.safe(error)}`));
  }

  private safe(error: unknown): string {
    const text = error instanceof Error ? error.message : String(error);
    return scrubSecret(text, this.cfg.telegram.botToken);
  }

  private log(level: AlertLogLevel, message: string): void {
    const safe = scrubSecret(message, this.cfg.telegram.botToken);
    try { this.ports.log?.(level, safe); } catch { /* A log sink never breaks alerts. */ }
  }
}
