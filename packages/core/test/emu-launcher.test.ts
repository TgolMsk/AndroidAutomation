import { spawnSync } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_SPEC } from '../src/constants.js';
import { consoleCommand, consoleKill } from '../src/emulator/console.js';
import { listRunningEmulators } from '../src/emulator/discovery.js';
import {
  GPU_SOFTWARE_MARKER,
  LOG_ROTATE_BYTES,
  describeCommand,
  getSupportedFlags,
  parseHelpFlags,
  planLaunch,
  portsFor,
  rotateLog,
  spawnEmulator,
  supportsGrpcToken,
} from '../src/emulator/launcher.js';
import { isAvdmError } from '../src/errors.js';
import { resolvePaths } from '../src/paths.js';
import { defaultSettings } from '../src/settings.js';
import type { InstanceRecord, SdkInfo, Settings } from '../src/types.js';
import {
  createFakeSdk,
  getFreePort,
  killIfFake,
  waitForDiscoveryFile,
  waitForExit,
  writeFakeAvd,
  type FakeSdk,
} from './helpers/fakeSdk.js';

const paths = resolvePaths('/tmp/avdm-home-test');

function sdk(version = '37.1.11'): SdkInfo {
  return {
    root: '/sdk',
    exists: true,
    emulator: { dir: '/sdk/emulator', bin: '/sdk/emulator/emulator', version },
    adb: { bin: '/sdk/platform-tools/adb' },
    images: [],
    acceptedLicenses: [],
  };
}

function record(overrides: Partial<InstanceRecord> = {}, spec: Partial<InstanceRecord['spec']> = {}): InstanceRecord {
  return {
    index: 3,
    name: '实例-3',
    avdName: 'avdm_3',
    image: 'system-images;android-35;default;arm64-v8a',
    spec: { ...DEFAULT_SPEC, extraArgs: [], ...spec },
    createdAt: '2026-09-23T00:00:00.000Z',
    autoRestart: false,
    ...overrides,
  };
}

function settings(patch: Partial<Settings> = {}): Settings {
  return { ...defaultSettings(), sdkRoot: '/sdk', ...patch };
}

const ALL_FLAGS = new Set(['-no-window', '-grpc', '-no-metrics', '-no-snapshot', '-gpu', '-port', GPU_SOFTWARE_MARKER]);

describe('portsFor', () => {
  it('maps index to console/adb/grpc ports and serial', () => {
    expect(portsFor(0)).toEqual({ console: 5554, adb: 5555, grpc: 8554, serial: 'emulator-5554' });
    expect(portsFor(3)).toEqual({ console: 5560, adb: 5561, grpc: 8557, serial: 'emulator-5560' });
    expect(portsFor(63)).toEqual({ console: 5680, adb: 5681, grpc: 8617, serial: 'emulator-5680' });
  });
  it('rejects out-of-range indices', () => {
    for (const bad of [-1, 64, 1.5, Number.NaN]) {
      expect(() => portsFor(bad)).toThrow(/实例编号/);
    }
  });
});

describe('parseHelpFlags', () => {
  it('collects indented flag names only', () => {
    const help = [
      'Android Emulator usage: emulator [options] [-qemu args]',
      '  options:',
      '    -no-window                   disable graphical window display',
      '    -gpu <mode>                  set hardware OpenGLES emulation mode',
      '    -no-metrics                  disable metrics',
      '     @<name>                     same as -avd <name>',
      'not-a-flag -foo',
    ].join('\n');
    expect([...parseHelpFlags(help)].sort()).toEqual(['-gpu', '-no-metrics', '-no-window']);
  });
});

describe('glDriver (-feature GuestAngle)', () => {
  const FLAGS = new Set([...ALL_FLAGS, '-feature']);
  const argsFor = (spec: Partial<InstanceRecord['spec']>, flags = FLAGS) =>
    planLaunch({ sdk: sdk(), paths, settings: settings(), record: record({}, spec), supportedFlags: flags }).args;

  it('defaults to ANGLE (GLES 3.1 + ASTC) right after -gpu', () => {
    const args = argsFor({});
    const i = args.indexOf('-feature');
    expect(args.slice(i, i + 2)).toEqual(['-feature', 'GuestAngle']);
    expect(args[i - 2]).toBe('-gpu');
  });

  it('treats records without glDriver (created before the field existed) as ANGLE', () => {
    const spec: Partial<InstanceRecord['spec']> = { ...DEFAULT_SPEC };
    delete spec.glDriver;
    expect(argsFor(spec)).toContain('GuestAngle');
  });

  it('translator explicitly disables GuestAngle', () => {
    const args = argsFor({ glDriver: 'translator' });
    expect(args).toContain('-GuestAngle');
    expect(args).not.toContain('GuestAngle');
  });

  it('windowed instances also disable VulkanNativeSwapchain (abort seen on 37.1.11)', () => {
    const args = argsFor({ headless: false });
    expect(args.join(' ')).toContain('-feature GuestAngle -feature -VulkanNativeSwapchain');
    expect(argsFor({ headless: true })).not.toContain('-VulkanNativeSwapchain');
  });

  it('-crash-report-mode never when supported (no blocking consent dialog after a crash)', () => {
    const args = argsFor({}, new Set([...FLAGS, '-crash-report-mode']));
    expect(args.join(' ')).toContain('-crash-report-mode never');
    expect(argsFor({})).not.toContain('-crash-report-mode');
  });

  it('adds nothing for software GPU or when the emulator lacks -feature', () => {
    expect(argsFor({ gpuMode: 'software' })).not.toContain('-feature');
    expect(argsFor({}, ALL_FLAGS)).not.toContain('-feature');
  });

  it('user extra args come after (and can override) the driver flag', () => {
    const args = argsFor({ extraArgs: ['-feature', '-GuestAngle'] });
    expect(args.lastIndexOf('-GuestAngle')).toBeGreaterThan(args.indexOf('GuestAngle'));
  });
});

describe('planLaunch', () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  });

  it('builds the default headless quick-boot argv in the documented order', () => {
    const plan = planLaunch({ sdk: sdk(), paths, settings: settings(), record: record(), supportedFlags: ALL_FLAGS });
    expect(plan.bin).toBe('/sdk/emulator/emulator');
    expect(plan.args).toEqual([
      '-avd', 'avdm_3', '-port', '5560', '-grpc', '8557', '-grpc-use-token', '-no-boot-anim', '-no-audio', '-gpu', 'host',
      '-no-window', '-no-metrics',
    ]);
    expect(plan.logFile).toBe(path.join(paths.logsDir, 'instance-3.log'));
    expect(plan.env.ANDROID_AVD_HOME).toBe(paths.avdHome);
    expect(plan.env.ANDROID_SDK_ROOT).toBe('/sdk');
    expect(plan.env.ANDROID_HOME).toBe('/sdk');
  });

  it('headlessOverride wins over spec.headless (both directions)', () => {
    const windowed = planLaunch({
      sdk: sdk(), paths, settings: settings(), record: record(), supportedFlags: ALL_FLAGS, headlessOverride: false,
    });
    expect(windowed.args).not.toContain('-no-window');
    const headless = planLaunch({
      sdk: sdk(), paths, settings: settings(), record: record({}, { headless: false }), supportedFlags: ALL_FLAGS,
      headlessOverride: true,
    });
    expect(headless.args).toContain('-no-window');
    const specWindowed = planLaunch({
      sdk: sdk(), paths, settings: settings(), record: record({}, { headless: false }), supportedFlags: ALL_FLAGS,
    });
    expect(specWindowed.args).not.toContain('-no-window');
  });

  it('cold boot adds -no-snapshot; noSnapshotLoad adds -no-snapshot-load to a quick boot only', () => {
    const plan = planLaunch({
      sdk: sdk(), paths, settings: settings(), record: record({}, { bootMode: 'cold' }), supportedFlags: ALL_FLAGS,
    });
    expect(plan.args).toContain('-no-snapshot');
    const quick = planLaunch({ sdk: sdk(), paths, settings: settings(), record: record(), supportedFlags: ALL_FLAGS });
    expect(quick.args).not.toContain('-no-snapshot');
    expect(quick.args).not.toContain('-no-snapshot-load');
    const stale = planLaunch({
      sdk: sdk(), paths, settings: settings(), record: record(), supportedFlags: ALL_FLAGS, noSnapshotLoad: true,
    });
    expect(stale.args).toContain('-no-snapshot-load');
    expect(stale.args).not.toContain('-no-snapshot');
    const coldStale = planLaunch({
      sdk: sdk(), paths, settings: settings(), record: record({}, { bootMode: 'cold' }), supportedFlags: ALL_FLAGS,
      noSnapshotLoad: true,
    });
    expect(coldStale.args).toContain('-no-snapshot');
    expect(coldStale.args).not.toContain('-no-snapshot-load');
  });

  it('gRPC is only enabled with token auth: from -help, else from the emulator version, else off (fail closed)', () => {
    const grpcArgs = (s: SdkInfo, flags: Set<string>) => {
      const args = planLaunch({ sdk: s, paths, settings: settings(), record: record(), supportedFlags: flags }).args;
      const at = args.indexOf('-grpc');
      return at < 0 ? [] : args.slice(at, at + 3);
    };
    // listed by -help (any version)
    expect(grpcArgs(sdk('30.0.0'), new Set(['-grpc', '-grpc-use-token']))).toEqual(['-grpc', '8557', '-grpc-use-token']);
    // -help probe failed (empty set) or was cut short: a supported emulator version still gets the token
    expect(grpcArgs(sdk('36.6.11'), new Set())).toEqual(['-grpc', '8557', '-grpc-use-token']);
    expect(grpcArgs(sdk('37.1.11'), new Set(['-no-window']))).toEqual(['-grpc', '8557', '-grpc-use-token']);
    // unknown or old emulator without the flag: never an unauthenticated *:port listener
    expect(grpcArgs(sdk('36.6.10'), new Set())).toEqual([]);
    const noVersion = sdk();
    delete noVersion.emulator!.version;
    expect(grpcArgs(noVersion, new Set())).toEqual([]);
    expect(supportsGrpcToken(noVersion, new Set(['-grpc-use-token']))).toBe(true);
  });

  it('adds -no-metrics only when supported', () => {
    const plan = planLaunch({
      sdk: sdk(), paths, settings: settings(), record: record(), supportedFlags: new Set(['-no-window']),
    });
    expect(plan.args).not.toContain('-no-metrics');
  });

  it('software gpu: "software" when supported (marker or version), else swiftshader_indirect', () => {
    const rec = record({}, { gpuMode: 'software' });
    const gpuOf = (s: SdkInfo, flags: Set<string>) => {
      const args = planLaunch({ sdk: s, paths, settings: settings(), record: rec, supportedFlags: flags }).args;
      return args[args.indexOf('-gpu') + 1];
    };
    expect(gpuOf(sdk('30.0.0'), new Set([GPU_SOFTWARE_MARKER]))).toBe('software');
    expect(gpuOf(sdk('36.4.9'), new Set())).toBe('software');
    expect(gpuOf(sdk('37.1.11'), new Set(['-no-window']))).toBe('software');
    expect(gpuOf(sdk('36.4.8'), new Set(['-no-window']))).toBe('swiftshader_indirect');
    const noVersion = sdk();
    delete noVersion.emulator!.version;
    expect(gpuOf(noVersion, new Set())).toBe('swiftshader_indirect');
    // other modes pass through
    const auto = planLaunch({
      sdk: sdk(), paths, settings: settings(), record: record({}, { gpuMode: 'auto' }), supportedFlags: ALL_FLAGS,
    }).args;
    expect(auto[auto.indexOf('-gpu') + 1]).toBe('auto');
  });

  it("proxy 'direct' strips proxy env vars in any case", () => {
    process.env.http_proxy = 'http://a:1';
    process.env.HTTPS_PROXY = 'http://b:2';
    process.env.All_Proxy = 'socks5://c:3';
    process.env.NO_PROXY = 'localhost';
    const plan = planLaunch({ sdk: sdk(), paths, settings: settings({ proxy: 'direct' }), record: record(), supportedFlags: ALL_FLAGS });
    const keys = Object.keys(plan.env).map((k) => k.toLowerCase());
    expect(keys).not.toContain('http_proxy');
    expect(keys).not.toContain('https_proxy');
    expect(keys).not.toContain('all_proxy');
    expect(plan.env.NO_PROXY).toBe('localhost');
    expect(plan.args).not.toContain('-http-proxy');
    // process.env itself is untouched
    expect(process.env.HTTPS_PROXY).toBe('http://b:2');
  });

  it("proxy 'inherit' keeps env; a URL becomes -http-proxy before the extra args", () => {
    process.env.HTTPS_PROXY = 'http://b:2';
    const inherit = planLaunch({ sdk: sdk(), paths, settings: settings({ proxy: 'inherit' }), record: record(), supportedFlags: ALL_FLAGS });
    expect(inherit.env.HTTPS_PROXY).toBe('http://b:2');
    expect(inherit.args).not.toContain('-http-proxy');

    const url = planLaunch({
      sdk: sdk(),
      paths,
      settings: settings({ proxy: 'http://127.0.0.1:7890', emulatorExtraArgs: ['-memory', '2048'] }),
      record: record({}, { extraArgs: ['-camera-back', 'none'] }),
      supportedFlags: ALL_FLAGS,
    });
    expect(url.args.slice(-6)).toEqual(['-http-proxy', 'http://127.0.0.1:7890', '-memory', '2048', '-camera-back', 'none']);
  });

  it('appends settings.emulatorExtraArgs then spec.extraArgs last', () => {
    const plan = planLaunch({
      sdk: sdk(),
      paths,
      settings: settings({ emulatorExtraArgs: ['-a1'] }),
      record: record({}, { extraArgs: ['-b1', '-b2'] }),
      supportedFlags: new Set(),
    });
    expect(plan.args.slice(-3)).toEqual(['-a1', '-b1', '-b2']);
  });

  it('throws EMULATOR_MISSING without an emulator', () => {
    const s = sdk();
    delete s.emulator;
    try {
      planLaunch({ sdk: s, paths, settings: settings(), record: record(), supportedFlags: ALL_FLAGS });
      expect.unreachable();
    } catch (err) {
      expect(isAvdmError(err, 'EMULATOR_MISSING')).toBe(true);
    }
  });

  it('describeCommand quotes and hides proxy passwords', () => {
    expect(describeCommand('/e', ['-avd', 'a b', '-http-proxy', 'http://u:secret@h:1'])).toBe(
      "/e -avd 'a b' -http-proxy 'http://u:***@h:1'",
    );
  });
});

describe('with the fake emulator', () => {
  let fake: FakeSdk;
  let tmp: string;
  const pids: number[] = [];

  beforeAll(async () => {
    fake = await createFakeSdk({ bootMs: 100 });
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'avdm-launch-'));
  });
  afterEach(async () => {
    for (const pid of pids.splice(0)) await killIfFake(pid, fake.root);
  });
  afterAll(async () => {
    await fake.cleanup();
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  it('getSupportedFlags parses -help and caches; empty set for a missing binary', async () => {
    const flags = await getSupportedFlags(fake.emulatorBin);
    for (const f of ['-no-window', '-grpc', '-no-metrics', '-no-snapshot', '-gpu', '-port', '-read-only', '-http-proxy', '-no-boot-anim', '-no-audio']) {
      expect(flags.has(f), f).toBe(true);
    }
    expect(flags.has(GPU_SOFTWARE_MARKER)).toBe(true); // source.properties says 37.1.11
    const again = await getSupportedFlags(fake.emulatorBin);
    expect([...again].sort()).toEqual([...flags].sort());
    expect((await getSupportedFlags(path.join(tmp, 'no-such-emulator'))).size).toBe(0);
  });

  it('getSupportedFlags does not cache the partial output of a timed-out -help', async () => {
    const counter = path.join(tmp, 'help-count');
    const bin = path.join(tmp, 'slow-emulator');
    await fsp.writeFile(
      bin,
      `#!/bin/sh\n[ "$1" = "-help" ] || exit 0\necho x >> '${counter}'\n` +
        `echo '  -grpc <port>   gRPC'\nsleep 5\necho '  -grpc-use-token   token'\n`,
      { mode: 0o755 },
    );
    // macOS assesses a new executable on its first run, which can take longer than the probe timeout below
    spawnSync(bin, ['-warm']);
    const first = await getSupportedFlags(bin, { timeoutMs: 1000 });
    expect(first.has('-grpc')).toBe(true);
    expect(first.has('-grpc-use-token')).toBe(false);
    await getSupportedFlags(bin, { timeoutMs: 1000 });
    expect((await fsp.readFile(counter, 'utf8')).trim().split('\n')).toHaveLength(2); // probed again
  }, 15_000);

  it('spawnEmulator launches detached, logs a header, and the instance is discoverable and killable', async () => {
    const home = path.join(tmp, 'home');
    const mpaths = resolvePaths(home);
    const avdName = 'avdm_7';
    await writeFakeAvd(mpaths.avdHome, avdName, { sysdirRel: fake.images[0]!.sysdirRel });
    const sdkInfo: SdkInfo = {
      root: fake.root,
      exists: true,
      emulator: { dir: path.dirname(fake.emulatorBin), bin: fake.emulatorBin, version: '37.1.11' },
      images: [],
      acceptedLicenses: [],
    };
    const plan = planLaunch({
      sdk: sdkInfo,
      paths: mpaths,
      settings: settings({ sdkRoot: fake.root }),
      record: record({ index: 7, avdName }),
      supportedFlags: await getSupportedFlags(fake.emulatorBin),
    });
    // Use free ports instead of 5568/8561 so a real emulator on this machine cannot collide.
    const consolePort = await getFreePort();
    const grpcPort = await getFreePort();
    plan.args[plan.args.indexOf('-port') + 1] = String(consolePort);
    plan.args[plan.args.indexOf('-grpc') + 1] = String(grpcPort);
    plan.env = { ...plan.env, ...fake.env };

    const { pid } = await spawnEmulator(plan);
    pids.push(pid);
    expect(pid).toBeGreaterThan(0);
    await waitForDiscoveryFile(fake.discoveryDir, pid);

    const running = await listRunningEmulators([fake.discoveryDir]);
    const me = running.find((e) => e.pid === pid);
    expect(me).toMatchObject({ avdName, consolePort, grpcPort, adbPort: consolePort + 1, emulatorVersion: '37.1.11.0' });

    expect(await consoleCommand(consolePort, 'avd name')).toBe(avdName);
    expect(await consoleKill(consolePort)).toBe(true);
    expect(await waitForExit(pid, 5000)).toBe(true);
    expect((await listRunningEmulators([fake.discoveryDir])).find((e) => e.pid === pid)).toBeUndefined();

    const log = await fsp.readFile(plan.logFile, 'utf8');
    expect(log).toMatch(/^\n=== launch \d{4}-\d{2}-\d{2}T[\d:.]+Z ===\n/);
    expect(log).toContain(`-avd ${avdName}`);
    expect(log).toContain('(fake) Android emulator version');
    expect(log).toContain('shutting down: console kill');
  });

  it('spawnEmulator appends to an existing log', async () => {
    const logFile = path.join(tmp, 'append', 'instance-1.log');
    await fsp.mkdir(path.dirname(logFile), { recursive: true });
    await fsp.writeFile(logFile, 'previous run\n');
    const { pid } = await spawnEmulator({ bin: fake.emulatorBin, args: ['-version'], env: { ...process.env }, logFile });
    pids.push(pid);
    await waitForExit(pid, 5000);
    const text = await fsp.readFile(logFile, 'utf8');
    expect(text.startsWith('previous run\n')).toBe(true);
    expect(text).toContain('Android emulator version 37.1.11.0');
  });

  it('spawnEmulator rotates an oversized log to <log>.1 before appending', async () => {
    const logFile = path.join(tmp, 'rotate', 'instance-2.log');
    await fsp.mkdir(path.dirname(logFile), { recursive: true });
    await fsp.writeFile(`${logFile}.1`, 'ancient\n');
    await fsp.writeFile(logFile, 'x'.repeat(LOG_ROTATE_BYTES + 1));
    const { pid } = await spawnEmulator({ bin: fake.emulatorBin, args: ['-version'], env: { ...process.env }, logFile });
    pids.push(pid);
    await waitForExit(pid, 5000);
    expect((await fsp.stat(`${logFile}.1`)).size).toBe(LOG_ROTATE_BYTES + 1);
    const text = await fsp.readFile(logFile, 'utf8');
    expect(text).toMatch(/^\n=== launch /);
    expect(text.length).toBeLessThan(10_000);
    // a small log is left alone
    expect(await rotateLog(logFile)).toBe(false);
  });

  it('spawnEmulator rejects when the binary cannot be spawned', async () => {
    await expect(
      spawnEmulator({ bin: path.join(tmp, 'missing-emulator'), args: [], env: {}, logFile: path.join(tmp, 'x.log') }),
    ).rejects.toMatchObject({ code: 'COMMAND_FAILED' });
  });
});
