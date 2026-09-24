/**
 * The install gate's question "is anything running right now" (the original `busy: () => instanceAccess.anyBusy()`).
 *
 * ★ One occupancy source. Who holds an instance is answered by the assistant's occupancy table (the app shell's
 *   `InstanceOccupancy`, whose async `anyBusy()` is exactly this question); the update module keeps no registry of its
 *   own. `updateBusyCheck()` only puts the one holder that table cannot express in front of it: the shell's SDK
 *   install, which is app-wide, not an instance.
 * ★ An enabled auto-gather schedule on its own is NOT busy: it is only a timer, and the scheduler restores itself when
 *   the assistant is opened again. Only work that is holding a device (or the SDK) right now counts.
 * ★ Fail closed: a check that throws counts as busy (`UpdateCenter` shows 「无法确认是否有任务在运行」 and refuses).
 */

/** Resolves with one Chinese sentence naming who is busy, or null when nothing is. */
export type BusyCheck = () => Promise<string | null>;

export interface UpdateBusySources {
  /** Who holds an instance: `() => occupancy.anyBusy()`; `interimInstanceBusy()` while there is no occupancy table. */
  instances: BusyCheck;
  /** The shell's SDK installer (quitting would cancel it). */
  sdkInstall: { readonly active: boolean };
}

export const SDK_INSTALL_BUSY = '正在安装 SDK 组件。';

/** The `busy` hook of `UpdateDeps` (wired in `main/index.ts`). */
export function updateBusyCheck(sources: UpdateBusySources): BusyCheck {
  return async () => (sources.sdkInstall.active ? SDK_INSTALL_BUSY : (await sources.instances()) || null);
}

// ── Stand-in for the occupancy table ─────────────────────────────────────────────────────────────────────────

/** Instance indices the assistant can address (`asIndex` accepts 0–63). */
export const INSTANCE_SLOTS = 64;

/** The services the stand-in reads: the same ones the occupancy table registers as blocking sources. */
export interface InstanceBusyServices<Phase> {
  /** Gather runs, manual and scheduled; a running or stopping one holds its device. */
  automation: { runs(): Promise<readonly { index: number; status: string }[]> };
  /** Script plan executions, including queued ones waiting for the device (quitting would drop them). */
  plans: { isActiveForInstance(index: number): boolean };
  /** Login wizards; `loginActive` is true between 「准备」 and 「验证」 (a finished or failed wizard holds nothing). */
  accounts: { loginSession(index: number): { phase: Phase } | null };
  loginActive(phase: Phase): boolean;
}

export interface InstanceHolder {
  index: number;
  /** What it is doing, as the occupancy table words it: 「运行采集」「运行脚本计划」「进行账号登录」. */
  label: string;
}

/** Every instance holder right now, by index. Schedules are not read at all: enabled or not, a timer holds nothing. */
export async function instanceHolders<Phase>(services: InstanceBusyServices<Phase>): Promise<InstanceHolder[]> {
  const holders: InstanceHolder[] = [];
  for (const run of await services.automation.runs()) {
    if (run.status === 'running') holders.push({ index: run.index, label: '运行采集' });
    else if (run.status === 'stopping') holders.push({ index: run.index, label: '停止采集' });
  }
  for (let index = 0; index < INSTANCE_SLOTS; index++) {
    if (services.plans.isActiveForInstance(index)) holders.push({ index, label: '运行脚本计划' });
    const session = services.accounts.loginSession(index);
    if (session && services.loginActive(session.phase)) holders.push({ index, label: '进行账号登录' });
  }
  return holders.sort((a, b) => a.index - b.index);
}

/**
 * `instances` for `updateBusyCheck()` while the assistant has no occupancy table: 「实例 #N 正在<label>。」 for the
 * first holder, the same sentence `InstanceOccupancy.anyBusy()` gives. Once the table exists, pass
 * `() => occupancy.anyBusy()` instead and delete this (never run both: that is two aggregators).
 */
export function interimInstanceBusy<Phase>(services: InstanceBusyServices<Phase>): BusyCheck {
  return async () => {
    const first = (await instanceHolders(services))[0];
    return first ? `实例 #${first.index} 正在${first.label}。` : null;
  };
}
