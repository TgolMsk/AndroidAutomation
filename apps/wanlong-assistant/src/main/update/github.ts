/**
 * The real `UpdaterPort`: GitHub Releases of TgolMsk/AndroidAutomation instead of electron-updater.
 *
 * Why not electron-updater: its macOS path installs through Squirrel.Mac, which checks the new bundle against the
 * running app's designated requirement. 万龙助手 is ad-hoc signed (no Developer ID), so that requirement is tied to
 * the exact binary and every new version would be rejected. The DMG route below needs no signature: download the
 * DMG, verify it against the release's `SHA256SUMS`, open it and let the user drag-replace the app.
 *
 * Safety rules:
 *  · only URLs of this repository are ever fetched or opened (asset URLs from the API are checked, not trusted);
 *  · the download goes to `<name>.part` next to the target and is renamed only after the SHA-256 matched, so an
 *    interrupted or tampered download never looks like an installer; a kept `.part` is resumed with `Range`;
 *  · every request has a timeout, every response a size cap;
 *  · when the Downloads folder cannot be written (macOS folder access denied), the installer goes to a temp folder.
 * Nothing here imports Electron: fetch, the downloads folder and the Finder actions are injected.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { UpdateProgress } from '../../shared/update';
import { compareVersions } from '../../shared/update';
import type { DownloadOptions, UpdateRelease, UpdaterPort } from './center';

export const UPDATE_OWNER = 'TgolMsk';
export const UPDATE_REPO = 'AndroidAutomation';
const REPO_PATH = `${UPDATE_OWNER}/${UPDATE_REPO}`;
/** Newest first; previews (prereleases) are included on purpose: the project publishes previews. */
export const RELEASES_API_URL = `https://api.github.com/repos/${REPO_PATH}/releases?per_page=20`;
const RELEASES_PAGE = `https://github.com/${REPO_PATH}/releases`;
const DOWNLOAD_PREFIX = `${RELEASES_PAGE}/download/`;
/** `Wanlong-Assistant-<version>-mac-arm64.dmg`, the name the release workflow uploads (see docs/RELEASE.md). */
const ASSET_PATTERN = /^Wanlong-Assistant-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-mac-arm64\.dmg$/;
const CHECKSUMS_NAME = 'SHA256SUMS';

const MAX_API_BYTES = 4 * 1024 * 1024;
const MAX_CHECKSUMS_BYTES = 64 * 1024;
/** Installers are ~200 MB; anything announced far above that is not ours. */
const MAX_INSTALLER_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_NOTES_CHARS = 8000;

/** Release page of one version (`/tag/v<version>`) or of the newest release. */
export function releasePageUrl(version?: string | null): string {
  return version ? `${RELEASES_PAGE}/tag/v${version.replace(/^v/, '')}` : `${RELEASES_PAGE}/latest`;
}

/** Only this repository's release pages may be opened in the browser. */
export function isReleasePageUrl(url: string): boolean {
  return url === RELEASES_PAGE || url.startsWith(`${RELEASES_PAGE}/`);
}

/** The version in an installer asset name, or null when the name is not an assistant installer. */
export function parseAssetVersion(name: string): string | null {
  return ASSET_PATTERN.exec(name)?.[1] ?? null;
}

/**
 * `SHA256SUMS` → file name → lowercase hex digest. Lines are `<64 hex>  <path>` (`shasum -a 256`, optionally
 * `*<path>` in binary mode). The workflow writes paths such as `wanlong-assistant/Wanlong-Assistant-….dmg`, and
 * release assets are uploaded under their base name, so entries are keyed by base name.
 */
export function parseChecksums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line.trim());
    if (!m) continue;
    const name = m[2]!.split(/[\\/]/).pop()!;
    if (name) sums.set(name, m[1]!.toLowerCase());
  }
  return sums;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Release notes as plain text: the Release body (Markdown source) without HTML comments, capped. */
export function normalizeNotes(body: unknown): string | null {
  if (typeof body !== 'string') return null;
  const text = body.replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '').trim();
  if (!text) return null;
  return text.length > MAX_NOTES_CHARS ? `${text.slice(0, MAX_NOTES_CHARS).trimEnd()}\n…（更多内容请到 Release 页查看）` : text;
}

function downloadUrl(value: unknown): string | null {
  return typeof value === 'string' && value.startsWith(DOWNLOAD_PREFIX) ? value : null;
}

/**
 * Pick the newest release that carries an assistant installer from the `GET /releases` payload. Drafts are
 * skipped; the version comes from the asset name (both apps share one tag, the asset says which app it is).
 */
export function pickRelease(payload: unknown): UpdateRelease | null {
  if (!Array.isArray(payload)) throw new Error('GitHub 返回的发布列表格式不对，请稍后再试。');
  let best: UpdateRelease | null = null;
  for (const item of payload) {
    if (!isRecord(item) || item['draft'] === true || !Array.isArray(item['assets'])) continue;
    const assets = item['assets'].filter(isRecord);
    let installer: UpdateRelease['asset'] | null = null;
    let version: string | null = null;
    let checksumsUrl: string | null = null;
    for (const asset of assets) {
      const name = typeof asset['name'] === 'string' ? asset['name'] : '';
      const url = downloadUrl(asset['browser_download_url']);
      if (!url || (asset['state'] !== undefined && asset['state'] !== 'uploaded')) continue;
      if (name === CHECKSUMS_NAME) { checksumsUrl = url; continue; }
      const assetVersion = parseAssetVersion(name);
      const size = asset['size'];
      if (!assetVersion || typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0 || size > MAX_INSTALLER_BYTES) continue;
      if (!version || compareVersions(assetVersion, version) > 0) {
        version = assetVersion;
        installer = { name, size, url };
      }
    }
    if (!installer || !version) continue;
    if (best && compareVersions(version, best.version) <= 0) continue;
    const page = typeof item['html_url'] === 'string' && isReleasePageUrl(item['html_url']) ? item['html_url'] : releasePageUrl(version);
    const published = typeof item['published_at'] === 'string' ? Date.parse(item['published_at']) : Number.NaN;
    best = {
      version,
      releaseNotes: normalizeNotes(item['body']),
      releaseUrl: page,
      prerelease: item['prerelease'] === true,
      publishedAt: Number.isFinite(published) ? published : null,
      asset: installer,
      checksumsUrl,
    };
  }
  return best;
}

/** SHA-256 of a file on disk, streamed. */
export async function sha256File(file: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(file, signal ? { signal } : {});
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface GitHubUpdaterOptions {
  /** Electron's `net.fetch` in the app (system proxy); global fetch in tests. */
  fetch?: FetchLike;
  /** Folder for the installer (the user's Downloads). Read on every download; a throw means "use the fallback". */
  downloadsDir(): string;
  /**
   * Used when the Downloads folder cannot be written: macOS asks before an app may use ~/Downloads and the user may
   * say no (the question can come back for every ad-hoc-signed version). Default `<tmpdir>/wanlong-assistant-update`.
   */
  fallbackDir?(): string;
  /** Sent as User-Agent (GitHub's API requires one). */
  userAgent: string;
  /** `shell.openPath`: resolves with an error text, empty on success. */
  openPath(file: string): Promise<string>;
  /** `shell.showItemInFolder`. */
  showItemInFolder(file: string): void;
  now?(): number;
  /** API and SHA256SUMS requests (default 20 s). */
  requestTimeoutMs?: number;
  /** A download that receives nothing for this long is aborted (default 60 s). */
  idleTimeoutMs?: number;
  /** Minimum gap between progress reports (default 250 ms). */
  progressIntervalMs?: number;
}

/** `UpdaterPort` over the GitHub REST API and release asset downloads. */
export class GitHubUpdater implements UpdaterPort {
  private readonly fetcher: FetchLike;
  /** Verified digests of downloaded files, so `verify()` needs no second SHA256SUMS request. */
  private readonly verified = new Map<string, string>();

  constructor(private readonly options: GitHubUpdaterOptions) {
    this.fetcher = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  }

  async check(): Promise<UpdateRelease | null> {
    const response = await this.request(RELEASES_API_URL, {
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    });
    const text = await readCapped(response, MAX_API_BYTES, 'GitHub 返回的发布列表过大，请稍后再试。');
    let payload: unknown;
    try { payload = JSON.parse(text); }
    catch { throw new Error('GitHub 返回的发布列表格式不对，请稍后再试。'); }
    return pickRelease(payload);
  }

  async download(release: UpdateRelease, { signal, onProgress }: DownloadOptions): Promise<string> {
    // The name becomes a path in the user's Downloads folder and the URL is fetched: both must be ours.
    if (!parseAssetVersion(release.asset.name) || !downloadUrl(release.asset.url)) {
      throw new Error('发布信息里的安装包地址不可信，已拒绝下载；请到 Release 页手动下载。');
    }
    const expected = await this.expectedDigest(release, signal);
    const total = release.asset.size;
    const { target, reusable } = await this.prepareTarget(release.asset.name, total, expected, signal);
    // A verified copy from an earlier download (or a re-check after downloading) is reused without the network.
    if (reusable) {
      this.verified.set(target, expected);
      onProgress({ percent: 100, transferred: total, total, bytesPerSecond: 0 });
      return target;
    }

    const part = `${target}.part`;
    let offset = await sizeOf(part) ?? 0;
    if (offset > total) { await rm(part, { force: true }); offset = 0; }
    if (offset < total) await this.fetchToPart(release, part, offset, signal, onProgress);

    const digest = await sha256File(part, signal);
    if (digest !== expected) {
      await rm(part, { force: true });
      throw new Error('sha256 mismatch：安装包校验失败');
    }
    await rename(part, target);
    this.verified.set(target, expected);
    return target;
  }

  async verify(file: string, release: UpdateRelease): Promise<void> {
    const expected = this.verified.get(file) ?? await this.expectedDigest(release);
    let digest: string;
    try { digest = await sha256File(file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('下载好的安装包已被移走或删除，请重新下载。');
      throw error;
    }
    if (digest !== expected) {
      this.verified.delete(file);
      await rm(file, { force: true });
      throw new Error('sha256 mismatch：安装包下载后被改动');
    }
  }

  async open(file: string): Promise<void> {
    const failure = await this.options.openPath(file);
    if (failure) throw new Error(`无法打开安装包：${failure}`);
  }

  async reveal(file: string): Promise<void> {
    this.options.showItemInFolder(file);
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /**
   * Where the installer goes: the Downloads folder, or the fallback folder when Downloads cannot be written.
   * `reusable` means a verified copy is already there. Only "no write access" moves on to the next folder.
   */
  private async prepareTarget(
    name: string, total: number, expected: string, signal: AbortSignal,
  ): Promise<{ target: string; reusable: boolean }> {
    const fallback = this.options.fallbackDir?.() ?? path.join(tmpdir(), 'wanlong-assistant-update');
    let primary: string | null = null;
    try { primary = this.options.downloadsDir(); }
    catch { /* No Downloads folder known: the fallback alone. */ }
    const dirs = primary && path.resolve(primary) !== path.resolve(fallback) ? [primary, fallback] : [fallback];
    let lastError: unknown = null;
    for (const dir of dirs) {
      const target = path.join(dir, name);
      try {
        await mkdir(dir, { recursive: true });
        if (await this.isVerifiedCopy(target, total, expected, signal)) return { target, reusable: true };
        // macOS enforces folder access when a file is opened for writing (stat / access() can pass and the write
        // still fail), so the check is creating the part file itself; the download appends to or truncates it.
        const handle = await open(`${target}.part`, 'a');
        await handle.close();
        return { target, reusable: false };
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? error;
        if (!isNoWriteAccess(error)) throw error;
        lastError = error;
      }
    }
    throw lastError;
  }

  private async isVerifiedCopy(target: string, total: number, expected: string, signal: AbortSignal): Promise<boolean> {
    if (await sizeOf(target) !== total) return false;
    try { return await sha256File(target, signal) === expected; }
    catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      // An unreadable copy is not reused; whether the folder can be written is decided by the part file next.
      return false;
    }
  }

  private async expectedDigest(release: UpdateRelease, signal?: AbortSignal): Promise<string> {
    if (!release.checksumsUrl || !downloadUrl(release.checksumsUrl)) {
      throw new Error('这个版本的发布缺少校验文件 SHA256SUMS，无法确认安装包完好；请到 Release 页手动下载。');
    }
    const response = await this.request(release.checksumsUrl, { headers: { Accept: 'application/octet-stream' } }, signal);
    const sums = parseChecksums(await readCapped(response, MAX_CHECKSUMS_BYTES, '校验文件 SHA256SUMS 过大，请到 Release 页手动下载。'));
    const expected = sums.get(release.asset.name);
    if (!expected) throw new Error(`校验文件 SHA256SUMS 里没有 ${release.asset.name}，请到 Release 页手动下载。`);
    return expected;
  }

  /** One small request with a timeout; HTTP failures become messages `describe()` understands. */
  private async request(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(this.options.requestTimeoutMs ?? 20_000);
    const response = await this.fetcher(url, {
      ...init,
      headers: { 'User-Agent': this.options.userAgent, ...(init.headers as Record<string, string>) },
      redirect: 'follow',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) throw await httpError(response);
    return response;
  }

  /** Stream the installer into `part`, resuming from `offset` when the server honours `Range`. */
  private async fetchToPart(
    release: UpdateRelease, part: string, offset: number, signal: AbortSignal, onProgress: (p: UpdateProgress) => void,
  ): Promise<void> {
    const idle = new AbortController();
    const idleMs = this.options.idleTimeoutMs ?? 60_000;
    let idleTimer: NodeJS.Timeout | undefined;
    const armIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => idle.abort(new Error('ETIMEDOUT：下载长时间没有收到数据')), idleMs);
      idleTimer.unref?.();
    };
    const combined = AbortSignal.any([signal, idle.signal]);
    armIdle();
    try {
      await this.streamToPart(release, part, offset, combined, armIdle, onProgress);
    } catch (error) {
      // A cancel or an idle timeout surfaces as its own reason, not as whatever the aborted read threw.
      if (signal.aborted) throw signal.reason ?? error;
      if (idle.signal.aborted) throw idle.signal.reason ?? error;
      throw error;
    } finally {
      clearTimeout(idleTimer);
    }
  }

  private async streamToPart(
    release: UpdateRelease, part: string, offset: number, signal: AbortSignal, alive: () => void,
    onProgress: (p: UpdateProgress) => void,
  ): Promise<void> {
    const total = release.asset.size;
    const headers: Record<string, string> = { 'User-Agent': this.options.userAgent, Accept: 'application/octet-stream' };
    if (offset > 0) headers['Range'] = `bytes=${offset}-`;
    let response = await this.fetcher(release.asset.url, { headers, redirect: 'follow', signal });
    if (response.status === 416) {
      // The kept part does not fit the file on the server any more: start over once.
      await response.body?.cancel().catch(() => undefined);
      await rm(part, { force: true });
      offset = 0;
      delete headers['Range'];
      response = await this.fetcher(release.asset.url, { headers, redirect: 'follow', signal });
    }
    if (!response.ok) throw await httpError(response);
    if (offset > 0 && response.status !== 206) offset = 0; // Range ignored: the body is the whole file.
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > 0 && offset + length !== total) {
      await response.body?.cancel().catch(() => undefined);
      await rm(part, { force: true });
      throw new Error('下载的文件大小与发布信息不符（checksum 无法通过），请稍后重试。');
    }
    if (!response.body) throw new Error('ECONNRESET：下载没有返回数据');

    const handle = await open(part, offset > 0 ? 'a' : 'w');
    let transferred = offset;
    let oversize = false;
    const startedAt = this.now();
    let lastReport = Number.NEGATIVE_INFINITY;
    const report = (force: boolean) => {
      const now = this.now();
      if (!force && now - lastReport < (this.options.progressIntervalMs ?? 250)) return;
      lastReport = now;
      const seconds = Math.max(0.001, (now - startedAt) / 1000);
      onProgress({
        percent: Math.max(0, Math.min(100, Math.round((transferred / total) * 100))),
        transferred,
        total,
        bytesPerSecond: Math.round((transferred - offset) / seconds),
      });
    };
    const reader = response.body.getReader();
    // Fetch implementations error the body on abort; cancelling the reader as well makes sure a stalled read ends.
    const onAbort = () => { void reader.cancel(signal.reason).catch(() => undefined); };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        alive();
        if (transferred + value.byteLength > total) {
          oversize = true;
          throw new Error('下载的文件比发布信息里的大（checksum 无法通过），已丢弃，请重试。');
        }
        await handle.write(value);
        transferred += value.byteLength;
        report(false);
      }
      await handle.sync().catch(() => undefined);
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    } finally {
      signal.removeEventListener('abort', onAbort);
      reader.releaseLock();
      await handle.close().catch(() => undefined);
      // An oversized body is not ours; a merely interrupted one is kept so the next download resumes.
      if (oversize) await rm(part, { force: true });
    }
    report(true);
    if (transferred < total) throw new Error('ECONNRESET：下载提前中断，再点一次会从断点继续');
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

/** The folder refuses writes (permission, macOS privacy, read-only volume). */
export function isNoWriteAccess(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null ? (error as NodeJS.ErrnoException).code : undefined;
  return code === 'EPERM' || code === 'EACCES' || code === 'EROFS';
}

async function sizeOf(file: string): Promise<number | null> {
  try { return (await stat(file)).size; }
  catch { return null; }
}

/** Read a response body as text, refusing bodies above `max` bytes. */
async function readCapped(response: Response, max: number, tooLarge: string): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(tooLarge);
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel().catch(() => undefined);
        throw new Error(tooLarge);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** HTTP failure → an error whose message `describe()` can translate (404, rate limit, …). */
async function httpError(response: Response): Promise<Error> {
  let body = '';
  try { body = (await readCapped(response, 16 * 1024, '')).slice(0, 300); }
  catch { /* The status alone is enough. */ }
  const limited = response.headers.get('x-ratelimit-remaining') === '0' || /rate limit/i.test(body);
  if ((response.status === 403 || response.status === 429) && limited) return new Error(`HTTP ${response.status} rate limit exceeded`);
  return new Error(`GitHub 请求失败（HTTP ${response.status}）`);
}
