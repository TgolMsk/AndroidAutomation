import type { InstalledImage, InstanceSpec, InstanceState, InstanceStatus, SdkInfo, Settings } from '@avdm/core';

/**
 * Mirrors MIN_EMULATOR_VERSION in @avdm/core (the renderer cannot import core runtime code).
 * 36.6.11 fixes an HVF memory leak on macOS 26.x.
 */
export const MIN_EMULATOR_VERSION = '36.6.11';

/** Base SDK components the app needs besides the default system image. */
export const BASE_SDK_PACKAGES = ['emulator', 'platform-tools'] as const;

export const STATUS_LABEL: Record<InstanceStatus, string> = {
  stopped: '已停止',
  starting: '启动中',
  booting: '开机中',
  running: '运行中',
  stopping: '停止中',
  error: '异常',
};

export type DisplayStatus = InstanceStatus | 'provisioning';

export function displayStatus(s: InstanceState): DisplayStatus {
  return s.record.provisioning ? 'provisioning' : s.status;
}

export function displayStatusLabel(s: DisplayStatus): string {
  return s === 'provisioning' ? '准备中' : STATUS_LABEL[s];
}

/** Process is up (or coming up / going down). */
export function isActive(s: InstanceState): boolean {
  return s.status !== 'stopped' && s.status !== 'error';
}

export function canStart(s: InstanceState): boolean {
  return !s.record.provisioning && (s.status === 'stopped' || s.status === 'error');
}

export function canStop(s: InstanceState): boolean {
  return s.status !== 'stopped' && s.status !== 'stopping';
}

/** Android is up and adb/gRPC usable. */
export function isRunning(s: InstanceState): boolean {
  return s.status === 'running';
}

/** Screen can be viewed (live view / scrcpy / thumbnails). */
export function hasScreen(s: InstanceState): boolean {
  return s.status === 'running' || s.status === 'booting';
}

export function formatMb(mb: number | undefined): string {
  if (mb === undefined || !Number.isFinite(mb)) return '—';
  if (Math.abs(mb) >= 1024) {
    const gb = mb / 1024;
    return `${gb >= 100 ? gb.toFixed(0) : gb.toFixed(1)} GB`;
  }
  return `${Math.round(mb)} MB`;
}

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[u]}`;
}

const ANDROID_VERSIONS: Record<string, string> = {
  '36': '16',
  '35': '15',
  '34': '14',
  '33': '13',
  '32': '12L',
  '31': '12',
  '30': '11',
  '29': '10',
  '28': '9',
  '27': '8.1',
  '26': '8.0',
};

const TAG_LABEL: Record<string, string> = {
  default: 'AOSP',
  google_apis: 'Google APIs',
  google_apis_playstore: 'Google Play',
  android: 'AOSP',
};

export function androidVersion(apiLevel: string | undefined): string | undefined {
  if (!apiLevel) return undefined;
  const major = /^(\d+)/.exec(apiLevel)?.[1];
  return major ? ANDROID_VERSIONS[major] : undefined;
}

/** Split "system-images;android-35;default;arm64-v8a". */
export function parseImagePath(pkgPath: string): { apiLevel?: string; tagId?: string; abi?: string } {
  const parts = pkgPath.split(';');
  if (parts[0] !== 'system-images') return {};
  return { apiLevel: parts[1]?.replace(/^android-/, ''), tagId: parts[2], abi: parts[3] };
}

/** "Android 15 · API 35 · AOSP" */
export function imageLabel(pkgPath: string, installed?: InstalledImage): string {
  const parsed = parseImagePath(pkgPath);
  const api = installed?.apiLevel ?? parsed.apiLevel;
  const tagId = installed?.tagId ?? parsed.tagId;
  if (!api) return pkgPath;
  const ver = androidVersion(api);
  const tag = (tagId && TAG_LABEL[tagId]) ?? installed?.tagDisplay ?? tagId ?? '';
  return [ver ? `Android ${ver}` : undefined, `API ${api}`, tag || undefined].filter(Boolean).join(' · ');
}

export function shortImageLabel(pkgPath: string): string {
  const { apiLevel, tagId } = parseImagePath(pkgPath);
  if (!apiLevel) return pkgPath;
  const ver = androidVersion(apiLevel);
  const tag = (tagId && TAG_LABEL[tagId]) ?? tagId ?? '';
  return `${ver ? `Android ${ver}` : `API ${apiLevel}`}${tag ? ` ${tag}` : ''}`;
}

export function specSummary(spec: InstanceSpec): string {
  return `${spec.cpuCores} 核 · ${formatMb(spec.ramMb)} · ${spec.width}×${spec.height} · ${spec.dpi} dpi`;
}

export function formatTime(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  const today = new Date();
  const time = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  if (d.toDateString() === today.toDateString()) return time;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${time}`;
}

export function formatUptime(iso: string | undefined, now = Date.now()): string | undefined {
  if (!iso) return undefined;
  const start = new Date(iso).getTime();
  if (Number.isNaN(start)) return undefined;
  const sec = Math.max(0, Math.floor((now - start) / 1000));
  if (sec < 60) return `${sec} 秒`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时 ${min % 60} 分`;
  return `${Math.floor(h / 24)} 天 ${h % 24} 小时`;
}

/** Numeric dotted version compare (mirrors core's compareVersions). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.\-_ ]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.split(/[.\-_ ]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** Split a command-line-ish string into args (supports "double" and 'single' quotes). */
export function splitArgs(input: string): string[] {
  const out: string[] = [];
  const re = /"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g;
  for (let m = re.exec(input); m; m = re.exec(input)) {
    out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : (m[2] ?? m[3] ?? ''));
  }
  return out;
}

export function joinArgs(args: string[]): string {
  return args.map((a) => (/[\s"']/.test(a) ? `"${a.replace(/(["\\])/g, '\\$1')}"` : a)).join(' ');
}

/** SDK components that are missing for the configured default image. */
export function missingSdkPackages(sdk: SdkInfo, settings: Settings): string[] {
  const out: string[] = [];
  if (!sdk.emulator) out.push('emulator');
  if (!sdk.adb) out.push('platform-tools');
  if (settings.defaultImage && !sdk.images.some((i) => i.packagePath === settings.defaultImage)) out.push(settings.defaultImage);
  return out;
}

export function emulatorOutdated(sdk: SdkInfo): boolean {
  const v = sdk.emulator?.version;
  return !!v && compareVersions(v, MIN_EMULATOR_VERSION) < 0;
}

/** Every license the install plan still needs was ticked individually. */
export function allLicensesAgreed(unaccepted: readonly string[], agreed: ReadonlySet<string>): boolean {
  return unaccepted.every((id) => agreed.has(id));
}

/** License ids to record consent for: only ticked ones among those the plan needs. */
export function agreedLicenseIds(unaccepted: readonly string[], agreed: ReadonlySet<string>): string[] {
  return unaccepted.filter((id) => agreed.has(id));
}

/**
 * The emulator's gRPC key channel only types ASCII: other characters (Chinese, emoji, é …) are dropped
 * silently, so the live window refuses such input with a message instead.
 */
export function hasNonAscii(text: string): boolean {
  return /[^\x00-\x7f]/.test(text);
}
