import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRuntimeState, wanlongPlugin, type GatherCycleResult } from '@avdm/automation/wanlong';
import type { ProbeReport } from '@avdm/automation';
import {
  GatherRuntimeStore,
  WanlongGatherRunner,
  type GatherAdbDevice,
  type GatherMainToWorker,
  type GatherManager,
  type GatherWorkerToMain,
} from '../src/main/automation/gather-runner';
import { inspectGatherProbe } from '../src/main/automation/gather-probe-guard';

const PACKAGE = wanlongPlugin.packageName;

function positiveProbe(found = true): ProbeReport {
  return {
    gameId: 'wanlong',
    packageName: PACKAGE,
    foregroundPackage: PACKAGE,
    foregroundMatches: true,
    templateSet: { id: 'private-set', name: 'private', refWidth: 2560, refHeight: 1440 },
    frame: { width: 960, height: 540, capturedAt: 1 },
    matches: [
      ['tpl_world_search_icon', false, 0.20],
      ['tpl_nav_map_toggle', found, found ? 0.94 : 0.20],
      ['tpl_nav_map_toggle_b', false, 0.25],
      ['tpl_panel_title_troop', false, 0.22],
    ].map(([templateId, hit, score]) => ({
      templateId: templateId as string, found: hit as boolean, score: score as number,
      threshold: 0.8, x: 1, y: 1, w: 1, h: 1, centerX: 1, centerY: 1, elapsedMs: 1,
    })),
    timingMs: { capture: 1, prepare: 1, match: 1, total: 3 },
  };
}

function result(outcome: GatherCycleResult['outcome'] = 'queueFull', backoffIndex = 3): GatherCycleResult {
  return {
    outcome,
    message: outcome,
    dispatched: [],
    queue: { used: 5, total: 5 },
    nextWakeAt: null,
    nextWakeReason: 'test',
    captures: 1,
    state: { ...createRuntimeState(), backoffIndex },
    warnings: [],
  };
}

class FakeWorker extends EventEmitter {
  readonly sent: GatherMainToWorker[] = [];
  constructor(private readonly receive: (message: GatherMainToWorker, worker: FakeWorker) => void) { super(); }
  postMessage(message: GatherMainToWorker): void {
    this.sent.push(message);
    queueMicrotask(() => this.receive(message, this));
  }
  emitMessage(message: GatherWorkerToMain): void { this.emit('message', message); }
  async terminate(): Promise<number> { this.emit('exit', 0); return 0; }
}

describe('Wanlong gather probe guard', () => {
  it('accepts one strong known world, city A/B, or troop-panel scene', () => {
    const cases = [
      ['tpl_world_search_icon', 'world-map', 0.978],
      ['tpl_nav_map_toggle', 'city-a', 0.943],
      ['tpl_nav_map_toggle_b', 'city-b', 0.970],
      ['tpl_panel_title_troop', 'troop-panel', 0.997],
    ] as const;
    for (const [id, scene, score] of cases) {
      const probe = positiveProbe(false);
      const match = probe.matches.find((item) => item.templateId === id)!;
      match.found = true;
      match.score = score;
      expect(inspectGatherProbe(probe)).toEqual({ ok: true, scene, score });
    }
  });

  it('rejects cross-scene hits, low confidence, near ties, and incomplete reports', () => {
    const crossScene = positiveProbe();
    crossScene.matches[0].found = true;
    crossScene.matches[0].score = 0.978;
    expect(inspectGatherProbe(crossScene)).toMatchObject({ ok: false, reason: expect.stringContaining('同时命中') });

    const low = positiveProbe();
    low.matches[1].score = 0.89;
    expect(inspectGatherProbe(low)).toMatchObject({ ok: false, reason: expect.stringContaining('最高分') });

    const nearTie = positiveProbe();
    nearTie.matches[2].score = 0.91;
    expect(inspectGatherProbe(nearTie)).toMatchObject({ ok: false, reason: expect.stringContaining('分数接近') });

    const incomplete = positiveProbe();
    incomplete.matches.pop();
    expect(inspectGatherProbe(incomplete)).toMatchObject({ ok: false, reason: expect.stringContaining('不完整') });
  });
});

describe('WanlongGatherRunner', () => {
  let home: string;
  let templateDir: string;
  let foreground: string | undefined;
  let taps: number;
  let adb: GatherAdbDevice;
  let manager: GatherManager;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'avdm-gather-runner-'));
    templateDir = path.join(home, 'selected-templates');
    await mkdir(templateDir);
    foreground = PACKAGE;
    taps = 0;
    adb = {
      screencapRaw: async () => ({ width: 1, height: 1, format: 1, capturedAt: Date.now(), data: new Uint8Array(4) }),
      foregroundPackage: async () => foreground,
      tap: async () => { taps++; },
      swipe: async () => undefined,
      keyevent: async () => undefined,
      startApp: async () => undefined,
      stopApp: async () => undefined,
    };
    manager = {
      getState: async () => ({ status: 'running', record: { createdAt: '2026-09-23T00:00:00.000Z' } }),
      device: async () => adb,
    };
  });

  afterEach(async () => { await rm(home, { recursive: true, force: true }); });

  const options = (dir: string) => ({ templateDir: dir, config: { enabled: true } });

  it('rejects a different foreground package without starting a worker or injecting input', async () => {
    foreground = 'com.android.launcher3';
    let workerCreated = false;
    const runner = new WanlongGatherRunner(manager, home, () => {
      workerCreated = true;
      throw new Error('should not spawn');
    });
    await expect(runner.runOnce(1, options(templateDir))).rejects.toThrow('未处于前台');
    expect(workerCreated).toBe(false);
    expect(taps).toBe(0);
    expect(runner.isRunning(1)).toBe(false);
  });

  it('rejects a worker probe without a positive anchor and releases the instance lease', async () => {
    const worker = new FakeWorker((message, self) => {
      if (message.type === 'start') self.emitMessage({ type: 'ready', probe: positiveProbe(false) });
    });
    const runner = new WanlongGatherRunner(manager, home, () => worker);
    await expect(runner.runOnce(1, options(templateDir))).rejects.toThrow('正锚点');
    expect(taps).toBe(0);
    expect(runner.isRunning(1)).toBe(false);
    expect(worker.sent.some((message) => message.type === 'approved')).toBe(false);
  });

  it('rejects a cross-scene worker report before approving input', async () => {
    const worker = new FakeWorker((message, self) => {
      if (message.type === 'start') {
        const probe = positiveProbe();
        probe.matches[0].found = true;
        probe.matches[0].score = 0.978;
        self.emitMessage({ type: 'ready', probe });
      }
    });
    const runner = new WanlongGatherRunner(manager, home, () => worker);
    await expect(runner.runOnce(1, options(templateDir))).rejects.toThrow('同时命中');
    expect(worker.sent.some((message) => message.type === 'approved')).toBe(false);
    expect(taps).toBe(0);
  });

  it('rechecks the foreground package after worker preflight and before approval', async () => {
    const worker = new FakeWorker((message, self) => {
      if (message.type === 'start') {
        foreground = 'com.android.launcher3';
        self.emitMessage({ type: 'ready', probe: positiveProbe() });
      }
    });
    const runner = new WanlongGatherRunner(manager, home, () => worker);
    await expect(runner.runOnce(1, options(templateDir))).rejects.toThrow('已离开前台');
    expect(worker.sent.some((message) => message.type === 'approved')).toBe(false);
    expect(taps).toBe(0);
  });

  it('denies device input before worker preflight approval', async () => {
    let denied = false;
    const worker = new FakeWorker((message, self) => {
      if (message.type === 'start') self.emitMessage({ type: 'request', id: 1, op: 'tap', args: [20, 30] });
      if (message.type === 'response' && !message.ok) {
        denied = message.error.includes('探针通过前');
        self.emitMessage({ type: 'failed', error: message.error });
      }
    });
    const runner = new WanlongGatherRunner(manager, home, () => worker);
    await expect(runner.runOnce(1, options(templateDir))).rejects.toThrow('探针通过前');
    expect(denied).toBe(true);
    expect(taps).toBe(0);
  });

  it('checks foreground again before approved input, persists the state, and resets it for a new AVD', async () => {
    const starts: Extract<GatherMainToWorker, { type: 'start' }>[] = [];
    const runner = new WanlongGatherRunner(manager, home, () => new FakeWorker((message, self) => {
      if (message.type === 'start') { starts.push(message); self.emitMessage({ type: 'ready', probe: positiveProbe() }); }
      if (message.type === 'approved') self.emitMessage({ type: 'request', id: 1, op: 'tap', args: [20, 30] });
      if (message.type === 'response') {
        if (message.ok) self.emitMessage({ type: 'result', result: result() });
        else self.emitMessage({ type: 'failed', error: message.error });
      }
    }));
    expect((await runner.runOnce(1, options(templateDir))).outcome).toBe('queueFull');
    expect(taps).toBe(1);
    expect(runner.isRunning(1)).toBe(false);
    const store = new GatherRuntimeStore(home);
    expect((await store.load(1, '2026-09-23T00:00:00.000Z')).backoffIndex).toBe(3);
    expect((await store.load(1, 'another-avd')).backoffIndex).toBe(0);
    expect(starts[0].state.backoffIndex).toBe(0);
    if (process.platform !== 'win32') expect((await stat(store.fileFor(1))).mode & 0o777).toBe(0o600);

    foreground = 'com.android.launcher3';
    await expect(runner.runOnce(1, options(templateDir))).rejects.toThrow('未处于前台');
    expect(taps).toBe(1);
  });

  it('prevents overlapping runs and releases the lease after cancellation', async () => {
    let ready!: () => void;
    const approved = new Promise<void>((resolve) => { ready = resolve; });
    const worker = new FakeWorker((message, self) => {
      if (message.type === 'start') self.emitMessage({ type: 'ready', probe: positiveProbe() });
      if (message.type === 'approved') ready();
      if (message.type === 'abort') self.emitMessage({ type: 'result', result: result('cancelled', 4) });
    });
    const runner = new WanlongGatherRunner(manager, home, () => worker);
    const run = runner.runOnce(1, options(templateDir));
    await approved;
    await expect(runner.runOnce(1, options(templateDir))).rejects.toThrow('已有采集任务');
    await runner.stop(1);
    expect((await run).outcome).toBe('cancelled');
    expect(runner.isRunning(1)).toBe(false);
    expect((await new GatherRuntimeStore(home).load(1, '2026-09-23T00:00:00.000Z')).backoffIndex).toBe(4);
  });

  it('waits for an in-flight ADB input before releasing a cancelled run', async () => {
    let releaseTap!: () => void;
    const tapPending = new Promise<void>((resolve) => { releaseTap = resolve; });
    let tapStarted!: () => void;
    const started = new Promise<void>((resolve) => { tapStarted = resolve; });
    adb.tap = async () => { taps++; tapStarted(); await tapPending; };
    const worker = new FakeWorker((message, self) => {
      if (message.type === 'start') self.emitMessage({ type: 'ready', probe: positiveProbe() });
      if (message.type === 'approved') self.emitMessage({ type: 'request', id: 1, op: 'tap', args: [20, 30] });
      if (message.type === 'abort') self.emitMessage({ type: 'result', result: result('cancelled') });
    });
    const runner = new WanlongGatherRunner(manager, home, () => worker);
    const run = runner.runOnce(1, options(templateDir));
    await started;
    let stopped = false;
    const stop = runner.stop(1).then(() => { stopped = true; });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(stopped).toBe(false);
    expect(runner.isRunning(1)).toBe(true);
    await expect(runner.runOnce(1, options(templateDir))).rejects.toThrow('已有采集任务');
    releaseTap();
    await stop;
    expect((await run).outcome).toBe('cancelled');
    expect(taps).toBe(1);
  });

  it('serializes all worker device RPC calls in arrival order', async () => {
    const order: string[] = [];
    let releaseTap!: () => void;
    const tapPending = new Promise<void>((resolve) => { releaseTap = resolve; });
    let tapStarted!: () => void;
    const started = new Promise<void>((resolve) => { tapStarted = resolve; });
    adb.tap = async () => { order.push('tap-start'); tapStarted(); await tapPending; order.push('tap-end'); };
    adb.screencapRaw = async () => {
      order.push('capture');
      return { width: 1, height: 1, format: 1, capturedAt: Date.now(), data: new Uint8Array(4) };
    };
    const worker = new FakeWorker((message, self) => {
      if (message.type === 'start') self.emitMessage({ type: 'ready', probe: positiveProbe() });
      if (message.type === 'approved') {
        self.emitMessage({ type: 'request', id: 1, op: 'tap', args: [20, 30] });
        self.emitMessage({ type: 'request', id: 2, op: 'capture', args: [] });
      }
      if (message.type === 'response' && message.id === 2) self.emitMessage({ type: 'result', result: result() });
    });
    const runner = new WanlongGatherRunner(manager, home, () => worker);
    const run = runner.runOnce(1, options(templateDir));
    await started;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual(['tap-start']);
    releaseTap();
    expect((await run).outcome).toBe('queueFull');
    expect(order).toEqual(['tap-start', 'tap-end', 'capture']);
  });

  it('does not begin a queued write after cancellation', async () => {
    let releaseFirst!: () => void;
    const firstPending = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => { firstStarted = resolve; });
    adb.tap = async () => { taps++; firstStarted(); await firstPending; };
    const worker = new FakeWorker((message, self) => {
      if (message.type === 'start') self.emitMessage({ type: 'ready', probe: positiveProbe() });
      if (message.type === 'approved') {
        self.emitMessage({ type: 'request', id: 1, op: 'tap', args: [20, 30] });
        self.emitMessage({ type: 'request', id: 2, op: 'tap', args: [40, 50] });
      }
      if (message.type === 'abort') self.emitMessage({ type: 'result', result: result('cancelled') });
    });
    const runner = new WanlongGatherRunner(manager, home, () => worker);
    const run = runner.runOnce(1, options(templateDir));
    await started;
    const stop = runner.stop(1);
    releaseFirst();
    await stop;
    expect((await run).outcome).toBe('cancelled');
    expect(taps).toBe(1);
  });

  it('allows only Wanlong launch recovery and verifies that it reaches foreground', async () => {
    foreground = PACKAGE;
    let launches = 0;
    adb.startApp = async (packageName) => {
      expect(packageName).toBe(PACKAGE);
      launches++;
      foreground = PACKAGE;
    };
    const worker = new FakeWorker((message, self) => {
      if (message.type === 'start') self.emitMessage({ type: 'ready', probe: positiveProbe() });
      if (message.type === 'approved') {
        foreground = 'com.android.launcher3';
        self.emitMessage({ type: 'request', id: 1, op: 'launchApp', args: [PACKAGE, false] });
      }
      if (message.type === 'response') {
        if (message.ok) self.emitMessage({ type: 'result', result: result() });
        else self.emitMessage({ type: 'failed', error: message.error });
      }
    });
    const runner = new WanlongGatherRunner(manager, home, () => worker);
    expect((await runner.runOnce(1, options(templateDir))).outcome).toBe('queueFull');
    expect(launches).toBe(1);
    expect(taps).toBe(0);
  });

  it('rejects corrupted persisted state before starting a worker', async () => {
    const store = new GatherRuntimeStore(home);
    await mkdir(path.dirname(store.fileFor(1)), { recursive: true });
    const file = store.fileFor(1);
    await import('node:fs/promises').then((fs) => fs.writeFile(file, '{"version":1,"instanceCreatedAt":"2026-09-23T00:00:00.000Z","state":{"inFlight":"bad"}}'));
    const runner = new WanlongGatherRunner(manager, home, () => { throw new Error('should not spawn'); });
    await expect(runner.runOnce(1, options(templateDir))).rejects.toThrow('状态格式无效');
    expect((await readFile(file, 'utf8')).includes('bad')).toBe(true);
    expect(runner.isRunning(1)).toBe(false);
  });
});
