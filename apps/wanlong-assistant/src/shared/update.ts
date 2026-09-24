/**
 * In-app update contract shared by the main process and the renderer: types, constants and pure functions only
 * (no Node, Electron or DOM dependencies). Ported from wanlong-panel `src/shared/update.ts`.
 *
 * How it works here: the original installed a Windows NSIS package through electron-updater. 万龙助手 ships an
 * ad-hoc-signed macOS DMG, and Squirrel.Mac refuses to replace an app that has no Developer ID signature. So the
 * main process reads the GitHub Releases of TgolMsk/AndroidAutomation (previews included), downloads
 * `Wanlong-Assistant-<version>-mac-arm64.dmg` on request, verifies it against the release's `SHA256SUMS`, and —
 * only when nothing is busy — opens the DMG and quits so the user can drag the new app over the old one.
 *
 * The original's iron rules, kept:
 *  1. Never download or install on its own. The only automatic action is one check 30 s after startup.
 *  2. Nothing may be running when installing; the main process refuses (a disabled button is only a hint).
 *  3. An environment that cannot update says why and offers the Release page instead of a cryptic error.
 *  4. Development builds never check.
 */

/** Update state machine; the panel picks its buttons from it. */
export type UpdatePhase =
  /** Nothing done yet. */
  | 'idle'
  /** Asking GitHub. */
  | 'checking'
  /** Already the newest version. */
  | 'latest'
  /** A newer version exists; waiting for the user to download it. */
  | 'available'
  /** Downloading the installer. */
  | 'downloading'
  /** The installer is downloaded and verified; waiting for the user to install. */
  | 'downloaded'
  /** The check failed (network, rate limit, …). */
  | 'error'
  /** This build cannot update itself (development build, unsupported platform). */
  | 'unsupported';

export const UPDATE_PHASES = [
  'idle', 'checking', 'latest', 'available', 'downloading', 'downloaded', 'error', 'unsupported',
] as const satisfies readonly UpdatePhase[];

export const UPDATE_PHASE_TEXT: Record<UpdatePhase, string> = {
  idle: '未检查',
  checking: '正在检查…',
  latest: '已是最新版',
  available: '有新版本',
  downloading: '正在下载…',
  downloaded: '下载完成，待安装',
  error: '检查失败',
  unsupported: '当前环境不支持自动更新',
};

/**
 * Why this build cannot update. The original's `portable` (a Windows single-exe build) has no macOS counterpart;
 * `platform` covers builds for which no installer is published (anything but macOS on Apple Silicon).
 */
export type UnsupportedReason = 'dev' | 'platform';

/** A title and a next step the user can act on, per reason. */
export const UNSUPPORTED_TEXT: Record<UnsupportedReason, { title: string; detail: string }> = {
  dev: {
    title: '开发模式不检查更新',
    detail: '当前是 pnpm dev:wanlong / start:wanlong 起的开发版本，更新只在 DMG 安装版里生效。',
  },
  platform: {
    title: '当前系统没有对应的安装包',
    detail: '发布页只提供 macOS Apple Silicon 版万龙助手；其他系统请从源码构建，或到 Release 页查看。',
  },
};

export interface UpdateProgress {
  /** 0–100. */
  percent: number;
  /** Bytes on disk so far (a resumed download counts the part kept from last time). */
  transferred: number;
  /** Installer size in bytes. */
  total: number;
  /** Bytes per second. */
  bytesPerSecond: number;
}

export interface UpdateState {
  phase: UpdatePhase;
  /** Version of the running assistant. */
  currentVersion: string;
  /** Newest version found by the last check; null when none was found. */
  latestVersion: string | null;
  /** Release notes as plain text (the Release body), possibly null. */
  releaseNotes: string | null;
  /** Release page of that version, for manual download. */
  releaseUrl: string | null;
  /** When the last check finished; null before the first one. */
  checkedAt: number | null;
  progress: UpdateProgress | null;
  /** Chinese explanation of the last failure. */
  error: string | null;
  unsupportedReason: UnsupportedReason | null;
  /**
   * Whether installing is allowed right now. False while a gather run, script plan, login or SDK install is in
   * flight; `busyReason` names who holds it. It goes stale quickly, so main asks again on every `updateState()`,
   * before the "downloaded" push, every few seconds while an installer waits, and always before installing.
   */
  installable: boolean;
  busyReason: string | null;
  /** Whether that release is marked as a preview (prerelease) on GitHub. */
  prerelease: boolean;
  /** Publication time of that release (epoch ms), null when unknown. */
  publishedAt: number | null;
  /** Installer file name on the release, e.g. `Wanlong-Assistant-0.4.0-mac-arm64.dmg`. */
  assetName: string | null;
  /** Installer size in bytes. */
  assetSize: number | null;
  /** Absolute path of the downloaded, checksum-verified installer (set in phase `downloaded`). */
  downloadedFile: string | null;
}

export function initialUpdateState(currentVersion: string): UpdateState {
  return {
    phase: 'idle',
    currentVersion,
    latestVersion: null,
    releaseNotes: null,
    releaseUrl: null,
    checkedAt: null,
    progress: null,
    error: null,
    unsupportedReason: null,
    installable: true,
    busyReason: null,
    prerelease: false,
    publishedAt: null,
    assetName: null,
    assetSize: null,
    downloadedFile: null,
  };
}

/** The public repository whose Releases carry the installers (shown in the panel footer). */
export const UPDATE_REPOSITORY = 'TgolMsk/AndroidAutomation';

/** Release asset name of the assistant installer for a version; the release workflow produces exactly this. */
export function updateAssetName(version: string): string {
  return `Wanlong-Assistant-${version.replace(/^v/, '')}-mac-arm64.dmg`;
}

// ── Version comparison (pure) ───────────────────────────────────────────────

/**
 * Semantic version comparison: positive when a > b, 0 when equal, negative when a < b.
 *
 * Only `X.Y.Z` plus an optional prerelease suffix (`1.2.3-beta.1`) is understood. A prerelease is lower than the
 * release with the same number, as in semver — otherwise someone on 1.2.3 would be "updated" back to 1.2.3-beta.1.
 * Unparseable versions count as 0.0.0; never guess.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    const x = pa.nums[i]!;
    const y = pb.nums[i]!;
    if (x !== y) return x - y;
  }
  // Same number: the one without a prerelease suffix is greater.
  if (!pa.pre && pb.pre) return 1;
  if (pa.pre && !pb.pre) return -1;
  if (pa.pre === pb.pre) return 0;
  return pa.pre < pb.pre ? -1 : 1;
}

function parseVersion(v: string): { nums: [number, number, number]; pre: string } {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(v).trim());
  if (!m) return { nums: [0, 0, 0], pre: '' };
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? '' };
}

/** Whether `latest` is newer than `current`. */
export function isNewer(latest: string, current: string): boolean {
  return compareVersions(latest, current) > 0;
}

/** Download speed for people (decimal units, as in the original). */
export function formatSpeed(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '—';
  if (bytesPerSecond >= 1e6) return `${(bytesPerSecond / 1e6).toFixed(1)} MB/s`;
  return `${Math.max(1, Math.round(bytesPerSecond / 1000))} KB/s`;
}

/** Byte count for people (decimal units, as in the original). */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 MB';
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1000))} KB`;
}
