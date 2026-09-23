import { DEFAULT_IMAGE, DEFAULT_SPEC } from './constants.js';
import { defaultSdkRoot } from './paths.js';
import type { InstanceSpec, ManagerPaths, Settings } from './types.js';
import { atomicWriteJson, readJsonIfExists, withFileLock } from './util/fs.js';
import { AvdmError } from './errors.js';

export function defaultSettings(): Settings {
  return {
    sdkRoot: defaultSdkRoot(),
    defaultImage: DEFAULT_IMAGE,
    defaultSpec: { ...DEFAULT_SPEC, extraArgs: [...DEFAULT_SPEC.extraArgs] },
    maxRunning: 6,
    memoryReserveMb: 2048,
    bootTimeoutSec: 240,
    healthIntervalSec: 5,
    proxy: 'direct',
    emulatorExtraArgs: [],
    scrcpyPath: '',
  };
}

/** Load settings.json merged over defaults (missing file → defaults). */
export async function loadSettings(paths: ManagerPaths): Promise<Settings> {
  const stored = (await readJsonIfExists<Partial<Settings>>(paths.settingsFile)) ?? {};
  return mergeSettings(defaultSettings(), stored);
}

export async function saveSettings(paths: ManagerPaths, patch: Partial<Settings>): Promise<Settings> {
  return withFileLock(`${paths.settingsFile}.lock`, async () => {
    const current = await loadSettings(paths);
    const next = mergeSettings(current, patch);
    validateSettings(next);
    await atomicWriteJson(paths.settingsFile, next);
    return next;
  });
}

function mergeSettings(base: Settings, patch: Partial<Settings>): Settings {
  return {
    ...base,
    ...patch,
    defaultSpec: { ...base.defaultSpec, ...(patch.defaultSpec ?? {}) },
  };
}

export function validateSpec(spec: InstanceSpec): void {
  const bad = (msg: string) => {
    throw new AvdmError('INVALID_ARGUMENT', msg);
  };
  if (!Number.isInteger(spec.cpuCores) || spec.cpuCores < 1 || spec.cpuCores > 16) bad('cpuCores 需为 1..16 的整数');
  if (!Number.isInteger(spec.ramMb) || spec.ramMb < 1024 || spec.ramMb > 32768) bad('ramMb 需为 1024..32768 的整数');
  if (!Number.isInteger(spec.width) || spec.width < 320 || spec.width > 3840) bad('width 需为 320..3840');
  if (!Number.isInteger(spec.height) || spec.height < 320 || spec.height > 3840) bad('height 需为 320..3840');
  if (!Number.isInteger(spec.dpi) || spec.dpi < 120 || spec.dpi > 640) bad('dpi 需为 120..640');
  if (!Number.isInteger(spec.dataPartitionGb) || spec.dataPartitionGb < 2 || spec.dataPartitionGb > 512)
    bad('dataPartitionGb 需为 2..512');
  if (!['host', 'software', 'auto'].includes(spec.gpuMode)) bad('gpuMode 需为 host|software|auto');
  if (spec.glDriver !== undefined && !['angle', 'translator'].includes(spec.glDriver)) bad('glDriver 需为 angle|translator');
  if (!['quick', 'cold'].includes(spec.bootMode)) bad('bootMode 需为 quick|cold');
  if (!Array.isArray(spec.extraArgs)) bad('extraArgs 需为数组');
}

export function validateSettings(s: Settings): void {
  validateSpec(s.defaultSpec);
  if (!Number.isInteger(s.maxRunning) || s.maxRunning < 1 || s.maxRunning > 64) {
    throw new AvdmError('INVALID_ARGUMENT', 'maxRunning 需为 1..64');
  }
  if (!Number.isInteger(s.memoryReserveMb) || s.memoryReserveMb < 0) {
    throw new AvdmError('INVALID_ARGUMENT', 'memoryReserveMb 需为非负整数');
  }
  if (!(s.bootTimeoutSec >= 30)) throw new AvdmError('INVALID_ARGUMENT', 'bootTimeoutSec 至少 30 秒');
  if (!(s.healthIntervalSec >= 1)) throw new AvdmError('INVALID_ARGUMENT', 'healthIntervalSec 至少 1 秒');
}
