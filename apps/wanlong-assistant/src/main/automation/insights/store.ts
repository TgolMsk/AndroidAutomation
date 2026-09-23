import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, readdir, rename, rm, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { withFileLock } from '@avdm/core';
import type { InsightAlert, InsightDay } from './contracts';
import { aggregateDay, cstDateKey, shiftDateKey, type InsightCycleFact } from './stats';

const FILE_VERSION = 1;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const RETENTION_DAYS = 90;
const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.json$/;

interface DayFile {
  version: 1;
  dateKey: string;
  cycles: InsightCycleFact[];
  alerts: InsightAlert[];
}

function validGameId(id: string): boolean { return /^[a-z][a-z0-9-]{0,63}$/.test(id); }
function validIndex(index: number): boolean { return Number.isInteger(index) && index >= 0 && index <= 63; }
function dayFile(key: string): DayFile { return { version: FILE_VERSION, dateKey: key, cycles: [], alerts: [] }; }

function validCycle(value: unknown): value is InsightCycleFact {
  if (!value || typeof value !== 'object') return false;
  const cycle = value as Partial<InsightCycleFact>;
  return typeof cycle.runId === 'string' && cycle.runId.length <= 100 &&
    typeof cycle.gameId === 'string' && validGameId(cycle.gameId) &&
    typeof cycle.index === 'number' && validIndex(cycle.index) &&
    typeof cycle.startedAt === 'number' && Number.isFinite(cycle.startedAt) &&
    typeof cycle.endedAt === 'number' && Number.isFinite(cycle.endedAt) &&
    typeof cycle.outcome === 'string' && cycle.outcome.length <= 80 &&
    (cycle.status === 'succeeded' || cycle.status === 'failed' || cycle.status === 'cancelled') &&
    (cycle.source === 'manual' || cycle.source === 'scheduled') &&
    Array.isArray(cycle.dispatches) && cycle.dispatches.length <= 64 && cycle.dispatches.every((item) =>
      item && typeof item.at === 'number' && Number.isFinite(item.at) &&
      ['wood', 'gold', 'iron', 'mana'].includes(item.resource) &&
      (item.storage === null || typeof item.storage === 'number' && Number.isFinite(item.storage)));
}

function validAlert(value: unknown): value is InsightAlert {
  if (!value || typeof value !== 'object') return false;
  const alert = value as Partial<InsightAlert>;
  return typeof alert.id === 'string' && alert.id.length <= 180 &&
    typeof alert.gameId === 'string' && validGameId(alert.gameId) &&
    typeof alert.index === 'number' && validIndex(alert.index) &&
    ['runFailed', 'circuitBroken', 'schedulePaused', 'consecutiveFailures', 'recoveryExhausted',
      'dispatchStalled', 'suspectedKicked', 'maintenanceRequired', 'updateRequired', 'suspectedFreeze'].includes(alert.kind ?? '') &&
    ['warning', 'critical'].includes(alert.severity ?? '') &&
    typeof alert.at === 'number' && Number.isFinite(alert.at) &&
    typeof alert.message === 'string' && alert.message.length <= 1000 &&
    (alert.runId === null || typeof alert.runId === 'string') &&
    (alert.evidence === undefined || validEvidence(alert.evidence));
}

function validEvidence(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const evidence = value as Record<string, unknown>;
  const allowed = new Set(['source', 'runId', 'outcome', 'errorCode', 'step', 'consecutiveFailures',
    'staticFrames', 'staticForMs', 'captureFailures', 'captureFailingForMs', 'templateId', 'score',
    'threshold', 'screenshotPath']);
  if (Object.keys(evidence).some((key) => !allowed.has(key))) return false;
  if (!['cycle', 'frame', 'capture'].includes(String(evidence.source))) return false;
  if (evidence.runId !== null && (typeof evidence.runId !== 'string' || evidence.runId.length > 100)) return false;
  for (const key of ['outcome', 'errorCode', 'step', 'templateId', 'screenshotPath']) {
    if (evidence[key] !== undefined && evidence[key] !== null &&
      (typeof evidence[key] !== 'string' || evidence[key].length > 1000)) return false;
  }
  for (const key of ['consecutiveFailures', 'staticFrames', 'staticForMs', 'captureFailures',
    'captureFailingForMs', 'score', 'threshold']) {
    if (evidence[key] !== undefined && (typeof evidence[key] !== 'number' || !Number.isFinite(evidence[key]))) return false;
  }
  return true;
}

async function atomicPrivateJson(file: string, value: unknown): Promise<void> {
  const data = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(data) > MAX_FILE_BYTES) throw new Error('统计日账超过 16 MB，请先归档旧记录');
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(tmp, 'wx', 0o600);
    try { await handle.writeFile(data); await handle.sync(); }
    finally { await handle.close(); }
    await rename(tmp, file);
    await chmod(file, 0o600);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** One atomic day ledger, keyed by run/alert id; repeated delivery never doubles a count. */
export class InsightStore {
  private readonly root: string;

  constructor(home: string) {
    if (!path.isAbsolute(home)) throw new Error('统计数据目录必须是绝对路径');
    this.root = path.join(home, 'automation', 'insights', 'days');
  }

  private fileFor(key: string): string {
    shiftDateKey(key, 0);
    return path.join(this.root, `${key}.json`);
  }

  async read(key: string): Promise<DayFile> {
    const file = this.fileFor(key);
    let raw: unknown;
    try {
      if ((await stat(file)).size > MAX_FILE_BYTES) throw new Error('文件超过大小上限');
      raw = JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return dayFile(key);
      throw new Error(`统计日账无法读取：${file}`, { cause: error });
    }
    const value = raw as Partial<DayFile> | null;
    if (!value || value.version !== FILE_VERSION || value.dateKey !== key ||
        !Array.isArray(value.cycles) || !value.cycles.every(validCycle) ||
        !Array.isArray(value.alerts) || !value.alerts.every(validAlert)) {
      throw new Error(`统计日账格式不兼容：${file}`);
    }
    return value as DayFile;
  }

  async addCycle(cycle: InsightCycleFact): Promise<boolean> {
    if (!validCycle(cycle)) throw new Error('采集统计事实无效');
    const key = cstDateKey(cycle.endedAt);
    const file = this.fileFor(key);
    const inserted = await withFileLock(`${file}.lock`, async () => {
      const day = await this.read(key);
      if (day.cycles.some((item) => item.runId === cycle.runId)) return false;
      day.cycles.push(cycle);
      await atomicPrivateJson(file, day);
      return true;
    });
    if (inserted) void this.prune().catch(() => undefined);
    return inserted;
  }

  async addAlert(alert: InsightAlert): Promise<boolean> {
    if (!validAlert(alert)) throw new Error('告警事实无效');
    const key = cstDateKey(alert.at);
    const file = this.fileFor(key);
    return withFileLock(`${file}.lock`, async () => {
      const day = await this.read(key);
      if (day.alerts.some((item) => item.id === alert.id)) return false;
      day.alerts.push(alert);
      await atomicPrivateJson(file, day);
      return true;
    });
  }

  /** Return ascending Beijing days; include next day's ledger for runs crossing midnight. */
  async days(gameId: string, index: number | null, count = 7, now = Date.now()): Promise<InsightDay[]> {
    if (!validGameId(gameId) || (index !== null && !validIndex(index))) throw new Error('统计范围无效');
    if (!Number.isInteger(count) || count < 1 || count > RETENTION_DAYS) throw new Error('统计天数应在 1–90 之间');
    const today = cstDateKey(now);
    const keys = Array.from({ length: count + 1 }, (_, offset) => shiftDateKey(today, 1 - offset));
    const files = await Promise.all(keys.map((key) => this.read(key)));
    const out: InsightDay[] = [];
    for (let offset = count; offset >= 1; offset--) {
      const current = files[offset]!;
      const next = files[offset - 1]!;
      // Runs are stored on their completion day, but a dispatch can occur before midnight.
      out.push(aggregateDay(current.dateKey, gameId, index, [...current.cycles, ...next.cycles], current.alerts));
    }
    return out;
  }

  async alerts(gameId: string, index: number | null, limit = 50, now = Date.now()): Promise<InsightAlert[]> {
    if (!validGameId(gameId) || (index !== null && !validIndex(index))) throw new Error('告警范围无效');
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('告警条数应在 1–200 之间');
    const today = cstDateKey(now);
    const out: InsightAlert[] = [];
    for (let offset = 0; offset < RETENTION_DAYS && out.length < limit; offset++) {
      const day = await this.read(shiftDateKey(today, -offset));
      out.push(...day.alerts.filter((item) => item.gameId === gameId && (index === null || item.index === index)).reverse());
    }
    return out.sort((a, b) => b.at - a.at).slice(0, limit);
  }

  private async prune(now = Date.now()): Promise<void> {
    const cutoff = shiftDateKey(cstDateKey(now), -RETENTION_DAYS);
    const names = await readdir(this.root).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    for (const name of names) {
      if (!DAY_FILE.test(name)) continue;
      if (name.slice(0, 10) < cutoff) await unlink(path.join(this.root, name)).catch(() => undefined);
    }
  }
}
