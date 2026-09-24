import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { RESOURCE_TYPES, isResourceType } from '@avdm/automation/wanlong/pure';
import { normalizeDailyStats } from '../../shared/stats';
import { DAY_MS, cstDateKey, dateKeyToDayStart, type DateKey } from '../../shared/time';
import { isRealDateKey } from './errors';
import { FACT_LIMITS, clip, validIndex, type StatsFact } from './facts';
import type { StatsStore } from './store';

const MAX_INSIGHTS_FILE_BYTES = 16 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Facts from one insights day file (`{version:1, dateKey, cycles[], alerts[]}`), read leniently: a bad record is
 * skipped. Ids are deterministic (`ins:<runId>…`), so importing the same file twice adds nothing.
 *   · each dispatch → a dispatch fact (coordinate / level / travel time were not stored: null)
 *   · a cycle with outcome 'error' → a failure; 'circuitBroken' → a circuit break
 *   · every alert except the per-run 「运行失败」 notice → an alert (the original counted alert conclusions only)
 */
export function insightsFileFacts(raw: unknown, gameId: string, cutoff: number): { facts: StatsFact[]; skipped: number } {
  const facts: StatsFact[] = [];
  let skipped = 0;
  if (!isRecord(raw)) return { facts, skipped: 1 };
  const base = (id: string, at: number, index: number) => ({ id: clip(id, FACT_LIMITS.id), at, index, instance: null, account: null });
  for (const cycle of Array.isArray(raw['cycles']) ? raw['cycles'] : []) {
    if (!isRecord(cycle) || cycle['gameId'] !== gameId) { if (!isRecord(cycle)) skipped++; continue; }
    const runId = cycle['runId'];
    const index = cycle['index'];
    const endedAt = cycle['endedAt'];
    if (typeof runId !== 'string' || !runId || !validIndex(index) || !finite(endedAt)) { skipped++; continue; }
    const dispatches = Array.isArray(cycle['dispatches']) ? cycle['dispatches'] : [];
    dispatches.forEach((item: unknown, i: number) => {
      if (!isRecord(item) || !finite(item['at']) || !isResourceType(item['resource'])) { skipped++; return; }
      if (item['at'] >= cutoff) return;
      const storage = finite(item['storage']) ? item['storage'] : null;
      facts.push({ ...base(`ins:${runId}:d${i}`, item['at'], index), kind: 'dispatch', resource: item['resource'], storage, coord: null, level: null, travelTimeSec: null });
    });
    const outcome = cycle['outcome'];
    if ((outcome === 'error' || outcome === 'circuitBroken') && endedAt < cutoff) {
      facts.push({ ...base(`ins:${runId}:f`, endedAt, index), kind: 'cycleFailed', outcome, message: '', step: null, errorCode: null });
    }
  }
  for (const alert of Array.isArray(raw['alerts']) ? raw['alerts'] : []) {
    if (!isRecord(alert)) { skipped++; continue; }
    if (alert['gameId'] !== gameId || alert['kind'] === 'runFailed') continue;
    const id = alert['id'];
    const index = alert['index'];
    const at = alert['at'];
    const kind = alert['kind'];
    if (typeof id !== 'string' || !validIndex(index) || !finite(at) || typeof kind !== 'string' || !kind) { skipped++; continue; }
    if (at >= cutoff) continue;
    facts.push({ ...base(`ins:alert:${id}`, at, index), kind: 'alertRaised', alertType: kind.slice(0, FACT_LIMITS.alertType) });
  }
  return { facts, skipped };
}

export interface MigrationResult {
  ran: boolean;
  days: number;
  facts: number;
}

/**
 * One-time import of the existing insights ledger (`automation/insights/days/*.json`) into the statistics ledger,
 * so history recorded before this version keeps showing. The cutoff is chosen and stored **before** importing (the
 * earlier of now and the first fact the hooks recorded), so an interrupted import resumes with the same cutoff and
 * nothing recorded by the hooks is counted twice. The insights files themselves are left untouched.
 */
export async function migrateInsightsLedger(opts: {
  home: string;
  gameId: string;
  store: StatsStore;
  now: number;
  warn: (message: string) => void;
}): Promise<MigrationResult> {
  const { store, gameId } = opts;
  let marker = await store.readMigration();
  if (marker?.done) return { ran: false, days: marker.days, facts: marker.facts };
  if (!marker) {
    let cutoff = opts.now;
    for (const key of await store.listDayKeys()) {
      for (const fact of await store.readDay(key)) if (!fact.id.startsWith('ins:')) cutoff = Math.min(cutoff, fact.at);
    }
    marker = { cutoff, done: false, days: 0, facts: 0 };
    await store.writeMigration(marker);
  }
  const dir = path.join(opts.home, 'automation', 'insights', 'days');
  let names: string[] = [];
  try { names = await readdir(dir); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const byDay = new Map<DateKey, StatsFact[]>();
  let skipped = 0;
  for (const name of names.sort()) {
    if (!name.endsWith('.json') || !isRealDateKey(name.slice(0, -5))) continue;
    const file = path.join(dir, name);
    let raw: unknown;
    try {
      if ((await stat(file)).size > MAX_INSIGHTS_FILE_BYTES) throw new Error('超过 16 MB');
      raw = JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      opts.warn(`旧统计日账读不出，跳过导入：${file}（${(error as Error).message}）`);
      continue;
    }
    const result = insightsFileFacts(raw, gameId, marker.cutoff);
    skipped += result.skipped;
    for (const fact of result.facts) {
      const key = cstDateKey(fact.at);
      const list = byDay.get(key) ?? [];
      list.push(fact);
      byDay.set(key, list);
    }
  }
  let facts = 0;
  for (const [key, list] of [...byDay].sort((a, b) => a[0].localeCompare(b[0]))) {
    await store.appendFacts(key, list);
    facts += list.length;
  }
  if (skipped > 0) opts.warn(`导入旧统计日账时有 ${skipped} 条记录格式不对，已跳过。`);
  const done: typeof marker = { cutoff: marker.cutoff, done: true, days: byDay.size, facts };
  await store.writeMigration(done);
  return { ran: true, days: byDay.size, facts };
}

// ── wanlong-panel <dataDir>/stats/<YYYY-MM-DD>.json (explicit import only) ─────────────────────────────────

/**
 * Facts that reproduce one legacy day bucket (wanlong-panel `DailyStats`, read leniently with `normalizeDailyStats`)
 * in the fact ledger, for the explicit 「导入旧版数据」. Every counter of every instance bucket becomes that many
 * facts (storage split so Σ matches the estimated amount, the unknown-storage dispatches without storage, the paused
 * time as one pause from 00:00), snapshots are kept. Ids are deterministic (`legacy:<day>:<index>:…`), so importing the
 * same file again adds nothing. `mapIndex` maps an old instance index onto the AVD index it now belongs to (null
 * skips that instance); the old identity is unknown, so facts carry no instance identity.
 */
export function legacyDailyStatsFacts(raw: unknown, dateKey: DateKey, mapIndex: (legacyIndex: number) => number | null = (i) => i): StatsFact[] {
  if (!isRealDateKey(dateKey)) return [];
  const day = normalizeDailyStats(raw, dateKey);
  const start = dateKeyToDayStart(dateKey);
  const facts: StatsFact[] = [];
  for (const inst of Object.values(day.byInstance)) {
    const index = mapIndex(inst.instanceIndex);
    if (index === null || !validIndex(index)) continue;
    const prefix = `legacy:${dateKey}:${index}:${inst.key}`;
    const base = (id: string, at: number) => ({ id: clip(`${prefix}:${id}`, FACT_LIMITS.id), at, index, instance: null, account: inst.accountName ? clip(inst.accountName, FACT_LIMITS.account) : null });
    // Spread over the first hour so the facts stay ordered and inside the day.
    let tick = 0;
    const at = () => start + Math.min(3_599_000, (tick++) * 1000);
    for (const type of RESOURCE_TYPES) {
      const r = inst.byResource[type];
      const dispatches = Math.max(0, Math.floor(r.dispatches));
      const unknown = Math.min(dispatches, Math.max(0, Math.floor(r.unknownStorageDispatches)));
      const known = dispatches - unknown;
      const amount = Math.max(0, Math.round(r.estimatedAmount));
      for (let i = 0; i < known; i++) {
        // Σ storage = the estimated amount: an even split, the remainder on the first dispatch.
        const share = Math.floor(amount / known) + (i === 0 ? amount % known : 0);
        facts.push({ ...base(`d:${type}:${i}`, at()), kind: 'dispatch', resource: type, storage: share, coord: null, level: null, travelTimeSec: null });
      }
      for (let i = 0; i < unknown; i++) {
        facts.push({ ...base(`u:${type}:${i}`, at()), kind: 'dispatch', resource: type, storage: null, coord: null, level: null, travelTimeSec: null });
      }
      for (let i = 0; i < Math.max(0, Math.floor(r.completed)); i++) {
        facts.push({ ...base(`t:${type}:${i}`, at()), kind: 'tripCompleted', coord: null, resource: type, via: 'event' });
      }
    }
    for (let i = 0; i < Math.max(0, Math.floor(inst.failures)); i++) {
      facts.push({ ...base(`f:${i}`, at()), kind: 'cycleFailed', outcome: 'error', message: '旧版统计导入', step: null, errorCode: null });
    }
    for (let i = 0; i < Math.max(0, Math.floor(inst.circuitBreaks)); i++) {
      facts.push({ ...base(`c:${i}`, at()), kind: 'cycleFailed', outcome: 'circuitBroken', message: '旧版统计导入', step: null, errorCode: null });
    }
    for (let i = 0; i < Math.max(0, Math.floor(inst.alerts)); i++) {
      facts.push({ ...base(`a:${i}`, at()), kind: 'alertRaised', alertType: 'legacy' });
    }
    const paused = Math.min(DAY_MS, Math.max(0, Math.round(inst.pausedMs)));
    if (paused > 0) {
      facts.push({ ...base('p', start), kind: 'paused', reason: '旧版统计导入' });
      // A whole-day pause needs no resume: a past day closes its open pause at 24:00.
      if (paused < DAY_MS) facts.push({ ...base('r', start + paused), kind: 'resumed' });
    }
  }
  for (const snapshot of day.snapshots) {
    const index = mapIndex(snapshot.instanceIndex);
    if (index === null || !validIndex(index) || cstDateKey(snapshot.at) !== dateKey) continue;
    facts.push({
      id: `legacy:${dateKey}:snapshot:${index}:${snapshot.at}`, at: snapshot.at, index, instance: null, account: null,
      kind: 'snapshot', snapshot: { ...snapshot, instanceIndex: index },
    });
  }
  return facts;
}
