/**
 * The Telegram bot channel (port of wanlong-panel `src/main/alerts/telegramBot.ts`; replaces this app's earlier
 * read-only bot): buttons and commands on the phone run bot actions on this machine.
 *
 * Scenario: an alert「疑似被顶号」arrives at night — press 「重启游戏并恢复」 under it; in the daytime press 「📷 截图」
 * in the bottom menu, pick an account, and the picture arrives a few seconds later.
 *
 *   · getUpdates long polling (timeout 25 s): the assistant runs on a home machine without a public address.
 *   · ★ Authorization: only messages / buttons from the configured Chat ID AND the authorized user id are served
 *     (this app's hardening; the original checked the chat only). Others are ignored with one warning per chat/user;
 *     an unauthorized button is answered 「未授权的会话。」 and nothing runs.
 *   · ★ Permissions (DECISIONS A.3): read actions need 「允许手机查看状态与截图」, control actions 「允许手机远程操作」;
 *     both default off, and an action whose switch is off gets a Chinese explanation instead of running.
 *   · Three inputs meet at (action, index): `/shot 1`, the menu button text 「📷 截图」 and the callback `shot:1`.
 *     A required index that is missing first gets an instance picker (one instance → run directly).
 *   · Buttons are answered at once (Telegram wants an answer within 10 s); the slow work runs afterwards on one
 *     ordered queue, so polling and answering never wait for a relaunch.
 *   · ★ The backlog is dropped when polling starts (offset -1): a stale /relaunch never replays after a restart.
 *   · Nothing escapes: the loop backs off (1 s doubling to 60 s; 409 = another process polls this token → 60 s), and a
 *     failed action answers 「操作失败：<reason>」.
 *   · ★★ The token exists only in the URL inside `api()`; every log line and every text sent to the user is scrubbed.
 *   · No parse_mode, ever (account names may contain `_ * [ ]`).
 */
import {
  CHAT_ID_SHAPE, scrubSecret, telegramApiUrl, validateRemoteBotConfig, type TelegramConfig,
} from '../../shared/alerts';
import {
  BOT_ACTION_SPECS, BOT_COMMAND_LIST, BOT_HELP_TEXT, BOT_TEXT_MAX, TELEGRAM_CAPTION_MAX, TELEGRAM_PHOTO_MAX_BYTES,
  actionOfCommand, botActionAllowed, botPermissionRefusal, buildInstancePicker, buildMenuKeyboard, commandOfButtonText,
  parseCallbackData, type BotAction, type BotActionPort, type BotActionResult, type BotCommand, type BotInlineKeyboard,
  type BotPhoto, type BotReplyKeyboard, type BotStatusView,
} from '../../shared/bot';
import { defaultTelegramFetch, describeThrown, type FetchLike } from '../alerts/telegram';

export type BotChannelLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface TelegramBotDeps {
  /** Current settings (★ plaintext token: main process only). Read at start and before every polled batch. */
  config(): Promise<TelegramConfig>;
  /** The only boundary to the actions (`createBotActions`). */
  actions: BotActionPort;
  /** Tests inject a fake; the app uses Electron's net.fetch (system proxy). */
  fetch?: FetchLike;
  /** ★ Every line is already scrubbed. */
  log?(level: BotChannelLogLevel, message: string): void;
  /** Running / problem changes (settings page, `hub.setRemoteControlHandler`). */
  onStatus?(status: BotStatusView): void;
  /** Abortable wait (tests use a virtual one). */
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
  now?(): number;
}

// ── Telegram update shapes (the fields used) ────────────────────────────────

interface TgMessage {
  message_id?: unknown;
  chat?: { id?: unknown };
  from?: { id?: unknown };
  text?: unknown;
}

interface TgCallbackQuery {
  id?: unknown;
  from?: { id?: unknown };
  message?: TgMessage;
  data?: unknown;
}

interface TgUpdate {
  update_id?: unknown;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

interface TgResponse {
  ok?: unknown;
  description?: unknown;
  result?: unknown;
}

type ReplyMarkup = BotInlineKeyboard | BotReplyKeyboard;

/** Long polling waits at most this long on Telegram's side. */
const POLL_TIMEOUT_SEC = 25;
/** The request timeout must outlast the long poll, or every poll cuts itself off. */
const POLL_HTTP_TIMEOUT_MS = (POLL_TIMEOUT_SEC + 10) * 1_000;
const ACTION_HTTP_TIMEOUT_MS = 15_000;
/** Uploading a photo is much slower than a text. */
const PHOTO_HTTP_TIMEOUT_MS = 30_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
/** Updates per poll (this app's cap). */
const UPDATE_LIMIT = 50;
/** Response bodies read at most this much. */
const MAX_BODY_CHARS = 1_000_000;
/** Queued slow actions beyond this are refused with 「机器人正忙」. */
const MAX_QUEUED = 20;
/** Unauthorized chats remembered for the once-only warning (a stranger cannot grow it without bound). */
const MAX_WARNED = 256;
/** Texts parsed from a message (a command line is short). */
const MAX_COMMAND_CHARS = 200;
/** How long `stop()` waits for the action in progress to finish sending. */
const STOP_DRAIN_MS = 3_000;

const TOKEN_IN_URL = /bot\d{5,}:[A-Za-z0-9_-]{20,}/g;
const TOKEN_LIKE = /\d{5,}:[A-Za-z0-9_-]{30,}/g;

/** A failed Bot API call. `message` is scrubbed; `status` is null when nothing was received. */
export class BotApiError extends Error {
  constructor(readonly method: string, readonly status: number | null, message: string) {
    super(message);
    this.name = 'BotApiError';
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A Telegram id as a string (numbers and numeric strings only). */
function idOf(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (typeof value === 'string' && CHAT_ID_SHAPE.test(value)) return value;
  return null;
}

/** Whether the phone may use the bot at all under these switches. */
function botWanted(cfg: TelegramConfig): boolean {
  return cfg.remoteReadOnlyEnabled || cfg.remoteControlEnabled;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const timer = setTimeout(done, ms);
    timer.unref?.();
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

export class TelegramBot {
  private active = false;
  private offset = 0;
  private prepared = false;
  private abort: AbortController | null = null;
  private loopPromise: Promise<void> | null = null;
  /** Serializes start / stop / restart. */
  private lifecycle: Promise<unknown> = Promise.resolve();
  /** The ordered queue of slow work (actions and their replies). */
  private work: Promise<void> = Promise.resolve();
  private queued = 0;
  /** Chat/user pairs already warned about (once each). */
  private readonly warned = new Set<string>();
  /** The token of the last config read (for scrubbing outside a request). */
  private lastToken = '';
  private view: BotStatusView = { running: false, readEnabled: false, controlEnabled: false, problem: null, since: null };

  constructor(private readonly deps: TelegramBotDeps) {}

  isRunning(): boolean {
    return this.active;
  }

  status(): BotStatusView {
    return { ...this.view };
  }

  /**
   * Start polling when a switch is on and the credentials are complete. Returns false (not an error) when both
   * switches are off; throws a Chinese message when a switch is on but the settings are incomplete.
   */
  start(): Promise<boolean> {
    return this.serialize(() => this.doStart());
  }

  stop(): Promise<void> {
    return this.serialize(() => this.doStop());
  }

  /** After every settings change: stop, then start by the new settings. */
  restart(): Promise<boolean> {
    return this.serialize(async () => { await this.doStop(); return this.doStart(); });
  }

  /** Wait for the queued actions and replies (tests, shutdown). */
  async idle(): Promise<void> {
    let seen: Promise<void>;
    do { seen = this.work; await seen; } while (seen !== this.work);
  }

  /**
   * The settings page's 「测试机器人连接」: getMe, then one message to the configured chat. Needs complete
   * credentials, not the switches (fill in, test, then switch on). Never throws.
   */
  async testConnection(): Promise<{ ok: boolean; message: string }> {
    let cfg: TelegramConfig | null = null;
    try {
      cfg = await this.deps.config();
      this.lastToken = cfg.botToken;
      const problems = validateRemoteBotConfig(cfg);
      if (problems.length > 0) return { ok: false, message: `机器人配置还不完整：${problems.join('；')}` };
      await this.api(cfg, 'getMe', {}, ACTION_HTTP_TIMEOUT_MS);
      await this.api(cfg, 'sendMessage', {
        chat_id: cfg.chatId.trim(), text: '万龙助手机器人测试成功。发 /help 查看可用命令。', disable_web_page_preview: true,
      }, ACTION_HTTP_TIMEOUT_MS);
      return { ok: true, message: '机器人与目标会话可用，已发送一条测试消息。' };
    } catch (error) {
      return { ok: false, message: `测试失败：${this.clean(messageOf(error), cfg?.botToken)}。请检查 Bot Token、Chat ID、授权用户 ID、网络和机器人会话权限。` };
    }
  }

  /**
   * One poll without waiting (timeout 0), for deterministic tests and diagnostics. Same gates as the loop; does not
   * drop the backlog. Queued actions finish later: await `idle()`.
   */
  async pollOnce(): Promise<number> {
    const cfg = await this.deps.config();
    this.lastToken = cfg.botToken;
    if (!botWanted(cfg)) return 0;
    const problems = validateRemoteBotConfig(cfg);
    if (problems.length > 0) throw new Error(`机器人配置不完整：${problems.join('；')}`);
    return this.pollBatch(cfg, 0);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.lifecycle.then(fn, fn);
    this.lifecycle = next.catch(() => undefined);
    return next;
  }

  private async doStart(): Promise<boolean> {
    if (this.active) return true;
    const cfg = await this.deps.config();
    this.lastToken = cfg.botToken;
    if (!botWanted(cfg)) {
      this.setStatus({ running: false, readEnabled: false, controlEnabled: false, problem: null });
      return false;
    }
    const problems = validateRemoteBotConfig(cfg);
    if (problems.length > 0) {
      const problem = `机器人没有启动：${problems.join('；')}`;
      this.setStatus({ running: false, readEnabled: cfg.remoteReadOnlyEnabled, controlEnabled: cfg.remoteControlEnabled, problem });
      throw new Error(problem);
    }
    this.active = true;
    this.prepared = false;
    const controller = new AbortController();
    this.abort = controller;
    this.setStatus({ running: true, readEnabled: cfg.remoteReadOnlyEnabled, controlEnabled: cfg.remoteControlEnabled, problem: null });
    this.loopPromise = this.loop(controller.signal);
    const scope = [cfg.remoteReadOnlyEnabled ? '查看状态与截图' : '', cfg.remoteControlEnabled ? '远程操作' : ''].filter(Boolean).join('、');
    this.log('info', `Telegram 机器人已启动（长轮询；已开放：${scope}；只响应配置的 Chat ID 与授权用户）。`);
    return true;
  }

  private async doStop(): Promise<void> {
    const loop = this.loopPromise;
    if (!this.active && !loop) return;
    this.active = false;
    this.abort?.abort(new Error('机器人已停止'));
    await loop?.catch(() => undefined);
    // The action in progress keeps its lock and finishes on its own; only its reply may be cut off.
    await Promise.race([this.work, new Promise<void>((resolve) => { const timer = setTimeout(resolve, STOP_DRAIN_MS); timer.unref?.(); })]);
    this.loopPromise = null;
    this.abort = null;
    this.setStatus({ running: false, problem: null });
    this.log('info', 'Telegram 机器人已停止。');
  }

  private setStatus(patch: Partial<Omit<BotStatusView, 'since'>>): void {
    const next = { ...this.view, ...patch };
    const changed = next.running !== this.view.running || next.problem !== this.view.problem ||
      next.readEnabled !== this.view.readEnabled || next.controlEnabled !== this.view.controlEnabled;
    if (!changed) return;
    if (next.running !== this.view.running) next.since = this.now();
    this.view = next;
    try { this.deps.onStatus?.({ ...next }); } catch { /* An observer never breaks the bot. */ }
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  // ── Polling ───────────────────────────────────────────────────────────────

  private async loop(signal: AbortSignal): Promise<void> {
    let backoff = BACKOFF_MIN_MS;
    while (this.active && !signal.aborted) {
      try {
        const cfg = await this.deps.config();
        this.lastToken = cfg.botToken;
        if (!this.prepared) {
          await this.prepare(cfg);
          this.prepared = true;
        }
        await this.pollBatch(cfg, POLL_TIMEOUT_SEC);
        backoff = BACKOFF_MIN_MS;
        if (this.view.problem) this.setStatus({ problem: null });
      } catch (error) {
        if (!this.active || signal.aborted) break;
        const status = error instanceof BotApiError ? error.status : null;
        let wait = backoff;
        let problem: string;
        if (status === 409) {
          problem = '另有一个进程在用同一个 Bot Token 轮询（比如同时开了两个助手或旧版面板）。Telegram 只允许一个，60 秒后重试。';
          wait = BACKOFF_MAX_MS;
        } else if (status === 401 || status === 404) {
          problem = 'Bot Token 无效（Telegram 返回 401/404）。请在「通知与推送」里重新填写 Token。';
          wait = BACKOFF_MAX_MS;
        } else {
          problem = `Telegram 轮询失败，${Math.round(wait / 1000)} 秒后重试：${this.clean(messageOf(error))}`;
        }
        this.log('warn', problem);
        this.setStatus({ problem });
        await (this.deps.sleep ?? defaultSleep)(wait, signal);
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
      }
    }
  }

  /**
   * Before the first poll: drop the backlog (offset -1 keeps only the newest update, which is skipped as well) and
   * register the 「/」 command menu (a failure only warns).
   */
  private async prepare(cfg: TelegramConfig): Promise<void> {
    const last = await this.getUpdates(cfg, -1, 0, 1);
    const ids = last.map((update) => update.update_id).filter((id): id is number => typeof id === 'number' && Number.isSafeInteger(id));
    if (ids.length > 0) this.offset = Math.max(this.offset, ...ids.map((id) => id + 1));
    try {
      await this.api(cfg, 'setMyCommands', { commands: BOT_COMMAND_LIST }, ACTION_HTTP_TIMEOUT_MS);
    } catch (error) {
      // The phone just lacks the 「/」 suggestions; sending and receiving still work.
      this.log('warn', `注册机器人命令菜单失败（不影响使用）：${this.clean(messageOf(error))}`);
    }
  }

  private async pollBatch(cfg: TelegramConfig, timeoutSec: number): Promise<number> {
    const updates = await this.getUpdates(cfg, this.offset, timeoutSec, UPDATE_LIMIT);
    for (const update of updates) {
      const id = update.update_id;
      if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < this.offset) continue;
      // Advance first: an update that throws is skipped, never retried forever.
      this.offset = id + 1;
      try {
        await this.handle(cfg, update);
      } catch (error) {
        this.log('warn', `处理一条 Telegram 更新时出错（已跳过）：${this.clean(messageOf(error))}`);
      }
    }
    return updates.length;
  }

  private async getUpdates(cfg: TelegramConfig, offset: number, timeoutSec: number, limit: number): Promise<TgUpdate[]> {
    const result = await this.api(cfg, 'getUpdates',
      { offset, timeout: timeoutSec, limit, allowed_updates: ['message', 'callback_query'] },
      timeoutSec > 0 ? POLL_HTTP_TIMEOUT_MS : ACTION_HTTP_TIMEOUT_MS);
    return Array.isArray(result) ? (result as TgUpdate[]).slice(0, UPDATE_LIMIT) : [];
  }

  private async handle(cfg: TelegramConfig, update: TgUpdate): Promise<void> {
    if (update.callback_query) return this.onCallback(cfg, update.callback_query);
    if (update.message && typeof update.message.text === 'string') return this.onMessage(cfg, update.message);
  }

  // ── Authorization ─────────────────────────────────────────────────────────

  /** ★ Chat ID AND authorized user id; one warning per unknown chat/user pair. */
  private authorized(cfg: TelegramConfig, chatId: string | null, userId: string | null): boolean {
    const wantChat = cfg.chatId.trim();
    const wantUser = cfg.authorizedUserId.trim();
    if (wantChat !== '' && wantUser !== '' && chatId === wantChat && userId === wantUser) return true;
    const key = `${chatId ?? '?'}/${userId ?? '?'}`;
    if (!this.warned.has(key) && this.warned.size < MAX_WARNED) {
      this.warned.add(key);
      this.log('warn', `收到来自未授权会话 ${chatId ?? '未知'}（用户 ${userId ?? '未知'}）的消息，已忽略（只响应配置里的 Chat ID 与授权用户 ID）。`);
    }
    return false;
  }

  // ── Buttons ───────────────────────────────────────────────────────────────

  private async onCallback(cfg: TelegramConfig, query: TgCallbackQuery): Promise<void> {
    const chatId = idOf(query.message?.chat?.id);
    const userId = idOf(query.from?.id);
    const queryId = typeof query.id === 'string' ? query.id.slice(0, 128) : '';
    if (!this.authorized(cfg, chatId, userId) || !chatId) {
      if (queryId) await this.answerCallback(cfg, queryId, '未授权的会话。');
      return;
    }
    const parsed = parseCallbackData(typeof query.data === 'string' ? query.data : '');
    if (!parsed) {
      if (queryId) await this.answerCallback(cfg, queryId, '不认识这个按钮。');
      return;
    }
    if (!botActionAllowed(parsed.action, cfg)) {
      if (queryId) await this.answerCallback(cfg, queryId, '这个操作在手机上还没有开放。');
      await this.sendText(cfg, chatId, botPermissionRefusal(parsed.action));
      return;
    }
    if (this.queued >= MAX_QUEUED) {
      if (queryId) await this.answerCallback(cfg, queryId, '机器人正忙，前面的请求还没做完，请稍后再点。');
      return;
    }
    // Answer first (Telegram wants it within 10 s), then do the work and send the result as its own message.
    if (queryId) await this.answerCallback(cfg, queryId, BOT_ACTION_SPECS[parsed.action].touchesDevice ? '收到，正在操作模拟器，请稍等…' : '收到，正在处理…');
    this.enqueue(() => this.dispatchCommand(cfg, chatId, parsed.action, parsed.instanceIndex));
  }

  // ── Commands and menu button texts ───────────────────────────────────────

  private async onMessage(cfg: TelegramConfig, message: TgMessage): Promise<void> {
    const chatId = idOf(message.chat?.id);
    const userId = idOf(message.from?.id);
    if (!this.authorized(cfg, chatId, userId) || !chatId) return;
    const text = String(message.text ?? '').trim().slice(0, MAX_COMMAND_CHARS);
    if (text === '') return;

    // ① A menu button: Telegram sends the button's literal text.
    let command: BotCommand | null = commandOfButtonText(text);
    let index: number | null = null;
    if (!command) {
      // ② `/cmd [idx]` (groups append @botname: dropped).
      if (!text.startsWith('/')) return;
      const [rawCommand, arg] = text.slice(1).split(/\s+/);
      const name = (rawCommand ?? '').split('@')[0]!.toLowerCase().slice(0, 32);
      index = /^\d{1,4}$/.test(arg ?? '') ? Number(arg) : null;
      command = name === 'help' || name === 'start' ? name : actionOfCommand(name);
      if (!command) {
        this.enqueue(() => this.sendText(cfg, chatId, `不认识的命令「/${name}」。\n${BOT_HELP_TEXT}`, buildMenuKeyboard()));
        return;
      }
    }
    if (this.queued >= MAX_QUEUED) {
      await this.sendText(cfg, chatId, '机器人正忙，前面的请求还没做完，请稍后再发。');
      return;
    }
    const resolved = command;
    this.enqueue(() => this.dispatchCommand(cfg, chatId, resolved, index));
  }

  /**
   * help / start → the help text with the menu keyboard. An action whose switch is off → the explanation. A required
   * index that is missing → the instance picker (one instance runs directly). Everything else runs.
   */
  private async dispatchCommand(cfg: TelegramConfig, chatId: string, command: BotCommand, index: number | null): Promise<void> {
    if (command === 'help' || command === 'start') return this.sendText(cfg, chatId, BOT_HELP_TEXT, buildMenuKeyboard());
    const action: BotAction = command;
    if (!botActionAllowed(action, cfg)) return this.sendText(cfg, chatId, botPermissionRefusal(action));
    const spec = BOT_ACTION_SPECS[action];
    if (spec.instance === 'required' && index === null) {
      let list: Awaited<ReturnType<BotActionPort['listInstances']>>;
      try {
        list = await this.deps.actions.listInstances();
      } catch (error) {
        return this.sendText(cfg, chatId, `取实例列表失败：${this.clean(messageOf(error))}`);
      }
      if (list.length === 1) return this.run(cfg, chatId, action, list[0]!.index);
      if (list.length === 0) return this.sendText(cfg, chatId, '还没有任何可操作的实例。先到助手「设备与账号」页创建实例并绑定账号。');
      return this.sendText(cfg, chatId, `请选择账号（${spec.description}）：`, buildInstancePicker(action, list));
    }
    return this.run(cfg, chatId, action, index);
  }

  /** Run one action and send the result: photo first, then the text. A thrown reason goes back to the user. */
  private async run(cfg: TelegramConfig, chatId: string, action: BotAction, index: number | null): Promise<void> {
    let result: BotActionResult;
    try {
      result = await this.deps.actions.perform(action, index);
    } catch (error) {
      // The action layer never sees the token; scrubbed anyway as the last safety net.
      return this.sendText(cfg, chatId, `操作失败：${this.clean(messageOf(error))}`);
    }
    if (result.photo) await this.sendPhoto(cfg, chatId, result.photo);
    if (result.text.trim() !== '') {
      await this.sendText(cfg, chatId, result.text, result.keyboard ?? (result.showMenu ? buildMenuKeyboard() : undefined));
    } else if (result.showMenu) {
      await this.sendText(cfg, chatId, '菜单已刷新。', buildMenuKeyboard());
    }
  }

  private enqueue(work: () => Promise<void>): void {
    this.queued++;
    this.work = this.work
      .then(work)
      .catch((error: unknown) => this.log('warn', `机器人处理请求时出错：${this.clean(messageOf(error))}`))
      .then(() => { this.queued = Math.max(0, this.queued - 1); });
  }

  // ── Bot API ───────────────────────────────────────────────────────────────

  private async answerCallback(cfg: TelegramConfig, callbackQueryId: string, text: string): Promise<void> {
    try {
      await this.api(cfg, 'answerCallbackQuery', { callback_query_id: callbackQueryId, text: text.slice(0, 190) }, ACTION_HTTP_TIMEOUT_MS);
    } catch (error) {
      this.log('warn', `应答按钮失败：${this.clean(messageOf(error))}`);
    }
  }

  /** ★ Never a parse_mode. A failure is only logged. */
  private async sendText(cfg: TelegramConfig, chatId: string, text: string, replyMarkup?: ReplyMarkup): Promise<void> {
    try {
      await this.api(cfg, 'sendMessage', {
        chat_id: chatId,
        text: this.clean(text, cfg.botToken).slice(0, BOT_TEXT_MAX),
        disable_web_page_preview: true,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      }, ACTION_HTTP_TIMEOUT_MS);
    } catch (error) {
      this.log('warn', `回复消息失败：${this.clean(messageOf(error))}`);
    }
  }

  /**
   * A screenshot as a photo (multipart). ★ With FormData the content-type is never set by hand (fetch writes the
   * boundary). Over Telegram's 10 MB limit it becomes a text without a request; an upload failure still sends the
   * caption and the reason.
   */
  private async sendPhoto(cfg: TelegramConfig, chatId: string, photo: BotPhoto): Promise<void> {
    const caption = this.clean(photo.caption, cfg.botToken);
    const bytes = photo.jpeg.byteLength;
    if (bytes > TELEGRAM_PHOTO_MAX_BYTES) {
      const mb = (bytes / 1024 / 1024).toFixed(1);
      return this.sendText(cfg, chatId, `截图 ${mb} MB 超过 Telegram 10MB 限制，没有发送。\n${caption}`);
    }
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('caption', caption.slice(0, TELEGRAM_CAPTION_MAX));
    form.append('photo', new Blob([Uint8Array.from(photo.jpeg)], { type: 'image/jpeg' }), photo.filename);
    try {
      await this.api(cfg, 'sendPhoto', form, PHOTO_HTTP_TIMEOUT_MS);
    } catch (error) {
      const why = this.clean(messageOf(error));
      this.log('warn', `发送截图失败：${why}`);
      // The user still learns the scene and why the picture is missing.
      await this.sendText(cfg, chatId, `截图发送失败：${why}\n${caption}`);
    }
  }

  /**
   * One Bot API call. Throws `BotApiError` with a scrubbed message. JSON bodies set their content-type; FormData
   * never does. ★★ The only place that holds the token-bearing URL.
   */
  private async api(cfg: TelegramConfig, method: string, payload: Record<string, unknown> | FormData, timeoutMs: number): Promise<unknown> {
    const token = cfg.botToken.trim();
    if (!token) throw new BotApiError(method, null, `${method} 没有可用的 Bot Token`);
    const url = telegramApiUrl(token, method);
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = this.abort ? AbortSignal.any([timeout, this.abort.signal]) : timeout;
    const form = payload instanceof FormData;
    let status: number;
    let body: string;
    try {
      const response = await (this.deps.fetch ?? defaultTelegramFetch)(url, {
        method: 'POST', headers: form ? {} : { 'content-type': 'application/json' }, body: form ? payload : JSON.stringify(payload), signal,
      });
      status = response.status;
      body = (await response.text()).slice(0, MAX_BODY_CHARS);
    } catch (error) {
      // ★★ undici writes the whole URL (token included) into message and cause: scrub before anything else.
      throw new BotApiError(method, null, this.clean(`${method} 请求失败：${describeThrown(error)}`, token));
    }
    let parsed: TgResponse | null = null;
    try { parsed = JSON.parse(body) as TgResponse; } catch { parsed = null; }
    if (status >= 200 && status < 300 && parsed?.ok === true) return parsed.result;
    const description = typeof parsed?.description === 'string' ? parsed.description : body.slice(0, 200);
    throw new BotApiError(method, status, this.clean(`${method} 返回 HTTP ${status}：${description}`, token));
  }

  /** ★ Every text that leaves the channel: the token (and anything token-shaped) becomes ***. */
  private clean(text: string, token: string = this.lastToken): string {
    return scrubSecret(scrubSecret(text, token), this.lastToken).replace(TOKEN_IN_URL, 'bot***').replace(TOKEN_LIKE, '***');
  }

  private log(level: BotChannelLogLevel, message: string): void {
    const safe = this.clean(message);
    try { this.deps.log?.(level, safe); } catch { /* A log sink never breaks the bot. */ }
  }
}
