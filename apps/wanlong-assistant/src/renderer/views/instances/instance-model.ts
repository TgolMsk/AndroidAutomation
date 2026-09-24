/**
 * Pure helpers of the 模拟器实例 page (original views/InstancesView.tsx): search / status filter, the resolution
 * warning and the running count. Testable in Node.
 */
import type { InstanceSpec, InstanceState } from '@avdm/core';
import type { GameAccount } from '../../../main/automation/accounts/types';
import { accountOfIndex, isInstanceUp } from '../accounts/account-model';

export type StatusFilter = 'all' | 'up' | 'stopped';

/** Instances matching the search (name, index or bound account name) and the status filter, sorted by index. */
export function filterInstances(
  instances: readonly InstanceState[], accounts: readonly GameAccount[], query: string, status: StatusFilter,
): InstanceState[] {
  const term = query.trim().toLocaleLowerCase();
  return instances.filter((instance) => {
    const account = accountOfIndex(accounts, instance.record.index);
    const matches = !term || [instance.record.name, String(instance.record.index), account?.name ?? '']
      .some((text) => text.toLocaleLowerCase().includes(term));
    return matches && (status === 'all' || (status === 'up' ? isInstanceUp(instance) : !isInstanceUp(instance)));
  }).sort((a, b) => a.record.index - b.record.index);
}

/** Instances that count against the running limit (running, starting or booting). */
export function countUp(instances: readonly InstanceState[]): number {
  return instances.filter((instance) => isInstanceUp(instance)).length;
}

/**
 * The resolution warning (original 「分辨率不一致」 against exactly 2560×1440). AVDs may run scaled 16:9 frames, so
 * the check is: landscape-or-portrait 16:9, and at least 1920×1080 — below that the countdown / level OCR on the
 * 2560×1440 templates becomes unreliable (DECISIONS C「设备分辨率」). null = fine.
 */
export function resolutionWarning(spec: Pick<InstanceSpec, 'width' | 'height'> | undefined): { label: string; tip: string } | null {
  if (!spec || !(spec.width > 0) || !(spec.height > 0)) return null;
  const long = Math.max(spec.width, spec.height);
  const short = Math.min(spec.width, spec.height);
  const size = `${spec.width}×${spec.height}`;
  if (Math.abs(long / short - 16 / 9) > 0.02) {
    return {
      label: '比例不是 16:9',
      tip: `当前分辨率 ${size} 不是 16:9。模板都截自 2560×1440，比例不同会让所有匹配错位。请在「编辑配置」里改成 2560×1440（或至少 1920×1080）后重启实例。`,
    };
  }
  if (long < 1920 || short < 1080) {
    return {
      label: '分辨率偏低',
      tip: `当前分辨率 ${size} 低于 1920×1080。模板截自 2560×1440，画面缩得越小，倒计时、等级与坐标的数字识别越不可靠。建议在「编辑配置」里改成 2560×1440（或至少 1920×1080）后重启实例。`,
    };
  }
  return null;
}

/**
 * The same warning for a captured frame (probe results, DECISIONS C「在探针结果里提示当前分辨率偏低」): the size of the
 * frame actually read, which is what the templates are matched against. null = fine or unknown.
 */
export function frameResolutionHint(width: number, height: number): string | null {
  const warning = resolutionWarning({ width, height });
  return warning ? `${warning.label}：${warning.tip}` : null;
}

/**
 * Progress of a script run in the 当前执行 column (original InstancesView: a bar of stepDone / stepTotal, or
 * 「第 N 轮｜已执行 N 步」 in loop mode where the total is unknown). `percent` is null in loop mode.
 */
export function scriptRunProgress(run: { stepDone: number; stepTotal: number | null; iteration: number }): { percent: number | null; text: string } {
  if (run.stepTotal !== null && run.stepTotal > 0) {
    const percent = Math.max(0, Math.min(100, Math.round((run.stepDone / run.stepTotal) * 100)));
    return { percent, text: `已完成 ${Math.min(run.stepDone, run.stepTotal)} / ${run.stepTotal} 步` };
  }
  return { percent: null, text: `第 ${run.iteration} 轮｜已执行 ${run.stepDone} 步` };
}

/**
 * Why 「重启游戏」 cannot run on an instance now, or null. The main process re-checks (instance lock, script / login
 * holders); this only keeps the button honest.
 */
export function restartGameBlockReason(input: {
  gameLoaded: boolean; running: boolean; scriptRunning: boolean; loginActive: boolean; gatherRunning: boolean;
}): string | null {
  if (!input.gameLoaded) return '游戏模块尚未加载';
  if (!input.running) return '实例没有开机，先启动实例';
  if (input.scriptRunning) return '脚本正在执行（脚本最高优先），先在「执行监控」停止它';
  if (input.loginActive) return '账号登录向导正在用这个实例';
  if (input.gatherRunning) return '这一轮采集还在跑，等它做完（或在「执行监控」停止）再重启';
  return null;
}

/** The toast after 「重启游戏」: whether the game came back, and what a paused instance still needs. */
export function restartGameOutcome(
  index: number, result: { foreground: boolean; elapsedMs: number }, pause: { paused: boolean; title: string } | null,
): { kind: 'success' | 'warn'; title: string; detail: string } {
  const seconds = Math.max(1, Math.round(result.elapsedMs / 1000));
  const paused = pause?.paused ? `自动采集仍因「${pause.title}」暂停中，打开实时画面确认游戏正常后点「恢复」。` : '';
  return result.foreground
    ? { kind: 'success', title: `实例 #${index} 的游戏已重新拉起`, detail: `用时 ${seconds} 秒。${paused}`.trim() }
    : { kind: 'warn', title: `实例 #${index} 的游戏 60 秒内没回到前台`, detail: `打开实时画面看看卡在哪（登录、更新或别的弹窗）。${paused}`.trim() };
}
