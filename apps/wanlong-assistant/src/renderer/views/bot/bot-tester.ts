/**
 * Pure helpers of the settings page's bot tester (original `features/bot/BotTestCard.tsx` logic), kept apart from the
 * component so the tests run them in Node.
 */
import {
  BOT_ACTION_SPECS, BOT_MENU_BUTTON, BOT_PERMISSION_SWITCH, type BotAction, type BotActionResult, type BotInstanceRef,
  type BotStatusView,
} from '../../../shared/bot';
import { formatCstClock } from '../../../shared/time';

/** The four quick buttons the user asked for, labelled exactly like the phone's menu. */
export const QUICK_ACTIONS: ReadonlyArray<{ action: BotAction; label: string }> = [
  { action: 'accounts', label: BOT_MENU_BUTTON.accounts },
  { action: 'shot', label: BOT_MENU_BUTTON.shot },
  { action: 'resources', label: BOT_MENU_BUTTON.resources },
  { action: 'stats', label: BOT_MENU_BUTTON.stats },
];

export function instanceLabel(ref: BotInstanceRef): string {
  return ref.name ? `实例 ${ref.index} · ${ref.name}` : `实例 ${ref.index}`;
}

/**
 * The index a run sends: none for actions without an instance, the selection otherwise (optional + nothing
 * selected = every instance). `blocked` when a required instance is missing.
 */
export function runIndex(action: BotAction, selected: number | null): { index: number | null; blocked: string | null } {
  const spec = BOT_ACTION_SPECS[action];
  if (spec.instance === 'none') return { index: null, blocked: null };
  if (spec.instance === 'required' && selected === null) return { index: null, blocked: `「${spec.description}」需要先选一个实例。` };
  return { index: selected, blocked: null };
}

/** Device actions (they take the instance lock) and control actions (they change the schedule) confirm first. */
export function confirmOf(action: BotAction, index: number | null): { title: string; message: string } | null {
  const spec = BOT_ACTION_SPECS[action];
  if (spec.touchesDevice) {
    return { title: `${spec.description}？`, message: `会占用实例 ${index ?? '?'} 的模拟器几秒；采集脚本正在跑时会被拒绝。` };
  }
  if (spec.permission === 'control') {
    return { title: `${spec.description}？`, message: `会真的对实例 ${index ?? '?'} 执行（与手机上点按钮是同一条路）。` };
  }
  return null;
}

/** What the phone would need for this action, or null when it is allowed there right now. */
export function phoneHint(action: BotAction, status: Pick<BotStatusView, 'readEnabled' | 'controlEnabled'>): string | null {
  const permission = BOT_ACTION_SPECS[action].permission;
  if (permission === 'read') return status.readEnabled ? null : `手机上需要先打开「${BOT_PERMISSION_SWITCH.read}」`;
  if (permission === 'control') return status.controlEnabled ? null : `手机上需要先打开「${BOT_PERMISSION_SWITCH.control}」`;
  return status.readEnabled || status.controlEnabled ? null : '手机上需要先打开任一个机器人开关';
}

/** The option text of the action picker. */
export function actionOptionLabel(action: BotAction): string {
  const spec = BOT_ACTION_SPECS[action];
  return `/${spec.command} · ${spec.description}${spec.touchesDevice ? '（会操作模拟器）' : ''}`;
}

/** `/shot 1 · 北京时间 21:22:33`. */
export function resultHeader(action: BotAction, index: number | null, at: number): string {
  return `/${BOT_ACTION_SPECS[action].command}${index !== null ? ` ${index}` : ''} · 北京时间 ${formatCstClock(at)}`;
}

/** Nothing to show at all (the original's 「这个动作没有返回任何内容。」). */
export function resultEmpty(result: BotActionResult): boolean {
  return !result.photo && result.text.trim() === '' && !result.keyboard;
}

/** `inst0-….jpg · 152 KB`. */
export function photoMeta(photo: { filename: string; jpeg: Uint8Array }): string {
  return `${photo.filename} · ${Math.max(1, Math.round(photo.jpeg.byteLength / 1024))} KB`;
}

/** The bot's state in one line (settings card and tester). */
export function botStatusText(status: BotStatusView): { label: string; tone: 'success' | 'warning' | 'neutral'; detail: string } {
  const open = [status.readEnabled ? '查看状态与截图' : '', status.controlEnabled ? '远程操作' : ''].filter(Boolean).join('、');
  if (status.running) {
    return {
      label: status.problem ? '运行中（有问题）' : '运行中', tone: status.problem ? 'warning' : 'success',
      detail: status.problem ?? `正在接收手机上的命令与按钮（已开放：${open || '无'}；只认配置的 Chat ID 与授权用户）。`,
    };
  }
  if (status.problem) return { label: '没有运行', tone: 'warning', detail: status.problem };
  return { label: '没有运行', tone: 'neutral', detail: '两个手机开关都关着，机器人不连接 Telegram。本卡片的测试不受影响。' };
}

/** Keep the selection when it still exists; otherwise the first instance (or none). */
export function keepSelection(current: number | null, list: readonly BotInstanceRef[]): number | null {
  return current !== null && list.some((item) => item.index === current) ? current : (list[0]?.index ?? null);
}
