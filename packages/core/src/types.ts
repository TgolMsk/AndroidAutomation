/**
 * Shared types for @avdm/core. This file is the contract between core modules,
 * the CLI and the Electron desktop app — change it deliberately.
 */

// ───────────────────────────── Paths ─────────────────────────────

export interface ManagerPaths {
  /** Manager home, default ~/.avdm (override with AVDM_HOME). */
  home: string;
  /** settings.json */
  settingsFile: string;
  /** instances.json (registry of InstanceRecord) */
  registryFile: string;
  /** Directory used as ANDROID_AVD_HOME for every emulator we launch. */
  avdHome: string;
  /** Per-instance emulator stdout/stderr logs: logs/instance-<index>.log */
  logsDir: string;
  /** Script run logs: logs/scripts/<runId>.log */
  scriptLogsDir: string;
  /** Runtime records: run/instance-<index>.json (RunRecord) and lock files. */
  runDir: string;
  /** User script plugins: scripts/<name>/script.json */
  scriptsDir: string;
  /** Download cache for SDK archives. */
  downloadsDir: string;
}

// ───────────────────────────── Settings ─────────────────────────────

export type GpuMode = 'host' | 'software' | 'auto';
export type BootMode = 'quick' | 'cold';
/**
 * Guest OpenGL ES driver:
 *  - 'angle'      → ANGLE on guest Vulkan (gfxstream → MoltenVK → Metal): GLES 3.1 + ASTC. Default; most Unity games need it.
 *  - 'translator' → classic emulator GL translator on macOS OpenGL 4.1: GLES 3.0 max, no ASTC.
 */
export type GlDriver = 'angle' | 'translator';

/** Hardware/launch spec of one instance. Maps onto AVD config.ini + emulator flags. */
export interface InstanceSpec {
  /** hw.cpu.ncore */
  cpuCores: number;
  /** hw.ramSize (MB) */
  ramMb: number;
  /** hw.lcd.width / hw.lcd.height / hw.lcd.density */
  width: number;
  height: number;
  dpi: number;
  /** disk.dataPartition.size in GB */
  dataPartitionGb: number;
  /** -gpu host | -gpu software | -gpu auto */
  gpuMode: GpuMode;
  /** Guest GLES driver (-feature GuestAngle / -GuestAngle). Missing (records created before this field) = 'angle'. */
  glDriver?: GlDriver;
  /** true → -no-window (view via desktop live view / scrcpy) */
  headless: boolean;
  /** quick → normal Quick Boot snapshot load/save; cold → -no-snapshot */
  bootMode: BootMode;
  /** Extra raw emulator flags appended at launch. */
  extraArgs: string[];
}

/**
 * Network proxy for the emulator process:
 *  - 'direct'  → strip HTTP(S)_PROXY/ALL_PROXY env vars from the emulator process (default)
 *  - 'inherit' → pass the manager's environment through unchanged
 *  - any other string → passed as `-http-proxy <value>`
 */
export type ProxySetting = 'direct' | 'inherit' | (string & {});

export interface Settings {
  /** Android SDK root, default ~/Library/Android/sdk */
  sdkRoot: string;
  /** Default system image package path for new instances. */
  defaultImage: string;
  /** Default spec for new instances. */
  defaultSpec: InstanceSpec;
  /** Max concurrently running instances (guard). */
  maxRunning: number;
  /** Host RAM (MB) kept free for macOS when admitting a new instance. */
  memoryReserveMb: number;
  /** Seconds to wait for sys.boot_completed before reporting an error. */
  bootTimeoutSec: number;
  /** Health monitor polling interval (seconds). */
  healthIntervalSec: number;
  /** Emulator network proxy. */
  proxy: ProxySetting;
  /** Extra flags appended to every emulator launch. */
  emulatorExtraArgs: string[];
  /** Path to scrcpy binary ('' = look up in PATH). */
  scrcpyPath: string;
}

// ───────────────────────────── Registry ─────────────────────────────

/** Persistent record of one managed instance (stored in instances.json). */
export interface InstanceRecord {
  /** 0..63. Determines ports: console = 5554 + 2*index, adb = console + 1, grpc = 8554 + index. */
  index: number;
  /** Human display name (unique not required). */
  name: string;
  /** AVD id on disk, always `avdm_<index>`; lives in paths.avdHome. */
  avdName: string;
  /** SDK package path of the system image, e.g. "system-images;android-35;default;arm64-v8a". */
  image: string;
  spec: InstanceSpec;
  /** Guest identifiers managed by avdm. ADB transport serial remains emulator-<port>. */
  identity?: DeviceIdentity;
  /** ISO timestamp. */
  createdAt: string;
  /** Index of the instance this one was cloned from (informational). */
  clonedFrom?: number;
  /** Health monitor restarts the instance if it dies unexpectedly. */
  autoRestart: boolean;
  /** Free-form notes (e.g. which account lives here). */
  notes?: string;
  /** True while AVD files are being created/cloned; instance cannot be started yet. */
  provisioning?: boolean;
}

/** Values stored once per AVD; never regenerate them on an ordinary restart. */
export interface DeviceIdentity {
  serialNumber?: string;
  wifiMac?: string;
  /** Shell-visible Android ID; changing it also rotates each user's per-app SSAID seed. */
  androidId?: string;
  /** App-visible Build fields. Applied on AOSP with root + resetprop before app processes are used. */
  build?: DeviceBuildProfile;
}

export interface DeviceBuildProfile {
  brand: string;
  manufacturer: string;
  model: string;
  device: string;
  product: string;
  fingerprint: string;
}

/** `random` generates one stable set per instance; serial/MAC templates may use index placeholders. */
export type DeviceIdentityInput = 'system' | 'random' | DeviceIdentity;

export interface RegistryFile {
  version: 1;
  instances: InstanceRecord[];
}

/** Runtime record written when we launch an emulator (run/instance-<index>.json). */
export interface RunRecord {
  index: number;
  /** PID of the process we spawned (the emulator launcher / qemu). */
  pid: number;
  /** ISO timestamp of launch. */
  startedAt: string;
  ports: InstancePorts;
  /** Full argv we launched with (for diagnostics). */
  argv: string[];
  /** Set when a stop was requested, so a disappearing process is not treated as a crash. */
  stopRequestedAt?: string;
  /** Graceful-stop budget (ms) of that stop request; a request much older than this is reported as unfinished. */
  stopTimeoutMs?: number;
  /**
   * The emulator's discovery file, recorded once it registered. The emulator deletes it on an orderly exit
   * (window closed, `adb emu kill`, guest power-off) and leaves it behind when it crashes or is killed.
   */
  discoveryFile?: string;
  /** Set once the process was seen dead with its discovery file left behind (a crash), so that stays known. */
  crashedAt?: string;
}

// ───────────────────────────── Runtime state ─────────────────────────────

export interface InstancePorts {
  /** Emulator console (telnet) port, even number 5554..5680. */
  console: number;
  /** ADB port = console + 1. */
  adb: number;
  /** gRPC EmulatorController port = 8554 + index. */
  grpc: number;
  /** ADB serial, "emulator-<console>". */
  serial: string;
}

export type InstanceStatus =
  | 'stopped'   // no process
  | 'starting'  // process spawned, emulator not yet registered / discoverable
  | 'booting'   // emulator process up, Android not yet boot_completed
  | 'running'   // sys.boot_completed = 1
  | 'stopping'  // stop requested, process still alive
  | 'error';    // process died unexpectedly or boot timed out

export interface InstanceState {
  record: InstanceRecord;
  ports: InstancePorts;
  status: InstanceStatus;
  /** Live PID (from emulator discovery file, or our RunRecord). */
  pid?: number;
  bootCompleted: boolean;
  startedAt?: string;
  /** Human-readable error for status 'error'. */
  error?: string;
  /** gRPC bearer token from the emulator discovery file, if the emulator requires one. */
  grpcToken?: string;
}

// ───────────────────────────── Emulator discovery ─────────────────────────────

/** Parsed emulator discovery file (…/avd/running/pid_<pid>.ini). */
export interface DiscoveryEntry {
  pid: number;
  file: string;
  avdName?: string;
  avdDir?: string;
  consolePort?: number;
  adbPort?: number;
  grpcPort?: number;
  grpcToken?: string;
  emulatorVersion?: string;
  /** All raw key/values. */
  raw: Record<string, string>;
}

// ───────────────────────────── SDK ─────────────────────────────

export interface ArchiveInfo {
  url: string;          // absolute URL
  size: number;         // bytes
  sha1: string;         // lowercase hex
  hostOs?: string;      // 'macosx' | 'linux' | 'windows'
  hostArch?: string;    // 'aarch64' | 'x64'
}

export interface RemotePackage {
  /** SDK package path, e.g. "emulator", "platform-tools", "system-images;android-35;default;arm64-v8a". */
  path: string;
  displayName: string;
  revision: string;
  /** 'channel-0' stable, 'channel-1' beta, 'channel-2' dev, 'channel-3' canary. */
  channel: string;
  licenseId: string;
  archives: ArchiveInfo[];
  /** For system images: API level string such as "35", tag id and abi. */
  apiLevel?: string;
  tagId?: string;
  tagDisplay?: string;
  abi?: string;
}

export interface SdkCatalog {
  packages: RemotePackage[];
  /** licenseId → full license text */
  licenses: Record<string, string>;
  fetchedAt: string;
}

export interface InstalledImage {
  /** "system-images;android-35;default;arm64-v8a" */
  packagePath: string;
  /** Absolute dir containing system.img etc. */
  dir: string;
  /** Relative sysdir as written into config.ini image.sysdir.1, with trailing slash. */
  sysdirRel: string;
  /** "android-35" */
  platform: string;
  /** "35" (may be "36.1", "35-ext15" etc.) */
  apiLevel: string;
  tagId: string;
  tagDisplay: string;
  abi: string;
  /** Pkg.Revision from source.properties if present. */
  revision?: string;
}

export interface SdkInfo {
  root: string;
  exists: boolean;
  emulator?: { dir: string; bin: string; version?: string; qemuImg?: string };
  adb?: { bin: string; version?: string };
  images: InstalledImage[];
  /** licenseIds already accepted in <sdk>/licenses */
  acceptedLicenses: string[];
}

export type InstallPhase = 'download' | 'verify' | 'extract' | 'done' | 'error';

export interface InstallProgress {
  packagePath: string;
  phase: InstallPhase;
  receivedBytes?: number;
  totalBytes?: number;
  message?: string;
}

// ───────────────────────────── Host ─────────────────────────────

export interface HostStats {
  platform: NodeJS.Platform;
  arch: string;
  cpuModel: string;
  cpuCount: number;
  loadAvg: [number, number, number];
  totalMemMb: number;
  /** Approximate memory available to new processes (free + inactive + purgeable on macOS). */
  availableMemMb: number;
  /** macOS memory pressure level if obtainable. */
  memoryPressure?: 'normal' | 'warn' | 'critical';
  /** Swap in use (MB), macOS `vm.swapusage`, if obtainable. */
  swapUsedMb?: number;
  /** Sum of ramMb of instances currently not 'stopped'. */
  committedInstanceRamMb: number;
  runningInstances: number;
}

// ───────────────────────────── Scripts (plugins) ─────────────────────────────

/** scripts/<dir>/script.json */
export interface ScriptManifest {
  /** Unique id = directory name (filled in by loader). */
  id: string;
  name: string;
  description?: string;
  /** argv to execute, run with cwd = script directory, e.g. ["python3", "main.py"]. */
  command: string[];
  /** Extra env vars. */
  env?: Record<string, string>;
  /** Directory of the script (filled in by loader). */
  dir: string;
}

export type ScriptRunStatus = 'running' | 'exited' | 'failed' | 'stopped';

export interface ScriptRunInfo {
  runId: string;
  scriptId: string;
  index: number;
  serial: string;
  pid?: number;
  status: ScriptRunStatus;
  exitCode?: number | null;
  startedAt: string;
  endedAt?: string;
  logFile: string;
}

// ───────────────────────────── Screen / input ─────────────────────────────

export interface ScreenFrame {
  /** PNG bytes when format === 'png', raw pixels otherwise. */
  data: Buffer;
  format: 'png' | 'rgba8888' | 'rgb888';
  width: number;
  height: number;
  seq?: number;
  timestampUs?: number;
}

export interface TouchPoint {
  x: number;
  y: number;
  /** Pointer id (0..9). */
  id: number;
  /** 0 = release, >0 = pressed. */
  pressure: number;
}

export type KeyEventType = 'keydown' | 'keyup' | 'keypress';

// ───────────────────────────── Manager API inputs ─────────────────────────────

export interface CreateOptions {
  count: number;
  /** Display name prefix; instances are named "<prefix>-<index>". Default "实例". */
  namePrefix?: string;
  /** System image package path; default settings.defaultImage. */
  image?: string;
  spec?: Partial<InstanceSpec>;
  autoRestart?: boolean;
  identity?: DeviceIdentityInput;
}

export interface CloneOptions {
  count: number;
  namePrefix?: string;
  /** Keep Quick Boot snapshots in the clone (default false → first boot is a cold boot). */
  keepSnapshots?: boolean;
  /** Defaults to new random identifiers when the source has managed identifiers. */
  identity?: DeviceIdentityInput;
}

export interface UpdateOptions {
  name?: string;
  notes?: string;
  autoRestart?: boolean;
  spec?: Partial<InstanceSpec>;
  identity?: DeviceIdentityInput;
}

export interface StartOptions {
  /** Wait until boot completed (default false). */
  wait?: boolean;
  timeoutMs?: number;
  /** Override spec.headless for this launch only. */
  headless?: boolean;
  /** Bypass maxRunning / memory admission checks. */
  force?: boolean;
}

export interface StopOptions {
  /** Skip graceful console kill, send SIGKILL. */
  force?: boolean;
  timeoutMs?: number;
}

// ───────────────────────────── Events ─────────────────────────────

export interface ManagerEventMap {
  /** An instance's computed state changed (status, pid, boot). */
  'instance-state': [state: InstanceState];
  /** Registry changed (create/clone/delete/update). */
  'instances-changed': [];
  /** Script run started/finished. */
  'script-run': [run: ScriptRunInfo];
  /** Line of output from a script run. */
  'script-output': [runId: string, line: string];
  /** SDK install progress. */
  'sdk-progress': [progress: InstallProgress];
  /** Informational log line for UIs. */
  'log': [entry: { level: 'info' | 'warn' | 'error'; message: string; index?: number; at: string }];
}
