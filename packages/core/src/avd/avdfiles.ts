import type { Dirent } from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { AvdmError, isAvdmError } from '../errors.js';
import { findInstalledImage } from '../sdk/locate.js';
import type { InstalledImage, InstanceRecord, InstanceSpec, SdkInfo } from '../types.js';
import { atomicWriteFile, cloneDirectory, pathExists, readTextIfExists } from '../util/fs.js';
import { parseIniRecord, serializeIni, updateIni } from '../util/ini.js';
import { execFileText } from '../util/proc.js';

/**
 * AVD files on disk, written directly (no avdmanager/Java needed).
 *   <avdHome>/<avdName>.ini        — avd.ini.encoding, path, path.rel, target
 *   <avdHome>/<avdName>.avd/config.ini
 * IMPLEMENTER: agent "core-avd" (see docs/DESIGN.md §avd).
 */

export interface AvdContext {
  avdHome: string;
  sdk: SdkInfo;
}

export function avdDirFor(avdHome: string, avdName: string): string {
  return path.join(avdHome, `${avdName}.avd`);
}

/** Path of the top-level `<avdHome>/<avdName>.ini` pointer file. */
export function avdIniFor(avdHome: string, avdName: string): string {
  return path.join(avdHome, `${avdName}.ini`);
}

/** Path of `<avdHome>/<avdName>.avd/config.ini`. */
export function avdConfigFor(avdHome: string, avdName: string): string {
  return path.join(avdDirFor(avdHome, avdName), 'config.ini');
}

/** Map a spec GPU mode onto the config.ini `hw.gpu.mode` value (the launcher passes the runtime `-gpu` flag). */
export function gpuModeToConfig(mode: InstanceSpec['gpuMode']): string {
  return mode === 'software' ? 'swiftshader_indirect' : mode;
}

/** config.ini hw.* keys derived from a spec (hw.cpu.ncore, hw.ramSize, hw.lcd.*, disk.dataPartition.size, hw.gpu.*). */
export function specToConfig(spec: InstanceSpec): Record<string, string> {
  return specKeys(spec);
}

/** Spec-derived config.ini keys with a precise (non-indexed) type. */
function specKeys(spec: InstanceSpec) {
  return {
    'hw.cpu.ncore': String(spec.cpuCores),
    // Plain integer = megabytes.
    'hw.ramSize': String(spec.ramMb),
    'hw.lcd.width': String(spec.width),
    'hw.lcd.height': String(spec.height),
    'hw.lcd.density': String(spec.dpi),
    // The emulator grows userdata-qemu.img to this size on the next launch.
    'disk.dataPartition.size': `${spec.dataPartitionGb}G`,
    'hw.gpu.mode': gpuModeToConfig(spec.gpuMode),
    'hw.initialOrientation': spec.width > spec.height ? 'landscape' : 'portrait',
    'skin.name': `${spec.width}x${spec.height}`,
  };
}

/** Full config.ini for a fresh AVD (see DESIGN.md for the exact key list). */
export function buildConfigIni(record: InstanceRecord, image: InstalledImage): Record<string, string> {
  const spec = specKeys(record.spec);
  const abi = image.abi || 'arm64-v8a';
  return {
    AvdId: record.avdName,
    'avd.ini.displayname': record.name,
    'avd.ini.encoding': 'UTF-8',
    'PlayStore.enabled': image.tagId.includes('playstore') ? 'true' : 'false',
    'abi.type': abi,
    'hw.cpu.arch': cpuArchForAbi(abi),
    'image.sysdir.1': normalizeSysdir(image.sysdirRel),
    'tag.id': image.tagId,
    'tag.display': image.tagDisplay,
    'hw.cpu.ncore': spec['hw.cpu.ncore'],
    'hw.ramSize': spec['hw.ramSize'],
    'hw.lcd.width': spec['hw.lcd.width'],
    'hw.lcd.height': spec['hw.lcd.height'],
    'hw.lcd.density': spec['hw.lcd.density'],
    'disk.dataPartition.size': spec['disk.dataPartition.size'],
    'hw.gpu.enabled': 'yes',
    'hw.gpu.mode': spec['hw.gpu.mode'],
    'hw.keyboard': 'yes',
    'hw.mainKeys': 'no',
    'hw.sdCard': 'no',
    'hw.audioInput': 'no',
    'hw.accelerometer': 'yes',
    'hw.gyroscope': 'no',
    'hw.sensors.orientation': 'yes',
    'hw.sensors.proximity': 'no',
    'hw.camera.back': 'none',
    'hw.camera.front': 'none',
    'hw.gps': 'yes',
    'hw.battery': 'yes',
    'hw.initialOrientation': spec['hw.initialOrientation'],
    'fastboot.forceColdBoot': 'no',
    'fastboot.forceFastBoot': 'yes',
    showDeviceFrame: 'no',
    'skin.dynamic': 'yes',
    'skin.name': spec['skin.name'],
    'skin.path': '_no_skin',
    'vm.heapSize': '512',
    // Same as the TapTap emulator (android-emu based) uses for games: fewer guest→host flush notifications.
    'hw.gltransport.drawFlushInterval': '1600',
    'runtime.network.latency': 'none',
    'runtime.network.speed': 'full',
  };
}

/** Contents of `<avdHome>/<avdName>.ini`. */
export function buildAvdIni(avdHome: string, avdName: string, target: string): Record<string, string> {
  return {
    'avd.ini.encoding': 'UTF-8',
    path: avdDirFor(avdHome, avdName),
    'path.rel': `avd/${avdName}.avd`,
    target,
  };
}

/**
 * Create <avdName>.ini and <avdName>.avd/config.ini for `record`. Throws AvdmError('IMAGE_MISSING')
 * if record.image is not installed, AvdmError('INVALID_ARGUMENT') if the AVD already exists.
 */
export async function createAvd(ctx: AvdContext, record: InstanceRecord): Promise<void> {
  assertAvdName(record.avdName);
  const image = findInstalledImage(ctx.sdk, record.image);
  if (!image) {
    throw new AvdmError('IMAGE_MISSING', `系统镜像未安装: ${record.image}，请先运行 avdm sdk install "${record.image}"`, {
      image: record.image,
    });
  }
  const dir = avdDirFor(ctx.avdHome, record.avdName);
  const iniFile = avdIniFor(ctx.avdHome, record.avdName);
  if ((await pathExists(dir)) || (await pathExists(iniFile))) {
    throw new AvdmError('INVALID_ARGUMENT', `AVD 已存在: ${record.avdName}（${dir}）`);
  }
  await fsp.mkdir(ctx.avdHome, { recursive: true });
  try {
    await fsp.mkdir(dir); // non-recursive: fails with EEXIST if another process raced us
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new AvdmError('INVALID_ARGUMENT', `AVD 已存在: ${record.avdName}（${dir}）`);
    }
    throw err;
  }
  try {
    // config.ini first so the pointer .ini never references an incomplete AVD.
    await atomicWriteFile(path.join(dir, 'config.ini'), serializeIni(buildConfigIni(record, image)));
    await atomicWriteFile(iniFile, serializeIni(buildAvdIni(ctx.avdHome, record.avdName, image.platform)));
  } catch (err) {
    await removeAvdFiles(ctx.avdHome, record.avdName);
    throw err;
  }
}

/** Rewrite spec-derived keys in config.ini (preserving other keys) and avd.ini.displayname. Instance must be stopped. */
export async function updateAvdConfig(ctx: AvdContext, record: InstanceRecord): Promise<void> {
  assertAvdName(record.avdName);
  const file = avdConfigFor(ctx.avdHome, record.avdName);
  const text = await readTextIfExists(file);
  if (text === undefined) {
    throw new AvdmError('INVALID_ARGUMENT', `AVD 配置文件不存在: ${file}`);
  }
  const patch: Record<string, string> = { ...specToConfig(record.spec), 'avd.ini.displayname': record.name };
  await atomicWriteFile(file, updateIni(text, patch));
}

export async function readAvdConfig(avdHome: string, avdName: string): Promise<Record<string, string> | undefined> {
  const text = await readTextIfExists(avdConfigFor(avdHome, avdName));
  return text === undefined ? undefined : parseIniRecord(text);
}

/** Top-level files/dirs in an AVD that belong to one emulator run and must not be carried into a clone. */
export const CLONE_EXCLUDED_ENTRIES: readonly string[] = [
  'multiinstance.lock',
  'hardware-qemu.ini',
  'bootcompleted.ini',
  'read-snapshot.txt',
  'quickbootChoice.ini',
  'tmpAdbCmds',
  // Per-run files observed with emulator 37.1.11 (regenerated on launch):
  'emu-launch-params.txt',
  'netsim.ini',
];

/**
 * Clone a stopped AVD to `dst.avdName` using APFS copy-on-write (cloneDirectory), then:
 *  - delete runtime/lock files: *.lock, multiinstance.lock, hardware-qemu.ini, bootcompleted.ini,
 *    read-snapshot.txt, quickbootChoice.ini, tmpAdbCmds/, and snapshots/ unless keepSnapshots
 *  - write <dst>.ini with the new path, rewrite config.ini AvdId / avd.ini.displayname and spec keys
 *  - for every *.qcow2 in the clone whose backing file points inside the source AVD dir, re-point it
 *    to the clone's copy with `<qemu-img> rebase -u -F <fmt> -b <newBacking> <file>` (qemu-img from sdk.emulator.qemuImg;
 *    if qemu-img is unavailable and such overlays exist, delete those overlays — the emulator recreates them).
 * Returns the copy method used.
 */
export async function cloneAvd(
  ctx: AvdContext,
  srcAvdName: string,
  dst: InstanceRecord,
  opts: { keepSnapshots?: boolean } = {},
): Promise<{ method: 'apfs-clone' | 'copy' }> {
  assertAvdName(srcAvdName);
  assertAvdName(dst.avdName);
  if (srcAvdName === dst.avdName) {
    throw new AvdmError('INVALID_ARGUMENT', `克隆的源与目标相同: ${srcAvdName}`);
  }
  const srcDir = avdDirFor(ctx.avdHome, srcAvdName);
  const srcConfigText = await readTextIfExists(path.join(srcDir, 'config.ini'));
  if (srcConfigText === undefined) {
    throw new AvdmError('INVALID_ARGUMENT', `源 AVD 不存在或缺少 config.ini: ${srcDir}`);
  }
  const srcIni = parseIniRecord((await readTextIfExists(avdIniFor(ctx.avdHome, srcAvdName))) ?? '');
  const dstDir = avdDirFor(ctx.avdHome, dst.avdName);
  const dstIni = avdIniFor(ctx.avdHome, dst.avdName);
  if ((await pathExists(dstDir)) || (await pathExists(dstIni))) {
    throw new AvdmError('INVALID_ARGUMENT', `目标 AVD 已存在: ${dst.avdName}（${dstDir}）`);
  }
  const target = srcIni.target || findInstalledImage(ctx.sdk, dst.image)?.platform || platformFromPackagePath(dst.image);

  let method: 'apfs-clone' | 'copy';
  try {
    ({ method } = await cloneDirectory(srcDir, dstDir));
  } catch (err) {
    // INVALID_ARGUMENT = the destination appeared concurrently: it is not ours to delete.
    if (!isAvdmError(err, 'INVALID_ARGUMENT')) await removeAvdFiles(ctx.avdHome, dst.avdName);
    throw err;
  }
  try {
    await pruneCloneRuntimeFiles(dstDir, opts.keepSnapshots === true);
    // A source dir that contains the clone (e.g. a corrupt `path=` pointing at avdHome) would make
    // every overlay look foreign, so such spellings are ignored.
    const srcDirs = (await equivalentPaths([srcDir, srcIni.path])).filter(
      (d) => relativeInside(dstDir, [d]) === undefined,
    );
    await retargetOverlays({ dstDir, srcDirs, qemuImg: await usableQemuImg(ctx.sdk) });
    if (opts.keepSnapshots) {
      // A kept snapshot's hardware.ini still names the source AVD (avd.id/avd.name) and its disk paths; the
      // emulator then refuses it ("hardware cannot load snapshot") and cold-boots. Point it at the clone.
      await retargetSnapshotHardware(dstDir, { srcDirs, dstDir, srcName: srcAvdName, dstName: dst.avdName });
    }
    const configText = (await readTextIfExists(path.join(dstDir, 'config.ini'))) ?? srcConfigText;
    await atomicWriteFile(
      path.join(dstDir, 'config.ini'),
      updateIni(configText, { ...specToConfig(dst.spec), AvdId: dst.avdName, 'avd.ini.displayname': dst.name }),
    );
    // Written last: the AVD only becomes visible to the emulator once everything else is in place.
    await atomicWriteFile(dstIni, serializeIni(buildAvdIni(ctx.avdHome, dst.avdName, target)));
  } catch (err) {
    await removeAvdFiles(ctx.avdHome, dst.avdName);
    throw err;
  }
  return { method };
}

/** Delete <avdName>.ini and <avdName>.avd/ (no-op if absent), plus leftovers of an interrupted delete. */
export async function deleteAvd(avdHome: string, avdName: string): Promise<void> {
  assertAvdName(avdName);
  await retireAvd(avdHome, avdName);
  await removeAvdFiles(avdHome, avdName);
  await purgeRetiredAvds(avdHome, avdName);
}

/** Suffix of an AVD dir that is being deleted (see retireAvd). */
const RETIRED_SUFFIX = '.deleting-';

/**
 * First step of a delete: atomically rename <avdName>.avd to <avdName>.avd.deleting-<rand> so that a crash
 * before the recursive delete finishes leaves something recognisably disposable (purgeRetiredAvds) instead of
 * an unknown AVD that must be preserved. Returns the new path (undefined if there was no dir).
 */
export async function retireAvd(avdHome: string, avdName: string): Promise<string | undefined> {
  assertAvdName(avdName);
  const dir = avdDirFor(avdHome, avdName);
  const retired = `${dir}${RETIRED_SUFFIX}${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  try {
    await fsp.rename(dir, retired);
    return retired;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

/** Undo retireAvd() (e.g. when removing the registry record failed). */
export async function restoreRetiredAvd(avdHome: string, avdName: string, retired: string): Promise<void> {
  assertAvdName(avdName);
  await fsp.rename(retired, avdDirFor(avdHome, avdName));
}

/** Delete every retired copy of this AVD (<avdName>.avd.deleting-*). Returns how many were removed. */
export async function purgeRetiredAvds(avdHome: string, avdName: string): Promise<number> {
  assertAvdName(avdName);
  const prefix = `${avdName}.avd${RETIRED_SUFFIX}`;
  let names: string[];
  try {
    names = await fsp.readdir(avdHome);
  } catch {
    return 0;
  }
  let n = 0;
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    await fsp.rm(path.join(avdHome, name), { recursive: true, force: true });
    n++;
  }
  return n;
}

/** Folder (inside avdHome, invisible to the emulator which only reads top-level *.ini) for unregistered AVDs. */
export const ORPHANED_DIR = 'orphaned';

/**
 * Move an AVD that is not in the registry (lost registry, older crashed delete…) out of the way instead of
 * deleting it: <avdHome>/orphaned/<avdName>-<yyyyMMddHHmmss>/{<avdName>.avd, <avdName>.ini}. Returns that dir,
 * or undefined when there was nothing to move.
 */
export async function quarantineAvd(avdHome: string, avdName: string): Promise<string | undefined> {
  assertAvdName(avdName);
  const dir = avdDirFor(avdHome, avdName);
  const ini = avdIniFor(avdHome, avdName);
  const hasDir = await pathExists(dir);
  const hasIni = await pathExists(ini);
  if (!hasDir && !hasIni) return undefined;
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const root = path.join(avdHome, ORPHANED_DIR);
  await fsp.mkdir(root, { recursive: true });
  let dest = path.join(root, `${avdName}-${stamp}`);
  for (let i = 2; ; i++) {
    try {
      await fsp.mkdir(dest);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      dest = path.join(root, `${avdName}-${stamp}-${i}`);
    }
  }
  if (hasDir) await fsp.rename(dir, path.join(dest, path.basename(dir)));
  if (hasIni) await fsp.rename(ini, path.join(dest, path.basename(ini)));
  return dest;
}

// ───────────────────────────── Quick Boot snapshot bookkeeping ─────────────────────────────

/**
 * Marker file in the AVD dir: "the Quick Boot snapshot may be older than the disk". Loading such a snapshot
 * rolls the disk back (qcow2 internal snapshots) and silently loses everything written since, or resumes a VM
 * that was saved half-booted. The manager writes it when a session starts and removes it only after the
 * emulator exited in an orderly way AND wrote snapshot.pb during that session (the save on exit); a launch
 * that finds it skips the snapshot load once (-no-snapshot-load: cold boot from the current disk, fresh
 * snapshot saved on exit).
 * It travels with clones on purpose (a clone's kept snapshot has the same relationship to its copied disk).
 */
export const SNAPSHOT_STALE_MARKER = '.avdm-snapshot-stale';

export function snapshotStaleMarkerFor(avdHome: string, avdName: string): string {
  return path.join(avdDirFor(avdHome, avdName), SNAPSHOT_STALE_MARKER);
}

export async function markSnapshotStale(avdHome: string, avdName: string, reason: string): Promise<void> {
  assertAvdName(avdName);
  if (!(await pathExists(avdDirFor(avdHome, avdName)))) return;
  await atomicWriteFile(snapshotStaleMarkerFor(avdHome, avdName), `${new Date().toISOString()} ${reason}\n`);
}

export async function clearSnapshotStale(avdHome: string, avdName: string): Promise<void> {
  assertAvdName(avdName);
  await fsp.rm(snapshotStaleMarkerFor(avdHome, avdName), { force: true });
}

export async function isSnapshotStale(avdHome: string, avdName: string): Promise<boolean> {
  assertAvdName(avdName);
  return pathExists(snapshotStaleMarkerFor(avdHome, avdName));
}

/** The default Quick Boot snapshot exists (snapshots/default_boot/snapshot.pb). */
export async function hasQuickBootSnapshot(avdHome: string, avdName: string): Promise<boolean> {
  return (await quickBootSnapshotSavedAt(avdHome, avdName)) !== undefined;
}

/** When the default Quick Boot snapshot was last written (mtime of snapshot.pb, epoch ms), if it exists. */
export async function quickBootSnapshotSavedAt(avdHome: string, avdName: string): Promise<number | undefined> {
  assertAvdName(avdName);
  try {
    return (await fsp.stat(path.join(avdDirFor(avdHome, avdName), 'snapshots', 'default_boot', 'snapshot.pb'))).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * Disk usage of the AVD dir in bytes (allocated blocks, so APFS clones/sparse files are not over-counted).
 * Note: `du` has no way to see APFS block sharing, so a fresh clone is reported at its full logical
 * allocation even though it initially costs ~0 extra bytes on disk. Sparse images are counted correctly.
 */
export async function avdDiskUsage(avdHome: string, avdName: string): Promise<number> {
  assertAvdName(avdName);
  const dir = avdDirFor(avdHome, avdName);
  if (!(await pathExists(dir))) return 0;
  if (process.platform !== 'win32') {
    try {
      const out = await execFileText('du', ['-sk', dir], { timeoutMs: 120_000 });
      const kb = Number.parseInt(out.trim().split(/\s+/)[0] ?? '', 10);
      if (Number.isFinite(kb)) return kb * 1024;
    } catch {
      // fall through to the in-process walk
    }
  }
  return allocatedBytes(dir);
}

// ───────────────────────────── internals ─────────────────────────────

const AVD_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** AVD names end up in rm -rf paths; refuse anything that could escape avdHome. */
function assertAvdName(name: string): void {
  if (typeof name !== 'string' || !AVD_NAME_RE.test(name) || name.includes('..')) {
    throw new AvdmError('INVALID_ARGUMENT', `无效的 AVD 名称: ${JSON.stringify(name)}`);
  }
}

/** "system-images;android-35;default;arm64-v8a" → "android-35" (best effort, for the .ini `target`). */
function platformFromPackagePath(pkgPath: string): string {
  return pkgPath.split(';')[1] ?? '';
}

function cpuArchForAbi(abi: string): string {
  switch (abi) {
    case 'arm64-v8a':
      return 'arm64';
    case 'armeabi-v7a':
    case 'armeabi':
      return 'arm';
    case 'x86_64':
      return 'x86_64';
    case 'x86':
      return 'x86';
    default:
      return abi;
  }
}

function normalizeSysdir(rel: string): string {
  const s = rel.replace(/\\/g, '/');
  return s.endsWith('/') ? s : `${s}/`;
}

async function removeAvdFiles(avdHome: string, avdName: string): Promise<void> {
  await fsp.rm(avdIniFor(avdHome, avdName), { force: true });
  await fsp.rm(avdDirFor(avdHome, avdName), { recursive: true, force: true });
}

/** Remove per-run state from a freshly cloned AVD directory. */
async function pruneCloneRuntimeFiles(dir: string, keepSnapshots: boolean): Promise<void> {
  const topLevel = [...CLONE_EXCLUDED_ENTRIES];
  if (!keepSnapshots) topLevel.push('snapshots');
  for (const name of topLevel) {
    await fsp.rm(path.join(dir, name), { recursive: true, force: true });
  }
  // *.lock anywhere in the tree (the emulator's file locks may be files, dirs or symlinks).
  for (const entry of await walk(dir)) {
    if (entry.name.endsWith('.lock')) {
      await fsp.rm(path.join(entry.parentPath, entry.name), { recursive: true, force: true });
    }
  }
}

interface OverlayRetargetInput {
  dstDir: string;
  /** Every spelling of the source AVD dir (as configured, real path, .ini `path=`). */
  srcDirs: string[];
  /** qemu-img binary, or undefined if unavailable. */
  qemuImg: string | undefined;
}

/**
 * Re-point qcow2 overlays in the clone whose backing file lives in the source AVD dir.
 * Overlays with relative backing names already resolve inside the clone, and overlays backed by
 * SDK images (system.img, vendor.img) stay as they are.
 */
async function retargetOverlays({ dstDir, srcDirs, qemuImg }: OverlayRetargetInput): Promise<void> {
  const overlays = (await walk(dstDir))
    .filter((e) => e.isFile() && e.name.endsWith('.qcow2'))
    .map((e) => path.join(e.parentPath, e.name));
  for (const file of overlays) {
    const info = qemuImg ? await qemuImgInfo(qemuImg, file) : await readQcow2Header(file);
    const backing = info?.['backing-filename'];
    if (!backing) continue;
    const rel = relativeInside(path.resolve(path.dirname(file), backing), srcDirs);
    if (rel === undefined) continue;
    const newBacking = path.join(dstDir, rel);
    if (!qemuImg || !(await pathExists(newBacking))) {
      // Cannot safely re-point it: drop the overlay rather than let the clone read the source's disk.
      await fsp.rm(file, { force: true });
      continue;
    }
    const format = info['backing-filename-format'] || (await qemuImgInfo(qemuImg, newBacking))?.format || 'raw';
    await execFileText(qemuImg, ['rebase', '-u', '-F', format, '-b', newBacking, file], { timeoutMs: 60_000 });
  }
}

interface HardwareRetarget {
  /** Every spelling of the source AVD dir. */
  srcDirs: string[];
  dstDir: string;
  srcName: string;
  dstName: string;
}

/**
 * Rewrite a snapshot's hardware.ini (`key = value` lines) for a clone: values equal to the source AVD id become
 * the clone's id (avd.id / avd.name), absolute paths inside the source AVD dir (disk.*Partition.path …) are
 * re-rooted into the clone. Everything else, including formatting, is kept byte for byte.
 */
export function rewriteSnapshotHardwareIni(text: string, t: HardwareRetarget): string {
  return text
    .split(/(\r?\n)/)
    .map((line) => {
      const m = /^(\s*[^\s#;=][^=]*=[ \t]*)(.*?)([ \t]*)$/.exec(line);
      if (!m) return line;
      const [, head, value, tail] = m as unknown as [string, string, string, string];
      let next = value;
      if (value === t.srcName) next = t.dstName;
      else if (path.isAbsolute(value)) {
        const abs = path.resolve(value);
        if (t.srcDirs.includes(abs)) next = t.dstDir;
        else {
          const rel = relativeInside(abs, t.srcDirs);
          if (rel !== undefined) next = path.join(t.dstDir, rel);
        }
      }
      return next === value ? line : `${head}${next}${tail}`;
    })
    .join('');
}

/** Apply rewriteSnapshotHardwareIni to snapshots/<every snapshot>/hardware.ini of a cloned AVD dir. */
async function retargetSnapshotHardware(dstDir: string, t: HardwareRetarget): Promise<void> {
  const root = path.join(dstDir, 'snapshots');
  let names: string[];
  try {
    names = await fsp.readdir(root);
  } catch {
    return; // no snapshots kept
  }
  for (const name of names) {
    const file = path.join(root, name, 'hardware.ini');
    const text = await readTextIfExists(file).catch(() => undefined);
    if (text === undefined) continue;
    const next = rewriteSnapshotHardwareIni(text, t);
    if (next !== text) await atomicWriteFile(file, next);
  }
}

/** Subset of `qemu-img info --output=json` we use. */
interface QemuImgInfo {
  format?: string;
  'backing-filename'?: string;
  'backing-filename-format'?: string;
}

async function qemuImgInfo(qemuImg: string, file: string): Promise<QemuImgInfo | undefined> {
  const out = await execFileText(qemuImg, ['info', '--output=json', file], { timeoutMs: 30_000 });
  try {
    return JSON.parse(out) as QemuImgInfo;
  } catch {
    throw new AvdmError('COMMAND_FAILED', `无法解析 qemu-img info 输出: ${file}`, { stdout: out });
  }
}

const QCOW2_MAGIC = 0x514649fb; // "QFI\xfb"

/** Read the backing file name straight from a qcow2 header (used when qemu-img is unavailable). */
export async function readQcow2Header(file: string): Promise<QemuImgInfo | undefined> {
  let fh: fsp.FileHandle | undefined;
  try {
    fh = await fsp.open(file, 'r');
    const head = Buffer.alloc(20);
    const { bytesRead } = await fh.read(head, 0, head.length, 0);
    if (bytesRead < head.length || head.readUInt32BE(0) !== QCOW2_MAGIC) return undefined;
    const offset = head.readBigUInt64BE(8);
    const size = head.readUInt32BE(16);
    if (offset === 0n || size === 0 || size > 4096) return { format: 'qcow2' };
    const name = Buffer.alloc(size);
    const r = await fh.read(name, 0, size, Number(offset));
    return { format: 'qcow2', 'backing-filename': name.subarray(0, r.bytesRead).toString('utf8') };
  } catch {
    return undefined;
  } finally {
    await fh?.close();
  }
}

async function usableQemuImg(sdk: SdkInfo): Promise<string | undefined> {
  const bin = sdk.emulator?.qemuImg;
  return bin && (await pathExists(bin)) ? bin : undefined;
}

/** Path plus its realpath (deduplicated), for comparing paths that may go through symlinks (/var → /private/var). */
async function equivalentPaths(paths: Array<string | undefined>): Promise<string[]> {
  const out = new Set<string>();
  for (const p of paths) {
    if (!p) continue;
    out.add(path.resolve(p));
    try {
      out.add(await fsp.realpath(p));
    } catch {
      // missing path: keep the literal spelling only
    }
  }
  return [...out];
}

/** If `abs` lies strictly inside one of `dirs`, its path relative to that dir. */
function relativeInside(abs: string, dirs: string[]): string | undefined {
  for (const dir of dirs) {
    const rel = path.relative(dir, abs);
    if (rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)) return rel;
  }
  return undefined;
}

async function walk(dir: string): Promise<Dirent[]> {
  return fsp.readdir(dir, { recursive: true, withFileTypes: true });
}

/** Allocated bytes of a tree (st.blocks * 512), used when `du` is unavailable. */
async function allocatedBytes(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await walk(dir)) {
    try {
      const st = await fsp.lstat(path.join(entry.parentPath, entry.name));
      total += st.blocks ? st.blocks * 512 : st.size;
    } catch {
      // vanished while walking
    }
  }
  return total;
}
