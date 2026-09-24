import type { SchedulerApi, SchedulerConfig, SchedulerQueueState } from '../../shared/ipc';
import type { AutomationHost } from '../automation/host';
import type { DomainHandlers } from './types';
import { asIndex, flag, game, patchObject } from './validate';

/** Services the scheduler handlers need. The ETA scheduler lives on the automation host (`automation.eta`). */
export interface SchedulerServices {
  automation: AutomationHost;
}

const GATHER_GAME = 'wanlong';

/** Only 万龙觉醒 has a queue model; any other registered game is refused with a Chinese reason. */
function gatherGame(value: unknown): string {
  const id = game(value);
  if (id !== GATHER_GAME) throw new Error('该游戏尚未接入自动续跑');
  return id;
}

export const schedulerHandlers: DomainHandlers<SchedulerApi, SchedulerServices> = {
  async schedulerStates({ automation }, gameId): Promise<SchedulerQueueState[]> {
    gatherGame(gameId);
    return automation.eta.list();
  },
  async schedulerState({ automation }, gameId, index) {
    gatherGame(gameId);
    return automation.eta.getState(asIndex(index));
  },
  async schedulerSample({ automation }, gameId, index) {
    gatherGame(gameId);
    return automation.eta.sampleNow(asIndex(index));
  },
  async schedulerSetAuto({ automation }, gameId, index, enabled) {
    const id = gatherGame(gameId);
    const i = asIndex(index);
    // Same path as setAutomationSchedule (control lock, busy checks, readiness gate, first sample).
    await automation.setSchedule(id, i, flag(enabled, '自动续跑开关'));
    return automation.eta.getState(i);
  },
  async schedulerConfig({ automation }, gameId): Promise<SchedulerConfig> {
    gatherGame(gameId);
    return automation.eta.getConfig();
  },
  async saveSchedulerConfig({ automation }, gameId, patch) {
    gatherGame(gameId);
    return automation.eta.saveConfig(patchObject(patch, '调度参数'));
  },
  async schedulerWakes({ automation }, gameId) {
    gatherGame(gameId);
    return automation.eta.listWakes();
  },
  async schedulerCancelWake({ automation }, gameId, index) {
    gatherGame(gameId);
    automation.eta.cancelWake(asIndex(index));
  },
  async schedulerForget({ automation }, gameId, index) {
    gatherGame(gameId);
    await automation.eta.forget(asIndex(index));
  },
};
