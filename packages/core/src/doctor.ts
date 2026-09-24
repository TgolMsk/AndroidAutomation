import { constants as fsConstants, promises as fsp } from 'node:fs';
import path from 'node:path';
import { MIN_EMULATOR_VERSION } from './constants.js';
import { accelCheck as defaultAccelCheck } from './host.js';
import { expectedResidentMb } from './manager.js';
import { findInstalledImage } from './sdk/locate.js';
import type { HostStats, InstalledImage, InstanceRecord, SdkInfo, Settings } from './types.js';
import { compareVersions } from './util/proc.js';

/**
 * Environment health checks shared by `avdm doctor` and the Electron apps' self-checks. Game agnostic: it only
 * looks at the host, the SDK, the emulator and the instance registry. Every check is isolated, so one failing
 * probe becomes one `fail` line and never aborts the report.
 */

export type DoctorLevel = 'ok' | 'warn' | 'fail';

export type DoctorCheckId =
  | 'platform' | 'home' | 'sdk' | 'emulator' | 'adb' | 'accel' | 'images' | 'default-image' | 'licenses'
  | 'host' | 'memory' | 'load' | 'instances' | 'scrcpy';

export interface DoctorCheck {
  id: DoctorCheckId;
  level: DoctorLevel;
  title: string;
  detail: string;
  /** What to do about a warn / fail, worded for the audience that runs the check. */
  hint?: string;
}

/** The manager surface the checks read (an `AvdManager`, or a fake in tests). */
export interface DoctorManager {
  readonly paths: { home: string };
  readonly registry: { list(): Promise<InstanceRecord[]> };
  getSettings(): Settings;
  refreshSdk(): Promise<SdkInfo>;
  hostStats(): Promise<HostStats>;
}

/**
 * `cli` hints name `avdm …` commands; `app` hints point at the desktop manager's settings and SDK wizard (a
 * GUI user has no terminal at hand).
 */
export type DoctorAudience = 'cli' | 'app';

export interface DoctorOptions {
  audience?: DoctorAudience;
  /** Checks to leave out (e.g. `scrcpy` in an app that has its own live view). Their groups still run. */
  skip?: readonly DoctorCheckId[];
  /** Called with a check's title before it runs (progress lines). */
  onProgress?: (title: string) => void;
  /** Called with the error of a check that threw (debug logging); the check itself becomes `fail`. */
  onError?: (id: DoctorCheckId, error: unknown) => void;
  /** Executable lookup for scrcpy; defaults to PATH plus the Homebrew prefixes. */
  findExecutable?: (name: string, explicit?: string) => Promise<string | undefined>;
  /** Hardware acceleration probe; defaults to `emulator -accel-check`. */
  accelCheck?: (sdk: SdkInfo) => Promise<{ ok: boolean; output: string }>;
  /** Host platform / architecture (tests). */
  platform?: NodeJS.Platform;
  arch?: string;
}

const MANAGER_APP = '「AVD 多开管理器」';

type HintKey =
  | 'platform-rosetta' | 'platform-other' | 'sdk-missing' | 'emulator-missing' | 'emulator-unreadable' | 'emulator-old'
  | 'adb-missing' | 'accel' | 'images-missing' | 'default-image' | 'licenses' | 'memory-critical' | 'load'
  | 'instances-limit' | 'scrcpy-path' | 'scrcpy-missing';

const HINTS: Record<DoctorAudience, Record<HintKey, string>> = {
  cli: {
    'platform-rosetta': '请使用 arm64 原生 Node 运行 avdm，否则无法使用 HVF 硬件加速',
    'platform-other': '本工具主要面向 Apple Silicon macOS，其他平台为尽力支持',
    'sdk-missing': '运行 `avdm sdk install` 自动安装，或 `avdm settings set sdkRoot <路径>` 指向已有 SDK',
    'emulator-missing': '运行 `avdm sdk install emulator`',
    'emulator-unreadable': '运行 `avdm sdk install emulator --force` 重新安装',
    'emulator-old': '运行 `avdm sdk install emulator` 升级',
    'adb-missing': '运行 `avdm sdk install platform-tools`',
    accel: '确认在 Apple Silicon 上以原生 arm64 运行，且未在不支持嵌套虚拟化的虚拟机中',
    'images-missing': '运行 `avdm sdk install`',
    'default-image': '运行 `avdm sdk install "{image}"`，或 `avdm settings set defaultImage <包路径>` 改用已安装镜像',
    licenses: '`avdm sdk install` 会展示许可全文并询问',
    'memory-critical': '内存压力严重，请停止部分实例或关闭其他应用',
    load: '主机负载较高，启动更多实例会变慢',
    'instances-limit': '已达最大运行数，可 `avdm settings set maxRunning <n>` 调整',
    'scrcpy-path': '`avdm settings set scrcpyPath ""` 恢复自动查找',
    'scrcpy-missing': '`brew install scrcpy`，或 `avdm settings set scrcpyPath <路径>`',
  },
  app: {
    'platform-rosetta': '请安装 Apple Silicon（arm64）版本，否则模拟器无法使用 HVF 硬件加速',
    'platform-other': '本工具主要面向 Apple Silicon macOS，其他平台为尽力支持',
    'sdk-missing': `打开${MANAGER_APP}，按提示安装 Android 运行环境；已有 SDK 时在其「设置」里填写 Android SDK 路径`,
    'emulator-missing': `打开${MANAGER_APP}，在「设置 → 管理 SDK 组件…」中安装 Android Emulator`,
    'emulator-unreadable': `打开${MANAGER_APP}，在「设置 → 管理 SDK 组件…」中重新安装 Android Emulator`,
    'emulator-old': `打开${MANAGER_APP}，在「设置 → 管理 SDK 组件…」中升级 Android Emulator`,
    'adb-missing': `打开${MANAGER_APP}，在「设置 → 管理 SDK 组件…」中安装 platform-tools（adb）`,
    accel: '确认在 Apple Silicon 上以原生 arm64 运行，且未在不支持嵌套虚拟化的虚拟机中',
    'images-missing': `打开${MANAGER_APP}，在「设置 → 管理 SDK 组件…」中安装系统镜像`,
    'default-image': `打开${MANAGER_APP}安装 {image}，或在其「设置」里把默认镜像改成已安装的镜像`,
    licenses: '安装 SDK 组件时会展示许可全文并询问',
    'memory-critical': '内存压力严重，请停止部分实例或关闭其他应用',
    load: '主机负载较高，启动更多实例会变慢',
    'instances-limit': `已达同时运行上限，可在「设置」的模拟器参数（与${MANAGER_APP}共用）里调整`,
    'scrcpy-path': `在${MANAGER_APP}的「设置」里清空 scrcpy 路径即可恢复自动查找`,
    'scrcpy-missing': '可选组件：`brew install scrcpy` 后可用 scrcpy 查看画面',
  },
};

const gb = (mb: number) => `${(mb / 1024).toFixed(1)} GB`;

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}

function firstLine(text: string | undefined): string {
  if (!text) return '';
  return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? '';
}

async function isExecutableFile(file: string): Promise<boolean> {
  try {
    const st = await fsp.stat(file);
    if (!st.isFile()) return false;
    await fsp.access(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** An explicit path (if executable), else PATH, else the usual Homebrew prefixes (GUI apps lack them on PATH). */
export async function findExecutableOnPath(name: string, explicit?: string): Promise<string | undefined> {
  if (explicit) return (await isExecutableFile(explicit)) ? explicit : undefined;
  const dirs = [...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean), '/opt/homebrew/bin', '/usr/local/bin'];
  const seen = new Set<string>();
  for (const dir of dirs) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    const candidate = path.join(dir, name);
    if (await isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}

function safeFindImage(sdk: SdkInfo, pkgPath: string, onError: (error: unknown) => void): InstalledImage | undefined {
  try {
    return findInstalledImage(sdk, pkgPath);
  } catch (err) {
    onError(err);
    return sdk.images.find((img) => img.packagePath === pkgPath);
  }
}

function pressureLabel(p: 'normal' | 'warn' | 'critical'): string {
  return p === 'normal' ? '正常' : p === 'warn' ? '偏高' : '严重';
}

/** `true` when no check failed (warnings are allowed). */
export function doctorPassed(checks: readonly DoctorCheck[]): boolean {
  return checks.every((check) => check.level !== 'fail');
}

/**
 * Run the environment checks in their fixed display order. Never throws for a single check: a check that throws
 * is reported as `fail` with the first line of its error (`检查失败: …`).
 */
export async function runDoctorChecks(manager: DoctorManager, opts: DoctorOptions = {}): Promise<DoctorCheck[]> {
  const audience = opts.audience ?? 'cli';
  const hints = HINTS[audience];
  const skip = new Set(opts.skip ?? []);
  const findExecutable = opts.findExecutable ?? findExecutableOnPath;
  const accelCheck = opts.accelCheck ?? defaultAccelCheck;
  const checks: DoctorCheck[] = [];
  const add = (r: DoctorCheck) => { if (!skip.has(r.id)) checks.push(r); };
  const guard = async (id: DoctorCheckId, title: string, fn: () => Promise<void>) => {
    opts.onProgress?.(title);
    try {
      await fn();
    } catch (err) {
      opts.onError?.(id, err);
      add({ id, level: 'fail', title, detail: `检查失败: ${firstLine(errorMessage(err))}` });
    }
  };
  const settings = manager.getSettings();

  // Platform
  {
    const platform = opts.platform ?? process.platform;
    const arch = opts.arch ?? process.arch;
    if (platform === 'darwin' && arch === 'arm64') {
      add({ id: 'platform', level: 'ok', title: '平台', detail: 'macOS / Apple Silicon (arm64)' });
    } else if (platform === 'darwin') {
      add({ id: 'platform', level: 'warn', title: '平台', detail: `macOS / ${arch}（Node 可能运行在 Rosetta 下）`, hint: hints['platform-rosetta'] });
    } else {
      add({ id: 'platform', level: 'warn', title: '平台', detail: `${platform} / ${arch}`, hint: hints['platform-other'] });
    }
  }
  add({ id: 'home', level: 'ok', title: '管理器目录', detail: manager.paths.home });

  let sdk: SdkInfo | undefined;
  await guard('sdk', 'Android SDK', async () => {
    sdk = await manager.refreshSdk();
    if (sdk.exists) add({ id: 'sdk', level: 'ok', title: 'Android SDK', detail: sdk.root });
    else add({ id: 'sdk', level: 'fail', title: 'Android SDK', detail: `未找到 SDK 目录 ${sdk.root}`, hint: hints['sdk-missing'] });
  });

  await guard('emulator', 'Emulator', async () => {
    const emu = sdk?.emulator;
    if (!emu) {
      add({ id: 'emulator', level: 'fail', title: 'Emulator', detail: '未安装', hint: hints['emulator-missing'] });
      return;
    }
    if (!emu.version) {
      add({ id: 'emulator', level: 'warn', title: 'Emulator', detail: `无法读取版本（${emu.bin}）`, hint: hints['emulator-unreadable'] });
    } else if (compareVersions(emu.version, MIN_EMULATOR_VERSION) < 0) {
      add({
        id: 'emulator',
        level: 'fail',
        title: 'Emulator',
        detail: `${emu.version} 低于要求的 ${MIN_EMULATOR_VERSION}（旧版在 macOS 26 上有 HVF 内存泄漏）`,
        hint: hints['emulator-old'],
      });
    } else {
      add({ id: 'emulator', level: 'ok', title: 'Emulator', detail: `${emu.version}（≥ ${MIN_EMULATOR_VERSION}）` });
    }
  });

  await guard('adb', 'adb', async () => {
    const adb = sdk?.adb;
    if (!adb) {
      add({ id: 'adb', level: 'fail', title: 'adb', detail: '未安装', hint: hints['adb-missing'] });
      return;
    }
    add({ id: 'adb', level: 'ok', title: 'adb', detail: adb.version ? `${adb.version}` : adb.bin });
  });

  if (!skip.has('accel')) {
    await guard('accel', '硬件加速', async () => {
      if (!sdk?.emulator) {
        add({ id: 'accel', level: 'warn', title: '硬件加速', detail: '未安装 emulator，跳过检查' });
        return;
      }
      const res = await accelCheck(sdk);
      const summary = firstLine(res.output.split(/\r?\n/).find((l) => /hypervisor|hvf|kvm|whpx|usable/i.test(l)) ?? res.output);
      if (res.ok) add({ id: 'accel', level: 'ok', title: '硬件加速', detail: summary || 'HVF 可用' });
      else add({ id: 'accel', level: 'fail', title: '硬件加速', detail: summary || '不可用', hint: hints.accel });
    });
  }

  await guard('images', '系统镜像', async () => {
    const images = sdk?.images ?? [];
    if (images.length === 0) {
      add({ id: 'images', level: 'fail', title: '系统镜像', detail: '未安装任何镜像', hint: hints['images-missing'] });
    } else {
      const names = images.map((i) => `${i.platform}/${i.tagId}`).join(', ');
      add({ id: 'images', level: 'ok', title: '系统镜像', detail: `${images.length} 个: ${names}` });
    }
    const def = settings.defaultImage;
    if (sdk && safeFindImage(sdk, def, (err) => opts.onError?.('default-image', err))) {
      add({ id: 'default-image', level: 'ok', title: '默认镜像', detail: `${def} 已安装` });
    } else {
      add({ id: 'default-image', level: 'fail', title: '默认镜像', detail: `${def} 未安装`, hint: hints['default-image'].replace('{image}', def) });
    }
  });

  await guard('licenses', 'SDK 许可', async () => {
    const accepted = sdk?.acceptedLicenses ?? [];
    if (accepted.length) add({ id: 'licenses', level: 'ok', title: 'SDK 许可', detail: `已接受 ${accepted.join(', ')}` });
    else add({ id: 'licenses', level: 'warn', title: 'SDK 许可', detail: '尚未接受任何许可', hint: hints.licenses });
  });

  await guard('host', '主机资源', async () => {
    const host = await manager.hostStats();
    // Same model as start() admission: an instance is charged its expected resident size, not its configured RAM.
    const perInstance = expectedResidentMb(settings.defaultSpec.ramMb);
    const need = perInstance + settings.memoryReserveMb;
    const pressure = host.memoryPressure ? `，内存压力 ${pressureLabel(host.memoryPressure)}` : '';
    const memDetail = `可用 ${gb(host.availableMemMb)} / 共 ${gb(host.totalMemMb)}，实例已占用 ${gb(host.committedInstanceRamMb)}${pressure}`;
    if (host.memoryPressure === 'critical') {
      add({ id: 'memory', level: 'fail', title: '内存', detail: memDetail, hint: hints['memory-critical'] });
    } else if (host.memoryPressure === 'warn' || host.availableMemMb < need) {
      add({
        id: 'memory',
        level: 'warn',
        title: '内存',
        detail: memDetail,
        hint: `再启动一个默认规格实例需约 ${gb(need)} 可用内存（预计常驻 ${gb(perInstance)} + 保留 ${gb(settings.memoryReserveMb)}）`,
      });
    } else {
      const more = Math.floor((host.availableMemMb - settings.memoryReserveMb) / perInstance);
      add({ id: 'memory', level: 'ok', title: '内存', detail: `${memDetail}；约还可启动 ${more} 个默认规格实例` });
    }
    const load = host.loadAvg[0];
    const loadDetail = `${load.toFixed(2)} / ${host.cpuCount} 核（${host.cpuModel}）`;
    if (load > host.cpuCount) add({ id: 'load', level: 'warn', title: '负载', detail: loadDetail, hint: hints.load });
    else add({ id: 'load', level: 'ok', title: '负载', detail: loadDetail });

    const records = await manager.registry.list();
    const running = host.runningInstances;
    const level: DoctorLevel = running >= settings.maxRunning ? 'warn' : 'ok';
    add({
      id: 'instances',
      level,
      title: '实例',
      detail: `${records.length} 个，运行中 ${running} / 上限 ${settings.maxRunning}`,
      ...(level === 'warn' ? { hint: hints['instances-limit'] } : {}),
    });
  });

  if (!skip.has('scrcpy')) {
    await guard('scrcpy', 'scrcpy', async () => {
      const found = await findExecutable('scrcpy', settings.scrcpyPath || undefined);
      if (found) add({ id: 'scrcpy', level: 'ok', title: 'scrcpy', detail: found });
      else if (settings.scrcpyPath) {
        add({ id: 'scrcpy', level: 'warn', title: 'scrcpy', detail: `设置的路径不可执行: ${settings.scrcpyPath}`, hint: hints['scrcpy-path'] });
      } else {
        const detail = audience === 'cli' ? '未找到（可选，`avdm view` 需要）' : '未找到（可选）';
        add({ id: 'scrcpy', level: 'warn', title: 'scrcpy', detail, hint: hints['scrcpy-missing'] });
      }
    });
  }

  return checks;
}
