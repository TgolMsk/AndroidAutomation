/**
 * Test harness for AvdManager integration tests: a fake SDK (see fakeSdk.ts), a temp AVDM_HOME with
 * settings pointing at it, and the fake's env vars applied to process.env (restored by cleanup()).
 *
 * Emulator ports are derived from the instance index (console 5554+2i, grpc 8554+i). Test files that start
 * emulators run in parallel, so each one reserves the low indices with placeholder records
 * (reserveIndices) to move its instances into its own port range, well away from any real emulator.
 */
import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_SPEC } from '../../src/constants.js';
import { AvdManager } from '../../src/manager.js';
import type { InstanceSpec, Settings } from '../../src/types.js';
import { createFakeSdk, type FakeSdk, type FakeSdkOptions } from './fakeSdk.js';

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Small spec so the memory admission check passes on any dev machine. */
export const TEST_SPEC: InstanceSpec = { ...DEFAULT_SPEC, cpuCores: 1, ramMb: 1024, extraArgs: [] };

export interface ManagerHarness {
  fake: FakeSdk;
  home: string;
  manager: AvdManager;
  /** Open another manager on the same home (e.g. the CLI next to the desktop app). */
  open(): Promise<AvdManager>;
  /** Force-stop every instance, dispose managers, kill leftover fakes, remove temp dirs, restore env. */
  cleanup(): Promise<void>;
}

export async function createManagerHarness(
  opts: { fake?: FakeSdkOptions; settings?: Partial<Settings> } = {},
): Promise<ManagerHarness> {
  const fake = await createFakeSdk({ bootMs: 200, ...opts.fake });
  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(fake.env)) {
    saved.set(k, process.env[k]);
    process.env[k] = v;
  }
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'avdm-mgr-'));
  const settings: Partial<Settings> = {
    sdkRoot: fake.root,
    memoryReserveMb: 0,
    maxRunning: 16,
    bootTimeoutSec: 60,
    healthIntervalSec: 1,
    defaultSpec: { ...TEST_SPEC },
    ...opts.settings,
  };
  await fsp.writeFile(path.join(home, 'settings.json'), JSON.stringify(settings, null, 2));

  const managers: AvdManager[] = [];
  const open = async () => {
    const m = await AvdManager.open({ home });
    managers.push(m);
    return m;
  };
  const manager = await open();
  return {
    fake,
    home,
    manager,
    open,
    cleanup: async () => {
      for (const m of managers) m.stopMonitor();
      const indices = await manager.indices().catch(() => [] as number[]);
      await Promise.all(indices.map((i) => manager.stop(i, { force: true }).catch(() => undefined)));
      for (const m of managers) await m.dispose().catch(() => undefined);
      await fake.cleanup();
      await fsp.rm(home, { recursive: true, force: true });
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}

/**
 * Occupy indices 0..count-1 with placeholder records so the next create() allocates from `count` upwards.
 * Returns a function that deletes the placeholders again.
 */
export async function reserveIndices(manager: AvdManager, count: number): Promise<() => Promise<void>> {
  const placeholders = await manager.registry.allocate(count, (index) => ({
    index,
    name: `占位-${index}`,
    avdName: `avdm_${index}`,
    image: 'placeholder',
    spec: { ...TEST_SPEC },
    createdAt: new Date().toISOString(),
    autoRestart: false,
    provisioning: true,
  }));
  return async () => {
    for (const r of placeholders) await manager.registry.remove(r.index);
  };
}

/** Poll `fn` until it returns a truthy value; throws with `what` on timeout. */
export async function waitUntil<T>(
  fn: () => Promise<T | undefined | null | false> | T | undefined | null | false,
  what: string,
  timeoutMs = 15_000,
  intervalMs = 100,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v as T;
    } catch (err) {
      lastErr = err;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}${lastErr ? ` (last error: ${(lastErr as Error).message})` : ''}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export function isAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Pid of a process that has already exited (for stale run records). */
export async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const pid = child.pid!;
  await new Promise((r) => child.once('exit', r));
  return pid;
}

/** A detached `sleep`-like process standing in for an emulator launcher; kill it with process.kill(-pid). */
export async function sleeper(seconds = 60): Promise<number> {
  const child = spawn(process.execPath, ['-e', `setTimeout(() => {}, ${seconds * 1000})`], {
    stdio: 'ignore',
    detached: true,
  });
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  child.unref();
  return child.pid!;
}

/** Collect every event of an AvdManager into arrays (for assertions). */
export function recordEvents(manager: AvdManager) {
  const states: Array<{ index: number; status: string; pid?: number; error?: string }> = [];
  const logs: Array<{ level: string; message: string; index?: number }> = [];
  const output: Array<{ runId: string; line: string }> = [];
  const runs: Array<{ runId: string; status: string; exitCode?: number | null }> = [];
  let changed = 0;
  const onState = (s: { record: { index: number }; status: string; pid?: number; error?: string }) =>
    states.push({ index: s.record.index, status: s.status, pid: s.pid, error: s.error });
  const onLog = (e: { level: string; message: string; index?: number }) => logs.push(e);
  const onOut = (runId: string, line: string) => output.push({ runId, line });
  const onRun = (r: { runId: string; status: string; exitCode?: number | null }) => runs.push({ ...r });
  const onChanged = () => changed++;
  manager.on('instance-state', onState);
  manager.on('log', onLog);
  manager.on('script-output', onOut);
  manager.on('script-run', onRun);
  manager.on('instances-changed', onChanged);
  return {
    states,
    logs,
    output,
    runs,
    get changed() {
      return changed;
    },
    stop() {
      manager.off('instance-state', onState);
      manager.off('log', onLog);
      manager.off('script-output', onOut);
      manager.off('script-run', onRun);
      manager.off('instances-changed', onChanged);
    },
  };
}
