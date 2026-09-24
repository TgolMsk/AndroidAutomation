/**
 * What is wrong with one instance right now, as a list (original features/gather/diagnostics.ts). Pure.
 *
 * These used to be three always-on red strips; ten cards full of them pushed the countdowns off screen. They now live
 * behind a badge (InstanceDiagnosticsBadge) — but folded is not hidden: the badge shows how many and how bad, so the
 * count and the worst level are computed here.
 *
 * ★ Three levels with fixed meanings:
 *   error   — no longer working (paused / sampling fails); stays so until someone acts
 *   warning — still working, but this round's judgement may be wrong (uncertain recognition, row count mismatch)
 *   info    — explanation only, nothing to do
 */
import type { InstanceQueueState } from '@avdm/automation/wanlong/pure';
import type { GatherPauseInfo } from './pause-port';
import { presentMarch } from './present';

export type DiagnosticLevel = 'error' | 'warning' | 'info';

export interface DiagnosticItem {
  level: DiagnosticLevel;
  /** Short title (the label in the list). */
  title: string;
  /** Chinese text that tells the user what to do. */
  text: string;
}

export interface CollectDiagnosticsOptions {
  state: InstanceQueueState;
  pause: GatherPauseInfo;
  /**
   * Also collect each march row's reason. The instance table has no MarchRow, so a row reason such as 「坐标读不出」
   * has nowhere else to show; the overview cards do (the reason is on the row), so they pass false (default).
   */
  rowReasons?: boolean;
  /** Time for presentMarch; row reasons do not change by the second, one render-time Date.now() is enough. */
  now: number;
  imminentMs?: number;
  staleAfterMs?: number;
}

/** The worst level; null when there is nothing. */
export function worstLevel(items: readonly DiagnosticItem[]): DiagnosticLevel | null {
  if (items.some((i) => i.level === 'error')) return 'error';
  if (items.some((i) => i.level === 'warning')) return 'warning';
  if (items.length > 0) return 'info';
  return null;
}

/** Items that need attention (info excluded: the number on the badge must equal "things to handle"). */
export function attentionCount(items: readonly DiagnosticItem[]): number {
  return items.filter((i) => i.level !== 'info').length;
}

export function collectDiagnostics({
  state, pause, rowReasons = false, now, imminentMs = 60_000, staleAfterMs = 60_000,
}: CollectDiagnosticsOptions): DiagnosticItem[] {
  const items: DiagnosticItem[] = [];

  // ① Paused — always first. The details (advice, time) are rendered by the pause details block; this only gives it
  //    a line and makes the badge red.
  if (pause.paused) {
    items.push({ level: 'error', title: pause.title || '已暂停', text: pause.reason ?? '没有记录原因。' });
  }

  // ② Sampling failed.
  // ★ The criterion is "has an error", with NO lastSampledAt > 0 precondition: a failed sample only sets
  //   lastSampleOk / error and leaves lastSampledAt alone, so an instance that never sampled successfully keeps 0.
  //   With that precondition an instance failing from the start (game not in front, no template set…) would show
  //   nothing and look like 「尚未采样」 while it is in fact failing over and over.
  if (!state.lastSampleOk && state.error) {
    items.push({ level: 'error', title: state.lastSampledAt > 0 ? '上次采样失败' : '一直没能采样成功', text: state.error });
  }

  // ③ Sampling warnings of this round (overwritten by every sample).
  for (const w of state.warnings) items.push({ level: 'warning', title: '本轮采样告警', text: w });

  // ④ Row reasons (only where no MarchRow is shown).
  if (rowReasons) {
    for (const m of state.marches) {
      const p = presentMarch(m, now, { imminentMs, staleAfterMs });
      if (!p.reason) continue;
      items.push({ level: p.reasonLevel, title: `第 ${m.slot} 行`, text: p.reason });
    }
  }

  return items;
}

/** The badge's tooltip. ★ Promise only what the drawer really has: advice exists only for a pause. */
export function diagnosticsTip(items: readonly DiagnosticItem[], paused: boolean): string {
  const count = attentionCount(items);
  if (count === 0) return '有几条说明（不用动手），点开查看。';
  const first = items.find((i) => i.level !== 'info')?.title ?? '';
  return `${count} 条需要处理：${first}。点开查看${paused ? '原因与处置建议' : '完整原因'}。`;
}
