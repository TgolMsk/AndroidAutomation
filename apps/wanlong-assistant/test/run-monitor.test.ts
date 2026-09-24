import { describe, expect, it } from 'vitest';
import type { LogEntry } from '@avdm/automation/script';
import type { PlanRun, ScriptRunSnapshot } from '../src/main/plans/types';
import { countActiveScriptWork, scriptRunBadge, scriptRunsByInstance, upsertSnapshot } from '../src/renderer/state/plan-runs';
import { LOG_RENDER_WINDOW, LOG_RING_CAPACITY, RunLogBuffer, logEntryKey, logRenderWindow, matchesFilter } from '../src/renderer/state/run-log-store';
import { buildRunRows, coerceParam, defaultParams, formatDuration, hitRate, logClock, progressLabel, shortData } from '../src/renderer/views/runs/run-rows';

const line = (ts: number, extra: Partial<LogEntry> = {}): LogEntry => ({ ts, level: 'info', runId: 'r1', instanceIndex: 1, scope: 'engine', message: `m${ts}`, ...extra });

const snapshot = (runId: string, extra: Partial<ScriptRunSnapshot> = {}): ScriptRunSnapshot => ({
  runId, scriptId: 's', scriptName: '脚本', instanceIndex: 1, accountId: null, accountName: null, status: 'running', startedAt: 100, endedAt: null,
  stepDone: 1, stepTotal: 4, currentStepId: 'b', currentStepName: '点击', iteration: 0, error: null,
  stats: { captures: 10, matches: 10, matchHits: 2, taps: 3, retries: 0, lastTickMs: 300, avgCaptureMs: 280 },
  gameId: 'wanlong', source: 'manual', taskId: null, shotPolicy: 'onFail', maxRunMs: null, ...extra,
});

const planRun = (runId: string, status: PlanRun['status'], extra: Partial<PlanRun> = {}): PlanRun => ({
  runId, gameId: 'wanlong', accountId: 'a', accountName: '账号', instanceIndex: 2, taskId: 't', scriptId: 'daily', priority: 50, status,
  queuedAt: 50, startedAt: null, endedAt: null, message: '等待实例空闲', stepId: null, ...extra,
});

describe('run log ring buffer (original logStore.ts)', () => {
  it('keeps the newest 2000 lines and counts what was pushed out', () => {
    const buffer = new RunLogBuffer();
    buffer.push(Array.from({ length: 2500 }, (_v, i) => line(i)));
    expect(buffer.snapshot()).toHaveLength(LOG_RING_CAPACITY);
    expect(buffer.snapshot()[0]?.ts).toBe(500);
    expect(buffer.counters()).toMatchObject({ total: 2000, received: 2500, dropped: 500 });
  });

  it('merges history without duplicates (ts | runId | message) and in time order', () => {
    const buffer = new RunLogBuffer();
    buffer.push([line(5), line(7)]);
    expect(buffer.mergeHistory([line(1), line(5), line(6)])).toBe(2);
    expect(buffer.snapshot().map((entry) => entry.ts)).toEqual([1, 5, 6, 7]);
    expect(buffer.mergeHistory([line(5)])).toBe(0);
  });

  it('clears one run only, or everything', () => {
    const buffer = new RunLogBuffer();
    buffer.push([line(1), line(2, { runId: 'r2' }), line(3, { level: 'error' }), line(4, { level: 'warn' })]);
    expect(buffer.counters()).toMatchObject({ error: 1, warn: 1 });
    buffer.clear('r1');
    expect(buffer.snapshot().map((entry) => entry.runId)).toEqual(['r2']);
    buffer.clear();
    expect(buffer.counters()).toMatchObject({ total: 0, received: 0 });
  });

  it('renders only the newest window of lines, with keys that survive the ring sliding', () => {
    const buffer = new RunLogBuffer();
    buffer.push(Array.from({ length: LOG_RING_CAPACITY }, (_v, i) => line(i)));
    const first = logRenderWindow(buffer.snapshot());
    expect(first.shown).toHaveLength(LOG_RENDER_WINDOW);
    expect(first.hidden).toBe(LOG_RING_CAPACITY - LOG_RENDER_WINDOW);
    expect(first.shown.at(-1)?.ts).toBe(LOG_RING_CAPACITY - 1);
    // "显示更早的" widens the window; it never exceeds what the ring holds.
    expect(logRenderWindow(buffer.snapshot(), LOG_RENDER_WINDOW).shown).toHaveLength(2 * LOG_RENDER_WINDOW);
    expect(logRenderWindow(buffer.snapshot(), 10 * LOG_RING_CAPACITY)).toMatchObject({ hidden: 0 });
    expect(logRenderWindow([line(1)]).shown).toHaveLength(1);

    const keys = new Map(first.shown.map((entry) => [entry, logEntryKey(entry)]));
    buffer.push([line(LOG_RING_CAPACITY)]);
    const next = logRenderWindow(buffer.snapshot()).shown;
    // The same line objects keep their keys after older lines dropped out, so React reuses those rows.
    for (const entry of next.slice(0, -1)) expect(logEntryKey(entry)).toBe(keys.get(entry));
    expect(new Set(next.map(logEntryKey)).size).toBe(next.length);
  });

  it('filters by run, level, keyword (message / scope / step) and instance', () => {
    const entry = line(1, { level: 'warn', scope: 'runner', stepId: 'tap-go', message: '点中模板' });
    expect(matchesFilter(entry, { runId: 'r1', minLevel: 'warn' })).toBe(true);
    expect(matchesFilter(entry, { minLevel: 'error' })).toBe(false);
    expect(matchesFilter(entry, { keyword: 'TAP-GO' })).toBe(true);
    expect(matchesFilter(entry, { keyword: 'RUNNER' })).toBe(true);
    expect(matchesFilter(entry, { keyword: '模板' })).toBe(true);
    expect(matchesFilter(entry, { runId: 'r2' })).toBe(false);
    expect(matchesFilter(entry, { instanceIndex: 2 })).toBe(false);
  });
});

describe('execution monitor helpers', () => {
  it('maps each instance to its live script run for the instance list and picker badges', () => {
    const map = scriptRunsByInstance([
      snapshot('new', { instanceIndex: 1, status: 'paused', startedAt: 300 }),
      snapshot('old', { instanceIndex: 1, status: 'running', startedAt: 100 }),
      snapshot('done', { instanceIndex: 2, status: 'succeeded' }),
      snapshot('other', { instanceIndex: 3, status: 'stopping' }),
    ]);
    expect([...map.keys()].sort()).toEqual([1, 3]);
    expect(map.get(1)?.runId).toBe('new');
    expect(scriptRunBadge(map.get(1)!)).toBe('脚本已暂停');
    expect(scriptRunBadge(map.get(3)!)).toBe('脚本停止中');
    expect(scriptRunBadge({ status: 'running' })).toBe('脚本运行中');
  });

  it('merges live snapshots with plan records, active first', () => {
    const rows = buildRunRows(
      [planRun('queued-1', 'queued'), planRun('live-1', 'running'), planRun('old', 'skipped', { message: '等待实例超时', queuedAt: 10 })],
      [snapshot('live-1', { source: 'plan', startedAt: 200 }), snapshot('done', { status: 'succeeded', startedAt: 150, endedAt: 160 })],
      (id) => (id === 'daily' ? '日常' : id),
    );
    expect(rows.map((row) => [row.runId, row.status, row.active])).toEqual([
      ['live-1', 'running', true], ['queued-1', 'queued', true], ['done', 'succeeded', false], ['old', 'skipped', false],
    ]);
    expect(rows.find((row) => row.runId === 'queued-1')?.scriptName).toBe('日常');
    expect(rows.find((row) => row.runId === 'old')?.message).toBe('等待实例超时');
  });

  it('never lets a stale running snapshot revive a finished run', () => {
    const finished = snapshot('r', { status: 'aborted', endedAt: 500 });
    expect(upsertSnapshot([finished], snapshot('r', { status: 'running', startedAt: 100 }))[0]?.status).toBe('aborted');
    // A retried plan run (same id, started later) replaces it.
    expect(upsertSnapshot([finished], snapshot('r', { status: 'running', startedAt: 600 }))[0]?.status).toBe('running');
  });

  it('counts active work once even when a plan run is also a live snapshot', () => {
    expect(countActiveScriptWork([planRun('a', 'running'), planRun('b', 'queued'), planRun('c', 'failed')],
      [snapshot('a'), snapshot('manual'), snapshot('done', { status: 'succeeded' })])).toBe(3);
  });

  it('formats durations, hit rates and progress like the original monitor', () => {
    expect(formatDuration(0, 65_000)).toBe('01:05');
    expect(formatDuration(0, 3_725_000)).toBe('1:02:05');
    expect(formatDuration(0, null, 5_000)).toBe('00:05');
    expect(hitRate({ matches: 0, matchHits: 0 })).toBeNull();
    expect(hitRate({ matches: 8, matchHits: 2 })).toBe(25);
    expect(progressLabel(snapshot('p'))).toEqual({ percent: 25, text: '点击' });
    expect(progressLabel(snapshot('p', { stepTotal: null, iteration: 2, stepDone: 3 })).text).toBe('第 3 轮｜已执行 3 步｜点击');
  });

  it('builds the param form values from ScriptParamDef', () => {
    expect(defaultParams([{ key: 'n', label: 'N', type: 'number', default: 3 }, { key: 'x', label: 'X', type: 'string' }])).toEqual({ n: 3 });
    expect(coerceParam({ key: 'n', label: 'N', type: 'number' }, '12')).toBe(12);
    expect(coerceParam({ key: 'n', label: 'N', type: 'number' }, '')).toBeUndefined();
    expect(coerceParam({ key: 'b', label: 'B', type: 'boolean' }, true)).toBe(true);
    expect(coerceParam({ key: 'e', label: 'E', type: 'enum', options: [{ value: 'a', label: 'A' }] }, 'a')).toBe('a');
  });

  it('shows log times in Beijing time with milliseconds and shortens data', () => {
    expect(logClock(Date.UTC(2026, 8, 24, 1, 2, 3, 45))).toBe('09:02:03.045');
    const data = shortData({ text: 'x'.repeat(200) });
    expect(data?.short.length).toBe(91);
    expect(data?.full.length).toBeGreaterThan(200);
  });
});
