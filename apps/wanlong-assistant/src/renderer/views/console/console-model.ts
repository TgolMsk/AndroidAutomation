/**
 * Pure helpers of the 脚本控制台 (unified script dispatch): which instances can take a run, which account a run
 * carries, the concurrency note, and the summary of a dispatch. Tested in `test/script-console.test.ts`.
 */
import type { GameAccount } from '../../../main/automation/accounts/types';
import type { ScriptRunPriority } from '../../../main/plans/types';

export const PRIORITY_OPTIONS: ReadonlyArray<{ value: ScriptRunPriority; label: string; hint: string }> = [
  { value: 'highest', label: '最高优先', hint: '立即抢占：正在进行的采样、采集步骤、手动采集当场中止' },
  { value: 'normal', label: '普通', hint: '先等采集当前这一步做完（计划设置里的「抢占宽限」），再开始' },
];

/** What the rule 「脚本最高优先」 means on the instance, in one paragraph for the page. */
export const PRIORITY_RULE =
  '脚本执行期间，这台实例上的其他自动功能全部让路：自动采集不再唤醒、健康探针与卡死看门狗暂停、读资源统计和手机机器人的截图 / 重启游戏被拒绝、' +
  '手动采集被中止、计划里排队的其他任务往后等。脚本结束 15 秒后自动采集重读队列、恢复正常。';

export interface ConsoleRowInput {
  running: boolean;
  /** Name of the script already running (or starting / paused) on it. */
  scriptRunning: string | null;
  loginActive: boolean;
}

/** Why an instance cannot be ticked at all, or null. */
export function selectBlockReason(row: Pick<ConsoleRowInput, 'running'>): string | null {
  return row.running ? null : '未开机';
}

/** Why a ticked instance gets no new run in a dispatch (it stays ticked for 暂停 / 停止), or null. */
export function dispatchSkipReason(row: ConsoleRowInput): string | null {
  if (!row.running) return '未开机';
  if (row.scriptRunning) return `正在跑「${row.scriptRunning}」`;
  if (row.loginActive) return '账号登录向导正在用';
  return null;
}

export interface RunAccount {
  /** Sent with the run: its script params apply and the log is filed under it. */
  accountId?: string;
  /** Shown in the row. */
  label: string;
  /** The account exists but is not usable for this run (shown as a warning; the run goes without it). */
  warning?: string;
}

/**
 * The account a run on this instance carries: the one bound to this AVD (index + identity), enabled and logged in.
 * Anything else runs without an account — the main process would refuse an account that is not ready.
 */
export function runAccountOf(
  account: GameAccount | undefined, instance: { index: number; createdAt: string } | undefined, withAccount: boolean,
): RunAccount {
  if (!account) return { label: '未绑定账号' };
  if (!instance || account.binding?.index !== instance.index || account.binding.instanceCreatedAt !== instance.createdAt) {
    return { label: account.name, warning: '绑定指向的是已被替换的实例，这次不带账号' };
  }
  if (!account.enabled) return { label: account.name, warning: '账号已停用，这次不带账号' };
  if (account.login.status !== 'ready') return { label: account.name, warning: '账号还没完成登录，这次不带账号' };
  return withAccount ? { accountId: account.id, label: account.name } : { label: `${account.name}（不带账号运行）` };
}

/** The global cap (计划设置「同时运行脚本上限」) against what is already running plus this dispatch. */
export function capacityNote(cap: number | null, active: number, starting: number): { over: number; text: string } | null {
  if (cap === null || starting === 0) return null;
  const free = Math.max(0, cap - active);
  const over = Math.max(0, starting - free);
  return {
    over,
    text: over > 0
      ? `同时运行上限 ${cap} 个，已有 ${active} 个在跑：这次最多再启动 ${free} 个，另外 ${over} 个会被拒绝。可在「任务计划 → 计划设置」调高上限。`
      : `同时运行上限 ${cap} 个，已有 ${active} 个在跑，这次启动 ${starting} 个。`,
  };
}

export type DispatchResult =
  | { index: number; ok: true; runId: string; at: number }
  | { index: number; ok: false; error: string; at: number; skipped?: boolean };

export function dispatchSummary(results: readonly DispatchResult[], scriptName: string): { kind: 'success' | 'warn' | 'error'; title: string; detail?: string } {
  const started = results.filter((result) => result.ok).length;
  const skipped = results.filter((result) => !result.ok && result.skipped).length;
  const failed = results.length - started - skipped;
  const title = started > 0 ? `「${scriptName}」已在 ${started} 个实例上启动` : `「${scriptName}」没有启动`;
  const parts = [skipped > 0 ? `${skipped} 个跳过` : '', failed > 0 ? `${failed} 个失败（原因见列表「本次下发」）` : ''].filter(Boolean);
  return { kind: failed > 0 ? (started > 0 ? 'warn' : 'error') : skipped > 0 && started === 0 ? 'warn' : 'success', title, ...(parts.length ? { detail: parts.join('，') } : {}) };
}

/** Toggle helpers for the instance ticks (sorted, unique). */
export function toggleIndex(selected: readonly number[], index: number, on: boolean): number[] {
  const next = new Set(selected);
  if (on) next.add(index); else next.delete(index);
  return [...next].sort((a, b) => a - b);
}
