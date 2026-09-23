import { execFile, spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { MAX_INSTANCES, MIN_EMULATOR_VERSION, consolePortFor, grpcPortFor } from '../constants.js';
import { AvdmError } from '../errors.js';
import type { InstancePorts, InstanceRecord, ManagerPaths, SdkInfo, Settings } from '../types.js';
import { ensureDir, readTextIfExists } from '../util/fs.js';
import { parseIniRecord } from '../util/ini.js';
import { compareVersions } from '../util/proc.js';

/**
 * Build argv and spawn the emulator detached.
 * IMPLEMENTER: agent "core-emu" (see docs/DESIGN.md §emulator).
 */

/** First emulator release that accepts `-gpu software` (older ones need `swiftshader_indirect`). */
export const GPU_SOFTWARE_MIN_VERSION = '36.4.9';

/**
 * Pseudo-flag added to the getSupportedFlags() result when the emulator next to the binary is new enough
 * for `-gpu software` (the mode list is not part of `-help`, so this is derived from source.properties).
 */
export const GPU_SOFTWARE_MARKER = 'gpu=software';

/**
 * Emulator releases known to support `-grpc-use-token`: every release we support (MIN_EMULATOR_VERSION) has it.
 * Used when `emulator -help` could not be read, so gRPC authentication never depends on that probe.
 */
export const GRPC_TOKEN_MIN_VERSION = MIN_EMULATOR_VERSION;

/** Environment variables that carry a proxy for the emulator process (compared case-insensitively). */
const PROXY_ENV_KEYS = new Set(['http_proxy', 'https_proxy', 'all_proxy']);

/** An instance log larger than this is rotated to `<log>.1` (replacing the previous one) at the next launch. */
export const LOG_ROTATE_BYTES = 1024 * 1024;

export function portsFor(index: number): InstancePorts {
  if (!Number.isInteger(index) || index < 0 || index >= MAX_INSTANCES) {
    throw new AvdmError('INVALID_ARGUMENT', `实例编号需为 0..${MAX_INSTANCES - 1} 的整数: ${index}`);
  }
  const consolePort = consolePortFor(index);
  return {
    console: consolePort,
    adb: consolePort + 1,
    grpc: grpcPortFor(index),
    serial: `emulator-${consolePort}`,
  };
}

/** Flags from `emulator -help` output: every line of the form `  -flag-name …`. */
export function parseHelpFlags(helpText: string): Set<string> {
  const flags = new Set<string>();
  for (const m of helpText.matchAll(/^\s+(-[a-z0-9][a-z0-9_-]*)/gim)) {
    if (m[1]) flags.add(m[1]);
  }
  return flags;
}

function runCapture(bin: string, args: string[], timeoutMs: number): Promise<{ text: string; complete: boolean }> {
  // `emulator -help` may exit non-zero on some builds; parse whatever it printed. Output of a run that was
  // killed (timeout / maxBuffer) or never started is incomplete and must not be cached.
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const e = err as (Error & { killed?: boolean; signal?: string | null; code?: unknown }) | null;
      const complete = !e || (typeof e.code === 'number' && !e.killed && !e.signal);
      resolve({ text: `${stdout ?? ''}\n${stderr ?? ''}`, complete });
    });
  });
}

async function emulatorRevisionNextTo(emulatorBin: string): Promise<string | undefined> {
  const text = await readTextIfExists(path.join(path.dirname(emulatorBin), 'source.properties')).catch(() => undefined);
  return text ? parseIniRecord(text)['Pkg.Revision'] : undefined;
}

const flagCache = new Map<string, Set<string>>();

/**
 * Parse `emulator -help` once per emulator binary (cached in-process) and return the set of
 * supported flags (e.g. "-no-window", "-grpc", "-no-metrics", "-skip-adb-auth"). Returns an empty set on failure.
 */
export async function getSupportedFlags(emulatorBin: string, opts: { timeoutMs?: number } = {}): Promise<Set<string>> {
  let key: string;
  try {
    const st = await fsp.stat(emulatorBin);
    key = `${emulatorBin}\0${st.mtimeMs}\0${st.size}`; // re-probe after an emulator update
  } catch {
    return new Set();
  }
  const cached = flagCache.get(key);
  if (cached) return new Set(cached);

  const { text, complete } = await runCapture(emulatorBin, ['-help'], opts.timeoutMs ?? 20_000);
  const flags = parseHelpFlags(text);
  if (flags.size === 0) return flags; // failure: do not cache, try again next time
  const revision = await emulatorRevisionNextTo(emulatorBin);
  if (revision && compareVersions(revision, GPU_SOFTWARE_MIN_VERSION) >= 0) flags.add(GPU_SOFTWARE_MARKER);
  if (complete) flagCache.set(key, flags); // a timed-out run printed only part of the list: re-probe next time
  return new Set(flags);
}

/**
 * Whether `-grpc-use-token` can be passed: listed by `emulator -help`, or — when that probe failed or was cut
 * short — implied by the installed emulator version. Without it `-grpc <port>` would listen on every interface
 * with no authentication, so planLaunch() then leaves gRPC off instead (fail closed).
 */
export function supportsGrpcToken(sdk: SdkInfo, supportedFlags: Set<string>): boolean {
  if (supportedFlags.has('-grpc-use-token')) return true;
  const version = sdk.emulator?.version;
  return !!version && compareVersions(version, GRPC_TOKEN_MIN_VERSION) >= 0;
}

export interface LaunchPlan {
  bin: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  logFile: string;
}

function softwareGpuMode(sdk: SdkInfo, supportedFlags: Set<string>): string {
  if (supportedFlags.has(GPU_SOFTWARE_MARKER)) return 'software';
  const version = sdk.emulator?.version;
  if (version && compareVersions(version, GPU_SOFTWARE_MIN_VERSION) >= 0) return 'software';
  return 'swiftshader_indirect';
}

/**
 * Guest GLES driver flags. The emulator's default GL translator maps GLES onto macOS OpenGL 4.1, which caps the guest at
 * GLES 3.0 without ASTC — Unity games that need GLES 3.1/ASTC refuse to start ("设备不支持当前游戏", verified with 万龙觉醒).
 * ANGLE on guest Vulkan gives GLES 3.1 + GL_KHR_texture_compression_astc_ldr (verified: emulator 37.1.11, android-35, M4).
 * Software GPU mode is left to the emulator's own choice (no host Vulkan to build ANGLE on).
 * With a visible window, VulkanNativeSwapchain is turned off: with it on, emulator 37.1.11 abort()ed as soon as the game
 * created its Vulkan device in window mode (twice-tested setup, headless was stable for 20+ min with it on).
 */
export function glDriverFeatureArgs(spec: InstanceRecord['spec'], supportedFlags: Set<string>, headless = spec.headless): string[] {
  if (spec.gpuMode === 'software' || !supportedFlags.has('-feature')) return [];
  if ((spec.glDriver ?? 'angle') !== 'angle') return ['-feature', '-GuestAngle'];
  return headless ? ['-feature', 'GuestAngle'] : ['-feature', 'GuestAngle', '-feature', '-VulkanNativeSwapchain'];
}

/**
 * Pure: compute the launch plan.
 * args: -avd <avdName> -port <console> [-grpc <grpc> -grpc-use-token] -no-boot-anim -no-audio -gpu <mode(software→'software' if supported else 'swiftshader_indirect')>
 *       [-no-window if headless] [-no-snapshot if bootMode=cold | -no-snapshot-load if noSnapshotLoad]
 *       [-no-metrics if supported] [-http-proxy <p> if settings.proxy is a URL]
 *       + settings.emulatorExtraArgs + record.spec.extraArgs
 *   gRPC is only enabled together with -grpc-use-token (see supportsGrpcToken): plain -grpc is unauthenticated on *:port.
 *   noSnapshotLoad: cold boot from the current disk this time but still save a snapshot on a graceful exit
 *   (used when the Quick Boot snapshot is older than the disk, see AvdManager).
 * env: process.env + ANDROID_AVD_HOME=paths.avdHome, ANDROID_SDK_ROOT/ANDROID_HOME=sdk.root;
 *      proxy 'direct' → delete http_proxy/https_proxy/all_proxy (any case).
 * logFile: <logsDir>/instance-<index>.log
 */
export function planLaunch(input: {
  sdk: SdkInfo;
  paths: ManagerPaths;
  settings: Settings;
  record: InstanceRecord;
  supportedFlags: Set<string>;
  headlessOverride?: boolean;
  noSnapshotLoad?: boolean;
}): LaunchPlan {
  const { sdk, paths, settings, record, supportedFlags } = input;
  const bin = sdk.emulator?.bin;
  if (!bin) {
    throw new AvdmError('EMULATOR_MISSING', '未找到 Android Emulator，请先运行 `avdm sdk install` 安装 emulator 组件');
  }
  const ports = portsFor(record.index);
  const spec = record.spec;

  const gpu = spec.gpuMode === 'software' ? softwareGpuMode(sdk, supportedFlags) : spec.gpuMode;
  const args = [
    '-avd', record.avdName,
    '-port', String(ports.console),
    // Plain `-grpc <port>` listens on *:<port> with no auth (verified on 37.1.11), exposing full device control to the LAN.
    // -grpc-use-token binds 127.0.0.1 and requires the bearer token the emulator publishes as grpc.token in its discovery file.
    // Fail closed: without token support gRPC stays off (the manager falls back to adb).
    ...(supportsGrpcToken(sdk, supportedFlags) ? ['-grpc', String(ports.grpc), '-grpc-use-token'] : []),
    '-no-boot-anim',
    '-no-audio',
    '-gpu', gpu,
  ];
  if (record.identity?.serialNumber) {
    if (!supportedFlags.has('-android-serialno')) {
      throw new AvdmError('INVALID_ARGUMENT', '当前 Android Emulator 不支持 -android-serialno，请更新 emulator 组件');
    }
    args.push('-android-serialno', record.identity.serialNumber);
  }
  const headless = input.headlessOverride ?? spec.headless;
  args.push(...glDriverFeatureArgs(spec, supportedFlags, headless));
  if (headless) args.push('-no-window');
  // After an emulator crash, a windowed launch blocks on a "send crash report?" consent dialog until someone clicks it
  // (seen as a 240 s boot timeout). `never` skips the dialog and never uploads crash dumps to Google.
  if (supportedFlags.has('-crash-report-mode')) args.push('-crash-report-mode', 'never');
  if (spec.bootMode === 'cold') args.push('-no-snapshot');
  else if (input.noSnapshotLoad) args.push('-no-snapshot-load');
  if (supportedFlags.has('-no-metrics')) args.push('-no-metrics');

  const proxy = (settings.proxy ?? 'direct').trim();
  const directProxy = proxy === '' || proxy === 'direct';
  if (!directProxy && proxy !== 'inherit') args.push('-http-proxy', proxy);
  args.push(...(settings.emulatorExtraArgs ?? []), ...(spec.extraArgs ?? []));

  const env: NodeJS.ProcessEnv = { ...process.env };
  if (directProxy) {
    for (const key of Object.keys(env)) {
      if (PROXY_ENV_KEYS.has(key.toLowerCase())) delete env[key];
    }
  }
  env.ANDROID_AVD_HOME = paths.avdHome;
  env.ANDROID_SDK_ROOT = sdk.root;
  env.ANDROID_HOME = sdk.root;

  return { bin, args, env, logFile: path.join(paths.logsDir, `instance-${record.index}.log`) };
}

/** Quote an argv for the human-readable log header; hides proxy passwords. */
export function describeCommand(bin: string, args: string[]): string {
  return [bin, ...args]
    .map((a) => a.replace(/(\/\/[^:/@\s]+:)[^@\s]+@/, '$1***@'))
    .map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`))
    .join(' ');
}

/** Keep instance logs bounded: past `maxBytes`, move the log to `<log>.1` (replacing an older one). */
export async function rotateLog(logFile: string, maxBytes = LOG_ROTATE_BYTES): Promise<boolean> {
  try {
    const st = await fsp.stat(logFile);
    if (st.size <= maxBytes) return false;
    await fsp.rename(logFile, `${logFile}.1`);
    return true;
  } catch {
    return false; // missing log, or rename failed: keep appending
  }
}

/**
 * Spawn the plan detached (own process group, stdio appended to logFile with a "=== launch <ISO> ===" header,
 * child.unref()) and resolve with the pid once spawned. Rejects if spawn fails immediately.
 */
export async function spawnEmulator(plan: LaunchPlan): Promise<{ pid: number }> {
  await ensureDir(path.dirname(plan.logFile));
  await rotateLog(plan.logFile);
  const log = await fsp.open(plan.logFile, 'a');
  try {
    await log.write(`\n=== launch ${new Date().toISOString()} ===\n${describeCommand(plan.bin, plan.args)}\n`);
    return await new Promise<{ pid: number }>((resolve, reject) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(plan.bin, plan.args, {
          detached: true,
          stdio: ['ignore', log.fd, log.fd],
          env: plan.env,
        });
      } catch (err) {
        reject(new AvdmError('COMMAND_FAILED', `启动模拟器失败: ${(err as Error).message}`));
        return;
      }
      child.once('error', (err) => {
        reject(new AvdmError('COMMAND_FAILED', `启动模拟器失败: ${err.message}`, { bin: plan.bin }));
      });
      child.once('spawn', () => {
        child.unref();
        if (child.pid === undefined) {
          reject(new AvdmError('COMMAND_FAILED', '启动模拟器失败: 未获得进程号'));
          return;
        }
        resolve({ pid: child.pid });
      });
    });
  } finally {
    // The child owns its own dup of the descriptor; the parent's copy is no longer needed.
    await log.close();
  }
}
