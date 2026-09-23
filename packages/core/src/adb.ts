import { AvdmError } from './errors.js';
import { execFileBuffer, execFileText } from './util/proc.js';

/**
 * Thin wrapper over the platform-tools `adb` binary (spawned per call; always the SDK's adb so there
 * is exactly one adb server version on the machine).
 * IMPLEMENTER: agent "core-emu" (see docs/DESIGN.md §adb).
 */

export interface AdbDeviceEntry {
  serial: string;
  state: string; // 'device' | 'offline' | 'unauthorized' | …
  props: Record<string, string>; // from `devices -l` (model, device, transport_id …)
}

const DEFAULT_TIMEOUT_MS = 60_000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const RAW_RGBA_8888 = 1;
const RAW_HEADER_LENGTHS = [16, 12] as const;
const MAX_RAW_DIMENSION = 20_000;
// execFileBuffer also caps binary stdout at 128 MiB. Reject impossible headers before copying pixels.
const MAX_RAW_BYTES = 128 * 1024 * 1024;

/** `adb exec-out screencap` frame with tightly packed RGBA_8888 pixels. */
export interface RawScreencapFrame {
  width: number;
  height: number;
  format: number;
  data: Uint8Array;
  capturedAt: number;
}

/** Parse the 12- or 16-byte Android raw screencap header and remove any row padding. */
export function parseRawScreencap(buf: Uint8Array): RawScreencapFrame {
  const length = buf.byteLength;
  if (length < 12 || length > MAX_RAW_BYTES) {
    throw new AvdmError('COMMAND_FAILED', `原始截图长度异常: ${length} 字节`);
  }

  const view = new DataView(buf.buffer, buf.byteOffset, length);
  const width = view.getUint32(0, true);
  const height = view.getUint32(4, true);
  const format = view.getUint32(8, true);
  const packedBytes = width * height * 4;
  if (
    width === 0 || height === 0 || width > MAX_RAW_DIMENSION || height > MAX_RAW_DIMENSION ||
    packedBytes > MAX_RAW_BYTES - 12
  ) {
    throw new AvdmError('COMMAND_FAILED', `原始截图尺寸异常: ${width}×${height}`);
  }
  if (format !== RAW_RGBA_8888) {
    throw new AvdmError('COMMAND_FAILED', `不支持的原始截图像素格式: ${format}（需要 RGBA_8888）`);
  }

  // Prefer a frame with no padding. ADB's 16-byte variant includes a color-space word;
  // older versions use 12 bytes. The total length is the only reliable stride source.
  let headerLength = 0;
  let stride = 0;
  for (const candidate of RAW_HEADER_LENGTHS) {
    if (length - candidate === packedBytes) {
      headerLength = candidate;
      stride = width;
      break;
    }
  }
  if (headerLength === 0) {
    for (const candidate of RAW_HEADER_LENGTHS) {
      const bodyLength = length - candidate;
      const rowUnit = height * 4;
      if (bodyLength <= packedBytes || bodyLength % rowUnit !== 0) continue;
      const candidateStride = bodyLength / rowUnit;
      if (candidateStride >= width) {
        headerLength = candidate;
        stride = candidateStride;
        break;
      }
    }
  }
  if (headerLength === 0) {
    throw new AvdmError('COMMAND_FAILED', `原始截图长度与尺寸不匹配: ${length} 字节，${width}×${height}`);
  }

  // A 16-byte header truncated by four bytes can masquerade as a 12-byte frame.
  // Zero is the usual color-space word; reject the ambiguous case instead of returning shifted pixels.
  if (headerLength === 12 && length >= 16 && view.getUint32(12, true) === 0) {
    throw new AvdmError('COMMAND_FAILED', '原始截图头部不明确，可能已截断');
  }

  const rowBytes = width * 4;
  let data: Uint8Array;
  if (stride === width) {
    data = buf.subarray(headerLength, headerLength + packedBytes);
  } else {
    data = new Uint8Array(packedBytes);
    const strideBytes = stride * 4;
    for (let y = 0; y < height; y++) {
      const from = headerLength + y * strideBytes;
      data.set(buf.subarray(from, from + rowBytes), y * rowBytes);
    }
  }
  return { width, height, format, data, capturedAt: Date.now() };
}

/** Parse `adb devices [-l]` output. */
export function parseAdbDevices(text: string): AdbDeviceEntry[] {
  const out: AdbDeviceEntry[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('*') || /^List of devices/i.test(line)) continue;
    const tab = line.indexOf('\t');
    let serial: string;
    let rest: string;
    if (tab > 0) {
      serial = line.slice(0, tab).trim();
      rest = line.slice(tab + 1).trim();
    } else {
      const m = /^(\S+)\s+(.*)$/.exec(line);
      if (!m?.[1]) continue;
      serial = m[1];
      rest = (m[2] ?? '').trim();
    }
    const tokens = rest.split(/\s+/).filter(Boolean);
    const props: Record<string, string> = {};
    const stateParts: string[] = [];
    for (const tok of tokens) {
      const colon = tok.indexOf(':');
      if (colon > 0 && /^[a-z_]+$/.test(tok.slice(0, colon))) props[tok.slice(0, colon)] = tok.slice(colon + 1);
      else if (Object.keys(props).length === 0) stateParts.push(tok);
    }
    // States can contain spaces, e.g. "no permissions (…)".
    out.push({ serial, state: stateParts.join(' ') || 'unknown', props });
  }
  return out;
}

/** Characters that must be backslash-escaped for the device shell (`input text` is run via `sh -c`). */
const SHELL_SPECIAL = /[\\'"()&<>|;*~$`?[\]{}#!]/g;

/**
 * Escape a string for `adb shell input text <arg>`: spaces → `%s`, shell metacharacters escaped,
 * control characters dropped (they cannot be typed by `input text`).
 */
export function escapeInputText(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(SHELL_SPECIAL, (c) => `\\${c}`)
    .replace(/ /g, '%s');
}

export type InputTextStep = { kind: 'text'; text: string } | { kind: 'key'; code: number };

const KEYCODE_TAB = 61;
const KEYCODE_ENTER = 66;

/**
 * Split text for `adb shell input text` into commands that type it exactly:
 *  - non-ASCII (e.g. Chinese) is rejected: Android's `input text` crashes on it (NullPointerException in
 *    InputShellCommand.sendText) instead of typing anything;
 *  - `input text` turns every "%s" into a space and has no escape for it, so a literal "%s" is split across
 *    two commands ("…%" then "s…");
 *  - tab / newline become TAB / ENTER key events (`input text` silently drops control characters); other
 *    control characters are rejected.
 */
export function planInputText(value: string): InputTextStep[] {
  const text = String(value ?? '');
  // eslint-disable-next-line no-control-regex
  if (/[^\u0000-\u007f]/.test(text)) {
    throw new AvdmError('INVALID_ARGUMENT', '暂不支持输入中文等非 ASCII 字符（adb input text 只能输入 ASCII 字符）');
  }
  // eslint-disable-next-line no-control-regex
  const bad = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.exec(text);
  if (bad) {
    throw new AvdmError(
      'INVALID_ARGUMENT',
      `文本包含无法输入的控制字符（U+${bad[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}）`,
    );
  }
  const steps: InputTextStep[] = [];
  const pushText = (chunk: string) => {
    // "%s" would be typed as a space: end one command after the '%' and start the next with the 's'.
    const parts = chunk.split('%s');
    parts.forEach((part, i) => {
      const piece = (i > 0 ? 's' : '') + part + (i < parts.length - 1 ? '%' : '');
      if (piece) steps.push({ kind: 'text', text: piece });
    });
  };
  for (const segment of text.split(/(\r\n|\r|\n|\t)/)) {
    if (segment === '') continue;
    if (segment === '\t') steps.push({ kind: 'key', code: KEYCODE_TAB });
    else if (segment === '\n' || segment === '\r' || segment === '\r\n') steps.push({ kind: 'key', code: KEYCODE_ENTER });
    else pushText(segment);
  }
  return steps;
}

/** Foreground package from `dumpsys window` (mCurrentFocus, falling back to mFocusedApp). */
export function parseForegroundPackage(dumpsys: string): string | undefined {
  const focus = /mCurrentFocus=Window\{[^}]*?\s([A-Za-z0-9_.]+)\/[^\s}]+\}/.exec(dumpsys);
  if (focus?.[1]) return focus[1];
  const app = /mFocusedApp=.*?\s([A-Za-z0-9_.]+)\/[^\s}]+/.exec(dumpsys);
  return app?.[1];
}

/** `pm list packages` output → sorted package names. */
export function parsePackageList(text: string): string[] {
  const pkgs = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^package:(?:.*=)?([A-Za-z0-9_.]+)\s*$/.exec(line.trim());
    if (m?.[1]) pkgs.add(m[1]);
  }
  return [...pkgs].sort();
}

const PACKAGE_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*$/;

function assertPackage(pkg: string): void {
  if (!PACKAGE_RE.test(pkg)) throw new AvdmError('INVALID_ARGUMENT', `无效的应用包名: ${pkg}`);
}

function assertCoord(...values: number[]): void {
  for (const v of values) {
    if (!Number.isFinite(v)) throw new AvdmError('INVALID_ARGUMENT', `无效的坐标或数值: ${v}`);
  }
}

export class Adb {
  constructor(readonly bin: string) {}

  /** Run adb with args; returns stdout text. */
  async run(args: string[], opts: { timeoutMs?: number } = {}): Promise<string> {
    return execFileText(this.bin, args, { timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS });
  }

  async startServer(): Promise<void> {
    await this.run(['start-server'], { timeoutMs: 30_000 });
  }

  async version(): Promise<string | undefined> {
    try {
      const out = await this.run(['version'], { timeoutMs: 10_000 });
      const pkg = /^Version\s+(\S+)/m.exec(out);
      if (pkg?.[1]) return pkg[1];
      return /Android Debug Bridge version\s+(\S+)/.exec(out)?.[1];
    } catch {
      return undefined;
    }
  }

  async devices(): Promise<AdbDeviceEntry[]> {
    return parseAdbDevices(await this.run(['devices', '-l'], { timeoutMs: 15_000 }));
  }

  device(serial: string): AdbDevice {
    return new AdbDevice(this, serial);
  }
}

export class AdbDevice {
  constructor(readonly adb: Adb, readonly serial: string) {}

  /** `adb -s <serial> <args…>` */
  async run(args: string[], opts: { timeoutMs?: number } = {}): Promise<string> {
    return this.adb.run(['-s', this.serial, ...args], opts);
  }

  /** `adb -s serial shell <command>` (command passed as ONE string argument). */
  async shell(command: string, opts: { timeoutMs?: number } = {}): Promise<string> {
    return this.run(['shell', command], opts);
  }

  async getState(): Promise<string | undefined> {
    try {
      const state = (await this.run(['get-state'], { timeoutMs: 5000 })).trim();
      return state || undefined;
    } catch {
      return undefined;
    }
  }

  async getprop(name: string): Promise<string> {
    if (!/^[A-Za-z0-9_.\-]+$/.test(name)) throw new AvdmError('INVALID_ARGUMENT', `无效的属性名: ${name}`);
    return (await this.shell(`getprop ${name}`, { timeoutMs: 10_000 })).trim();
  }

  /** sys.boot_completed === '1' (false on any error). */
  async isBootCompleted(): Promise<boolean> {
    try {
      return (await this.shell('getprop sys.boot_completed', { timeoutMs: 5000 })).trim() === '1';
    } catch {
      return false;
    }
  }

  /** adb install -r [-g] <apk>; for multiple files use install-multiple. */
  async install(apkPaths: string[], opts: { grantAll?: boolean; timeoutMs?: number } = {}): Promise<string> {
    if (apkPaths.length === 0) throw new AvdmError('INVALID_ARGUMENT', '未指定要安装的 APK');
    const args = [apkPaths.length > 1 ? 'install-multiple' : 'install', '-r'];
    if (opts.grantAll) args.push('-g');
    args.push(...apkPaths);
    const out = await this.run(args, { timeoutMs: opts.timeoutMs ?? 10 * 60_000 });
    if (!/\bSuccess\b/.test(out) && /\b(Failure|Error)\b/i.test(out)) {
      throw new AvdmError('COMMAND_FAILED', `安装失败: ${out.trim()}`, { stdout: out });
    }
    return out.trim();
  }

  async uninstall(pkg: string): Promise<string> {
    assertPackage(pkg);
    const out = await this.run(['uninstall', pkg], { timeoutMs: 120_000 });
    if (/\bFailure\b/.test(out)) throw new AvdmError('COMMAND_FAILED', `卸载失败: ${out.trim()}`);
    return out.trim();
  }

  async push(local: string, remote: string): Promise<string> {
    return (await this.run(['push', local, remote], { timeoutMs: 30 * 60_000 })).trim();
  }

  async pull(remote: string, local: string): Promise<string> {
    return (await this.run(['pull', remote, local], { timeoutMs: 30 * 60_000 })).trim();
  }

  /** `exec-out screencap -p` → PNG bytes. */
  async screencapPng(): Promise<Buffer> {
    const buf = await execFileBuffer(this.adb.bin, ['-s', this.serial, 'exec-out', 'screencap', '-p'], {
      timeoutMs: 20_000,
    });
    if (buf.length < PNG_SIGNATURE.length || !buf.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
      throw new AvdmError('COMMAND_FAILED', `截图失败: 设备 ${this.serial} 返回的数据不是 PNG`);
    }
    return buf;
  }

  /** `exec-out screencap` → tightly packed RGBA_8888 pixels. */
  async screencapRaw(): Promise<RawScreencapFrame> {
    const buf = await execFileBuffer(this.adb.bin, ['-s', this.serial, 'exec-out', 'screencap'], {
      timeoutMs: 20_000,
      maxBuffer: MAX_RAW_BYTES,
    });
    return parseRawScreencap(buf);
  }

  async tap(x: number, y: number): Promise<void> {
    assertCoord(x, y);
    await this.shell(`input tap ${Math.round(x)} ${Math.round(y)}`, { timeoutMs: 10_000 });
  }

  async swipe(x1: number, y1: number, x2: number, y2: number, durationMs = 300): Promise<void> {
    assertCoord(x1, y1, x2, y2, durationMs);
    const coords = [x1, y1, x2, y2, Math.max(0, durationMs)].map((v) => Math.round(v)).join(' ');
    await this.shell(`input swipe ${coords}`, { timeoutMs: 10_000 + durationMs });
  }

  /** keycode number or name (e.g. 4, "KEYCODE_BACK", "HOME"). */
  async keyevent(code: number | string): Promise<void> {
    let arg: string;
    if (typeof code === 'number') {
      if (!Number.isInteger(code) || code < 0) throw new AvdmError('INVALID_ARGUMENT', `无效的按键码: ${code}`);
      arg = String(code);
    } else {
      const name = code.trim().toUpperCase();
      if (/^\d+$/.test(name)) arg = name;
      else if (/^[A-Z0-9_]+$/.test(name)) arg = name.startsWith('KEYCODE_') ? name : `KEYCODE_${name}`;
      else throw new AvdmError('INVALID_ARGUMENT', `无效的按键名: ${code}`);
    }
    await this.shell(`input keyevent ${arg}`, { timeoutMs: 10_000 });
  }

  /**
   * Type `value` with `input text` (spaces → %s, shell metacharacters escaped). Tab and newline are sent as
   * TAB / ENTER key events; see planInputText for what is rejected. Every character of `value` is typed.
   */
  async text(value: string): Promise<void> {
    for (const step of planInputText(value)) {
      if (step.kind === 'key') await this.shell(`input keyevent ${step.code}`, { timeoutMs: 10_000 });
      else await this.shell(`input text ${escapeInputText(step.text)}`, { timeoutMs: 30_000 });
    }
  }

  /** Launch app: `monkey -p <pkg> -c android.intent.category.LAUNCHER 1`, or `am start -n pkg/activity` if given. */
  async startApp(pkg: string, activity?: string): Promise<void> {
    assertPackage(pkg);
    let out: string;
    if (activity) {
      const component = activity.includes('/') ? activity : `${pkg}/${activity}`;
      if (!/^[A-Za-z0-9_.$/]+$/.test(component)) throw new AvdmError('INVALID_ARGUMENT', `无效的 Activity: ${activity}`);
      out = await this.shell(`am start -n '${component}'`, { timeoutMs: 30_000 });
    } else {
      out = await this.shell(`monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`, { timeoutMs: 30_000 });
    }
    if (/^Error\b|No activities found|monkey aborted/im.test(out)) {
      throw new AvdmError('COMMAND_FAILED', `启动应用 ${pkg} 失败: ${out.trim()}`);
    }
  }

  async stopApp(pkg: string): Promise<void> {
    assertPackage(pkg);
    await this.shell(`am force-stop ${pkg}`, { timeoutMs: 15_000 });
  }

  /** Installed packages (`pm list packages [-3]`), sorted. */
  async listPackages(opts: { thirdPartyOnly?: boolean } = {}): Promise<string[]> {
    const out = await this.shell(`pm list packages${opts.thirdPartyOnly ? ' -3' : ''}`, { timeoutMs: 30_000 });
    return parsePackageList(out);
  }

  /** Package currently in foreground (parse `dumpsys window` mCurrentFocus / mFocusedApp), if any. */
  async foregroundPackage(): Promise<string | undefined> {
    return parseForegroundPackage(await this.shell('dumpsys window', { timeoutMs: 15_000 }));
  }
}
