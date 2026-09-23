/**
 * Fake Android SDK for tests: copies test/fixtures/fake-sdk (Node scripts standing in for emulator, adb and
 * qemu-img) to a temp dir, adds a system image, and returns the env vars the manager/CLI under test need.
 *
 *   const fake = await createFakeSdk({ bootMs: 300 });
 *   Object.assign(process.env, fake.env);   // or pass fake.env to a spawned CLI
 *   …
 *   await fake.cleanup();                   // kills leftover fake emulators, removes the temp dir
 *
 * Fake emulators also exit on their own within ~0.5 s once the temp dir is gone.
 */
import { execFile, spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORE_DIR = path.resolve(HERE, '..', '..');

export const FAKE_SDK_TEMPLATE = path.join(CORE_DIR, 'test', 'fixtures', 'fake-sdk');
export const CORE_PROTO_PATH = path.join(CORE_DIR, 'proto', 'emulator_controller.proto');
export const FAKE_DEFAULT_IMAGE = 'system-images;android-35;default;arm64-v8a';
export const FAKE_EMULATOR_VERSION = '37.1.11';

const EXECUTABLES = ['emulator/emulator', 'emulator/qemu-img', 'platform-tools/adb'];

export interface FakeSdkOptions {
  /** ms until the fake reports boot completed (gRPC getStatus / getprop sys.boot_completed). Default 300. */
  bootMs?: number;
  /** Require this gRPC bearer token (published in the discovery file as grpc.token). */
  grpcToken?: string;
  /** System image package paths to install (default [DEFAULT_IMAGE]; [] for none). */
  images?: string[];
  /** License ids to pre-accept (files in <sdk>/licenses). Default none. */
  acceptedLicenses?: string[];
  /** Safety net: fake emulators exit after this many ms (default 10 min). */
  maxLifetimeMs?: number;
}

export interface FakeSdk {
  /** SDK root (use as settings.sdkRoot / ANDROID_HOME). */
  root: string;
  /** Directory the fake emulators write pid_<pid>.ini into (AVDM_DISCOVERY_DIR). */
  discoveryDir: string;
  /** Env vars to set for the manager/CLI under test. */
  env: Record<string, string>;
  /** Kill fake emulators started from this SDK and remove the temp dir. */
  cleanup(): Promise<void>;
  /** Temp dir holding root, discoveryDir and logs. */
  base: string;
  emulatorBin: string;
  adbBin: string;
  qemuImgBin: string;
  /** JSON lines from gRPC sendTouch/sendKey/sendMouse/setVmState. */
  inputLog: string;
  /** JSON line per fake adb invocation. */
  adbLog: string;
  /** JSON line per fake qemu-img invocation. */
  qemuImgLog: string;
  images: Array<{ packagePath: string; dir: string; sysdirRel: string }>;
}

function imageRelDir(packagePath: string): string {
  const parts = packagePath.split(';');
  if (parts.length !== 4 || parts[0] !== 'system-images') throw new Error(`bad image package path: ${packagePath}`);
  return parts.join('/');
}

async function writeImage(root: string, packagePath: string): Promise<{ packagePath: string; dir: string; sysdirRel: string }> {
  const rel = imageRelDir(packagePath);
  const [, platform = 'android-35', tagId = 'default', abi = 'arm64-v8a'] = packagePath.split(';');
  const apiLevel = platform.replace(/^android-/, '');
  const dir = path.join(root, ...rel.split('/'));
  await fsp.mkdir(dir, { recursive: true });
  const tagDisplay =
    tagId === 'default' ? 'Default Android System Image' : tagId === 'google_apis' ? 'Google APIs' : 'Google Play';
  await fsp.writeFile(
    path.join(dir, 'source.properties'),
    [
      'Pkg.Desc=System Image arm64-v8a (fake).',
      'Pkg.Revision=2',
      `Pkg.Path=${packagePath}`,
      `AndroidVersion.ApiLevel=${apiLevel}`,
      `SystemImage.Abi=${abi}`,
      `SystemImage.TagId=${tagId}`,
      `SystemImage.TagDisplay=${tagDisplay}`,
      'SystemImage.GpuSupport=true',
      '',
    ].join('\n'),
  );
  for (const f of ['system.img', 'vendor.img', 'userdata.img', 'ramdisk.img', 'kernel-ranchu', 'encryptionkey.img']) {
    await fsp.writeFile(path.join(dir, f), `fake ${f}\n`);
  }
  await fsp.writeFile(path.join(dir, 'build.prop'), `ro.build.version.sdk=${apiLevel}\nro.product.cpu.abi=${abi}\n`);
  await fsp.writeFile(path.join(dir, 'advancedFeatures.ini'), 'Vulkan = on\nGLDirectMem = on\n');
  return { packagePath, dir, sysdirRel: `${rel}/` };
}

/** Rewrite `#!/usr/bin/env node` to this Node binary so the fakes work without node on PATH. */
async function pinShebang(file: string): Promise<void> {
  if (/\s/.test(process.execPath)) return;
  const text = await fsp.readFile(file, 'utf8');
  if (text.startsWith('#!/usr/bin/env node')) {
    await fsp.writeFile(file, `#!${process.execPath}${text.slice('#!/usr/bin/env node'.length)}`);
  }
}

function commandOf(pid: number): Promise<string> {
  return new Promise((resolve) => {
    execFile('/bin/ps', ['-o', 'command=', '-p', String(pid)], (err, stdout) => resolve(err ? '' : String(stdout)));
  });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** SIGKILL `pid` only if it is still a process started from `root` (guards against pid reuse). */
export async function killIfFake(pid: number, root: string): Promise<boolean> {
  if (!isAlive(pid)) return false;
  if (!(await commandOf(pid)).includes(root)) return false;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    return false;
  }
  const deadline = Date.now() + 3000;
  while (isAlive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  return true;
}

const spawned = new Map<string, Set<number>>();

/** Kill every fake emulator of this SDK (from discovery files and processes started via startFakeEmulator). */
export async function killFakeEmulators(fake: Pick<FakeSdk, 'root' | 'discoveryDir'>): Promise<void> {
  const pids = new Set(spawned.get(fake.root) ?? []);
  for (const name of await fsp.readdir(fake.discoveryDir).catch(() => [] as string[])) {
    const m = /^pid_(\d+)\.ini$/.exec(name);
    if (m?.[1]) pids.add(Number(m[1]));
  }
  await Promise.all([...pids].map((pid) => killIfFake(pid, fake.root)));
  spawned.delete(fake.root);
}

export async function createFakeSdk(opts: FakeSdkOptions = {}): Promise<FakeSdk> {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'avdm-fake-'));
  const root = path.join(base, 'sdk');
  const discoveryDir = path.join(base, 'discovery');
  await fsp.cp(FAKE_SDK_TEMPLATE, root, { recursive: true });
  // The fakes are ESM scripts without extension.
  await fsp.writeFile(path.join(root, 'package.json'), '{ "private": true, "type": "module" }\n');
  for (const rel of EXECUTABLES) {
    const file = path.join(root, rel);
    await pinShebang(file);
    await fsp.chmod(file, 0o755);
  }
  await fsp.mkdir(discoveryDir, { recursive: true });
  await fsp.mkdir(path.join(base, 'logs'), { recursive: true });

  const images = [];
  for (const pkg of opts.images ?? [FAKE_DEFAULT_IMAGE]) images.push(await writeImage(root, pkg));
  if (opts.acceptedLicenses?.length) {
    await fsp.mkdir(path.join(root, 'licenses'), { recursive: true });
    for (const id of opts.acceptedLicenses) await fsp.writeFile(path.join(root, 'licenses', id), '\nfake-license-hash');
  }

  const inputLog = path.join(base, 'logs', 'input.jsonl');
  const adbLog = path.join(base, 'logs', 'adb.jsonl');
  const qemuImgLog = path.join(base, 'logs', 'qemu-img.jsonl');
  const env: Record<string, string> = {
    AVDM_DISCOVERY_DIR: discoveryDir,
    ANDROID_HOME: root,
    ANDROID_SDK_ROOT: root,
    FAKE_BOOT_MS: String(opts.bootMs ?? 300),
    // Client side (EmulatorGrpc) too, so a bundled CLI/desktop build under test finds the proto.
    AVDM_PROTO_PATH: CORE_PROTO_PATH,
    FAKE_PROTO_PATH: CORE_PROTO_PATH,
    FAKE_REQUIRE_FROM: path.join(CORE_DIR, 'package.json'),
    FAKE_INPUT_LOG: inputLog,
    FAKE_ADB_LOG: adbLog,
    FAKE_QEMU_IMG_LOG: qemuImgLog,
    FAKE_MAX_LIFETIME_MS: String(opts.maxLifetimeMs ?? 10 * 60_000),
  };
  if (opts.grpcToken) env.FAKE_GRPC_TOKEN = opts.grpcToken;

  const fake: FakeSdk = {
    root,
    discoveryDir,
    env,
    base,
    emulatorBin: path.join(root, 'emulator', 'emulator'),
    adbBin: path.join(root, 'platform-tools', 'adb'),
    qemuImgBin: path.join(root, 'emulator', 'qemu-img'),
    inputLog,
    adbLog,
    qemuImgLog,
    images,
    cleanup: async () => {
      await killFakeEmulators(fake);
      await fsp.rm(base, { recursive: true, force: true });
    },
  };
  return fake;
}

/**
 * Minimal AVD for launching the fake emulator directly (real tests use core-avd's createAvd):
 * <avdHome>/<name>.ini + <avdHome>/<name>.avd/config.ini.
 */
export async function writeFakeAvd(
  avdHome: string,
  avdName: string,
  opts: { sysdirRel?: string; width?: number; height?: number } = {},
): Promise<string> {
  const avdDir = path.join(avdHome, `${avdName}.avd`);
  await fsp.mkdir(avdDir, { recursive: true });
  await fsp.writeFile(
    path.join(avdHome, `${avdName}.ini`),
    `avd.ini.encoding=UTF-8\npath=${avdDir}\npath.rel=avd/${avdName}.avd\ntarget=android-35\n`,
  );
  const cfg = [
    `AvdId=${avdName}`,
    'abi.type=arm64-v8a',
    `hw.lcd.width=${opts.width ?? 1280}`,
    `hw.lcd.height=${opts.height ?? 720}`,
  ];
  if (opts.sysdirRel) cfg.push(`image.sysdir.1=${opts.sysdirRel}`);
  await fsp.writeFile(path.join(avdDir, 'config.ini'), cfg.join('\n') + '\n');
  return avdDir;
}

/** A TCP port that is free on 127.0.0.1 right now. */
export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** Wait until the discovery file of `pid` exists (the fake writes it once its servers listen). */
export async function waitForDiscoveryFile(discoveryDir: string, pid: number, timeoutMs = 10_000): Promise<string> {
  const file = path.join(discoveryDir, `pid_${pid}.ini`);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await fsp.access(file);
      return file;
    } catch {
      if (Date.now() > deadline) throw new Error(`fake emulator pid ${pid} did not publish ${file} in ${timeoutMs} ms`);
      if (!isAlive(pid)) throw new Error(`fake emulator pid ${pid} exited before publishing its discovery file`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

/** Wait for a pid to exit; returns false on timeout. */
export async function waitForExit(pid: number, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isAlive(pid)) {
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 20));
  }
  return true;
}

export interface RunningFakeEmulator {
  pid: number;
  avdName: string;
  consolePort: number;
  grpcPort: number;
  serial: string;
  discoveryFile: string;
  logFile: string;
  /** SIGTERM (graceful: removes the discovery file), SIGKILL after 3 s. */
  stop(): Promise<void>;
}

/**
 * Launch the fake emulator directly on free ports (bypassing launcher.ts), with a fresh AVD under
 * <base>/avd, and wait until it is discoverable.
 */
export async function startFakeEmulator(
  fake: FakeSdk,
  opts: { avdName?: string; consolePort?: number; grpcPort?: number; env?: Record<string, string>; args?: string[] } = {},
): Promise<RunningFakeEmulator> {
  const avdHome = path.join(fake.base, 'avd');
  const avdName = opts.avdName ?? `avdm_fake_${Math.random().toString(36).slice(2, 8)}`;
  await writeFakeAvd(avdHome, avdName, { sysdirRel: fake.images[0]?.sysdirRel });
  const consolePort = opts.consolePort ?? (await getFreePort());
  const grpcPort = opts.grpcPort ?? (await getFreePort());
  const logFile = path.join(fake.base, 'logs', `${avdName}.log`);
  const log = await fsp.open(logFile, 'a');
  const child = spawn(
    fake.emulatorBin,
    ['-avd', avdName, '-port', String(consolePort), '-grpc', String(grpcPort), '-no-window', ...(opts.args ?? [])],
    {
      detached: true,
      stdio: ['ignore', log.fd, log.fd],
      env: { ...process.env, ...fake.env, ANDROID_AVD_HOME: avdHome, ...(opts.env ?? {}) },
    },
  );
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  }).finally(() => log.close());
  child.unref();
  const pid = child.pid!;
  let set = spawned.get(fake.root);
  if (!set) spawned.set(fake.root, (set = new Set()));
  set.add(pid);
  const discoveryFile = await waitForDiscoveryFile(fake.discoveryDir, pid);
  return {
    pid,
    avdName,
    consolePort,
    grpcPort,
    serial: `emulator-${consolePort}`,
    discoveryFile,
    logFile,
    stop: async () => {
      if (!isAlive(pid)) return;
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        return;
      }
      if (!(await waitForExit(pid, 3000))) await killIfFake(pid, fake.root);
    },
  };
}
