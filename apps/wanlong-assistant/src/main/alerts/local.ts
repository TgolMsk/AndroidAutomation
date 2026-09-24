import {
  ALERT_SPECS, renderAlertSummary, skippedNotifyResult, type AlertEvent, type LocalNotifyConfig, type NotifyResult,
} from '../../shared/alerts';

/** Shows one system notification (Electron's Notification in the app, a fake in tests). */
export type ShowLocalNotification = (title: string, body: string) => Promise<void>;

async function defaultShowLocal(title: string, body: string): Promise<void> {
  const electron = await import('electron');
  if (!electron.Notification?.isSupported()) throw new Error('当前系统不支持桌面通知');
  new electron.Notification({ title, body, silent: false }).show();
}

/**
 * The macOS notification centre as a second channel (this app's addition; the original only had Telegram). Same
 * contract as the Telegram channel: never throws, failures are returned.
 */
export class LocalNotifier {
  readonly id = 'local' as const;
  readonly label = '本机通知';

  constructor(private readonly deps: { config(): LocalNotifyConfig; show?: ShowLocalNotification; now?(): number }) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  isReady(): boolean {
    return this.deps.config().enabled;
  }

  async send(event: AlertEvent, note?: string): Promise<NotifyResult> {
    if (!this.deps.config().enabled) return skippedNotifyResult('local', 'disabled', '本机通知开关没有打开。', this.now());
    const title = `万龙助手 · ${ALERT_SPECS[event.type].title}`;
    const body = `${renderAlertSummary(event)}${note ? `\n${note}` : ''}`.slice(0, 900);
    return this.show(title, body, '已请求系统显示通知。');
  }

  /** Ignores the switch, like the Telegram test. */
  test(): Promise<NotifyResult> {
    return this.show('万龙助手 · 测试通知', '本机通知可用。出现异常时会在这里提醒你。', '已请求系统显示一条测试通知。');
  }

  private async show(title: string, body: string, okMessage: string): Promise<NotifyResult> {
    const startedAt = this.now();
    try {
      await (this.deps.show ?? defaultShowLocal)(title, body);
      return { ok: true, channel: 'local', failure: null, message: okMessage, attempts: 1, elapsedMs: this.now() - startedAt, at: this.now(), retryAfterSec: null };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        ok: false, channel: 'local', failure: 'unknown', attempts: 1, elapsedMs: this.now() - startedAt, at: this.now(), retryAfterSec: null,
        message: `本机通知没能显示：${reason.slice(0, 200)}。请在「系统设置 → 通知」里允许万龙助手发送通知。`,
      };
    }
  }
}
