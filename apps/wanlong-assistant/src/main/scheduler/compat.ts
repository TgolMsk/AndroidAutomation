import type { AutomationSchedule } from '../../shared/ipc/automation';
import type { SchedulerQueueState } from '../../shared/ipc/scheduler';
import { sleep } from './errors';
import type { EtaScheduler } from './service';

const GAME_ID = 'wanlong';
/** How long a disable waits for the aborted sample / cycle to let go of the instance. */
const DRAIN_MS = 5_000;

/** The pre-ETA `AutomationSchedule` view (renderer, accounts, monitoring and the bot still read it). */
export function toAutomationSchedule(state: Pick<SchedulerQueueState, 'instanceIndex' | 'auto' | 'nextWakeAt' | 'failureCount'>): AutomationSchedule {
  return { gameId: GAME_ID, index: state.instanceIndex, enabled: state.auto, nextWakeAt: state.auto ? state.nextWakeAt : null, failureCount: state.failureCount };
}

function assertGame(gameId: string): void {
  if (gameId !== GAME_ID) throw new Error('该游戏尚未接入自动续跑');
}

/**
 * Thin compatibility layer: the old per-instance wake scheduler API (`get / list / enable / disable`) on top of the
 * ETA scheduler, so the host's template/settings guards and `setAutomationSchedule` keep working unchanged.
 */
export class ScheduleCompat {
  constructor(private readonly eta: EtaScheduler) {}

  restore(): Promise<void> {
    return this.eta.restore();
  }

  async list(): Promise<AutomationSchedule[]> {
    return this.eta.list().map(toAutomationSchedule);
  }

  async get(gameId: string, index: number): Promise<AutomationSchedule> {
    if (gameId !== GAME_ID) return { gameId, index, enabled: false, nextWakeAt: null, failureCount: 0 };
    return toAutomationSchedule(this.eta.getState(index));
  }

  /** Enable = the ETA scheduler's readiness gate + one read-only sample (see `EtaScheduler.setAuto`). */
  async enable(gameId: string, index: number): Promise<AutomationSchedule> {
    assertGame(gameId);
    return toAutomationSchedule(await this.eta.setAuto(index, true));
  }

  /**
   * Disable always works; it aborts the in-flight sample or cycle of that instance and waits (≤ 5 s) until the device
   * is released, so a following template or settings edit can take the instance lease.
   */
  async disable(gameId: string, index: number, reason?: string): Promise<AutomationSchedule> {
    if (gameId !== GAME_ID) return { gameId, index, enabled: false, nextWakeAt: null, failureCount: 0 };
    await this.eta.setAuto(index, false, reason);
    if (!this.eta.locks.held(index)) await Promise.race([this.eta.locks.drain(index), sleep(DRAIN_MS)]);
    return toAutomationSchedule(this.eta.getState(index));
  }

  dispose(): Promise<void> {
    return this.eta.dispose();
  }
}
