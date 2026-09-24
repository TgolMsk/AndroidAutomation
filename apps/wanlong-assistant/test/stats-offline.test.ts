/**
 * Port of wanlong-panel scripts/stats-offline-check.ts (73 assertions): Beijing day boundaries under three host time
 * zones, the seven event kinds, the midnight pause split, amounts and the daily text, the day store and the
 * statistics service with its IPC. No emulator, no network; the clock is injected.
 */
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyResourceSnapshot, formatCnAmount, type ResourceSnapshot } from '@avdm/automation/wanlong/pure';
import {
  emptyDailyStats, formatPausedDuration, livePausedMs, normalizeDailyStats, renderDailyStatsText, type DailyStats, type StatsEvent,
} from '../src/shared/stats';
import { cstDateKey, cstDayStart, cstNextDayStart, dateKeyToDayStart, formatCstClock, shiftDateKey } from '../src/shared/time';
import { aggregateDay, isDayEmpty } from '../src/main/stats/aggregate';
import { cycleFailedEvent, dispatchEvents, autoChangedEvent, tripEvents } from '../src/main/stats/events';
import type { StatsFact } from '../src/main/stats/facts';
import { StatsService, type StatsInstanceInfo } from '../src/main/stats/service';
import { StatsStore } from '../src/main/stats/store';

const MIN = 60_000;
const HOUR = 3_600_000;
// Beijing 2026-09-09 23:59 = UTC 15:59
const T_2359 = Date.UTC(2026, 8, 9, 15, 59);
const T_0000 = T_2359 + MIN;
const DAY_A = '2026-09-09';
const DAY_B = '2026-09-10';
const T0 = dateKeyToDayStart(DAY_A) + 8 * HOUR; // Beijing 08:00

const originalTz = process.env.TZ;
const homes: string[] = [];
async function tempHome(prefix = 'avdm-stats-'): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), prefix));
  homes.push(home);
  return home;
}
afterAll(async () => {
  process.env.TZ = originalTz;
  await Promise.all(homes.map((home) => rm(home, { recursive: true, force: true })));
});

let seq = 0;
type Extra<K extends StatsFact['kind']> = Omit<Extract<StatsFact, { kind: K }>, 'id' | 'kind' | 'at' | 'index' | 'instance' | 'account'>;
function fact<K extends StatsFact['kind']>(kind: K, at: number, index: number, extra: Extra<K>, meta: { instance?: string | null; account?: string | null } = {}): StatsFact {
  return { id: `f${++seq}`, kind, at, index, instance: meta.instance ?? null, account: meta.account ?? null, ...extra } as unknown as StatsFact;
}
const dispatch = (at: number, index: number, resource: 'wood' | 'gold' | 'iron' | 'mana', storage: number | null, account: string | null = null, coord: string | null = null) =>
  fact('dispatch', at, index, { resource, storage, coord, level: 5, travelTimeSec: 100 }, { account });

describe('一、北京日切边界（与宿主时区无关）', () => {
  it('23:59 and 00:00 fall into different Beijing days', () => {
    expect(cstDateKey(T_2359)).toBe(DAY_A);
    expect(cstDateKey(T_0000)).toBe(DAY_B);
    expect(cstDayStart(T_2359)).toBe(Date.UTC(2026, 8, 8, 16));
    expect(cstNextDayStart(T_2359)).toBe(T_0000);
    expect(dateKeyToDayStart(DAY_A)).toBe(cstDayStart(T_2359));
    expect(shiftDateKey('2026-09-30', 1)).toBe('2026-10-01');
    expect(shiftDateKey('2026-10-01', -1)).toBe('2026-09-30');
  });

  it('gives identical keys and day buckets under America/Los_Angeles, Asia/Shanghai and UTC', () => {
    const results: Record<string, string> = {};
    const hours: Record<string, number> = {};
    for (const tz of ['America/Los_Angeles', 'Asia/Shanghai', 'UTC']) {
      process.env.TZ = tz;
      const day = aggregateDay('wanlong', DAY_A, [dispatch(T_2359, 0, 'wood', 1), dispatch(T_0000, 0, 'wood', 2)], T_2359);
      results[tz] = `${cstDateKey(T_2359)}|${cstDateKey(T_0000)}|${day.dispatches}|${formatCstClock(T_2359)}`;
      hours[tz] = new Date(T_2359).getHours();
    }
    process.env.TZ = originalTz;
    expect(results['America/Los_Angeles']).toBe(results['Asia/Shanghai']);
    expect(results['Asia/Shanghai']).toBe(results['UTC']);
    expect(results['UTC']).toBe(`${DAY_A}|${DAY_B}|1|23:59:00`);
    // Evidence that the host clock really changed with TZ.
    expect(new Set(Object.values(hours)).size).toBeGreaterThan(1);
  });
});

describe('二、聚合：七种事件', () => {
  it('counts dispatches, estimated amount, unknown storage and instance buckets without touching the input', () => {
    const facts = [
      dispatch(T0, 0, 'wood', 1_260_000, '主号', 'X:100 Y:200'),
      dispatch(T0 + MIN, 0, 'wood', null, '主号', 'X:101 Y:201'),
      dispatch(T0 + 2 * MIN, 1, 'mana', 420_000, '小号', 'X:1 Y:2'),
    ];
    const before = structuredClone(facts);
    const d = aggregateDay('wanlong', DAY_A, facts, T0 + HOUR);
    expect(facts).toEqual(before);
    expect(d.dispatches).toBe(3);
    expect(d.byResource.wood.dispatches).toBe(2);
    expect(d.byResource.mana.dispatches).toBe(1);
    expect(d.byResource.wood.estimatedAmount).toBe(1_260_000);
    expect(d.byResource.mana.estimatedAmount).toBe(420_000);
    expect(d.byResource.wood.unknownStorageDispatches).toBe(1);
    expect(d.byInstance['0']!.byResource.wood.unknownStorageDispatches).toBe(1);
    expect(d.byInstance['0']!.accountName).toBe('主号');
    expect(d.byInstance['1']!.accountName).toBe('小号');
    expect(d.byInstance['1']!.dispatches).toBe(1);
  });

  it('keeps failures and circuit breaks apart', () => {
    const d = aggregateDay('wanlong', DAY_A, [
      fact('cycleFailed', T0, 0, { outcome: 'error', message: 'x', step: null, errorCode: null }),
      fact('cycleFailed', T0 + MIN, 0, { outcome: 'circuitBroken', message: 'y', step: 'S', errorCode: 'STEP_FAILED' }),
    ], T0 + HOUR);
    expect([d.failures, d.circuitBreaks, d.byInstance['0']!.failures, d.byInstance['0']!.circuitBreaks]).toEqual([1, 1, 1, 1]);
  });

  it('turns hook payloads into events with the original rules', () => {
    const base = { message: 'm', step: null, errorCode: null, dispatched: 0, captures: 1, shotPath: null, kicked: null };
    expect(cycleFailedEvent(0, { ...base, outcome: 'error' }, T0)).toMatchObject({ kind: 'cycleFailed', outcome: 'error' });
    expect(cycleFailedEvent(0, { ...base, outcome: 'circuitBroken' }, T0)).toMatchObject({ outcome: 'circuitBroken' });
    // ★ A human must look: not a failure (the original returned before recording).
    expect(cycleFailedEvent(0, { ...base, outcome: 'error', errorCode: 'GAME_UPDATE_REQUIRED' }, T0)).toBeNull();
    expect(cycleFailedEvent(0, { ...base, outcome: 'error', errorCode: 'AI_RISK_BLOCKED' }, T0)).toBeNull();
    for (const outcome of ['dispatched', 'queueFull', 'noResourceWanted', 'giveUp', 'staminaLow', 'cancelled'] as const) {
      expect(cycleFailedEvent(0, { ...base, outcome }, T0)).toBeNull();
    }
    const records = [{ at: 0, resource: 'wood' as const, coord: 'X:1 Y:1', level: 5, searchFloor: 4, storage: 7, travelTimeSec: 60, troops: null }];
    expect(dispatchEvents(2, records, T0)[0]).toMatchObject({ at: T0, instanceIndex: 2, resource: 'wood', storage: 7, coord: 'X:1 Y:1' });
    expect(tripEvents(1, [{ slot: 0, coord: 'X:9 Y:9' } as { coord: string }], T0)).toEqual([{ kind: 'tripCompleted', at: T0, instanceIndex: 1, coord: 'X:9 Y:9', resource: null }]);
    expect(autoChangedEvent(0, false, T0, '连续失败')).toEqual({ kind: 'paused', at: T0, instanceIndex: 0, reason: '连续失败' });
    expect(autoChangedEvent(0, true, T0)).toEqual({ kind: 'resumed', at: T0, instanceIndex: 0 });
  });

  it('counts alerts, an idempotent pause, a 15-minute pause and ignores a stray resume', () => {
    const d = aggregateDay('wanlong', DAY_A, [
      fact('alertRaised', T0, 0, { alertType: 'kicked' }),
      fact('paused', T0 + 10 * MIN, 0, { reason: '机器人手动暂停' }),
      fact('paused', T0 + 12 * MIN, 0, { reason: '重复' }),
      fact('resumed', T0 + 25 * MIN, 0, {}),
      fact('resumed', T0 + 26 * MIN, 0, {}),
    ], T0 + HOUR);
    expect(d.alerts).toBe(1);
    expect(d.byInstance['0']!.alerts).toBe(1);
    expect(d.byInstance['0']!.pausedMs).toBe(15 * MIN);
    expect(d.pausedMs).toBe(15 * MIN);
    expect(d.byInstance['0']!.pausedSince).toBeNull();

    const open = aggregateDay('wanlong', DAY_A, [
      fact('paused', T0 + 10 * MIN, 0, { reason: null }),
      fact('paused', T0 + 12 * MIN, 0, { reason: null }),
    ], T0 + HOUR);
    // A repeated paused never moves the start later.
    expect(open.byInstance['0']!.pausedSince).toBe(T0 + 10 * MIN);
    expect(livePausedMs(open.byInstance['0']!, T0 + 40 * MIN)).toBe(30 * MIN);
  });

  it('keeps the newest 48 snapshots in time order and sets updatedAt to the last fact', () => {
    const snap: ResourceSnapshot = { ...emptyResourceSnapshot(0, T0 + 30 * MIN), warnings: [] };
    const one = aggregateDay('wanlong', DAY_A, [dispatch(T0, 0, 'wood', 1), fact('snapshot', snap.at, 0, { snapshot: snap })], T0 + HOUR);
    expect(one.snapshots).toHaveLength(1);
    expect(one.snapshots[0]!.at).toBe(snap.at);
    expect(one.updatedAt).toBe(snap.at);
    const many: StatsFact[] = [];
    for (let i = 59; i >= 0; i--) many.push(fact('snapshot', snap.at + i * MIN, 0, { snapshot: { ...snap, at: snap.at + i * MIN } }));
    const capped = aggregateDay('wanlong', DAY_A, many, T0 + 2 * HOUR);
    expect(capped.snapshots).toHaveLength(48);
    expect(capped.snapshots[47]!.at).toBe(snap.at + 59 * MIN);
    expect(capped.snapshots[0]!.at).toBe(snap.at + 12 * MIN);
  });

  it('ignores facts of another day and knows an empty day', () => {
    const day = aggregateDay('wanlong', DAY_A, [fact('alertRaised', T_0000, 0, { alertType: 'x' })], T_0000);
    expect(day.alerts).toBe(0);
    expect(isDayEmpty(emptyDailyStats(DAY_A))).toBe(true);
    expect(isDayEmpty(aggregateDay('wanlong', DAY_A, [dispatch(T0, 0, 'gold', 5)], T0))).toBe(false);
  });
});

describe('三、跨日：暂停在 0 点切开', () => {
  it('splits a pause at midnight: 10 minutes yesterday, 5 minutes today, account carried', () => {
    const paused = fact('paused', T_0000 - 10 * MIN, 0, { reason: '连续失败' }, { account: '主号' });
    const yesterday = aggregateDay('wanlong', DAY_A, [paused], T_0000 + 5 * MIN);
    // ★ A past day never shows an open pause (the original rendered +Infinity here).
    expect(yesterday.pausedMs).toBe(10 * MIN);
    expect(yesterday.byInstance['0']!.pausedMs).toBe(10 * MIN);
    expect(yesterday.byInstance['0']!.pausedSince).toBeNull();
    const carry = fact('pauseCarry', T_0000, 0, { since: paused.at }, { account: '主号' });
    const today = aggregateDay('wanlong', DAY_B, [carry], T_0000 + MIN);
    expect(today.byInstance['0']!.pausedSince).toBe(T_0000);
    expect(today.byInstance['0']!.accountName).toBe('主号');
    expect(today.dispatches + today.pausedMs + today.snapshots.length).toBe(0);
    const resumed = aggregateDay('wanlong', DAY_B, [carry, fact('resumed', T_0000 + 5 * MIN, 0, {})], T_0000 + HOUR);
    expect(resumed.pausedMs).toBe(5 * MIN);
    expect(resumed.byInstance['0']!.pausedSince).toBeNull();
  });
});

describe('四、金额格式化与今日统计文案', () => {
  it('formats amounts and durations like the game', () => {
    expect(formatCnAmount(1_110_000_000)).toBe('11.1亿');
    expect(formatCnAmount(91_290_000)).toBe('9129万');
    expect(formatCnAmount(9_999)).toBe('9,999');
    expect(formatCnAmount(59_677)).toBe('6万');
    expect(formatCnAmount(null)).toBe('—');
    expect(formatPausedDuration(0)).toBe('0分');
    expect(formatPausedDuration(15 * MIN)).toBe('15分');
    expect(formatPausedDuration(3 * HOUR + 12 * MIN)).toBe('3小时12分');
    expect(formatPausedDuration(30_000)).toBe('<1分');
    expect(formatPausedDuration(Number.NaN)).toBe('0分');
  });

  it('renders the daily text (plain, Beijing time)', () => {
    const facts: StatsFact[] = [];
    for (let i = 0; i < 6; i++) facts.push(dispatch(T0 + i * MIN, 0, 'wood', 1_260_000, '主号', `X:${i} Y:0`));
    facts.push(dispatch(T0 + 7 * MIN, 0, 'gold', null, '主号', 'X:9 Y:9'));
    const d = aggregateDay('wanlong', DAY_A, facts, T0 + HOUR);
    const text = renderDailyStatsText(d, { now: T0 + HOUR, formatClock: formatCstClock });
    expect(text).toContain('派兵 7 次');
    expect(text).toContain('木材 6 次 ≈ 756万');
    expect(text).toContain('有 1 趟储量没读出来');
    expect(text).toContain('实例 0「主号」');
    expect(text).toContain('北京时间，截至 09:00:00');
    expect(text).not.toMatch(/[*_`]/);
    expect(renderDailyStatsText(d, { now: T0 + 3 * 24 * HOUR, formatClock: formatCstClock })).toContain('【当日统计】2026-09-09（北京时间）');
  });

  it('normalizes a damaged bucket field by field', () => {
    const d = normalizeDailyStats({ dateKey: DAY_A, dispatches: 'abc', byInstance: { x: {}, 1: { dispatches: 4, pausedSince: 'no' } }, snapshots: [1, 2] }, DAY_A);
    expect(d.dispatches).toBe(0);
    expect(d.byInstance['1']!.dispatches).toBe(4);
    expect(d.byInstance['1']!.pausedSince).toBeNull();
    expect('x' in d.byInstance).toBe(false);
    expect(d.snapshots).toEqual([]);
  });
});

describe('五、落盘往返与容错', { timeout: 30_000 }, () => {
  let home: string;
  let warnings: string[];
  let store: StatsStore;
  beforeEach(async () => {
    home = await tempHome();
    warnings = [];
    store = new StatsStore(home, 'wanlong', (m) => warnings.push(m));
  });

  it('writes owner-only day files and reads them back', async () => {
    const facts = [dispatch(T0, 2, 'iron', 2_000_000, '铁号', 'X:5 Y:5')];
    await store.appendFacts(DAY_A, facts);
    expect(await store.readDay(DAY_A)).toEqual(facts);
    if (process.platform !== 'win32') expect((await stat(store.fileOf(DAY_A))).mode & 0o777).toBe(0o600);
    // Re-adding the same facts is a no-op (ids), never a double count.
    await store.appendFacts(DAY_A, facts);
    expect(await store.readDay(DAY_A)).toHaveLength(1);
    expect(await store.readDay('2020-01-01')).toEqual([]);
  });

  it('reads bad JSON as an empty day, then keeps the damaged file aside before writing', async () => {
    await mkdir(store.daysDir, { recursive: true });
    await writeFile(store.fileOf('2026-09-01'), '{ 这不是 JSON', 'utf8');
    expect(await store.readDay('2026-09-01')).toEqual([]);
    expect(warnings.some((w) => w.includes('不是合法的 JSON'))).toBe(true);
    const at = dateKeyToDayStart('2026-09-01') + HOUR;
    await store.appendFacts('2026-09-01', [dispatch(at, 0, 'wood', 1)]);
    expect(await store.readDay('2026-09-01')).toHaveLength(1);
    const aside = (await readdir(store.daysDir)).find((name) => name.startsWith('2026-09-01.json.corrupt-'));
    expect(aside).toBeDefined();
    expect(await readFile(path.join(store.daysDir, aside!), 'utf8')).toBe('{ 这不是 JSON');
  });

  it('skips one bad record and keeps the rest of the day', async () => {
    await mkdir(store.daysDir, { recursive: true });
    const good = dispatch(dateKeyToDayStart('2026-09-02') + HOUR, 1, 'gold', 4);
    await writeFile(store.fileOf('2026-09-02'), JSON.stringify({
      version: 1, gameId: 'wanlong', dateKey: '2026-09-02',
      facts: [good, { id: 'bad', kind: 'dispatch', at: 'x', index: 1 }, { kind: 'bogus' }],
    }), 'utf8');
    const facts = await store.readDay('2026-09-02');
    expect(facts).toEqual([good]);
    expect(warnings.some((w) => w.includes('2 条记录'))).toBe(true);
    expect(aggregateDay('wanlong', '2026-09-02', facts, Date.now()).byInstance['1']!.dispatches).toBe(1);
  });

  it('lists only real day files in order and prunes old days', async () => {
    for (const key of ['2026-09-01', '2026-09-02', DAY_A]) {
      await store.appendFacts(key, [dispatch(dateKeyToDayStart(key) + HOUR, 0, 'wood', 1)]);
    }
    await writeFile(path.join(store.daysDir, 'notes.txt'), 'x', 'utf8');
    await mkdir(path.join(store.daysDir, 'sub'), { recursive: true });
    await writeFile(path.join(store.daysDir, '2026-02-30.json'), '{}', 'utf8');
    expect(await store.listDayKeys()).toEqual(['2026-09-01', '2026-09-02', DAY_A]);
    expect(await store.prune(7, T0)).toEqual(['2026-09-01', '2026-09-02']);
    expect(await store.listDayKeys()).toEqual([DAY_A]);
    expect(await readFile(path.join(store.daysDir, 'notes.txt'), 'utf8')).toBe('x');
  });

  it('refuses an invalid date key in Chinese', async () => {
    await expect(store.readDay('2026/09/09')).rejects.toThrow('YYYY-MM-DD');
    await expect(store.readDay('2026-02-30')).rejects.toThrow('YYYY-MM-DD');
  });
});

describe('六、统计服务：跨 0 点换日、补记、查询', { timeout: 30_000 }, () => {
  let home: string;
  let now: number;
  let logs: string[];
  let pushed: DailyStats[];
  let snapshotCalls: number;
  const names: Record<number, StatsInstanceInfo> = {
    0: { createdAt: 'avd-0', accountName: '主号' },
    1: { createdAt: 'avd-1', accountName: null },
  };

  function service(extra: Partial<ConstructorParameters<typeof StatsService>[1]> = {}): StatsService {
    return new StatsService(home, {
      instanceInfo: async (index) => names[index] ?? { createdAt: null, accountName: null },
      now: () => now,
      log: (level, message) => logs.push(`[${level}] ${message}`),
      onToday: (s) => pushed.push(s),
      snapshotNow: async (index) => {
        snapshotCalls++;
        const snap = emptyResourceSnapshot(index, now);
        return { ...snap, rows: snap.rows.map((row) => ({ ...row, itemTotal: 290_000_000, rawItem: '2.9亿' })) };
      },
      ...extra,
    });
  }

  beforeEach(async () => {
    home = await tempHome();
    now = T_2359 - 30 * MIN; // Beijing 23:29
    logs = [];
    pushed = [];
    snapshotCalls = 0;
  });
  afterEach(() => { vi.useRealTimers(); });

  it('follows the original StatsCenter scenario end to end', async () => {
    const stats = service();
    await stats.start();
    expect(stats.today().dateKey).toBe(DAY_A);

    stats.record({ kind: 'dispatch', at: now, instanceIndex: 0, resource: 'wood', storage: 1_260_000, coord: 'X:1 Y:1', level: 5, travelTimeSec: 100 });
    stats.record({ kind: 'paused', at: now + MIN, instanceIndex: 0, reason: '连续失败' });
    await stats.idle();
    expect(stats.today().dispatches).toBe(1);
    expect(stats.today().byInstance['0']!.pausedSince).toBe(now + MIN);
    expect(stats.today().byInstance['0']!.accountName).toBe('主号');
    const copy = stats.today();
    copy.dispatches = 99;
    expect(stats.today().dispatches).toBe(1);

    // Across midnight: an event of the next day rolls the day over first.
    now = T_0000 + 5 * MIN;
    stats.record({ kind: 'tripCompleted', at: now, instanceIndex: 0, coord: 'X:1 Y:1', resource: null });
    await stats.idle();
    expect(stats.today().dateKey).toBe(DAY_B);
    // Yesterday's march came home today: the dispatch bookkeeping still knows it gathered wood.
    expect(stats.today().byResource.wood.completed).toBe(1);
    expect(stats.today().byInstance['0']!.pausedSince).toBe(T_0000);
    expect(stats.today().byInstance['0']!.accountName).toBe('主号');
    stats.record({ kind: 'resumed', at: now + MIN, instanceIndex: 0 });
    await stats.flush();
    expect(stats.today().pausedMs).toBe(6 * MIN);

    const yesterday = await stats.daily(DAY_A);
    expect(yesterday.dispatches).toBe(1);
    expect(yesterday.pausedMs).toBe(30 * MIN);
    expect(yesterday.byInstance['0']!.pausedSince).toBeNull();
    expect(aggregateDay('wanlong', DAY_B, await new StatsStore(home, 'wanlong').readDay(DAY_B), now + HOUR).pausedMs).toBe(6 * MIN);
    expect(pushed.at(-1)?.dateKey).toBe(DAY_B);

    // An earlier day's fact goes into that day's file; today is untouched.
    stats.record({ kind: 'alertRaised', at: T_2359, instanceIndex: 1, alertType: 'kicked' });
    await stats.idle();
    const yesterday2 = await stats.daily(DAY_A);
    expect([yesterday2.alerts, yesterday2.dispatches, stats.today().alerts]).toEqual([1, 1, 0]);

    // The timer path: time passes without events.
    now = T_0000 + 25 * HOUR;
    await stats.checkRollover(now);
    expect(stats.today().dateKey).toBe('2026-09-11');
    expect(isDayEmpty(stats.today())).toBe(true);
    expect((await stats.daily(DAY_B)).pausedMs).toBe(6 * MIN);

    const range = await stats.range('2026-09-08', '2026-09-11');
    expect(range.map((d) => d.dateKey)).toEqual(['2026-09-08', DAY_A, DAY_B, '2026-09-11']);
    expect(range[0]!.dispatches).toBe(0);
    expect(range[1]!.dispatches).toBe(1);
    await expect(stats.range(DAY_B, DAY_A)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringContaining('晚于') });
    await expect(stats.daily('20260909')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringContaining('YYYY-MM-DD') });

    const snap = await stats.snapshotNow(0);
    expect(snapshotCalls).toBe(1);
    expect(snap.instanceIndex).toBe(0);
    expect(stats.today().snapshots).toHaveLength(1);
    await expect(stats.snapshotNow(-1)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });

    // record never throws: a NaN time is recorded as now, an unknown kind only warns.
    expect(() => {
      stats.record({ kind: 'dispatch', at: Number.NaN, instanceIndex: 0, resource: 'gold', storage: 1, coord: null, level: null, travelTimeSec: null });
      stats.record({ kind: 'bogus' } as unknown as StatsEvent);
      stats.record(null as unknown as StatsEvent);
    }).not.toThrow();
    await stats.idle();
    expect(stats.today().byResource.gold.dispatches).toBe(1);
    expect(logs.some((line) => line.includes('未知事件'))).toBe(true);

    await stats.stop();
    const persisted = aggregateDay('wanlong', '2026-09-11', await new StatsStore(home, 'wanlong').readDay('2026-09-11'), now);
    expect(persisted.snapshots).toHaveLength(1);
    expect(logs.filter((line) => line.startsWith('[error]'))).toEqual([]);

    // Restart: today is read back.
    const again = service();
    await again.start();
    expect(again.today().dateKey).toBe('2026-09-11');
    expect(again.today().snapshots).toHaveLength(1);
    expect(again.today().byResource.gold.dispatches).toBe(1);
    await again.stop();
  });

  it('refuses snapshotNow in Chinese when the reader is not wired', async () => {
    const stats = service({ snapshotNow: undefined });
    await stats.start();
    await expect(stats.snapshotNow(0)).rejects.toThrow('未接线');
    await stats.stop();
  });

  it('pushes today at most once per second and the new day at once after midnight', async () => {
    const stats = service();
    await stats.start();
    pushed.length = 0;
    for (let i = 0; i < 5; i++) stats.record({ kind: 'alertRaised', at: now, instanceIndex: 0, alertType: 'x' });
    await stats.idle();
    expect(pushed).toHaveLength(0);
    await vi.waitFor(() => expect(pushed).toHaveLength(1), { timeout: 10_000 });
    expect(pushed[0]!.alerts).toBe(5);
    now = T_0000 + 2_000;
    await stats.checkRollover(now);
    expect(pushed.at(-1)).toMatchObject({ dateKey: DAY_B, alerts: 0 });
    await stats.stop();
  });

  it('resolves completed trips: own resource, coordinate, instance top, global top, else drops', async () => {
    const stats = service();
    await stats.start();
    const trip = (index: number, coord: string | null, resource: 'wood' | 'mana' | null = null) =>
      stats.record({ kind: 'tripCompleted', at: now, instanceIndex: index, coord, resource });
    trip(3, null);
    await stats.idle();
    expect(Object.values(stats.today().byResource).every((r) => r.completed === 0)).toBe(true);
    expect(logs.some((line) => line.includes('没有任何派兵记录可归类'))).toBe(true);
    stats.record({ kind: 'dispatch', at: now, instanceIndex: 0, resource: 'wood', storage: 1, coord: 'X:1 Y:1', level: null, travelTimeSec: null });
    stats.record({ kind: 'dispatch', at: now, instanceIndex: 1, resource: 'mana', storage: 1, coord: 'X:2 Y:2', level: null, travelTimeSec: null });
    stats.record({ kind: 'dispatch', at: now, instanceIndex: 1, resource: 'mana', storage: 1, coord: 'X:3 Y:3', level: null, travelTimeSec: null });
    trip(0, 'X:9 Y:9', 'mana'); // own resource wins
    trip(1, 'X:2 Y:2'); // bookkeeping by coordinate → mana
    trip(0, null); // instance 0 dispatched wood most
    trip(4, null); // instance 4 dispatched nothing: global top = mana
    await stats.idle();
    const d = stats.today();
    expect(d.byResource.mana.completed).toBe(3);
    expect(d.byResource.wood.completed).toBe(1);
    expect(logs.some((line) => line.includes('按该实例今日派兵最多的资源归类：木材'))).toBe(true);
    expect(logs.some((line) => line.includes('按全局今日派兵最多的资源归类：魔水'))).toBe(true);
    await stats.stop();
  });

  it('keeps a pause open across a closed app: every missed day is fully paused, today continues from 00:00', async () => {
    const first = service();
    await first.start();
    first.record({ kind: 'paused', at: now, instanceIndex: 0, reason: '手动关闭' });
    await first.stop();
    now = T_0000 + 2 * 24 * HOUR + 3 * HOUR; // Beijing 2026-09-12 03:00
    const later = service();
    await later.start();
    expect((await later.daily(DAY_A)).pausedMs).toBe(31 * MIN);
    expect((await later.daily(DAY_B)).pausedMs).toBe(24 * HOUR);
    expect((await later.daily('2026-09-11')).pausedMs).toBe(24 * HOUR);
    const today = later.today();
    expect(today.dateKey).toBe('2026-09-12');
    expect(today.byInstance['0']!.pausedSince).toBe(dateKeyToDayStart('2026-09-12'));
    expect(livePausedMs(today.byInstance['0']!, now)).toBe(3 * HOUR);
    later.record({ kind: 'resumed', at: now, instanceIndex: 0 });
    await later.flush();
    expect(later.today().pausedMs).toBe(3 * HOUR);
    await later.stop();
  });

  it('waits for start before applying early events and drops events after stop', async () => {
    const stats = service();
    stats.record({ kind: 'alertRaised', at: now, instanceIndex: 0, alertType: 'early' });
    await stats.start();
    await stats.idle();
    expect(stats.today().alerts).toBe(1);
    await stats.stop();
    stats.record({ kind: 'alertRaised', at: now, instanceIndex: 0, alertType: 'late' });
    expect(logs.some((line) => line.includes('已停止'))).toBe(true);
  });
});
