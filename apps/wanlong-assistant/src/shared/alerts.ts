/**
 * Alerts, automatic pauses and outbound notifications — the contract shared by the main process, the renderer and
 * the tests. Ported from wanlong-panel `src/shared/alerts.ts`. Pure: no Node, Electron or DOM imports.
 *
 * Why this layer exists (the user's words: 「设备被顶号了就暂停任务并且推送到 telegram」):
 *   layer 1 (generic, needs no special template): the gather flow's unknown-screen recovery ladder exhausted N times
 *   in a row, N cycles in a row failed, or the troop panel could not be read N times → pause the instance's automatic
 *   schedule, keep a scene screenshot and notify. This covers kicked, banned, maintenance, forced update, network.
 *   layer 2 (precise, template-based): the reserved template ids below (kicked dialog, login screen, maintenance and
 *   update notices). ★ A missing template degrades silently to layer 1 — never an error, never an abort.
 *
 * ★ Pause = switch the instance's automatic schedule off (`EtaScheduler.setAuto(i, false)`), record reason / time /
 *   screenshot, show a red banner with 「恢复」. Idempotent: an instance already paused is not paused or pushed twice.
 * ★★ Credentials: the Telegram bot token lives only in the main process (safeStorage ciphertext on disk). The
 *   renderer only ever gets `AlertsConfigView` (no `botToken` key at all). Any text that may leave the process goes
 *   through `scrubSecret()` first.
 * ★ Defaults have exactly one authority: `defaultAlertsConfig()` (no `600` / `2` literals anywhere else).
 */
import { formatCst } from './time';

// ══════════════════════════════════════════════════════════════════════════
// 1. Alert types — the single table
// ══════════════════════════════════════════════════════════════════════════

/**
 * Alert types. Adding one = one entry here plus one row in ALERT_SPECS (a missing row fails to compile); the
 * settings checkbox list, the push text and the pause banner all read the table.
 */
export const ALERT_TYPES = [
  /** Generic fallback (recovery ladder exhausted, maintenance / update notice, game update or AI risk needs a human). */
  'needsAttention',
  /** Layer 2 hit: the kicked dialog or the login screen. */
  'suspectedKicked',
  /** N gather cycles in a row failed. */
  'consecutiveFailures',
  /** The emulator or the game is gone: instance not running, adb unreachable, game process exited. */
  'deviceOffline',
  /** A readiness gate refused the instance (account not checked, login running, base instance): paused, not a failure. */
  'schedulePaused',
  /** Frozen emulator restarted automatically (freeze auto-restart on). Warning, no pause. */
  'emulatorFrozen',
  /** Frozen emulator detected while freeze auto-restart is off: alert only. Warning, no pause. */
  'suspectedFreeze',
  /** No troop dispatched for a long time (resources, not a broken state). Warning, no pause. */
  'dispatchStalled',
  /** A paused instance was resumed. Info. */
  'instanceResumed',
  /** Synthetic event of the settings page's test push. Never subscribable, never pauses. */
  'test',
] as const;

export type AlertType = (typeof ALERT_TYPES)[number];

export type AlertSeverity = 'critical' | 'warning' | 'info';

export const ALERT_SEVERITY_TEXT: Record<AlertSeverity, string> = {
  critical: '需要人工介入',
  warning: '警告',
  info: '信息',
};

/** UI tone names only (the colours come from CSS design tokens). */
export const ALERT_SEVERITY_TONE: Record<AlertSeverity, 'danger' | 'warning' | 'info'> = {
  critical: 'danger',
  warning: 'warning',
  info: 'info',
};

export interface AlertSpec {
  readonly type: AlertType;
  /** Chinese title: first line of the push and the label everywhere in the UI. */
  readonly title: string;
  readonly severity: AlertSeverity;
  /** ★ Whether this event pauses the instance's automatic schedule. */
  readonly pauses: boolean;
  /** Subscribed by default (the user can untick it in settings). */
  readonly notifyByDefault: boolean;
  /** What it means (tooltip / settings explanation). */
  readonly summary: string;
  /** What the user should do (the 「处置」 line of the push). */
  readonly advice: string;
}

/**
 * `as const satisfies Record<AlertType, AlertSpec>`: a missing type fails to compile, and the literal `pauses` values
 * stay available so `PausingAlertType` is derived instead of hand-copied.
 */
export const ALERT_SPECS = {
  needsAttention: {
    type: 'needsAttention',
    title: '需要人工介入',
    severity: 'critical',
    pauses: true,
    notifyByDefault: true,
    summary:
      '通用兜底判定：采集的「未知界面恢复阶梯」已经用尽（关弹窗 → BACK 并取消退出框 → 冷启动游戏都没能回到世界地图），' +
      '或者画面上出现了维护 / 强制更新公告、游戏资源更新需要人处理、AI 判断某个确认弹窗的点击有风险。' +
      '顶号、封号、维护公告、版本更新、网络断开都会走到这里。',
    advice:
      '已暂停该实例的自动调度。请打开实时画面看一眼当前是什么界面（是否被顶号、是否弹了维护/更新公告），' +
      '处理完成后回来点「恢复」。',
  },
  suspectedKicked: {
    type: 'suspectedKicked',
    title: '疑似被顶号',
    severity: 'critical',
    pauses: true,
    notifyByDefault: true,
    summary:
      '精确识别命中了「账号在其他设备登录」提示框或登录界面。' +
      '★ 相应模板（tpl_dlg_kicked / tpl_login_screen）不在模板集里时，这类事件永远不会产生，会自动降级成「需要人工介入」。',
    advice:
      '已暂停该实例的自动调度。账号很可能在别的设备上登录了，请先确认是不是自己在别处操作；' +
      '确认安全后重新登录游戏，再回来点「恢复」。',
  },
  consecutiveFailures: {
    type: 'consecutiveFailures',
    title: '连续失败熔断',
    severity: 'critical',
    pauses: true,
    notifyByDefault: true,
    summary: '同一实例连续多轮采集 / 派遣都失败，继续重试只会在坏状态上反复操作游戏。',
    advice: '已暂停该实例的自动调度。请查看运行日志里最近几轮的失败原因，处理后回来点「恢复」。',
  },
  deviceOffline: {
    type: 'deviceOffline',
    title: '模拟器或游戏掉线',
    severity: 'critical',
    pauses: true,
    notifyByDefault: true,
    summary:
      '模拟器实例不在运行、adb 连不上，或游戏进程已经退出、前台长期不是万龙觉醒。这时候任何点击都会落到别的应用上。' +
      '（画面纹丝不动被判定为「卡死」且开了「卡死自动重启」时，会先自动重启模拟器；重启失败或短时间内反复卡死才会走到这里。）',
    advice: '已暂停该实例的自动调度。请确认模拟器是否被关掉或崩溃，在「模拟器实例」页重新启动实例并把游戏拉起来后点「恢复」。',
  },
  schedulePaused: {
    type: 'schedulePaused',
    title: '自动调度已暂停',
    severity: 'warning',
    pauses: true,
    notifyByDefault: true,
    summary:
      '绑定的账号还没完成登录检查、正在登录、实例是基础实例或已被替换 —— 这些不是故障，不计为失败，' +
      '但在处理好之前不能自动操作这个实例。',
    advice: '到「账号管理」完成登录检查（或结束登录向导），然后回来点「恢复」。',
  },
  emulatorFrozen: {
    type: 'emulatorFrozen',
    title: '模拟器卡死已自动重启',
    severity: 'warning',
    pauses: false,
    notifyByDefault: true,
    summary:
      '画面长时间纹丝不动（连续多张截图一模一样）或截图一直超时，但模拟器进程还在 —— 判定为卡死。' +
      '开启「卡死自动重启」后，助手会强制重启该实例（冷启动）、重新连接 adb、用 monkey 拉起游戏并等主界面出来，然后继续自动调度。' +
      '重启失败、或一小时内反复卡死超过次数上限，才会转成「模拟器或游戏掉线」并暂停。',
    advice:
      '无需处理，自动调度会自己接着跑。如果同一个实例频繁卡死，检查一下模拟器的 CPU / 内存分配，' +
      '或把「多久不动判卡死」调大一些。',
  },
  suspectedFreeze: {
    type: 'suspectedFreeze',
    title: '疑似模拟器卡死',
    severity: 'warning',
    pauses: false,
    notifyByDefault: true,
    summary:
      '画面长时间纹丝不动或截图一直超时，但模拟器进程还在 —— 疑似卡死。「卡死自动重启」没有开启，所以只告警、不重启；' +
      '之后采样连续失败时会按「模拟器或游戏掉线」暂停。',
    advice: '请在「模拟器实例」页手动重启该实例，或在「设置 → 通知与推送」里打开「卡死自动重启」。',
  },
  dispatchStalled: {
    type: 'dispatchStalled',
    title: '长时间派不出队',
    severity: 'warning',
    pauses: false,
    notifyByDefault: true,
    summary: '游戏本身是好的，但因为兵力不够、行军队列一直占满或搜不到合格资源点，已经很久没有成功派出过采集队。',
    advice: '不影响运行，自动调度照常继续。要提高产出可以调低搜索下限或放宽储量要求。',
  },
  instanceResumed: {
    type: 'instanceResumed',
    title: '实例已恢复',
    severity: 'info',
    pauses: false,
    notifyByDefault: true,
    summary: '被暂停的实例已经重新开启自动调度。',
    advice: '无需处理。',
  },
  test: {
    type: 'test',
    title: '测试推送',
    severity: 'info',
    pauses: false,
    notifyByDefault: true,
    summary: '设置页「测试推送」按钮产生的合成事件，用来验证推送配置是否通。',
    advice: '收到这条就说明 Bot Token 与 Chat ID 都是对的。',
  },
} as const satisfies Record<AlertType, AlertSpec>;

/** Pausing types, derived from the table at the type level (not a second hand-written list). */
export type PausingAlertType = {
  [K in AlertType]: (typeof ALERT_SPECS)[K]['pauses'] extends true ? K : never
}[AlertType];

export function alertSpec(type: AlertType): AlertSpec {
  return ALERT_SPECS[type];
}

/** Narrows the type to `PausingAlertType` when true. */
export function pausesInstance(type: AlertType): type is PausingAlertType {
  return ALERT_SPECS[type].pauses;
}

export function isAlertType(value: unknown): value is AlertType {
  return typeof value === 'string' && (ALERT_TYPES as readonly string[]).includes(value);
}

/** Types the user may subscribe to (the synthetic `test` is excluded). */
export const SUBSCRIBABLE_ALERT_TYPES: readonly AlertType[] = ALERT_TYPES.filter((type) => type !== 'test');

// ══════════════════════════════════════════════════════════════════════════
// 2. Events
// ══════════════════════════════════════════════════════════════════════════

/** Structured detail. Scalars only so it survives structuredClone over IPC. */
export type AlertDetail = Record<string, string | number | boolean | null>;

/** One alert. Times are absolute milliseconds; Beijing time only when displayed. */
export interface AlertEvent {
  /** `alert_<base36>` from `makeAlertEvent`. */
  id: string;
  type: AlertType;
  /** Always `ALERT_SPECS[type].severity`. */
  severity: AlertSeverity;
  /** Emulator instance index (-1 for the synthetic test push). */
  instanceIndex: number;
  accountId: string | null;
  /** Bound account's display name; null falls back to 「未绑定账号」 in texts. */
  accountName: string | null;
  at: number;
  /** One Chinese sentence explaining the verdict (no stack traces or raw codes). */
  reason: string;
  /** Scene screenshot relative to the data directory (`automation/wanlong/shots/…`), or null. */
  shotPath: string | null;
  detail?: AlertDetail;
  /** ★ Throttle / dedupe key = `${instanceIndex}:${type}`. */
  dedupeKey: string;
}

export interface AlertEventInput {
  type: AlertType;
  instanceIndex: number;
  reason: string;
  accountId?: string | null;
  accountName?: string | null;
  shotPath?: string | null;
  detail?: AlertDetail;
  /** Defaults to Date.now() (tests pass it). */
  at?: number;
}

export function alertDedupeKey(instanceIndex: number, type: AlertType): string {
  return `${instanceIndex}:${type}`;
}

let idCounter = 0;

export function makeAlertId(now = Date.now()): string {
  idCounter = (idCounter + 1) % 1_296;
  return `alert_${now.toString(36)}${idCounter.toString(36).padStart(2, '0')}${Math.floor(Math.random() * 46_656).toString(36).padStart(3, '0')}`;
}

/** The only event constructor (hand-written literals forget the dedupe key). */
export function makeAlertEvent(input: AlertEventInput): AlertEvent {
  const at = input.at ?? Date.now();
  return {
    id: makeAlertId(at),
    type: input.type,
    severity: ALERT_SPECS[input.type].severity,
    instanceIndex: input.instanceIndex,
    accountId: input.accountId ?? null,
    accountName: input.accountName ?? null,
    at,
    reason: input.reason,
    shotPath: input.shotPath ?? null,
    ...(input.detail ? { detail: input.detail } : {}),
    dedupeKey: alertDedupeKey(input.instanceIndex, input.type),
  };
}

// ══════════════════════════════════════════════════════════════════════════
// 3. Rendering (plain text; Beijing time)
// ══════════════════════════════════════════════════════════════════════════

/**
 * The push text. ★ Plain text, never a parse_mode: account names and reasons may contain `_ * [ ]`, and a parse_mode
 * would make Telegram answer 400 exactly when an alert matters (the test push works, the real one fails).
 */
export function renderAlertText(e: AlertEvent): string {
  const spec = ALERT_SPECS[e.type];
  const who = e.accountName ? e.accountName : '未绑定账号';
  const tag = ALERT_SEVERITY_TEXT[spec.severity];
  // A title that equals its level (「需要人工介入」) is not written twice.
  const head = spec.title === tag ? `【${spec.title}】` : `【${tag}】${spec.title}`;
  const lines = [head, `实例 #${e.instanceIndex}（${who}）`, `原因：${e.reason}`, `时间：${formatCst(e.at)}（北京时间）`];
  const detailLine = renderAlertDetail(e.detail);
  if (detailLine) lines.push(`现场：${detailLine}`);
  if (e.shotPath) lines.push(`截图：${e.shotPath}`);
  lines.push(`处置：${spec.advice}`);
  return lines.join('\n');
}

/** One line for logs and lists. */
export function renderAlertSummary(e: Pick<AlertEvent, 'instanceIndex' | 'type' | 'reason'>): string {
  return `实例 #${e.instanceIndex}｜${ALERT_SPECS[e.type].title}｜${e.reason}`;
}

export function renderAlertDetail(detail: AlertDetail | undefined): string {
  if (!detail) return '';
  const parts: string[] = [];
  for (const [key, value] of Object.entries(detail)) {
    if (value === null || value === '') continue;
    parts.push(`${key}=${String(value)}`);
  }
  return parts.join(' ');
}

// ══════════════════════════════════════════════════════════════════════════
// 4. Notification channels (provider-neutral)
// ══════════════════════════════════════════════════════════════════════════

/** Channels: Telegram (original) and the macOS notification centre (this app's addition). */
export const NOTIFIER_IDS = ['telegram', 'local'] as const;
export type NotifierId = (typeof NOTIFIER_IDS)[number];

export const NOTIFIER_LABEL: Record<NotifierId, string> = {
  telegram: 'Telegram',
  local: '本机通知',
};

/** Failure classes; ★ each has its own Chinese guidance. */
export type NotifyFailureKind =
  | 'disabled'
  | 'notConfigured'
  | 'unsubscribed'
  | 'throttled'
  | 'badToken'
  | 'badChat'
  | 'network'
  | 'timeout'
  | 'rateLimited'
  | 'serverError'
  | 'unknown';

export const NOTIFY_FAILURE_TEXT: Record<NotifyFailureKind, string> = {
  disabled: '推送开关没打开',
  notConfigured: '推送尚未配置完整',
  unsubscribed: '这类事件没有被订阅',
  throttled: '冷却期内已去重',
  badToken: 'Bot Token 无效',
  badChat: 'Chat ID 不对',
  network: '网络不通',
  timeout: '请求超时',
  rateLimited: '被限流',
  serverError: '对方服务器出错',
  unknown: '未知错误',
};

/** One send attempt series. ★ Never contains the token (built from scrubbed text only). */
export interface NotifyResult {
  ok: boolean;
  channel: NotifierId;
  failure: NotifyFailureKind | null;
  /** Chinese explanation, also on success. */
  message: string;
  /** Requests actually sent (0 when a gate stopped it). */
  attempts: number;
  elapsedMs: number;
  at: number;
  /** Seconds Telegram asked to wait (429), else null. */
  retryAfterSec: number | null;
}

export function skippedNotifyResult(channel: NotifierId, failure: NotifyFailureKind, message: string, at = Date.now()): NotifyResult {
  return { ok: false, channel, failure, message, attempts: 0, elapsedMs: 0, at, retryAfterSec: null };
}

// ── Throttle ────────────────────────────────────────────────────────────────

export interface ThrottleEntry {
  /** Last time a message really went out. */
  lastSentAt: number;
  /** Events suppressed since; announced with the next allowed send. */
  suppressedCount: number;
  lastSuppressedAt: number | null;
}

export interface ThrottleDecision {
  allow: boolean;
  reason: string;
  suppressedCount: number;
  nextAllowedAt: number | null;
}

/**
 * Cooldown per key (`${channel}|${instance}:${type}`). The cooldown is read through a getter, so a settings change
 * applies at once. `snapshot()` / `restore()` persist it: a restart must not re-spam an instance still broken.
 */
export class AlertThrottle {
  private readonly entries = new Map<string, ThrottleEntry>();

  constructor(private readonly cooldownSecondsOf: () => number) {}

  check(key: string, now = Date.now()): ThrottleDecision {
    const cooldownMs = Math.max(0, this.cooldownSecondsOf()) * 1000;
    const entry = this.entries.get(key);
    if (!entry || cooldownMs === 0) {
      return { allow: true, reason: '首次触发或未设冷却', suppressedCount: entry?.suppressedCount ?? 0, nextAllowedAt: null };
    }
    const nextAllowedAt = entry.lastSentAt + cooldownMs;
    if (now >= nextAllowedAt) return { allow: true, reason: '冷却已过', suppressedCount: entry.suppressedCount, nextAllowedAt: null };
    return {
      allow: false,
      reason: `同一实例同一原因在冷却期内（还需 ${Math.ceil((nextAllowedAt - now) / 1000)}s）`,
      suppressedCount: entry.suppressedCount,
      nextAllowedAt,
    };
  }

  /** After a real send: restart the window and clear the suppressed count. */
  markSent(key: string, now = Date.now()): void {
    this.entries.set(key, { lastSentAt: now, suppressedCount: 0, lastSuppressedAt: null });
  }

  /** After a suppression: count it (announced with the next allowed send). */
  markSuppressed(key: string, now = Date.now()): void {
    const entry = this.entries.get(key);
    if (!entry) { this.entries.set(key, { lastSentAt: 0, suppressedCount: 1, lastSuppressedAt: now }); return; }
    this.entries.set(key, { ...entry, suppressedCount: entry.suppressedCount + 1, lastSuppressedAt: now });
  }

  reset(key?: string): void {
    if (key === undefined) this.entries.clear();
    else this.entries.delete(key);
  }

  /** Clear every key of one instance (the 「恢复」 button), whatever the channel prefix. */
  resetInstance(instanceIndex: number): void {
    const suffix = `|${instanceIndex}:`;
    const prefix = `${instanceIndex}:`;
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(prefix) || key.includes(suffix)) this.entries.delete(key);
    }
  }

  snapshot(): Record<string, ThrottleEntry> {
    return Object.fromEntries([...this.entries].map(([key, value]) => [key, { ...value }]));
  }

  restore(snap: Record<string, ThrottleEntry> | undefined | null): void {
    this.entries.clear();
    if (!snap || typeof snap !== 'object') return;
    for (const [key, value] of Object.entries(snap)) {
      if (!key || !value || typeof value !== 'object') continue;
      this.entries.set(key, {
        lastSentAt: finiteOr(value.lastSentAt, 0),
        suppressedCount: Math.max(0, Math.trunc(finiteOr(value.suppressedCount, 0))),
        lastSuppressedAt: typeof value.lastSuppressedAt === 'number' && Number.isFinite(value.lastSuppressedAt) ? value.lastSuppressedAt : null,
      });
    }
  }
}

/** 「冷却期内还发生过 N 次同类事件」, empty for 0. Appended per send, never written into the event. */
export function renderSuppressedNote(suppressedCount: number): string {
  return suppressedCount > 0 ? `（冷却期内还发生过 ${suppressedCount} 次同类事件）` : '';
}

// ══════════════════════════════════════════════════════════════════════════
// 5. Configuration
// ══════════════════════════════════════════════════════════════════════════

/** Thresholds of the generic layer and the freeze watchdog. */
export interface AlertDetectConfig {
  /** Master switch: off = record and notify only, never pause. */
  autoPauseEnabled: boolean;
  /** N failed gather cycles in a row → consecutiveFailures. */
  cycleFailThreshold: number;
  /** N exhausted recovery ladders (step G0) in a row → needsAttention; lower on purpose (a much stronger signal). */
  recoveryFailThreshold: number;
  /** N failed troop-panel samples in a row → deviceOffline. */
  sampleFailThreshold: number;
  /** No dispatch for this many minutes → dispatchStalled (warning, no pause). */
  stalledMinutes: number;
  /** Try the layer-2 templates (kicked / login / maintenance / update). Missing templates degrade silently. */
  kickedProbeEnabled: boolean;
  /**
   * Freeze auto-restart (DECISIONS A.3: explicit opt-in, default off). Off: a freeze only raises 「疑似模拟器卡死」, and
   * sample failures still end in the offline pause.
   */
  freezeRestartEnabled: boolean;
  /** Minutes of an unchanged picture (or failing captures) that count as frozen. */
  freezeMinutes: number;
  /** Automatic restarts allowed per window; beyond it the instance is paused as offline. */
  freezeRestartLimit: number;
  /** The window of the previous limit (minutes). */
  freezeRestartWindowMin: number;
}

/** Telegram settings as the main process holds them. ★ `botToken` is plaintext in memory only (ciphertext on disk). */
export interface TelegramConfig {
  enabled: boolean;
  botToken: string;
  /** Private chats are positive, groups / channels negative (e.g. -1001234567890). */
  chatId: string;
  /** Cooldown per instance + type (seconds), shared by every channel. */
  cooldownSeconds: number;
  /** Retries after the first attempt. */
  retryCount: number;
  timeoutMs: number;
  /** Types pushed (also the local channel's subscription). */
  subscribedTypes: AlertType[];
  /**
   * Remote control buttons / commands (resume, relaunch, pause, resources) — DECISIONS A.3: opt-in, default off.
   * The bot answers only the configured chat AND the authorized user id.
   */
  remoteControlEnabled: boolean;
  /** Read-only bot actions (status, screenshot) — opt-in, default off. */
  remoteReadOnlyEnabled: boolean;
  /** Telegram user id allowed to use the bot (both switches above need it). */
  authorizedUserId: string;
}

/** The macOS notification centre (this app's addition to the original). */
export interface LocalNotifyConfig {
  enabled: boolean;
}

export interface AlertsConfig {
  version: 1;
  detect: AlertDetectConfig;
  telegram: TelegramConfig;
  local: LocalNotifyConfig;
}

/**
 * Value ranges, identical to the clamps in `normalizeAlertsConfig`. ★ These are bounds, not defaults: the settings UI
 * takes its min / max from here and its initial values from `defaultAlertsConfig()`.
 */
export const ALERT_RANGE = {
  cycleFailThreshold: [1, 20],
  recoveryFailThreshold: [1, 20],
  sampleFailThreshold: [1, 20],
  stalledMinutes: [5, 1440],
  freezeMinutes: [2, 60],
  freezeRestartLimit: [1, 10],
  freezeRestartWindowMin: [10, 1440],
  cooldownSeconds: [0, 86_400],
  retryCount: [0, 5],
  timeoutMs: [2_000, 120_000],
} as const satisfies Record<string, readonly [number, number]>;

/**
 * ★★★ The only authority for defaults. Main process, renderer and tests import it; no second literal copy.
 * Differences from the original panel (DECISIONS A.3): freeze auto-restart and remote control start off.
 */
export function defaultAlertsConfig(): AlertsConfig {
  return {
    version: 1,
    detect: {
      autoPauseEnabled: true,
      cycleFailThreshold: 3,
      recoveryFailThreshold: 2,
      sampleFailThreshold: 3,
      stalledMinutes: 120,
      kickedProbeEnabled: true,
      freezeRestartEnabled: false,
      freezeMinutes: 5,
      freezeRestartLimit: 3,
      freezeRestartWindowMin: 60,
    },
    telegram: {
      enabled: false,
      botToken: '',
      chatId: '',
      cooldownSeconds: 600,
      retryCount: 2,
      timeoutMs: 15_000,
      subscribedTypes: SUBSCRIBABLE_ALERT_TYPES.filter((type) => ALERT_SPECS[type].notifyByDefault),
      remoteControlEnabled: false,
      remoteReadOnlyEnabled: false,
      authorizedUserId: '',
    },
    local: { enabled: false },
  };
}

/** The detect half only (other modules never get the Telegram half). */
export function defaultAlertDetectConfig(): AlertDetectConfig {
  return defaultAlertsConfig().detect;
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function intIn(value: unknown, fallback: number, [lo, hi]: readonly [number, number]): number {
  return Math.min(hi, Math.max(lo, Math.round(finiteOr(value, fallback))));
}

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function strOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function recordOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Subscriptions in declaration order, without duplicates or `test`. */
export function normalizeSubscriptions(types: readonly unknown[]): AlertType[] {
  return SUBSCRIBABLE_ALERT_TYPES.filter((type) => types.includes(type));
}

/**
 * Per-field tolerant normalization: one bad field falls back alone, never the whole config (a corrupt file, a half
 * patch or a newer version with extra fields all go through here).
 */
export function normalizeAlertsConfig(raw: unknown): AlertsConfig {
  const base = defaultAlertsConfig();
  const o = recordOf(raw);
  const d = recordOf(o['detect']);
  const t = recordOf(o['telegram']);
  const l = recordOf(o['local']);
  const subs = Array.isArray(t['subscribedTypes']) ? [...t['subscribedTypes'] as unknown[]] : [...base.telegram.subscribedTypes];
  // One-time migration kept from the original: a file saved before freeze alerts existed has no freezeRestartEnabled
  // key; its subscription list lacks the newer types because they did not exist, not because the user unticked them.
  if (Array.isArray(t['subscribedTypes']) && d['freezeRestartEnabled'] === undefined) {
    for (const type of SUBSCRIBABLE_ALERT_TYPES) if (ALERT_SPECS[type].notifyByDefault && !subs.includes(type)) subs.push(type);
  }
  return {
    version: 1,
    detect: {
      autoPauseEnabled: boolOr(d['autoPauseEnabled'], base.detect.autoPauseEnabled),
      cycleFailThreshold: intIn(d['cycleFailThreshold'], base.detect.cycleFailThreshold, ALERT_RANGE.cycleFailThreshold),
      recoveryFailThreshold: intIn(d['recoveryFailThreshold'], base.detect.recoveryFailThreshold, ALERT_RANGE.recoveryFailThreshold),
      sampleFailThreshold: intIn(d['sampleFailThreshold'], base.detect.sampleFailThreshold, ALERT_RANGE.sampleFailThreshold),
      stalledMinutes: intIn(d['stalledMinutes'], base.detect.stalledMinutes, ALERT_RANGE.stalledMinutes),
      kickedProbeEnabled: boolOr(d['kickedProbeEnabled'], base.detect.kickedProbeEnabled),
      freezeRestartEnabled: boolOr(d['freezeRestartEnabled'], base.detect.freezeRestartEnabled),
      freezeMinutes: intIn(d['freezeMinutes'], base.detect.freezeMinutes, ALERT_RANGE.freezeMinutes),
      freezeRestartLimit: intIn(d['freezeRestartLimit'], base.detect.freezeRestartLimit, ALERT_RANGE.freezeRestartLimit),
      freezeRestartWindowMin: intIn(d['freezeRestartWindowMin'], base.detect.freezeRestartWindowMin, ALERT_RANGE.freezeRestartWindowMin),
    },
    telegram: {
      enabled: boolOr(t['enabled'], base.telegram.enabled),
      botToken: strOr(t['botToken'], base.telegram.botToken).trim(),
      chatId: strOr(t['chatId'], base.telegram.chatId).trim().slice(0, 40),
      cooldownSeconds: intIn(t['cooldownSeconds'], base.telegram.cooldownSeconds, ALERT_RANGE.cooldownSeconds),
      retryCount: intIn(t['retryCount'], base.telegram.retryCount, ALERT_RANGE.retryCount),
      timeoutMs: intIn(t['timeoutMs'], base.telegram.timeoutMs, ALERT_RANGE.timeoutMs),
      subscribedTypes: normalizeSubscriptions(subs),
      remoteControlEnabled: boolOr(t['remoteControlEnabled'], base.telegram.remoteControlEnabled),
      remoteReadOnlyEnabled: boolOr(t['remoteReadOnlyEnabled'], base.telegram.remoteReadOnlyEnabled),
      authorizedUserId: strOr(t['authorizedUserId'], base.telegram.authorizedUserId).trim().slice(0, 32),
    },
    local: { enabled: boolOr(l['enabled'], base.local.enabled) },
  };
}

// ── Views (no token across IPC) ─────────────────────────────────────────────

export interface TelegramConfigView extends Omit<TelegramConfig, 'botToken'> {
  /** 「••••••••」 when a token is saved, empty otherwise (this app never shows any character of it). */
  botTokenMasked: string;
  botTokenSet: boolean;
}

export interface AlertsConfigView extends Omit<AlertsConfig, 'telegram'> {
  telegram: TelegramConfigView;
  /**
   * Main only: a bot in this process handles the alert buttons' callbacks. While false, 「允许手机远程操作」 attaches no
   * buttons (the bot module registers its handler through `NotifyHub.setRemoteControlHandler`). Absent = false.
   */
  remoteControlAvailable?: boolean;
}

/** Fully masked (the app's safeStorage hardening: not even the last four characters leave the main process). */
export function maskToken(token: string): string {
  return (token ?? '').trim() === '' ? '' : '••••••••';
}

/** ★ The only way a config reaches the renderer. */
export function toAlertsConfigView(cfg: AlertsConfig): AlertsConfigView {
  const { botToken, ...rest } = cfg.telegram;
  return {
    version: cfg.version,
    detect: { ...cfg.detect },
    telegram: { ...rest, subscribedTypes: [...rest.subscribedTypes], botTokenMasked: maskToken(botToken), botTokenSet: botToken.trim() !== '' },
    local: { ...cfg.local },
  };
}

/**
 * A settings patch. ★ botToken has three states: absent = keep, non-empty = replace, '' = clear (the explicit
 * 「清除 Token」 button). Clearing it also switches every Telegram function off.
 */
export interface AlertsConfigPatch {
  detect?: Partial<AlertDetectConfig>;
  telegram?: Partial<Omit<TelegramConfig, 'botToken'>> & { botToken?: string };
  local?: Partial<LocalNotifyConfig>;
}

const PATCH_KEYS: Record<keyof AlertsConfigPatch, readonly string[]> = {
  detect: Object.keys(defaultAlertsConfig().detect),
  telegram: Object.keys(defaultAlertsConfig().telegram),
  local: Object.keys(defaultAlertsConfig().local),
};

const RANGED = ALERT_RANGE as Record<string, readonly [number, number]>;

/** Save-time validation (Chinese, one line per problem): unknown keys, wrong types, out-of-range numbers. */
export function alertsPatchProblems(patch: unknown): string[] {
  const problems: string[] = [];
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return ['告警设置无效'];
  for (const [section, value] of Object.entries(patch)) {
    const keys = PATCH_KEYS[section as keyof AlertsConfigPatch];
    if (!keys) { problems.push(`未知的设置分组：${section}`); continue; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) { problems.push(`${section} 设置无效`); continue; }
    const defaults = recordOf((defaultAlertsConfig() as unknown as Record<string, unknown>)[section]);
    for (const [key, field] of Object.entries(value as Record<string, unknown>)) {
      if (!keys.includes(key)) { problems.push(`未知的设置项：${section}.${key}`); continue; }
      const expected = defaults[key];
      if (key === 'subscribedTypes') {
        if (!Array.isArray(field) || field.some((type) => !isAlertType(type) || type === 'test')) problems.push('推送事件订阅无效');
      } else if (typeof expected === 'boolean') {
        if (typeof field !== 'boolean') problems.push(`${FIELD_LABEL[key] ?? key}开关无效`);
      } else if (typeof expected === 'number') {
        const range = RANGED[key];
        if (typeof field !== 'number' || !Number.isInteger(field) || (range && (field < range[0] || field > range[1]))) {
          problems.push(`${FIELD_LABEL[key] ?? key}应为 ${range ? `${range[0]}–${range[1]} 之间的` : ''}整数`);
        }
      } else if (typeof field !== 'string' || field.length > 200) {
        problems.push(`${FIELD_LABEL[key] ?? key}无效`);
      }
    }
  }
  return problems;
}

/** Chinese names of the fields, for messages and the settings form. */
export const FIELD_LABEL: Record<string, string> = {
  autoPauseEnabled: '判定为异常时自动暂停',
  cycleFailThreshold: '连续几轮采集失败判异常',
  recoveryFailThreshold: '恢复阶梯连续几次用尽判异常',
  sampleFailThreshold: '连续几次采样失败判掉线',
  stalledMinutes: '多久派不出队算停摆（分钟）',
  kickedProbeEnabled: '精确识别「被顶号」',
  freezeRestartEnabled: '卡死自动重启',
  freezeMinutes: '多久不动判卡死（分钟）',
  freezeRestartLimit: '窗口内最多自动重启几次',
  freezeRestartWindowMin: '统计窗口（分钟）',
  enabled: '推送',
  botToken: 'Bot Token',
  chatId: 'Chat ID',
  cooldownSeconds: '同类事件冷却（秒）',
  retryCount: '失败重试次数',
  timeoutMs: '单次请求超时（毫秒）',
  remoteControlEnabled: '手机远程操作',
  remoteReadOnlyEnabled: '手机查看状态与截图',
  authorizedUserId: '授权用户 ID',
};

/** Merge a patch (three-state token) and normalize. */
export function mergeAlertsConfig(base: AlertsConfig, patch: AlertsConfigPatch | undefined): AlertsConfig {
  const p = patch ?? {};
  const merged = normalizeAlertsConfig({
    version: 1,
    detect: { ...base.detect, ...(p.detect ?? {}) },
    telegram: {
      ...base.telegram,
      ...(p.telegram ?? {}),
      botToken: p.telegram?.botToken === undefined ? base.telegram.botToken : p.telegram.botToken,
    },
    local: { ...base.local, ...(p.local ?? {}) },
  });
  if (p.telegram?.botToken === '') {
    // The credential is shared: clearing it switches every dependent Telegram function off.
    merged.telegram.enabled = false;
    merged.telegram.remoteControlEnabled = false;
    merged.telegram.remoteReadOnlyEnabled = false;
  }
  return merged;
}

// ── Preflight ────────────────────────────────────────────────────────────────

/** `<numeric id>:<35-ish chars>`; shape only, whether it works needs the test push. */
export const TOKEN_SHAPE = /^\d{5,}:[A-Za-z0-9_-]{20,}$/;
/** Positive (private chat) or negative (group / channel) integers. */
export const CHAT_ID_SHAPE = /^-?\d{1,32}$/;
export const USER_ID_SHAPE = /^\d{1,32}$/;

/** Guided Chinese problems (empty = fine). ★ Never contains the token itself. */
export function validateTelegramConfig(cfg: Pick<TelegramConfig, 'botToken' | 'chatId'>): string[] {
  const problems: string[] = [];
  const token = cfg.botToken.trim();
  const chat = cfg.chatId.trim();
  if (token === '') {
    problems.push('还没有填 Bot Token。到 Telegram 里找 @BotFather 发 /newbot 建一个机器人就能拿到。');
  } else if (!TOKEN_SHAPE.test(token)) {
    problems.push(
      'Bot Token 的格式不对：应该形如「123456789:AAE…」（冒号前是一串数字，冒号后是一长串字母数字）。' +
      '常见错误是把整行「HTTP API: xxx」都粘进来了。',
    );
  }
  if (chat === '') {
    problems.push('还没有填 Chat ID。给你的机器人随便发一条消息，然后找 @userinfobot 或 @getidsbot 要一下你的数字 id。');
  } else if (!CHAT_ID_SHAPE.test(chat)) {
    problems.push('Chat ID 只能是数字（群和频道是负数，形如 -1001234567890）。@username 这种写法这里不支持。');
  }
  return problems;
}

/** Problems of the remote bot switches (they additionally need the authorized user id). */
export function validateRemoteBotConfig(cfg: Pick<TelegramConfig, 'botToken' | 'chatId' | 'authorizedUserId'>): string[] {
  const problems = validateTelegramConfig(cfg);
  if (!USER_ID_SHAPE.test(cfg.authorizedUserId.trim())) {
    problems.push('还没有填授权用户 ID（只有这个 Telegram 用户能操作机器人）。给 @userinfobot 发一条消息就能拿到自己的数字 id。');
  }
  return problems;
}

export function isTelegramReady(cfg: TelegramConfig): boolean {
  return cfg.enabled && validateTelegramConfig(cfg).length === 0;
}

/** `test` always passes the subscription gate. */
export function isSubscribed(cfg: Pick<TelegramConfig, 'subscribedTypes'>, type: AlertType): boolean {
  return type === 'test' || cfg.subscribedTypes.includes(type);
}

// ── Credential scrubbing ─────────────────────────────────────────────────────

/**
 * ★★ Replace every occurrence of the secret with `***` (undici puts the whole token-bearing URL into error messages
 * and causes). Secrets shorter than 8 characters are left alone so an empty or tiny value never masks a whole text.
 */
export function scrubSecret(text: string, secret: string): string {
  const s = (secret ?? '').trim();
  if (s === '' || s.length < 8) return text;
  return text.split(s).join('***');
}

/** A loggable copy of the config (token masked). */
export function redactAlertsConfig(cfg: AlertsConfig): Record<string, unknown> {
  const { botToken, ...telegram } = cfg.telegram;
  return {
    version: cfg.version,
    detect: { ...cfg.detect },
    telegram: { ...telegram, botToken: maskToken(botToken), subscribedTypes: [...telegram.subscribedTypes] },
    local: { ...cfg.local },
  };
}

// ── Telegram texts (one copy of the Chinese guidance) ─────────────────────────

export const TELEGRAM_API_HOST = 'https://api.telegram.org';
/** Telegram's hard limit for uploaded photos. */
export const TELEGRAM_PHOTO_MAX_BYTES = 10 * 1024 * 1024;
export const TELEGRAM_CAPTION_MAX = 1024;
/** Messages longer than this are cut (Telegram's limit is 4096 characters). */
export const TELEGRAM_TEXT_MAX = 3_900;

/** ★★ The returned URL contains the token: never log it or put it into an error. */
export function telegramApiUrl(botToken: string, method: string): string {
  return `${TELEGRAM_API_HOST}/bot${botToken}/${method}`;
}

export interface TelegramFailureInput {
  /** HTTP status; null when nothing was received. */
  status: number | null;
  description: string | null;
  retryAfterSec: number | null;
  /** Transport error text (★ scrubbed before it gets here). */
  transportError: string | null;
}

/** Classification + guidance. ★ Bad token, bad chat, network and rate limit each get a different sentence. */
export function describeTelegramFailure(input: TelegramFailureInput): { kind: NotifyFailureKind; message: string } {
  const desc = (input.description ?? '').toLowerCase();
  if (input.status === null) {
    const raw = input.transportError ?? '';
    if (/abort|timeout|timed out/i.test(raw)) {
      return {
        kind: 'timeout',
        message: '请求超时，没能连上 api.telegram.org。国内网络通常需要给系统配代理，或者确认你的网络能访问 Telegram；也可以把「单次请求超时」调大一些。',
      };
    }
    return {
      kind: 'network',
      message:
        '网络不通，连不上 api.telegram.org。请确认这台机器能访问 Telegram（国内直连通常是不行的，需要代理），也检查一下 DNS 与防火墙。' +
        (raw ? `底层报错：${raw}` : ''),
    };
  }
  if (input.status === 401 || input.status === 404) {
    return {
      kind: 'badToken',
      message:
        `Bot Token 无效（Telegram 返回 ${input.status}${input.status === 404 ? '，说明这个 token 对应的机器人不存在' : ' Unauthorized'}）。` +
        '请回到 @BotFather 用 /mybots 选中你的机器人、点 API Token 重新复制一次，注意只复制冒号两边那一整串，' +
        '不要带上「HTTP API:」这几个字，也不要有多余空格或换行。',
    };
  }
  if (input.status === 429) {
    const wait = input.retryAfterSec ?? 0;
    return {
      kind: 'rateLimited',
      message: `被 Telegram 限流了（429）${wait > 0 ? `，要求等 ${wait} 秒再试` : ''}。这通常是短时间内推得太多，把「同类事件冷却」调大一些即可。`,
    };
  }
  if (input.status === 403) {
    return {
      kind: 'badChat',
      message:
        '机器人没有权限往这个会话发消息（403）。私聊的话，请先在 Telegram 里主动给你的机器人发一条消息（哪怕只发一个 /start），' +
        '机器人才被允许回你；群里的话，请把机器人拉进群。',
    };
  }
  if (input.status === 400) {
    if (desc.includes('chat not found') || desc.includes('chat_id')) {
      return {
        kind: 'badChat',
        message:
          'Chat ID 不对（Telegram 返回 chat not found）。私聊的 id 是正数，群 / 频道是负数（形如 -1001234567890）。' +
          '可以给 @userinfobot 发条消息拿到自己的数字 id。',
      };
    }
    if (desc.includes("can't parse entities") || desc.includes('parse')) {
      return {
        kind: 'unknown',
        message: '消息内容里有 Telegram 解析不了的字符。本助手发送时不应该开 parse_mode，出现这个提示说明有人给请求加了 parse_mode，请去掉。',
      };
    }
    return { kind: 'badChat', message: `Telegram 拒绝了这条请求（400）：${input.description ?? '没有给出原因'}。请检查 Chat ID。` };
  }
  if (input.status >= 500) {
    return { kind: 'serverError', message: `Telegram 服务器暂时出错（${input.status}）。稍后会自动重试，不用管。` };
  }
  return { kind: 'unknown', message: `推送失败（HTTP ${input.status}）：${input.description ?? '没有给出原因'}。` };
}

/** Whether a retry can help (a wrong token or chat never becomes right by retrying). */
export function isRetriableFailure(kind: NotifyFailureKind): boolean {
  return kind === 'network' || kind === 'timeout' || kind === 'serverError' || kind === 'rateLimited';
}

// ── Remote-control buttons (callback data shared with the bot module) ─────────

/** Telegram inline keyboard (callback buttons only). */
export interface AlertInlineKeyboard {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

/** Actions reachable from an alert message. Prefixes match the original `src/shared/bot.ts` callback format. */
export const ALERT_CALLBACK_ACTIONS = ['resume', 'relaunch', 'status'] as const;
export type AlertCallbackAction = (typeof ALERT_CALLBACK_ACTIONS)[number];

/** `resume:0` / `relaunch:3` / `status:1` (≤ 64 bytes, Telegram's limit). The bot module parses the same format. */
export function alertCallbackData(action: AlertCallbackAction, instanceIndex: number): string {
  return `${action}:${instanceIndex}`;
}

/** Parse `resume:0`; null for anything else (unknown prefix, missing or non-numeric index). */
export function parseAlertCallbackData(data: string): { action: AlertCallbackAction; instanceIndex: number } | null {
  const match = /^(resume|relaunch|status):(\d{1,2})$/.exec(String(data ?? ''));
  if (!match) return null;
  const instanceIndex = Number(match[2]);
  return instanceIndex <= 63 ? { action: match[1] as AlertCallbackAction, instanceIndex } : null;
}

/**
 * Buttons under a pushed alert, only for a real instance and only the ones the phone may use: 「恢复」 and 「重启游戏」
 * need remote control, 「查看状态」 needs the read-only switch (the bot refuses the rest, a dead button would only
 * confuse). Pausing events get resume / relaunch / status, `instanceResumed` gets status; the test push gets none.
 * `remoteReadOnlyEnabled` absent = follows `remoteControlEnabled` (the original's single switch).
 */
export function buildAlertKeyboard(
  event: Pick<AlertEvent, 'type' | 'instanceIndex'>,
  cfg: Pick<TelegramConfig, 'remoteControlEnabled'> & Partial<Pick<TelegramConfig, 'remoteReadOnlyEnabled'>>,
): AlertInlineKeyboard | undefined {
  if (event.instanceIndex < 0) return undefined;
  const control = cfg.remoteControlEnabled;
  const read = cfg.remoteReadOnlyEnabled ?? cfg.remoteControlEnabled;
  const i = event.instanceIndex;
  const status = [{ text: '📊 查看状态', callback_data: alertCallbackData('status', i) }];
  const rows: AlertInlineKeyboard['inline_keyboard'] = [];
  if (pausesInstance(event.type)) {
    if (control) {
      rows.push([{ text: '▶️ 恢复自动调度', callback_data: alertCallbackData('resume', i) }]);
      rows.push([{ text: '🔁 重启游戏并恢复', callback_data: alertCallbackData('relaunch', i) }]);
    }
    if (read) rows.push(status);
  } else if (event.type === 'instanceResumed' && read) {
    rows.push(status);
  }
  return rows.length > 0 ? { inline_keyboard: rows } : undefined;
}

// ══════════════════════════════════════════════════════════════════════════
// 6. Layer 2: reserved templates
// ══════════════════════════════════════════════════════════════════════════

/**
 * ★ Reserved template ids. The repository ships no template images: the user authors them in the template library
 * (or imports the old panel's set). A missing id means「no conclusion」and degrades silently to layer 1. Never add
 * them to the gather flow's critical or optional template lists.
 */
export const RESERVED_TEMPLATE = {
  kickedDialog: 'tpl_dlg_kicked',
  loginScreen: 'tpl_login_screen',
  maintenanceDialog: 'tpl_dlg_maintenance',
  updateDialog: 'tpl_dlg_update',
} as const;

export type ReservedTemplateId = (typeof RESERVED_TEMPLATE)[keyof typeof RESERVED_TEMPLATE];

/** A layer-2 hit. Null (no conclusion) is the normal answer when templates are missing. */
export interface KickedProbeHit {
  type: PausingAlertType;
  reason: string;
  detail: AlertDetail;
}

// ══════════════════════════════════════════════════════════════════════════
// 7. Instance pause state
// ══════════════════════════════════════════════════════════════════════════

/**
 * One instance's pause. ★ The red state is `paused === true`, never `!auto`: a user switching auto off by hand is a
 * normal action and must not turn red.
 */
export interface InstancePauseState {
  instanceIndex: number;
  paused: boolean;
  type: AlertType | null;
  severity: AlertSeverity | null;
  reason: string | null;
  pausedAt: number | null;
  /** Relative to the data directory; fetched with `alertScreenshot`. */
  shotPath: string | null;
  /** `ALERT_SPECS[type].advice`. */
  advice: string | null;
  detail?: AlertDetail;
  /** Whether the pause was pushed; null = no channel configured (or still sending). */
  notified: boolean | null;
  /** ★ Scrubbed reason of a failed push. */
  notifyError: string | null;
  eventId: string | null;
  /** Account shown in the banner (from the event). */
  accountName?: string | null;
}

export function emptyPauseState(instanceIndex: number): InstancePauseState {
  return {
    instanceIndex, paused: false, type: null, severity: null, reason: null, pausedAt: null, shotPath: null,
    advice: null, notified: null, notifyError: null, eventId: null,
  };
}

export function pauseStateFromEvent(e: AlertEvent, notify: { notified: boolean | null; notifyError: string | null }): InstancePauseState {
  return {
    instanceIndex: e.instanceIndex,
    paused: true,
    type: e.type,
    severity: e.severity,
    reason: e.reason,
    pausedAt: e.at,
    shotPath: e.shotPath,
    advice: ALERT_SPECS[e.type].advice,
    ...(e.detail ? { detail: e.detail } : {}),
    notified: notify.notified,
    notifyError: notify.notifyError,
    eventId: e.id,
    accountName: e.accountName,
  };
}

/**
 * The 「阶段」 detail of a 「需要人工介入」 pause raised for GAME_UPDATE_REQUIRED / AI_RISK_BLOCKED (original alert detail):
 * which chain stopped the automation. One copy for the alerts module, the AI executor and the renderer.
 */
export const ATTENTION_STAGE = { aiRisk: 'AI 操作风险评估', gameUpdate: '游戏资源更新' } as const;

export function attentionStageOf(code: string): string {
  return code === 'AI_RISK_BLOCKED' ? ATTENTION_STAGE.aiRisk : ATTENTION_STAGE.gameUpdate;
}

/** The AI's risk gate (or its verdict) paused this instance: the 「AI 处理」 page has the record behind it. */
export function isAiAttentionPause(pause: Pick<InstancePauseState, 'paused' | 'type' | 'detail'> | null | undefined): boolean {
  return pause?.paused === true && pause.type === 'needsAttention' && pause.detail?.['阶段'] === ATTENTION_STAGE.aiRisk;
}

/**
 * Short title of a pause for status lines and diagnostics: the alert type's title, plus the stage of a needs-attention
 * pause (「需要人工介入（AI 操作风险评估）」), so an AI or update pause is told apart from a generic one at a glance.
 */
export function pauseTitle(pause: Pick<InstancePauseState, 'paused' | 'type' | 'detail'>): string {
  if (!pause.paused) return '';
  const title = pause.type ? ALERT_SPECS[pause.type].title : '已暂停';
  const stage = pause.type === 'needsAttention' ? pause.detail?.['阶段'] : undefined;
  return typeof stage === 'string' && stage ? `${title}（${stage}）` : title;
}

// ── History ────────────────────────────────────────────────────────────────

export interface AlertRecord {
  event: AlertEvent;
  /** Per-channel results; empty when no channel is configured. */
  results: NotifyResult[];
  /** Nothing was sent at all (disabled / unsubscribed / throttled). */
  suppressed: boolean;
  /** This event actually paused the instance (false when it was already paused: idempotent). */
  pausedNow: boolean;
}

export const ALERT_HISTORY_LIMIT = 100;

/** 「已推送」 / 「冷却期内已去重」 / 「未推送：…」 for lists. */
export function deliveryText(record: Pick<AlertRecord, 'results' | 'suppressed'>): string {
  if (record.results.length === 0) return '未配置推送';
  if (record.results.some((result) => result.ok)) {
    return `已推送（${record.results.filter((result) => result.ok).map((result) => NOTIFIER_LABEL[result.channel]).join('、')}）`;
  }
  if (record.suppressed) {
    const throttled = record.results.some((result) => result.failure === 'throttled');
    return throttled ? '冷却期内已去重，未推送' : `未推送：${record.results[0]?.message ?? '没有可用通道'}`;
  }
  return `未推送：${record.results[0]?.message ?? '没有可用通道'}`;
}

// ══════════════════════════════════════════════════════════════════════════
// 8. Daily ledger kinds (statistics)
// ══════════════════════════════════════════════════════════════════════════

/**
 * Kinds written by the earlier monitoring / insights code; still readable in old day files, never produced again
 * (`runFailed` was a per-run row: a failed run is now only a cycle fact, counted as `failed` in the day).
 */
export const LEGACY_LEDGER_KINDS = ['runFailed', 'circuitBroken', 'recoveryExhausted', 'maintenanceRequired', 'updateRequired'] as const;
export type LegacyLedgerKind = (typeof LEGACY_LEDGER_KINDS)[number];

/** Alert kinds the daily ledger accepts: every real alert type (not info) plus the legacy ones. */
export type LedgerAlertKind = Exclude<AlertType, 'instanceResumed' | 'test'> | LegacyLedgerKind;

export const LEDGER_ALERT_KINDS: readonly LedgerAlertKind[] = [
  ...ALERT_TYPES.filter((type): type is Exclude<AlertType, 'instanceResumed' | 'test'> => type !== 'instanceResumed' && type !== 'test'),
  ...LEGACY_LEDGER_KINDS,
];

const LEGACY_LABEL: Record<LegacyLedgerKind, string> = {
  runFailed: '运行失败', circuitBroken: '采集熔断', recoveryExhausted: '恢复次数耗尽',
  maintenanceRequired: '游戏维护', updateRequired: '需要更新',
};

export function ledgerKindLabel(kind: LedgerAlertKind): string {
  return isAlertType(kind) ? ALERT_SPECS[kind].title : LEGACY_LABEL[kind];
}

/**
 * Map subscriptions of the earlier per-instance notification settings (`insights/notifications.json`) to alert
 * types. Types that did not exist then are added (they were not unticked, they did not exist).
 */
export function mapLegacyKinds(kinds: readonly string[]): AlertType[] {
  const out = new Set<AlertType>();
  const map: Record<string, AlertType[]> = {
    consecutiveFailures: ['consecutiveFailures'], recoveryExhausted: ['needsAttention'], maintenanceRequired: ['needsAttention'],
    updateRequired: ['needsAttention'], dispatchStalled: ['dispatchStalled'], suspectedKicked: ['suspectedKicked'],
    suspectedFreeze: ['suspectedFreeze', 'emulatorFrozen'], schedulePaused: ['schedulePaused'],
  };
  for (const kind of kinds) for (const type of map[kind] ?? []) out.add(type);
  for (const type of ['deviceOffline', 'emulatorFrozen', 'instanceResumed'] as const) out.add(type);
  return normalizeSubscriptions([...out]);
}
