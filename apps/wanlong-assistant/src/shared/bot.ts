/**
 * The Telegram bot's public contract (port of wanlong-panel `src/shared/bot.ts`): the action enum, the menu buttons,
 * callback data, the action port and the pure renderers. Shared by the main process, the renderer (the in-app tester
 * card) and the tests. Pure: no Node, Electron or DOM imports.
 *
 * Layers (read this before the code):
 *   main/bot/telegram-bot.ts  channel: long polling → authorization (Chat ID AND authorized user id) → permission
 *                             switch → command / button text / callback → `BotActionPort.perform` → sendMessage /
 *                             sendPhoto
 *   main/bot/actions.ts       actions: Electron-free, ports injected. Device actions (shot / resources / relaunch) run
 *                             inside `EtaScheduler.exclusive()`; resume runs outside the lock.
 *   main/index.ts (bot)       wiring; the `bot` IPC domain runs the same port for the settings page tester.
 * The channel and the actions meet only at `BotActionPort`.
 *
 * ★★ Credentials: no type in this file carries the bot token. `BotActionResult` holds only what goes back to the user.
 * ★ Permissions (DECISIONS A.3): every action is either `read` (「允许手机查看状态与截图」) or `control`
 *   (「允许手机远程操作」); the channel refuses an action whose switch is off. Both default to off.
 */
import { formatCst, formatCstClock } from './time';
import { TELEGRAM_CAPTION_MAX, TELEGRAM_PHOTO_MAX_BYTES } from './alerts';

export { TELEGRAM_CAPTION_MAX, TELEGRAM_PHOTO_MAX_BYTES };

// ══════════════════════════════════════════════════════════════════════════
// 1. Actions
// ══════════════════════════════════════════════════════════════════════════

/**
 * What the bot can do. ★ To add one: a value here → one BOT_ACTION_SPECS row (the compiler insists) → implement it in
 * main/bot/actions.ts. The channel needs no change.
 */
export const BOT_ACTIONS = [
  /** Queue / marches / auto switch / pause reason (index null = every instance). */
  'status',
  /** Switch the instance's automatic schedule back on (clears an alert pause first). */
  'resume',
  /** Clear the kicked / network dialogs, relaunch the game, then resume. */
  'relaunch',
  /** Switch the instance's automatic schedule off by hand. */
  'pause',
  /** Accounts: bound instance, enabled, running, auto, pause reason, last panel read. */
  'accounts',
  /** One screenshot (★ takes the instance lock). */
  'shot',
  /** Read the in-game 「道具 → 资源统计」 table (★ takes the instance lock, taps, restores the main screen). */
  'resources',
  /** Today's statistics (Beijing day). */
  'stats',
  /** Send the reply keyboard (menu) again. */
  'menu',
] as const;

export type BotAction = (typeof BOT_ACTIONS)[number];

/** Commands the channel answers itself (never reach `BotActionPort`). */
export type BotLocalCommand = 'help' | 'start';
export type BotCommand = BotAction | BotLocalCommand;

export function isBotAction(value: unknown): value is BotAction {
  return typeof value === 'string' && (BOT_ACTIONS as readonly string[]).includes(value);
}

/** What an action needs as instance number. */
export type BotInstanceNeed =
  /** Required: without one the channel first sends an instance picker (`buildInstancePicker`). */
  | 'required'
  /** Optional: none = every instance. */
  | 'optional'
  | 'none';

/**
 * Which switch allows the action from the phone. `read` = 「允许手机查看状态与截图」 (`remoteReadOnlyEnabled`);
 * `control` = 「允许手机远程操作」 (`remoteControlEnabled`): anything that changes the schedule or taps the game;
 * `any` = whenever the bot runs at all (the menu keyboard).
 */
export type BotPermission = 'read' | 'control' | 'any';

export interface BotActionSpec {
  readonly action: BotAction;
  /** Slash command without `/` (setMyCommands and text parsing). */
  readonly command: string;
  /** Chinese description in setMyCommands (Telegram: 3–256 characters). */
  readonly description: string;
  /** Callback data prefix (`<prefix>:<idx>`, at most 64 bytes). */
  readonly callbackPrefix: string;
  readonly instance: BotInstanceNeed;
  /** Drives the emulator (screenshot, taps). ★ Such actions MUST run inside `EtaScheduler.exclusive()`. */
  readonly touchesDevice: boolean;
  /** Allowed while the emulator is not running. */
  readonly worksOffline: boolean;
  readonly permission: BotPermission;
}

export const BOT_ACTION_SPECS = {
  status: {
    action: 'status', command: 'status', description: '查看实例队列与调度状态', callbackPrefix: 'status',
    instance: 'optional', touchesDevice: false, worksOffline: true, permission: 'read',
  },
  resume: {
    action: 'resume', command: 'resume', description: '恢复实例的自动调度', callbackPrefix: 'resume',
    instance: 'required', touchesDevice: false, worksOffline: true, permission: 'control',
  },
  relaunch: {
    action: 'relaunch', command: 'relaunch', description: '重启游戏并恢复自动调度', callbackPrefix: 'relaunch',
    instance: 'required', touchesDevice: true, worksOffline: false, permission: 'control',
  },
  pause: {
    action: 'pause', command: 'pause', description: '手动关掉实例的自动调度', callbackPrefix: 'pause',
    instance: 'required', touchesDevice: false, worksOffline: true, permission: 'control',
  },
  accounts: {
    action: 'accounts', command: 'accounts', description: '查看账号列表与各实例状态', callbackPrefix: 'accounts',
    instance: 'none', touchesDevice: false, worksOffline: true, permission: 'read',
  },
  shot: {
    action: 'shot', command: 'shot', description: '截一张指定账号的画面发过来', callbackPrefix: 'shot',
    instance: 'required', touchesDevice: true, worksOffline: false, permission: 'read',
  },
  resources: {
    action: 'resources', command: 'resources', description: '读游戏里的资源统计表', callbackPrefix: 'res',
    instance: 'required', touchesDevice: true, worksOffline: false, permission: 'control',
  },
  stats: {
    action: 'stats', command: 'stats', description: '今日采集统计（北京时间）', callbackPrefix: 'stats',
    instance: 'none', touchesDevice: false, worksOffline: true, permission: 'read',
  },
  menu: {
    action: 'menu', command: 'menu', description: '显示菜单按钮', callbackPrefix: 'menu',
    instance: 'none', touchesDevice: false, worksOffline: true, permission: 'any',
  },
} as const satisfies Record<BotAction, BotActionSpec>;

export function botActionSpec(action: BotAction): BotActionSpec {
  return BOT_ACTION_SPECS[action];
}

/** setMyCommands list (actions + help), in the order of the phone's 「/」 menu. */
export const BOT_COMMAND_LIST: ReadonlyArray<{ command: string; description: string }> = [
  ...BOT_ACTIONS.map((action) => ({ command: BOT_ACTION_SPECS[action].command, description: BOT_ACTION_SPECS[action].description })),
  { command: 'help', description: '查看可用命令' },
];

/** Slash command name → action (case and surrounding spaces ignored); null when unknown. */
export function actionOfCommand(command: string): BotAction | null {
  const c = command.trim().toLowerCase();
  for (const action of BOT_ACTIONS) if (BOT_ACTION_SPECS[action].command === c) return action;
  return null;
}

/** The settings switch behind each permission (the wording of the settings card). */
export const BOT_PERMISSION_SWITCH: Readonly<Record<Exclude<BotPermission, 'any'>, string>> = {
  read: '允许手机查看状态与截图',
  control: '允许手机远程操作',
};

/** Whether the phone may run the action under these switches. */
export function botActionAllowed(action: BotAction, switches: { remoteReadOnlyEnabled: boolean; remoteControlEnabled: boolean }): boolean {
  const permission: BotPermission = BOT_ACTION_SPECS[action].permission;
  if (permission === 'read') return switches.remoteReadOnlyEnabled;
  if (permission === 'control') return switches.remoteControlEnabled;
  return switches.remoteReadOnlyEnabled || switches.remoteControlEnabled;
}

/** What the phone gets when the action's switch is off. */
export function botPermissionRefusal(action: BotAction): string {
  const spec = BOT_ACTION_SPECS[action];
  const permission: BotPermission = spec.permission;
  const needed = permission === 'any' ? '任一个机器人开关' : `「${BOT_PERMISSION_SWITCH[permission]}」`;
  return `「${spec.description}」在手机上还没有开放：请在电脑上的万龙助手「设置 → 通知与推送 → 手机机器人」里打开${needed}后再试。`;
}

// ══════════════════════════════════════════════════════════════════════════
// 2. Menu (persistent ReplyKeyboardMarkup)
// ══════════════════════════════════════════════════════════════════════════

/**
 * ★★ The reply keyboard's button literals. Pressing one sends exactly this text, and `commandOfButtonText()` maps it
 * back: never change a single character, or keyboards already on phones stop working.
 */
export const BOT_MENU_BUTTON = {
  status: '📊 状态',
  accounts: '👥 账号列表',
  shot: '📷 截图',
  resources: '💰 资源',
  stats: '📈 今日统计',
  help: '❓ 帮助',
} as const;

export type BotMenuKey = keyof typeof BOT_MENU_BUTTON;

/** Two rows of three. */
export const BOT_MENU_LAYOUT: ReadonlyArray<ReadonlyArray<BotMenuKey>> = [
  ['status', 'accounts', 'shot'],
  ['resources', 'stats', 'help'],
];

/** Button → command (help is the channel's own command, the rest are actions). */
export const BOT_MENU_COMMAND: Readonly<Record<BotMenuKey, BotCommand>> = {
  status: 'status',
  accounts: 'accounts',
  shot: 'shot',
  resources: 'resources',
  stats: 'stats',
  help: 'help',
};

/** Telegram ReplyKeyboardMarkup (the fields used). */
export interface BotReplyKeyboard {
  keyboard: Array<Array<{ text: string }>>;
  resize_keyboard: true;
  is_persistent: true;
  input_field_placeholder?: string;
}

export function buildMenuKeyboard(): BotReplyKeyboard {
  return {
    keyboard: BOT_MENU_LAYOUT.map((row) => row.map((key) => ({ text: BOT_MENU_BUTTON[key] }))),
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: '点下面的按钮，或发 /help',
  };
}

/** The command of a menu button text (surrounding spaces ignored, otherwise exact); null for anything else. */
export function commandOfButtonText(text: string): BotCommand | null {
  const t = text.trim();
  for (const key of Object.keys(BOT_MENU_BUTTON) as BotMenuKey[]) {
    if (BOT_MENU_BUTTON[key] === t) return BOT_MENU_COMMAND[key];
  }
  return null;
}

/** /help and /start (sent by the channel itself). Commands marked 「远程操作」 need that switch. */
export const BOT_HELP_TEXT = [
  '万龙助手 · 可用命令：',
  '/status [实例号] —— 查看队列、在途队伍、自动调度与暂停原因',
  '/accounts —— 账号列表：绑定实例 / 启用 / 运行 / 自动调度 / 暂停原因 / 上次读面板',
  '/shot [实例号] —— 截一张画面发过来，方便人工看看是否正常',
  '/stats —— 今日（北京时间）采集统计',
  '/resources [实例号] —— 读游戏「道具 → 资源统计」表（精度 0.1亿，只作对账；会操作游戏，需开启远程操作）',
  '/resume <实例号> —— 恢复该实例的自动调度（需开启远程操作）',
  '/relaunch <实例号> —— 点掉顶号/断线弹窗、重启游戏，然后恢复（需开启远程操作）',
  '/pause <实例号> —— 手动关掉该实例的自动调度（需开启远程操作）',
  '/menu —— 重新显示底部菜单按钮',
  '/help —— 看这份说明',
  '底部菜单按钮、告警消息下面的按钮和这些命令是一回事。查看类命令需要在助手里打开「允许手机查看状态与截图」，操作类需要「允许手机远程操作」。',
].join('\n');

// ══════════════════════════════════════════════════════════════════════════
// 3. Inline buttons and callback data
// ══════════════════════════════════════════════════════════════════════════

/** Telegram inline keyboard (callback buttons only); same shape as `AlertInlineKeyboard`. */
export interface BotInlineKeyboard {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

/** Telegram's callback_data limit in bytes. */
export const BOT_CALLBACK_MAX_BYTES = 64;

/** `shot:0` / `res:2` / `status:all`. */
export function buildCallbackData(action: BotAction, instanceIndex: number | null): string {
  const prefix = BOT_ACTION_SPECS[action].callbackPrefix;
  return instanceIndex === null ? `${prefix}:all` : `${prefix}:${instanceIndex}`;
}

/**
 * Parse callback data; unknown prefix or invalid index → null.
 *   'resume:0' → resume / 0;  'res:3' → resources / 3;  'status:all' → status / null;
 *   'status' or 'status:' → status / null (older buttons without an index stay valid).
 * The index is only checked for shape here (≤ 4 digits); the action layer checks that the instance exists.
 */
export function parseCallbackData(data: string): { action: BotAction; instanceIndex: number | null } | null {
  const text = String(data ?? '');
  if (new TextEncoder().encode(text).byteLength > BOT_CALLBACK_MAX_BYTES) return null;
  const [prefix, idxRaw, extra] = text.split(':');
  if (extra !== undefined) return null;
  const action = BOT_ACTIONS.find((item) => BOT_ACTION_SPECS[item].callbackPrefix === prefix);
  if (!action) return null;
  if (idxRaw === undefined || idxRaw === '' || idxRaw === 'all') return { action, instanceIndex: null };
  if (!/^\d{1,4}$/.test(idxRaw)) return null;
  return { action, instanceIndex: Number(idxRaw) };
}

/** One instance the bot can act on (`listInstances`). */
export interface BotInstanceRef {
  index: number;
  /** Display name of the bound account; null when unbound. */
  name: string | null;
}

/** 「先选账号再执行」: one row per instance, `实例 0 · 主号`. */
export function buildInstancePicker(action: BotAction, instances: readonly BotInstanceRef[]): BotInlineKeyboard {
  return {
    inline_keyboard: instances.map((item) => [{
      text: item.name ? `实例 ${item.index} · ${item.name}` : `实例 ${item.index}`,
      callback_data: buildCallbackData(action, item.index),
    }]),
  };
}

// ══════════════════════════════════════════════════════════════════════════
// 4. The action port (the only boundary between channel and actions)
// ══════════════════════════════════════════════════════════════════════════

/** A screenshot sent as a photo. */
export interface BotPhoto {
  /** JPEG bytes, already ≤ BOT_PHOTO_MAX_WIDTH wide at about BOT_PHOTO_JPEG_QUALITY. */
  jpeg: Uint8Array;
  /** Chinese caption (≤ TELEGRAM_CAPTION_MAX). */
  caption: string;
  /** Multipart filename, e.g. `inst0-20260909-212233.jpg`. */
  filename: string;
}

/** One action's answer. The channel sends the photo first (with its caption), then the text when not empty. */
export interface BotActionResult {
  /** Plain text (★ never Markdown). May be empty when only a photo is sent. */
  text: string;
  photo?: BotPhoto;
  /** Inline buttons under the text message. */
  keyboard?: BotInlineKeyboard;
  /** Send the menu reply keyboard with this message (the menu action). */
  showMenu?: boolean;
}

/**
 * The action executor; the channel only knows this interface.
 * ★ `perform` may throw a Chinese Error (with a `code`); the channel answers 「操作失败：<message>」. The action layer
 *   never sees the token, so its messages cannot contain it (the channel scrubs anyway).
 * ★ A `required` action given null throws 「请先选择账号/实例。」 (the channel normally sends a picker first).
 */
export interface BotActionPort {
  perform(action: BotAction, instanceIndex: number | null): Promise<BotActionResult>;
  /** Instances the bot can act on: bound accounts first; with none bound, every existing non-base instance. */
  listInstances(): Promise<BotInstanceRef[]>;
}

// ── Image and text limits ─────────────────────────────────────────────────────

/** Screenshots are scaled to at most this width before sending (2560 → 1280, about 150 KB). */
export const BOT_PHOTO_MAX_WIDTH = 1280;
export const BOT_PHOTO_JPEG_QUALITY = 70;
/** Telegram's text limit is 4096 characters; replies are cut at 4000. */
export const BOT_TEXT_MAX = 4000;

// ══════════════════════════════════════════════════════════════════════════
// 5. Renderers (account list, shot caption) — times are always Beijing time
// ══════════════════════════════════════════════════════════════════════════

/** One row of the account list (built by the action layer from accounts + instances + scheduler + alerts). */
export interface BotAccountRow {
  accountName: string;
  enabled: boolean;
  /** Bound instance; null when unbound. */
  instanceIndex: number | null;
  /** The binding points at an AVD that was deleted or recreated (a new AVD at the same index inherits nothing). */
  bindingStale: boolean;
  /** The account's login check is done; null when unbound. */
  loginReady: boolean | null;
  /** AVD name; null when unbound / not found. */
  instanceName: string | null;
  /** AVD status (running / stopped / …); null when unbound / not found. */
  instanceState: string | null;
  /** Automatic schedule switch; null when unbound. */
  auto: boolean | null;
  /** Chinese reason while an alert keeps it paused; null otherwise. */
  pausedReason: string | null;
  /** Last troop panel read; null when never read. */
  lastSampledAt: number | null;
  lastSampleOk: boolean | null;
  queueUsed: number | null;
  queueTotal: number | null;
}

/** AVD status in words (the emulator's states, not the original MuMu ones). */
export function describeInstanceState(state: string | null): string {
  if (state === null) return '';
  const words: Record<string, string> = {
    running: '运行中', stopped: '未运行', starting: '启动中', booting: '系统启动中', stopping: '正在停止',
    provisioning: '准备中', error: '异常',
  };
  return `（${words[state] ?? state}）`;
}

/**
 * The account list (plain text).
 *
 *   【账号列表】共 2 个（北京时间 21:22:33）
 *   1. 主号 · 实例 0「Pixel-0」（运行中）
 *      启用 ✅｜自动调度 开｜队列 5/5｜上次读面板 21:20:11
 *   2. 小号 · 未绑定实例
 *      启用 ❌
 */
export function renderAccountList(rows: readonly BotAccountRow[], now: number = Date.now()): string {
  if (rows.length === 0) {
    return `【账号列表】还没有任何账号。到助手「设备与账号 → 账号管理」页新建并绑定实例后再来看。（北京时间 ${formatCstClock(now)}）`;
  }
  const lines: string[] = [`【账号列表】共 ${rows.length} 个（北京时间 ${formatCstClock(now)}）`];
  rows.forEach((row, i) => {
    let head: string;
    if (row.instanceIndex === null) head = `${i + 1}. ${row.accountName} · 未绑定实例`;
    else if (row.bindingStale) head = `${i + 1}. ${row.accountName} · 实例 ${row.instanceIndex}（绑定已失效：实例已被删除或重建，请重新绑定并登录）`;
    else head = `${i + 1}. ${row.accountName} · 实例 ${row.instanceIndex}${row.instanceName ? `「${row.instanceName}」` : ''}${describeInstanceState(row.instanceState)}`;
    lines.push(head);
    const parts: string[] = [`启用 ${row.enabled ? '✅' : '❌'}`];
    if (row.instanceIndex !== null && !row.bindingStale) {
      if (row.loginReady === false) parts.push('登录待验证');
      parts.push(`自动调度 ${row.auto === null ? '未知' : row.auto ? '开' : '关'}`);
      if (row.queueUsed != null || row.queueTotal != null) parts.push(`队列 ${row.queueUsed ?? '?'}/${row.queueTotal ?? '?'}`);
      parts.push(row.lastSampledAt
        ? `上次读面板 ${formatCstClock(row.lastSampledAt)}${row.lastSampleOk === false ? '（失败）' : ''}`
        : '还没读过面板');
    }
    lines.push(`   ${parts.join('｜')}`);
    if (row.pausedReason) lines.push(`   ⛔ 已暂停：${row.pausedReason}`);
  });
  return lines.join('\n');
}

/** What a screenshot caption says about the scene. */
export interface BotShotContext {
  instanceIndex: number;
  accountName: string | null;
  at: number;
  /** Foreground package; null when unreadable. */
  foreground: string | null;
  /** Game process alive; null when not checked. */
  gameRunning: boolean | null;
  /** Turns the foreground package into 「游戏」. */
  gamePackage: string;
}

/**
 * The photo caption (≤ TELEGRAM_CAPTION_MAX).
 *   实例 0「主号」截图
 *   北京时间 2026-09-09 21:22:33
 *   前台：游戏（com.lilithgames.samo.android.cn）｜游戏进程：存活
 * ★ A foreground that is not the game is shown, not refused (「★ 不是游戏：pkg」): that is exactly what a user
 *   wants to see after a crash to the desktop.
 */
export function renderShotCaption(ctx: BotShotContext): string {
  const who = ctx.accountName ? `「${ctx.accountName}」` : '';
  const fg = ctx.foreground === null
    ? '未知'
    : ctx.foreground === ctx.gamePackage ? `游戏（${ctx.foreground}）` : `★ 不是游戏：${ctx.foreground}`;
  const running = ctx.gameRunning === null ? '未查' : ctx.gameRunning ? '存活' : '★ 不在';
  return [`实例 ${ctx.instanceIndex}${who}截图`, `北京时间 ${formatCst(ctx.at)}`, `前台：${fg}｜游戏进程：${running}`]
    .join('\n').slice(0, TELEGRAM_CAPTION_MAX);
}

/** `inst0-20260909-212233.jpg` (only [A-Za-z0-9_.-]; Beijing time). */
export function shotFilename(instanceIndex: number, at: number): string {
  const s = formatCst(at).replace(/[-: ]/g, '');
  return `inst${instanceIndex}-${s.slice(0, 8)}-${s.slice(8)}.jpg`;
}

/** Whether a photo fits Telegram's upload limit. */
export function photoFits(photo: Pick<BotPhoto, 'jpeg'>): boolean {
  return photo.jpeg.byteLength <= TELEGRAM_PHOTO_MAX_BYTES;
}

// ══════════════════════════════════════════════════════════════════════════
// 6. Bot status (settings page)
// ══════════════════════════════════════════════════════════════════════════

/** Whether the bot polls, and which switches it serves (the settings card and the in-app tester show it). */
export interface BotStatusView {
  running: boolean;
  /** 「允许手机查看状态与截图」 */
  readEnabled: boolean;
  /** 「允许手机远程操作」 */
  controlEnabled: boolean;
  /** Why it is not running or why polling fails right now (Chinese, token-free); null when fine. */
  problem: string | null;
  /** When `running` last changed. */
  since: number | null;
}
