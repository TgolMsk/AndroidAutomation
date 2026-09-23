import { execFile, type ExecFileOptions } from 'node:child_process';
import { AvdmError } from '../errors.js';

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface ExecOptions {
  timeoutMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Max stdout/stderr buffer (default 64 MiB). */
  maxBuffer?: number;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
}

/** Run a command, resolve with text output; reject with AvdmError('COMMAND_FAILED') on non-zero exit. */
export function execFileText(cmd: string, args: string[], opts: ExecOptions = {}): Promise<string> {
  return execFileFull(cmd, args, opts).then((r) => r.stdout);
}

export function execFileFull(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  const options: ExecFileOptions = {
    timeout: opts.timeoutMs ?? 60_000,
    cwd: opts.cwd,
    env: opts.env,
    maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
    encoding: 'utf8',
  };
  return new Promise((resolve, reject) => {
    execFile(cmd, args, options, (err, stdout, stderr) => {
      const out = String(stdout ?? '');
      const errText = String(stderr ?? '');
      if (err) {
        reject(
          new AvdmError('COMMAND_FAILED', `${cmd} ${args.join(' ')} 失败: ${errText.trim() || err.message}`, {
            stdout: out,
            stderr: errText,
            code: (err as NodeJS.ErrnoException & { code?: unknown }).code,
          }),
        );
        return;
      }
      resolve({ stdout: out, stderr: errText });
    });
  });
}

/** Run a command and return stdout as a Buffer (for binary output such as screencap). */
export function execFileBuffer(cmd: string, args: string[], opts: ExecOptions = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      {
        timeout: opts.timeoutMs ?? 60_000,
        cwd: opts.cwd,
        env: opts.env,
        maxBuffer: opts.maxBuffer ?? 128 * 1024 * 1024,
        encoding: 'buffer',
      },
      (err, stdout, stderr) => {
        if (err) {
          reject(
            new AvdmError('COMMAND_FAILED', `${cmd} ${args.join(' ')} 失败: ${stderr?.toString().trim() || err.message}`),
          );
          return;
        }
        resolve(stdout as Buffer);
      },
    );
  });
}

/**
 * True if `pid` is a live process this user can signal. EPERM (the pid belongs to another user, e.g. a root
 * daemon that inherited a recycled pid) counts as NOT alive: every emulator/script we manage runs as us, so such
 * a pid can never be one of ours — and we could not stop it anyway.
 */
export function isPidAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false; // ESRCH (gone) or EPERM (someone else's process)
  }
}

/** `ps -o etime=` value ("[[dd-]hh:]mm:ss") → seconds. */
export function parseEtime(text: string): number | undefined {
  const m = /^\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s*$/.exec(text);
  if (!m) return undefined;
  const [, d, h, min, s] = m;
  return Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(min) * 60 + Number(s);
}

/** Start-time estimates are reused this long (a pid cannot be recycled that fast: it needs a full pid wrap). */
const START_CACHE_TTL_MS = 5000;
const startCache = new Map<number, { startMs: number; at: number }>();

/**
 * Approximate start time (epoch ms, ≤ ~1.1 s late) of each live pid, from one `ps -o pid=,etime=` call
 * (elapsed time, so no locale/time-zone parsing). Pids missing from the result are not running.
 * Returns undefined when this cannot be determined (Windows, no `ps`, ps failure) — callers then fall back
 * to trusting the pid.
 */
export async function processStartTimes(pids: readonly number[]): Promise<Map<number, number> | undefined> {
  if (process.platform === 'win32') return undefined;
  const now = Date.now();
  const out = new Map<number, number>();
  const query: number[] = [];
  for (const pid of new Set(pids)) {
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const cached = startCache.get(pid);
    if (cached && now - cached.at < START_CACHE_TTL_MS) out.set(pid, cached.startMs);
    else query.push(pid);
  }
  if (query.length === 0) return out;
  const text = await new Promise<string | undefined>((resolve) => {
    execFile(
      'ps',
      ['-o', 'pid=,etime=', '-p', query.join(',')],
      { timeout: 5000, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } },
      (err, stdout, stderr) => {
        // ps exits 1 without a message when none of the pids exist: that is an answer, not a failure.
        // Anything else (spawn error, timeout, "ps: …" complaint) means we cannot tell.
        const code = (err as { code?: unknown } | null)?.code;
        const quietNoMatch = code === 1 && String(stderr ?? '').trim() === '';
        if (err && !quietNoMatch) resolve(undefined);
        else resolve(String(stdout ?? ''));
      },
    );
  });
  if (text === undefined) return undefined;
  const at = Date.now();
  const seen = new Set<number>();
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\S+)\s*$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const elapsed = parseEtime(m[2]!);
    if (!query.includes(pid) || elapsed === undefined) continue;
    const startMs = at - elapsed * 1000;
    startCache.set(pid, { startMs, at });
    out.set(pid, startMs);
    seen.add(pid);
  }
  for (const pid of query) if (!seen.has(pid)) startCache.delete(pid);
  return out;
}

/** Tolerance for comparing a process start estimate with a timestamp we recorded (etime has 1 s resolution). */
export const PID_START_SLACK_MS = 2000;

/**
 * Could `pid` be the process that existed at `atMs` (epoch ms)? False when the pid is dead, belongs to another
 * user, or is a recycled pid whose process started after `atMs`. Undeterminable → true (trust the pid).
 */
export async function isPidStartedBy(pid: number, atMs: number): Promise<boolean> {
  if (!isPidAlive(pid)) return false;
  if (!Number.isFinite(atMs)) return true;
  const starts = await processStartTimes([pid]);
  if (!starts) return true;
  const start = starts.get(pid);
  return start !== undefined && start <= atMs + PID_START_SLACK_MS;
}

export function killPid(pid: number, signal: NodeJS.Signals = 'SIGTERM'): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

/** Poll `predicate` until it returns a truthy value or the timeout elapses (returns undefined on timeout). */
export async function waitFor<T>(
  predicate: () => Promise<T | undefined | null | false> | T | undefined | null | false,
  opts: { timeoutMs: number; intervalMs?: number; signal?: AbortSignal },
): Promise<T | undefined> {
  const deadline = Date.now() + opts.timeoutMs;
  const interval = opts.intervalMs ?? 500;
  for (;;) {
    if (opts.signal?.aborted) return undefined;
    try {
      const v = await predicate();
      if (v) return v as T;
    } catch {
      // treat errors as "not yet"
    }
    if (Date.now() >= deadline) return undefined;
    await sleep(interval);
  }
}

/** Compare dotted versions ("36.6.11" vs "37.1.11.0"). Returns -1, 0, 1. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.\-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(/[.\-]/).map((x) => Number.parseInt(x, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}
