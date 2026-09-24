import type { WakeInfo } from '@avdm/automation/wanlong/pure';

/** setTimeout's single-shot ceiling with some room; longer waits are re-armed in segments. */
const MAX_TIMEOUT_MS = 2_000_000_000;

export interface WakeTask {
  /** One wake per instance: the key is the instance index. */
  key: number;
  dueAt: number;
  reason: string;
  /** How many backoffs in a row; 0 when not backing off. */
  backoffStep: number;
}

interface Entry {
  task: WakeTask;
  timer: NodeJS.Timeout;
}

/**
 * Wake timers (original scheduler/timers.ts). At most one wake per instance; a new one replaces the old.
 * Timers are unref'd so a pending wake never keeps the app alive, and a due time beyond setTimeout's limit is reached
 * in segments. A timer firing only means "go and look": sleep can make it late, so the callback always re-reads.
 */
export class WakeTimers {
  private readonly tasks = new Map<number, Entry>();

  constructor(private readonly now: () => number = Date.now, private readonly onError?: (key: number, error: unknown) => void) {}

  schedule(task: WakeTask, fire: (task: WakeTask) => void): void {
    this.cancel(task.key);
    this.arm({ ...task }, fire);
  }

  cancel(key: number): void {
    const entry = this.tasks.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.tasks.delete(key);
  }

  cancelAll(): void {
    for (const key of [...this.tasks.keys()]) this.cancel(key);
  }

  get(key: number): WakeTask | null {
    const task = this.tasks.get(key)?.task;
    return task ? { ...task } : null;
  }

  list(): WakeInfo[] {
    return [...this.tasks.values()]
      .map(({ task }) => ({ instanceIndex: task.key, dueAt: task.dueAt, reason: task.reason, backoffStep: task.backoffStep }))
      .sort((a, b) => a.dueAt - b.dueAt);
  }

  private arm(task: WakeTask, fire: (task: WakeTask) => void): void {
    const wait = Math.max(0, task.dueAt - this.now());
    const timer = setTimeout(() => {
      // Segmented re-arm: not due yet (long wait or a clock that ran slow), wait another slice.
      if (this.now() < task.dueAt - 50) {
        this.arm(task, fire);
        return;
      }
      this.tasks.delete(task.key);
      try { fire({ ...task }); }
      catch (error) { this.onError?.(task.key, error); }
    }, Math.min(wait, MAX_TIMEOUT_MS));
    timer.unref?.();
    this.tasks.set(task.key, { task, timer });
  }
}
