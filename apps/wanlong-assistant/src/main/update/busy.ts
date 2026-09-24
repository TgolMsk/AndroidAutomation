/**
 * The install gate's question "is anything running right now" (the original `busy: () => instanceAccess.anyBusy()`).
 *
 * ★ One occupancy source. Who holds an instance is answered by the assistant's occupancy table (the app shell's
 *   `InstanceOccupancy` in `main/app/occupancy.ts`, whose async `anyBusy()` is exactly this question: blocking holders
 *   of any instance, this process's services and occupancy table, and leases held by another assistant process). The
 *   update module keeps no registry and no probes of its own: a service that holds a device registers with that table
 *   (`occupancy.register(…)` in `main/index.ts`), and the update gate follows automatically.
 * ★ The one holder that table cannot express is put in front of it: the shell's SDK install, which is app-wide, not an
 *   instance (the table only accepts instance indices).
 * ★ An enabled auto-gather schedule on its own is NOT busy: it is only a timer (registered as a non-blocking holder),
 *   and the scheduler restores itself when the assistant is opened again. Only work holding a device (or the SDK)
 *   right now counts.
 * ★ Fail closed: a check that throws counts as busy (`UpdateCenter` shows 「无法确认是否有任务在运行」 and refuses).
 */

/** Resolves with one Chinese sentence naming who is busy, or null when nothing is. */
export type BusyCheck = () => Promise<string | null>;

export interface UpdateBusySources {
  /** The instance occupancy table (`InstanceOccupancy`): 「实例 #N 正在<活动>。」 for the first blocking holder, or null. */
  occupancy: { anyBusy(): Promise<string | null> };
  /** The shell's SDK installer (quitting would cancel it). */
  sdkInstall: { readonly active: boolean };
}

export const SDK_INSTALL_BUSY = '正在安装 SDK 组件。';

/** The `busy` hook of `UpdateDeps` (wired in `main/index.ts`). Errors propagate: the center counts them as busy. */
export function updateBusyCheck(sources: UpdateBusySources): BusyCheck {
  return async () => (sources.sdkInstall.active ? SDK_INSTALL_BUSY : (await sources.occupancy.anyBusy()) || null);
}
