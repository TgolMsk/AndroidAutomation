import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  accelCheck,
  availableMemMbFromVmStat,
  getHostStats,
  parseAccelCheck,
  parseMemAvailableMb,
  parseMemoryPressure,
  parseVmStat,
} from '../src/host.js';
import type { SdkInfo } from '../src/types.js';
import { createFakeSdk, type FakeSdk } from './helpers/fakeSdk.js';

// Captured from `vm_stat` on an Apple Silicon Mac (macOS 26).
const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                    50695.
Pages active:                                 390701.
Pages inactive:                               387914.
Pages speculative:                              2154.
Pages throttled:                                   0.
Pages wired down:                             183322.
Pages purgeable:                                5889.
"Translation faults":                      640706812.
Pages copy-on-write:                        11865146.
Pages zero filled:                         545578115.
Pages reactivated:                          10513487.
Pages purged:                                3288529.
File-backed pages:                            208234.
Anonymous pages:                              572535.
Pages stored in compressor:                   963526.
Pages occupied by compressor:                 510105.
Decompressions:                              6113841.
Compressions:                                9093683.
Pageins:                                     5859783.
Pageouts:                                      78129.
Swapins:                                        1638.
Swapouts:                                      10808.
`;

describe('vm_stat parsing', () => {
  it('reads the page size and counters', () => {
    const { pageSize, pages } = parseVmStat(VM_STAT);
    expect(pageSize).toBe(16384);
    expect(pages.free).toBe(50695);
    expect(pages.inactive).toBe(387914);
    expect(pages.speculative).toBe(2154);
    expect(pages.purgeable).toBe(5889);
    expect(pages['wired down']).toBe(183322);
    expect(pages['translation faults']).toBe(640706812);
    expect(pages['stored in compressor']).toBe(963526);
  });

  it('available = (free + inactive + purgeable + speculative) * pageSize', () => {
    const expected = Math.floor(((50695 + 387914 + 5889 + 2154) * 16384) / (1024 * 1024));
    expect(availableMemMbFromVmStat(VM_STAT)).toBe(expected);
    expect(expected).toBe(6978); // 446652 pages * 16 KiB
  });

  it('defaults to 4 KiB pages (Intel) and tolerates missing counters', () => {
    const intel = 'Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages free:  2560.\n';
    expect(availableMemMbFromVmStat(intel)).toBe(10);
    expect(parseVmStat('Pages free: 1.\n').pageSize).toBe(4096);
    expect(availableMemMbFromVmStat('')).toBe(0);
  });
});

describe('memory pressure / meminfo / accel parsing', () => {
  it('maps kern.memorystatus_vm_pressure_level', () => {
    expect(parseMemoryPressure('1\n')).toBe('normal');
    expect(parseMemoryPressure('2')).toBe('warn');
    expect(parseMemoryPressure(' 4 ')).toBe('critical');
    expect(parseMemoryPressure('0')).toBeUndefined();
    expect(parseMemoryPressure('')).toBeUndefined();
  });

  it('reads MemAvailable from /proc/meminfo', () => {
    expect(parseMemAvailableMb('MemTotal:       16303460 kB\nMemFree:  1 kB\nMemAvailable:    8151730 kB\n')).toBe(7960);
    expect(parseMemAvailableMb('MemTotal: 1 kB\n')).toBeUndefined();
  });

  it('interprets -accel-check output', () => {
    expect(parseAccelCheck('accel:\n0\nHypervisor.Framework OS X Version 26.0\naccel\n')).toBe(true);
    expect(parseAccelCheck('0\nHVF (version 12.x) is installed and usable.\naccel\n')).toBe(true);
    expect(parseAccelCheck('accel:\n1\nHVF is not supported on this host\naccel\n')).toBe(false);
    expect(parseAccelCheck('KVM (version 12) is installed and usable.')).toBe(true);
    expect(parseAccelCheck('something went wrong')).toBe(false);
  });
});

describe('getHostStats on this machine', () => {
  it('returns sane numbers', async () => {
    const stats = await getHostStats({ committedInstanceRamMb: 6144, runningInstances: 2 });
    expect(stats.platform).toBe(process.platform);
    expect(stats.arch).toBe(process.arch);
    expect(stats.cpuCount).toBeGreaterThan(0);
    expect(stats.loadAvg).toHaveLength(3);
    expect(stats.totalMemMb).toBeGreaterThan(512);
    expect(stats.availableMemMb).toBeGreaterThan(0);
    expect(stats.availableMemMb).toBeLessThanOrEqual(stats.totalMemMb);
    expect(stats.committedInstanceRamMb).toBe(6144);
    expect(stats.runningInstances).toBe(2);
    if (process.platform === 'darwin') {
      expect(['normal', 'warn', 'critical']).toContain(stats.memoryPressure);
      expect(stats.cpuModel).not.toBe('');
    }
  });
});

describe('accelCheck', () => {
  let fake: FakeSdk;
  beforeAll(async () => {
    fake = await createFakeSdk();
  });
  afterAll(async () => {
    await fake.cleanup();
  });

  function sdkWith(bin?: string): SdkInfo {
    return {
      root: fake.root,
      exists: true,
      emulator: bin ? { dir: fake.root, bin } : undefined,
      images: [],
      acceptedLicenses: [],
    };
  }

  it('runs emulator -accel-check (fake reports HVF usable)', async () => {
    const res = await accelCheck(sdkWith(fake.emulatorBin));
    expect(res.ok).toBe(true);
    expect(res.output).toContain('HVF');
  });

  it('reports a missing emulator without throwing', async () => {
    expect(await accelCheck(sdkWith())).toEqual({ ok: false, output: expect.stringContaining('未找到') });
    const res = await accelCheck(sdkWith(`${fake.root}/nope/emulator`));
    expect(res.ok).toBe(false);
    expect(res.output).toContain('失败');
  });
});
