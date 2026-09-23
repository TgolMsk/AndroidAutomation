import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SPEC } from '../src/constants.js';
import { isAvdmError } from '../src/errors.js';
import type { HostStats, InstanceRecord, InstanceState, InstanceStatus } from '../src/types.js';

/**
 * Memory admission with a controlled host: getHostStats is mocked, the admission check is called directly with
 * synthetic inspections (nothing is launched).
 */

const host: { current: Partial<HostStats> } = { current: {} };

vi.mock('../src/host.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/host.js')>();
  return {
    ...real,
    getHostStats: async (input: { committedInstanceRamMb: number; runningInstances: number }): Promise<HostStats> => ({
      platform: 'darwin',
      arch: 'arm64',
      cpuModel: 'test',
      cpuCount: 10,
      loadAvg: [0, 0, 0],
      totalMemMb: 24576,
      availableMemMb: 20000,
      committedInstanceRamMb: input.committedInstanceRamMb,
      runningInstances: input.runningInstances,
      ...host.current,
    }),
  };
});

const { AvdManager } = await import('../src/manager.js');
type Manager = InstanceType<typeof AvdManager>;

let home: string;
let m: Manager;

beforeAll(async () => {
  home = await fsp.mkdtemp(path.join(os.tmpdir(), 'avdm-admission-'));
  await fsp.writeFile(
    path.join(home, 'settings.json'),
    JSON.stringify({ sdkRoot: path.join(home, 'no-sdk'), memoryReserveMb: 2048, maxRunning: 6 }),
  );
  m = await AvdManager.open({ home });
});

afterAll(async () => {
  await m?.dispose();
  await fsp.rm(home, { recursive: true, force: true });
});

function rec(index: number, bootMode: 'quick' | 'cold' = 'cold'): InstanceRecord {
  return {
    index,
    name: `实例-${index}`,
    avdName: `avdm_${index}`,
    image: 'system-images;android-35;default;arm64-v8a',
    spec: { ...DEFAULT_SPEC, bootMode, extraArgs: [] },
    createdAt: new Date().toISOString(),
    autoRestart: false,
  };
}

function insp(index: number, status: InstanceStatus) {
  const state: InstanceState = {
    record: rec(index),
    ports: { console: 5554 + 2 * index, adb: 5555 + 2 * index, grpc: 8554 + index, serial: `emulator-${5554 + 2 * index}` },
    status,
    bootCompleted: status === 'running',
  };
  return { state, alive: status !== 'stopped' && status !== 'error' };
}

async function admit(record: InstanceRecord, others: ReturnType<typeof insp>[]): Promise<unknown> {
  const check = (m as unknown as { checkAdmission(r: InstanceRecord, i: unknown[]): Promise<void> }).checkAdmission.bind(m);
  return check(record, others).then(
    () => 'admitted',
    (e: unknown) => e,
  );
}

describe('memory admission', () => {
  it("denies under pressure 'warn' with swap in use while instances run (vm_stat overstates free memory)", async () => {
    // measured: 3 quick-booted instances, pressure warn, 3.8 GB swap, yet vm_stat "available" 5.6 GB
    host.current = { memoryPressure: 'warn', swapUsedMb: 3821, availableMemMb: 5664 };
    const err = await admit(rec(3), [insp(0, 'running'), insp(1, 'running'), insp(2, 'running')]);
    expect(isAvdmError(err, 'ADMISSION_DENIED')).toBe(true);
    expect((err as Error).message).toContain('内存压力偏高');
    expect((err as { details?: { reason?: string } }).details?.reason).toBe('memory-pressure');
  });

  it("'warn' alone does not block the first instance, nor a host that is not swapping", async () => {
    host.current = { memoryPressure: 'warn', swapUsedMb: 3821, availableMemMb: 12000 };
    expect(await admit(rec(0), [])).toBe('admitted');
    host.current = { memoryPressure: 'warn', swapUsedMb: 0, availableMemMb: 12000 };
    expect(await admit(rec(1), [insp(0, 'running')])).toBe('admitted');
  });

  it('charges a Quick Boot resume at 0.8 × RAM, a cold boot at 0.6 × RAM', async () => {
    host.current = { memoryPressure: 'normal', availableMemMb: 2048 + 2000 };
    // cold boot of a 3 GB instance needs ~1843 MB → fits; the same instance resuming a snapshot needs ~2458 MB
    expect(await admit(rec(5, 'cold'), [])).toBe('admitted');
    const snap = path.join(m.paths.avdHome, 'avdm_5.avd', 'snapshots', 'default_boot');
    await fsp.mkdir(snap, { recursive: true });
    await fsp.writeFile(path.join(snap, 'snapshot.pb'), 'pb');
    const err = await admit(rec(5, 'quick'), []);
    expect(isAvdmError(err, 'ADMISSION_DENIED')).toBe(true);
    expect((err as { details?: { needMb?: number } }).details?.needMb).toBe(2458);
    // a stale snapshot will not be resumed (cold boot) → charged as cold
    await fsp.writeFile(path.join(m.paths.avdHome, 'avdm_5.avd', '.avdm-snapshot-stale'), 'x');
    expect(await admit(rec(5, 'quick'), [])).toBe('admitted');
  });

  it("still denies pressure 'critical' outright", async () => {
    host.current = { memoryPressure: 'critical', availableMemMb: 20000 };
    const err = await admit(rec(7), []);
    expect(isAvdmError(err, 'ADMISSION_DENIED')).toBe(true);
  });
});
