import { readdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { withFileLock } from '@avdm/core';
import { cstDateKey, shiftDateKey, type DateKey } from '../../shared/time';
import { writePrivateFile } from '../app/private-file';
import { capSnapshots, sortFacts } from './aggregate';
import { StatsError, assertDateKey, isRealDateKey } from './errors';
import { parseFacts, validIndex, type StatsFact } from './facts';

const FILE_VERSION = 1;
/** One day never gets near this (a busy day is a few thousand facts); a larger file is treated as damaged. */
export const MAX_DAY_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_FACTS_PER_DAY = 50_000;
const MAX_STATE_BYTES = 256 * 1024;
const LOCK_TIMEOUT_MS = 15_000;

/** A pause (auto switched off) that has not been resumed yet, kept across restarts and midnights. */
export interface OpenPause {
  since: number;
  reason: string | null;
  instance: string | null;
  /** Account bound when the pause started (the next day's bucket keeps showing it, like the original rollover). */
  account: string | null;
}

/** Progress of the one-time import of the old insights ledger (automation/insights/days). */
export interface MigrationMarker {
  /** Facts recorded before this time came from the insights ledger; later ones come from the hooks. */
  cutoff: number;
  done: boolean;
  days: number;
  facts: number;
}

interface DayFile {
  version: typeof FILE_VERSION;
  gameId: string;
  dateKey: DateKey;
  facts: StatsFact[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Day ledgers `automation/games/<gameId>/stats/days/<YYYY-MM-DD>.json` (Beijing days) plus two small state files.
 *
 * Reads are tolerant (original loadDailyStats): a missing day is empty; unparsable JSON, an unknown version or an
 * oversized file reads as empty with a warning; a bad record is skipped alone and counted. A damaged file is never
 * overwritten in place: the next write to that day first renames it to `<key>.json.corrupt-<time>`. Writes are
 * atomic, owner-only (0600) and merge by fact id under a cross-process file lock, so a repeated delivery never
 * doubles a count.
 */
export class StatsStore {
  readonly root: string;
  readonly daysDir: string;
  private readonly warned = new Set<string>();

  constructor(home: string, readonly gameId: string, private readonly warn: (message: string) => void = () => undefined) {
    if (!path.isAbsolute(home)) throw new Error('统计数据目录必须是绝对路径');
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(gameId)) throw new Error('统计游戏 ID 无效');
    this.root = path.join(home, 'automation', 'games', gameId, 'stats');
    this.daysDir = path.join(this.root, 'days');
  }

  fileOf(key: DateKey): string {
    return path.join(this.daysDir, `${assertDateKey(key)}.json`);
  }

  /** Facts of one day (tolerant; never repairs the file). */
  async readDay(key: DateKey): Promise<StatsFact[]> {
    return (await this.load(key, false)).facts;
  }

  /**
   * Add facts to a day (existing ids win, so re-adding is a no-op), keep the newest 48 snapshots, and return the
   * day's merged facts. Facts of another Beijing day are refused.
   */
  async appendFacts(key: DateKey, facts: readonly StatsFact[]): Promise<StatsFact[]> {
    const file = this.fileOf(key);
    for (const fact of facts) {
      if (cstDateKey(fact.at) !== key) throw new StatsError('INVALID_ARGUMENT', `统计事实的日期（${cstDateKey(fact.at)}）与日账 ${key} 不符`);
    }
    return withFileLock(`${file}.lock`, async () => {
      const current = await this.load(key, true);
      const ids = new Set(current.facts.map((fact) => fact.id));
      const added = facts.filter((fact) => !ids.has(fact.id) && ids.add(fact.id));
      if (added.length === 0 && !current.dirty) return current.facts;
      const merged = sortFacts(capSnapshots([...current.facts, ...added]));
      if (merged.length > MAX_FACTS_PER_DAY) {
        throw new StatsError('IO_ERROR', `统计日账 ${key} 超过 ${MAX_FACTS_PER_DAY} 条记录，已停止写入这一天：${file}`);
      }
      const data = json({ version: FILE_VERSION, gameId: this.gameId, dateKey: key, facts: merged } satisfies DayFile);
      if (Buffer.byteLength(data) > MAX_DAY_FILE_BYTES) throw new StatsError('IO_ERROR', `统计日账超过 16 MB，已停止写入这一天：${file}`);
      await writePrivateFile(file, data);
      return merged;
    }, { timeoutMs: LOCK_TIMEOUT_MS });
  }

  /** Stored day keys, ascending; anything that is not `<real date>.json` is ignored. */
  async listDayKeys(): Promise<DateKey[]> {
    let names: string[];
    try { names = await readdir(this.daysDir); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new StatsError('IO_ERROR', `读取统计目录失败：${this.daysDir}`);
    }
    const keys: DateKey[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const key = name.slice(0, -'.json'.length);
      if (!isRealDateKey(key)) continue;
      try { if ((await stat(path.join(this.daysDir, name))).isFile()) keys.push(key); }
      catch { /* vanished */ }
    }
    return keys.sort();
  }

  /**
   * Delete day files older than `keepDays` Beijing days (keeps [today − keepDays + 1, today]); returns the removed
   * keys. A file that cannot be removed only warns. Nothing but `<date>.json` files is ever touched.
   */
  async prune(keepDays: number, now: number): Promise<DateKey[]> {
    const days = Math.max(1, Math.floor(keepDays));
    const oldest = shiftDateKey(cstDateKey(now), -(days - 1));
    const removed: DateKey[] = [];
    for (const key of await this.listDayKeys()) {
      if (key >= oldest) continue;
      try { await unlink(this.fileOf(key)); removed.push(key); }
      catch (error) { this.warn(`清理旧统计文件失败：${this.fileOf(key)}（${(error as Error).message}）`); }
    }
    return removed;
  }

  // ── open pauses and the migration marker ───────────────────────────────────

  async readPauses(): Promise<Map<number, OpenPause>> {
    const raw = await this.readState('pauses.json');
    const out = new Map<number, OpenPause>();
    const open = isRecord(raw) && isRecord(raw['open']) ? raw['open'] : {};
    for (const [key, value] of Object.entries(open)) {
      const index = Number(key);
      if (!validIndex(index) || !isRecord(value)) continue;
      const since = value['since'];
      if (typeof since !== 'number' || !Number.isFinite(since) || since < 0) continue;
      out.set(index, {
        since,
        reason: typeof value['reason'] === 'string' ? value['reason'].slice(0, 200) : null,
        instance: typeof value['instance'] === 'string' ? value['instance'].slice(0, 64) : null,
        account: typeof value['account'] === 'string' ? value['account'].slice(0, 120) : null,
      });
    }
    return out;
  }

  async writePauses(pauses: ReadonlyMap<number, OpenPause>): Promise<void> {
    const open: Record<string, OpenPause> = {};
    for (const [index, pause] of [...pauses].sort((a, b) => a[0] - b[0])) open[String(index)] = { ...pause };
    await writePrivateFile(path.join(this.root, 'pauses.json'), json({ version: 1, open }));
  }

  async readMigration(): Promise<MigrationMarker | null> {
    const raw = await this.readState('migration.json');
    if (!isRecord(raw) || typeof raw['cutoff'] !== 'number' || !Number.isFinite(raw['cutoff'])) return null;
    return {
      cutoff: raw['cutoff'],
      done: raw['done'] === true,
      days: typeof raw['days'] === 'number' ? raw['days'] : 0,
      facts: typeof raw['facts'] === 'number' ? raw['facts'] : 0,
    };
  }

  async writeMigration(marker: MigrationMarker): Promise<void> {
    await writePrivateFile(path.join(this.root, 'migration.json'), json({ version: 1, source: 'insights', ...marker }));
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private async readState(name: string): Promise<unknown> {
    const file = path.join(this.root, name);
    try {
      if ((await stat(file)).size > MAX_STATE_BYTES) throw new Error('文件超过大小上限');
      return JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      this.warnOnce(`${file}:state`, `统计状态文件读不出，按空状态继续：${file}（${(error as Error).message}）`);
      return null;
    }
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.warn(message);
  }

  /**
   * @param repair inside the write lock only: a damaged file is renamed aside before it is overwritten (`dirty`
   *   then tells the caller to write even without new facts, dropping the skipped records).
   */
  private async load(key: DateKey, repair: boolean): Promise<{ facts: StatsFact[]; dirty: boolean }> {
    const file = this.fileOf(key);
    let text: string;
    try {
      const info = await stat(file);
      if (!info.isFile()) {
        this.warnOnce(`${file}:dir`, `统计日账位置被别的东西占了（不是文件），这一天按空账处理：${file}`);
        if (repair) throw new StatsError('IO_ERROR', `统计日账位置不是文件，无法写入：${file}`);
        return { facts: [], dirty: false };
      }
      if (info.size > MAX_DAY_FILE_BYTES) return this.damaged(file, '超过 16 MB', repair);
      text = await readFile(file, 'utf8');
    } catch (error) {
      if (error instanceof StatsError) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { facts: [], dirty: false };
      throw new StatsError('IO_ERROR', `读取统计日账失败：${file}`);
    }
    let raw: unknown;
    try { raw = JSON.parse(text); }
    catch { return this.damaged(file, '不是合法的 JSON', repair); }
    if (!isRecord(raw) || !Array.isArray(raw['facts'])) return this.damaged(file, '结构不对', repair);
    if (raw['version'] !== FILE_VERSION) return this.damaged(file, `格式版本 ${String(raw['version'])} 不认识`, repair);
    if (raw['dateKey'] !== key) {
      this.warnOnce(`${file}:key`, `统计日账 ${file} 里的日期（${String(raw['dateKey'])}）与文件名不符，已按文件名 ${key} 处理。`);
    }
    const parsed = parseFacts(raw['facts'] as unknown[]);
    const facts = parsed.facts.filter((fact) => cstDateKey(fact.at) === key);
    const skipped = parsed.skipped + (parsed.facts.length - facts.length);
    if (skipped > 0) {
      this.warnOnce(`${file}:skip:${skipped}`, `统计日账 ${file} 里有 ${skipped} 条记录格式不对或不属于这一天，已跳过（其余照常统计）。`);
    }
    return { facts, dirty: skipped > 0 };
  }

  private async damaged(file: string, reason: string, repair: boolean): Promise<{ facts: StatsFact[]; dirty: boolean }> {
    if (!repair) {
      this.warnOnce(`${file}:damaged`, `统计日账 ${file} ${reason}，这一天按空账显示；下次写入时原文件会改名保留备查。`);
      return { facts: [], dirty: false };
    }
    const aside = `${file}.corrupt-${Date.now()}`;
    try {
      await rename(file, aside);
      this.warn(`统计日账 ${file} ${reason}，已改名为 ${path.basename(aside)} 保留备查，这一天从空账重新记。`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new StatsError('IO_ERROR', `统计日账已损坏且无法改名保留：${file}`);
    }
    this.warned.delete(`${file}:damaged`);
    return { facts: [], dirty: true };
  }
}
