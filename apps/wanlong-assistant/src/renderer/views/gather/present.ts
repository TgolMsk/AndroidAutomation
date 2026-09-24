/**
 * Presentation layer of the countdowns (original features/gather/present.ts): on top of the shared pure
 * `deriveMarchView` it adds tone / imminent / stale / a Chinese reason per row, and the global queue summary.
 *
 * ★ Time maths are always `deriveMarchView` from `@avdm/automation/wanlong/pure` (the main process schedules with the
 *   same function): never re-implement it here. A sample stores absolute times (timerEndsAt / gatherDoneAt / freeAt),
 *   so the page just subtracts `Date.now()` every second with zero adb cost; once `now` passes gatherDoneAt the row
 *   flips to 「返回中」 locally, because freeAt = gatherDoneAt + travel time is known since the dispatch.
 * ★ An unreadable countdown or queue is never shown as 0, idle or infinity, and no progress ratio is ever invented.
 */
import {
  deriveMarchView, formatDuration, type InstanceQueueState, type MarchState, type MarchView,
} from '@avdm/automation/wanlong/pure';
import { formatCstClock } from '../../../shared/time';

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 「3 分钟前」 style relative time, for 「上次采样」. */
export function formatAgo(ms: number): string {
  if (ms < 0) return '刚刚';
  const total = Math.floor(ms / 1000);
  if (total < 60) return `${total} 秒前`;
  const m = Math.floor(total / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  return `${h} 小时 ${m % 60} 分前`;
}

/**
 * Absolute time → `14:05:30`. ★ Beijing time (DECISIONS A.8: game times are shown in Beijing time whatever the host
 * time zone), where the original used the host's local clock.
 */
export function formatClock(at: number): string {
  return formatCstClock(at);
}

/**
 * Short countdown: `MM:SS` under an hour, `HH:MM:SS` above. Marches and returns are minutes long and read better
 * short; gathering (hours) always uses formatDuration.
 */
export function formatShort(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return '--:--';
  const total = Math.max(0, Math.round(ms / 1000));
  if (total >= 3600) return formatDuration(ms);
  return `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;
}

export type MarchTone = 'accent' | 'warning' | 'danger' | 'neutral';

export interface PresentOptions {
  /** Less than this left (ms) is 「临期」: the row is highlighted. */
  imminentMs: number;
  /** Older than this since the last sample (ms) is stale: the row is dimmed and marked 「待校准」. */
  staleAfterMs: number;
}

export interface MarchPresentation {
  /** From the shared `deriveMarchView`: the same seconds as the main process. */
  view: MarchView;
  /** Countdown text: HH:MM:SS while gathering, MM:SS for marches and returns. */
  text: string;
  tone: MarchTone;
  imminent: boolean;
  /** The data is older than the calibration interval. */
  stale: boolean;
  staleForMs: number;
  /** Chinese reason to show the user; null when normal. */
  reason: string | null;
  /** Whether the reason is an error (red) or a reminder (amber). */
  reasonLevel: 'error' | 'warning';
  /** When the queue slot frees up, for 「释放 14:05:30」. */
  freeAt: number | null;
}

/** One march row as it should look at this second. Pure. */
export function presentMarch(m: MarchState, now: number, opts: PresentOptions): MarchPresentation {
  const view = deriveMarchView(m, now);
  const staleForMs = Math.max(0, now - m.sampledAt - opts.staleAfterMs);
  const stale = staleForMs > 0;

  // An unreadable countdown is the case that most needs to be seen: never quietly 0 or 「空闲」, or the scheduler
  // would think a slot is free and dispatch early.
  const unreadable = m.status === 'unknown' || (m.status !== 'idle' && m.remainingMs == null);

  let tone: MarchTone = 'accent';
  let reason: string | null = m.warning ?? null;
  let reasonLevel: 'error' | 'warning' = 'warning';

  if (unreadable) {
    tone = 'danger';
    reasonLevel = 'error';
    reason = m.warning ?? (m.status === 'unknown'
      ? `状态词「${m.statusText || '（空）'}」没有命中任何已知模板，无法判断这支队伍在做什么。` +
        '调度会按「倒计时识别失败时的保守 ETA」重排，不会提前派兵。'
      : '这一行读不到倒计时（数字未命中模板）。调度会按保守 ETA 重排，不会提前派兵。');
  } else if (view.phase === 'idle') {
    tone = 'neutral';
  } else if (view.phase === 'due') {
    // Locally due; the next sample confirms. Normal, not an error.
    tone = 'accent';
  } else if (view.phase === 'marching') {
    tone = 'neutral';
  }

  const imminent = !unreadable && view.untilFreeMs != null && view.untilFreeMs > 0 && view.untilFreeMs <= opts.imminentMs;
  if (imminent && tone !== 'danger') tone = 'warning';

  // With a fallback travel time freeAt is only an estimate: say so. 'fallback' = dispatched by the assistant but the
  // march button was not read; 'unrecorded' = no dispatch record at all (dispatched by hand).
  if (!unreadable && m.travelTimeSource === 'fallback' && m.freeAt != null && reason == null) {
    reason = '单程行军耗时没有从「创建部队」页读到，用的是配置里的兜底估计，' +
      '所以「释放时刻」只是个估算值（调度已按宁晚勿早处理）。';
    reasonLevel = 'warning';
  } else if (!unreadable && m.travelTimeSource === 'unrecorded' && m.freeAt != null && reason == null) {
    reason = '没有这支队的派兵记录（多半是手动派出的，或面板重装后记录丢失）：资源类型未知，' +
      '单程行军耗时按配置的兜底值估算，「释放时刻」只是估算值（调度已按宁晚勿早处理）。它采完回城后，面板接管派兵即可。';
    reasonLevel = 'warning';
  }

  let text: string;
  if (unreadable) text = '倒计时不可用';
  else if (view.phase === 'idle') text = '空闲';
  else if (view.phase === 'due') text = '待校准';
  else if (view.phase === 'gathering') text = formatDuration(view.remainingMs);
  else text = formatShort(view.remainingMs);

  return { view, text, tone, imminent, stale, staleForMs, reason, reasonLevel, freeAt: m.freeAt };
}

export interface QueueSummary {
  /** Instances whose queue N/M was read. */
  instanceCount: number;
  queueUsed: number;
  queueTotal: number;
  /** Marches out (no idle rows, no unreadable rows). */
  activeMarches: number;
  /** Rows whose status or countdown could not be read. */
  unreadableMarches: number;
  /** Instances whose sampling failed. */
  failedInstances: number;
  /** Instances with auto scheduling on. */
  autoInstances: number;
  nextFreeAt: number | null;
  nextFreeInstance: number | null;
  nextWakeAt: number | null;
  nextWakeInstance: number | null;
  nextWakeReason: string | null;
  /** Oldest successful sample (null when nothing was ever sampled). */
  oldestSampledAt: number | null;
}

/**
 * Global KPIs over every instance. ★ `failedInstances` keeps the original formula: an instance counts when its last
 * sample failed after an earlier success (lastSampledAt > 0), or when an error is set although the last sample was ok.
 * An instance that never sampled successfully is NOT counted here (the diagnostics badge still reports it).
 */
export function summarizeQueues(states: readonly InstanceQueueState[]): QueueSummary {
  let instanceCount = 0;
  let queueUsed = 0;
  let queueTotal = 0;
  let activeMarches = 0;
  let unreadableMarches = 0;
  let failedInstances = 0;
  let autoInstances = 0;
  let nextFreeAt: number | null = null;
  let nextFreeInstance: number | null = null;
  let nextWakeAt: number | null = null;
  let nextWakeInstance: number | null = null;
  let nextWakeReason: string | null = null;
  let oldestSampledAt: number | null = null;

  for (const s of states) {
    if (s.auto) autoInstances += 1;
    if (!s.lastSampleOk && s.lastSampledAt > 0) failedInstances += 1;
    if (s.error) failedInstances += s.lastSampleOk ? 1 : 0;

    if (s.queueUsed != null && s.queueTotal != null) {
      queueUsed += s.queueUsed;
      queueTotal += s.queueTotal;
      instanceCount += 1;
    }
    if (s.lastSampledAt > 0) oldestSampledAt = oldestSampledAt == null ? s.lastSampledAt : Math.min(oldestSampledAt, s.lastSampledAt);
    if (s.nextWakeAt != null && (nextWakeAt == null || s.nextWakeAt < nextWakeAt)) {
      nextWakeAt = s.nextWakeAt;
      nextWakeInstance = s.instanceIndex;
      nextWakeReason = s.nextWakeReason;
    }
    for (const m of s.marches) {
      if (m.status === 'idle') continue;
      if (m.status === 'unknown' || m.remainingMs == null) {
        unreadableMarches += 1;
        continue;
      }
      activeMarches += 1;
      if (m.freeAt != null && (nextFreeAt == null || m.freeAt < nextFreeAt)) {
        nextFreeAt = m.freeAt;
        nextFreeInstance = s.instanceIndex;
      }
    }
  }

  return {
    instanceCount, queueUsed, queueTotal, activeMarches, unreadableMarches, failedInstances, autoInstances,
    nextFreeAt, nextFreeInstance, nextWakeAt, nextWakeInstance, nextWakeReason, oldestSampledAt,
  };
}

/** 临期窗口 = max(60 s, 2 × 唤醒冗余); stale = max(60 s, 校准间隔). Same formulas as the original overview. */
export function countdownWindows(config: { slackSeconds: number; calibrateIntervalMin: number }): PresentOptions {
  return {
    imminentMs: Math.max(60_000, config.slackSeconds * 2 * 1000),
    staleAfterMs: Math.max(60_000, config.calibrateIntervalMin * 60_000),
  };
}
