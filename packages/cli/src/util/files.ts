import { constants as fsConstants, promises as fsp } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export async function fileSize(file: string): Promise<number | undefined> {
  try {
    const st = await fsp.stat(file);
    return st.isFile() ? st.size : undefined;
  } catch {
    return undefined;
  }
}

export async function isExecutableFile(file: string): Promise<boolean> {
  try {
    const st = await fsp.stat(file);
    if (!st.isFile()) return false;
    await fsp.access(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find an executable: an explicit path (if given and executable), else PATH, else the usual Homebrew
 * locations (a GUI-launched Electron app or a minimal shell may not have them on PATH).
 */
export async function findExecutable(name: string, explicit?: string): Promise<string | undefined> {
  if (explicit) return (await isExecutableFile(explicit)) ? explicit : undefined;
  const dirs = [
    ...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
  const seen = new Set<string>();
  for (const dir of dirs) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    const candidate = path.join(dir, name);
    if (await isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}

/** Parse a flat `key=value` properties file (source.properties). */
export function parseProperties(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

/**
 * Revision of an installed SDK package, read from `<sdk>/<path segments>/source.properties`
 * (`Pkg.Revision`), falling back to `.avdm-package.json` written by our installer. `undefined` when the
 * package is not installed; `''` when installed but the revision is unknown.
 */
export async function installedRevision(sdkRoot: string, pkgPath: string): Promise<string | undefined> {
  const dir = path.join(sdkRoot, ...pkgPath.split(';'));
  try {
    const text = await fsp.readFile(path.join(dir, 'source.properties'), 'utf8');
    const rev = parseProperties(text)['Pkg.Revision'];
    if (rev) return rev;
  } catch {
    // fall through
  }
  try {
    const meta = JSON.parse(await fsp.readFile(path.join(dir, '.avdm-package.json'), 'utf8')) as { revision?: unknown };
    if (typeof meta.revision === 'string' && meta.revision) return meta.revision;
  } catch {
    // fall through
  }
  try {
    const st = await fsp.stat(dir);
    if (st.isDirectory() && (await fsp.readdir(dir)).length > 0) return '';
  } catch {
    // not installed
  }
  return undefined;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

/** Which file a path currently names; changes when the file is deleted and recreated (log rotation, `rm` + `create`). */
export interface FileIdentity {
  dev: number;
  ino: number;
  /** Creation time; compared on macOS only (Linux may report 0 or fall back to other timestamps). */
  birthtimeMs: number;
}

function identityOf(st: { dev: number; ino: number; birthtimeMs: number }): FileIdentity {
  return { dev: st.dev, ino: st.ino, birthtimeMs: st.birthtimeMs };
}

function sameFile(a: FileIdentity, b: FileIdentity): boolean {
  if (a.dev !== b.dev || a.ino !== b.ino) return false;
  return process.platform !== 'darwin' || a.birthtimeMs === b.birthtimeMs;
}

/**
 * Last `maxLines` complete lines of a file, read from one open handle together with the byte offset
 * right after them and the file's identity — the starting point for followFile(), so nothing written
 * between reading the tail and following is lost or printed twice. An unterminated last line is left
 * for the follower. A missing file gives `{ lines: [], offset: 0 }`.
 */
export async function readTail(
  file: string,
  maxLines: number,
  maxBytes = 256 * 1024,
): Promise<{ lines: string[]; offset: number; identity?: FileIdentity }> {
  let fh: fsp.FileHandle;
  try {
    fh = await fsp.open(file, 'r');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { lines: [], offset: 0 };
    throw err;
  }
  try {
    const st = await fh.stat();
    const size = st.size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    let got = 0;
    while (got < buf.length) {
      const { bytesRead } = await fh.read(buf, got, buf.length - got, start + got);
      if (bytesRead <= 0) break;
      got += bytesRead;
    }
    const data = buf.subarray(0, got);
    const lastNl = data.lastIndexOf(0x0a);
    if (lastNl < 0) return { lines: [], offset: start, identity: identityOf(st) };
    const lines = data.subarray(0, lastNl).toString('utf8').replace(/\r$/, '').split(/\r?\n/);
    if (start > 0) lines.shift(); // partial first line
    return { lines: maxLines > 0 ? lines.slice(-maxLines) : [], offset: start + lastNl + 1, identity: identityOf(st) };
  } finally {
    await fh.close().catch(() => {});
  }
}

/**
 * Follow a growing file (like `tail -F`) by polling it, starting at byte `from` of the file identified
 * by `identity` (from readTail; when omitted, the first file seen is taken as-is). Handles the file being
 * missing (waits), truncated, or deleted and recreated (restarts at 0 and calls onTruncate).
 * Resolves when `signal` aborts.
 */
export async function followFile(
  file: string,
  opts: {
    from: number;
    identity?: FileIdentity;
    signal: AbortSignal;
    onData: (text: string) => void;
    onTruncate?: () => void;
    intervalMs?: number;
  },
): Promise<void> {
  let decoder = new StringDecoder('utf8');
  const interval = opts.intervalMs ?? 500;
  let pos = opts.from;
  let identity = opts.identity;
  const buf = Buffer.alloc(256 * 1024);
  const restart = () => {
    pos = 0;
    decoder = new StringDecoder('utf8');
    opts.onTruncate?.();
  };
  while (!opts.signal.aborted) {
    await sleep(interval, opts.signal);
    if (opts.signal.aborted) break;
    let fh: fsp.FileHandle | undefined;
    try {
      fh = await fsp.open(file, 'r');
    } catch {
      continue; // missing for now (deleted, not yet recreated)
    }
    try {
      // Stat the handle we read from, so a replacement between two calls cannot mix up two files.
      const st = await fh.stat();
      if (!st.isFile()) continue;
      const current = identityOf(st);
      if (identity && !sameFile(identity, current)) restart();
      else if (st.size < pos) restart();
      identity = current;
      const size = st.size;
      while (pos < size && !opts.signal.aborted) {
        const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, size - pos), pos);
        if (bytesRead <= 0) break;
        pos += bytesRead;
        const text = decoder.write(buf.subarray(0, bytesRead));
        if (text) opts.onData(text);
      }
    } catch {
      // transient read error — retry on the next tick
    } finally {
      await fh.close().catch(() => {});
    }
  }
}

/** Splits streamed text into complete lines (keeps the unterminated tail for the next chunk). */
export class LineSplitter {
  private tail = '';

  push(text: string): string[] {
    const parts = (this.tail + text).split(/\r?\n/);
    this.tail = parts.pop() ?? '';
    return parts;
  }

  flush(): string[] {
    const rest = this.tail;
    this.tail = '';
    return rest ? [rest] : [];
  }
}
