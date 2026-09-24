import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SPEC } from '../src/constants.js';
import { doctorPassed, runDoctorChecks, type DoctorManager } from '../src/doctor.js';
import type { HostStats, InstanceRecord, SdkInfo, Settings } from '../src/types.js';

const settings = {
  sdkRoot: '/sdk',
  defaultImage: 'system-images;android-35;google_apis;arm64-v8a',
  defaultSpec: DEFAULT_SPEC,
  maxRunning: 2,
  memoryReserveMb: 2048,
  bootTimeoutSec: 180,
  healthIntervalSec: 5,
  scrcpyPath: '',
} as unknown as Settings;

const healthySdk: SdkInfo = {
  root: '/sdk',
  exists: true,
  emulator: { dir: '/sdk/emulator', bin: '/sdk/emulator/emulator', version: '36.6.11' },
  adb: { bin: '/sdk/platform-tools/adb', version: '36.0.0' },
  images: [{ packagePath: settings.defaultImage, platform: 'android-35', tagId: 'google_apis', abi: 'arm64-v8a' } as SdkInfo['images'][number]],
  acceptedLicenses: ['android-sdk-license'],
};

const host: HostStats = {
  platform: 'darwin', arch: 'arm64', cpuModel: 'Apple M3', cpuCount: 8, loadAvg: [1, 1, 1],
  totalMemMb: 32768, availableMemMb: 20000, committedInstanceRamMb: 0, runningInstances: 0,
};

function manager(overrides: Partial<{ sdk: () => Promise<SdkInfo>; host: () => Promise<HostStats>; records: InstanceRecord[] }> = {}): DoctorManager {
  return {
    paths: { home: '/home/me/.avdm' },
    registry: { list: async () => overrides.records ?? [] },
    getSettings: () => settings,
    refreshSdk: overrides.sdk ?? (async () => healthySdk),
    hostStats: overrides.host ?? (async () => host),
  };
}

const base = { platform: 'darwin' as const, arch: 'arm64', accelCheck: async () => ({ ok: true, output: 'Hypervisor.Framework OS X Version 26' }) };

describe('shared doctor checks', () => {
  it('reports every check in the fixed order and passes on a healthy machine', async () => {
    const checks = await runDoctorChecks(manager(), { ...base, findExecutable: async () => '/opt/homebrew/bin/scrcpy' });
    expect(checks.map((check) => check.id)).toEqual([
      'platform', 'home', 'sdk', 'emulator', 'adb', 'accel', 'images', 'default-image', 'licenses', 'memory', 'load', 'instances', 'scrcpy',
    ]);
    expect(checks.every((check) => check.level === 'ok')).toBe(true);
    expect(doctorPassed(checks)).toBe(true);
  });

  it('words hints for the CLI or for the desktop apps', async () => {
    const missing = async (): Promise<SdkInfo> => ({ root: '/sdk', exists: false, images: [], acceptedLicenses: [] });
    const cli = await runDoctorChecks(manager({ sdk: missing }), { ...base, audience: 'cli', skip: ['scrcpy'] });
    const app = await runDoctorChecks(manager({ sdk: missing }), { ...base, audience: 'app', skip: ['scrcpy'] });
    expect(cli.find((check) => check.id === 'sdk')!.hint).toContain('avdm sdk install');
    const appHints = app.filter((check) => check.hint).map((check) => check.hint!);
    expect(appHints.length).toBeGreaterThan(3);
    for (const hint of appHints) expect(hint).not.toMatch(/`avdm /);
    expect(app.find((check) => check.id === 'emulator')!.hint).toContain('AVD 多开管理器');
    expect(doctorPassed(app)).toBe(false);
  });

  it('isolates a throwing probe into one failed line and keeps checking', async () => {
    const onError = vi.fn();
    const checks = await runDoctorChecks(manager({ host: async () => { throw new Error('sysctl 不可用\n第二行'); } }), {
      ...base, onError, skip: ['scrcpy'],
    });
    const hostCheck = checks.find((check) => check.id === 'host')!;
    expect(hostCheck).toMatchObject({ level: 'fail', title: '主机资源', detail: '检查失败: sysctl 不可用' });
    expect(onError).toHaveBeenCalledWith('host', expect.any(Error));
    expect(checks.find((check) => check.id === 'sdk')!.level).toBe('ok');
  });

  it('flags an old emulator, missing adb and the running limit', async () => {
    const sdk = async (): Promise<SdkInfo> => ({ ...healthySdk, emulator: { ...healthySdk.emulator!, version: '36.5.2' }, adb: undefined });
    const checks = await runDoctorChecks(manager({ sdk, host: async () => ({ ...host, runningInstances: 2 }) }), { ...base, audience: 'app', skip: ['scrcpy'] });
    expect(checks.find((check) => check.id === 'emulator')).toMatchObject({ level: 'fail' });
    expect(checks.find((check) => check.id === 'adb')).toMatchObject({ level: 'fail', detail: '未安装' });
    expect(checks.find((check) => check.id === 'instances')).toMatchObject({ level: 'warn', detail: '0 个，运行中 2 / 上限 2' });
  });

  it('skips probes that the caller does not want (no process is spawned for them)', async () => {
    const accelCheck = vi.fn(async () => ({ ok: true, output: '' }));
    const findExecutable = vi.fn(async () => undefined);
    const checks = await runDoctorChecks(manager(), { ...base, accelCheck, findExecutable, skip: ['accel', 'scrcpy', 'licenses'] });
    expect(accelCheck).not.toHaveBeenCalled();
    expect(findExecutable).not.toHaveBeenCalled();
    expect(checks.map((check) => check.id)).not.toContain('licenses');
  });

  it('warns about a non-native platform', async () => {
    const checks = await runDoctorChecks(manager(), { ...base, platform: 'darwin', arch: 'x64', skip: ['scrcpy'] });
    expect(checks[0]).toMatchObject({ id: 'platform', level: 'warn' });
    expect(doctorPassed(checks)).toBe(true);
  });
});
