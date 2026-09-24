import { chmod, lstat, mkdir, open, readdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { LOG_LEVEL_ORDER, type LogEntry, type LogLevel } from '@avdm/automation/script';
import type { RunLogQuery, RunLogSummary } from './types';

/**
 * Run logs and trace shots on disk (wanlong-panel `store/logs.ts` + `store/shots.ts`):
 * `home/automation/games/<gameId>/runs/<runId>/events.ndjson` and `…/shots/<seq>-<label>.jpg`.
 *
 * ★ Only the main process writes these files: the executor thread sends batches, never file handles, so two
 *   writers can never interleave half lines. Appends to one file are serialized.
 * Lines are a superset of the old `{at, level, stepId, message}` shape; the reader accepts `at` and `ts`.
 */

const GAME_ID = /^[a-z][a-z0-9-]{0,63}$/;
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHOT_FILE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}\.(jpg|png)$/i;
/** A query reads at most this much from the end of a log. */
export const MAX_TAIL_BYTES = 4 * 1024 * 1024;
export const DEFAULT_LOG_LIMIT = 500;
export const MAX_LOG_LIMIT = 5000;
/** Run directories kept per game (matches the 200 runs kept in plans.json). */
export const KEEP_RUNS = 200;
export const MAX_SHOTS_PER_RUN = 1000;
export const MAX_SHOT_BYTES = 8 * 1024 * 1024;
const MAX_MESSAGE = 4096;
const MAX_LINE_BYTES = 64 * 1024;

export function assertRunId(runId: string): void {
  if (typeof runId !== 'string' || !RUN_ID.test(runId)) throw new Error('运行 ID 无效');
}

function assertGameId(gameId: string): void {
  if (!GAME_ID.test(gameId)) throw new Error('游戏编号无效');
}

/** `<runId>/<file>` or a bare file name → both parts, rejecting any path traversal. */
export function splitShotPath(runId: string, shot: string): { runId: string; file: string } {
  if (typeof shot !== 'string') throw new Error('截图路径无效');
  const parts = shot.split(/[/\\]/).filter((part) => part.length > 0);
  if (parts.length === 0 || parts.length > 2 || parts.some((part) => part === '.' || part === '..')) {
    throw new Error(`截图路径非法（只接受 <运行 ID>/<文件名> 或文件名）：${shot}`);
  }
  const file = parts.length > 1 ? parts[1]! : parts[0]!;
  const dir = parts.length > 1 ? parts[0]! : runId;
  assertRunId(dir);
  if (!SHOT_FILE.test(file)) throw new Error(`截图文件名非法：${file}`);
  return { runId: dir, file };
}

function encode(entries: readonly LogEntry[]): string {
  const lines: string[] = [];
  for (const entry of entries) {
    const message = entry.message.length > MAX_MESSAGE ? `${entry.message.slice(0, MAX_MESSAGE)}…` : entry.message;
    let line: string;
    try {
      line = JSON.stringify({ ...entry, message });
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw new Error('too large');
    } catch {
      // Circular or oversized data: keep the line, drop the data.
      line = JSON.stringify({
        ts: entry.ts, level: entry.level, runId: entry.runId, instanceIndex: entry.instanceIndex, scope: entry.scope,
        stepId: entry.stepId, message, shot: entry.shot, data: { __serializeFailed: true },
      });
    }
    lines.push(line);
  }
  return lines.length ? `${lines.join('\n')}\n` : '';
}

const LEVELS = new Set<string>(Object.keys(LOG_LEVEL_ORDER));

/** One stored line → LogEntry, accepting the older `{at, level, stepId, message}` lines. */
function decode(line: string, runId: string): LogEntry | null {
  let raw: unknown;
  try { raw = JSON.parse(line); } catch { return null; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const ts = typeof value.ts === 'number' ? value.ts : typeof value.at === 'number' ? value.at : null;
  if (ts === null || !Number.isFinite(ts) || typeof value.message !== 'string') return null;
  const level = typeof value.level === 'string' && LEVELS.has(value.level) ? value.level as LogLevel : 'info';
  const entry: LogEntry = {
    ts, level, runId: typeof value.runId === 'string' ? value.runId : runId,
    instanceIndex: typeof value.instanceIndex === 'number' ? value.instanceIndex : null,
    scope: typeof value.scope === 'string' ? value.scope : 'engine',
    message: value.message,
  };
  if (typeof value.stepId === 'string') entry.stepId = value.stepId;
  if (value.data && typeof value.data === 'object' && !Array.isArray(value.data)) entry.data = value.data as Record<string, unknown>;
  if (typeof value.shot === 'string') entry.shot = value.shot;
  return entry;
}

/** Per-game run directories: append, query, shots, list, delete, prune. */
export class RunLogStore {
  private readonly chains = new Map<string, Promise<void>>();

  constructor(private readonly home: string) {
    if (!path.isAbsolute(home)) throw new Error('运行日志根目录必须是绝对路径');
  }

  runsDir(gameId: string): string {
    assertGameId(gameId);
    return path.join(this.home, 'automation', 'games', gameId, 'runs');
  }

  runDir(gameId: string, runId: string): string {
    assertRunId(runId);
    return path.join(this.runsDir(gameId), runId);
  }

  private logFile(gameId: string, runId: string): string {
    return path.join(this.runDir(gameId, runId), 'events.ndjson');
  }

  private serialize(key: string, work: () => Promise<void>): Promise<void> {
    const next = (this.chains.get(key) ?? Promise.resolve()).then(work, work);
    const tail = next.catch(() => undefined);
    this.chains.set(key, tail);
    void tail.then(() => { if (this.chains.get(key) === tail) this.chains.delete(key); });
    return next;
  }

  /** Append one batch in a single write. Appends to one file never interleave. */
  async append(gameId: string, runId: string, entries: readonly LogEntry[]): Promise<void> {
    if (!entries.length) return;
    const file = this.logFile(gameId, runId);
    const text = encode(entries);
    return this.serialize(file, async () => {
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const handle = await open(file, 'a', 0o600);
      try { await handle.writeFile(text); }
      finally { await handle.close(); }
    });
  }

  /** Resolves once every append queued so far for this run has been written. */
  async flushed(gameId: string, runId: string): Promise<void> {
    await this.chains.get(this.logFile(gameId, runId));
  }

  /**
   * The newest `limit` lines matching the filters, in time order. Reads at most the last 4 MB and drops a
   * half line at the cut; malformed lines are skipped.
   */
  async query(gameId: string, query: RunLogQuery): Promise<LogEntry[]> {
    const file = this.logFile(gameId, query.runId);
    const limit = Math.min(MAX_LOG_LIMIT, Math.max(1, Math.floor(query.limit ?? DEFAULT_LOG_LIMIT)));
    const minLevel = query.minLevel ? LOG_LEVEL_ORDER[query.minLevel] : 0;
    await this.flushed(gameId, query.runId);
    let text: string;
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error(`运行日志不是常规文件：${file}`);
      const start = Math.max(0, info.size - MAX_TAIL_BYTES);
      const length = info.size - start;
      if (length === 0) return [];
      const handle = await open(file, 'r');
      try {
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, start);
        text = buffer.toString('utf8');
      } finally { await handle.close(); }
      if (start > 0) {
        const newline = text.indexOf('\n');
        text = newline >= 0 ? text.slice(newline + 1) : '';
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const lines = text.split('\n');
    const out: LogEntry[] = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      const line = lines[i]!.trim();
      if (!line) continue;
      const entry = decode(line, query.runId);
      if (!entry) continue;
      if (LOG_LEVEL_ORDER[entry.level] < minLevel) continue;
      if (query.since !== undefined && entry.ts <= query.since) continue;
      if (query.instanceIndex !== undefined && entry.instanceIndex !== null && entry.instanceIndex !== query.instanceIndex) continue;
      out.push(entry);
    }
    return out.reverse();
  }

  /** Save one trace shot (0600, never overwriting) and return `<runId>/<file>` for LogEntry.shot. */
  async saveShot(gameId: string, runId: string, file: string, bytes: Uint8Array): Promise<string> {
    const { file: name } = splitShotPath(runId, file);
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_SHOT_BYTES) throw new Error('留痕截图为空或过大');
    const dir = path.join(this.runDir(gameId, runId), 'shots');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const existing = (await readdir(dir)).length;
    if (existing >= MAX_SHOTS_PER_RUN) throw new Error(`本次执行的留痕截图已达上限 ${MAX_SHOTS_PER_RUN} 张`);
    const target = path.join(dir, name);
    const handle = await open(target, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
    await chmod(target, 0o600);
    return `${runId}/${name}`;
  }

  /** Read a trace shot for the monitor. */
  async readShot(gameId: string, runId: string, shot: string): Promise<Uint8Array> {
    const parts = splitShotPath(runId, shot);
    const file = path.join(this.runDir(gameId, parts.runId), 'shots', parts.file);
    let info;
    try { info = await lstat(file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('截图不存在（可能已被清理）');
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_SHOT_BYTES * 2) throw new Error('截图文件无效');
    return Uint8Array.from(await readFile(file));
  }

  async listShots(gameId: string, runId: string): Promise<string[]> {
    try { return (await readdir(path.join(this.runDir(gameId, runId), 'shots'))).filter((file) => SHOT_FILE.test(file)).sort(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }

  /** Run directories on disk, newest first. */
  async list(gameId: string): Promise<RunLogSummary[]> {
    const root = this.runsDir(gameId);
    let names: string[];
    try { names = await readdir(root); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const out: RunLogSummary[] = [];
    for (const runId of names.filter((name) => RUN_ID.test(name))) {
      try {
        const dir = await lstat(path.join(root, runId));
        if (!dir.isDirectory() || dir.isSymbolicLink()) continue;
        let size = 0;
        let updatedAt = dir.mtimeMs;
        try {
          const log = await stat(path.join(root, runId, 'events.ndjson'));
          size = log.size;
          updatedAt = Math.max(updatedAt, log.mtimeMs);
        } catch { /* A run without a log yet. */ }
        out.push({ runId, size, updatedAt });
      } catch { /* Removed meanwhile. */ }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async delete(gameId: string, runId: string): Promise<void> {
    const dir = this.runDir(gameId, runId);
    await this.flushed(gameId, runId);
    await rm(dir, { recursive: true, force: true });
  }

  /** Keep the newest `keep` run directories (never the protected ones); returns the removed run ids. */
  async prune(gameId: string, keep = KEEP_RUNS, protect: ReadonlySet<string> = new Set()): Promise<string[]> {
    const all = await this.list(gameId);
    const doomed = all.slice(Math.max(0, keep)).filter((item) => !protect.has(item.runId));
    for (const item of doomed) await this.delete(gameId, item.runId);
    return doomed.map((item) => item.runId);
  }
}
