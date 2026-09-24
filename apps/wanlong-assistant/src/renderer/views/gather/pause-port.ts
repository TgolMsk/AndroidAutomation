/**
 * ★ Pause / resume port of the gather UI (original features/alerts: pauses, pauseOf, resume, PauseBanner).
 *
 * The alerts module owns pause records (reason, time, scene shot, advice, push result) and the real resume path
 * (clear the record + the push cooldown, then `eta.setAuto(i, true)` outside the lock). It is being ported in
 * parallel, so the gather UI reads pauses only through this file:
 *   · `pauseInfoOf(state)` — today derived from the scheduler's queue state: the alerts hook `pauseOf` fills
 *     `SchedulerQueueState.pause`; until it is wired, the scheduler's own safety pause (auto switched off after
 *     `SAFETY_PAUSE_FAILURES` consecutive real failures) is shown as a 「连续失败熔断」 pause.
 *   · `resumeInstance(gameId, index)` — today `schedulerSetAuto(gameId, index, true)`.
 * Integration: point both at the alerts IPC (pause records / resume) and keep every caller unchanged.
 *
 * Rules kept from the original: paused is judged by `paused`, never by `!auto` (the user switching auto off is not
 * a pause); resume goes through its own confirmation and this port, never through the auto switch.
 */
import type { SchedulerQueueState } from '../../../shared/ipc';
import { avdm } from '../../api';

/** Same as the scheduler's `DEFAULT_MAX_CONSECUTIVE_FAILURES` (src/main/scheduler/service.ts). */
export const SAFETY_PAUSE_FAILURES = 8;

export interface GatherPauseInfo {
  instanceIndex: number;
  paused: boolean;
  /** Alert kind (needsAttention / suspectedKicked / consecutiveFailures / deviceOffline …); null when not paused. */
  kind: string | null;
  /** Short Chinese title (the alert type's title). */
  title: string;
  /** Chinese reason; null when none was recorded. */
  reason: string | null;
  /** When it paused (ms); null when unknown. */
  at: number | null;
  /** What to do about it. */
  advice: string | null;
  /** Where the pause came from: an alerts pause record, or the scheduler's own safety pause. */
  source: 'alerts' | 'scheduler' | null;
}

/** Titles and advice of the pausing alert types (original shared/alerts ALERT_SPECS, verbatim). */
export const PAUSE_KIND_TEXT: Readonly<Record<string, { title: string; advice: string }>> = {
  needsAttention: {
    title: '需要人工介入',
    advice: '已暂停该实例的自动调度。请打开模拟器看一眼当前是什么界面（是否被顶号、是否弹了维护/更新公告），处理完成后回面板点「恢复」。',
  },
  suspectedKicked: {
    title: '疑似被顶号',
    advice: '已暂停该实例的自动调度。账号很可能在别的设备上登录了，请先确认是不是自己在别处操作；确认安全后重新登录游戏，再回面板点「恢复」。',
  },
  consecutiveFailures: {
    title: '连续失败熔断',
    advice: '已暂停该实例的自动调度。请查看日志里最近几轮的失败原因，处理后回面板点「恢复」。',
  },
  deviceOffline: {
    title: '模拟器或游戏掉线',
    advice: '已暂停该实例的自动调度。请确认模拟器是否被关掉或崩溃，重开实例并把游戏拉起来后点「恢复」。',
  },
};

export function notPaused(instanceIndex: number): GatherPauseInfo {
  return { instanceIndex, paused: false, kind: null, title: '', reason: null, at: null, advice: null, source: null };
}

/** The pause of one instance as the gather UI shows it (see the file header). */
export function pauseInfoOf(state: Pick<SchedulerQueueState, 'instanceIndex' | 'auto' | 'failureCount' | 'error' | 'pause'> | null | undefined,
  instanceIndex = state?.instanceIndex ?? -1): GatherPauseInfo {
  if (!state) return notPaused(instanceIndex);
  if (state.pause) {
    const text = state.pause.kind ? PAUSE_KIND_TEXT[state.pause.kind] : undefined;
    return {
      instanceIndex: state.instanceIndex, paused: true, kind: state.pause.kind ?? null, title: text?.title ?? '已暂停',
      reason: state.pause.reason || null, at: state.pause.at || null, advice: text?.advice ?? null, source: 'alerts',
    };
  }
  if (!state.auto && state.failureCount >= SAFETY_PAUSE_FAILURES) {
    const text = PAUSE_KIND_TEXT['consecutiveFailures']!;
    return {
      instanceIndex: state.instanceIndex, paused: true, kind: 'consecutiveFailures', title: text.title,
      reason: `连续 ${state.failureCount} 次失败，自动调度已暂停${state.error ? `：${state.error}` : '。'}`,
      at: null, advice: text.advice, source: 'scheduler',
    };
  }
  return notPaused(state.instanceIndex);
}

/** Indexes of paused instances, in order (the overview's red alert). */
export function pausedIndexes(pauses: readonly GatherPauseInfo[]): number[] {
  return pauses.filter((pause) => pause.paused).map((pause) => pause.instanceIndex).sort((a, b) => a - b);
}

/**
 * Resume a paused instance (original alerts:resume). Only ever called from a user action outside any lock; the
 * main side runs the readiness gate and a first read-only sample, and refuses with a Chinese reason.
 */
export async function resumeInstance(gameId: string, index: number): Promise<SchedulerQueueState> {
  return avdm.schedulerSetAuto(gameId, index, true);
}
