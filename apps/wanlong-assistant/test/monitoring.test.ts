import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MatchResult, RawFrame, TemplateSet } from '@avdm/automation';
import { createRuntimeState, type GatherCycleResult } from '@avdm/automation/wanlong';
import type { AutomationRun } from '../src/shared/ipc';
import { CycleFailureTracker } from '../src/main/monitoring/failures';
import { changedCells, frameDigest, FreezeGuard } from '../src/main/monitoring/freeze';
import { probeSpecificScene, RESERVED_ALERT_TEMPLATES } from '../src/main/monitoring/kicked';
import { MonitoringService, type MonitorAlert, type MonitorPorts, type MonitorTarget } from '../src/main/monitoring';

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

async function home(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'avdm-monitoring-'));
  homes.push(directory);
  return directory;
}

function frame(value: number, capturedAt = 0): RawFrame {
  const width = 192;
  const height = 108;
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = value; data[i + 1] = value; data[i + 2] = value; data[i + 3] = 255;
  }
  return { width, height, data, capturedAt };
}

function result(outcome: GatherCycleResult['outcome'], options: { step?: string; dispatched?: number } = {}): GatherCycleResult {
  return {
    outcome, message: outcome === 'error' ? '画面恢复失败' : '本轮完成',
    dispatched: Array.from({ length: options.dispatched ?? 0 }, (_, i) => ({
      at: i, resource: 'wood' as const, coord: null, level: 1, searchFloor: 1,
      storage: null, travelTimeSec: null, troops: null,
    })),
    queue: null, nextWakeAt: null, nextWakeReason: '', captures: 0,
    state: createRuntimeState(), warnings: [],
    ...(outcome === 'error' ? { error: { code: 'STEP_FAILED', message: '恢复失败', detail: options.step ? { step: options.step } : {} } } : {}),
  };
}

function run(id: string, at: number): AutomationRun {
  return {
    runId: id, gameId: 'wanlong', taskId: 'gather-once', index: 1,
    status: 'failed', startedAt: at - 30_000, endedAt: at,
    message: '采集失败', nextWakeAt: null,
  };
}

function set(ids: string[]): TemplateSet {
  return {
    id: 'test', name: '告警', packageName: 'com.example.game', directory: '/tmp/alert-templates',
    refWidth: 2560, refHeight: 1440,
    templates: ids.map((id) => ({ id, name: id, file: `${id}.png`, authoredWidth: 2560, authoredHeight: 1440,
      bounds: { x: 1, y: 1, w: 50, h: 20 }, threshold: 0.85 })),
  };
}

function match(id: string, score: number): MatchResult {
  return { templateId: id, found: score >= 0.85, score, x: 1, y: 1, w: 50, h: 20,
    centerX: 26, centerY: 11, threshold: 0.85, elapsedMs: 1 };
}

function target(overrides: Partial<MonitorTarget> = {}): MonitorTarget {
  return { gameId: 'wanlong', index: 1, packageName: 'com.example.game', instanceIdentity: 'created-1',
    instanceRunning: true, busy: false, ...overrides };
}

describe('failure evidence', () => {
  it('counts only real errors, specializes repeated G0 failure, and resets on normal outcomes', () => {
    const tracker = new CycleFailureTracker();
    expect(tracker.note('wanlong', 1, 'a', result('error', { step: 'G0' }), 0)).toBeNull();
    expect(tracker.note('wanlong', 1, 'b', result('error', { step: 'G0' }), 1)?.kind).toBe('recoveryExhausted');
    expect(tracker.note('wanlong', 1, 'c', result('error'), 2)).toBeNull();
    expect(tracker.note('wanlong', 1, 'd', result('queueFull'), 3)).toBeNull();
    expect(tracker.note('wanlong', 1, 'e', result('error'), 4)).toBeNull();
    expect(tracker.note('wanlong', 1, 'f', result('circuitBroken'), 5)).toBeNull();
    expect(tracker.peek('wanlong', 1)?.failures).toBe(0);
  });

  it('emits a dispatch-stalled warning once per window and resets after a dispatch', () => {
    const tracker = new CycleFailureTracker({ stalledMinutes: 1 });
    expect(tracker.note('wanlong', 1, 'a', result('queueFull'), 0)).toBeNull();
    expect(tracker.note('wanlong', 1, 'b', result('queueFull'), 60_000)?.kind).toBe('dispatchStalled');
    expect(tracker.note('wanlong', 1, 'c', result('queueFull'), 60_001)).toBeNull();
    expect(tracker.note('wanlong', 1, 'd', result('dispatched', { dispatched: 1 }), 61_000)).toBeNull();
    expect(tracker.note('wanlong', 1, 'e', result('queueFull'), 121_000)?.kind).toBe('dispatchStalled');
  });
});

describe('freeze evidence', () => {
  it('requires several nearly identical foreground frames over the full duration', () => {
    const guard = new FreezeGuard({ staticMinutes: 5, minStaticFrames: 4 });
    expect(guard.observe('wanlong', 1, frame(25), 0)).toBeNull();
    expect(guard.observe('wanlong', 1, frame(25), 60_000)).toBeNull();
    expect(guard.observe('wanlong', 1, frame(25), 180_000)).toBeNull();
    expect(guard.observe('wanlong', 1, frame(25), 300_000)?.kind).toBe('static');
    expect(guard.observe('wanlong', 1, frame(25), 360_000)).toBeNull();
    expect(guard.observe('wanlong', 1, frame(220), 420_000)).toBeNull();
    expect(changedCells(frameDigest(frame(25)), frameDigest(frame(220)))).toBeGreaterThan(100);
  });

  it('requires repeated confirmed capture failures, and success clears the streak', () => {
    const guard = new FreezeGuard({ staticMinutes: 1, minCaptureFailures: 3 });
    expect(guard.captureFailed('wanlong', 1, 0)).toBeNull();
    expect(guard.captureFailed('wanlong', 1, 30_000)).toBeNull();
    expect(guard.captureFailed('wanlong', 1, 60_000)?.kind).toBe('capture');
    expect(guard.captureFailed('wanlong', 1, 90_000)).toBeNull();
    guard.observe('wanlong', 1, frame(20), 100_000);
    expect(guard.evidence('wanlong', 1, 100_000).captureFailures).toBe(0);
  });
});

describe('specific scene probes', () => {
  it('silently skips missing templates and requires two high-scoring fresh matches', async () => {
    const testTemplate = vi.fn(async (_game: string, _index: number, id: string) =>
      ({ match: match(id, 0.97), preview: { png: new Uint8Array([137, 80, 78, 71, 0, 0, 0, 0]) } }));
    const ports = { testTemplate, sleep: async () => undefined };
    expect(await probeSpecificScene('wanlong', 1, set([]), ports)).toBeNull();
    expect(testTemplate).not.toHaveBeenCalled();
    const scene = await probeSpecificScene('wanlong', 1, set([RESERVED_ALERT_TEMPLATES.kickedDialog]), ports);
    expect(scene).toMatchObject({ kind: 'suspectedKicked', templateId: RESERVED_ALERT_TEMPLATES.kickedDialog, score: 0.97 });
    expect(testTemplate).toHaveBeenCalledTimes(2);
    testTemplate.mockClear();
    testTemplate.mockResolvedValueOnce({ match: match(RESERVED_ALERT_TEMPLATES.kickedDialog, 0.91), preview: { png: new Uint8Array(8) } });
    expect(await probeSpecificScene('wanlong', 1, set([RESERVED_ALERT_TEMPLATES.kickedDialog]), ports)).toBeNull();
    expect(testTemplate).toHaveBeenCalledTimes(1);
  });
});

describe('monitoring service', () => {
  it('emits confirmed template alerts with private screenshot evidence; absent templates use fallback', async () => {
    const directory = await home();
    const png = await sharp({ create: { width: 24, height: 24, channels: 4, background: '#2a6f93' } }).png().toBuffer();
    const alerts: MonitorAlert[] = [];
    let templates: TemplateSet | null = set([RESERVED_ALERT_TEMPLATES.kickedDialog]);
    const ports: MonitorPorts = {
      targets: async () => [], capture: async () => ({ frame: frame(1), foregroundPackage: 'com.example.game' }),
      templateSet: async () => templates,
      testTemplate: async (_game, _index, id) => ({ match: match(id, 0.98), preview: { png } }),
      onAlert: async (alert) => { alerts.push(alert); }, sleep: async () => undefined,
    };
    const monitor = new MonitoringService(directory, ports);
    await monitor.recordCycle(run('confirmed', 100_000), result('error'));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: 'suspectedKicked', evidence: { templateId: RESERVED_ALERT_TEMPLATES.kickedDialog } });
    const screenshot = alerts[0]!.evidence.screenshotPath!;
    expect(screenshot.startsWith(directory)).toBe(true);
    if (process.platform !== 'win32') expect((await stat(screenshot)).mode & 0o777).toBe(0o600);
    templates = null;
    await monitor.recordCycle(run('fallback-1', 101_000), result('error'));
    await monitor.recordFailure(run('fallback-2', 102_000), new Error('ADB screenshot failed'));
    await monitor.recordCycle(run('fallback-3', 103_000), result('error'));
    expect(alerts.map((alert) => alert.kind)).toEqual(['suspectedKicked', 'consecutiveFailures']);
    await monitor.dispose();
  });

  it('polls enabled targets read-only, skips busy instances, and avoids false capture failure alerts', async () => {
    const directory = await home();
    const alerts: MonitorAlert[] = [];
    let at = 0;
    let state = target();
    let captureFailure = false;
    const ports: MonitorPorts = {
      targets: async () => [state],
      capture: async () => {
        if (captureFailure) throw new Error('foreground changed');
        return { frame: frame(20, at), foregroundPackage: 'com.example.game' };
      },
      classifyCaptureError: () => 'unknown',
      templateSet: async () => null,
      testTemplate: async (_game, _index, id) => ({ match: match(id, 0), preview: { png: new Uint8Array() } }),
      onAlert: async (alert) => { alerts.push(alert); }, now: () => at,
    };
    const monitor = new MonitoringService(directory, ports, { freezeThresholds: { staticMinutes: 5, minStaticFrames: 4 } });
    for (at of [0, 60_000, 180_000, 300_000]) await monitor.pollOnce();
    expect(alerts.map((alert) => alert.kind)).toEqual(['suspectedFreeze']);
    expect(alerts[0]!.evidence.screenshotPath).toBeTruthy();
    state = target({ busy: true });
    at = 360_000;
    await monitor.pollOnce();
    state = target();
    captureFailure = true;
    for (at of [420_000, 480_000, 540_000, 600_000]) await monitor.pollOnce();
    expect(alerts).toHaveLength(1);
    state = target({ instanceIdentity: 'created-2' });
    await monitor.pollOnce();
    expect(monitor.freeze.evidence('wanlong', 1, at).staticFrames).toBe(0);
    await monitor.dispose();
  });
});
