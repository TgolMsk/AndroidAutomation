import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRuntimeState, wanlongPlugin, type GatherCycleResult } from '@avdm/automation/wanlong';
import { defaultSchedulerConfig } from '@avdm/automation/wanlong/pure';
import type { ProbeReport, RawFrame } from '@avdm/automation';
import {
  GatherRuntimeStore,
  WanlongGatherRunner,
  type GatherAdbDevice,
  type GatherManager,
} from '../src/main/automation/gather-runner';
import { inspectGatherProbe } from '../src/main/automation/gather-probe-guard';
import type { MainToWorker, VisionJobSpec, VisionRequest, WorkerToMain } from '../src/main/scheduler/vision-protocol';
import { AutomationHost } from '../src/main/automation/host';
import { codeOf } from '../src/main/scheduler/errors';
import { InstanceLocks } from '../src/main/scheduler/instance-lock';
import type { ManagerHost } from '../src/main/manager-host';

vi.mock('../src/main/events', () => ({ broadcast: vi.fn() }));

const PACKAGE = wanlongPlugin.packageName;
const CREATED_AT = '2026-09-23T00:00:00.000Z';

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

function frame(): RawFrame {
  return { width: 1, height: 1, format: 1, capturedAt: Date.now(), data: new Uint8Array(4) };
}

type Script = (message: MainToWorker, worker: FakeWorker) => void;

/** Speaks the vision-worker protocol from the worker side; `script` reacts to what main sends. */
class FakeWorker extends EventEmitter {
  readonly sent: MainToWorker[] = [];
  jobId = 0;
  spec: VisionJobSpec | null = null;
  private nextId = 1;
  terminated = false;

  constructor(private readonly script: Script) { super(); }

  postMessage(message: MainToWorker): void {
    this.sent.push(message);
    if (message.type === 'job') { this.jobId = message.jobId; this.spec = message.spec; }
    queueMicrotask(() => this.script(message, this));
  }

  ready(probe = positiveProbe()): void { this.emit('message', { type: 'ready', jobId: this.jobId, probe } satisfies WorkerToMain); }
  request(request: VisionRequest, id = this.nextId++): number {
    this.emit('message', { type: 'request', jobId: this.jobId, id, ...request } as WorkerToMain);
    return id;
  }
  finish(value = result()): void { this.emit('message', { type: 'result', jobId: this.jobId, result: { kind: 'gather', result: value } } satisfies WorkerToMain); }
  fail(message: string, code = 'PROBE_REJECTED'): void {
    this.emit('message', { type: 'failed', jobId: this.jobId, error: { code, message } } as WorkerToMain);
  }
  shot(label: string): void { this.emit('message', { type: 'shot', jobId: this.jobId, label, raw: frame() } satisfies WorkerToMain); }

  sentOf<T extends MainToWorker['type']>(type: T): Extract<MainToWorker, { type: T }>[] {
    return this.sent.filter((message): message is Extract<MainToWorker, { type: T }> => message.type === type);
  }

  async terminate(): Promise<number> { this.terminated = true; this.emit('exit', 0); return 0; }
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
  let taps: Array<[number, number]>;
  let keys: string[];
  let shells: string[];
  let launches: number;
  let adb: GatherAdbDevice;
  let manager: GatherManager;
  let createdAt: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'avdm-gather-runner-'));
    templateDir = path.join(home, 'selected-templates');
    await mkdir(templateDir);
    foreground = PACKAGE;
    taps = [];
    keys = [];
    shells = [];
    launches = 0;
    createdAt = CREATED_AT;
    adb = {
      screencapRaw: async () => frame(),
      foregroundPackage: async () => foreground,
      tap: async (x, y) => { taps.push([x, y]); },
      swipe: async () => undefined,
      keyevent: async (key) => { keys.push(key); },
      startApp: async (pkg) => { expect(pkg).toBe(PACKAGE); launches++; foreground = PACKAGE; },
      stopApp: async () => undefined,
    };
    manager = {
      getState: async () => ({ status: 'running', record: { createdAt } }),
      device: async () => adb,
    };
  });

  afterEach(async () => { await rm(home, { recursive: true, force: true }); });

  const options = (extra: Record<string, unknown> = {}) => ({ templateDir, config: { enabled: true }, ...extra });
  const runnerWith = (script: Script, created: FakeWorker[] = []) =>
    new WanlongGatherRunner(manager, home, {
      workerFactory: () => { const worker = new FakeWorker(script); created.push(worker); return worker; },
    });

  /** Approve, then run `after`, then finish with `value` once every request was answered. */
  const approvedScript = (after: (worker: FakeWorker) => void): Script => (message, worker) => {
    if (message.type === 'job') worker.ready();
    if (message.type === 'approved') after(worker);
    if (message.type === 'denied') worker.fail(message.reason);
  };

  it('refuses a foreground mismatch without a worker when cold start is disallowed', async () => {
    foreground = 'com.android.launcher3';
    let workerCreated = false;
    const runner = new WanlongGatherRunner(manager, home, {
      workerFactory: () => { workerCreated = true; throw new Error('should not spawn'); },
    });
    await expect(runner.runOnce(1, options({ allowColdStart: false }))).rejects.toThrow('未处于前台');
    expect(workerCreated).toBe(false);
    expect(taps).toHaveLength(0);
    expect(runner.isRunning(1)).toBe(false);
  });

  it('cold-starts the game with a monkey launch of its own package before the probe gate (DECISIONS C)', async () => {
    foreground = 'com.android.launcher3';
    let presence: unknown;
    const runner = runnerWith((message, worker) => {
      if (message.type === 'job') worker.request({ op: 'ensureGame', args: [] });
      if (message.type === 'response' && message.ok && presence === undefined) {
        presence = message.value;
        worker.ready();
      }
      if (message.type === 'approved') worker.finish();
    });
    expect((await runner.runOnce(1, options())).outcome).toBe('queueFull');
    expect(presence).toBe('launched');
    expect(launches).toBe(1);
  });

  it('answers a cold-start request with failed and no launch when the job disallows it', async () => {
    let presence: unknown;
    const created: FakeWorker[] = [];
    const runner = runnerWith((message, worker) => {
      if (message.type === 'job') worker.request({ op: 'ensureGame', args: [] });
      if (message.type === 'response' && message.ok) { presence = message.value; worker.fail('没有拉起', 'NOT_FOUND'); }
    }, created);
    // The game is in front for the allowColdStart:false preflight; the worker asks anyway and is refused.
    await expect(runner.runOnce(1, options({ allowColdStart: false }))).rejects.toThrow('没有拉起');
    expect(presence).toBe('failed');
    expect(launches).toBe(0);
    expect(created[0].spec).toMatchObject({ kind: 'gather', allowColdStart: false });
  });

  it('rejects a worker probe without a positive anchor and releases the instance lease', async () => {
    const created: FakeWorker[] = [];
    const runner = runnerWith((message, worker) => {
      if (message.type === 'job') worker.ready(positiveProbe(false));
      if (message.type === 'denied') worker.fail(message.reason);
    }, created);
    await expect(runner.runOnce(1, options())).rejects.toThrow('正锚点');
    expect(taps).toHaveLength(0);
    expect(runner.isRunning(1)).toBe(false);
    expect(created[0].sentOf('approved')).toHaveLength(0);
    expect(runner.locks.held(1)).toBe(false);
  });

  it('rejects a cross-scene worker report before approving input', async () => {
    const created: FakeWorker[] = [];
    const runner = runnerWith((message, worker) => {
      if (message.type === 'job') {
        const probe = positiveProbe();
        probe.matches[0].found = true;
        probe.matches[0].score = 0.978;
        worker.ready(probe);
      }
      if (message.type === 'denied') worker.fail(message.reason);
    }, created);
    await expect(runner.runOnce(1, options())).rejects.toThrow('同时命中');
    expect(created[0].sentOf('approved')).toHaveLength(0);
    expect(taps).toHaveLength(0);
  });

  it('rechecks the foreground package and the AVD identity at approval', async () => {
    const runner = runnerWith((message, worker) => {
      if (message.type === 'job') { foreground = 'com.android.launcher3'; worker.ready(); }
      if (message.type === 'denied') worker.fail(message.reason);
    });
    await expect(runner.runOnce(1, options())).rejects.toThrow('已离开前台');

    foreground = PACKAGE;
    const replaced = runnerWith((message, worker) => {
      if (message.type === 'job') { createdAt = 'another-avd'; worker.ready(); }
      if (message.type === 'denied') worker.fail(message.reason);
    });
    await expect(replaced.runOnce(1, options())).rejects.toThrow('已停止或被替换');
    expect(taps).toHaveLength(0);
  });

  it('denies formal input before approval but allows each whitelisted recovery action once', async () => {
    const answers = new Map<number, { ok: boolean; message?: string }>();
    const ids: Record<string, number> = {};
    const runner = runnerWith((message, worker) => {
      if (message.type === 'job') {
        ids.plain = worker.request({ op: 'tap', args: [20, 30] });
        ids.popup = worker.request({ op: 'tap', args: [2400, 100, 'closePopup'] });
        ids.popup2 = worker.request({ op: 'tap', args: [2400, 100, 'closePopup'] });
        ids.back = worker.request({ op: 'key', args: ['BACK', 'probeBack'] });
        ids.back2 = worker.request({ op: 'key', args: ['BACK', 'probeBack'] });
        ids.home = worker.request({ op: 'key', args: ['HOME', 'probeBack'] });
        ids.cancel = worker.request({ op: 'tap', args: [1000, 900, 'exitCancel'] });
        ids.many = worker.request({ op: 'tapMany', args: [[[1, 2]], 0] });
        ids.swipe = worker.request({ op: 'swipe', args: [1, 2, 3, 4, 100] });
        ids.launch = worker.request({ op: 'launchApp', args: [PACKAGE, false] });
      }
      if (message.type === 'response') {
        answers.set(message.id, message.ok ? { ok: true } : { ok: false, message: message.error.message });
        if (answers.size === Object.keys(ids).length) worker.fail('stop here', 'CANCELLED');
      }
    });
    await expect(runner.runOnce(1, options())).rejects.toThrow('stop here');
    expect(answers.get(ids.plain)).toMatchObject({ ok: false, message: expect.stringContaining('探针通过前') });
    expect(answers.get(ids.popup)).toEqual({ ok: true });
    expect(answers.get(ids.popup2)).toMatchObject({ ok: false, message: expect.stringContaining('次数已用完') });
    expect(answers.get(ids.back)).toEqual({ ok: true });
    expect(answers.get(ids.back2)).toMatchObject({ ok: false });
    expect(answers.get(ids.home)).toMatchObject({ ok: false, message: expect.stringContaining('探针通过前') });
    expect(answers.get(ids.cancel)).toEqual({ ok: true });
    for (const id of [ids.many, ids.swipe, ids.launch]) expect(answers.get(id)).toMatchObject({ ok: false, message: expect.stringContaining('探针通过前') });
    expect(taps).toEqual([[2400, 100], [1000, 900]]);
    expect(keys).toEqual(['BACK']);
  });

  it('never lets a whitelisted action through when the game left the foreground', async () => {
    foreground = PACKAGE;
    let answer: { ok: boolean; message?: string } | undefined;
    const runner = runnerWith((message, worker) => {
      if (message.type === 'job') { foreground = 'com.android.launcher3'; worker.request({ op: 'tap', args: [5, 5, 'closePopup'] }); }
      if (message.type === 'response') {
        answer = message.ok ? { ok: true } : { ok: false, message: message.error.message };
        worker.fail('done', 'CANCELLED');
      }
    });
    await expect(runner.runOnce(1, options())).rejects.toThrow('done');
    expect(answer).toMatchObject({ ok: false, message: expect.stringContaining('已离开前台') });
    expect(taps).toHaveLength(0);
  });

  it('refuses a gather result that skipped the probe gate', async () => {
    const runner = runnerWith((message, worker) => { if (message.type === 'job') worker.finish(); });
    await expect(runner.runOnce(1, options())).rejects.toThrow('越过探针门槛');
  });

  it('checks foreground again before approved input, persists the state, and resets it for a new AVD', async () => {
    const created: FakeWorker[] = [];
    const combined = runnerWith((message, worker) => {
      approvedScript((w) => {
        // The second cycle: the game leaves the foreground between approval and the tap.
        if (w.sentOf('approved').length === 2) foreground = 'com.android.launcher3';
        w.request({ op: 'tap', args: [20, 30] });
      })(message, worker);
      if (message.type === 'response') {
        if (message.ok) worker.finish();
        else worker.fail(message.error.message, 'NOT_FOUND');
      }
    }, created);
    expect((await combined.runOnce(1, options())).outcome).toBe('queueFull');
    expect(taps).toEqual([[20, 30]]);
    expect(combined.isRunning(1)).toBe(false);
    const store = new GatherRuntimeStore(home);
    expect((await store.load(1, CREATED_AT)).backoffIndex).toBe(3);
    expect((await store.load(1, 'another-avd')).backoffIndex).toBe(0);
    const spec = created[0].spec;
    expect(spec?.kind).toBe('gather');
    if (spec?.kind === 'gather') {
      expect(spec.state.backoffIndex).toBe(0);
      expect(spec.templateDir).toBe(await import('node:fs/promises').then((fs) => fs.realpath(templateDir)));
    }
    if (process.platform !== 'win32') expect((await stat(store.fileFor(1))).mode & 0o777).toBe(0o600);

    // Same worker (long-lived, templates compiled once); the approved tap now meets a foreign foreground.
    await expect(combined.runOnce(1, options())).rejects.toThrow('已离开前台');
    expect(taps).toHaveLength(1);
    expect(created).toHaveLength(1);
  });

  it('keeps one long-lived worker per instance and forwards template invalidation', async () => {
    const created: FakeWorker[] = [];
    const runner = runnerWith(approvedScript((worker) => worker.finish()), created);
    await runner.runOnce(1, options());
    await runner.runOnce(1, options());
    await runner.runOnce(2, options());
    expect(created).toHaveLength(2);
    runner.invalidateTemplates();
    expect(created.every((worker) => worker.sentOf('invalidate').length === 1)).toBe(true);
    await runner.dispose();
    expect(created.every((worker) => worker.terminated)).toBe(true);
  });

  it('sends a batched tapMany as one shell command per 32 taps', async () => {
    adb.shell = async (command) => { shells.push(command); return ''; };
    const points: Array<[number, number]> = Array.from({ length: 33 }, (_, i) => [100 + i, 200.4]);
    const runner = runnerWith((message, worker) => {
      approvedScript((w) => w.request({ op: 'tapMany', args: [points, 50] }))(message, worker);
      if (message.type === 'response') worker.finish();
    });
    await runner.runOnce(1, options());
    expect(shells).toHaveLength(2);
    expect(shells[0].split('input tap')).toHaveLength(33);
    expect(shells[0].startsWith('input tap 100 200; sleep 0.050; input tap 101 200')).toBe(true);
    expect(shells[1]).toBe('input tap 132 200');
    expect(taps).toHaveLength(0);
  });

  it('prevents overlapping runs and releases the lease after cancellation', async () => {
    let ready!: () => void;
    const approved = new Promise<void>((resolve) => { ready = resolve; });
    const runner = runnerWith((message, worker) => {
      if (message.type === 'job') worker.ready();
      if (message.type === 'approved') ready();
      if (message.type === 'abort') worker.finish(result('cancelled', 4));
    });
    const run = runner.runOnce(1, options());
    await approved;
    await expect(runner.runOnce(1, options())).rejects.toThrow('已有采集任务');
    await runner.stop(1);
    expect((await run).outcome).toBe('cancelled');
    expect(runner.isRunning(1)).toBe(false);
    expect(runner.locks.held(1)).toBe(false);
    expect((await new GatherRuntimeStore(home).load(1, CREATED_AT)).backoffIndex).toBe(4);
  });

  it('waits for an in-flight ADB input before releasing a cancelled run', async () => {
    let releaseTap!: () => void;
    const tapPending = new Promise<void>((resolve) => { releaseTap = resolve; });
    let tapStarted!: () => void;
    const started = new Promise<void>((resolve) => { tapStarted = resolve; });
    adb.tap = async (x, y) => { taps.push([x, y]); tapStarted(); await tapPending; };
    const runner = runnerWith((message, worker) => {
      approvedScript((w) => w.request({ op: 'tap', args: [20, 30] }))(message, worker);
      if (message.type === 'abort') worker.finish(result('cancelled'));
    });
    const run = runner.runOnce(1, options());
    await started;
    let stopped = false;
    const stop = runner.stop(1).then(() => { stopped = true; });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(stopped).toBe(false);
    expect(runner.isRunning(1)).toBe(true);
    await expect(runner.runOnce(1, options())).rejects.toThrow('已有采集任务');
    releaseTap();
    await stop;
    expect((await run).outcome).toBe('cancelled');
    expect(taps).toHaveLength(1);
  });

  it('serializes all worker device RPC calls in arrival order', async () => {
    const order: string[] = [];
    let releaseTap!: () => void;
    const tapPending = new Promise<void>((resolve) => { releaseTap = resolve; });
    let tapStarted!: () => void;
    const started = new Promise<void>((resolve) => { tapStarted = resolve; });
    adb.tap = async () => { order.push('tap-start'); tapStarted(); await tapPending; order.push('tap-end'); };
    adb.screencapRaw = async () => { order.push('capture'); return frame(); };
    let captureId = 0;
    const runner = runnerWith((message, worker) => {
      approvedScript((w) => { w.request({ op: 'tap', args: [20, 30] }); captureId = w.request({ op: 'capture', args: [] }); })(message, worker);
      if (message.type === 'response' && message.id === captureId) worker.finish();
    });
    const run = runner.runOnce(1, options());
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
    adb.tap = async (x, y) => { taps.push([x, y]); firstStarted(); await firstPending; };
    const runner = runnerWith((message, worker) => {
      approvedScript((w) => { w.request({ op: 'tap', args: [20, 30] }); w.request({ op: 'tap', args: [40, 50] }); })(message, worker);
      if (message.type === 'abort') worker.finish(result('cancelled'));
    });
    const run = runner.runOnce(1, options());
    await started;
    const stop = runner.stop(1);
    releaseFirst();
    await stop;
    expect((await run).outcome).toBe('cancelled');
    expect(taps).toHaveLength(1);
  });

  it('allows only the game package for approved launches and verifies that it reaches foreground', async () => {
    const answers: boolean[] = [];
    const runner = runnerWith((message, worker) => {
      approvedScript((w) => {
        foreground = 'com.android.launcher3';
        w.request({ op: 'launchApp', args: ['com.other.app', false] });
        w.request({ op: 'launchApp', args: [PACKAGE, false] });
      })(message, worker);
      if (message.type === 'response') {
        answers.push(message.ok);
        if (answers.length === 2) worker.finish();
      }
    });
    expect((await runner.runOnce(1, options())).outcome).toBe('queueFull');
    expect(answers).toEqual([false, true]);
    expect(launches).toBe(1);
    expect(taps).toHaveLength(0);
  });

  it('saves failure shots by policy, runs the kicked probe once and reports the facts', async () => {
    const saved: string[] = [];
    const probeKicked = vi.fn(async () => ({ type: 'kicked', reason: '账号在别处登录', templateId: 'tpl_kicked', score: 0.93 }));
    const runner = runnerWith(approvedScript((worker) => {
      worker.shot('g0-unknown-1');
      worker.shot('g0-failed');
      worker.shot('cycle-error');
      worker.finish({ ...result('error'), error: { code: 'STEP_FAILED', message: 'G0 失败', detail: { step: 'G0' } } } as GatherCycleResult);
    }));
    const outcome = await runner.runOnce(1, options({
      shotPolicy: 'onFail',
      saveShot: async (label: string) => { saved.push(label); return `automation/wanlong/shots/inst1-${label}.jpg`; },
      probeKicked,
    }));
    expect(saved).toEqual(['g0-failed', 'cycle-error']);
    expect(probeKicked).toHaveBeenCalledTimes(1);
    expect(outcome.fact).toMatchObject({
      outcome: 'error', step: 'G0', errorCode: 'STEP_FAILED', shotPath: 'automation/wanlong/shots/inst1-g0-failed.jpg',
      kicked: { type: 'kicked', templateId: 'tpl_kicked' },
    });
  });

  it('does not fail a cycle when the state or a shot cannot be saved', async () => {
    const spy = vi.spyOn(GatherRuntimeStore.prototype, 'save').mockRejectedValue(new Error('磁盘满了'));
    try {
      const logs: string[] = [];
      const runner = runnerWith(approvedScript((worker) => { worker.shot('cycle-error'); worker.finish(); }));
      const outcome = await runner.runOnce(1, options({
        saveShot: async () => { throw new Error('写不进去'); },
        log: (_level: string, message: string) => logs.push(message),
      }));
      expect(outcome.outcome).toBe('queueFull');
      expect(outcome.warnings.join('\n')).toContain('磁盘满了');
      expect(logs.join('\n')).toContain('写不进去');
    } finally {
      spy.mockRestore();
    }
  });

  it('ends a timed-out cycle as cancelled with its state intact', async () => {
    const runner = runnerWith((message, worker) => {
      if (message.type === 'job') worker.ready();
      if (message.type === 'abort') worker.finish(result('cancelled', 2));
    });
    const outcome = await runner.runOnce(1, options({ timeoutMs: 1000 }));
    expect(outcome.outcome).toBe('cancelled');
    expect((await new GatherRuntimeStore(home).load(1, CREATED_AT)).backoffIndex).toBe(2);
  });

  it('reports a device that cannot be resolved to onCaptureFailed before any frame (freeze watchdog)', async () => {
    const failures: unknown[] = [];
    manager.getState = async () => { throw Object.assign(new Error('adb 命令超时'), { code: 'ADB_TIMEOUT' }); };
    const created: FakeWorker[] = [];
    const runner = runnerWith(() => undefined, created);
    await expect(runner.sample(1, {
      templateDir, config: defaultSchedulerConfig(), deadlineAt: Date.now() + 60_000, signal: new AbortController().signal,
      allowColdStart: false, onCaptureFailed: (error) => { failures.push(error); },
    })).rejects.toThrow('adb 命令超时');
    expect(failures.map(codeOf)).toEqual(['ADB_TIMEOUT']);
    expect(created).toHaveLength(0);
  });

  it('refuses a scheduled cycle\'s device requests once auto scheduling is switched off (reliability check)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const locks = new InstanceLocks(home, { fileLock: async (_path, fn) => fn() });
    let approved!: () => void;
    const gatherApproved = new Promise<void>((resolve) => { approved = resolve; });
    let lateTap: { ok: boolean } | null = null;
    let tapId = -1;
    const runner = new WanlongGatherRunner(manager, home, {
      locks,
      workerFactory: () => new FakeWorker((message, worker) => {
        if (message.type === 'job' && message.spec.kind === 'sample') {
          worker.emit('message', { type: 'result', jobId: worker.jobId, result: { kind: 'sample', sample: {
            sampledAt: Date.now(), queueUsed: 2, queueTotal: 5, rows: [], warnings: [],
          } } } satisfies WorkerToMain);
        } else if (message.type === 'job') {
          worker.ready();
        } else if (message.type === 'approved') {
          approved();
        } else if (message.type === 'abort') {
          // The session keeps going for a moment after the stop: its next tap must be refused by main.
          tapId = worker.request({ op: 'tap', args: [20, 30] });
        } else if (message.type === 'response' && message.id === tapId) {
          lateTap = { ok: message.ok };
          worker.finish(result('cancelled'));
        }
      }),
    });
    const host = new AutomationHost({ get: async () => manager } as unknown as ManagerHost, home, runner, undefined, {}, {
      locks, scheduler: { ownerLease: false, random: () => 0 },
    });
    vi.spyOn(host, 'probe').mockResolvedValue({ launchReady: true, launchReason: '已确认世界地图画面' } as never);
    try {
      await host.saveSettings('wanlong', 1, { templateDir, config: { version: 2, enabled: true } });
      expect((await host.setSchedule('wanlong', 1, true)).enabled).toBe(true);
      await vi.advanceTimersByTimeAsync(30_000);
      await gatherApproved;
      expect((await host.setSchedule('wanlong', 1, false)).enabled).toBe(false);
      await vi.waitFor(() => expect(lateTap).not.toBeNull());
      expect(lateTap).toEqual({ ok: false });
      expect(taps).toEqual([]);
      await vi.waitFor(async () => expect((await host.runs())[0]?.status).toBe('cancelled'));
      expect(host.eta.listWakes()).toEqual([]);
    } finally {
      await host.dispose();
      vi.useRealTimers();
    }
  });

  it('rejects corrupted persisted state before starting a worker', async () => {
    const store = new GatherRuntimeStore(home);
    await mkdir(path.dirname(store.fileFor(1)), { recursive: true });
    const file = store.fileFor(1);
    await writeFile(file, `{"version":1,"instanceCreatedAt":"${CREATED_AT}","state":{"inFlight":"bad"}}`);
    const runner = new WanlongGatherRunner(manager, home, { workerFactory: () => { throw new Error('should not spawn'); } });
    await expect(runner.runOnce(1, options())).rejects.toThrow('状态格式无效');
    expect((await readFile(file, 'utf8')).includes('bad')).toBe(true);
    expect(runner.isRunning(1)).toBe(false);
  });
});

describe('GatherRuntimeStore', () => {
  let home: string;
  beforeEach(async () => { home = await mkdtemp(path.join(tmpdir(), 'avdm-gather-store-')); });
  afterEach(async () => { await rm(home, { recursive: true, force: true }); });

  it('drops half and legacy level memory instead of failing the load', async () => {
    const store = new GatherRuntimeStore(home);
    await mkdir(path.dirname(store.fileFor(3)), { recursive: true });
    const state = {
      ...createRuntimeState(),
      maxLevel: 8, maxLevelProbedAt: 1,
      levelByResource: {
        wood: { maxLevel: 10, probedAt: 1000, noResultFloor: 9, noResultAt: 2000 },
        gold: { maxLevel: 7 },
        mana: 'broken',
      },
    };
    await writeFile(store.fileFor(3), JSON.stringify({ version: 1, instanceCreatedAt: CREATED_AT, state }));
    const loaded = await store.load(3, CREATED_AT);
    expect(loaded.levelByResource).toEqual({ wood: { maxLevel: 10, probedAt: 1000, noResultFloor: 9, noResultAt: 2000 } });
    expect('maxLevel' in loaded).toBe(false);

    const { levelByResource: _dropped, ...withoutMemory } = createRuntimeState();
    void _dropped;
    await writeFile(store.fileFor(3), JSON.stringify({ version: 1, instanceCreatedAt: CREATED_AT, state: withoutMemory }));
    expect((await store.load(3, CREATED_AT)).levelByResource).toEqual({});
  });

  it('serializes 32 concurrent saves of one instance and leaves no temp files', async () => {
    const store = new GatherRuntimeStore(home);
    await Promise.all(Array.from({ length: 32 }, (_, i) => store.save(4, CREATED_AT, { ...createRuntimeState(), backoffIndex: i })));
    expect((await store.load(4, CREATED_AT)).backoffIndex).toBe(31);
    expect((await readdir(path.dirname(store.fileFor(4)))).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
});
