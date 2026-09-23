import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import type { HostStats, SdkInfo } from './types.js';
import { execFileText } from './util/proc.js';

/**
 * Host resource inspection.
 * IMPLEMENTER: agent "core-emu" (see docs/DESIGN.md §host).
 */

const MB = 1024 * 1024;

export interface VmStat {
  pageSize: number;
  /** Counters keyed by their label without the "Pages " prefix, lower-cased: "free", "inactive", "purgeable" … */
  pages: Record<string, number>;
}

/** Parse macOS `vm_stat` output ("… (page size of 16384 bytes)" header, lines like `Pages free:  12345.`). */
export function parseVmStat(text: string): VmStat {
  const pageSize = Number(/page size of (\d+) bytes/.exec(text)?.[1] ?? 4096);
  const pages: Record<string, number> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*"?([^":]+?)"?:\s+(\d+)\.?\s*$/.exec(line);
    if (!m?.[1] || !m[2]) continue;
    const key = m[1].trim().replace(/^Pages\s+/i, '').toLowerCase();
    pages[key] = Number(m[2]);
  }
  return { pageSize, pages };
}

/** Memory available to new processes (MB) ≈ free + inactive + purgeable + speculative pages. */
export function availableMemMbFromVmStat(text: string): number {
  const { pageSize, pages } = parseVmStat(text);
  const reclaimable = (pages.free ?? 0) + (pages.inactive ?? 0) + (pages.purgeable ?? 0) + (pages.speculative ?? 0);
  return Math.floor((reclaimable * pageSize) / MB);
}

/** `sysctl -n kern.memorystatus_vm_pressure_level` → 1 normal, 2 warn, 4 critical. */
export function parseMemoryPressure(text: string): HostStats['memoryPressure'] {
  switch (Number.parseInt(text.trim(), 10)) {
    case 1:
      return 'normal';
    case 2:
      return 'warn';
    case 4:
      return 'critical';
    default:
      return undefined;
  }
}

/** macOS `sysctl -n vm.swapusage` ("total = 5120.00M  used = 3821.50M  free = …") → used MB. */
export function parseSwapUsedMb(text: string): number | undefined {
  const m = /used\s*=\s*([\d.]+)([KMGT])/i.exec(text);
  if (!m) return undefined;
  const scale: Record<string, number> = { K: 1 / 1024, M: 1, G: 1024, T: 1024 * 1024 };
  return Math.round(Number(m[1]) * (scale[m[2]!.toUpperCase()] ?? 1));
}

/** Linux `/proc/meminfo` MemAvailable (MB), if present. */
export function parseMemAvailableMb(meminfo: string): number | undefined {
  const kb = /^MemAvailable:\s+(\d+)\s*kB/m.exec(meminfo)?.[1];
  return kb === undefined ? undefined : Math.floor(Number(kb) / 1024);
}

type DarwinMemory = { availableMemMb?: number; memoryPressure?: HostStats['memoryPressure']; swapUsedMb?: number };

async function darwinMemory(): Promise<DarwinMemory> {
  const [vmStat, pressure, swap] = await Promise.all([
    execFileText('/usr/bin/vm_stat', [], { timeoutMs: 5000 }).catch(() => undefined),
    execFileText('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], { timeoutMs: 5000 }).catch(
      () => undefined,
    ),
    execFileText('/usr/sbin/sysctl', ['-n', 'vm.swapusage'], { timeoutMs: 5000 }).catch(() => undefined),
  ]);
  const out: DarwinMemory = {};
  if (vmStat) {
    const mb = availableMemMbFromVmStat(vmStat);
    if (mb > 0) out.availableMemMb = mb;
  }
  if (pressure) {
    const level = parseMemoryPressure(pressure);
    if (level) out.memoryPressure = level;
  }
  if (swap) {
    const used = parseSwapUsedMb(swap);
    if (used !== undefined) out.swapUsedMb = used;
  }
  return out;
}

/**
 * On macOS parse `vm_stat` (page size from its header) → available ≈ (free + inactive + purgeable + speculative) pages,
 * and `sysctl -n kern.memorystatus_vm_pressure_level` (1 normal, 2 warn, 4 critical). Elsewhere fall back to os.freemem().
 * committedInstanceRamMb / runningInstances are passed in by the manager.
 */
export async function getHostStats(input: { committedInstanceRamMb: number; runningInstances: number }): Promise<HostStats> {
  const cpus = os.cpus();
  const [l1 = 0, l5 = 0, l15 = 0] = os.loadavg();
  let availableMemMb: number | undefined;
  let memoryPressure: HostStats['memoryPressure'];
  let swapUsedMb: number | undefined;
  if (process.platform === 'darwin') {
    ({ availableMemMb, memoryPressure, swapUsedMb } = await darwinMemory());
  } else if (process.platform === 'linux') {
    const meminfo = await fsp.readFile('/proc/meminfo', 'utf8').catch(() => '');
    availableMemMb = parseMemAvailableMb(meminfo);
  }
  const stats: HostStats = {
    platform: process.platform,
    arch: process.arch,
    cpuModel: cpus[0]?.model?.trim() ?? '',
    cpuCount: typeof os.availableParallelism === 'function' ? os.availableParallelism() : cpus.length,
    loadAvg: [l1, l5, l15],
    totalMemMb: Math.floor(os.totalmem() / MB),
    availableMemMb: availableMemMb ?? Math.floor(os.freemem() / MB),
    committedInstanceRamMb: input.committedInstanceRamMb,
    runningInstances: input.runningInstances,
  };
  if (memoryPressure) stats.memoryPressure = memoryPressure;
  if (swapUsedMb !== undefined) stats.swapUsedMb = swapUsedMb;
  return stats;
}

/**
 * Interpret `emulator -accel-check` output. The emulator prints a numeric status line (0 = usable) followed by a
 * description, e.g. "accel:\n0\nHypervisor.Framework OS X Version 26.0\naccel". Without a status line, fall back
 * to the description mentioning a hypervisor and "usable".
 */
export function parseAccelCheck(output: string): boolean {
  const status = /^\s*(\d+)\s*$/m.exec(output)?.[1];
  if (status !== undefined) return status === '0';
  return /(Hypervisor\.Framework|HVF|KVM|WHPX|AEHD)/i.test(output) && /\busable\b/i.test(output);
}

/** `emulator -accel-check` → { ok, output } (ok when output mentions Hypervisor.Framework / KVM / WHPX and "usable"). */
export async function accelCheck(sdk: SdkInfo): Promise<{ ok: boolean; output: string }> {
  const bin = sdk.emulator?.bin;
  if (!bin) return { ok: false, output: '未找到 Android Emulator，请先安装 emulator 组件' };
  const { output, failed } = await new Promise<{ output: string; failed?: string }>((resolve) => {
    execFile(bin, ['-accel-check'], { timeout: 30_000, encoding: 'utf8' }, (err, stdout, stderr) => {
      const text = `${stdout ?? ''}${stderr ? `\n${stderr}` : ''}`.trim();
      // A non-zero exit still prints the diagnosis; only a spawn failure yields nothing useful.
      resolve({ output: text, failed: err && !text ? err.message : undefined });
    });
  });
  if (failed) return { ok: false, output: `执行 emulator -accel-check 失败: ${failed}` };
  return { ok: parseAccelCheck(output), output };
}
