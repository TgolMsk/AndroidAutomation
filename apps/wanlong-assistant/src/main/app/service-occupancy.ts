import type { OccupancyHolder } from '../../shared/ipc';
import { perInstanceSource, type InstanceOccupancy } from './occupancy';

/** The services whose work occupies an instance (structural, so tests can pass the real ones or small fakes). */
export interface ServiceOccupancyDeps {
  /** Every instance the manager knows; sources that can only answer one instance at a time walk these. */
  instanceIndices(): Promise<readonly number[]>;
  automation: {
    runs(): Promise<readonly { index: number; status: string }[]>;
    schedules(): Promise<readonly { index: number; enabled: boolean }[]>;
  };
  plans: {
    /** Queued, running or manual script work on the instance. */
    isActiveForInstance(index: number): boolean;
    hasEnabledPlanForInstance(gameId: string, index: number): Promise<boolean>;
  };
  /** A login wizard between 「准备」 and 「验证」 (a finished or failed wizard holds nothing). */
  accounts: { loginActiveOn(index: number): boolean };
  /**
   * The ETA scheduler's instance lock (`AutomationHost.locks`): who holds each instance right now — a troop-panel
   * sample, a dispatch cycle, a health probe or an `exclusive(what)` loan (bot screenshot, resource read …).
   * Optional so fakes of the other services stay small; the composition root always passes it.
   */
  scheduler?: { holderList(): readonly { index: number; label: string }[] };
  /** Game whose enabled script plans count as standing automation. */
  gameId: string;
}

/**
 * The assistant services' occupancy sources. Registered once by the composition root (`main/index.ts`) and built the
 * same way by the tests that pin the update gate (`update-busy.test.ts`), so the gate's tests cannot drift from the
 * real wiring.
 *
 * - Blocking (holds the device right now: stop / restart / remove ask, the update gate waits): a running or stopping
 *   gather run, the scheduler's instance lock (sample / dispatch / health probe / exclusive loan), queued / running
 *   script work, a login wizard in progress.
 * - Not blocking (standing automation: stop / restart / remove still ask, the update gate does not wait): an enabled
 *   gather schedule (between cycles it is only a timer), enabled script plans.
 *
 * Returns the function that unregisters all of them.
 */
export function registerServiceOccupancy(occupancy: Pick<InstanceOccupancy, 'register'>, deps: ServiceOccupancyDeps): () => void {
  const knownIndices = async (index?: number): Promise<readonly number[]> => (index !== undefined ? [index] : deps.instanceIndices());
  const unregister = [
    occupancy.register('gather', async () => (await deps.automation.runs())
      .filter((run) => run.status === 'running' || run.status === 'stopping')
      .map((run): OccupancyHolder => ({
        index: run.index, label: run.status === 'stopping' ? '停止采集' : '运行采集', source: 'gather', blocking: true,
      }))),
    // The scheduler's lock holders (a sample or health probe holds the device between cycles too).
    occupancy.register('scheduler', async (index) => (deps.scheduler?.holderList() ?? [])
      .filter((holder) => index === undefined || holder.index === index)
      .map((holder): OccupancyHolder => ({ index: holder.index, label: holder.label, source: 'scheduler', blocking: true }))),
    occupancy.register('schedule', async () => (await deps.automation.schedules()).filter((item) => item.enabled)
      .map((item): OccupancyHolder => ({ index: item.index, label: '自动采集已开启', source: 'schedule', blocking: false }))),
    occupancy.register('plans', perInstanceSource(knownIndices, (i) => deps.plans.isActiveForInstance(i),
      { label: '运行脚本计划', source: 'plans', blocking: true })),
    // Standing automation, like an enabled gather schedule: stopping the instance only needs a confirmation.
    occupancy.register('planSchedule', perInstanceSource(knownIndices, (i) => deps.plans.hasEnabledPlanForInstance(deps.gameId, i),
      { label: '已启用脚本计划', source: 'plans', blocking: false })),
    occupancy.register('login', perInstanceSource(knownIndices, (i) => deps.accounts.loginActiveOn(i),
      { label: '进行账号登录', source: 'login', blocking: true })),
  ];
  return () => { for (const off of unregister) off(); };
}
