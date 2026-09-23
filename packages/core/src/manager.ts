import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { constants as fsConstants, promises as fsp } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Adb, type AdbDevice } from './adb.js';
import { ensureAndroidId } from './android-id.js';
import {
  avdConfigFor,
  avdDirFor,
  avdIniFor,
  clearSnapshotStale,
  cloneAvd,
  createAvd,
  deleteAvd,
  hasQuickBootSnapshot,
  isSnapshotStale,
  markSnapshotStale,
  purgeRetiredAvds,
  quarantineAvd,
  quickBootSnapshotSavedAt,
  restoreRetiredAvd,
  retireAvd,
  updateAvdConfig,
} from './avd/avdfiles.js';
import { DEFAULT_SDK_PACKAGES, MAX_INSTANCES, avdNameFor } from './constants.js';
import { consoleKill } from './emulator/console.js';
import { listRunningEmulators } from './emulator/discovery.js';
import { getSupportedFlags, planLaunch, portsFor, spawnEmulator } from './emulator/launcher.js';
import { AvdmError, isAvdmError } from './errors.js';
import { EmulatorGrpc, fitScreenshotBox } from './grpc.js';
import { ensureBuildProfile } from './build-profile.js';
import { ensureWifiMac, resolveIdentity } from './identity.js';
import { getHostStats } from './host.js';
import { defaultHome, resolvePaths } from './paths.js';
import { Registry } from './registry.js';
import { ScriptRunner, type ScriptTarget } from './scripts.js';
import { fetchCatalog as fetchRemoteCatalog, findPackage, selectArchive } from './sdk/catalog.js';
import { acceptLicense, installPackage, isLicenseAccepted } from './sdk/installer.js';
import { findInstalledImage, locateSdk } from './sdk/locate.js';
import { loadSettings, saveSettings, validateSpec } from './settings.js';
import type {
  CloneOptions,
  CreateOptions,
  DiscoveryEntry,
  HostStats,
  InstallProgress,
  InstancePorts,
  InstanceRecord,
  InstanceSpec,
  InstanceState,
  InstanceStatus,
  ManagerEventMap,
  ManagerPaths,
  RemotePackage,
  RunRecord,
  ScriptManifest,
  ScriptRunInfo,
  SdkCatalog,
  SdkInfo,
  Settings,
  StartOptions,
  StopOptions,
  UpdateOptions,
} from './types.js';
import { ensureDir, isLockHeld, pathExists, tailFile, withFileLock } from './util/fs.js';
import { execFileText, isPidAlive, isPidStartedBy, sleep } from './util/proc.js';

/** Default display-name prefix for new instances ("实例-3"). */
const DEFAULT_NAME_PREFIX = '实例';
/** Instance names are written into config.ini (avd.ini.displayname) and shown in UIs. */
const NAME_MAX_CHARS = 64;
/** A stop request this much older than its graceful budget, with the emulator still up, was abandoned. */
const STALE_STOP_GRACE_MS = 45_000;
/**
 * A boot that is overdue but whose probes cannot give a definitive answer (gRPC and adb unreachable, or gRPC
 * says booted while adb is still offline) is only called a boot timeout after staying so this long.
 */
const BOOT_DOUBT_GRACE_MS = 30_000;
/** stop(): extra boot probes (spaced 1.5 s) before deciding that an instance never finished booting. */
const STOP_BOOT_PROBES = 3;
/** Clone / delete hold a per-instance lock; others wait this long for it. */
const BUSY_LOCK_WAIT_MS = 30_000;
/** gRPC getStatus deadline used for boot checks (then adb fallback). */
const BOOT_CHECK_GRPC_TIMEOUT_MS = 1500;
/** Default graceful stop timeout (Quick Boot snapshot save can take a while). */
const DEFAULT_STOP_TIMEOUT_MS = 60_000;
/** After spawning, watch this long for an immediate exit (bad AVD, port taken…) before reporting success. */
const EARLY_EXIT_WATCH_MS = 1000;
/** Auto-restart budget: at most AUTO_RESTART_MAX restarts per AUTO_RESTART_WINDOW_MS per instance. */
const AUTO_RESTART_MAX = 3;
const AUTO_RESTART_WINDOW_MS = 10 * 60_000;
/** dispose() waits this long for the monitor's in-flight tick / auto-restarts (launch lock timeout is 120s). */
const DISPOSE_MONITOR_WAIT_MS = 130_000;
/** A fetched SDK catalog is reused by plan/install for this long. */
const CATALOG_TTL_MS = 10 * 60_000;
/** Log lines of the last launch quoted in crash / early-exit errors. */
const ERROR_LOG_LINES = 8;

const STATUS_LABELS: Record<InstanceStatus, string> = {
  stopped: '已停止',
  starting: '启动中',
  booting: '开机中',
  running: '运行中',
  stopping: '停止中',
  error: '异常',
};

/** Human (Chinese) label of an instance status. */
export function statusLabel(status: InstanceStatus): string {
  return STATUS_LABELS[status] ?? status;
}

/** Internal result of computing one instance's state. */
interface Inspection {
  state: InstanceState;
  entry?: DiscoveryEntry;
  run?: RunRecord;
  /** Some process of this instance (discovery entry or launched pid) is alive. */
  alive: boolean;
}

interface Snapshot {
  records: InstanceRecord[];
  entries: DiscoveryEntry[];
  runs: Map<number, RunRecord | undefined>;
}

interface CachedClient {
  pid: number;
  port: number;
  token?: string;
  client: EmulatorGrpc;
}

type Writable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * Boot probe result: 'yes' = gRPC (if reachable) and adb agree the guest booted; 'no' = a definitive "not yet";
 * 'pending' = gRPC says booted but adb cannot reach the device yet (right after a snapshot load, or a VM
 * restored from a broken snapshot); 'unknown' = neither gRPC nor adb answered.
 */
type BootProbe = 'yes' | 'no' | 'pending' | 'unknown';

/** Fraction of configured guest RAM a cold-booted instance keeps resident (HVF allocates lazily; 3 GB → ~1.1 GB). */
export const RESIDENT_FRACTION = 0.6;
/**
 * Fraction for an instance that resumes a Quick Boot snapshot: the guest RAM comes back from the snapshot
 * (measured 3 GB → ~2.3 GB footprint, mostly dirty/compressed pages that vm_stat still reports as "inactive").
 */
export const QUICK_BOOT_RESIDENT_FRACTION = 0.8;

export function expectedResidentMb(ramMb: number, opts: { quickBoot?: boolean } = {}): number {
  return Math.round(ramMb * (opts.quickBoot ? QUICK_BOOT_RESIDENT_FRACTION : RESIDENT_FRACTION));
}

/**
 * The single entry point used by the CLI and the Electron app.
 *
 * State model (see docs/DESIGN.md §manager): an instance's status is *computed*, never trusted from disk:
 *   discovery entry with avd.id (older builds: avd.name) === record.avdName and live pid  → process up
 *     (an entry that names another AVD dir — another AVDM_HOME uses the same names and ports — is never ours
 *      unless its pid is the one we launched; without avd.dir: our launched pid or our console port)
 *     → boot completed? (gRPC getStatus().booted AND adb getprop sys.boot_completed; adb alone if gRPC is
 *       unreachable) → 'running' : 'booting'
 *     → run record has stopRequestedAt → 'stopping' ('error' "停止未完成" once far past the stop's budget)
 *   no discovery entry but run record pid alive (and started before the record: pids get recycled)
 *     → 'starting' (or 'stopping' if stop requested)
 *   run record present, pid dead, stop requested → clear run record → 'stopped'
 *   run record present, pid dead, the emulator registered and removed its own discovery file (orderly exit:
 *     window closed, `adb emu kill`, guest power-off) → clear run record → 'stopped'
 *   run record present, pid dead otherwise → 'error' (crash; error = last lines of instance log)
 *   otherwise 'stopped'
 *   booting longer than settings.bootTimeoutSec → 'error' ("启动超时"; probes that cannot answer get a grace period)
 *
 * IMPLEMENTER: agent "core-manager".
 */
export class AvdManager extends EventEmitter<ManagerEventMap> {
  readonly paths!: ManagerPaths;
  readonly registry!: Registry;
  readonly scripts!: ScriptRunner;

  private settings!: Settings;
  private sdk: SdkInfo | undefined;
  private sdkLoading: Promise<SdkInfo> | undefined;
  private catalog: { value: SdkCatalog; at: number } | undefined;
  private adbClient: Adb | undefined;
  private readonly clients = new Map<number, CachedClient>();
  /** index → pid whose boot completion was already observed (boot never "un-completes" for a pid). */
  private readonly bootCache = new Map<number, number>();
  private readonly identityApplying = new Map<number, Promise<void>>();
  private readonly identityErrors = new Map<number, string>();
  /** index → cached crash message for a given run (avoids re-reading the log on every poll). */
  private readonly crashNotes = new Map<number, { key: string; message: string }>();
  /** index → cached boot-timeout hint for a given run. */
  private readonly hintNotes = new Map<number, { key: string; message: string }>();
  /** index → last observed state signature/status, for change events. */
  private readonly lastSeen = new Map<number, { sig: string; status: InstanceStatus }>();
  /** In-flight launches / stops of this process, per index. */
  private readonly launching = new Map<number, Promise<InstanceState>>();
  private readonly stopping = new Map<number, Promise<void>>();
  /** Instances currently used as a clone source (refcount). */
  private readonly cloneSources = new Map<number, number>();
  /** Control block of an in-flight stop of this process (force can be escalated while it runs). */
  private readonly stopCtl = new Map<number, { force: boolean; pids: number[] }>();
  /** index → since when (for which pid) an overdue boot got only non-definitive probe answers. */
  private readonly bootDoubt = new Map<number, { pid: number; since: number }>();
  /** Instances whose stop request was abandoned (reported as error, not auto-restarted). */
  private readonly staleStops = new Set<number>();
  /** avdHome as configured plus its realpath (a symlinked AVDM_HOME makes the emulator report either). */
  private avdHomes: string[] = [];
  private readonly restartHistory = new Map<number, number[]>();
  private readonly restartGaveUp = new Set<number>();
  private readonly autoRestarting = new Set<number>();
  /** In-flight auto-restarts started by the monitor (awaited by dispose()). */
  private readonly autoRestartTasks = new Set<Promise<void>>();
  /** The monitor tick currently running, if any (awaited by dispose()). */
  private monitorRun: Promise<void> | undefined;
  private monitorTimer: NodeJS.Timeout | undefined;
  private monitorIntervalMs = 0;
  private monitorBusy = false;
  private lastMonitorError: string | undefined;
  private disposed = false;

  /** Open (creating dirs as needed) the manager at `home` (default ~/.avdm or $AVDM_HOME). */
  static async open(opts: { home?: string } = {}): Promise<AvdManager> {
    const paths = resolvePaths(path.resolve(expandHome(opts.home ?? defaultHome())));
    await Promise.all(
      [
        paths.home,
        paths.avdHome,
        paths.logsDir,
        paths.scriptLogsDir,
        paths.runDir,
        paths.scriptsDir,
        paths.downloadsDir,
      ].map((d) => ensureDir(d)),
    );
    let settings: Settings;
    try {
      settings = await loadSettings(paths);
    } catch (err) {
      throw new AvdmError(
        'INVALID_ARGUMENT',
        `设置文件无法读取: ${paths.settingsFile}（${errorMessage(err)}），请修复或删除该文件`,
      );
    }
    const manager = new AvdManager();
    const realAvdHome = await fsp.realpath(paths.avdHome).catch(() => paths.avdHome);
    manager.init(paths, settings, await locateSdk(settings.sdkRoot));
    manager.avdHomes = [...new Set([paths.avdHome, realAvdHome])];
    return manager;
  }

  private init(paths: ManagerPaths, settings: Settings, sdk: SdkInfo): void {
    const self = this as Writable<Pick<AvdManager, 'paths' | 'registry' | 'scripts'>>;
    self.paths = paths;
    this.avdHomes = [paths.avdHome];
    self.registry = new Registry(paths);
    self.scripts = new ScriptRunner(
      paths,
      { adbBin: sdk.adb?.bin, sdkRoot: sdk.root },
      {
        onRun: (run) => this.emit('script-run', run),
        onOutput: (runId, line) => this.emit('script-output', runId, line),
      },
    );
    this.settings = settings;
    this.setSdk(sdk);
  }

  // ───────────────────────────── settings & SDK ─────────────────────────────

  getSettings(): Settings {
    return structuredClone(this.settings);
  }

  async updateSettings(patch: Partial<Settings>): Promise<Settings> {
    const before = this.settings;
    this.settings = await saveSettings(this.paths, patch);
    await this.afterSettingsChange(before);
    return this.getSettings();
  }

  /** Re-scan the SDK on disk (cached until next call). */
  async refreshSdk(): Promise<SdkInfo> {
    const loading = locateSdk(this.settings.sdkRoot).then((sdk) => {
      this.setSdk(sdk);
      return sdk;
    });
    this.sdkLoading = loading;
    try {
      return await loading;
    } finally {
      if (this.sdkLoading === loading) this.sdkLoading = undefined;
    }
  }

  /** Last scanned SDK info (scans if never scanned). */
  async getSdk(): Promise<SdkInfo> {
    if (this.sdkLoading) return this.sdkLoading;
    if (this.sdk) return this.sdk;
    return this.refreshSdk();
  }

  async fetchCatalog(): Promise<SdkCatalog> {
    const value = await fetchRemoteCatalog();
    this.catalog = { value, at: Date.now() };
    return value;
  }

  /**
   * Resolve package paths against the catalog (stable channel, host archive). Returns the packages and the
   * licenses they need (id → text) plus which of those are not yet accepted.
   */
  async planSdkInstall(pkgPaths: string[]): Promise<SdkInstallPlan> {
    const wanted = uniqueStrings(pkgPaths?.length ? pkgPaths : DEFAULT_SDK_PACKAGES);
    const catalog = await this.cachedCatalog();
    const sdk = await this.getSdk();
    const packages: RemotePackage[] = [];
    const missing: string[] = [];
    for (const p of wanted) {
      const pkg = findPackage(catalog, p);
      if (pkg) packages.push(pkg);
      else missing.push(p);
    }
    const licenses: Record<string, string> = {};
    for (const pkg of packages) {
      if (pkg.licenseId && !(pkg.licenseId in licenses)) licenses[pkg.licenseId] = catalog.licenses[pkg.licenseId] ?? '';
    }
    const unaccepted: string[] = [];
    for (const [id, text] of Object.entries(licenses)) {
      if (!(await isLicenseAccepted(sdk.root, id, text))) unaccepted.push(id);
    }
    const totalBytes = packages.reduce((sum, pkg) => sum + (selectArchive(pkg)?.size ?? 0), 0);
    return { packages, licenses, unaccepted, missing, totalBytes };
  }

  /**
   * Record user consent for licenses (ONLY call after the user explicitly accepted in the UI/CLI).
   * Consent is recorded for the text the user was shown: pass it as `shownTexts` (id → text, e.g.
   * `plan.licenses`); otherwise the catalog last used by planSdkInstall() is taken as shown — never a silently
   * re-fetched one (the TTL does not apply here). A shown text that differs from the repository's current one is
   * refused (LICENSE_NOT_ACCEPTED) rather than recorded.
   */
  async acceptLicenses(licenseIds: string[], shownTexts?: Record<string, string>): Promise<void> {
    const ids = uniqueStrings(licenseIds ?? []);
    if (ids.length === 0) return;
    const catalog = this.catalog?.value ?? (await this.fetchCatalog());
    const sdk = await this.getSdk();
    for (const id of ids) {
      const text = catalog.licenses[id];
      if (!text) throw new AvdmError('INVALID_ARGUMENT', `SDK 仓库清单中没有许可 "${id}"，无法记录同意`);
      const shown = shownTexts?.[id];
      if (shown !== undefined && shown !== text) {
        throw new AvdmError(
          'LICENSE_NOT_ACCEPTED',
          `许可 ${id} 的内容与你阅读的版本不一致（SDK 仓库清单可能已更新），请重新阅读后再同意`,
          { licenseIds: [id] },
        );
      }
      await acceptLicense(sdk.root, id, text);
    }
    await this.refreshSdk();
  }

  /** Install packages sequentially, emitting 'sdk-progress'; refreshes SDK afterwards. */
  async installSdkPackages(pkgPaths: string[], opts: { signal?: AbortSignal } = {}): Promise<void> {
    const plan = await this.planSdkInstall(pkgPaths);
    if (plan.missing.length) {
      throw new AvdmError(
        'INVALID_ARGUMENT',
        `以下组件在 SDK 仓库中不存在或没有适用于本机的稳定版: ${plan.missing.join(', ')}`,
        { missing: plan.missing },
      );
    }
    if (plan.unaccepted.length) {
      throw new AvdmError(
        'LICENSE_NOT_ACCEPTED',
        `安装前需要先阅读并同意 SDK 许可: ${plan.unaccepted.join(', ')}`,
        { licenseIds: plan.unaccepted },
      );
    }
    await this.assertNotInUse(plan.packages);
    const sdk = await this.getSdk();
    await ensureDir(sdk.root);
    const catalog = await this.cachedCatalog();
    try {
      for (const pkg of plan.packages) {
        if (opts.signal?.aborted) throw new AvdmError('DOWNLOAD_FAILED', '安装已取消');
        await installPackage({
          sdkRoot: sdk.root,
          pkg,
          licenseText: catalog.licenses[pkg.licenseId] ?? '',
          downloadsDir: this.paths.downloadsDir,
          signal: opts.signal,
          onProgress: (p: InstallProgress) => this.emit('sdk-progress', p),
        });
        this.log('info', `已安装 SDK 组件 ${pkg.path}（${pkg.revision}）`);
      }
    } finally {
      await this.refreshSdk().catch(() => undefined);
    }
  }

  // ───────────────────────────── instances ─────────────────────────────

  /** Computed state of every instance, sorted by index. */
  async list(): Promise<InstanceState[]> {
    const snap = await this.snapshot();
    const results = await Promise.all(
      snap.records.map((r) => this.inspect(r, snap.entries, snap.runs.get(r.index), true)),
    );
    const present = new Set(snap.records.map((r) => r.index));
    for (const index of [...this.lastSeen.keys()]) if (!present.has(index)) this.lastSeen.delete(index);
    for (const r of results) this.noteState(r.state);
    return results.map((r) => r.state);
  }

  async getState(index: number): Promise<InstanceState> {
    const record = await this.registry.require(index);
    const [entries, run] = await Promise.all([listRunningEmulators(), this.registry.readRun(index)]);
    const { state } = await this.inspect(record, entries, run, true);
    this.noteState(state);
    return state;
  }

  /** Existing indices (for selector parsing). */
  async indices(): Promise<number[]> {
    return (await this.registry.list()).map((r) => r.index);
  }

  /** Create `count` fresh instances from a system image (image must be installed). */
  async create(opts: CreateOptions): Promise<InstanceRecord[]> {
    const count = assertCount(opts?.count ?? 1);
    await this.reloadSettings();
    const spec = mergeSpec(this.settings.defaultSpec, opts.spec);
    validateSpec(spec);
    const image = String(opts.image ?? this.settings.defaultImage ?? '').trim();
    if (!image) throw new AvdmError('INVALID_ARGUMENT', '未指定系统镜像');
    const sdk = await this.requireImage(image);
    const prefix = namePrefix(opts.namePrefix);
    const createdAt = new Date().toISOString();
    const autoRestart = opts.autoRestart ?? false;

    const identities = new Set<string>();
    const records = await this.registry.allocate(count, (index) => ({
      index,
      name: `${prefix}-${index}`,
      avdName: avdNameFor(index),
      image,
      spec: cloneSpec(spec),
      identity: this.uniqueIdentity(resolveIdentity(opts.identity, index), identities),
      createdAt,
      autoRestart,
      provisioning: true,
    }));
    this.emit('instances-changed');
    const created = new Set<number>();
    try {
      const entries = await listRunningEmulators();
      const done: InstanceRecord[] = [];
      for (const rec of records) {
        await this.prepareSlot(rec, entries);
        await createAvd({ avdHome: this.paths.avdHome, sdk }, rec);
        created.add(rec.index);
        done.push(await this.registry.update(rec.index, finishProvisioning));
      }
      this.log('info', `已创建 ${done.length} 个实例: ${done.map((r) => `#${r.index}`).join(', ')}（镜像 ${image}）`);
      return done;
    } catch (err) {
      await this.rollback(records, created);
      throw err;
    } finally {
      this.emit('instances-changed');
    }
  }

  /** Clone a STOPPED instance (APFS CoW) `count` times. Clones inherit spec and image; data is copied. */
  async clone(sourceIndex: number, opts: CloneOptions): Promise<InstanceRecord[]> {
    const count = assertCount(opts?.count ?? 1);
    const src = await this.registry.require(sourceIndex);
    if (src.provisioning) {
      throw new AvdmError('INVALID_ARGUMENT', `实例 #${sourceIndex} 正在创建或克隆中，暂不能作为克隆源`);
    }
    const prefix = namePrefix(opts.namePrefix);
    this.cloneSources.set(sourceIndex, (this.cloneSources.get(sourceIndex) ?? 0) + 1);
    try {
      if (this.launching.has(sourceIndex)) {
        throw new AvdmError('INSTANCE_RUNNING', `实例 #${sourceIndex} 正在运行，请先停止后再克隆`);
      }
      // The source must stay stopped while it is copied — also against launches from other processes (the
      // desktop app next to the CLI): hold its busy lock for the whole copy and check liveness under the launch
      // lock, so a launch either happened before the check (→ refused here) or sees the busy lock (→ refused there).
      return await this.withInstanceBusy(sourceIndex, '克隆', async () => {
        await this.withLaunchLock(async () => {
          if (this.launching.has(sourceIndex) || (await this.inspectOne(src, false)).alive) {
            throw new AvdmError('INSTANCE_RUNNING', `实例 #${sourceIndex} 正在运行，请先停止后再克隆`);
          }
        });
        const sdk = await this.getSdk();
        const createdAt = new Date().toISOString();
        const identities = new Set<string>();
        const identityInput = opts.identity ?? (src.identity ? 'random' : 'system');
        const records = await this.registry.allocate(count, (index) => ({
          index,
          name: `${prefix}-${index}`,
          avdName: avdNameFor(index),
          image: src.image,
          spec: cloneSpec(src.spec),
          identity: this.uniqueIdentity(resolveIdentity(identityInput, index), identities),
          createdAt,
          clonedFrom: src.index,
          autoRestart: src.autoRestart,
          provisioning: true,
        }));
        this.emit('instances-changed');
        const created = new Set<number>();
        try {
          const entries = await listRunningEmulators();
          const done: InstanceRecord[] = [];
          let method = '';
          for (const rec of records) {
            await this.prepareSlot(rec, entries);
            ({ method } = await cloneAvd({ avdHome: this.paths.avdHome, sdk }, src.avdName, rec, {
              keepSnapshots: opts.keepSnapshots === true,
            }));
            if (rec.identity && JSON.stringify(rec.identity) !== JSON.stringify(src.identity)) {
              await markSnapshotStale(this.paths.avdHome, rec.avdName, 'cloned device identity differs');
            }
            created.add(rec.index);
            done.push(await this.registry.update(rec.index, finishProvisioning));
          }
          this.log(
            'info',
            `已从实例 #${sourceIndex} 克隆 ${done.length} 个实例: ${done.map((r) => `#${r.index}`).join(', ')}` +
              (method === 'apfs-clone' ? '（APFS 写时复制）' : ''),
            sourceIndex,
          );
          return done;
        } catch (err) {
          await this.rollback(records, created);
          throw err;
        } finally {
          this.emit('instances-changed');
        }
      }, 10 * 60_000);
    } finally {
      const n = (this.cloneSources.get(sourceIndex) ?? 1) - 1;
      if (n > 0) this.cloneSources.set(sourceIndex, n);
      else this.cloneSources.delete(sourceIndex);
    }
  }

  /** Update name/notes/autoRestart anytime; spec changes require the instance to be stopped (INSTANCE_RUNNING). */
  async update(index: number, opts: UpdateOptions): Promise<InstanceRecord> {
    const rec = await this.registry.require(index);
    let name: string | undefined;
    if (opts.name !== undefined) name = validateName(String(opts.name).trim());
    let spec: InstanceSpec | undefined;
    if (opts.spec && Object.keys(opts.spec).length > 0) {
      const merged = mergeSpec(rec.spec, opts.spec);
      validateSpec(merged);
      if (!specEquals(merged, rec.spec)) spec = merged;
    }
    if (spec || opts.identity !== undefined) {
      if (rec.provisioning) throw new AvdmError('INVALID_ARGUMENT', `实例 #${index} 正在创建或克隆中，暂不能修改配置`);
      if (spec && spec.dataPartitionGb < rec.spec.dataPartitionGb) {
        throw new AvdmError(
          'INVALID_ARGUMENT',
          `数据盘只能扩容不能缩小（当前 ${rec.spec.dataPartitionGb} GB，目标 ${spec.dataPartitionGb} GB）`,
        );
      }
      // Check-and-write under the launch lock so a start from another process cannot slip in between.
      return this.withLaunchLock(() => this.applyUpdate(rec, opts, name, spec));
    }
    return this.applyUpdate(rec, opts, name, undefined);
  }

  private async applyUpdate(
    rec: InstanceRecord,
    opts: UpdateOptions,
    name: string | undefined,
    spec: InstanceSpec | undefined,
  ): Promise<InstanceRecord> {
    const index = rec.index;
    const alive = this.launching.has(index) || (await this.inspectOne(rec, false)).alive;
    if ((spec || opts.identity !== undefined) && alive) throw new AvdmError('INSTANCE_RUNNING', `实例 #${index} 正在运行，修改硬件或设备标识前请先停止`);
    const identity = opts.identity === undefined ? undefined : resolveIdentity(opts.identity, index);
    const apply = (cur: InstanceRecord): InstanceRecord => {
      if (name !== undefined) cur.name = name;
      if (spec) cur.spec = cloneSpec(spec);
      if (opts.identity !== undefined) {
        if (identity) cur.identity = identity;
        else delete cur.identity;
      }
      if (opts.notes !== undefined) {
        const notes = String(opts.notes ?? '');
        if (notes.trim()) cur.notes = notes;
        else delete cur.notes;
      }
      if (opts.autoRestart !== undefined) cur.autoRestart = Boolean(opts.autoRestart);
      return cur;
    };
    const next = apply(structuredClone(rec));
    const ctx = { avdHome: this.paths.avdHome, sdk: await this.getSdk() };
    const nameChanged = next.name !== rec.name;
    // config.ini carries the spec and the display name; only rewrite it while no emulator is using it.
    if (spec || (nameChanged && !alive && !rec.provisioning)) {
      try {
        await updateAvdConfig(ctx, next);
      } catch (err) {
        if (spec) throw err; // a cosmetic display-name sync must not block a rename
      }
    }
    let saved: InstanceRecord;
    try {
      saved = await this.registry.update(index, apply);
    } catch (err) {
      if (spec) await updateAvdConfig(ctx, rec).catch(() => undefined);
      throw err;
    }
    if (opts.identity !== undefined) {
      await markSnapshotStale(this.paths.avdHome, rec.avdName, 'device identity changed').catch(() => undefined);
      this.identityErrors.delete(index);
    } else if (spec && spec.bootMode !== rec.spec.bootMode) {
      // Cold-boot sessions never save a snapshot, so an existing one is older than the disk from now on.
      await markSnapshotStale(this.paths.avdHome, rec.avdName, 'boot mode changed').catch(() => undefined);
    }
    this.emit('instances-changed');
    return saved;
  }

  /** Delete instance + AVD files. Running → INSTANCE_RUNNING unless force (then stop first). */
  async remove(index: number, opts: { force?: boolean } = {}): Promise<void> {
    const rec = await this.registry.require(index);
    if (this.cloneSources.has(index)) {
      throw new AvdmError('INVALID_ARGUMENT', `实例 #${index} 正在被克隆，请稍后再删除`);
    }
    const alive = this.launching.has(index) || (await this.inspectOne(rec, false)).alive;
    if (alive) {
      if (!opts.force) {
        throw new AvdmError('INSTANCE_RUNNING', `实例 #${index} 正在运行，请先停止（或使用强制删除）`);
      }
      await this.stop(index, { force: true });
    }
    await this.withInstanceBusy(index, '删除', async () => {
      // Re-check under the launch lock (another process may have started it meanwhile), then take the AVD out
      // of service in the same critical section: a later launch finds no AVD instead of a half-deleted one, and
      // a crash from here on leaves a recognisable `.deleting-*` dir rather than an unknown AVD.
      const retired = await this.withLaunchLock(async () => {
        if (this.launching.has(index) || (await this.inspectOne(rec, false)).alive) {
          throw new AvdmError('INSTANCE_RUNNING', `实例 #${index} 刚被启动，已取消删除（请先停止）`);
        }
        return retireAvd(this.paths.avdHome, rec.avdName);
      });
      await this.scripts.stopAll(index).catch(() => undefined);
      try {
        await this.registry.remove(index);
      } catch (err) {
        if (retired) await restoreRetiredAvd(this.paths.avdHome, rec.avdName, retired).catch(() => undefined);
        throw err;
      }
      this.forgetRuntime(index);
      this.lastSeen.delete(index);
      this.restartHistory.delete(index);
      this.restartGaveUp.delete(index);
      try {
        await deleteAvd(this.paths.avdHome, rec.avdName);
        await this.removeLogs(index);
      } finally {
        this.emit('instances-changed');
      }
    });
    this.log('info', `已删除实例 #${index}（${rec.name}）`, index);
  }

  /**
   * Launch. No-op if already starting/booting/running. Admission control unless opts.force:
   * running count < settings.maxRunning, memory pressure not 'critical' (nor 'warn' with swap in use while
   * another instance runs), and host availableMem - pending - expectedResident(spec) >= settings.memoryReserveMb
   * (expectedResident = RESIDENT_FRACTION × ramMb for a cold boot, QUICK_BOOT_RESIDENT_FRACTION × ramMb when a
   * Quick Boot snapshot will be resumed) (AvdmError('ADMISSION_DENIED') with a Chinese explanation otherwise).
   * A start of an instance whose stop request was abandoned (status error "停止未完成") withdraws that request.
   */
  async start(index: number, opts: StartOptions = {}): Promise<InstanceState> {
    const stopping = this.stopping.get(index);
    if (stopping) await stopping.catch(() => undefined);
    let launch = this.launching.get(index);
    if (!launch) {
      launch = this.launch(index, opts).finally(() => this.launching.delete(index));
      this.launching.set(index, launch);
    }
    const state = await launch;
    // A CLI process exits immediately after start(); managed MACs must be applied before it exits.
    if (opts.wait || state.record.identity) return this.waitForBoot(index, opts.timeoutMs);
    return state;
  }

  /**
   * Graceful stop: mark stop requested → console `kill` → wait for pid exit (timeoutMs default 60s,
   * Quick Boot snapshot save can take a while) → SIGTERM → SIGKILL. force → SIGKILL immediately.
   * An instance that has not finished booting is killed right away (SIGKILL): a console `kill` would save a
   * half-booted VM as its Quick Boot snapshot, which then fails to load on every later start.
   * A force stop arriving while a graceful stop of the same instance is in flight escalates it (SIGKILL now).
   * Also stops script runs targeting this instance.
   */
  async stop(index: number, opts: StopOptions = {}): Promise<void> {
    let p = this.stopping.get(index);
    if (!p) {
      p = this.doStop(index, opts).finally(() => this.stopping.delete(index));
      this.stopping.set(index, p);
    } else if (opts.force) {
      this.escalateStop(index);
    }
    return p;
  }

  /** Turn an in-flight graceful stop into a force stop: SIGKILL the known pids now. */
  private escalateStop(index: number): void {
    const ctl = this.stopCtl.get(index);
    if (!ctl || ctl.force) return;
    ctl.force = true;
    for (const pid of ctl.pids) signalTree(pid, 'SIGKILL');
  }

  async restart(index: number, opts?: StartOptions): Promise<InstanceState> {
    await this.stop(index);
    return this.start(index, opts);
  }

  /** Resolve when status === 'running'; throws BOOT_TIMEOUT / INSTANCE_NOT_RUNNING (if it dies). */
  async waitForBoot(index: number, timeoutMs?: number): Promise<InstanceState> {
    const limit = timeoutMs ?? this.settings.bootTimeoutSec * 1000;
    const deadline = Date.now() + limit;
    for (;;) {
      const state = await this.getState(index);
      switch (state.status) {
        case 'running':
          await this.ensureManagedIdentity(state);
          return state;
        case 'stopped':
          throw new AvdmError('INSTANCE_NOT_RUNNING', `实例 #${index} 未运行`);
        case 'stopping':
          throw new AvdmError('INSTANCE_NOT_RUNNING', `实例 #${index} 正在停止`);
        case 'error':
          if (state.pid !== undefined && isPidAlive(state.pid)) {
            throw new AvdmError('BOOT_TIMEOUT', `实例 #${index} ${state.error ?? '启动超时'}`, { state });
          }
          throw new AvdmError('INSTANCE_NOT_RUNNING', `实例 #${index} 启动失败: ${state.error ?? '模拟器进程已退出'}`, {
            state,
          });
        default:
          break;
      }
      if (Date.now() >= deadline) {
        throw new AvdmError('BOOT_TIMEOUT', `实例 #${index} 在 ${Math.round(limit / 1000)} 秒内未完成开机`, { state });
      }
      await sleep(Math.min(500, Math.max(50, deadline - Date.now())));
    }
  }

  /**
   * Run `fn` for each index with bounded concurrency (default 3 — emulator boot is CPU heavy),
   * collecting per-index results; never throws.
   */
  async batch<T>(
    indices: number[],
    fn: (index: number) => Promise<T>,
    opts?: { concurrency?: number },
  ): Promise<Array<{ index: number; ok: true; value: T } | { index: number; ok: false; error: Error }>> {
    type Result = { index: number; ok: true; value: T } | { index: number; ok: false; error: Error };
    const list = [...indices];
    const results = new Array<Result>(list.length);
    const concurrency = Math.max(1, Math.floor(Number(opts?.concurrency ?? 3)) || 1);
    let next = 0;
    const worker = async () => {
      while (next < list.length) {
        const pos = next++;
        const index = list[pos]!;
        try {
          results[pos] = { index, ok: true, value: await fn(index) };
        } catch (err) {
          results[pos] = { index, ok: false, error: err instanceof Error ? err : new Error(String(err)) };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
    return results;
  }

  // ───────────────────────────── device access ─────────────────────────────

  /** Shared Adb (SDK platform-tools); throws ADB_MISSING. */
  async adb(): Promise<Adb> {
    let sdk = await this.getSdk();
    if (!sdk.adb) sdk = await this.refreshSdk();
    const bin = sdk.adb?.bin;
    if (!bin) {
      throw new AvdmError('ADB_MISSING', '未找到 adb（platform-tools），请先运行 `avdm sdk install platform-tools` 安装');
    }
    if (!this.adbClient || this.adbClient.bin !== bin) this.adbClient = new Adb(bin);
    return this.adbClient;
  }

  /** AdbDevice for an instance (serial emulator-<console>). */
  async device(index: number): Promise<AdbDevice> {
    const record = await this.registry.require(index);
    const [entries, run] = await Promise.all([listRunningEmulators(), this.registry.readRun(index)]);
    const entry = this.matchEntry(record, entries, run);
    const ports = entry ? portsFromEntry(entry, portsFor(index)) : portsFor(index);
    return (await this.adb()).device(ports.serial);
  }

  /** Cached gRPC client for a running instance (uses discovery grpc.port/token). Throws INSTANCE_NOT_RUNNING. */
  async grpc(index: number): Promise<EmulatorGrpc> {
    const record = await this.registry.require(index);
    const [entries, run] = await Promise.all([listRunningEmulators(), this.registry.readRun(index)]);
    const entry = this.matchEntry(record, entries, run);
    if (!entry) throw new AvdmError('INSTANCE_NOT_RUNNING', `实例 #${index} 未运行`);
    return this.clientFor(index, entry);
  }

  /** PNG screenshot scaled to `width` (gRPC first, adb screencap fallback). */
  async screenshot(index: number, opts: { width?: number } = {}): Promise<Buffer> {
    const record = await this.registry.require(index);
    const [entries, run] = await Promise.all([listRunningEmulators(), this.registry.readRun(index)]);
    const entry = this.matchEntry(record, entries, run);
    if (!entry) throw new AvdmError('INSTANCE_NOT_RUNNING', `实例 #${index} 未运行，无法截图`);
    // The emulator ignores a width without a height: ask for a box with the panel's aspect ratio.
    const box = fitScreenshotBox({ width: opts.width }, { width: record.spec.width, height: record.spec.height });
    let grpcError: unknown;
    try {
      const frame = await this.clientFor(index, entry).getScreenshot({ format: 'png', ...box });
      if (frame.format === 'png' && isPng(frame.data)) return frame.data;
      grpcError = new Error('gRPC 返回的截图不是 PNG');
    } catch (err) {
      grpcError = err;
    }
    try {
      return await (await this.adb()).device(portsFromEntry(entry, portsFor(index)).serial).screencapPng();
    } catch (err) {
      throw new AvdmError(
        'COMMAND_FAILED',
        `实例 #${index} 截图失败: ${errorMessage(err)}（gRPC: ${errorMessage(grpcError)}）`,
      );
    }
  }

  /** Install APK(s) on an instance (must be running). */
  async installApk(index: number, apkPaths: string[]): Promise<string> {
    if (!Array.isArray(apkPaths) || apkPaths.length === 0) throw new AvdmError('INVALID_ARGUMENT', '未指定要安装的 APK');
    const files = apkPaths.map((p) => path.resolve(expandHome(String(p))));
    for (const f of files) {
      const st = await fsp.stat(f).catch(() => undefined);
      if (!st?.isFile()) throw new AvdmError('INVALID_ARGUMENT', `APK 文件不存在: ${f}`);
    }
    const state = await this.requireRunning(index);
    return (await this.adb()).device(state.ports.serial).install(files);
  }

  /** Spawn scrcpy for an instance (detached); throws UNSUPPORTED if scrcpy is not found. */
  async openScrcpy(index: number, extraArgs: string[] = []): Promise<{ pid: number }> {
    const bin = await this.findScrcpy();
    const state = await this.requireRunning(index);
    const adb = await this.adb();
    const args = [
      '-s',
      state.ports.serial,
      '--window-title',
      `${state.record.name} (#${index})`,
      '--no-audio',
      ...extraArgs.map(String),
    ];
    const logFile = path.join(this.paths.logsDir, `scrcpy-${index}.log`);
    await ensureDir(this.paths.logsDir);
    const log = await fsp.open(logFile, 'a');
    try {
      await log.write(`\n=== scrcpy ${new Date().toISOString()} ===\n${[bin, ...args].join(' ')}\n`);
      return await new Promise<{ pid: number }>((resolve, reject) => {
        const child = spawn(bin, args, {
          detached: true,
          stdio: ['ignore', log.fd, log.fd],
          env: { ...process.env, ADB: adb.bin },
        });
        child.once('error', (err) => reject(new AvdmError('COMMAND_FAILED', `启动 scrcpy 失败: ${err.message}`)));
        child.once('spawn', () => {
          child.unref();
          if (child.pid === undefined) reject(new AvdmError('COMMAND_FAILED', '启动 scrcpy 失败: 未获得进程号'));
          else resolve({ pid: child.pid });
        });
      });
    } finally {
      await log.close();
    }
  }

  /** Last lines of the instance's emulator log. */
  async instanceLog(index: number, lines = 200): Promise<string[]> {
    await this.registry.require(index);
    const n = Number.isFinite(lines) && lines > 0 ? Math.floor(lines) : 200;
    return tailFile(this.logFile(index), n);
  }

  // ───────────────────────────── host ─────────────────────────────

  async hostStats(): Promise<HostStats> {
    const snap = await this.snapshot();
    let committed = 0;
    let running = 0;
    const results = await Promise.all(
      snap.records.map((r) => this.inspect(r, snap.entries, snap.runs.get(r.index), false)),
    );
    for (const r of results) {
      if (!r.alive) continue;
      committed += r.state.record.spec.ramMb;
      running++;
    }
    return getHostStats({ committedInstanceRamMb: committed, runningInstances: running });
  }

  // ───────────────────────────── scripts ─────────────────────────────

  async listScripts(): Promise<ScriptManifest[]> {
    return this.scripts.listScripts();
  }

  /** Run a script on running instances only (non-running indices are skipped with a 'log' warn). */
  async runScript(scriptId: string, indices: number[], args: string[] = []): Promise<ScriptRunInfo[]> {
    await this.getSdk(); // make sure the runner knows the current adb
    const states = await this.list();
    const byIndex = new Map(states.map((s) => [s.record.index, s]));
    const targets: ScriptTarget[] = [];
    for (const index of [...new Set(indices)]) {
      const st = byIndex.get(index);
      if (!st) {
        this.log('warn', `实例 #${index} 不存在，已跳过脚本 ${scriptId}`, index);
        continue;
      }
      if (st.status !== 'running') {
        this.log('warn', `实例 #${index} 未运行（${statusLabel(st.status)}），已跳过脚本 ${scriptId}`, index);
        continue;
      }
      const target: ScriptTarget = {
        index,
        name: st.record.name,
        serial: st.ports.serial,
        consolePort: st.ports.console,
        adbPort: st.ports.adb,
        grpcPort: st.ports.grpc,
      };
      if (st.grpcToken) target.grpcToken = st.grpcToken;
      targets.push(target);
    }
    return this.scripts.run(scriptId, targets, args);
  }

  // ───────────────────────────── health monitor ─────────────────────────────

  /**
   * Poll every settings.healthIntervalSec: compute all states, emit 'instance-state' for changes,
   * and auto-restart instances with record.autoRestart whose status became 'error'
   * (max 3 restarts per 10 minutes per instance, emits 'log').
   */
  startMonitor(): void {
    if (this.disposed) throw new AvdmError('INVALID_ARGUMENT', '管理器已释放');
    if (this.monitorTimer) return;
    this.scheduleMonitor();
    setImmediate(() => void this.monitorTick());
  }

  stopMonitor(): void {
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    this.monitorTimer = undefined;
  }

  /**
   * Stop monitor, close gRPC clients, stop script runs started by this process. Does NOT stop emulators.
   * Waits (bounded) for the monitor's in-flight tick and auto-restarts: exiting in the middle of one could leave
   * a launch half done (launch lock held, emulator spawned without a run record).
   */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.stopMonitor();
    const pending: Promise<unknown>[] = [...this.autoRestartTasks];
    if (this.monitorRun) pending.push(this.monitorRun);
    if (pending.length) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.allSettled(pending),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, DISPOSE_MONITOR_WAIT_MS);
        }),
      ]);
      clearTimeout(timer);
    }
    await this.scripts.stopAll().catch(() => undefined);
    for (const c of this.clients.values()) c.client.close();
    this.clients.clear();
  }

  // ───────────────────────────── internals: state ─────────────────────────────

  private async snapshot(): Promise<Snapshot> {
    const records = await this.registry.list();
    const [entries, runList] = await Promise.all([
      listRunningEmulators(),
      Promise.all(records.map((r) => this.registry.readRun(r.index))),
    ]);
    const runs = new Map<number, RunRecord | undefined>();
    records.forEach((r, i) => runs.set(r.index, runList[i]));
    return { records, entries, runs };
  }

  private async inspectOne(record: InstanceRecord, checkBoot: boolean): Promise<Inspection> {
    const [entries, run] = await Promise.all([listRunningEmulators(), this.registry.readRun(record.index)]);
    return this.inspect(record, entries, run, checkBoot);
  }

  /** Our AVD dir for `avdName`, in every spelling the emulator may report (configured and real path). */
  private isOurAvdDir(dir: string | undefined, avdName: string): boolean {
    if (!dir) return false;
    return this.avdHomes.some((home) => samePath(dir, avdDirFor(home, avdName)));
  }

  /** The discovery entry of this instance's emulator, if one is running. */
  private matchEntry(record: InstanceRecord, entries: DiscoveryEntry[], run: RunRecord | undefined): DiscoveryEntry | undefined {
    const ports = portsFor(record.index);
    let best: DiscoveryEntry | undefined;
    let bestScore = 0;
    for (const e of entries) {
      // Real emulators publish the AVD id as `avd.id` and the display name as `avd.name`.
      const nameMatch = e.raw['avd.id'] === record.avdName || e.avdName === record.avdName;
      const pidMatch = run !== undefined && e.pid === run.pid;
      const dirMatch = this.isOurAvdDir(e.avdDir, record.avdName);
      if (!nameMatch && !dirMatch) continue; // a reused pid alone proves nothing
      // Another manager home (AVDM_HOME: the desktop's ~/.avdm next to a CLI/test home) has the same avdm_<i>
      // names AND the same index → port mapping, so name + console port prove nothing. When the emulator tells
      // us its AVD dir (every current build does), that dir decides — unless it is the very process we launched.
      if (e.avdDir && !dirMatch && !pidMatch) continue;
      const score = (pidMatch ? 8 : 0) + (dirMatch ? 4 : 0) + (e.consolePort === ports.console ? 2 : 0) + (nameMatch ? 1 : 0);
      if (score >= 3 && score > bestScore) {
        best = e;
        bestScore = score;
      }
    }
    return best;
  }

  /** The run record's pid is still the process we launched (not dead, not recycled by another program). */
  private async runPidIsOurs(run: RunRecord): Promise<boolean> {
    return isPidStartedBy(run.pid, Date.parse(run.startedAt));
  }

  /** A pending stop request that nobody is completing any more (the requesting process died mid-stop). */
  private isStaleStop(index: number, run: RunRecord | undefined): boolean {
    if (!run?.stopRequestedAt || this.stopping.has(index)) return false;
    const at = Date.parse(run.stopRequestedAt);
    const budget = (run.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS) + STALE_STOP_GRACE_MS;
    return Number.isFinite(at) && Date.now() - at > budget;
  }

  private staleStopMessage(run: RunRecord): string {
    // Stable text (no running counter): the state signature must not change on every poll.
    const at = new Date(run.stopRequestedAt!).toLocaleString('zh-CN', { hour12: false });
    return `停止未完成：已于 ${at} 请求停止，但模拟器仍在运行（发起停止的进程可能已退出）。请重新停止，或直接启动以继续使用`;
  }

  private async inspect(
    record: InstanceRecord,
    entries: DiscoveryEntry[],
    run: RunRecord | undefined,
    checkBoot: boolean,
  ): Promise<Inspection> {
    const index = record.index;
    const base = portsFor(index);
    const entry = this.matchEntry(record, entries, run);
    const state: InstanceState = { record, ports: base, status: 'stopped', bootCompleted: false };
    if (run?.startedAt) state.startedAt = run.startedAt;
    const bootTimeoutMs = this.settings.bootTimeoutSec * 1000;
    const startedMs = run ? Date.parse(run.startedAt) : Number.NaN;
    const overdue = Number.isFinite(startedMs) && Date.now() - startedMs > bootTimeoutMs;
    this.staleStops.delete(index);

    if (entry) {
      state.ports = portsFromEntry(entry, base);
      state.pid = entry.pid;
      if (entry.grpcToken) state.grpcToken = entry.grpcToken;
      if (run && run.pid === entry.pid && run.discoveryFile !== entry.file) run = await this.noteRegistered(index, run, entry);
      const cachedBoot = this.bootCache.get(index) === entry.pid;
      if (run?.stopRequestedAt) {
        state.bootCompleted = cachedBoot;
        if (this.isStaleStop(index, run)) {
          this.staleStops.add(index);
          state.status = 'error';
          state.error = this.staleStopMessage(run);
        } else state.status = 'stopping';
      } else {
        const probe: BootProbe = cachedBoot ? 'yes' : checkBoot ? await this.probeBoot(index, entry, state.ports) : 'unknown';
        state.bootCompleted = probe === 'yes';
        if (probe === 'yes') {
          state.status = 'running';
          this.bootDoubt.delete(index);
        } else if (overdue && checkBoot && this.bootTimedOut(index, entry.pid, probe)) {
          state.status = 'error';
          state.error = `启动超时：超过 ${this.settings.bootTimeoutSec} 秒仍未完成开机` + (await this.bootFailureHint(index, run));
        } else state.status = 'booting';
      }
      return { state, entry, run, alive: true };
    }

    if (run && isPidAlive(run.pid) && (await this.runPidIsOurs(run))) {
      state.pid = run.pid;
      if (run.stopRequestedAt) {
        if (this.isStaleStop(index, run)) {
          this.staleStops.add(index);
          state.status = 'error';
          state.error = this.staleStopMessage(run);
        } else state.status = 'stopping';
      } else if (run.discoveryFile && !(await pathExists(run.discoveryFile))) {
        // It had registered and withdrew its discovery file: the emulator is shutting down on its own
        // (window closed, `adb emu kill`…) and is still saving its snapshot.
        state.status = 'stopping';
      } else if (run.discoveryFile) {
        // Registered before and its file is still there, just not readable in this scan (being rewritten):
        // a transient miss, not a boot timeout.
        state.status = 'booting';
      } else if (overdue) {
        state.status = 'error';
        state.error = `启动超时：超过 ${this.settings.bootTimeoutSec} 秒模拟器仍未就绪`;
      } else state.status = 'starting';
      return { state, run, alive: true };
    }

    if (run) {
      if (run.stopRequestedAt) {
        await this.clearRunIfSame(index, run);
        return { state, alive: false };
      }
      if (await this.exitedInOrder(index, run)) {
        // Window closed, `adb emu kill`, guest power-off…: a deliberate shutdown, not a crash.
        if (await this.clearRunIfSame(index, run)) {
          await this.noteOrderlyExit(record, run);
          this.log('info', `实例 #${index}（${record.name}）的模拟器已自行正常关闭，状态记为已停止`, index);
        }
        return { state, alive: false };
      }
      state.status = 'error';
      state.error = await this.crashMessage(index, run);
      return { state, run, alive: false };
    }
    return { state, alive: false };
  }

  /** Remember (once) that this run's emulator registered, and where its discovery file is. */
  private async noteRegistered(index: number, run: RunRecord, entry: DiscoveryEntry): Promise<RunRecord> {
    const updated = await this.registry
      .updateRunIf(index, (cur) =>
        sameRun(cur, run) && cur.discoveryFile !== entry.file ? { ...cur, discoveryFile: entry.file } : undefined,
      )
      .catch(() => undefined);
    return updated && sameRun(updated, run) ? updated : { ...run, discoveryFile: entry.file };
  }

  /**
   * The (dead) process of `run` shut down in an orderly way: it had registered and then removed its own discovery
   * file. A crash or kill leaves the file behind; that verdict is persisted (crashedAt) so it survives the file
   * being cleaned up later by another emulator's startup.
   */
  private async exitedInOrder(index: number, run: RunRecord): Promise<boolean> {
    if (run.crashedAt || !run.discoveryFile) return false;
    if (this.crashNotes.get(index)?.key === runKey(run)) return false; // already reported as a crash
    if (!(await pathExists(run.discoveryFile))) return true;
    await this.registry
      .updateRunIf(index, (cur) => (sameRun(cur, run) && !cur.crashedAt ? { ...cur, crashedAt: new Date().toISOString() } : undefined))
      .catch(() => undefined);
    return false;
  }

  /**
   * An emulator session ended in an orderly way. If that session saved its Quick Boot snapshot on the way out
   * (snapshot.pb written after the session started), the snapshot matches the disk again: quick boot is safe.
   * Otherwise (cold-boot session, save disabled or failed, guest power-off…) the marker stays.
   */
  private async noteOrderlyExit(record: InstanceRecord, run: RunRecord | undefined): Promise<void> {
    if (!run || !savesSnapshot(run.argv)) return;
    const savedAt = await quickBootSnapshotSavedAt(this.paths.avdHome, record.avdName);
    const startedAt = Date.parse(run.startedAt);
    if (savedAt !== undefined && Number.isFinite(startedAt) && savedAt >= startedAt) {
      await clearSnapshotStale(this.paths.avdHome, record.avdName).catch(() => undefined);
    }
  }

  /** Overdue boot + this probe answer → is it a boot timeout yet? */
  private bootTimedOut(index: number, pid: number, probe: BootProbe): boolean {
    if (probe === 'no') {
      this.bootDoubt.delete(index);
      return true; // the emulator answered: not booted
    }
    // No definitive answer (probes failing, or adb still offline although gRPC says booted): give it a grace
    // period so one failed probe in a freshly started manager does not turn a healthy instance into an error.
    const doubt = this.bootDoubt.get(index);
    if (!doubt || doubt.pid !== pid) {
      this.bootDoubt.set(index, { pid, since: Date.now() });
      return false;
    }
    return Date.now() - doubt.since >= BOOT_DOUBT_GRACE_MS;
  }

  /** Extra explanation for a boot timeout, from the last launch's log (e.g. a broken Quick Boot snapshot). */
  private async bootFailureHint(index: number, run: RunRecord | undefined): Promise<string> {
    const key = run ? runKey(run) : '';
    const cached = this.hintNotes.get(index);
    if (cached?.key === key) return cached.message;
    const lines = await this.launchLogTail(index, 400).catch(() => [] as string[]);
    const broken = lines.some((l) => /error while loading state|Error -?\d+ while loading VM state|Failed to load snapshot/i.test(l));
    const hint = broken
      ? '。日志显示 Quick Boot 快照加载失败（快照可能已损坏）：停止该实例后再启动，会自动冷启动并重建快照'
      : '';
    this.hintNotes.set(index, { key, message: hint });
    return hint;
  }

  /**
   * Boot check. gRPC getStatus().booted alone is not enough: right after a snapshot load it is true while the adb
   * transport is still offline (and it stays true for a VM restored from a broken snapshot), so 'yes' also needs
   * adb to report sys.boot_completed=1. Without gRPC, adb decides; without adb (no platform-tools), gRPC does.
   */
  private async probeBoot(index: number, entry: DiscoveryEntry, ports: InstancePorts): Promise<BootProbe> {
    let grpcBooted: boolean | undefined;
    try {
      grpcBooted = (await this.clientFor(index, entry).getStatus({ timeoutMs: BOOT_CHECK_GRPC_TIMEOUT_MS })).booted;
    } catch {
      grpcBooted = undefined;
    }
    if (grpcBooted === false) return 'no';
    let adbBooted: boolean | undefined;
    let adbMissing = false;
    try {
      const out = await (await this.adb()).device(ports.serial).shell('getprop sys.boot_completed', { timeoutMs: 5000 });
      adbBooted = out.trim() === '1';
    } catch (err) {
      adbMissing = isAvdmError(err, 'ADB_MISSING');
    }
    let result: BootProbe;
    if (grpcBooted === true) result = adbBooted === true || adbMissing ? 'yes' : 'pending';
    else result = adbBooted === true ? 'yes' : adbBooted === false ? 'no' : 'unknown';
    if (result === 'yes') this.bootCache.set(index, entry.pid);
    return result;
  }

  private clientFor(index: number, entry: DiscoveryEntry): EmulatorGrpc {
    const port = entry.grpcPort ?? portsFor(index).grpc;
    const token = entry.grpcToken;
    const cached = this.clients.get(index);
    if (cached && cached.pid === entry.pid && cached.port === port && cached.token === token) return cached.client;
    cached?.client.close();
    const client = EmulatorGrpc.create(port, token);
    const next: CachedClient = { pid: entry.pid, port, client };
    if (token) next.token = token;
    this.clients.set(index, next);
    return client;
  }

  /** Delete a run record only if it is still the one we looked at (a new launch may have replaced it). */
  private async clearRunIfSame(index: number, run: RunRecord): Promise<boolean> {
    if (this.launching.has(index)) return false;
    return this.registry.clearRunIf(index, (current) => sameRun(current, run)).catch(() => false);
  }

  private async crashMessage(index: number, run: RunRecord): Promise<string> {
    const key = runKey(run);
    const cached = this.crashNotes.get(index);
    if (cached?.key === key) return cached.message;
    const tail = await this.launchLogTail(index, ERROR_LOG_LINES).catch(() => [] as string[]);
    const message =
      `模拟器进程意外退出（pid ${run.pid}）` + (tail.length ? `\n日志末尾:\n${tail.join('\n')}` : '');
    this.crashNotes.set(index, { key, message });
    return message;
  }

  /** Last non-empty lines written by the most recent launch (after the "=== launch" header + command line). */
  private async launchLogTail(index: number, maxLines: number): Promise<string[]> {
    const lines = await tailFile(this.logFile(index), 400);
    let start = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i]!.startsWith('=== launch ')) {
        start = i + 2;
        break;
      }
    }
    return lines
      .slice(start)
      .map((l) => l.trimEnd())
      .filter((l) => l.trim() !== '')
      .slice(-maxLines);
  }

  private noteState(state: InstanceState): void {
    const index = state.record.index;
    const sig = JSON.stringify([
      state.status,
      state.pid ?? null,
      state.bootCompleted,
      state.error ?? null,
      state.ports.console,
    ]);
    const prev = this.lastSeen.get(index);
    this.lastSeen.set(index, { sig, status: state.status });
    if (!prev || prev.sig === sig) return;
    this.emit('instance-state', state);
    if (state.status === 'error' && prev.status !== 'error') {
      this.log('error', `实例 #${index}（${state.record.name}）${firstLine(state.error ?? '状态异常')}`, index);
    }
  }

  /** Drop per-process caches for an instance whose emulator is gone. */
  private forgetRuntime(index: number): void {
    this.bootCache.delete(index);
    this.crashNotes.delete(index);
    this.hintNotes.delete(index);
    this.bootDoubt.delete(index);
    this.staleStops.delete(index);
    this.identityErrors.delete(index);
    const c = this.clients.get(index);
    if (c) {
      c.client.close();
      this.clients.delete(index);
    }
  }

  private async requireRunning(index: number): Promise<InstanceState> {
    const state = await this.getState(index);
    if (state.status !== 'running') {
      throw new AvdmError('INSTANCE_NOT_RUNNING', `实例 #${index} 未运行（当前状态: ${statusLabel(state.status)}）`);
    }
    return state;
  }

  // ───────────────────────────── internals: lifecycle ─────────────────────────────

  private async launch(index: number, opts: StartOptions): Promise<InstanceState> {
    const record = await this.registry.require(index);
    if (record.provisioning) {
      throw new AvdmError('INVALID_ARGUMENT', `实例 #${index} 正在创建或克隆中，暂不能启动`);
    }
    if (this.cloneSources.has(index)) {
      throw new AvdmError('INVALID_ARGUMENT', `实例 #${index} 正在被克隆，请稍后再启动`);
    }
    await this.reloadSettings();
    let sdk = await this.getSdk();
    if (!sdk.emulator || !findInstalledImage(sdk, record.image)) sdk = await this.refreshSdk();
    const emulatorBin = sdk.emulator?.bin;
    if (!emulatorBin) {
      throw new AvdmError('EMULATOR_MISSING', '未找到 Android Emulator，请先运行 `avdm sdk install emulator` 安装');
    }
    if (!findInstalledImage(sdk, record.image)) {
      throw new AvdmError(
        'IMAGE_MISSING',
        `实例 #${index} 使用的系统镜像未安装: ${record.image}，请先运行 avdm sdk install "${record.image}"`,
        { image: record.image },
      );
    }
    if (!(await pathExists(avdConfigFor(this.paths.avdHome, record.avdName)))) {
      throw new AvdmError(
        'INVALID_ARGUMENT',
        `实例 #${index} 的 AVD 文件缺失（${avdDirFor(this.paths.avdHome, record.avdName)}），请删除该实例后重新创建`,
      );
    }
    const supportedFlags = await getSupportedFlags(emulatorBin);

    // Admission + port check + spawn + run record are serialized across processes (CLI and desktop).
    const launched = await this.withLaunchLock(async (): Promise<{
      state?: InstanceState;
      pid?: number;
      coldBoot?: boolean;
      noGrpc?: boolean;
    }> => {
      const snap = await this.snapshot();
      const current = snap.records.find((r) => r.index === index);
      if (!current) throw new AvdmError('INSTANCE_NOT_FOUND', `实例 #${index} 不存在`);
      const inspections = await Promise.all(
        snap.records.map((r) => this.inspect(r, snap.entries, snap.runs.get(r.index), true)),
      );
      for (const r of inspections) this.noteState(r.state);
      const self = inspections.find((r) => r.state.record.index === index)!;
      const status = self.state.status;
      if (status === 'starting' || status === 'booting' || status === 'running') return { state: self.state };
      if (status === 'stopping') {
        throw new AvdmError('INSTANCE_RUNNING', `实例 #${index} 正在停止中，请稍后再启动`);
      }
      if (status === 'error' && self.alive) {
        if (this.staleStops.has(index) && self.run) {
          // The stop that was requested never finished and the emulator is still up: the user now wants it
          // running, so withdraw the abandoned request instead of refusing.
          const run = self.run;
          await this.registry.updateRunIf(index, (cur) => {
            if (!sameRun(cur, run)) return undefined;
            delete cur.stopRequestedAt;
            delete cur.stopTimeoutMs;
            return cur;
          });
          this.staleStops.delete(index);
          this.log('info', `实例 #${index} 的停止请求未完成，已撤销该请求并继续运行`, index);
          const again = await this.inspectOne(current, true);
          this.noteState(again.state);
          return { state: again.state };
        }
        throw new AvdmError(
          'INSTANCE_RUNNING',
          `实例 #${index} ${firstLine(self.state.error ?? '启动超时')}，模拟器进程仍在运行，请先停止或重启该实例`,
        );
      }
      if (await isLockHeld(this.busyLockPath(index))) {
        throw new AvdmError('INVALID_ARGUMENT', `实例 #${index} 正在被克隆或删除，请稍后再启动`);
      }
      if (!opts.force) await this.checkAdmission(current, inspections);
      await this.checkPorts(index, snap.entries);

      // Quick Boot snapshot bookkeeping (see SNAPSHOT_STALE_MARKER): a previous session that did not end in an
      // orderly, snapshot-saving shutdown left the marker, so its snapshot is older than the disk — do not load it.
      const avdHome = this.paths.avdHome;
      if (status === 'error' && self.run) await markSnapshotStale(avdHome, current.avdName, 'crash').catch(() => undefined);
      const wasStale = await isSnapshotStale(avdHome, current.avdName);
      const coldBoot =
        current.spec.bootMode === 'quick' && wasStale && (await hasQuickBootSnapshot(avdHome, current.avdName));
      await markSnapshotStale(avdHome, current.avdName, 'session running');

      const plan = planLaunch({
        sdk,
        paths: this.paths,
        settings: this.settings,
        record: current,
        supportedFlags,
        headlessOverride: opts.headless,
        noSnapshotLoad: coldBoot,
      });
      let pid: number;
      try {
        ({ pid } = await spawnEmulator(plan));
      } catch (err) {
        if (!wasStale) await clearSnapshotStale(avdHome, current.avdName).catch(() => undefined);
        throw err;
      }
      this.forgetRuntime(index);
      const startedAt = new Date().toISOString();
      await this.registry.writeRun({ index, pid, startedAt, ports: portsFor(index), argv: [plan.bin, ...plan.args] });
      // Publish 'starting' right away so UIs react to the click, before the emulator registers itself.
      this.noteState({ record: current, ports: portsFor(index), status: 'starting', pid, bootCompleted: false, startedAt });
      return { pid, coldBoot, noGrpc: !plan.args.includes('-grpc') };
    });
    if (launched.state) return launched.state;
    const pid = launched.pid!;

    await this.watchEarlyExit(record, pid);
    this.log(
      'info',
      `已启动实例 #${index}（${record.name}），pid ${pid}` +
        (launched.coldBoot ? '。上次未正常关机，Quick Boot 快照早于磁盘数据，本次冷启动以免数据回滚' : ''),
      index,
    );
    if (launched.noGrpc) {
      this.log(
        'warn',
        `无法确认当前 emulator 支持 gRPC 令牌鉴权（-grpc-use-token），为避免无鉴权地暴露设备控制，实例 #${index} 本次未启用 gRPC；` +
          '截图等功能将改用 adb。请升级 Android Emulator（avdm sdk install emulator）',
        index,
      );
    }
    return this.getState(index);
  }

  /** Serialize admission/spawn (and anything that must not interleave with a launch) across processes. */
  private withLaunchLock<T>(fn: () => Promise<T>): Promise<T> {
    return withFileLock(path.join(this.paths.runDir, 'launch.lock'), fn, { timeoutMs: 120_000, staleMs: 60_000 });
  }

  /** Per-instance lock held while an instance is cloned from or deleted; launch() refuses while it is held. */
  private busyLockPath(index: number): string {
    return path.join(this.paths.runDir, `instance-${index}.busy`);
  }

  private async withInstanceBusy<T>(index: number, what: string, fn: () => Promise<T>, timeoutMs = BUSY_LOCK_WAIT_MS): Promise<T> {
    let entered = false;
    try {
      return await withFileLock(
        this.busyLockPath(index),
        () => {
          entered = true;
          return fn();
        },
        { timeoutMs },
      );
    } catch (err) {
      if (!entered && isAvdmError(err, 'LOCK_TIMEOUT')) {
        throw new AvdmError('INVALID_ARGUMENT', `实例 #${index} 正被其他进程克隆或删除，请稍后再${what}`);
      }
      throw err;
    }
  }

  /** Whether `record` will resume its Quick Boot snapshot on the next start (for memory admission). */
  private async willQuickBoot(record: InstanceRecord, run?: RunRecord): Promise<boolean> {
    if (record.spec.bootMode !== 'quick') return false;
    if (run) return !run.argv.includes('-no-snapshot-load') && !run.argv.includes('-no-snapshot');
    const home = this.paths.avdHome;
    return (await hasQuickBootSnapshot(home, record.avdName)) && !(await isSnapshotStale(home, record.avdName));
  }

  private async checkAdmission(record: InstanceRecord, inspections: Inspection[]): Promise<void> {
    const others = inspections.filter((r) => r.state.record.index !== record.index);
    const running = others.filter((r) => r.state.status !== 'stopped' && r.state.status !== 'error');
    const max = this.settings.maxRunning;
    if (running.length >= max) {
      throw new AvdmError(
        'ADMISSION_DENIED',
        `已达到最大同时运行数 ${max}（当前 ${running.length} 个实例在运行），无法启动实例 #${record.index}。` +
          '请先停止其他实例，或在设置中调高“最大运行数”，也可以强制启动（--force）跳过检查',
        { reason: 'max-running', running: running.length, maxRunning: max },
      );
    }
    const committed = others.filter((r) => r.state.status !== 'stopped').reduce((s, r) => s + r.state.record.spec.ramMb, 0);
    const host = await getHostStats({ committedInstanceRamMb: committed, runningInstances: running.length });
    if (host.memoryPressure === 'critical') {
      throw new AvdmError(
        'ADMISSION_DENIED',
        `系统内存压力为“严重”，暂不启动实例 #${record.index}。请先停止其他实例或关闭占用内存的程序，也可以强制启动（--force）`,
        { reason: 'memory-pressure', host },
      );
    }
    const reserve = this.settings.memoryReserveMb;
    // Quick-booted instances keep ~2.3 GB (of 3 GB) that vm_stat still counts as "inactive", so availableMemMb
    // overstates the headroom exactly when several run. macOS's own verdict is the better signal: pressure 'warn'
    // with swap in use while our instances run means another one would push the host into swapping.
    // (memoryReserveMb = 0 opts out of the memory checks; only 'critical' above still applies.)
    if (
      reserve > 0 &&
      host.memoryPressure === 'warn' &&
      running.length > 0 &&
      (host.swapUsedMb === undefined || host.swapUsedMb > 0)
    ) {
      throw new AvdmError(
        'ADMISSION_DENIED',
        `系统内存压力偏高（已在使用交换空间${host.swapUsedMb !== undefined ? ` ${host.swapUsedMb} MB` : ''}），` +
          `已有 ${running.length} 个实例在运行，暂不启动实例 #${record.index}。请先停止其他实例或关闭占用内存的程序，也可以强制启动（--force）`,
        { reason: 'memory-pressure', host },
      );
    }
    // Emulators that are still starting have not touched most of their RAM yet: reserve it for them.
    let pending = 0;
    for (const r of others) {
      if (r.state.status !== 'starting' && r.state.status !== 'booting') continue;
      pending += expectedResidentMb(r.state.record.spec.ramMb, { quickBoot: await this.willQuickBoot(r.state.record, r.run) });
    }
    const available = host.availableMemMb - pending;
    // HVF commits guest RAM lazily: a cold-booted 3 GB AOSP instance measured ~1.1 GB, a Quick Boot one ~2.3 GB
    // (footprint). Charge the expected resident size, not the configured size; memory pressure above is the hard stop.
    const need = expectedResidentMb(record.spec.ramMb, { quickBoot: await this.willQuickBoot(record) });
    if (available - need < reserve) {
      throw new AvdmError(
        'ADMISSION_DENIED',
        `主机可用内存不足: 当前可用约 ${Math.max(0, Math.round(available))} MB` +
          (pending ? `（已扣除正在启动的实例预计占用的 ${pending} MB）` : '') +
          `，实例 #${record.index} 预计常驻约 ${need} MB（配置 ${record.spec.ramMb} MB），且需为系统保留 ${reserve} MB。` +
          '请先停止其他实例、调低实例内存或“内存保留”设置，也可以强制启动（--force）跳过检查',
        { reason: 'memory', availableMemMb: host.availableMemMb, pendingMb: pending, needMb: need, reserveMb: reserve },
      );
    }
  }

  /** Refuse to launch when a port this instance needs is already taken (INVALID_ARGUMENT naming the port). */
  private async checkPorts(index: number, entries: DiscoveryEntry[]): Promise<void> {
    const ports = portsFor(index);
    const wanted: Array<[string, number]> = [
      ['控制台', ports.console],
      ['ADB', ports.adb],
      ['gRPC', ports.grpc],
    ];
    const busy = (
      await Promise.all(wanted.map(async ([label, port]) => ((await isPortBusy(port)) ? { label, port } : undefined)))
    ).filter((x): x is { label: string; port: number } => x !== undefined);
    if (busy.length === 0) return;
    const parts: string[] = [];
    for (const { label, port } of busy) {
      parts.push(`${label}端口 ${port} 已被${await describePortOwner(port, entries)}占用`);
    }
    throw new AvdmError(
      'INVALID_ARGUMENT',
      `端口冲突，无法启动实例 #${index}: ${parts.join('；')}。请关闭占用端口的程序后重试`,
      { ports: busy.map((b) => b.port) },
    );
  }

  /** Detect an emulator that exits right after spawning (bad AVD, port race…) and report its log. */
  private async watchEarlyExit(record: InstanceRecord, pid: number): Promise<void> {
    const deadline = Date.now() + EARLY_EXIT_WATCH_MS;
    while (Date.now() < deadline) {
      await sleep(100);
      if (!isPidAlive(pid)) {
        const tail = await this.launchLogTail(record.index, ERROR_LOG_LINES).catch(() => [] as string[]);
        await this.getState(record.index).catch(() => undefined); // publish the 'error' state
        throw new AvdmError(
          'COMMAND_FAILED',
          `实例 #${record.index} 的模拟器启动后立即退出` + (tail.length ? `\n日志末尾:\n${tail.join('\n')}` : ''),
          { pid, log: this.logFile(record.index) },
        );
      }
      const run = await this.registry.readRun(record.index);
      if (this.matchEntry(record, await listRunningEmulators(), run)) return;
    }
  }

  /** Pids of this instance's emulator that are verifiably ours (never a recycled pid of an unrelated program). */
  private async ownedPids(info: Inspection): Promise<number[]> {
    const pids = new Set<number>();
    if (info.entry && isPidAlive(info.entry.pid)) pids.add(info.entry.pid);
    const run = info.run;
    if (run && !pids.has(run.pid) && isPidAlive(run.pid) && (await this.runPidIsOurs(run))) pids.add(run.pid);
    return [...pids];
  }

  /**
   * Has the guest finished booting (so a console `kill` may save it as the Quick Boot snapshot)? Re-probes a few
   * times when the answer is not definitive. A VM whose adb never comes up counts as not booted; when neither
   * gRPC nor adb answers at all we cannot tell and keep the graceful path.
   */
  private async bootedForStop(index: number, entry: DiscoveryEntry, ports: InstancePorts): Promise<boolean> {
    if (this.bootCache.get(index) === entry.pid) return true;
    let probe: BootProbe = 'unknown';
    for (let i = 0; i < STOP_BOOT_PROBES; i++) {
      if (i > 0) await sleep(1500);
      probe = await this.probeBoot(index, entry, ports);
      if (probe === 'yes' || probe === 'no') break;
    }
    return probe === 'yes' || probe === 'unknown';
  }

  private async doStop(index: number, opts: StopOptions): Promise<void> {
    const ctl = { force: opts.force === true, pids: [] as number[] };
    this.stopCtl.set(index, ctl);
    try {
      await this.stopInstance(index, opts, ctl);
    } finally {
      if (this.stopCtl.get(index) === ctl) this.stopCtl.delete(index);
    }
  }

  private async stopInstance(index: number, opts: StopOptions, ctl: { force: boolean; pids: number[] }): Promise<void> {
    const launching = this.launching.get(index);
    if (launching) await launching.catch(() => undefined);
    const record = await this.registry.require(index);
    const scriptsStopped = this.scripts.stopAll(index).catch(() => undefined);
    await this.getState(index).catch(() => undefined); // baseline for the change events below (also probes boot)
    const info = await this.inspectOne(record, false);
    const isOurs = (cur: RunRecord) => (info.run !== undefined && sameRun(cur, info.run)) || !isPidAlive(cur.pid);
    if (!info.alive) {
      await this.registry.clearRunIf(index, isOurs);
      this.forgetRuntime(index);
      await scriptsStopped;
      await this.getState(index).catch(() => undefined);
      return;
    }

    const timeoutMs = opts.timeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
    await this.registry.markStopRequested(index, { timeoutMs });
    await this.getState(index).catch(() => undefined); // → 'stopping'
    const pids = await this.ownedPids(info);
    ctl.pids = pids;
    // Not booted yet (still starting, booting, boot timeout, or a VM whose adb never came up): kill it. A graceful
    // console `kill` would save this half-booted VM as the Quick Boot snapshot, and every later start would load
    // that broken snapshot and hang (verified on 37.1.11). The snapshot marker stays, so the next start cold-boots.
    const booted = !ctl.force && info.entry ? await this.bootedForStop(index, info.entry, info.state.ports) : false;
    let exited = pids.length === 0;
    let killed = false;
    if (!exited && (ctl.force || !booted)) {
      killed = true;
      for (const pid of pids) signalTree(pid, 'SIGKILL');
      exited = await waitPidsExit(pids, 5000);
    } else if (!exited) {
      // Quick Boot saves guest RAM, so recent writes can live only in the guest page cache. Flush them to the
      // virtual disk first: clones cold-boot from disk (verified: without this a file written just before stop
      // was missing in a clone, with it the clone had it). Best effort — never blocks a stop for long.
      if (info.entry) await this.syncGuest(info.state.ports.serial);
      const sent = !ctl.force && info.entry ? await consoleKill(info.state.ports.console, { timeoutMs: 5000 }) : false;
      if (sent) exited = await waitPidsExit(pids, timeoutMs, () => ctl.force);
      if (!exited && !ctl.force) {
        for (const pid of pids) signalTree(pid, 'SIGTERM');
        exited = await waitPidsExit(pids, sent ? 10_000 : Math.min(timeoutMs, 15_000), () => ctl.force);
      }
      if (!exited) {
        killed = true;
        for (const pid of pids) signalTree(pid, 'SIGKILL');
        exited = await waitPidsExit(pids, 5000);
      }
    }
    if (!exited) {
      throw new AvdmError('STOP_TIMEOUT', `实例 #${index} 停止超时，模拟器进程 ${pids.join(', ')} 仍在运行`, { pids });
    }
    // Orderly = it exited by itself (no SIGKILL) and withdrew its discovery file, as the emulator does on a
    // clean shutdown; a crash or kill leaves the file behind.
    const orderly = !killed && !ctl.force && !!info.entry && !(await pathExists(info.entry.file));
    if (orderly) await this.noteOrderlyExit(record, info.run);
    // A killed emulator leaves its discovery file behind; once its pid is recycled that file would describe an
    // unrelated process. We confirmed the exit, so remove it.
    if (info.entry) await fsp.rm(info.entry.file, { force: true }).catch(() => undefined);
    await this.registry.clearRunIf(index, isOurs);
    this.forgetRuntime(index);
    await scriptsStopped;
    this.log('info', `已停止实例 #${index}（${record.name}）`, index);
    await this.getState(index).catch(() => undefined);
  }

  /** `adb shell sync` with a short timeout; failures are ignored (the stop proceeds regardless). */
  private async syncGuest(serial: string): Promise<void> {
    try {
      const adb = await this.adb();
      await adb.device(serial).shell('sync', { timeoutMs: 10_000 });
    } catch {
      // adb missing / device offline: nothing more we can do before the kill
    }
  }

  /**
   * Reclaim an index that was just allocated: stale run record and logs, leftovers of an interrupted delete.
   * An AVD found at this name that is not in the registry is NOT deleted — it may be a real instance whose
   * registry entry was lost — but moved to avd/orphaned/ and reported.
   */
  private async prepareSlot(rec: InstanceRecord, entries: DiscoveryEntry[]): Promise<void> {
    const avdHome = this.paths.avdHome;
    await purgeRetiredAvds(avdHome, rec.avdName);
    if ((await pathExists(avdDirFor(avdHome, rec.avdName))) || (await pathExists(avdIniFor(avdHome, rec.avdName)))) {
      const inUse = entries.some((e) =>
        e.avdDir ? this.isOurAvdDir(e.avdDir, rec.avdName) : e.raw['avd.id'] === rec.avdName || e.avdName === rec.avdName,
      );
      if (inUse) {
        throw new AvdmError('INVALID_ARGUMENT', `AVD ${rec.avdName} 仍被一个模拟器进程使用，无法创建实例 #${rec.index}`);
      }
      const moved = await quarantineAvd(avdHome, rec.avdName);
      if (moved) {
        this.log(
          'warn',
          `发现未登记的 AVD ${rec.avdName}（可能来自丢失或重置的实例注册表），未删除，已移到 ${moved} 保留；确认不需要后可手动删除`,
          rec.index,
        );
      }
    }
    await this.registry.clearRun(rec.index);
    await this.removeLogs(rec.index);
    this.forgetRuntime(rec.index);
    this.lastSeen.delete(rec.index);
  }

  /** Undo an allocation: drop the records, and delete only the AVDs this call created. */
  private async rollback(records: InstanceRecord[], created: ReadonlySet<number>): Promise<void> {
    for (const rec of records) {
      await this.registry.remove(rec.index).catch(() => undefined);
      if (created.has(rec.index)) await deleteAvd(this.paths.avdHome, rec.avdName).catch(() => undefined);
      this.lastSeen.delete(rec.index);
    }
  }

  private async removeLogs(index: number): Promise<void> {
    const log = this.logFile(index);
    await fsp.rm(log, { force: true });
    await fsp.rm(`${log}.1`, { force: true });
  }

  // ───────────────────────────── internals: monitor ─────────────────────────────

  private scheduleMonitor(): void {
    this.monitorIntervalMs = Math.max(1, this.settings.healthIntervalSec) * 1000;
    this.monitorTimer = setInterval(() => void this.monitorTick(), this.monitorIntervalMs);
    this.monitorTimer.unref?.();
  }

  private monitorTick(): Promise<void> {
    if (this.monitorBusy || this.disposed || !this.monitorTimer) return Promise.resolve();
    const run = this.runMonitorTick().finally(() => {
      if (this.monitorRun === run) this.monitorRun = undefined;
    });
    this.monitorRun = run;
    return run;
  }

  private async runMonitorTick(): Promise<void> {
    this.monitorBusy = true;
    try {
      await this.reloadSettings();
      const states = await this.list();
      // Stopped/disposed while listing: never start new work (dispose() only waits for what already runs).
      if (this.disposed || !this.monitorTimer) return;
      for (const st of states) {
        const index = st.record.index;
        if (st.status === 'running' && st.record.identity) {
          await this.ensureManagedIdentity(st).catch((err: unknown) => this.reportIdentityError(index, err));
        }
        if (st.status !== 'error') {
          this.restartGaveUp.delete(index);
          continue;
        }
        // An abandoned stop request is reported as an error but the user wanted it stopped: never restart it.
        if (st.record.autoRestart && !st.record.provisioning && !this.staleStops.has(index)) this.maybeAutoRestart(st);
      }
      this.lastMonitorError = undefined;
    } catch (err) {
      const msg = errorMessage(err);
      if (msg !== this.lastMonitorError) this.log('warn', `健康检查失败: ${msg}`);
      this.lastMonitorError = msg;
    } finally {
      this.monitorBusy = false;
    }
  }

  private maybeAutoRestart(st: InstanceState): void {
    const index = st.record.index;
    if (this.disposed || !this.monitorTimer) return;
    if (this.autoRestarting.has(index) || this.launching.has(index) || this.stopping.has(index)) return;
    const now = Date.now();
    const history = (this.restartHistory.get(index) ?? []).filter((t) => now - t < AUTO_RESTART_WINDOW_MS);
    if (history.length >= AUTO_RESTART_MAX) {
      this.restartHistory.set(index, history);
      if (!this.restartGaveUp.has(index)) {
        this.restartGaveUp.add(index);
        this.log(
          'warn',
          `实例 #${index}（${st.record.name}）在 10 分钟内已自动重启 ${AUTO_RESTART_MAX} 次，暂停自动重启，请检查日志`,
          index,
        );
      }
      return;
    }
    history.push(now);
    this.restartHistory.set(index, history);
    this.autoRestarting.add(index);
    this.log(
      'warn',
      `实例 #${index}（${st.record.name}）${firstLine(st.error ?? '状态异常')}，正在自动重启（10 分钟内第 ${history.length} 次）`,
      index,
    );
    const task: Promise<void> = this.restart(index)
      .then(
        () => this.log('info', `实例 #${index} 已自动重启`, index),
        (err: unknown) => this.log('error', `实例 #${index} 自动重启失败: ${errorMessage(err)}`, index),
      )
      .finally(() => {
        this.autoRestarting.delete(index);
        this.autoRestartTasks.delete(task);
      });
    this.autoRestartTasks.add(task);
  }

  private uniqueIdentity(identity: InstanceRecord['identity'], seen: Set<string>): InstanceRecord['identity'] {
    if (!identity) return undefined;
    for (const value of [identity.serialNumber, identity.wifiMac, identity.androidId]) {
      if (!value) continue;
      if (seen.has(value)) throw new AvdmError('INVALID_ARGUMENT', `批量创建的设备标识重复：${value}；请在模板中使用 {index} 或 {indexHex2}`);
      seen.add(value);
    }
    return identity;
  }

  private async ensureManagedIdentity(state: InstanceState): Promise<void> {
    const { index, identity } = state.record;
    if (!identity) return;
    const existing = this.identityApplying.get(index);
    if (existing) return existing;
    const task = (async () => {
      const device = (await this.adb()).device(state.ports.serial);
      if (identity.build) await ensureBuildProfile(device, identity.build, path.join(this.paths.home, 'cache'));
      if (identity.androidId) await ensureAndroidId(device, identity.androidId, avdDirFor(this.paths.avdHome, state.record.avdName));
      if (identity.serialNumber) {
        const actual = await device.getprop('ro.serialno');
        if (actual !== identity.serialNumber) {
          throw new AvdmError('COMMAND_FAILED', `实例 #${index} 序列号校验失败：期望 ${identity.serialNumber}，实际 ${actual}`);
        }
      }
      if (identity.wifiMac) await ensureWifiMac(device, identity.wifiMac);
      this.identityErrors.delete(index);
    })();
    this.identityApplying.set(index, task);
    try {
      await task;
    } finally {
      if (this.identityApplying.get(index) === task) this.identityApplying.delete(index);
    }
  }

  private reportIdentityError(index: number, err: unknown): void {
    const msg = errorMessage(err);
    if (this.identityErrors.get(index) !== msg) this.log('error', `实例 #${index} 设备标识应用失败：${msg}`, index);
    this.identityErrors.set(index, msg);
  }

  // ───────────────────────────── internals: misc ─────────────────────────────

  private setSdk(sdk: SdkInfo): void {
    this.sdk = sdk;
    this.scripts.env.sdkRoot = sdk.root;
    this.scripts.env.adbBin = sdk.adb?.bin;
    if (this.adbClient && this.adbClient.bin !== sdk.adb?.bin) this.adbClient = undefined;
  }

  /** Pick up settings changed by another process (e.g. `avdm settings set` while the desktop app runs). */
  private async reloadSettings(): Promise<void> {
    let next: Settings;
    try {
      next = await loadSettings(this.paths);
    } catch {
      return; // keep the last good settings
    }
    const before = this.settings;
    this.settings = next;
    await this.afterSettingsChange(before);
  }

  private async afterSettingsChange(before: Settings): Promise<void> {
    if (before.sdkRoot !== this.settings.sdkRoot) {
      this.catalog = undefined;
      await this.refreshSdk();
    }
    if (this.monitorTimer && this.settings.healthIntervalSec * 1000 !== this.monitorIntervalMs) {
      this.stopMonitor();
      this.scheduleMonitor();
    }
  }

  private async cachedCatalog(): Promise<SdkCatalog> {
    if (this.catalog && Date.now() - this.catalog.at < CATALOG_TTL_MS) return this.catalog.value;
    return this.fetchCatalog();
  }

  private async requireImage(image: string): Promise<SdkInfo> {
    let sdk = await this.getSdk();
    if (findInstalledImage(sdk, image)) return sdk;
    sdk = await this.refreshSdk();
    if (findInstalledImage(sdk, image)) return sdk;
    throw new AvdmError('IMAGE_MISSING', `系统镜像未安装: ${image}，请先运行 avdm sdk install "${image}"`, { image });
  }

  /** Replacing the emulator or an image under a running instance can crash it: refuse. */
  private async assertNotInUse(packages: RemotePackage[]): Promise<void> {
    const touched = packages.filter((p) => p.path === 'emulator' || p.path.startsWith('system-images;'));
    if (touched.length === 0) return;
    const snap = await this.snapshot();
    const live = (
      await Promise.all(snap.records.map((r) => this.inspect(r, snap.entries, snap.runs.get(r.index), false)))
    ).filter((r) => r.alive);
    for (const pkg of touched) {
      const users = live.filter((r) => pkg.path === 'emulator' || r.state.record.image === pkg.path);
      if (users.length) {
        throw new AvdmError(
          'INSTANCE_RUNNING',
          `${pkg.path} 正在被运行中的实例使用（${users.map((u) => `#${u.state.record.index}`).join(', ')}），请先停止这些实例再安装`,
        );
      }
    }
    if (!touched.some((p) => p.path === 'emulator')) return;
    // The SDK is shared with Android Studio by default: an emulator we do not manage (Android Studio AVD, another
    // AVDM_HOME) running from this SDK would crash when its lazily loaded libraries are deleted under it.
    const sdk = await this.getSdk();
    const ours = new Set(live.map((r) => r.entry?.pid).filter((p): p is number => p !== undefined));
    const others = snap.entries.filter((e) => !ours.has(e.pid) && entryMayUseSdk(e, sdk.root));
    if (others.length) {
      const names = others.map((e) => `${e.raw['avd.id'] ?? e.avdName ?? '未知 AVD'}（pid ${e.pid}）`).join('、');
      throw new AvdmError(
        'INSTANCE_RUNNING',
        `emulator 正在被其他模拟器进程使用: ${names}。请先关闭这些模拟器（例如 Android Studio 中运行的 AVD）再安装`,
        { pids: others.map((e) => e.pid) },
      );
    }
  }

  private async findScrcpy(): Promise<string> {
    const configured = (this.settings.scrcpyPath ?? '').trim();
    if (configured) {
      const p = path.resolve(expandHome(configured));
      if (await isExecutableFile(p)) return p;
      throw new AvdmError('UNSUPPORTED', `设置中的 scrcpy 路径不可用: ${p}`);
    }
    const dirs = [...(process.env.PATH ?? '').split(path.delimiter), '/opt/homebrew/bin', '/usr/local/bin'];
    for (const dir of dirs) {
      if (!dir) continue;
      const candidate = path.join(dir, process.platform === 'win32' ? 'scrcpy.exe' : 'scrcpy');
      if (await isExecutableFile(candidate)) return candidate;
    }
    throw new AvdmError('UNSUPPORTED', '未找到 scrcpy，请先安装（例如 brew install scrcpy），或在设置中填写 scrcpy 路径');
  }

  private logFile(index: number): string {
    return path.join(this.paths.logsDir, `instance-${index}.log`);
  }

  private log(level: 'info' | 'warn' | 'error', message: string, index?: number): void {
    const entry: { level: 'info' | 'warn' | 'error'; message: string; index?: number; at: string } = {
      level,
      message,
      at: new Date().toISOString(),
    };
    if (index !== undefined) entry.index = index;
    this.emit('log', entry);
  }
}

export interface SdkInstallPlan {
  packages: RemotePackage[];
  /** licenseId → license text, for every license the packages use. */
  licenses: Record<string, string>;
  /** licenseIds not yet accepted in <sdk>/licenses. */
  unaccepted: string[];
  /** Package paths that were requested but not found in the catalog for this host. */
  missing: string[];
  /** Sum of archive sizes (bytes). */
  totalBytes: number;
}

export type { InstallProgress };

// ───────────────────────────── module helpers ─────────────────────────────

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err ?? '未知错误');
}

function firstLine(text: string): string {
  return text.split('\n', 1)[0] ?? text;
}

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function uniqueStrings(list: readonly string[]): string[] {
  return [...new Set(list.map((s) => String(s).trim()).filter(Boolean))];
}

function assertCount(count: number): number {
  if (!Number.isInteger(count) || count < 1 || count > MAX_INSTANCES) {
    throw new AvdmError('INVALID_ARGUMENT', `数量需为 1..${MAX_INSTANCES} 的整数（收到 ${count}）`);
  }
  return count;
}

/** Control characters (incl. CR/LF, which would start a new key in config.ini) are never allowed in names. */
// eslint-disable-next-line no-control-regex
const NAME_FORBIDDEN = /[\u0000-\u001f\u007f\u2028\u2029]/;

/** Validate an instance display name (shared by create / clone / update). Returns it unchanged. */
function validateName(name: string): string {
  if (!name) throw new AvdmError('INVALID_ARGUMENT', '实例名称不能为空');
  if (NAME_FORBIDDEN.test(name)) throw new AvdmError('INVALID_ARGUMENT', '实例名称不能包含换行或其他控制字符');
  if (name.length > NAME_MAX_CHARS) throw new AvdmError('INVALID_ARGUMENT', `实例名称不能超过 ${NAME_MAX_CHARS} 个字符`);
  return name;
}

/** Name prefix for create/clone: instances are named `<prefix>-<index>`, which must itself be a valid name. */
function namePrefix(prefix: string | undefined): string {
  const p = String(prefix ?? '').trim() || DEFAULT_NAME_PREFIX;
  if (NAME_FORBIDDEN.test(p)) throw new AvdmError('INVALID_ARGUMENT', '名称前缀不能包含换行或其他控制字符');
  const maxPrefix = NAME_MAX_CHARS - `-${MAX_INSTANCES - 1}`.length;
  if (p.length > maxPrefix) {
    throw new AvdmError(
      'INVALID_ARGUMENT',
      `名称前缀不能超过 ${maxPrefix} 个字符（实例名为“前缀-编号”，最长 ${NAME_MAX_CHARS} 个字符）`,
    );
  }
  return p;
}

/** Same launch (a new launch of the same instance writes a new pid/startedAt). */
function sameRun(a: RunRecord, b: RunRecord): boolean {
  return a.pid === b.pid && a.startedAt === b.startedAt;
}

function runKey(run: RunRecord): string {
  return `${run.pid}|${run.startedAt}`;
}

/** Whether a session launched with this argv saves the Quick Boot snapshot on an orderly exit. */
function savesSnapshot(argv: readonly string[]): boolean {
  return !argv.some((a) => a === '-no-snapshot' || a === '-no-snapshot-save' || a === '-read-only');
}

/**
 * Whether the emulator of a discovery entry may be running from `sdkRoot`: judged from the executable in its
 * `cmdline` key; when that is missing or not an absolute path we cannot tell and assume it does.
 */
function entryMayUseSdk(entry: DiscoveryEntry, sdkRoot: string): boolean {
  const cmdline = entry.raw['cmdline'];
  if (!cmdline) return true;
  const m = /^\s*(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(cmdline);
  const bin = m?.[1] ?? m?.[2] ?? m?.[3];
  if (!bin || !path.isAbsolute(bin)) return true;
  const norm = (p: string) => path.resolve(p).replace(/^\/private(?=\/(?:var|tmp|etc)\/)/, '');
  const rel = path.relative(norm(sdkRoot), norm(bin));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function cloneSpec(spec: InstanceSpec): InstanceSpec {
  return { ...spec, extraArgs: [...(spec.extraArgs ?? [])] };
}

function mergeSpec(base: InstanceSpec, patch: Partial<InstanceSpec> | undefined): InstanceSpec {
  const merged: InstanceSpec = { ...base };
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (v !== undefined) (merged as unknown as Record<string, unknown>)[k] = v;
  }
  return cloneSpec(merged);
}

function specEquals(a: InstanceSpec, b: InstanceSpec): boolean {
  return JSON.stringify(cloneSpecSorted(a)) === JSON.stringify(cloneSpecSorted(b));
}

function cloneSpecSorted(spec: InstanceSpec): Array<[string, unknown]> {
  return Object.entries(spec).sort(([x], [y]) => x.localeCompare(y));
}

function finishProvisioning(rec: InstanceRecord): InstanceRecord {
  delete rec.provisioning;
  return rec;
}

function portsFromEntry(entry: DiscoveryEntry, base: InstancePorts): InstancePorts {
  const consolePort = entry.consolePort ?? base.console;
  return {
    console: consolePort,
    adb: entry.adbPort ?? consolePort + 1,
    grpc: entry.grpcPort ?? base.grpc,
    serial: `emulator-${consolePort}`,
  };
}

/** Compare paths loosely (macOS reports /var/… and /private/var/… for the same temp dirs). */
function samePath(a: string, b: string): boolean {
  const norm = (p: string) => path.resolve(p).replace(/^\/private(?=\/(?:var|tmp|etc)\/)/, '');
  return norm(a) === norm(b);
}

function isPng(buf: Buffer): boolean {
  return buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a;
}

async function isExecutableFile(p: string): Promise<boolean> {
  try {
    const st = await fsp.stat(p);
    if (!st.isFile()) return false;
    await fsp.access(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Signal the process group of a detached child (falls back to the single pid). */
function signalTree(pid: number, signal: NodeJS.Signals): void {
  // kill(-1) would hit every process of this user, kill(-0) our own group: never let a bad pid get that far.
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return;
  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // not a group leader
    }
  }
  try {
    process.kill(pid, signal);
  } catch {
    // already gone
  }
}

/** Wait until every pid exited (true) or the timeout elapsed / `abort()` became true (false). */
async function waitPidsExit(pids: number[], timeoutMs: number, abort?: () => boolean): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (pids.every((p) => !isPidAlive(p))) return true;
    if (Date.now() >= deadline || abort?.()) return false;
    await sleep(100);
  }
}

function canConnect(port: number, host: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    let settled = false;
    const done = (value: boolean) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(value);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

function canListen(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen({ port, host, exclusive: true }, () => srv.close(() => resolve(true)));
  });
}

/** True if something already listens on 127.0.0.1:<port> (or we cannot bind it). */
export async function isPortBusy(port: number): Promise<boolean> {
  if (await canConnect(port, '127.0.0.1', 500)) return true;
  return !(await canListen(port, '127.0.0.1'));
}

/** " 模拟器 avdm_3（pid 123）" / " node（pid 456）" / "其他程序" — best effort, for error messages. */
async function describePortOwner(port: number, entries: DiscoveryEntry[]): Promise<string> {
  const emu = entries.find((e) => e.consolePort === port || e.adbPort === port || e.grpcPort === port);
  if (emu) {
    // Typically an instance of another manager home (same avdm_<i> name and ports) or an Android Studio AVD.
    return ` 模拟器 ${emu.raw['avd.id'] ?? emu.avdName ?? '未知 AVD'}（pid ${emu.pid}${emu.avdDir ? `，AVD 目录 ${emu.avdDir}` : ''}）`;
  }
  if (process.platform !== 'win32') {
    for (const lsof of ['/usr/sbin/lsof', '/usr/bin/lsof']) {
      if (!(await pathExists(lsof))) continue;
      try {
        const out = await execFileText(lsof, ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc'], { timeoutMs: 3000 });
        const pid = /^p(\d+)$/m.exec(out)?.[1];
        const cmd = /^c(.+)$/m.exec(out)?.[1];
        if (pid) return ` ${cmd ?? '进程'}（pid ${pid}）`;
      } catch {
        // lsof exits 1 when nothing matches (e.g. the port is held by another user's process)
      }
      break;
    }
  }
  return '其他程序';
}
