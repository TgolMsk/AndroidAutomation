import { randomBytes } from 'node:crypto';
import { promises as fsp, constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { AvdmError } from '../errors.js';
import { execFileText, sleep } from './proc.js';

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
}

export async function readTextIfExists(file: string): Promise<string | undefined> {
  try {
    return await fsp.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

export async function readJsonIfExists<T>(file: string): Promise<T | undefined> {
  const text = await readTextIfExists(file);
  if (text === undefined) return undefined;
  return JSON.parse(text) as T;
}

/**
 * Write via temp file + rename so readers never observe a partial file. The temp file is fsync'ed before the
 * rename: otherwise a crash / power loss right after the rename can leave a 0-byte file on APFS (the rename is
 * journaled before the data blocks).
 */
export async function atomicWriteFile(file: string, data: string | Buffer): Promise<void> {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    const fh = await fsp.open(tmp, 'w');
    try {
      await fh.writeFile(data);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fsp.rename(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

export async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  await atomicWriteFile(file, JSON.stringify(value, null, 2) + '\n');
}

/** Default age after which an un-refreshed lock directory is considered abandoned. */
const DEFAULT_LOCK_STALE_MS = 30_000;

/**
 * Cross-process mutex using an exclusive lock directory. Locks older than
 * `staleMs` are considered abandoned (crashed holder) and broken. While `fn` runs, the holder refreshes the
 * lock's mtime every staleMs/3, so a long critical section (e.g. copying an AVD) is never mistaken for a
 * crashed holder.
 */
export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  opts: { timeoutMs?: number; staleMs?: number } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const staleMs = opts.staleMs ?? DEFAULT_LOCK_STALE_MS;
  await ensureDir(path.dirname(lockPath));
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await fsp.mkdir(lockPath);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      try {
        const st = await fsp.stat(lockPath);
        if (Date.now() - st.mtimeMs > staleMs) {
          await fsp.rm(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue; // lock vanished between mkdir and stat
      }
      if (Date.now() > deadline) throw new AvdmError('LOCK_TIMEOUT', `等待文件锁超时: ${lockPath}`);
      await sleep(25 + Math.floor(Math.random() * 50));
    }
  }
  const heartbeat = setInterval(
    () => {
      const now = new Date();
      fsp.utimes(lockPath, now, now).catch(() => undefined);
    },
    Math.max(100, Math.floor(staleMs / 3)),
  );
  heartbeat.unref?.();
  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    await fsp.rm(lockPath, { recursive: true, force: true });
  }
}

/** True while some process holds (and keeps refreshing) the withFileLock() lock at `lockPath`. */
export async function isLockHeld(lockPath: string, staleMs = DEFAULT_LOCK_STALE_MS): Promise<boolean> {
  try {
    const st = await fsp.stat(lockPath);
    return Date.now() - st.mtimeMs <= staleMs;
  } catch {
    return false;
  }
}

/**
 * Copy a directory tree using APFS copy-on-write clones when possible
 * (`cp -c`, instant and ~0 extra disk), falling back to a plain recursive copy.
 * `dst` must not exist.
 */
export async function cloneDirectory(src: string, dst: string): Promise<{ method: 'apfs-clone' | 'copy' }> {
  if (await pathExists(dst)) throw new AvdmError('INVALID_ARGUMENT', `目标目录已存在: ${dst}`);
  await ensureDir(path.dirname(dst));
  if (process.platform === 'darwin') {
    try {
      await execFileText('/bin/cp', ['-c', '-R', src, dst], { timeoutMs: 10 * 60_000 });
      return { method: 'apfs-clone' };
    } catch {
      await fsp.rm(dst, { recursive: true, force: true });
    }
  }
  await fsp.cp(src, dst, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
  return { method: 'copy' };
}

/** Last `maxLines` lines of a text file (reads at most `maxBytes` from the end). */
export async function tailFile(file: string, maxLines = 200, maxBytes = 256 * 1024): Promise<string[]> {
  let fh: fsp.FileHandle | undefined;
  try {
    fh = await fsp.open(file, 'r');
    const { size } = await fh.stat();
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split(/\r?\n/);
    if (start > 0) lines.shift(); // drop partial first line
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines.slice(-maxLines);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  } finally {
    await fh?.close();
  }
}
