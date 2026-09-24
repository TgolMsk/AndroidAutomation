import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRuntimeState, type GatherCycleResult } from '@avdm/automation/wanlong';
import type { AutomationRun } from '../src/shared/ipc';
import { InsightsService } from '../src/main/automation/insights';
import { InsightStore } from '../src/main/automation/insights/store';
import { cstDateKey, shiftDateKey } from '../src/main/automation/insights/stats';

function run(id: string, index: number, endedAt: number): AutomationRun {
  return {
    runId: id, gameId: 'wanlong', taskId: 'gather-once', index, status: 'running',
    startedAt: endedAt - 60_000, endedAt, message: '采集一轮', nextWakeAt: null,
  };
}

function result(outcome: GatherCycleResult['outcome'], dispatches: GatherCycleResult['dispatched'] = []): GatherCycleResult {
  return {
    outcome, message: outcome === 'error' ? '画面校准失败' : '采集完成', dispatched: dispatches,
    queue: null, nextWakeAt: null, nextWakeReason: '', captures: 1,
    state: createRuntimeState(), warnings: [],
  };
}

describe('automation insights', () => {
  let home: string;

  beforeEach(async () => { home = await mkdtemp(path.join(tmpdir(), 'avdm-insights-')); });
  afterEach(async () => { await rm(home, { recursive: true, force: true }); });

  it('records confirmed dispatches once, filters by instance, and labels card storage as an estimate', async () => {
    const service = new InsightsService(home);
    const at = Date.parse('2026-09-23T10:00:00Z');
    const first = run('first', 1, at);
    const cycle = result('dispatched', [
      { at: at - 1_000, resource: 'wood', coord: '1,2', level: 8, searchFloor: 7, storage: 4_500, travelTimeSec: 30, troops: 20 },
      { at: at - 800, resource: 'gold', coord: '3,4', level: 8, searchFloor: 7, storage: null, travelTimeSec: 30, troops: 20 },
    ]);
    await Promise.all([service.recordCycle(first, cycle, 'manual'), service.recordCycle(first, cycle, 'manual')]);
    await service.recordCycle(run('second', 2, at + 1_000), result('queueFull'), 'scheduled');
    const store = new InsightStore(home);
    const onlyOne = (await store.days('wanlong', 1, 1, at))[0]!;
    expect(onlyOne).toMatchObject({ cycles: 1, succeeded: 1, dispatches: 2, estimatedAmount: 4_500, unknownStorageDispatches: 1 });
    expect(onlyOne.byResource.wood).toMatchObject({ dispatches: 1, estimatedAmount: 4_500 });
    expect(onlyOne.byResource.gold).toMatchObject({ dispatches: 1, estimatedAmount: 0, unknownStorageDispatches: 1 });
    expect((await store.days('wanlong', null, 1, at))[0]).toMatchObject({ cycles: 2, dispatches: 2 });
    const file = path.join(home, 'automation', 'insights', 'days', `${cstDateKey(at)}.json`);
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it('uses Beijing dates and attributes a dispatch before midnight to the previous day', async () => {
    const service = new InsightsService(home);
    const dispatchAt = Date.parse('2026-09-23T15:59:59Z');
    const endAt = Date.parse('2026-09-23T16:00:01Z');
    expect(cstDateKey(dispatchAt)).toBe('2026-09-23');
    expect(cstDateKey(endAt)).toBe('2026-09-24');
    await service.recordCycle(run('cross-midnight', 1, endAt), result('dispatched', [
      { at: dispatchAt, resource: 'iron', coord: null, level: 7, searchFloor: 6, storage: 120, travelTimeSec: null, troops: null },
    ]), 'scheduled');
    const store = new InsightStore(home);
    const days = await store.days('wanlong', 1, 2, endAt);
    expect(days).toMatchObject([
      { dateKey: '2026-09-23', cycles: 0, dispatches: 1, estimatedAmount: 120 },
      { dateKey: '2026-09-24', cycles: 1, dispatches: 0 },
    ]);
  });

  it('counts failed runs as cycles only; the ledger holds the alerts module conclusions, idempotent by id', async () => {
    const service = new InsightsService(home);
    const now = Date.now();
    await service.recordCycle(run('bad', 1, now), result('error'), 'scheduled');
    const pause = {
      id: 'wanlong:1:consecutiveFailures:abc', gameId: 'wanlong', index: 1, kind: 'consecutiveFailures' as const,
      severity: 'critical' as const, at: now + 1, message: '连续失败 3 次，已暂停', runId: null,
    };
    expect(await service.recordAlert(pause)).toBe(true);
    expect(await service.recordAlert(pause)).toBe(false);
    await service.dispose();
    await service.recordFailure(run('crash', 1, now + 2), new Error('工作线程崩溃'), 'scheduled');
    // ★ A failed run is no alert (the original alerts only on thresholds): 2 failed cycles, 1 alert.
    expect((await service.days('wanlong', 1, 1))[0]).toMatchObject({ cycles: 2, failed: 2, alerts: 1 });
    expect((await service.alerts('wanlong', 1)).map((alert) => alert.kind)).toEqual(['consecutiveFailures']);
  });

  it('skips a damaged day file when listing alerts instead of failing the whole list', async () => {
    const service = new InsightsService(home);
    const now = Date.now();
    await service.recordAlert({
      id: 'wanlong:1:consecutiveFailures:dmg', gameId: 'wanlong', index: 1, kind: 'consecutiveFailures',
      severity: 'critical', at: now, message: '连续失败 8 次，已暂停', runId: null,
    });
    await service.dispose();
    const yesterday = shiftDateKey(cstDateKey(now), -1);
    await writeFile(path.join(home, 'automation', 'insights', 'days', `${yesterday}.json`), '{broken', 'utf8');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect((await service.alerts('wanlong', 1)).map((alert) => alert.kind)).toEqual(['consecutiveFailures']);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('跳过无法读取的告警日账'), expect.stringContaining(yesterday));
    } finally {
      warn.mockRestore();
    }
  });

  it('notifies alert observers once per newly stored alert (statistics count alert conclusions)', async () => {
    const service = new InsightsService(home);
    const seen: string[] = [];
    const off = service.onAlertStored((alert) => { seen.push(alert.id); });
    service.onAlertStored(() => { throw new Error('观察者出错'); });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const alert = {
        id: 'wanlong:3:deviceOffline:z', gameId: 'wanlong', index: 3, kind: 'deviceOffline' as const,
        severity: 'critical' as const, at: Date.now(), message: '设备掉线', runId: null,
      };
      expect(await service.recordAlert(alert)).toBe(true);
      expect(await service.recordAlert(alert)).toBe(false);
      off();
      await service.recordAlert({ ...alert, id: 'wanlong:3:deviceOffline:z2' });
      expect(seen).toEqual(['wanlong:3:deviceOffline:z']);
    } finally {
      error.mockRestore();
    }
  });

  it('accepts every alert type of the alerts module (incl. deviceOffline / emulatorFrozen) with evidence', async () => {
    const service = new InsightsService(home);
    const at = Date.now();
    await service.recordAlert({
      id: 'wanlong:2:deviceOffline:x', gameId: 'wanlong', index: 2, kind: 'deviceOffline', severity: 'critical',
      at, message: '设备掉线', runId: null,
    });
    await service.recordAlert({
      id: 'wanlong:2:emulatorFrozen:y', gameId: 'wanlong', index: 2, kind: 'emulatorFrozen', severity: 'warning',
      at: at + 1, message: '已自动重启', runId: null,
      evidence: { source: 'frame', runId: null, screenshotPath: 'automation/wanlong/shots/a.jpg' },
    });
    await service.dispose();
    expect(await service.alerts('wanlong', 2)).toMatchObject([
      { kind: 'emulatorFrozen', evidence: { screenshotPath: 'automation/wanlong/shots/a.jpg' } },
      { kind: 'deviceOffline', severity: 'critical' },
    ]);
    expect((await service.days('wanlong', 2, 1))[0]?.alerts).toBe(2);
  });

  it('counts a circuit breaker apart without calling it a failure or raising an alert (original alerts rule 1)', async () => {
    const service = new InsightsService(home);
    await service.recordCycle(run('breaker', 1, Date.now()), result('circuitBroken'), 'scheduled');
    await service.dispose();
    expect((await service.days('wanlong', 1, 1))[0]).toMatchObject({ cycles: 1, failed: 0, succeeded: 1, circuitBreaks: 1, alerts: 0 });
    expect(await service.alerts('wanlong', 1)).toEqual([]);
  });

  it('never writes notification settings any more (they moved to automation/alerts/config.json)', async () => {
    const service = new InsightsService(home);
    await service.recordFailure(run('failure', 1, Date.now()), new Error('画面异常'), 'scheduled');
    await service.dispose();
    await expect(readFile(path.join(home, 'automation', 'insights', 'notifications.json'), 'utf8')).rejects.toThrow();
  });
});
