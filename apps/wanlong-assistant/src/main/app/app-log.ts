import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { AppLogPersistLevel } from '../../shared/app-settings';
import type { AppLogEntry, AppLogLevel, AppLogQuery } from '../../shared/ipc';
import { assertAbsoluteHome } from './private-file';

/** The file rotates past this size (5 MB × (1 + 3 rotated files) ≈ 20 MB at most). */
export const APP_LOG_MAX_BYTES = 5 * 1024 * 1024;
export const APP_LOG_KEEP_FILES = 3;
const DEFAULT_QUERY_LIMIT = 300;
const MAX_QUERY_LIMIT = 2000;
const MAX_MESSAGE_CHARS = 4000;
const MAX_DATA_CHARS = 8000;

export const LOG_LEVEL_ORDER: Readonly<Record<AppLogLevel, number>> = { debug: 0, info: 1, warn: 2, error: 3 };

type ConsoleLike = Pick<Console, 'log' | 'warn' | 'error'>;

/** True while an AppLog echoes a line to the console, so a console capture does not persist it a second time. */
let echoing = false;

export interface AppLogOptions {
  maxBytes?: number;
  keepFiles?: number;
  /** Lowest persisted level (app settings `logLevel`); warn and error are always persisted. */
  persistLevel?: () => AppLogPersistLevel;
  /** Every persisted entry, already scrubbed (wired to the `app-log` event). */
  onEntry?: (entry: AppLogEntry) => void;
  /** Live pushes per second at most (a warning storm must not flood the renderer; the file keeps every line). */
  maxPushesPerSecond?: number;
  /** Where lines are echoed; captured at construction so a later console capture cannot recurse. */
  console?: ConsoleLike;
  now?: () => number;
}

/** Scoped convenience logger handed to services (`appLog.scoped('scheduler').warn('…', { … }, index)`). */
export interface ScopedLog {
  debug(message: string, data?: Record<string, unknown>, index?: number): void;
  info(message: string, data?: Record<string, unknown>, index?: number): void;
  warn(message: string, data?: Record<string, unknown>, index?: number): void;
  error(message: string, data?: Record<string, unknown>, index?: number): void;
}

/**
 * Credential-shaped substrings replaced before anything is written or pushed: Telegram bot tokens (they sit inside
 * request URLs), `sk-` API keys, bearer / key=value secrets and mainland phone numbers. Registered live secrets
 * (the saved token, the AI key) are replaced verbatim on top of these patterns.
 */
const SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/(?<![0-9])\d{6,12}:[A-Za-z0-9_-]{30,}/g, '***'],
  [/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-***'],
  [/(Bearer\s+)[^\s"'\\]+/gi, '$1***'],
  [/((?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|passwd|authorization)["']?\s*[:=]\s*["']?)[^\s"'&,;\\}]+/gi, '$1***'],
  [/(?<![0-9])1[3-9]\d{9}(?![0-9])/g, '[手机号]'],
];

export function scrubSecrets(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const secret of secrets) if (secret.length >= 6) out = out.split(secret).join('***');
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…（已截断）` : text;
}

/** Message of an error without its stack (a stack or cause can carry request URLs). */
export function describeThrown(value: unknown): string {
  if (value instanceof Error) {
    const cause = value.cause instanceof Error ? value.cause.message : undefined;
    return cause && cause !== value.message ? `${value.message}（${cause}）` : value.message || value.name;
  }
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value) ?? String(value); }
  catch { return String(value); }
}

/** `[wanlong/bot] 文本` → scope `wanlong/bot`, message `文本`; other messages keep `fallback`. */
export function splitScope(message: string, fallback: string): { scope: string; message: string } {
  const match = /^\[([A-Za-z0-9_./-]{1,40})\]\s*/.exec(message);
  return match ? { scope: match[1]!, message: message.slice(match[0].length) || message } : { scope: fallback, message };
}

function rotatedName(file: string, n: number): string {
  return file.replace(/\.ndjson$/, `.${n}.ndjson`);
}

function isEntry(value: unknown): value is AppLogEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return typeof entry['ts'] === 'number' && typeof entry['message'] === 'string' && typeof entry['scope'] === 'string' &&
    typeof entry['level'] === 'string' && entry['level'] in LOG_LEVEL_ORDER;
}

/**
 * The assistant's persistent log, `<AVDM_HOME>/automation/logs/app.ndjson` (one JSON object per line, 0600).
 *
 * Original iron rule: warn and error must reach the disk, because a packaged GUI app has no console to read (the
 * 2026-09-18 incident: the error text named the broken glyph set, but nobody could see it). debug never goes to
 * disk; info only when the settings ask for it. `record()` is synchronous and never throws; appends are serialized
 * so concurrent writers never interleave half lines. Files rotate by size and old rotations are deleted.
 */
export class AppLog {
  readonly dir: string;
  readonly file: string;
  private readonly maxBytes: number;
  private readonly keepFiles: number;
  private readonly out: ConsoleLike;
  private readonly now: () => number;
  private chain: Promise<void> = Promise.resolve();
  private size: number | null = null;
  private readonly secretSources = new Set<() => readonly (string | null | undefined)[]>();
  private pushWindow = { start: 0, count: 0 };

  constructor(home: string, private readonly options: AppLogOptions = {}) {
    assertAbsoluteHome(home, '日志');
    this.dir = path.join(home, 'automation', 'logs');
    this.file = path.join(this.dir, 'app.ndjson');
    this.maxBytes = options.maxBytes ?? APP_LOG_MAX_BYTES;
    this.keepFiles = Math.max(1, options.keepFiles ?? APP_LOG_KEEP_FILES);
    this.out = options.console ?? { log: console.log.bind(console), warn: console.warn.bind(console), error: console.error.bind(console) };
    this.now = options.now ?? Date.now;
  }

  /** Register live secrets (saved tokens, API keys) that must never be written; returns the unregister function. */
  addSecrets(source: () => readonly (string | null | undefined)[]): () => void {
    this.secretSources.add(source);
    return () => { this.secretSources.delete(source); };
  }

  scrub(text: string): string {
    const secrets: string[] = [];
    for (const source of this.secretSources) {
      try { for (const value of source()) if (typeof value === 'string' && value) secrets.push(value); }
      catch { /* A broken secret source must not break logging. */ }
    }
    return scrubSecrets(text, secrets);
  }

  /** Whether `level` is written to disk under the current settings. */
  persists(level: AppLogLevel): boolean {
    if (level === 'debug') return false;
    if (level === 'info') {
      try { return this.options.persistLevel?.() === 'info'; }
      catch { return false; }
    }
    return true;
  }

  /**
   * Log one line: echoed to the console, and persisted (scrubbed) when the level qualifies. Never throws.
   * `echo: false` is for lines that were already printed (console capture).
   */
  record(level: AppLogLevel, scope: string, message: string, data?: Record<string, unknown>, index?: number, echo = true): void {
    try {
      if (echo) this.echo(level, scope, message, data, index);
      if (!this.persists(level)) return;
      const entry = this.build(level, scope, message, data, index);
      const line = `${JSON.stringify(entry)}\n`;
      this.chain = this.chain.then(() => this.append(line)).catch(() => undefined);
      if (this.options.onEntry && this.allowPush(entry.ts)) {
        try { this.options.onEntry(entry); }
        catch { /* A closed window must not break logging. */ }
      }
    } catch {
      // Logging is best effort by definition.
    }
  }

  debug(scope: string, message: string, data?: Record<string, unknown>, index?: number): void { this.record('debug', scope, message, data, index); }
  info(scope: string, message: string, data?: Record<string, unknown>, index?: number): void { this.record('info', scope, message, data, index); }
  warn(scope: string, message: string, data?: Record<string, unknown>, index?: number): void { this.record('warn', scope, message, data, index); }
  error(scope: string, message: string, data?: Record<string, unknown>, index?: number): void { this.record('error', scope, message, data, index); }

  scoped(scope: string): ScopedLog {
    return {
      debug: (message, data, index) => this.record('debug', scope, message, data, index),
      info: (message, data, index) => this.record('info', scope, message, data, index),
      warn: (message, data, index) => this.record('warn', scope, message, data, index),
      error: (message, data, index) => this.record('error', scope, message, data, index),
    };
  }

  /** Resolves once every line recorded so far is on disk (dispose, tests). */
  flush(): Promise<void> {
    return this.chain;
  }

  /** Newest matching entries across the current and rotated files, returned in chronological order. */
  async query(query: AppLogQuery = {}): Promise<AppLogEntry[]> {
    await this.flush();
    const limit = Math.min(MAX_QUERY_LIMIT, Math.max(1, Math.floor(query.limit ?? DEFAULT_QUERY_LIMIT)));
    const minLevel = query.minLevel ? LOG_LEVEL_ORDER[query.minLevel] : 0;
    const search = query.search?.trim().toLowerCase() || undefined;
    const out: AppLogEntry[] = [];
    const files = [this.file, ...Array.from({ length: this.keepFiles }, (_, i) => rotatedName(this.file, i + 1))];
    for (const file of files) {
      let text: string;
      try { text = await readFile(file, 'utf8'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw new Error(`读取日志失败：${file}（${describeThrown(error)}）`, { cause: error });
      }
      const lines = text.split('\n');
      for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
        const line = lines[i]!.trim();
        if (!line) continue;
        let entry: unknown;
        try { entry = JSON.parse(line); }
        catch { continue; } // A half line or a hand-edited line must not fail the whole query.
        if (!isEntry(entry)) continue;
        if (LOG_LEVEL_ORDER[entry.level] < minLevel) continue;
        if (query.since !== undefined && entry.ts <= query.since) continue;
        if (query.scope && entry.scope !== query.scope) continue;
        if (query.index !== undefined && entry.index !== query.index) continue;
        if (search && !entry.message.toLowerCase().includes(search) && !entry.scope.toLowerCase().includes(search)) continue;
        out.push(entry);
      }
      if (out.length >= limit) break;
    }
    return out.reverse();
  }

  private allowPush(now: number): boolean {
    const limit = this.options.maxPushesPerSecond ?? 50;
    if (now - this.pushWindow.start >= 1000 || now < this.pushWindow.start) this.pushWindow = { start: now, count: 0 };
    return ++this.pushWindow.count <= limit;
  }

  private echo(level: AppLogLevel, scope: string, message: string, data?: Record<string, unknown>, index?: number): void {
    const where = index === undefined ? '' : `[实例 ${index}] `;
    const line = `[${scope}] ${where}${message}`;
    echoing = true;
    try {
      if (level === 'error') this.out.error(line, ...(data ? [data] : []));
      else if (level === 'warn') this.out.warn(line, ...(data ? [data] : []));
      else this.out.log(line, ...(data ? [data] : []));
    } catch { /* A closed stdout (EPIPE) must not break logging. */ }
    finally { echoing = false; }
  }

  private build(level: AppLogLevel, scope: string, message: string, data?: Record<string, unknown>, index?: number): AppLogEntry {
    const entry: AppLogEntry = {
      ts: this.now(),
      level,
      scope: this.scrub(clip(scope || 'main', 60)),
      message: this.scrub(clip(message, MAX_MESSAGE_CHARS)),
    };
    if (index !== undefined && Number.isInteger(index) && index >= 0) entry.index = index;
    if (data && Object.keys(data).length > 0) {
      let json: string;
      try { json = JSON.stringify(data) ?? '{}'; }
      catch { json = '{"__serializeFailed":true}'; } // Circular data: keep the line, drop the data.
      if (json.length > MAX_DATA_CHARS) json = JSON.stringify({ __truncated: true, preview: json.slice(0, MAX_DATA_CHARS) });
      try { entry.data = JSON.parse(this.scrub(json)) as Record<string, unknown>; }
      catch { entry.data = { __serializeFailed: true }; }
    }
    return entry;
  }

  private async append(line: string): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    if (this.size === null) {
      try { this.size = (await stat(this.file)).size; }
      catch { this.size = 0; }
    }
    const bytes = Buffer.byteLength(line);
    if (this.size > 0 && this.size + bytes > this.maxBytes) await this.rotate();
    const handle = await open(this.file, 'a', 0o600);
    try { await handle.appendFile(line); }
    finally { await handle.close(); }
    this.size += bytes;
  }

  private async rotate(): Promise<void> {
    await rm(rotatedName(this.file, this.keepFiles), { force: true });
    for (let n = this.keepFiles - 1; n >= 1; n--) {
      await rename(rotatedName(this.file, n), rotatedName(this.file, n + 1)).catch(() => undefined);
    }
    await rename(this.file, rotatedName(this.file, 1)).catch(() => undefined);
    this.size = 0;
  }
}

/**
 * Persist the main process's `console.warn` / `console.error` (the assistant's services log through them) into the
 * app log. The originals still print; a leading `[scope]` tag becomes the entry's scope. Returns the uninstaller.
 */
export function installConsoleCapture(log: Pick<AppLog, 'record'>, target: Pick<Console, 'warn' | 'error'> = console): () => void {
  const original = { warn: target.warn, error: target.error };
  let inside = false;
  const wrap = (level: 'warn' | 'error') => (...args: unknown[]) => {
    original[level].apply(target, args);
    if (inside || echoing) return; // Lines the app log echoes itself, or a logger that warns, must not loop.
    inside = true;
    try {
      const text = args.map((arg) => (typeof arg === 'string' ? arg : describeThrown(arg))).join(' ');
      // Node prints process warnings (deprecations, native module notes) through console.error: keep them as warnings.
      if (/^\(node:\d+\) (\[[^\]]+\] )?\w*Warning:/.test(text)) {
        log.record('warn', 'node', text.replace(/^\(node:\d+\) /, ''), undefined, undefined, false);
        return;
      }
      const { scope, message } = splitScope(text, 'main');
      log.record(level, scope, message, undefined, undefined, false);
    } finally {
      inside = false;
    }
  };
  target.warn = wrap('warn');
  target.error = wrap('error');
  return () => {
    target.warn = original.warn;
    target.error = original.error;
  };
}
