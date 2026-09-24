import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScriptRunner, type ScriptExecuteOptions, type ScriptRunnerOptions } from '../src/main/plans/script-runner';
import { attachScriptWorker } from '../src/main/plans/script-worker-core';
import type { ScriptMainToWorker, ScriptWorkerLike, ScriptWorkerToMain } from '../src/main/plans/script-protocol';
import type { RunLogsEvent, ScriptDef, ScriptRunSnapshot } from '../src/main/plans/types';
import { AvdmError } from '@avdm/core';
import { getBuiltinScript } from '@avdm/automation/script';
import { FAST_PACING, PKG, eventually, fakeScriptDevice, fakeVision, inProcessWorkers, writeTemplateSet, type FakeScriptDevice } from './helpers/script-worker';

const RUN = '00000000-0000-4000-8000-0000000000b1';
const script = (steps: ScriptDef['steps'], extra: Partial<ScriptDef> = {}): ScriptDef => ({ id: 'test', name: '测试', version: '1.0.0', packageName: PKG,
  refWidth: 100, refHeight: 100, updatedAt: 0, steps, ...extra });

let home: string;
beforeEach(async () => { home = await mkdtemp(path.join(tmpdir(), 'wanlong-script-runner-')); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

function options(def: ScriptDef, extra: Partial<ScriptExecuteOptions> = {}): ScriptExecuteOptions {
  return {
    runId: RUN, gameId: 'wanlong', packageName: PKG, instanceIndex: 2, instanceIdentity: 'identity-1', script: def, params: {},
    accountId: null, accountName: null, source: 'manual', taskId: null, templateDir: null, shotPolicy: 'onFail', maxRunMs: 60_000, ...extra,
  };
}

function runner(device: FakeScriptDevice, extra: ScriptRunnerOptions = {}, found?: (id: string) => boolean) {
  const workers = inProcessWorkers({ vision: fakeVision(found) });
  const snapshots: ScriptRunSnapshot[] = [];
  const logs: RunLogsEvent[] = [];
  let identity = 'identity-1';
  const instance = { status: 'running' };
  const value = new ScriptRunner(home, {
    instance: async () => ({ status: instance.status, record: { createdAt: identity } }),
    device: async () => device,
  }, {
    workerFactory: workers.factory, pacing: FAST_PACING, foregroundPollMs: 5,
    onSnapshot: (snapshot) => snapshots.push(snapshot), onLogs: (event) => logs.push(event), ...extra,
  });
  return { runner: value, workers, snapshots, logs, replaceInstance: (next: string) => { identity = next; }, instance };
}

/** A scripted worker for protocol-level checks (the real core is exercised through `inProcessWorkers`). */
class FakeWorker extends EventEmitter implements ScriptWorkerLike {
  readonly sent: ScriptMainToWorker[] = [];
  terminated = false;
  constructor(private readonly receive: (message: ScriptMainToWorker, worker: FakeWorker) => void) { super(); }
  postMessage(message: ScriptMainToWorker): void {
    this.sent.push(message);
    queueMicrotask(() => this.receive(message, this));
  }
  emitMessage(message: ScriptWorkerToMain): void { queueMicrotask(() => this.emit('message', message)); }
  async terminate(): Promise<number> { this.terminated = true; return 0; }
}

const finishedSnapshot = (status: ScriptRunSnapshot['status']) => ({
  runId: RUN, scriptId: 'test', scriptName: '测试', instanceIndex: 2, accountId: null, accountName: null, status, startedAt: 1, endedAt: 2,
  stepDone: 1, stepTotal: 1, currentStepId: null, currentStepName: null, iteration: 0, error: null,
  stats: { captures: 0, matches: 0, matchHits: 0, taps: 1, retries: 0, lastTickMs: 0, avgCaptureMs: 0 },
});

describe('ScriptRunner protocol (main side of the worker RPC)', () => {
  it('refuses any device operation before the start gate opens', async () => {
    const device = fakeScriptDevice();
    let replied: ScriptMainToWorker | undefined;
    const worker = new FakeWorker((message, self) => {
      if (message.type === 'start') self.emitMessage({ type: 'request', id: 1, op: 'tap', args: [1, 1] });
      if (message.type === 'response') {
        replied = message;
        self.emitMessage({ type: 'failed', error: '测试结束' });
      }
    });
    const { runner: value } = runner(device, { workerFactory: () => worker });
    const result = await value.execute(options(script([])));
    expect(replied).toMatchObject({ type: 'response', id: 1, ok: false, error: '启动检查通过前禁止操作设备' });
    expect(device.actions).toEqual([]);
    expect(result.status).toBe('failed');
  });

  it('transfers frames as copies and marks guard failures for the engine', async () => {
    const device = fakeScriptDevice();
    const raw = new Uint8Array(200 * 100 * 4).fill(7);
    device.screencapRaw = async () => ({ width: 200, height: 100, data: raw, capturedAt: 1 });
    const replies: ScriptMainToWorker[] = [];
    const worker = new FakeWorker((message, self) => {
      if (message.type === 'start') self.emitMessage({ type: 'ready', templates: 0, refWidth: 100, refHeight: 100, shrink: 2 });
      if (message.type === 'go') self.emitMessage({ type: 'request', id: 1, op: 'capture', args: [] });
      if (message.type === 'response') {
        replies.push(message);
        if (message.id === 1) { device.foreground = 'com.example.other'; self.emitMessage({ type: 'request', id: 2, op: 'tap', args: [3, 3] }); }
        else self.emitMessage({ type: 'finished', snapshot: finishedSnapshot('failed') });
      }
    });
    const { runner: value } = runner(device, { workerFactory: () => worker });
    await value.execute(options(script([])));
    const frame = (replies[0] as Extract<ScriptMainToWorker, { type: 'response'; ok: true }>).value as { data: Uint8Array };
    expect(frame.data).not.toBe(raw);
    expect(Array.from(frame.data.subarray(0, 4))).toEqual([7, 7, 7, 7]);
    expect(replies[1]).toMatchObject({ ok: false, guard: true, error: expect.stringContaining('目标游戏已离开前台') });
    expect(device.actions).toEqual([]);
    expect(worker.terminated).toBe(true);
  });

  it('a worker crash marks the run failed with its message', async () => {
    const worker = new FakeWorker((message, self) => {
      if (message.type === 'start') queueMicrotask(() => self.emit('error', new Error('WASM 内存不足')));
    });
    const { runner: value } = runner(fakeScriptDevice(), { workerFactory: () => worker });
    const result = await value.execute(options(script([])));
    expect(result.status).toBe('failed');
    expect(result.error).toContain('WASM 内存不足');
  });

  it('stop drains in-flight device calls before resolving (the lease is never released under a late tap)', async () => {
    const device = fakeScriptDevice();
    let tapping = false;
    let tapsDone = 0;
    device.tap = async () => { tapping = true; await new Promise((resolve) => setTimeout(resolve, 120)); tapsDone++; tapping = false; };
    const worker = new FakeWorker((message, self) => {
      if (message.type === 'start') self.emitMessage({ type: 'ready', templates: 0, refWidth: 100, refHeight: 100, shrink: 2 });
      if (message.type === 'go') {
        self.emitMessage({ type: 'request', id: 1, op: 'tap', args: [1, 1] });
        self.emitMessage({ type: 'request', id: 2, op: 'tap', args: [2, 2] });
      }
      // Ignore 'stop': the worker is "stuck", so the grace timeout must end it.
    });
    const { runner: value } = runner(device, { workerFactory: () => worker, stopGraceMs: 30 });
    const running = value.execute(options(script([])));
    await eventually(() => tapping);
    await value.stop(RUN);
    const result = await running;
    expect(result.status).toBe('aborted');
    expect(tapsDone).toBe(1); // The in-flight tap finished; the queued one was refused.
    expect(tapping).toBe(false);
    expect(worker.terminated).toBe(true);
    expect(worker.sent.map((message) => message.type)).toEqual(expect.arrayContaining(['stop', 'abort']));
  });

  it('always answers an AI consult: default handled=false, handler errors never escape', async () => {
    const answers: unknown[] = [];
    const makeWorker = () => new FakeWorker((message, self) => {
      if (message.type === 'start') self.emitMessage({ type: 'ready', templates: 0, refWidth: 100, refHeight: 100, shrink: 2 });
      if (message.type === 'go') self.emitMessage({ type: 'aiConsult', requestId: 'ai-1', stepId: 's', reason: '卡住了', expectTemplateIds: ['x'] });
      if (message.type === 'aiResult') { answers.push(message.result); self.emitMessage({ type: 'finished', snapshot: finishedSnapshot('succeeded') }); }
    });
    const first = runner(fakeScriptDevice(), { workerFactory: makeWorker });
    await first.runner.execute(options(script([])));
    expect(answers[0]).toMatchObject({ handled: false, message: expect.stringContaining('没有接入') });

    const failing = runner(fakeScriptDevice(), {
      workerFactory: makeWorker,
      aiAssist: async () => { throw Object.assign(new Error('风险过高'), { code: 'AI_RISK_BLOCKED' }); },
    });
    await failing.runner.execute({ ...options(script([])), runId: '00000000-0000-4000-8000-0000000000b2' });
    expect(answers[1]).toMatchObject({ handled: false, requiresAttention: true });

    const requests: unknown[] = [];
    const handled = runner(fakeScriptDevice(), { workerFactory: makeWorker, aiAssist: async (request) => { requests.push(request); return { handled: true, message: '关掉了' }; } });
    await handled.runner.execute({ ...options(script([], { templateSetId: 'set' })), runId: '00000000-0000-4000-8000-0000000000b3' });
    expect(requests[0]).toMatchObject({ gameId: 'wanlong', instanceIndex: 2, scriptId: 'test', templateSetId: 'set', stepId: 's', expectTemplateIds: ['x'] });
    expect(answers[2]).toEqual({ handled: true, message: '关掉了' });
  });

  it('the main-side run limit ends a run whose thread does not respond, as a time-limit failure', async () => {
    const worker = new FakeWorker((message, self) => {
      if (message.type === 'start') self.emitMessage({ type: 'ready', templates: 0, refWidth: 100, refHeight: 100, shrink: 2 });
      // 'go' and 'stop' are ignored: a blocked event loop never runs the engine's own deadline.
    });
    const ctx = runner(fakeScriptDevice(), { workerFactory: () => worker, deadlineSlackMs: 10, stopGraceMs: 30 });
    const started = Date.now();
    const result = await ctx.runner.execute(options(script([]), { maxRunMs: 40 }));
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('时间上限');
    expect(worker.terminated).toBe(true);
    expect(worker.sent.map((message) => message.type)).toEqual(expect.arrayContaining(['stop', 'abort']));
    expect(ctx.logs.flatMap((event) => event.entries).some((line) => line.message.includes('主进程强制收尾'))).toBe(true);
  });

  it('a stop does not wait for an AI advisor that ignores its abort signal', async () => {
    let seen: AbortSignal | null = null;
    const answers: unknown[] = [];
    const worker = new FakeWorker((message, self) => {
      if (message.type === 'start') self.emitMessage({ type: 'ready', templates: 0, refWidth: 100, refHeight: 100, shrink: 2 });
      if (message.type === 'go') self.emitMessage({ type: 'aiConsult', requestId: 'ai-1', stepId: 's', reason: '卡住了', expectTemplateIds: [] });
      if (message.type === 'aiResult') { answers.push(message.result); self.emitMessage({ type: 'finished', snapshot: finishedSnapshot('aborted') }); }
    });
    const ctx = runner(fakeScriptDevice(), {
      workerFactory: () => worker, stopGraceMs: 5000, aiAbortGraceMs: 20,
      aiAssist: (request) => { seen = request.signal; return new Promise(() => undefined); },
    });
    const running = ctx.runner.execute(options(script([])));
    await eventually(() => seen !== null);
    const started = Date.now();
    await ctx.runner.stop(RUN);
    const result = await running;
    expect(Date.now() - started).toBeLessThan(2000);
    expect(seen!.aborted).toBe(true);
    expect(answers[0]).toMatchObject({ handled: false, message: expect.stringContaining('执行已停止') });
    expect(result.status).toBe('aborted');
  });

  it('reserve makes the instance busy synchronously and blocks a second claim', () => {
    const { runner: value } = runner(fakeScriptDevice());
    const release = value.reserve(4, 'run-a');
    expect(value.runIdOfInstance(4)).toBe('run-a');
    expect(value.activeCount()).toBe(1);
    expect(() => value.reserve(4, 'run-b')).toThrow('实例 #4 上已经有脚本在运行');
    release();
    expect(value.runIdOfInstance(4)).toBeNull();
  });
});

describe('ScriptRunner with the real worker core', () => {
  it('persists batched logs and pushes them, with the run id and instance on every line', async () => {
    const device = fakeScriptDevice();
    const ctx = runner(device);
    const result = await ctx.runner.execute(options(script([{ id: 'a', kind: 'tap', at: { x: 5, y: 5 } }, { id: 'l', kind: 'log', level: 'warn', message: '注意 {{who}}' }]), { params: { who: '甲' } }));
    expect(result.status).toBe('succeeded');
    const lines = (await readFile(path.join(home, 'automation', 'games', 'wanlong', 'runs', RUN, 'events.ndjson'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(lines.some((line) => line.scope === 'script' && line.message === '注意 甲' && line.level === 'warn')).toBe(true);
    expect(lines.every((line) => line.runId === RUN && line.instanceIndex === 2 && typeof line.ts === 'number')).toBe(true);
    if (process.platform !== 'win32') expect((await stat(path.join(home, 'automation', 'games', 'wanlong', 'runs', RUN, 'events.ndjson'))).mode & 0o777).toBe(0o600);
    expect(ctx.logs.flatMap((event) => event.entries).length).toBe(lines.length);
    expect(await ctx.runner.logs.query('wanlong', { runId: RUN, minLevel: 'warn' })).toEqual([expect.objectContaining({ message: '注意 甲' })]);
    expect(ctx.snapshots.at(-1)).toMatchObject({ status: 'succeeded', gameId: 'wanlong', source: 'manual', stepDone: 2 });
  });

  it('saves trace shots from the last frame as private JPEG files readable by the monitor', async () => {
    const device = fakeScriptDevice();
    let captures = 0;
    device.screencapRaw = async () => { captures++; return { width: 64, height: 32, data: new Uint8Array(64 * 32 * 4).fill(90), capturedAt: 1 }; };
    const ctx = runner(device);
    const result = await ctx.runner.execute(options(script([{ id: 'a', kind: 'tap', at: { x: 5, y: 5 } }, { id: 'shot', kind: 'screenshot', label: 'after' }])));
    expect(result.status).toBe('succeeded');
    expect(captures).toBe(1);
    const lines = await ctx.runner.logs.query('wanlong', { runId: RUN });
    const shot = lines.find((line) => line.stepId === 'shot')?.shot;
    expect(shot).toBe(`${RUN}/0001-after.jpg`);
    const bytes = await ctx.runner.logs.readShot('wanlong', RUN, shot!);
    expect((await sharp(Buffer.from(bytes)).metadata()).format).toBe('jpeg');
    if (process.platform !== 'win32') expect((await stat(path.join(home, 'automation', 'games', 'wanlong', 'runs', RUN, 'shots', '0001-after.jpg'))).mode & 0o777).toBe(0o600);
  });

  it('a replaced instance stops the run before the next input', async () => {
    const device = fakeScriptDevice();
    const ctx = runner(device);
    device.tap = async (x, y) => { device.actions.push(`tap:${x},${y}`); ctx.replaceInstance('identity-2'); };
    const result = await ctx.runner.execute(options(script([{ id: 'a', kind: 'tap', at: { x: 5, y: 5 } }, { id: 'b', kind: 'tap', at: { x: 6, y: 6 }, retry: 3, onFail: { kind: 'continue' } }])));
    expect(result.status).toBe('failed');
    expect(result.error).toContain('实例已停止或被替换');
    expect(device.actions).toEqual(['tap:10,5']);
  });

  it('long press is one motionevent shell and launch is limited to the game package', async () => {
    const device = fakeScriptDevice();
    const ctx = runner(device);
    const result = await ctx.runner.execute(options(script([
      { id: 'lp', kind: 'longPress', at: { x: 50, y: 50 }, durationMs: 600 },
      { id: 'other', kind: 'launchApp', packageName: 'com.example.other', onFail: { kind: 'continue' } },
    ])));
    expect(result.status).toBe('succeeded');
    expect(device.shells).toEqual(['input motionevent DOWN 100 50; sleep 0.600; input motionevent UP 100 50']);
    expect(device.actions).toEqual([]);
    const lines = await ctx.runner.logs.query('wanlong', { runId: RUN, minLevel: 'error' });
    expect(lines.some((line) => line.message.includes('禁止启动其他应用'))).toBe(true);
  });

  it('types Chinese only through an enabled ADBKeyboard, otherwise fails the step with guidance', async () => {
    const without = fakeScriptDevice();
    const missing = await runner(without).runner.execute(options(script([{ id: 't', kind: 'text', text: '你好' }])));
    expect(missing.status).toBe('failed');
    expect(missing.error).toContain('ADBKeyboard');
    expect(without.actions).toEqual([]);

    const withIme = fakeScriptDevice({
      shell: async (command) => {
        withIme.shells.push(command);
        if (command.startsWith('pm list packages')) return 'package:com.android.adbkeyboard\n';
        if (command === 'ime list -s') return 'com.android.adbkeyboard/.AdbIME\n';
        if (command.startsWith('settings get secure default_input_method')) return 'com.android.adbkeyboard/.AdbIME\n';
        return '';
      },
    });
    const typed = await runner(withIme).runner.execute({ ...options(script([{ id: 't', kind: 'text', text: '你好' }])), runId: '00000000-0000-4000-8000-0000000000c1' });
    expect(typed.status).toBe('succeeded');
    expect(withIme.shells.at(-1)).toBe(`am broadcast -a ADB_INPUT_B64 --es msg ${Buffer.from('你好').toString('base64')}`);
  });

  it('★ a failed text step never persists the typed text, its base64 or the device serial', async () => {
    const SECRET = 'hunter2%sPw';
    const SERIAL = 'emulator-5554';
    const adbLine = (command: string) => `/sdk/platform-tools/adb -s ${SERIAL} shell ${command}`;
    const failure = (command: string, detail: string) =>
      new AvdmError('COMMAND_FAILED', `${adbLine(command)} 失败: Command failed: ${adbLine(command)}\n${detail}`);
    const reasons: string[] = [];
    const device = fakeScriptDevice({
      text: async (value) => { throw failure(`input text ${value.replace('%s', '%%s')}`, 'error: device offline'); },
    });
    const ctx = runner(device, { aiAssist: async (request) => { reasons.push(request.reason); return { handled: false, message: '未处理' }; } });
    const result = await ctx.runner.execute(options(script([{ id: 'pw', kind: 'text', text: '{{password}}', retry: 1, retryDelayMs: 0 }]), { params: { password: SECRET } }));
    expect(result.status).toBe('failed');
    expect(result.error).toBe(`输入文本失败（${SECRET.length} 字）：模拟器连接已断开`);

    const unicode = '密码是一二三';
    const base64 = Buffer.from(unicode, 'utf8').toString('base64');
    const withIme = fakeScriptDevice({
      shell: async (command) => {
        if (command.startsWith('pm list packages')) return 'package:com.android.adbkeyboard\n';
        if (command === 'ime list -s') return 'com.android.adbkeyboard/.AdbIME\n';
        if (command.startsWith('settings get secure default_input_method')) return 'com.android.adbkeyboard/.AdbIME\n';
        throw failure(command, `Broadcasting: Intent { act=ADB_INPUT_B64 (has extras) } ${base64}\nerror: closed`);
      },
    });
    const imeCtx = runner(withIme);
    const imeResult = await imeCtx.runner.execute({ ...options(script([{ id: 'cn', kind: 'text', text: unicode }])), runId: '00000000-0000-4000-8000-0000000000c2' });
    expect(imeResult.status).toBe('failed');
    expect(imeResult.error).toBe(`输入文本失败（${unicode.length} 字）：模拟器连接已断开`);

    const tapFail = fakeScriptDevice({ tap: async (x, y) => { throw failure(`input tap ${x} ${y}`, 'error: closed'); } });
    const tapCtx = runner(tapFail);
    const tapResult = await tapCtx.runner.execute({ ...options(script([{ id: 't', kind: 'tap', at: { x: 5, y: 5 } }])), runId: '00000000-0000-4000-8000-0000000000c3' });
    expect(tapResult.status).toBe('failed');
    expect(tapResult.error).toContain('adb 命令失败');

    const runsDir = path.join(home, 'automation', 'games', 'wanlong', 'runs');
    const persisted = [
      await readFile(path.join(runsDir, RUN, 'events.ndjson'), 'utf8'),
      await readFile(path.join(runsDir, '00000000-0000-4000-8000-0000000000c2', 'events.ndjson'), 'utf8'),
      await readFile(path.join(runsDir, '00000000-0000-4000-8000-0000000000c3', 'events.ndjson'), 'utf8'),
    ].join('\n');
    const pushed = JSON.stringify([ctx, imeCtx, tapCtx].map((item) => [item.logs, item.snapshots]));
    for (const leak of [SECRET, 'hunter2', unicode, base64, SERIAL, 'input text', 'ADB_INPUT_B64']) {
      expect(persisted).not.toContain(leak);
      expect(pushed).not.toContain(leak);
      expect(JSON.stringify(reasons)).not.toContain(leak);
    }
    expect(reasons).toHaveLength(1);
    expect(persisted).toContain(`输入文本失败（${SECRET.length} 字）`);
  });

  it('the keep-alive example starts with the game off-screen and relaunches it', async () => {
    const dir = await writeTemplateSet(path.join(home, 'set'), ['demo_target']);
    const device = fakeScriptDevice();
    device.foreground = 'com.android.launcher3';
    const keepAlive = getBuiltinScript('builtin_keep_alive', PKG)!;
    const ctx = runner(device, {}, () => true);
    const result = await ctx.runner.execute(options(keepAlive, { templateDir: dir }));
    expect(result.status).toBe('succeeded');
    expect(device.actions).toEqual([`stop:${PKG}`, `start:${PKG}`]);
  });

  it('pause holds the run at the next step boundary and resume continues it', async () => {
    const device = fakeScriptDevice();
    const ctx = runner(device);
    const running = ctx.runner.execute(options(script([{ id: 's', kind: 'sleep', ms: 80 }, { id: 'a', kind: 'tap', at: { x: 5, y: 5 } }])));
    await eventually(() => ctx.runner.get(RUN)?.status === 'running');
    ctx.runner.pause(RUN);
    await eventually(() => ctx.runner.get(RUN)?.status === 'paused');
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(device.actions).toEqual([]);
    ctx.runner.resume(RUN);
    expect((await running).status).toBe('succeeded');
    expect(device.actions).toEqual(['tap:10,5']);
    expect(() => ctx.runner.pause(RUN)).toThrow('已经结束');
  });

  it('fails early, listing templates the instance set does not have', async () => {
    const dir = path.join(home, 'set');
    await mkdir(dir, { recursive: true });
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#808080' } }).png().toBuffer();
    await writeFile(path.join(dir, 'a.png'), png);
    await writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ id: 'set', name: 'S', refWidth: 100, refHeight: 100,
      templates: [{ id: 'a', name: 'A', file: 'a.png', authoredWidth: 100, authoredHeight: 100, bounds: { x: 0, y: 0, w: 8, h: 8 } }] }));
    const ctx = runner(fakeScriptDevice());
    const result = await ctx.runner.execute(options(script([{ id: 'w', kind: 'tapTemplate', templateId: 'missing' }, { id: 'x', kind: 'tapTemplate', templateId: 'a' }]), { templateDir: dir }));
    expect(result.status).toBe('failed');
    expect(result.error).toContain('没有 missing');
  });
});

describe('script worker core', () => {
  it('stops waiting for the AI advisor after 180 s and drops a late answer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const inner = new EventEmitter();
      const out: ScriptWorkerToMain[] = [];
      attachScriptWorker({ on: (event, listener) => inner.on(event, listener), postMessage: (message) => { out.push(message); } },
        { vision: fakeVision(), warmUp: async () => undefined, echoLogs: false });
      const send = (message: ScriptMainToWorker): void => { inner.emit('message', message); };
      send({ type: 'start', input: { runId: RUN, instanceIndex: 2, script: script([{ id: 'a', kind: 'tap', at: { x: 5, y: 5 } }]), params: {},
        accountId: null, accountName: null, templateDir: null, shotPolicy: 'never', maxRunMs: null, consultAi: true, debugMatches: false, ...FAST_PACING } });
      await vi.advanceTimersByTimeAsync(0);
      expect(out.some((message) => message.type === 'ready')).toBe(true);
      send({ type: 'go' });
      const answered = new Set<number>();
      for (let i = 0; i < 50 && !out.some((message) => message.type === 'aiConsult'); i++) {
        for (const message of out) {
          if (message.type !== 'request' || answered.has(message.id)) continue;
          answered.add(message.id);
          if (message.op === 'capture') send({ type: 'response', id: message.id, ok: true, value: { width: 200, height: 100, data: new Uint8Array(200 * 100 * 4), capturedAt: 1 } });
          else send({ type: 'response', id: message.id, ok: false, error: '点击失败' });
        }
        await vi.advanceTimersByTimeAsync(10);
      }
      const consult = out.find((message) => message.type === 'aiConsult') as Extract<ScriptWorkerToMain, { type: 'aiConsult' }>;
      expect(consult).toMatchObject({ stepId: 'a', expectTemplateIds: [] });
      await vi.advanceTimersByTimeAsync(179_000);
      expect(out.some((message) => message.type === 'finished')).toBe(false);
      await vi.advanceTimersByTimeAsync(1_500);
      const finished = out.find((message) => message.type === 'finished') as Extract<ScriptWorkerToMain, { type: 'finished' }>;
      expect(finished.snapshot).toMatchObject({ status: 'failed', error: '点击失败' });
      const logs = out.flatMap((message) => (message.type === 'logs' ? message.entries : []));
      expect(logs.some((line) => line.message.includes('AI 顾问超时没有回应'))).toBe(true);
      const before = out.length;
      send({ type: 'aiResult', requestId: consult.requestId, result: { handled: true, message: '迟到' } });
      await vi.advanceTimersByTimeAsync(100);
      expect(out.slice(before).some((message) => message.type === 'request')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
