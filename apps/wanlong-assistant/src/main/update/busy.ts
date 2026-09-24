/**
 * The install gate's view of "is anything running right now" (the original `instanceAccess.anyBusy()`).
 *
 * The original had one occupancy table every device chain registered in. Here the holders live in their own
 * services (gather runs, script plans, login sessions, the shell's SDK install, and later the scheduler, freeze
 * recovery, resource reading …), so each registers a synchronous probe and the gate asks all of them.
 *
 * ★ An enabled auto-gather schedule on its own is NOT busy: it is only a timer, and the scheduler restores itself
 *   when the assistant is opened again. Only work that is holding a device (or the SDK) right now counts.
 * ★ Fail closed: a probe that throws counts as busy, so a broken probe can never let an install cut work.
 */

/** Something holding the assistant right now. */
export interface BusyHolder {
  /** Instance index, or null for app-wide work (e.g. an SDK install). */
  index: number | null;
  /** What it is doing, as a Chinese verb phrase: 「运行采集」「登录账号」「安装 SDK 组件」. */
  activity: string;
}

/** Returns the current holders of one kind; must be synchronous and cheap (it runs on every state read). */
export type BusyProbe = () => Iterable<BusyHolder> | null | undefined;

const MAX_LISTED = 3;

/** `实例 #0 正在运行采集` / `正在安装 SDK 组件`. */
export function describeHolder(holder: BusyHolder): string {
  return holder.index === null ? `正在${holder.activity}` : `实例 #${holder.index} 正在${holder.activity}`;
}

/** One Chinese sentence naming the holders (at most three, then a count), or null when nothing is busy. */
export function formatBusyReason(holders: readonly BusyHolder[]): string | null {
  if (holders.length === 0) return null;
  const listed = holders.slice(0, MAX_LISTED).map(describeHolder).join('；');
  return holders.length > MAX_LISTED ? `${listed}等 ${holders.length} 项任务。` : `${listed}。`;
}

/** Aggregates the busy probes of every service. Register probes from the composition root (`main/index.ts`). */
export class BusyGate {
  private readonly probes = new Map<string, BusyProbe>();

  /** Add a probe under a Chinese name (used when the probe fails). Returns a function that removes it. */
  register(name: string, probe: BusyProbe): () => void {
    if (this.probes.has(name)) throw new Error(`占用检查「${name}」重复登记`);
    this.probes.set(name, probe);
    return () => {
      if (this.probes.get(name) === probe) this.probes.delete(name);
    };
  }

  /** Every holder right now, de-duplicated; a probe that throws yields one "cannot confirm" holder. */
  holders(): BusyHolder[] {
    const seen = new Set<string>();
    const result: BusyHolder[] = [];
    for (const [name, probe] of this.probes) {
      let found: BusyHolder[];
      try { found = [...(probe() ?? [])]; }
      catch { found = [{ index: null, activity: `核对「${name}」（状态读取失败，按占用处理）` }]; }
      for (const holder of found) {
        const key = `${holder.index ?? '-'}:${holder.activity}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result.push({ index: holder.index, activity: holder.activity });
      }
    }
    return result.sort((a, b) => (a.index ?? -1) - (b.index ?? -1));
  }

  /** The holders of one instance (for per-instance checks such as stop / restart confirmations). */
  holdersOf(index: number): BusyHolder[] {
    return this.holders().filter((holder) => holder.index === index);
  }

  /** Chinese reason for the install gate, or null when nothing is busy. */
  reason(): string | null {
    return formatBusyReason(this.holders());
  }
}

// ── Probes for the services that exist today (registered in main/index.ts) ────────────────────────────────

/** Instance indices the assistant can address (`asIndex` accepts 0–63). */
export const INSTANCE_SLOTS = 64;

/** Gather runs that hold a device: manual and scheduled cycles, including ones still stopping. */
export function gatherRunProbe(automation: { activeRunIndices(): readonly number[] }): BusyProbe {
  return () => automation.activeRunIndices().map((index) => ({ index, activity: '运行采集' }));
}

/** Script plan executions, including queued ones waiting for the device (quitting would drop them). */
export function planRunProbe(plans: { isActiveForInstance(index: number): boolean }): BusyProbe {
  return () => {
    const holders: BusyHolder[] = [];
    for (let index = 0; index < INSTANCE_SLOTS; index++) {
      if (plans.isActiveForInstance(index)) holders.push({ index, activity: '运行脚本计划' });
    }
    return holders;
  };
}

/** Login wizards between 「准备」 and 「验证」 (a finished or failed wizard holds nothing). */
export function loginProbe<Phase>(
  accounts: { loginSession(index: number): { phase: Phase } | null }, active: (phase: Phase) => boolean,
): BusyProbe {
  return () => {
    const holders: BusyHolder[] = [];
    for (let index = 0; index < INSTANCE_SLOTS; index++) {
      const session = accounts.loginSession(index);
      if (session && active(session.phase)) holders.push({ index, activity: '登录账号' });
    }
    return holders;
  };
}

/** The shell's SDK installer (quitting would cancel it). */
export function sdkInstallProbe(sdk: { readonly active: boolean }): BusyProbe {
  return () => (sdk.active ? [{ index: null, activity: '安装 SDK 组件' }] : []);
}
