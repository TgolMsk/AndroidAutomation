/**
 * Telegram channel (port of the original `src/main/alerts/telegram.ts`): turns one AlertEvent into one Telegram
 * message and failures into Chinese guidance. It knows nothing about pauses, instances or the scheduler.
 *
 * ★★ Credentials. The token is part of the URL (`https://api.telegram.org/bot<TOKEN>/sendMessage`), so anything that
 * carries the URL out leaks it: undici writes the whole URL into error messages and causes, and stacks repeat it.
 *   1. The URL exists only inside `doPost()`: never a parameter, never a return value.
 *   2. The first thing every catch does is `scrubSecret(describeThrown(e), token)`.
 *   3. `send()` / `sendPhoto()` / `test()` never throw: every failure is a returned NotifyResult.
 *   4. `log()` scrubs once more as the last safety net.
 * ★ No parse_mode: account names and reasons may contain `_ * [ ]`; Telegram would answer 400 exactly when it matters.
 */
import {
  TELEGRAM_CAPTION_MAX, TELEGRAM_PHOTO_MAX_BYTES, TELEGRAM_TEXT_MAX, buildAlertKeyboard, describeTelegramFailure,
  isRetriableFailure, makeAlertEvent, renderAlertText, scrubSecret, skippedNotifyResult, telegramApiUrl,
  validateTelegramConfig, type AlertEvent, type AlertInlineKeyboard, type NotifyFailureKind, type NotifyResult,
  type TelegramConfig,
} from '../../shared/alerts';

/** Only the fields used; the global Response / RequestInit types of Node and Electron disagree. */
export interface HttpResponse {
  readonly status: number;
  text(): Promise<string>;
}

/**
 * JSON string (sendMessage …, content-type set here) or FormData (sendPhoto). ★ With FormData the content-type is
 * never set by hand: fetch generates the multipart boundary, a hand-written header has none and Telegram answers
 * 「there is no photo in the request」.
 */
export type FetchBody = string | FormData;

export type FetchLike = (url: string, init: { method: string; headers?: Record<string, string>; body: FetchBody; signal: AbortSignal }) => Promise<HttpResponse>;

/**
 * Electron's net.fetch (Chromium network stack, honours the system proxy — mainland users almost always need one),
 * falling back to Node's global fetch outside Electron (tests, dev scripts).
 */
export async function defaultTelegramFetch(url: string, init: Parameters<FetchLike>[1]): Promise<HttpResponse> {
  // Resolve the implementation first: a request error must never fall back to a second request.
  resolvedFetch ??= resolveFetch();
  return (await resolvedFetch)(url, init);
}

let resolvedFetch: Promise<FetchLike> | undefined;

async function resolveFetch(): Promise<FetchLike> {
  try {
    const electron = await import('electron') as { net?: { fetch?: unknown } };
    const netFetch = electron.net?.fetch;
    if (typeof netFetch === 'function') return (netFetch as FetchLike).bind(electron.net);
  } catch { /* Not in Electron (tests, dev scripts): Node's fetch. */ }
  return (url, init) => globalThis.fetch(url, init as RequestInit) as unknown as Promise<HttpResponse>;
}

/** Wait at most this long for a 429 retry_after. */
const MAX_RETRY_AFTER_MS = 60_000;
/**
 * ★ Total retry wait cap. Pausing alerts are dispatched right after the pause, but a slow push must never hold a
 * caller for minutes: past this the last failure is returned (in Chinese, like every failure).
 */
const MAX_TOTAL_RETRY_WAIT_MS = 60_000;
/** Backoff of retriable failures other than 429 (ms). */
const BACKOFF_LADDER_MS = [1_000, 2_000, 4_000, 8_000, 8_000];

interface Attempt {
  ok: boolean;
  kind: NotifyFailureKind | null;
  /** ★ Already scrubbed. */
  message: string;
  retryAfterSec: number | null;
}

interface TelegramBody {
  ok?: unknown;
  description?: unknown;
  parameters?: { retry_after?: unknown };
}

function parseBody(text: string): TelegramBody | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null ? value as TelegramBody : null;
  } catch {
    // A proxy error page is not JSON: the status decides.
    return null;
  }
}

/**
 * One line from anything thrown: message plus up to two levels of cause (with errno codes such as ENOTFOUND),
 * ★ never the stack (it repeats the URL and means nothing to the user). The caller scrubs it.
 */
export function describeThrown(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const parts: string[] = [error.message];
  let current: unknown = (error as { cause?: unknown }).cause;
  for (let depth = 0; depth < 2 && current; depth += 1) {
    if (current instanceof Error) {
      const code = (current as { code?: unknown }).code;
      parts.push(typeof code === 'string' ? `${current.message}（${code}）` : current.message);
      current = (current as { cause?: unknown }).cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return parts.join(' ← ');
}

export interface TelegramNotifierDeps {
  /** Current settings (getter: a change applies without rebuilding). Holds the plaintext token: main process only. */
  config(): TelegramConfig;
  fetch?: FetchLike;
  /** Injectable for tests (retry waits). */
  sleep?(ms: number): Promise<void>;
  now?(): number;
  /** ★ Every line is scrubbed before it gets here. */
  log?(level: 'debug' | 'info' | 'warn' | 'error', message: string): void;
}

export class TelegramNotifier {
  readonly id = 'telegram' as const;
  readonly label = 'Telegram';

  constructor(private readonly deps: TelegramNotifierDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /** Switch on and token / chat id well formed. */
  isReady(): boolean {
    const cfg = this.deps.config();
    return cfg.enabled && validateTelegramConfig(cfg).length === 0;
  }

  /**
   * Push one alert. Never throws. `note` (the cooldown's 「期间还发生过 N 次」) belongs to this send only and is
   * appended as the last line, never written into the event.
   */
  async send(event: AlertEvent, note?: string): Promise<NotifyResult> {
    const cfg = this.deps.config();
    if (!cfg.enabled) return skippedNotifyResult('telegram', 'disabled', 'Telegram 推送开关没有打开，本条只记录未发送。', this.now());
    const problems = validateTelegramConfig(cfg);
    if (problems.length > 0) return skippedNotifyResult('telegram', 'notConfigured', problems.join('；'), this.now());
    const body = note ? `${renderAlertText(event)}\n${note}` : renderAlertText(event);
    return this.postWithRetry('sendMessage', () => textPayload(cfg.chatId.trim(), body, buildAlertKeyboard(event, cfg)), cfg);
  }

  /** A plain text message (the bot module's replies). Never throws. */
  async sendText(chatId: string, text: string, replyMarkup?: AlertInlineKeyboard): Promise<NotifyResult> {
    const cfg = this.deps.config();
    const problems = validateTelegramConfig(cfg);
    if (problems.length > 0) return skippedNotifyResult('telegram', 'notConfigured', problems.join('；'), this.now());
    return this.postWithRetry('sendMessage', () => textPayload(chatId.trim() || cfg.chatId.trim(), text, replyMarkup), cfg);
  }

  /**
   * Upload a screenshot (sendPhoto, multipart). Never throws. Same retries and guidance as `send`.
   * ★ A new FormData per attempt (a multipart stream is consumed once; reusing it sends an empty body on retry).
   * ★ Over Telegram's 10 MB limit it fails without a request.
   * @param chatId '' = the configured chat.
   */
  async sendPhoto(chatId: string, image: ArrayBuffer | Uint8Array, caption: string, filename = 'shot.jpg'): Promise<NotifyResult> {
    const cfg = this.deps.config();
    const problems = validateTelegramConfig(cfg);
    if (problems.length > 0) return skippedNotifyResult('telegram', 'notConfigured', problems.join('；'), this.now());
    if (image.byteLength > TELEGRAM_PHOTO_MAX_BYTES) {
      const mb = (image.byteLength / 1024 / 1024).toFixed(1);
      return {
        ok: false, channel: 'telegram', failure: 'unknown', attempts: 0, elapsedMs: 0, at: this.now(), retryAfterSec: null,
        message: `截图 ${mb} MB 超过 Telegram 10MB 限制，没有发送。请把截图降采样后再试。`,
      };
    }
    const target = chatId.trim() || cfg.chatId.trim();
    return this.postWithRetry('sendPhoto', () => photoPayload(target, image, caption, filename), cfg);
  }

  /**
   * The settings page's test push. Ignores the switch on purpose (the user fills in, tests, then switches on) and
   * bypasses subscriptions and cooldown (those gates live in the hub). Never throws.
   */
  async test(): Promise<NotifyResult> {
    const cfg = this.deps.config();
    const problems = validateTelegramConfig(cfg);
    if (problems.length > 0) return skippedNotifyResult('telegram', 'notConfigured', problems.join('；'), this.now());
    // Instance -1: the test concerns no real instance (0 would read as「instance 0 is in trouble」).
    const event = makeAlertEvent({ type: 'test', instanceIndex: -1, reason: '这是一条来自万龙助手的测试推送', accountName: '测试', at: this.now() });
    const body = `${renderAlertText(event)}\n（实例号 -1 表示这条不针对任何具体实例，是设置页「测试推送」按钮发出来的。）`;
    const result = await this.postWithRetry('sendMessage', () => textPayload(cfg.chatId.trim(), body), cfg);
    return result.ok ? { ...result, message: '已推送到 Telegram，去手机上看一眼是不是收到了。' } : result;
  }

  /**
   * Send with retries; only retriable failures retry (a wrong token or chat never becomes right). `payload` builds a
   * fresh body per attempt (a FormData can only be consumed once).
   */
  private async postWithRetry(method: string, payload: () => FetchBody, cfg: TelegramConfig): Promise<NotifyResult> {
    const startedAt = this.now();
    const maxAttempts = 1 + Math.max(0, cfg.retryCount);
    let waited = 0;
    /** ★ Requests actually sent (a badToken stop after one try reports 1, not retryCount + 1). */
    let tried = 0;
    let last: Attempt = { ok: false, kind: 'unknown', message: '推送没有真正发出去（没有执行任何一次尝试）。', retryAfterSec: null };
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      last = await this.doPost(method, payload(), cfg);
      tried = attempt;
      if (last.ok) {
        return {
          ok: true, channel: 'telegram', failure: null, attempts: attempt, elapsedMs: this.now() - startedAt, at: this.now(), retryAfterSec: null,
          message: attempt === 1 ? '已推送到 Telegram。' : `已推送到 Telegram（第 ${attempt} 次尝试成功）。`,
        };
      }
      const kind = last.kind ?? 'unknown';
      if (attempt >= maxAttempts || !isRetriableFailure(kind)) {
        if (!isRetriableFailure(kind) && attempt < maxAttempts) this.log('warn', `Telegram 推送失败且重试无意义（${kind}），不再重试：${last.message}`);
        break;
      }
      // 429 waits what Telegram asked (capped); the rest walk the backoff ladder.
      const wantMs = kind === 'rateLimited' && last.retryAfterSec != null
        ? Math.min(Math.max(1, last.retryAfterSec) * 1000, MAX_RETRY_AFTER_MS)
        : BACKOFF_LADDER_MS[Math.min(attempt - 1, BACKOFF_LADDER_MS.length - 1)] ?? 4_000;
      if (waited + wantMs > MAX_TOTAL_RETRY_WAIT_MS) {
        this.log('warn', `Telegram 推送重试累计等待已超过 ${Math.round(MAX_TOTAL_RETRY_WAIT_MS / 1000)} 秒，不再继续重试。最后一次的原因：${last.message}`);
        break;
      }
      waited += wantMs;
      this.log('info', `Telegram 推送第 ${attempt} 次失败（${kind}），${Math.round(wantMs / 1000)} 秒后重试。`);
      await this.sleep(wantMs);
    }
    return {
      ok: false, channel: 'telegram', failure: last.kind ?? 'unknown', message: last.message, attempts: tried,
      elapsedMs: this.now() - startedAt, at: this.now(), retryAfterSec: last.retryAfterSec,
    };
  }

  /**
   * One HTTP request. Never throws. ★★ The only place holding the token-bearing URL; every catch scrubs first.
   */
  private async doPost(method: string, body: FetchBody, cfg: TelegramConfig): Promise<Attempt> {
    const token = cfg.botToken.trim();
    const url = telegramApiUrl(token, method);
    let response: HttpResponse;
    try {
      response = await (this.deps.fetch ?? defaultTelegramFetch)(url, {
        method: 'POST',
        headers: typeof body === 'string' ? { 'content-type': 'application/json' } : {},
        body,
        // A photo upload is much slower than a text: at least 30 s.
        signal: AbortSignal.timeout(typeof body === 'string' ? cfg.timeoutMs : Math.max(cfg.timeoutMs, 30_000)),
      });
    } catch (error) {
      // ★★ Leak point 1: undici puts the whole URL (token included) into message and cause.
      const raw = scrubSecret(describeThrown(error), token);
      const { kind, message } = describeTelegramFailure({ status: null, description: null, retryAfterSec: null, transportError: raw });
      return { ok: false, kind, message: scrubSecret(message, token), retryAfterSec: null };
    }
    let bodyText = '';
    try {
      bodyText = await response.text();
    } catch (error) {
      // ★★ Leak point 2: a body read cut off midway throws with the URL as well.
      const raw = scrubSecret(describeThrown(error), token);
      return { ok: false, kind: 'network', message: `已经连上 Telegram，但读取响应中途断开了。底层报错：${raw}`, retryAfterSec: null };
    }
    const parsed = parseBody(bodyText);
    if (response.status >= 200 && response.status < 300 && parsed?.ok === true) {
      return { ok: true, kind: null, message: '已推送到 Telegram。', retryAfterSec: null };
    }
    const description = typeof parsed?.description === 'string' ? parsed.description : null;
    const retryAfterRaw = parsed?.parameters?.retry_after;
    const retryAfterSec = typeof retryAfterRaw === 'number' && Number.isFinite(retryAfterRaw) ? retryAfterRaw : null;
    // A 2xx without ok:true (a proxy page) is not a success either: classified by status, then 'unknown'.
    const { kind, message } = response.status >= 200 && response.status < 300
      ? { kind: 'unknown' as const, message: 'Telegram 的回复不是预期的格式（可能被代理改写了），这条推送可能没有发出去。' }
      : describeTelegramFailure({ status: response.status, description, retryAfterSec, transportError: null });
    // Telegram never echoes the token, but a proxy might: this message reaches the UI and the log, scrub it.
    return { ok: false, kind, message: scrubSecret(message, token), retryAfterSec };
  }

  private sleep(ms: number): Promise<void> {
    if (this.deps.sleep) return this.deps.sleep(ms);
    return new Promise((resolve) => { const timer = setTimeout(resolve, ms); timer.unref?.(); });
  }

  /** ★ The single log exit, scrubbed once more. */
  private log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
    const safe = scrubSecret(message, this.deps.config().botToken);
    try { this.deps.log?.(level, safe); } catch { /* A log sink never breaks a push. */ }
  }
}

/** sendMessage body. ★ Never a parse_mode. */
function textPayload(chatId: string, text: string, replyMarkup?: AlertInlineKeyboard): string {
  return JSON.stringify({
    chat_id: chatId,
    text: text.slice(0, TELEGRAM_TEXT_MAX),
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

/** sendPhoto body: a new FormData on every call (retries must not reuse a consumed stream). */
function photoPayload(chatId: string, image: ArrayBuffer | Uint8Array, caption: string, filename: string): FormData {
  const form = new FormData();
  form.append('chat_id', chatId);
  form.append('caption', caption.slice(0, TELEGRAM_CAPTION_MAX));
  const bytes = image instanceof Uint8Array ? Uint8Array.from(image) : new Uint8Array(image.slice(0));
  form.append('photo', new Blob([bytes], { type: 'image/jpeg' }), filename);
  return form;
}
