import { readFile, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { withFileLock } from '@avdm/core';
import {
  ALERT_HISTORY_LIMIT, emptyPauseState, isAlertType, type AlertDetail, type AlertEvent, type AlertRecord, type AlertSeverity,
  type InstancePauseState, type NotifyResult,
} from '../../shared/alerts';
import { writePrivateFile } from '../app/private-file';

const VERSION = 1;
const MAX_PAUSES_BYTES = 256 * 1024;
const MAX_HISTORY_BYTES = 2 * 1024 * 1024;

/** A pause as stored: the renderer's state plus the AVD identity it belongs to. */
export interface StoredPause extends InstancePauseState {
  /** `record.createdAt` of the AVD that was paused: a recreated instance at the same index never inherits it. */
  instanceIdentity: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function str(value: unknown, max = 2_000): string | null {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, max) : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function severityOf(value: unknown): AlertSeverity | null {
  return value === 'critical' || value === 'warning' || value === 'info' ? value : null;
}

/** Scalars only (the detail must survive structuredClone and JSON). */
export function sanitizeDetail(value: unknown): AlertDetail | undefined {
  if (!isRecord(value)) return undefined;
  const out: AlertDetail = {};
  for (const [key, field] of Object.entries(value).slice(0, 32)) {
    if (key.length > 60) continue;
    if (field === null || typeof field === 'boolean' || (typeof field === 'number' && Number.isFinite(field))) out[key] = field;
    else if (typeof field === 'string') out[key] = field.slice(0, 500);
  }
  return out;
}

/** Tolerant per field and per record: a bad record only loses its own reason, never the whole file. */
export function sanitizePause(raw: unknown): StoredPause | null {
  if (!isRecord(raw)) return null;
  const index = num(raw['instanceIndex']);
  if (index === null || !Number.isInteger(index) || index < 0 || index > 63) return null;
  const identity = str(raw['instanceIdentity'], 100);
  if (raw['paused'] !== true) return { ...emptyPauseState(index), instanceIdentity: identity };
  const type = isAlertType(raw['type']) ? raw['type'] : null;
  const detail = sanitizeDetail(raw['detail']);
  return {
    ...emptyPauseState(index),
    paused: true,
    type,
    severity: severityOf(raw['severity']),
    reason: str(raw['reason']),
    pausedAt: num(raw['pausedAt']),
    shotPath: str(raw['shotPath'], 400),
    advice: str(raw['advice']),
    ...(detail ? { detail } : {}),
    notified: typeof raw['notified'] === 'boolean' ? raw['notified'] : null,
    notifyError: str(raw['notifyError']),
    eventId: str(raw['eventId'], 80),
    accountName: str(raw['accountName'], 120),
    instanceIdentity: identity,
  };
}

function sanitizeResult(raw: unknown): NotifyResult | null {
  if (!isRecord(raw)) return null;
  const channel = raw['channel'] === 'local' ? 'local' : raw['channel'] === 'telegram' ? 'telegram' : null;
  if (!channel) return null;
  return {
    ok: raw['ok'] === true,
    channel,
    failure: typeof raw['failure'] === 'string' ? raw['failure'] as NotifyResult['failure'] : null,
    message: str(raw['message']) ?? '',
    attempts: num(raw['attempts']) ?? 0,
    elapsedMs: num(raw['elapsedMs']) ?? 0,
    at: num(raw['at']) ?? 0,
    retryAfterSec: num(raw['retryAfterSec']),
  };
}

export function sanitizeRecord(raw: unknown): AlertRecord | null {
  if (!isRecord(raw) || !isRecord(raw['event'])) return null;
  const e = raw['event'];
  if (!isAlertType(e['type'])) return null;
  const index = num(e['instanceIndex']);
  const at = num(e['at']);
  const id = str(e['id'], 80);
  if (index === null || at === null || !id) return null;
  const detail = sanitizeDetail(e['detail']);
  const event: AlertEvent = {
    id, type: e['type'], severity: severityOf(e['severity']) ?? 'warning', instanceIndex: index,
    accountId: str(e['accountId'], 100), accountName: str(e['accountName'], 120), at,
    reason: str(e['reason']) ?? '', shotPath: str(e['shotPath'], 400), ...(detail ? { detail } : {}),
    dedupeKey: str(e['dedupeKey'], 80) ?? `${index}:${e['type']}`,
  };
  const results = Array.isArray(raw['results']) ? raw['results'].map(sanitizeResult).filter((item): item is NotifyResult => item !== null) : [];
  return { event, results, suppressed: raw['suppressed'] === true, pausedNow: raw['pausedNow'] === true };
}

/**
 * Pause records and alert history of the game's instances: `~/.avdm/automation/wanlong/alerts-pauses.json` (original
 * `<dataDir>/alerts-pauses.json`) and `alerts-history.json` (the original kept the history in memory; kept here across
 * restarts). The global alerts settings stay in `automation/alerts/` (store.ts). Atomic 0600 writes under the file lock
 * (same convention as config.json / throttle.json), serialized in process; tolerant reads (a corrupt file is moved
 * aside and startup continues with empty state — losing a pause reason is bad, a panel that cannot start is worse).
 */
export class AlertRecordsStore {
  readonly pausesFile: string;
  readonly historyFile: string;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(home: string, private readonly now: () => number = Date.now) {
    if (!path.isAbsolute(home)) throw new Error('告警数据目录必须是绝对路径');
    this.pausesFile = path.join(home, 'automation', 'wanlong', 'alerts-pauses.json');
    this.historyFile = path.join(home, 'automation', 'wanlong', 'alerts-history.json');
  }

  async loadPauses(): Promise<{ pauses: StoredPause[]; warnings: string[] }> {
    const warnings: string[] = [];
    const raw = await this.read(this.pausesFile, MAX_PAUSES_BYTES, warnings, '暂停状态');
    const list = isRecord(raw) && Array.isArray(raw['pauses']) ? raw['pauses'] : [];
    const pauses = list.map(sanitizePause).filter((item): item is StoredPause => item !== null);
    if (pauses.length < list.length) warnings.push(`暂停状态文件里有 ${list.length - pauses.length} 条记录格式不对，已丢弃。`);
    return { pauses, warnings };
  }

  savePauses(pauses: StoredPause[]): Promise<void> {
    const json = `${JSON.stringify({ version: VERSION, pauses }, null, 2)}\n`;
    if (Buffer.byteLength(json) > MAX_PAUSES_BYTES) return Promise.reject(new Error(`暂停状态超过大小上限：${this.pausesFile}`));
    return this.serialize(() => withFileLock(`${this.pausesFile}.lock`, () => writePrivateFile(this.pausesFile, json)));
  }

  async loadHistory(): Promise<{ records: AlertRecord[]; warnings: string[] }> {
    const warnings: string[] = [];
    const raw = await this.read(this.historyFile, MAX_HISTORY_BYTES, warnings, '告警历史');
    const list = isRecord(raw) && Array.isArray(raw['records']) ? raw['records'] : [];
    const records = list.map(sanitizeRecord).filter((item): item is AlertRecord => item !== null).slice(0, ALERT_HISTORY_LIMIT);
    return { records, warnings };
  }

  saveHistory(records: AlertRecord[]): Promise<void> {
    let kept = records.slice(0, ALERT_HISTORY_LIMIT);
    let json = `${JSON.stringify({ version: VERSION, records: kept })}\n`;
    // Oversized (long reasons): keep the newest that fit instead of failing.
    while (Buffer.byteLength(json) > MAX_HISTORY_BYTES && kept.length > 1) {
      kept = kept.slice(0, Math.floor(kept.length / 2));
      json = `${JSON.stringify({ version: VERSION, records: kept })}\n`;
    }
    return this.serialize(() => withFileLock(`${this.historyFile}.lock`, () => writePrivateFile(this.historyFile, json)));
  }

  flush(): Promise<void> {
    return this.chain.then(() => undefined, () => undefined);
  }

  private serialize(fn: () => Promise<void>): Promise<void> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async read(file: string, maxBytes: number, warnings: string[], label: string): Promise<unknown> {
    try {
      if ((await stat(file)).size > maxBytes) throw new Error('文件超过大小上限');
      return JSON.parse(await readFile(file, 'utf8')) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      const backup = `${file}.bad-${new Date(this.now()).toISOString().replace(/[:.]/g, '-')}`;
      await rename(file, backup).catch(() => undefined);
      warnings.push(`${label}文件无法读取，已改名为 ${path.basename(backup)}，本次从空状态开始：${file}`);
      return undefined;
    }
  }
}
