/**
 * Data safety of the statistics ledger (the stats-relevant parts of wanlong-panel scripts/data-offline-check.ts, with
 * the per-emulator data context replaced by AVD identity): a recreated AVD at the same index never merges into the old
 * one's numbers or account, concurrent writers never lose a fact, damaged state never blocks startup, and the old
 * insights ledger is imported exactly once. Also the stats / resources IPC through the real handler map.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => import('../../../packages/emulator-shell/test/helpers/electron-mock'));

import { emptyResourceSnapshot } from '@avdm/automation/wanlong/pure';
import { handlers } from '../../../packages/emulator-shell/test/helpers/electron-mock';
import { registerWanlongIpcHandlers, type WanlongServices } from '../src/main/ipc-handlers';
import { ResourcesService } from '../src/main/resources/service';
import { SchedulerError } from '../src/main/scheduler/errors';
import { aggregateDay } from '../src/main/stats/aggregate';
import type { StatsFact } from '../src/main/stats/facts';
import { insightsFileFacts } from '../src/main/stats/migrate';
import { StatsService, type StatsInstanceInfo } from '../src/main/stats/service';
import { StatsStore } from '../src/main/stats/store';
import { wanlongInvokeChannel } from '../src/shared/ipc';
import { dateKeyToDayStart } from '../src/shared/time';

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = '2026-09-09';
const T0 = dateKeyToDayStart(DAY) + 8 * HOUR;

const homes: string[] = [];
async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'avdm-stats-data-'));
  homes.push(home);
  return home;
}
afterAll(async () => { await Promise.all(homes.map((home) => rm(home, { recursive: true, force: true }))); });

function dispatchFact(id: string, at: number, index = 0): StatsFact {
  return { id, kind: 'dispatch', at, index, instance: null, account: null, resource: 'wood', storage: 10, coord: null, level: null, travelTimeSec: null };
}

describe('instance identity isolation', { timeout: 30_000 }, () => {
  it('never merges a recreated AVD at the same index into the old one, nor lends it the old account', async () => {
    const home = await tempHome();
    let now = T0;
    let info: StatsInstanceInfo = { createdAt: 'avd-old', accountName: '旧号' };
    const stats = new StatsService(home, { now: () => now, instanceInfo: async () => info });
    await stats.start();
    stats.record({ kind: 'dispatch', at: now, instanceIndex: 0, resource: 'wood', storage: 100, coord: null, level: null, travelTimeSec: null });
    stats.record({ kind: 'cycleFailed', at: now, instanceIndex: 0, outcome: 'error', message: 'x', step: null, errorCode: null });
    await stats.idle();
    // The AVD is deleted and created again at index 0; a minute later (past the identity cache) it gathers too.
    now += 2 * MIN;
    info = { createdAt: 'avd-new', accountName: null };
    stats.record({ kind: 'dispatch', at: now, instanceIndex: 0, resource: 'gold', storage: 7, coord: null, level: null, travelTimeSec: null });
    await stats.idle();
    const day = stats.today();
    expect(day.dispatches).toBe(2);
    expect(day.byInstance['0']).toMatchObject({ instanceCreatedAt: 'avd-new', replaced: false, dispatches: 1, failures: 0, accountName: null });
    expect(day.byInstance['0@avd-old']).toMatchObject({ instanceIndex: 0, instanceCreatedAt: 'avd-old', replaced: true, dispatches: 1, failures: 1, accountName: '旧号' });
    await stats.stop();
  });
});

describe('concurrent writers and damaged state', { timeout: 30_000 }, () => {
  it('keeps every fact of 32 concurrent writes and of two processes writing the same day', async () => {
    const home = await tempHome();
    const a = new StatsStore(home, 'wanlong');
    const b = new StatsStore(home, 'wanlong');
    await Promise.all(Array.from({ length: 32 }, (_, i) => (i % 2 ? a : b).appendFacts(DAY, [dispatchFact(`f${i}`, T0 + i)])));
    const facts = await a.readDay(DAY);
    expect(facts).toHaveLength(32);
    expect(new Set(facts.map((fact) => fact.id)).size).toBe(32);
    expect(aggregateDay('wanlong', DAY, facts, T0 + HOUR).dispatches).toBe(32);
  });

  it('starts with damaged pause / migration state and a damaged today file, keeping the damaged day aside', async () => {
    const home = await tempHome();
    const store = new StatsStore(home, 'wanlong');
    await mkdir(store.daysDir, { recursive: true });
    await writeFile(join(store.root, 'pauses.json'), '{broken', 'utf8');
    await writeFile(join(store.root, 'migration.json'), '[]', 'utf8');
    await writeFile(store.fileOf(DAY), '{broken', 'utf8');
    const logs: string[] = [];
    const stats = new StatsService(home, { now: () => T0, log: (level, message) => logs.push(`[${level}] ${message}`) });
    await stats.start();
    expect(stats.today().dispatches).toBe(0);
    stats.record({ kind: 'dispatch', at: T0, instanceIndex: 1, resource: 'iron', storage: 5, coord: null, level: null, travelTimeSec: null });
    await stats.flush();
    expect((await store.readDay(DAY))).toHaveLength(1);
    expect(logs.some((line) => line.includes('改名为'))).toBe(true);
    expect(logs.filter((line) => line.startsWith('[error]'))).toEqual([]);
    await stats.stop();
  });
});

describe('import of the old insights ledger', { timeout: 30_000 }, () => {
  async function writeInsightsDay(home: string, key: string, value: unknown): Promise<void> {
    const dir = join(home, 'automation', 'insights', 'days');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${key}.json`), typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
  }
  const cycle = (runId: string, endedAt: number, outcome: string, dispatches: Array<{ at: number; resource: string; storage: number | null }>, gameId = 'wanlong') => ({
    runId, gameId, index: 0, startedAt: endedAt - MIN, endedAt, outcome, status: outcome === 'error' ? 'failed' : 'succeeded', source: 'scheduled', dispatches,
  });
  const alert = (id: string, at: number, kind: string, gameId = 'wanlong') => ({ id, gameId, index: 0, kind, severity: 'warning', at, message: 'm', runId: null });

  let home: string;
  beforeEach(async () => { home = await tempHome(); });

  it('imports dispatches, failures, circuit breaks and alert conclusions once, keeping the insights files', async () => {
    const beforeMidnight = dateKeyToDayStart('2026-09-10') - 5 * MIN;
    const day10 = {
      version: 1, dateKey: '2026-09-10',
      cycles: [
        // A run that ended after midnight with a dispatch before it: the dispatch stays on the 9th.
        cycle('run-1', dateKeyToDayStart('2026-09-10') + 5 * MIN, 'dispatched', [{ at: beforeMidnight, resource: 'wood', storage: 1000 }, { at: beforeMidnight + MIN, resource: 'gold', storage: null }]),
        cycle('run-2', dateKeyToDayStart('2026-09-10') + HOUR, 'error', []),
        cycle('run-3', dateKeyToDayStart('2026-09-10') + 2 * HOUR, 'circuitBroken', []),
        cycle('run-x', dateKeyToDayStart('2026-09-10') + 2 * HOUR, 'error', [], 'other-game'),
        { broken: true },
      ],
      alerts: [
        alert('a-run', dateKeyToDayStart('2026-09-10') + HOUR, 'runFailed'),
        alert('a-kick', dateKeyToDayStart('2026-09-10') + 3 * HOUR, 'suspectedKicked'),
        alert('a-other', dateKeyToDayStart('2026-09-10') + 3 * HOUR, 'suspectedKicked', 'other-game'),
      ],
    };
    await writeInsightsDay(home, '2026-09-10', day10);
    await writeInsightsDay(home, '2026-09-08', '{broken');
    const now = dateKeyToDayStart('2026-09-11') + HOUR;
    const logs: string[] = [];
    const stats = new StatsService(home, { now: () => now, log: (level, message) => logs.push(`[${level}] ${message}`) });
    await stats.start();
    const nine = await stats.daily('2026-09-09');
    expect(nine.dispatches).toBe(2);
    expect(nine.byResource.wood.estimatedAmount).toBe(1000);
    expect(nine.byResource.gold.unknownStorageDispatches).toBe(1);
    const ten = await stats.daily('2026-09-10');
    expect([ten.failures, ten.circuitBreaks, ten.alerts, ten.dispatches]).toEqual([1, 1, 1, 0]);
    expect(logs.some((line) => line.includes('已把旧版统计'))).toBe(true);
    expect(logs.some((line) => line.includes('旧统计日账读不出'))).toBe(true);
    await stats.stop();

    // A second start never imports again (and the ids would dedupe anyway).
    const again = new StatsService(home, { now: () => now });
    await again.start();
    expect((await again.daily('2026-09-10')).failures).toBe(1);
    expect((await again.daily('2026-09-09')).dispatches).toBe(2);
    await again.stop();
    expect(JSON.parse(await readFile(join(home, 'automation', 'insights', 'days', '2026-09-10.json'), 'utf8'))).toEqual(day10);
  });

  it('never imports what the hooks already recorded (cutoff = the first hook fact)', async () => {
    const store = new StatsStore(home, 'wanlong');
    const hookAt = T0 + HOUR;
    await store.appendFacts(DAY, [dispatchFact('d:hook', hookAt)]);
    const facts = insightsFileFacts({ cycles: [cycle('r', hookAt + MIN, 'error', [{ at: hookAt + MIN, resource: 'wood', storage: 1 }, { at: T0, resource: 'wood', storage: 2 }])], alerts: [] }, 'wanlong', hookAt);
    expect(facts.facts.map((fact) => fact.id)).toEqual(['ins:r:d1']);
    await writeInsightsDay(home, DAY, { version: 1, dateKey: DAY, cycles: [cycle('r', hookAt + MIN, 'error', [{ at: hookAt + MIN, resource: 'wood', storage: 1 }, { at: T0, resource: 'wood', storage: 2 }])], alerts: [] });
    const stats = new StatsService(home, { now: () => hookAt + 2 * HOUR });
    await stats.start();
    const day = stats.today();
    expect(day.dispatches).toBe(2); // the hook's own fact + the one insights dispatch before it
    expect(day.failures).toBe(0);
    await stats.stop();
  });
});

describe('explicit import of wanlong-panel day buckets', { timeout: 30_000 }, () => {
  it('reproduces every counter of the old buckets, maps instance indexes and is idempotent', async () => {
    const home = await tempHome();
    const legacyKey = '2026-09-08';
    const legacy = {
      dateKey: legacyKey,
      byInstance: {
        0: {
          instanceIndex: 0, accountName: '主号',
          byResource: {
            wood: { dispatches: 4, estimatedAmount: 5_000_001, unknownStorageDispatches: 1, completed: 3 },
            mana: { dispatches: 1, estimatedAmount: 420_000, unknownStorageDispatches: 0, completed: 1 },
          },
          dispatches: 5, failures: 2, circuitBreaks: 1, alerts: 3, pausedMs: 15 * MIN, pausedSince: null,
        },
        1: { instanceIndex: 1, dispatches: 0, failures: 1, pausedMs: 24 * HOUR },
        7: { instanceIndex: 7, dispatches: 0, failures: 9 },
      },
      snapshots: [{ ...emptyResourceSnapshot(0, dateKeyToDayStart(legacyKey) + HOUR), warnings: [] }],
    };
    const stats = new StatsService(home, { now: () => T0 });
    await stats.start();
    const map = (index: number) => (index === 7 ? null : index + 2);
    const first = await stats.importLegacyDays([{ dateKey: legacyKey, raw: legacy }, { dateKey: '2020-01-01', raw: legacy }, { dateKey: 'bad', raw: legacy }], map);
    expect(first.days).toBe(1);
    const day = await stats.daily(legacyKey);
    const main = day.byInstance['2']!;
    expect(main).toMatchObject({ accountName: '主号', dispatches: 5, failures: 2, circuitBreaks: 1, alerts: 3, pausedMs: 15 * MIN, pausedSince: null });
    expect(main.byResource.wood).toEqual({ dispatches: 4, estimatedAmount: 5_000_001, unknownStorageDispatches: 1, completed: 3 });
    expect(main.byResource.mana).toEqual({ dispatches: 1, estimatedAmount: 420_000, unknownStorageDispatches: 0, completed: 1 });
    expect(day.byInstance['3']).toMatchObject({ failures: 1, pausedMs: 24 * HOUR, pausedSince: null });
    expect(day.byInstance['7']).toBeUndefined();
    expect(day.byInstance['9']).toBeUndefined();
    expect([day.dispatches, day.failures, day.circuitBreaks, day.alerts]).toEqual([5, 3, 1, 3]);
    expect(day.snapshots.map((snap) => snap.instanceIndex)).toEqual([2]);
    const again = await stats.importLegacyDays([{ dateKey: legacyKey, raw: legacy }], map);
    expect(again.facts).toBe(first.facts);
    expect((await stats.daily(legacyKey)).dispatches).toBe(5);
    await stats.stop();
  });
});

describe('stats and resources IPC', { timeout: 30_000 }, () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const appUrl = `${pathToFileURL(join(here, '..', '..', '..', 'packages', 'emulator-shell', 'src', 'renderer', 'index.html')).href}#/`;
  type Invoke = (event: unknown, ...args: unknown[]) => Promise<unknown>;
  const invoke = (method: string, ...args: unknown[]) =>
    (handlers.get(wanlongInvokeChannel(method as never)) as Invoke)({ sender: { id: 1 }, senderFrame: { url: appUrl } }, ...args);

  it('serves days, ranges and snapshots through the real handlers and keeps error codes', async () => {
    const home = await tempHome();
    const now = T0;
    let busy = false;
    const reading: Array<[number, boolean]> = [];
    const stats: StatsService = new StatsService(home, { now: () => now, snapshotNow: (index) => resources.read(index) });
    const resources: ResourcesService = new ResourcesService('wanlong', {
      read: async (index) => {
        if (busy) throw new SchedulerError('CONCURRENCY_LIMIT', `实例 #${index} 正在读取部队管理面板，读资源统计稍后再试。`);
        return { ...emptyResourceSnapshot(index, now), rows: emptyResourceSnapshot(index, now).rows.map((row) => ({ ...row, total: 1_110_000_000, rawTotal: '11.1亿' })) };
      },
      record: (snapshot) => stats.recordSnapshot(snapshot),
      onReading: (index, value) => reading.push([index, value]),
    });
    await stats.start();
    registerWanlongIpcHandlers({ stats, resources, windows: { kindOf: () => 'main' } } as unknown as WanlongServices);

    await expect(invoke('statsDaily', 'wanlong')).resolves.toMatchObject({ ok: true, value: { dateKey: DAY, dispatches: 0 } });
    await expect(invoke('statsDaily', 'wanlong', '2026/09/09')).resolves.toEqual({
      ok: false, error: { code: 'INVALID_ARGUMENT', message: '日期格式应为 YYYY-MM-DD，收到：2026/09/09' },
    });
    await expect(invoke('statsRange', 'wanlong', '2026-09-10', DAY)).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT', message: expect.stringContaining('晚于') } });
    const range = await invoke('statsRange', 'wanlong', '2026-09-06', DAY) as { ok: true; value: Array<{ dateKey: string }> };
    expect(range.value.map((d) => d.dateKey)).toEqual(['2026-09-06', '2026-09-07', '2026-09-08', DAY]);

    await expect(invoke('statsSnapshotNow', 'wanlong', 2)).resolves.toMatchObject({ ok: true, value: { instanceIndex: 2 } });
    await expect(invoke('resourcesRead', 'wanlong', 3)).resolves.toMatchObject({ ok: true, value: { instanceIndex: 3 } });
    const today = await invoke('statsDaily', 'wanlong', null) as { ok: true; value: { snapshots: unknown[] } };
    expect(today.value.snapshots).toHaveLength(2);
    expect(reading).toEqual([[2, true], [2, false], [3, true], [3, false]]);

    busy = true;
    await expect(invoke('resourcesRead', 'wanlong', 0)).resolves.toMatchObject({ ok: false, error: { code: 'CONCURRENCY_LIMIT' } });
    await expect(invoke('resourcesRead', 'wanlong', 99)).resolves.toMatchObject({ ok: false });
    await expect(invoke('resourcesReading', 'wanlong')).resolves.toEqual({ ok: true, value: [] });
    await expect(invoke('statsDaily', 'no-such-game')).resolves.toMatchObject({ ok: false });
    await stats.stop();
  });
});
