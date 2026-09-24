/**
 * Pure logic of the 数据统计 page (original statsStore + StatsView / ResourceSnapshotTable helpers): the midnight
 * follow of the live push, the day cache, the share fallback, the snapshot comparison and its precision threshold,
 * Beijing time whatever the host zone.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { InstanceState } from '@avdm/core';
import { emptyResourceSnapshot, type ResourceSnapshot } from '@avdm/automation/wanlong/pure';
import { emptyDailyStats, type DailyStats } from '../src/shared/stats';
import { dateKeyToDayStart, formatCstClock, shiftDateKey } from '../src/shared/time';
import {
  RECENT_DAYS, amountView, applyTodayPush, cachedDay, compareRows, deltaView, instanceRows, pageOf, pairByInstance,
  resourceRows, totalPausedMs, type StatsViewState,
} from '../src/renderer/views/stats/stats-model';
import { pickSnapshotIndex } from '../src/renderer/views/stats/StatsView';

const originalTz = process.env.TZ;
afterEach(() => { process.env.TZ = originalTz; });

function day(key: string, dispatches = 0): DailyStats {
  return { ...emptyDailyStats(key), dispatches };
}

function recent(to: string): DailyStats[] {
  return Array.from({ length: RECENT_DAYS }, (_, i) => day(shiftDateKey(to, i - (RECENT_DAYS - 1))));
}

function snap(index: number, at: number, total: number | null, item: number | null = 1): ResourceSnapshot {
  const base = emptyResourceSnapshot(index, at);
  return { ...base, rows: base.rows.map((row) => ({ ...row, total, itemTotal: item, rawTotal: total === null ? '1?.1亿' : 'x', rawItem: 'y' })) };
}

describe('live push (stats-today)', () => {
  const state = (selectedKey: string): StatsViewState => ({
    today: day('2026-09-09', 1), selectedKey, selected: day(selectedKey, 1), recent: recent('2026-09-09'),
  });

  it('refreshes the selected day and the recent row of the same day', () => {
    const next = applyTodayPush(state('2026-09-09'), day('2026-09-09', 5));
    expect(next.selected?.dispatches).toBe(5);
    expect(next.recent).toHaveLength(RECENT_DAYS);
    expect(next.recent.at(-1)?.dispatches).toBe(5);
  });

  it('follows Beijing midnight only when the page was on today, and keeps the recent list at 14 days', () => {
    const followed = applyTodayPush(state('2026-09-09'), day('2026-09-10'));
    expect(followed.selectedKey).toBe('2026-09-10');
    expect(followed.today?.dateKey).toBe('2026-09-10');
    expect(followed.recent).toHaveLength(RECENT_DAYS);
    expect(followed.recent.at(-1)?.dateKey).toBe('2026-09-10');
    expect(followed.recent[0]?.dateKey).toBe(shiftDateKey('2026-09-10', -(RECENT_DAYS - 1)));
    const stayed = applyTodayPush(state('2026-09-01'), day('2026-09-10'));
    expect(stayed.selectedKey).toBe('2026-09-01');
    expect(stayed.selected?.dateKey).toBe('2026-09-01');
  });

  it('reuses today and the recent days without IPC', () => {
    const s = state('2026-09-09');
    expect(cachedDay(s, '2026-09-09')).toBe(s.today);
    expect(cachedDay(s, '2026-09-01')?.dateKey).toBe('2026-09-01');
    expect(cachedDay(s, '2026-08-01')).toBeNull();
  });
});

describe('summary helpers', () => {
  it('shares by estimated amount, falls back to dispatch share, else zero', () => {
    const byAmount = day('2026-09-09', 4);
    byAmount.byResource.wood = { dispatches: 3, estimatedAmount: 300, unknownStorageDispatches: 0, completed: 0 };
    byAmount.byResource.gold = { dispatches: 1, estimatedAmount: 100, unknownStorageDispatches: 0, completed: 0 };
    expect(resourceRows(byAmount).find((r) => r.type === 'wood')?.share).toBe(0.75);
    const byCount = day('2026-09-09', 4);
    byCount.byResource.mana = { dispatches: 1, estimatedAmount: 0, unknownStorageDispatches: 1, completed: 0 };
    byCount.byResource.iron = { dispatches: 3, estimatedAmount: 0, unknownStorageDispatches: 3, completed: 0 };
    expect(resourceRows(byCount).find((r) => r.type === 'iron')?.share).toBe(0.75);
    expect(resourceRows(day('2026-09-09')).every((r) => r.share === 0)).toBe(true);
  });

  it('adds the running pause only when it is running, and orders instance rows', () => {
    const s = day('2026-09-09');
    const start = dateKeyToDayStart('2026-09-09');
    s.byInstance['1'] = { ...emptyDailyStats('x').byInstance['0']!, ...{ instanceIndex: 1, key: '1', instanceCreatedAt: 'b', replaced: false, accountName: null, byResource: s.byResource, dispatches: 0, failures: 0, circuitBreaks: 0, alerts: 0, pausedMs: 60_000, pausedSince: start } };
    s.byInstance['0@a'] = { ...s.byInstance['1']!, instanceIndex: 0, key: '0@a', replaced: true, pausedSince: null };
    s.byInstance['0'] = { ...s.byInstance['1']!, instanceIndex: 0, key: '0', pausedSince: null, pausedMs: 0 };
    expect(totalPausedMs(s, start + 120_000)).toBe(60_000 + 120_000 + 60_000);
    expect(instanceRows(s).map((row) => row.key)).toEqual(['0', '0@a', '1']);
  });

  it('picks the snapshot target: current, else the global running instance, else the first running one', () => {
    const inst = (index: number, status: string) => ({ record: { index, name: `i${index}`, createdAt: 'c' }, status }) as unknown as InstanceState;
    const list = [inst(0, 'stopped'), inst(1, 'running'), inst(2, 'running')];
    expect(pickSnapshotIndex(2, list, 1)).toBe(2);
    expect(pickSnapshotIndex(null, list, 2)).toBe(2);
    expect(pickSnapshotIndex(null, list, 0)).toBe(1);
    expect(pickSnapshotIndex(7, [inst(0, 'stopped')], null)).toBe(0);
    expect(pickSnapshotIndex(null, [], null)).toBeNull();
  });
});

describe('snapshot table', () => {
  it('pairs each instance\'s earliest and latest snapshot, sorted by index', () => {
    const pairs = pairByInstance([snap(2, 30, 1), snap(0, 20, 1), snap(2, 10, 1), snap(2, 20, 1)]);
    expect(pairs.map((p) => [p.instanceIndex, p.first.at, p.last.at])).toEqual([[0, 20, 20], [2, 10, 30]]);
    const rows = compareRows([snap(0, 20, 1)]);
    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.type)).toEqual(['gold', 'wood', 'iron', 'mana']);
    expect(rows[0]).toMatchObject({ firstOfInstance: true, same: true });
    expect(rows[1]!.firstOfInstance).toBe(false);
  });

  it('shows changes below 0.1亿 as ≈0 and larger ones with a direction', () => {
    expect(deltaView(1_110_000_000, 1_110_000_000 + 9_999_999)).toMatchObject({ kind: 'flat', text: '≈0' });
    expect(deltaView(1_110_000_000, 1_210_000_000)).toEqual({ kind: 'up', text: '+1亿' });
    expect(deltaView(1_210_000_000, 1_110_000_000)).toEqual({ kind: 'down', text: '-1亿' });
    expect(deltaView(null, 5)).toEqual({ kind: 'none', text: '—' });
  });

  it('prefixes amounts with ≈ and falls back to the raw text or 读不出', () => {
    expect(amountView(1_110_000_000, '11.1亿')).toMatchObject({ text: '≈11.1亿', dim: false, title: expect.stringContaining('1,110,000,000') });
    expect(amountView(null, '1?.1亿')).toMatchObject({ text: '1?.1亿', dim: true });
    expect(amountView(null, '')).toMatchObject({ text: '读不出', dim: true });
  });

  it('pages the detail list by 12', () => {
    const list = Array.from({ length: 25 }, (_, i) => i);
    expect(pageOf(list, 1, 12)).toMatchObject({ page: 1, pages: 3, rows: list.slice(0, 12) });
    expect(pageOf(list, 9, 12)).toMatchObject({ page: 3, rows: [24] });
    expect(pageOf([], 1, 12)).toMatchObject({ page: 1, pages: 1, rows: [] });
  });

  it('renders times in Beijing time under America/Los_Angeles', () => {
    process.env.TZ = 'America/Los_Angeles';
    expect(formatCstClock(Date.UTC(2026, 8, 9, 15, 59, 5))).toBe('23:59:05');
  });
});
