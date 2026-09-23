import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, promises as fsp } from 'node:fs';
import path from 'node:path';
import type { InstallPhase, InstallProgress, RemotePackage } from '../types.js';
import { AvdmError, isAvdmError } from '../errors.js';
import { ensureDir, pathExists, readTextIfExists } from '../util/fs.js';
import { isPidAlive } from '../util/proc.js';
import { selectArchive } from './catalog.js';
import { httpDownload } from './http.js';
import { AVDM_PACKAGE_FILE, type AvdmPackageMarker } from './locate.js';

/**
 * Install SDK packages without Java/sdkmanager: download archive → verify SHA-1 → extract → move into place.
 * IMPLEMENTER: agent "core-sdk" (see docs/DESIGN.md §sdk).
 */

function sha1Hex(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex');
}

/** Java String.trim(): strips chars <= U+0020 at both ends. */
function javaTrim(s: string): string {
  return s.replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, '');
}

/**
 * License text as sdkmanager / Android Studio hash it. Their JAXB `TrimStringAdapter` unmarshals text as
 * `s.replaceAll("(?<=\\s)[ \t]*", "").replaceAll("(?<!\n)\n(?!\n)", " ").trim()` — drop indentation that follows
 * whitespace, join single line breaks with a space, trim. SHA-1 of this form reproduces the well-known
 * hashes (android-sdk-license → 24333f8a…, android-sdk-arm-dbt-license → 859f3176…).
 */
export function sdkmanagerLicenseText(text: string): string {
  const JAVA_WS = '[ \\t\\n\\u000B\\f\\r]';
  return javaTrim(
    text.replace(new RegExp(`(?<=${JAVA_WS})[ \\t]*`, 'g'), '').replace(/(?<!\n)\n(?!\n)/g, ' '),
  );
}

/**
 * Hashes written to <sdk>/licenses/<id> to record acceptance. We write both the SHA-1 of the raw
 * license text and of the trimmed text (one line each) so Android Studio's sdkmanager recognises it.
 * A third hash of the sdkmanager-normalised text (see sdkmanagerLicenseText) is what sdkmanager itself
 * actually compares against, so it is included too. Order: raw, trimmed, sdkmanager; de-duplicated.
 */
export function licenseHashes(text: string): string[] {
  const out: string[] = [];
  for (const h of [sha1Hex(text), sha1Hex(text.trim()), sha1Hex(sdkmanagerLicenseText(text))]) {
    if (!out.includes(h)) out.push(h);
  }
  return out;
}

function licenseFile(sdkRoot: string, licenseId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(licenseId) || licenseId === '.' || licenseId === '..') {
    throw new AvdmError('INVALID_ARGUMENT', `无效的许可 ID: "${licenseId}"`);
  }
  return path.join(sdkRoot, 'licenses', licenseId);
}

function parseHashLines(content: string | undefined): string[] {
  if (!content) return [];
  return content
    .split(/\r?\n/)
    .map((l) => l.trim().toLowerCase())
    .filter(Boolean);
}

export async function isLicenseAccepted(sdkRoot: string, licenseId: string, text: string): Promise<boolean> {
  if (!licenseId) return true; // package declares no license
  const recorded = new Set(parseHashLines(await readTextIfExists(licenseFile(sdkRoot, licenseId))));
  if (!text) return recorded.size > 0; // license text unknown: any recorded acceptance counts
  return licenseHashes(text).some((h) => recorded.has(h));
}

/** Record acceptance (append missing hashes to <sdk>/licenses/<licenseId>). Only call after explicit user consent. */
export async function acceptLicense(sdkRoot: string, licenseId: string, text: string): Promise<void> {
  const file = licenseFile(sdkRoot, licenseId);
  if (!text) throw new AvdmError('INVALID_ARGUMENT', `许可 "${licenseId}" 的内容为空，无法记录同意`);
  await ensureDir(path.dirname(file));
  const existing = (await readTextIfExists(file)) ?? '';
  const have = new Set(parseHashLines(existing));
  const missing = licenseHashes(text).filter((h) => !have.has(h));
  if (!missing.length) return;
  const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
  await fsp.appendFile(file, prefix + missing.join('\n') + '\n', 'utf8');
}

/**
 * Directory a package installs into:
 *   "emulator"         → <sdk>/emulator
 *   "platform-tools"   → <sdk>/platform-tools
 *   "system-images;android-35;default;arm64-v8a" → <sdk>/system-images/android-35/default/arm64-v8a
 *   generic "a;b;c"    → <sdk>/a/b/c
 */
export function packageInstallDir(sdkRoot: string, pkgPath: string): string {
  const segs = String(pkgPath ?? '').trim().split(';');
  for (const s of segs) {
    if (!s || s === '.' || s === '..' || !/^[A-Za-z0-9._-]+$/.test(s)) {
      throw new AvdmError('INVALID_ARGUMENT', `无效的 SDK 包路径: "${pkgPath}"`);
    }
  }
  return path.join(sdkRoot, ...segs);
}

export interface InstallPackageOptions {
  sdkRoot: string;
  pkg: RemotePackage;
  /** Full license text for pkg.licenseId (from the catalog). */
  licenseText: string;
  downloadsDir: string;
  onProgress?: (p: InstallProgress) => void;
  signal?: AbortSignal;
}

/** Streaming SHA-1 of a file (lowercase hex). */
export function sha1File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha1');
    const stream = createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function archiveFileName(url: string, sha1: string): string {
  let base = 'package.zip';
  try {
    base = decodeURIComponent(path.posix.basename(new URL(url).pathname)) || base;
  } catch {
    base = path.posix.basename(url) || base;
  }
  base = base.replace(/[^A-Za-z0-9._-]/g, '_');
  return `${sha1}-${base}`;
}

function throwIfAborted(signal: AbortSignal | undefined, what: string): void {
  if (signal?.aborted) throw new AvdmError('DOWNLOAD_FAILED', `安装已取消: ${what}`);
}

/**
 * Run a file tool (unzip, cp) to completion; an AbortSignal kills it (→ DOWNLOAD_FAILED "安装已取消").
 * `action` names what it does ("解压"), `failure` builds the message for a non-zero exit.
 */
function runTool(
  tool: { bin: string; args: string[]; action: string },
  signal: AbortSignal | undefined,
  failure: (status: string, lastErr: string) => string,
): Promise<void> {
  const name = path.basename(tool.bin);
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AvdmError('DOWNLOAD_FAILED', '安装已取消'));
      return;
    }
    const child = spawn(tool.bin, tool.args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    let aborted = false;
    child.stderr?.on('data', (d: Buffer) => {
      err += d.toString('utf8');
      if (err.length > 16_384) err = err.slice(-8_192);
    });
    const onAbort = () => {
      aborted = true;
      child.kill('SIGKILL');
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e: NodeJS.ErrnoException) => {
      signal?.removeEventListener('abort', onAbort);
      reject(
        new AvdmError(
          'COMMAND_FAILED',
          e.code === 'ENOENT' ? `找不到 ${name}（${tool.bin}），无法${tool.action}` : `启动 ${name} 失败: ${e.message}`,
        ),
      );
    });
    child.on('close', (code, sig) => {
      signal?.removeEventListener('abort', onAbort);
      if (aborted) reject(new AvdmError('DOWNLOAD_FAILED', '安装已取消'));
      else if (code === 0) resolve();
      else {
        const status = code !== null ? `${name} 退出码 ${code}` : `信号 ${sig}`;
        reject(new AvdmError('COMMAND_FAILED', failure(status, err.trim().split('\n').pop() ?? '')));
      }
    });
  });
}

/** Run unzip; AbortSignal kills it. */
function unzip(zipFile: string, destDir: string, signal?: AbortSignal): Promise<void> {
  const bin = process.platform === 'darwin' ? '/usr/bin/unzip' : 'unzip';
  return runTool(
    { bin, args: ['-q', '-o', zipFile, '-d', destDir], action: '解压' },
    signal,
    (status, lastErr) => `解压失败: ${path.basename(zipFile)}（${status}${lastErr ? `；${lastErr}` : ''}）`,
  );
}

/**
 * Copy a directory tree to `dst` (must not exist) — the cross-volume fallback for rename. A `cp`
 * child process (modes, times and symlinks preserved) so an abort stops a multi-GB copy at once.
 */
function copyTree(src: string, dst: string, signal?: AbortSignal): Promise<void> {
  if (process.platform === 'win32') {
    if (signal?.aborted) return Promise.reject(new AvdmError('DOWNLOAD_FAILED', '安装已取消'));
    return fsp.cp(src, dst, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
  }
  return runTool(
    { bin: '/bin/cp', args: ['-pPR', src, dst], action: '复制' },
    signal,
    (status, lastErr) => `复制失败（${status}${lastErr ? `；${lastErr}` : ''}）`,
  );
}

// ───────────────────────────── leftovers of interrupted installs ─────────────────────────────

/**
 * Temp dirs carry the owning process id — `<sdk>/.temp/extract-<pid>-XXXXXX` and, next to the install
 * dir, `.<name>.avdm-new-<pid>-<hex>` (staged copy) / `.<name>.avdm-old-<pid>-<hex>` (previous version
 * set aside). A hard exit (second Ctrl-C, kill -9, power loss) leaves them behind; sweepLeftovers()
 * removes those whose owner is gone at the start of the next install.
 */
const EXTRACT_RE = /^extract-(?:(\d+)-)?/;
const ASIDE_RE = /^\..+\.avdm-(?:old|new)-(?:(\d+)-)?[0-9a-f]+$/;
/** Leftovers without an owner pid (older naming) or with a recycled pid: removed once this old. */
const UNOWNED_STALE_MS = 60 * 60_000;
const OWNED_STALE_MS = 24 * 60 * 60_000;

function ownerTag(): string {
  return `${process.pid}-${randomBytes(4).toString('hex')}`;
}

async function sweepLeftovers(dir: string, pattern: RegExp): Promise<void> {
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of names) {
    const m = pattern.exec(name);
    if (!m) continue;
    const full = path.join(dir, name);
    try {
      const st = await fsp.lstat(full);
      if (!st.isDirectory()) continue;
      const age = now - st.mtimeMs;
      const pid = m[1] ? Number(m[1]) : undefined;
      const stale = pid !== undefined ? !isPidAlive(pid) || age > OWNED_STALE_MS : age > UNOWNED_STALE_MS;
      if (stale) await fsp.rm(full, { recursive: true, force: true });
    } catch {
      // best effort: never fail an install over a leftover
    }
  }
}

/** The single top-level directory of an extracted archive, or the extraction dir itself otherwise. */
async function contentRoot(extractDir: string): Promise<string> {
  const entries = (await fsp.readdir(extractDir, { withFileTypes: true })).filter(
    (e) => e.name !== '__MACOSX' && e.name !== '.DS_Store',
  );
  const only = entries[0];
  if (entries.length === 1 && only && only.isDirectory()) return path.join(extractDir, only.name);
  return extractDir;
}

/**
 * 1. Refuse with AvdmError('LICENSE_NOT_ACCEPTED') unless isLicenseAccepted(pkg.licenseId).
 * 2. Pick the host archive (selectArchive) → httpDownload into downloadsDir/<sha1>-<basename>.
 * 3. Verify SHA-1 (AvdmError('CHECKSUM_MISMATCH') and delete file on mismatch).
 * 4. Extract with /usr/bin/unzip -q into a temp dir inside <sdk>/.temp; the archive contains exactly
 *    one top-level directory (e.g. "emulator/", "platform-tools/", "arm64-v8a/") — stage it next to
 *    packageInstallDir() (a rename, or a copy when <sdk>/.temp is on another volume) and rename it into
 *    place, replacing any previous install (old dir renamed aside, deleted after success). The install
 *    dir therefore only ever appears complete, even if the process is killed half way.
 * 5. Write <installDir>/.avdm-package.json { path, revision, channel, licenseId, installedAt, sha1 }
 *    (into the staged dir, before it is renamed into place).
 * Leftovers of earlier hard-interrupted installs (temp/staged/old dirs of dead processes) are removed first.
 * Emits progress for download/verify/extract/done (and 'error' before rethrowing).
 *
 * The downloaded archive is removed from downloadsDir after a successful install (archives are large);
 * an interrupted download keeps its `.part` file so the next attempt resumes.
 */
export async function installPackage(opts: InstallPackageOptions): Promise<void> {
  const { pkg, sdkRoot, signal } = opts;
  const packagePath = pkg.path;
  const emit = (phase: InstallPhase, extra: Partial<InstallProgress> = {}) => {
    try {
      opts.onProgress?.({ packagePath, phase, ...extra });
    } catch {
      // never let a UI callback break the install
    }
  };

  const tempRoot = path.join(sdkRoot, '.temp');
  let extractDir: string | undefined;
  let stagedDir: string | undefined;
  let oldDir: string | undefined;

  try {
    // 1. License gate.
    if (!(await isLicenseAccepted(sdkRoot, pkg.licenseId, opts.licenseText))) {
      throw new AvdmError(
        'LICENSE_NOT_ACCEPTED',
        `安装 ${packagePath} 前需要先阅读并同意许可 "${pkg.licenseId}"`,
        { licenseId: pkg.licenseId },
      );
    }
    const installDir = packageInstallDir(sdkRoot, packagePath);
    const parentDir = path.dirname(installDir);
    await sweepLeftovers(tempRoot, EXTRACT_RE);
    await sweepLeftovers(parentDir, ASIDE_RE);

    // 2. Download (or reuse a verified cached archive).
    const archive = selectArchive(pkg);
    if (!archive) {
      throw new AvdmError('UNSUPPORTED', `${packagePath} ${pkg.revision} 没有适用于当前平台的安装包`);
    }
    const total = archive.size > 0 ? archive.size : undefined;
    await ensureDir(opts.downloadsDir);
    const zipFile = path.join(opts.downloadsDir, archiveFileName(archive.url, archive.sha1));
    const baseName = path.basename(zipFile);

    let cachedOk = false;
    if (await pathExists(zipFile)) {
      const st = await fsp.stat(zipFile);
      if (total === undefined || st.size === total) {
        emit('verify', { receivedBytes: st.size, totalBytes: total ?? st.size, message: '正在校验已缓存的安装包' });
        cachedOk = (await sha1File(zipFile)) === archive.sha1;
      }
      if (!cachedOk) await fsp.rm(zipFile, { force: true });
    }

    if (!cachedOk) {
      emit('download', { receivedBytes: 0, totalBytes: total, message: `正在下载 ${baseName}` });
      const dlOpts: Parameters<typeof httpDownload>[2] = {
        onProgress: (received, t) =>
          emit('download', { receivedBytes: received, totalBytes: t ?? total, message: `正在下载 ${baseName}` }),
      };
      if (total !== undefined) dlOpts.expectedSize = total;
      if (signal) dlOpts.signal = signal;
      await httpDownload(archive.url, zipFile, dlOpts);
      throwIfAborted(signal, packagePath);

      // 3. Verify.
      emit('verify', { totalBytes: total, message: '正在校验 SHA-1' });
      const actual = await sha1File(zipFile);
      if (actual !== archive.sha1) {
        await fsp.rm(zipFile, { force: true });
        throw new AvdmError(
          'CHECKSUM_MISMATCH',
          `安装包校验失败: ${baseName} 的 SHA-1 为 ${actual}，应为 ${archive.sha1}（已删除，请重试）`,
          { expected: archive.sha1, actual },
        );
      }
    }
    throwIfAborted(signal, packagePath);

    // 4. Extract into <sdk>/.temp and move into place.
    emit('extract', { message: `正在解压 ${baseName}` });
    await ensureDir(tempRoot);
    extractDir = await fsp.mkdtemp(path.join(tempRoot, `extract-${process.pid}-`));
    await unzip(zipFile, extractDir, signal);
    throwIfAborted(signal, packagePath);
    const srcDir = await contentRoot(extractDir);

    // 5. Marker written before the move so the install dir appears complete atomically.
    const marker: AvdmPackageMarker = {
      path: packagePath,
      revision: pkg.revision,
      channel: pkg.channel,
      licenseId: pkg.licenseId,
      installedAt: new Date().toISOString(),
      sha1: archive.sha1,
    };
    await fsp.writeFile(path.join(srcDir, AVDM_PACKAGE_FILE), JSON.stringify(marker, null, 2) + '\n');

    // Stage next to the install dir (same volume), so the final step is one atomic rename.
    await ensureDir(parentDir);
    const base = path.basename(installDir);
    const staging = path.join(parentDir, `.${base}.avdm-new-${ownerTag()}`);
    try {
      try {
        stagedDir = staging;
        await fsp.rename(srcDir, staging);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
        // <sdk>/.temp and the target live on different volumes (symlinked SDK subdir): copy instead —
        // into the staging dir, never straight into the install dir.
        await copyTree(srcDir, staging, signal);
      }
    } catch (err) {
      if (isAvdmError(err, 'DOWNLOAD_FAILED')) throw err;
      throw new AvdmError('COMMAND_FAILED', `无法将 ${packagePath} 移动到 ${installDir}: ${(err as Error).message}`);
    }
    throwIfAborted(signal, packagePath);

    if (await pathExists(installDir)) {
      // Renamed aside within the same parent (same filesystem); dot-prefixed so locateSdk ignores it.
      oldDir = path.join(parentDir, `.${base}.avdm-old-${ownerTag()}`);
      await fsp.rename(installDir, oldDir);
    }
    try {
      await fsp.rename(staging, installDir);
      stagedDir = undefined;
    } catch (err) {
      if (oldDir) {
        await fsp.rename(oldDir, installDir).catch(() => undefined);
        oldDir = undefined;
      }
      throw new AvdmError('COMMAND_FAILED', `无法将 ${packagePath} 移动到 ${installDir}: ${(err as Error).message}`);
    }

    // Success: clean up the previous install, the extraction dir and the archive.
    if (oldDir) await fsp.rm(oldDir, { recursive: true, force: true }).catch(() => undefined);
    oldDir = undefined;
    await fsp.rm(extractDir, { recursive: true, force: true }).catch(() => undefined);
    extractDir = undefined;
    await fsp.rm(zipFile, { force: true }).catch(() => undefined);
    // <sdk>/.temp itself is left in place: sdkmanager/Android Studio use it too, and a concurrent install may
    // be about to create its own extraction dir there.

    emit('done', { message: `${packagePath} ${pkg.revision} 安装完成` });
  } catch (err) {
    if (extractDir) await fsp.rm(extractDir, { recursive: true, force: true }).catch(() => undefined);
    if (stagedDir) await fsp.rm(stagedDir, { recursive: true, force: true }).catch(() => undefined);
    const e = isAvdmError(err)
      ? err
      : new AvdmError('COMMAND_FAILED', `安装 ${packagePath} 失败: ${(err as Error)?.message ?? String(err)}`);
    emit('error', { message: e.message });
    throw e;
  }
}
