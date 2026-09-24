import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRuntimeState, type GatherCycleResult } from '@avdm/automation/wanlong';
import type { AutomationRun } from '../src/shared/ipc';
import { InsightsService } from '../src/main/automation/insights';
import { InsightStore } from '../src/main/automation/insights/store';
import { cstDateKey } from '../src/main/automation/insights/stats';

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

  it('keeps failures and automatic pause alerts even when notifications are disabled', async () => {
    const service = new InsightsService(home);
    const now = Date.now();
    await service.recordCycle(run('bad', 1, now), result('error'), 'scheduled');
    await service.recordScheduleStop('wanlong', 1, 8);
    await service.recordScheduleStop('wanlong', 1, 8);
    await service.dispose();
    expect((await service.days('wanlong', 1, 1))[0]).toMatchObject({ cycles: 1, failed: 1, alerts: 2 });
    expect((await service.alerts('wanlong', 1)).map((alert) => alert.kind)).toEqual(['schedulePaused', 'runFailed']);
  });

  it('records a gate pause as a daily warning, not a failed cycle', async () => {
    const service = new InsightsService(home);
    await service.recordSchedulePause('wanlong', 2, '账号「主号」尚未完成登录检查');
    await service.recordSchedulePause('wanlong', 2, '账号「主号」尚未完成登录检查');
    await service.dispose();
    expect((await service.days('wanlong', 2, 1))[0]).toMatchObject({ cycles: 0, failed: 0, alerts: 1 });
    expect((await service.alerts('wanlong', 2))[0]).toMatchObject({
      kind: 'schedulePaused', severity: 'warning', message: expect.stringContaining('不计为失败'),
    });
  });

  it('counts a circuit breaker apart without calling it a failure or raising an alert (original alerts rule 1)', async () => {
    const service = new InsightsService(home);
    await service.recordCycle(run('breaker', 1, Date.now()), result('circuitBroken'), 'scheduled');
    await service.dispose();
    expect((await service.days('wanlong', 1, 1))[0]).toMatchObject({ cycles: 1, failed: 0, succeeded: 1, circuitBreaks: 1, alerts: 0 });
    expect(await service.alerts('wanlong', 1)).toEqual([]);
  });

  it('raises one human-needed pause alert per instance, code and day', async () => {
    const service = new InsightsService(home);
    await service.recordAttentionPause('wanlong', 2, { code: 'GAME_UPDATE_REQUIRED', message: '游戏需要更新资源' });
    await service.recordAttentionPause('wanlong', 2, { code: 'GAME_UPDATE_REQUIRED', message: '游戏需要更新资源' });
    await service.dispose();
    expect(await service.alerts('wanlong', 2)).toMatchObject([
      { kind: 'schedulePaused', severity: 'critical', message: expect.stringContaining('需要人工处理') },
    ]);
  });

  it('persists a read-only monitor finding with evidence only once', async () => {
    const service = new InsightsService(home);
    const finding = {
      id: 'wanlong:1:suspectedFreeze:example', gameId: 'wanlong', index: 1,
      at: Date.now(), kind: 'suspectedFreeze' as const, severity: 'critical' as const,
      message: '画面持续静止，请检查实例',
      evidence: { source: 'frame' as const, runId: null, staticFrames: 5, staticForMs: 300_000 },
    };
    await service.recordMonitorAlert(finding);
    await service.recordMonitorAlert(finding);
    await service.dispose();
    expect(await service.alerts('wanlong', 1)).toMatchObject([{ kind: 'suspectedFreeze', evidence: finding.evidence }]);
    expect((await service.days('wanlong', 1, 1))[0]?.alerts).toBe(1);
  });

  it('stores a masked encrypted token, sends only after opt-in, and cools down duplicates', async () => {
    const fetch = vi.fn(async () => ({ status: 200 }));
    const local = vi.fn(async () => undefined);
    let now = Date.parse('2026-09-23T10:00:00Z');
    const service = new InsightsService(home, {
      codec: {
        encrypt: async (plain) => Buffer.from(plain).toString('base64'),
        decrypt: async (ciphertext) => Buffer.from(ciphertext, 'base64').toString(),
      },
      fetch, showLocal: local, now: () => now,
    });
    const token = '123456789:ABCDEFGHIJKLMNOPQRSTUVWXY1234567890';
    await service.saveConfig('wanlong', 1, { telegram: { botToken: token, chatId: '-1001234567890' } });
    expect((await service.config('wanlong', 1)).telegram).toMatchObject({ enabled: false, botTokenSet: true, botTokenMasked: '••••••••' });
    const configFile = await readFile(path.join(home, 'automation', 'insights', 'notifications.json'), 'utf8');
    expect(configFile).not.toContain(token);

    await service.recordFailure(run('first-failure', 1, now), new Error('画面异常'), 'scheduled');
    await service.dispose();
    expect(fetch).not.toHaveBeenCalled();
    expect(local).not.toHaveBeenCalled();

    await service.saveConfig('wanlong', 1, { localEnabled: true, telegram: { enabled: true, cooldownSeconds: 600 } });
    now += 1_000;
    await service.recordFailure(run('second-failure', 1, now), new Error('画面异常'), 'scheduled');
    await service.dispose();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(local).toHaveBeenCalledTimes(1);
    now += 1_000;
    await service.recordFailure(run('third-failure', 1, now), new Error('画面异常'), 'scheduled');
    await service.dispose();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(local).toHaveBeenCalledTimes(1);

    expect((await service.config('wanlong', 2)).telegram.enabled).toBe(false);
    expect((await service.config('wanlong', 2)).telegram.botTokenSet).toBe(true);
    expect((await service.test('wanlong', 1, 'telegram')).ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
