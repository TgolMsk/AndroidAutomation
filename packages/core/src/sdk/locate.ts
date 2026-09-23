import { promises as fsp, type Dirent } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { InstalledImage, SdkInfo } from '../types.js';
import { AvdmError } from '../errors.js';
import { parseIniRecord } from '../util/ini.js';
import { readTextIfExists } from '../util/fs.js';
import { defaultSdkRoot } from '../paths.js';

/**
 * Inspect an SDK root on disk.
 * IMPLEMENTER: agent "core-sdk" (see docs/DESIGN.md §sdk).
 */

export interface ParsedImagePath {
  /** "android-35" */
  platform: string;
  /** "35" */
  apiLevel: string;
  tagId: string;
  abi: string;
  /** "system-images/android-35/default/arm64-v8a" (no trailing slash, forward slashes) */
  relDir: string;
}

/** Marker file we write into every package directory we install (see installer.ts). */
export const AVDM_PACKAGE_FILE = '.avdm-package.json';

export interface AvdmPackageMarker {
  path: string;
  revision: string;
  channel: string;
  licenseId: string;
  installedAt: string;
  sha1: string;
}

const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

function validSegment(s: string | undefined): s is string {
  return !!s && SEGMENT_RE.test(s) && s !== '.' && s !== '..';
}

/** "system-images;android-35;default;arm64-v8a" → parts. Throws AvdmError('INVALID_ARGUMENT'). */
export function parseImagePackagePath(pkgPath: string): ParsedImagePath {
  const parts = String(pkgPath ?? '').trim().split(';');
  const [kind, platform, tagId, abi] = parts;
  if (
    parts.length !== 4 ||
    kind !== 'system-images' ||
    !validSegment(platform) ||
    !validSegment(tagId) ||
    !validSegment(abi) ||
    !platform.startsWith('android-') ||
    platform.length <= 'android-'.length
  ) {
    throw new AvdmError(
      'INVALID_ARGUMENT',
      `无效的系统镜像包路径: "${pkgPath}"（应形如 system-images;android-35;default;arm64-v8a）`,
    );
  }
  return {
    platform,
    apiLevel: platform.slice('android-'.length),
    tagId,
    abi,
    relDir: `system-images/${platform}/${tagId}/${abi}`,
  };
}

// ───────────────────────────── API level ordering ─────────────────────────────

interface ApiKey {
  numeric: boolean;
  major: number;
  minor: number;
  ext: number;
  raw: string;
}

function apiKey(level: string): ApiKey {
  const raw = String(level ?? '').trim();
  const m = /^(\d+)(?:\.(\d+))?x?(?:-ext(\d+))?/i.exec(raw);
  if (!m) return { numeric: false, major: 0, minor: 0, ext: 0, raw };
  return {
    numeric: true,
    major: Number(m[1]),
    minor: m[2] ? Number(m[2]) : 0,
    ext: m[3] ? Number(m[3]) : 0,
    raw,
  };
}

/**
 * Compare API level strings such as "35", "36.1", "35-ext15", "CANARY" (ascending: -1 when a < b).
 * Extension images sort just above their base level; codenames (non-numeric) sort above all numeric levels.
 */
export function compareApiLevels(a: string, b: string): number {
  const ka = apiKey(a);
  const kb = apiKey(b);
  if (ka.numeric !== kb.numeric) return ka.numeric ? -1 : 1;
  if (!ka.numeric) return ka.raw < kb.raw ? -1 : ka.raw > kb.raw ? 1 : 0;
  for (const f of ['major', 'minor', 'ext'] as const) {
    if (ka[f] !== kb[f]) return ka[f] < kb[f] ? -1 : 1;
  }
  return 0;
}

/** True for released platform names ("android-35", "android-36.1", "android-35-ext15"), false for previews. */
export function isFinalPlatformName(platform: string): boolean {
  return /^android-\d+(?:\.\d+)?(?:-ext\d+)?$/.test(platform);
}

const DEFAULT_TAG_DISPLAY: Record<string, string> = {
  default: 'Default Android System Image',
  google_apis: 'Google APIs',
  google_apis_playstore: 'Google Play',
  google_apis_ps16k: 'Google APIs, 16 KB Page Size',
  google_apis_playstore_ps16k: 'Google Play, 16 KB Page Size',
};

/** Human display name for a system image tag id when the manifest/source.properties has none. */
export function defaultTagDisplay(tagId: string): string {
  return (
    DEFAULT_TAG_DISPLAY[tagId] ??
    tagId
      .split('_')
      .filter(Boolean)
      .map((w) => w[0]!.toUpperCase() + w.slice(1))
      .join(' ')
  );
}

const TAG_ORDER = ['default', 'google_apis', 'google_apis_playstore'];

// ───────────────────────────── Disk inspection ─────────────────────────────

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).isFile();
  } catch {
    return false;
  }
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** Visible subdirectory names (symlinks to directories included), sorted. */
async function listDirs(dir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (e.isDirectory() || (e.isSymbolicLink() && (await isDir(path.join(dir, e.name))))) out.push(e.name);
  }
  return out.sort();
}

async function readProps(file: string): Promise<Record<string, string>> {
  try {
    const text = await readTextIfExists(file);
    return text === undefined ? {} : parseIniRecord(text);
  } catch {
    return {};
  }
}

/** Read the `.avdm-package.json` marker of a package dir, if any. */
export async function readPackageMarker(dir: string): Promise<AvdmPackageMarker | undefined> {
  try {
    const text = await readTextIfExists(path.join(dir, AVDM_PACKAGE_FILE));
    if (text === undefined) return undefined;
    const v = JSON.parse(text) as Partial<AvdmPackageMarker>;
    return v && typeof v === 'object' ? (v as AvdmPackageMarker) : undefined;
  } catch {
    return undefined;
  }
}

async function locateEmulator(root: string): Promise<SdkInfo['emulator']> {
  const exe = process.platform === 'win32' ? '.exe' : '';
  const dir = path.join(root, 'emulator');
  const bin = path.join(dir, `emulator${exe}`);
  if (!(await isFile(bin))) return undefined;
  const result: NonNullable<SdkInfo['emulator']> = { dir, bin };
  const props = await readProps(path.join(dir, 'source.properties'));
  const version = props['Pkg.Revision'] || (await readPackageMarker(dir))?.revision;
  if (version) result.version = version;
  const qemuImg = path.join(dir, `qemu-img${exe}`);
  if (await isFile(qemuImg)) result.qemuImg = qemuImg;
  return result;
}

async function locateAdb(root: string): Promise<SdkInfo['adb']> {
  const exe = process.platform === 'win32' ? '.exe' : '';
  const dir = path.join(root, 'platform-tools');
  const bin = path.join(dir, `adb${exe}`);
  if (!(await isFile(bin))) return undefined;
  const result: NonNullable<SdkInfo['adb']> = { bin };
  const props = await readProps(path.join(dir, 'source.properties'));
  const version = props['Pkg.Revision'] || (await readPackageMarker(dir))?.revision;
  if (version) result.version = version;
  return result;
}

async function describeImage(root: string, platform: string, tag: string, abi: string): Promise<InstalledImage | undefined> {
  const dir = path.join(root, 'system-images', platform, tag, abi);
  if (!(await isFile(path.join(dir, 'system.img')))) return undefined;
  const props = await readProps(path.join(dir, 'source.properties'));
  const marker = await readPackageMarker(dir);

  const pathApi = platform.startsWith('android-') ? platform.slice('android-'.length) : platform;
  // Prefer the directory-derived level ("36.1", "35-ext15"); fall back to source.properties for codenames.
  const apiLevel = /^\d/.test(pathApi) ? pathApi : props['AndroidVersion.ApiLevel'] || pathApi;
  const tagId = (props['SystemImage.TagId'] || tag).split(',')[0]!.trim() || tag;
  const image: InstalledImage = {
    packagePath: `system-images;${platform};${tag};${abi}`,
    dir,
    sysdirRel: `system-images/${platform}/${tag}/${abi}/`,
    platform,
    apiLevel,
    tagId,
    tagDisplay: props['SystemImage.TagDisplay'] || DEFAULT_TAG_DISPLAY[tag] || defaultTagDisplay(tagId),
    abi: props['SystemImage.Abi'] || abi,
  };
  const revision = props['Pkg.Revision'] || marker?.revision;
  if (revision) image.revision = revision;
  return image;
}

async function locateImages(root: string): Promise<InstalledImage[]> {
  const sysRoot = path.join(root, 'system-images');
  const images: InstalledImage[] = [];
  for (const platform of await listDirs(sysRoot)) {
    for (const tag of await listDirs(path.join(sysRoot, platform))) {
      for (const abi of await listDirs(path.join(sysRoot, platform, tag))) {
        try {
          const img = await describeImage(root, platform, tag, abi);
          if (img) images.push(img);
        } catch {
          // unreadable image dir: skip
        }
      }
    }
  }
  const tagRank = (t: string) => {
    const i = TAG_ORDER.indexOf(t);
    return i === -1 ? TAG_ORDER.length : i;
  };
  return images.sort((a, b) => {
    const api = compareApiLevels(b.apiLevel, a.apiLevel);
    if (api !== 0) return api;
    const segA = a.packagePath.split(';')[2] ?? '';
    const segB = b.packagePath.split(';')[2] ?? '';
    const t = tagRank(segA) - tagRank(segB);
    if (t !== 0) return t;
    return a.packagePath < b.packagePath ? -1 : a.packagePath > b.packagePath ? 1 : 0;
  });
}

async function locateLicenses(root: string): Promise<string[]> {
  const dir = path.join(root, 'licenses');
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => (e.isFile() || e.isSymbolicLink()) && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();
}

/**
 * Locate emulator (<root>/emulator/emulator, version from source.properties Pkg.Revision,
 * qemu-img at <root>/emulator/qemu-img if present), adb (<root>/platform-tools/adb) and every installed
 * system image under <root>/system-images/<platform>/<tag>/<abi>/ that contains system.img
 * (tag display / revision from source.properties when present). Never throws for a missing SDK:
 * returns exists=false with empty lists.
 */
export async function locateSdk(sdkRoot: string): Promise<SdkInfo> {
  const root = path.resolve(expandHome(String(sdkRoot ?? '').trim() || defaultSdkRoot()));
  const info: SdkInfo = { root, exists: await isDir(root), images: [], acceptedLicenses: [] };
  if (!info.exists) return info;
  const [emulator, adb, images, licenses] = await Promise.all([
    locateEmulator(root).catch(() => undefined),
    locateAdb(root).catch(() => undefined),
    locateImages(root).catch(() => [] as InstalledImage[]),
    locateLicenses(root).catch(() => [] as string[]),
  ]);
  if (emulator) info.emulator = emulator;
  if (adb) info.adb = adb;
  info.images = images;
  info.acceptedLicenses = licenses;
  return info;
}

/** Find an installed image by package path. */
export function findInstalledImage(sdk: SdkInfo, pkgPath: string): InstalledImage | undefined {
  const want = String(pkgPath ?? '').trim();
  return sdk.images.find((img) => img.packagePath === want);
}
