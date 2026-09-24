import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  MAX_TRAVEL_HINTS,
  defaultSchedulerConfig,
  mergeSchedulerConfig,
  type MarchResourceType,
  type MarchState,
  type SchedulerConfig,
  type TravelHint,
} from '@avdm/automation/wanlong/pure';

const FILE_VERSION = 1;
const MAX_CONFIG_BYTES = 16 * 1024;
const MAX_INSTANCE_BYTES = 256 * 1024;
const MAX_MARCHES = 16;
const LEGACY_GAME_ID = 'wanlong';

/** What survives a restart: absolute times only, so countdowns stay right after the app comes back. */
export interface PersistedQueue {
  instanceIndex: number;
  /** The AVD identity the bookkeeping belongs to (`record.createdAt`); a replaced AVD at the index starts fresh. */
  instanceCreatedAt: string | null;
  auto: boolean;
  accountId: string | null;
  queueUsed: number | null;
  queueTotal: number | null;
  marches: MarchState[];
  lastSampledAt: number;
  travelHints: TravelHint[];
  failureCount: number;
}

export interface LegacySchedule {
  index: number;
  enabled: boolean;
  file: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** An unknown resource becomes null instead of voiding the whole record. */
function resourceOrNull(value: unknown): MarchResourceType | null {
  return value === 'wood' || value === 'gold' || value === 'iron' || value === 'mana' ? value : null;
}

const COORD_RE = /^\d{1,5},\d{1,5}$/;

/** Per-field sanitize (original scheduler/store.ts): a malformed march is dropped, never guessed. */
export function sanitizeMarch(raw: unknown): MarchState | null {
  if (!isRecord(raw)) return null;
  const slot = numOrNull(raw.slot);
  if (slot == null || slot < 1 || slot > 16) return null;
  const status = raw.status;
  if (status !== 'gathering' && status !== 'gatherMarching' && status !== 'returning' && status !== 'idle' && status !== 'unknown') {
    return null;
  }
  const source = raw.travelTimeSource;
  return {
    slot,
    status,
    statusText: typeof raw.statusText === 'string' ? raw.statusText.slice(0, 32) : '',
    targetCoord: typeof raw.targetCoord === 'string' && COORD_RE.test(raw.targetCoord) ? raw.targetCoord : null,
    troopCount: numOrNull(raw.troopCount),
    commanders: Array.isArray(raw.commanders)
      ? raw.commanders.slice(0, 4).map((c) => ({
        current: numOrNull(isRecord(c) ? c.current : null),
        max: numOrNull(isRecord(c) ? c.max : null),
      }))
      : [],
    remainingMs: numOrNull(raw.remainingMs),
    resourceType: resourceOrNull(raw.resourceType),
    fillRatio: numOrNull(raw.fillRatio),
    timerEndsAt: numOrNull(raw.timerEndsAt),
    gatherDoneAt: numOrNull(raw.gatherDoneAt),
    freeAt: numOrNull(raw.freeAt),
    travelTimeMs: numOrNull(raw.travelTimeMs),
    travelTimeSource: source === 'dispatch' || source === 'observed' || source === 'fallback' || source === 'unrecorded' ? source : 'fallback',
    sampledAt: num(raw.sampledAt, 0),
    ...(typeof raw.warning === 'string' ? { warning: raw.warning.slice(0, 500) } : {}),
  };
}

export function sanitizeHint(raw: unknown): TravelHint | null {
  if (!isRecord(raw)) return null;
  const travelTimeMs = numOrNull(raw.travelTimeMs);
  if (travelTimeMs == null || travelTimeMs < 0) return null;
  const source = raw.source;
  return {
    travelTimeMs,
    source: source === 'dispatch' || source === 'observed' || source === 'fallback' ? source : 'dispatch',
    at: num(raw.at, 0),
    coord: typeof raw.coord === 'string' && COORD_RE.test(raw.coord) ? raw.coord : null,
    resourceType: resourceOrNull(raw.resourceType),
  };
}

/** Newest first, at most MAX_TRAVEL_HINTS. */
export function trimHints(hints: readonly TravelHint[]): TravelHint[] {
  return [...hints].sort((a, b) => b.at - a.at).slice(0, MAX_TRAVEL_HINTS);
}

function sanitizeQueue(raw: unknown, index: number, warnings: string[]): PersistedQueue | null {
  if (!isRecord(raw) || raw.version !== FILE_VERSION) return null;
  const marches: MarchState[] = [];
  for (const item of Array.isArray(raw.marches) ? raw.marches.slice(0, MAX_MARCHES) : []) {
    const march = sanitizeMarch(item);
    if (march) marches.push(march);
    else warnings.push(`实例 #${index} 的一条队伍记录格式不对，已丢弃。`);
  }
  const hints: TravelHint[] = [];
  for (const item of Array.isArray(raw.travelHints) ? raw.travelHints : []) {
    const hint = sanitizeHint(item);
    if (hint) hints.push(hint);
  }
  const failureCount = numOrNull(raw.failureCount);
  return {
    instanceIndex: index,
    instanceCreatedAt: typeof raw.instanceCreatedAt === 'string' && raw.instanceCreatedAt ? raw.instanceCreatedAt : null,
    auto: raw.auto === true,
    accountId: typeof raw.accountId === 'string' && raw.accountId ? raw.accountId.slice(0, 64) : null,
    queueUsed: numOrNull(raw.queueUsed),
    queueTotal: numOrNull(raw.queueTotal),
    marches,
    lastSampledAt: num(raw.lastSampledAt, 0),
    travelHints: trimHints(hints),
    failureCount: failureCount == null ? 0 : Math.max(0, Math.min(99, Math.round(failureCount))),
  };
}

/**
 * Durable scheduler state: `automation/games/wanlong/scheduler/{config.json, instances/<i>.json}`.
 *
 * Loading is tolerant (original rule): a missing file means defaults; an unreadable, malformed or oversized file is
 * moved aside as `<file>.corrupt-<time>` with a Chinese warning, so one bad cache file never blocks startup. Writes
 * are atomic, private (0600) and serialized per file.
 */
export class SchedulerStore {
  readonly root: string;
  private readonly writes = new Map<string, Promise<void>>();

  constructor(readonly home: string, private readonly now: () => number = Date.now) {
    if (!path.isAbsolute(home)) throw new Error('调度数据目录必须是绝对路径');
    this.root = path.join(home, 'automation', 'games', 'wanlong', 'scheduler');
  }

  get configFile(): string { return path.join(this.root, 'config.json'); }

  instanceFile(index: number): string {
    if (!Number.isInteger(index) || index < 0 || index > 63) throw new Error('实例编号无效');
    return path.join(this.root, 'instances', `${index}.json`);
  }

  async loadConfig(): Promise<{ config: SchedulerConfig; warnings: string[] }> {
    const warnings: string[] = [];
    const raw = await this.readTolerant(this.configFile, MAX_CONFIG_BYTES, '调度配置', warnings);
    if (raw === undefined) return { config: defaultSchedulerConfig(), warnings };
    if (!isRecord(raw) || raw.version !== FILE_VERSION || !isRecord(raw.config)) {
      await this.quarantine(this.configFile, '调度配置格式不兼容', warnings);
      return { config: defaultSchedulerConfig(), warnings };
    }
    return { config: mergeSchedulerConfig(defaultSchedulerConfig(), raw.config as Partial<SchedulerConfig>), warnings };
  }

  saveConfig(config: SchedulerConfig): Promise<void> {
    return this.write(this.configFile, { version: FILE_VERSION, config }, MAX_CONFIG_BYTES, '调度配置');
  }

  async loadInstances(): Promise<{ instances: PersistedQueue[]; warnings: string[] }> {
    const warnings: string[] = [];
    const dir = path.join(this.root, 'instances');
    let names: string[];
    try {
      names = (await readdir(dir)).filter((name) => /^\d{1,2}\.json$/.test(name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { instances: [], warnings };
      warnings.push(`读取调度状态目录失败，本次从空状态开始（不影响别的功能）：${dir}`);
      return { instances: [], warnings };
    }
    const instances: PersistedQueue[] = [];
    for (const name of names.sort()) {
      const index = Number(name.slice(0, -5));
      if (index > 63) continue;
      const file = path.join(dir, name);
      const raw = await this.readTolerant(file, MAX_INSTANCE_BYTES, `实例 #${index} 的调度状态`, warnings);
      if (raw === undefined) continue;
      const queue = sanitizeQueue(raw, index, warnings);
      if (!queue) {
        await this.quarantine(file, `实例 #${index} 的调度状态格式不兼容`, warnings);
        continue;
      }
      instances.push(queue);
    }
    return { instances, warnings };
  }

  saveInstance(queue: PersistedQueue): Promise<void> {
    const value = {
      version: FILE_VERSION,
      ...queue,
      marches: queue.marches.slice(0, MAX_MARCHES),
      travelHints: trimHints(queue.travelHints),
    };
    return this.write(this.instanceFile(queue.instanceIndex), value, MAX_INSTANCE_BYTES, `实例 #${queue.instanceIndex} 的调度状态`);
  }

  async deleteInstance(index: number): Promise<void> {
    const file = this.instanceFile(index);
    await this.serialize(file, () => rm(file, { force: true }));
  }

  /**
   * Schedules of the previous per-instance wake scheduler (`automation/scheduler/wanlong/<i>.json`,
   * {enabled, nextWakeAt, failureCount}). Only the enabled flag carries over: its wake times are stale.
   */
  async legacySchedules(): Promise<LegacySchedule[]> {
    const dir = path.join(this.home, 'automation', 'scheduler', LEGACY_GAME_ID);
    let names: string[];
    try { names = await readdir(dir); } catch { return []; }
    const out: LegacySchedule[] = [];
    for (const name of names) {
      if (!/^\d{1,2}\.json$/.test(name)) continue;
      const file = path.join(dir, name);
      try {
        const stat = await lstat(file);
        if (!stat.isFile() || stat.size > 16 * 1024) continue;
        const raw: unknown = JSON.parse(await readFile(file, 'utf8'));
        if (!isRecord(raw) || raw.gameId !== LEGACY_GAME_ID || typeof raw.enabled !== 'boolean') continue;
        out.push({ index: Number(name.slice(0, -5)), enabled: raw.enabled, file });
      } catch { /* A broken legacy file just does not migrate. */ }
    }
    return out.filter((item) => item.index <= 63).sort((a, b) => a.index - b.index);
  }

  /** Keep the legacy file (renamed) so a downgrade or manual check can still see it. */
  async retireLegacy(item: LegacySchedule): Promise<void> {
    await rename(item.file, `${item.file}.migrated`).catch(() => undefined);
  }

  /** undefined = missing (or quarantined); a parsed JSON value otherwise. */
  private async readTolerant(file: string, maxBytes: number, label: string, warnings: string[]): Promise<unknown> {
    let text: string;
    try {
      const stat = await lstat(file);
      if (!stat.isFile()) {
        warnings.push(`${label}不是常规文件，已忽略：${file}`);
        return undefined;
      }
      if (stat.size > maxBytes) {
        await this.quarantine(file, `${label}超过 ${Math.round(maxBytes / 1024)} KB`, warnings);
        return undefined;
      }
      text = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      warnings.push(`${label}读取失败，本次按默认值处理：${file}`);
      return undefined;
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      await this.quarantine(file, `${label}不是合法 JSON`, warnings);
      return undefined;
    }
  }

  private async quarantine(file: string, why: string, warnings: string[]): Promise<void> {
    const backup = `${file}.corrupt-${this.now()}`;
    try {
      await rename(file, backup);
      warnings.push(`${why}，已备份为 ${backup} 并从默认值重建。`);
    } catch {
      warnings.push(`${why}，且无法备份（${file}），本次按默认值处理。`);
    }
  }

  private write(file: string, value: unknown, maxBytes: number, label: string): Promise<void> {
    const json = JSON.stringify(value, null, 2) + '\n';
    if (Buffer.byteLength(json) > maxBytes) return Promise.reject(new Error(`${label}超过 ${Math.round(maxBytes / 1024)} KB 上限：${file}`));
    return this.serialize(file, () => writePrivate(file, json));
  }

  private serialize(file: string, operation: () => Promise<unknown>): Promise<void> {
    const previous = this.writes.get(file) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => { await operation(); });
    const tail = next.catch(() => undefined);
    this.writes.set(file, tail);
    void tail.then(() => { if (this.writes.get(file) === tail) this.writes.delete(file); });
    return next;
  }
}

async function writePrivate(file: string, json: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(json); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temp, file);
    await chmod(file, 0o600);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}
