import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withFileLock } from '@avdm/core';
import { readLeaseOwner, type LeaseOwner } from '../src/main/app/instance-access';
import { AppSettingsStore } from '../src/main/app/settings-store';
import { PlanService, ScriptRunner } from '../src/main/plans';
import type { GameAccount } from '../src/main/automation/accounts/types';
import type { PlanHostPort, ScriptDef, ScriptRunSnapshot } from '../src/main/plans/types';
import { FAST_PACING, fakeScriptDevice, fakeVision, inProcessWorkers, writeTemplateSet } from './helpers/script-worker';

const GAME = 'wanlong';
const PKG = 'com.lilithgames.samo.android.cn';
const ACCOUNT = '00000000-0000-4000-8000-000000000001';
const account: GameAccount = { id: ACCOUNT, gameId: GAME, packageName: PKG, name: '测试账号', server: '', role: '', note: '',
  enabled: true, binding: { index: 1, instanceCreatedAt: 'identity-1' }, login: { status: 'ready', attemptId: null, verifiedAt: 1 },
  createdAt: 1, updatedAt: 1 };
const script: ScriptDef = { id: 'tap-once', name: '点击一次', version: '1.0.0', packageName: PKG, refWidth: 100, refHeight: 100,
  updatedAt: 0, steps: [{ id: 'tap-1', kind: 'tap', at: { x: 50, y: 50 } }] };

async function eventually(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('运行未在 1 秒内结束');
}

describe('PlanService integration with fake device', () => {
  const homes: string[] = [];
  const services: PlanService[] = [];
  afterEach(async () => {
    await Promise.all(services.splice(0).map((service) => service.shutdown()));
    await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
  });

  async function setup(tap?: (x: number, y: number) => Promise<void>) {
    const home = await mkdtemp(path.join(tmpdir(), 'wanlong-plan-service-'));
    homes.push(home);
    const actions: string[] = [];
    const port: PlanHostPort = {
      accounts: async () => [account],
      instance: async () => ({ status: 'running', record: { createdAt: 'identity-1' } }),
      templateDir: async () => '',
      device: async () => ({
        screencapRaw: async () => ({ width: 200, height: 200, data: new Uint8Array(200 * 200 * 4), capturedAt: Date.now() }),
        screencapPng: async () => new Uint8Array([1]),
        foregroundPackage: async () => PKG,
        tap: async (x, y) => { actions.push(`${x},${y}`); await tap?.(x, y); },
        swipe: async () => undefined,
        keyevent: async () => undefined,
        text: async () => undefined,
        startApp: async () => undefined,
        stopApp: async () => undefined,
        shell: async () => '',
      }),
    };
    const snapshots: ScriptRunSnapshot[] = [];
    const runner = new ScriptRunner(home, port, {
      workerFactory: inProcessWorkers({ vision: fakeVision() }).factory, pacing: FAST_PACING, foregroundPollMs: 5,
      onSnapshot: (snapshot) => snapshots.push(snapshot),
    });
    const service = new PlanService(home, port, runner, { manualLeaseWaitMs: 300 });
    services.push(service);
    await service.start(GAME);
    await service.saveScript(GAME, script);
    await service.savePlan(GAME, { accountId: ACCOUNT, enabled: false, updatedAt: 0,
      tasks: [{ id: 'task-1', scriptId: script.id, enabled: true, trigger: { kind: 'manual' }, priority: 50, maxRunMinutes: 1 }] });
    return { service, actions, home, port, snapshots, runner };
  }

  const endedSnapshot = (extra: Partial<ScriptRunSnapshot>): ScriptRunSnapshot => ({
    runId: 'x', scriptId: script.id, scriptName: script.name, instanceIndex: 1, accountId: ACCOUNT, accountName: '测试账号', status: 'failed',
    startedAt: 1, endedAt: 2, stepDone: 0, stepTotal: null, currentStepId: null, currentStepName: null, iteration: 0, error: null,
    stats: { captures: 0, matches: 0, matchHits: 0, taps: 0, retries: 0, lastTickMs: 0, avgCaptureMs: 0 },
    gameId: GAME, source: 'plan', taskId: 'task-1', shotPolicy: 'onFail', maxRunMs: 60_000, ...extra,
  });

  it('never retries a run its time limit ended (original: a stopped plan run is not retried)', async () => {
    const { service, runner } = await setup();
    await service.saveConfig(GAME, { retry: 2, retryDelayMs: 0 });
    const run = vi.spyOn(runner, 'run').mockImplementation(async (options) => endedSnapshot({
      runId: options.runId, status: 'failed', timedOut: true, error: '脚本运行超过本次时间上限（1 分钟），已停止。',
    }));
    const queued = await service.runNow(GAME, ACCOUNT, 'task-1');
    await eventually(async () => (await service.overview(GAME)).runs.find((row) => row.runId === queued.runId)?.status === 'failed');
    expect(run).toHaveBeenCalledTimes(1);
    expect((await service.overview(GAME)).runs.find((row) => row.runId === queued.runId)?.message).toContain('时间上限');

    // Without the time limit the same failure is retried as configured: each retry is a new attempt of the round,
    // queued again after the instance was released (original re-enqueue model).
    run.mockImplementation(async (options) => endedSnapshot({ runId: options.runId, status: 'failed', error: '没找到模板' }));
    await service.runNow(GAME, ACCOUNT, 'task-1');
    await eventually(async () => run.mock.calls.length === 4 && !service.isActiveForInstance(1) &&
      (await service.overview(GAME)).tasks[0]?.holdUntil === null);
    const attempts = (await service.overview(GAME)).runs.slice(0, 3);
    expect(attempts.map((row) => [row.attempt, row.status])).toEqual([[3, 'failed'], [2, 'failed'], [1, 'failed']]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(run).toHaveBeenCalledTimes(4);
  });

  it('a loop script that ran its time limit out is recorded as done, not failed', async () => {
    const { service, runner } = await setup();
    await service.saveConfig(GAME, { retry: 1, retryDelayMs: 0 });
    await service.saveScript(GAME, { ...script, loop: true, loopIntervalMs: 1000 });
    const run = vi.spyOn(runner, 'run').mockImplementation(async (options) => endedSnapshot({
      runId: options.runId, status: 'succeeded', timedOut: true, iteration: 3,
    }));
    const queued = await service.runNow(GAME, ACCOUNT, 'task-1');
    await eventually(async () => (await service.overview(GAME)).runs.find((row) => row.runId === queued.runId)?.status === 'succeeded');
    expect(run).toHaveBeenCalledTimes(1);
    expect((await service.overview(GAME)).runs.find((row) => row.runId === queued.runId)?.message).toContain('按时结束（完成 3 轮）');
  });

  it('runs without an explicit shot policy follow the app settings (app-settings.json, then saved changes)', async () => {
    const { service, runner, port, home } = await setup();
    await mkdir(path.join(home, 'automation'), { recursive: true });
    await writeFile(path.join(home, 'automation', 'app-settings.json'), JSON.stringify({ version: 1, shotPolicy: 'always' }));
    // Wired exactly as in src/main/index.ts.
    const settings = new AppSettingsStore(home, { log: () => undefined });
    port.shotPolicy = async () => { await settings.ready; return settings.get().shotPolicy; };
    const run = vi.spyOn(runner, 'run').mockImplementation(async (options) => endedSnapshot({ runId: options.runId, status: 'succeeded' }));
    const runOnce = async () => {
      const queued = await service.runNow(GAME, ACCOUNT, 'task-1');
      await eventually(async () => (await service.overview(GAME)).runs.find((row) => row.runId === queued.runId)?.status === 'succeeded');
      await eventually(async () => !service.isActiveForInstance(1));
    };
    await runOnce();
    expect(run.mock.calls[0]?.[0].shotPolicy).toBe('always');
    await settings.save({ shotPolicy: 'never' });
    await runOnce();
    expect(run.mock.calls[1]?.[0].shotPolicy).toBe('never');
    // A manual run that chose a policy keeps it; one that did not follows the settings too.
    const chosen = await service.runScript(GAME, 1, script.id, { shotPolicy: 'always' });
    expect(chosen.shotPolicy).toBe('always');
    await eventually(async () => !service.isActiveForInstance(1));
    const fallback = await service.runScript(GAME, 1, script.id);
    expect(fallback.shotPolicy).toBe('never');
    await eventually(async () => !service.isActiveForInstance(1));
    // Without the port (or when it fails) runs keep only failure shots.
    port.shotPolicy = () => { throw new Error('设置读不出'); };
    await runOnce();
    expect(run.mock.calls.at(-1)?.[0].shotPolicy).toBe('onFail');
  });

  it('runs a manual script through the shared instance lease and records success', async () => {
    const { service, actions } = await setup();
    const run = await service.runNow(GAME, ACCOUNT, 'task-1');
    await eventually(async () => (await service.overview(GAME)).runs.find((row) => row.runId === run.runId)?.status === 'succeeded');
    await eventually(async () => !service.isActiveForInstance(1));
    expect(actions).toEqual(['100,100']);
    expect((await service.overview(GAME)).runtime[0]?.runs).toBe(1);
    expect(service.isActiveForInstance(1)).toBe(false);
  });

  it('labels the instance lease and writes explicit screenshot steps whatever the shot policy (per-step shots only under 「每步都留痕」)', async () => {
    let owner: LeaseOwner | null = null;
    const { service, port, home } = await setup(async () => { owner = await readLeaseOwner(home, 1); });
    let policy: 'never' | 'always' = 'never';
    port.shotPolicy = () => policy;
    await service.saveScript(GAME, { ...script, steps: [
      { id: 'tap-1', kind: 'tap', at: { x: 50, y: 50 }, capture: true },
      { id: 'shot-1', kind: 'screenshot', label: 'scene' },
    ] });
    const shotsOf = (runId: string) => readdir(path.join(home, 'automation', 'games', GAME, 'runs', runId, 'shots')).catch(() => [] as string[]);
    const finished = async (runId: string) => {
      await eventually(async () => (await service.overview(GAME)).runs.find((row) => row.runId === runId)?.status === 'succeeded');
      await eventually(async () => !service.isActiveForInstance(1));
    };
    const quiet = await service.runNow(GAME, ACCOUNT, 'task-1');
    await finished(quiet.runId);
    expect(owner).toMatchObject({ label: '运行脚本计划', pid: process.pid });
    // Original worker/actions.ts: a screenshot step (and step.capture === true) is saved even under 「不留痕」;
    // the port has no shot-policy hook for them at all (the engine decides from the run's policy).
    expect(await shotsOf(quiet.runId)).toEqual(['0001-tap-1-ok.jpg', '0002-scene.jpg']);
    policy = 'always';
    const traced = await service.runNow(GAME, ACCOUNT, 'task-1');
    await finished(traced.runId);
    // 「每步都留痕」 adds a shot after every completed step (the screenshot step's own included).
    expect(await shotsOf(traced.runId)).toEqual(['0001-tap-1-ok.jpg', '0002-scene.jpg', '0003-shot-1-ok.jpg']);
  });

  it('labels the lease of a manual run', async () => {
    let owner: LeaseOwner | null = null;
    const { service, home } = await setup(async () => { owner = await readLeaseOwner(home, 1); });
    const run = await service.runScript(GAME, 1, script.id);
    await eventually(async () => service.listRuns(GAME).find((item) => item.runId === run.runId)?.status === 'succeeded');
    expect(owner).toMatchObject({ label: '运行脚本', pid: process.pid });
  });

  it('★ a plan run preempts gathering: the scheduler yields before the lease is taken and gets it back after (plan rule 1)', async () => {
    // Gather auto being on never refuses a script any more (DECISIONS A.4): the run borrows the instance.
    const events: string[] = [];
    let homeDir = '';
    const { service, port, home, actions } = await setup(async () => {
      events.push(`tap:lease=${(await readLeaseOwner(homeDir, 1))?.label ?? 'none'}`);
    });
    homeDir = home;
    port.suspendForScript = async (game, index, reason) => {
      events.push(`suspend:${game}:${index}:lease=${(await readLeaseOwner(home, 1))?.label ?? 'none'}`);
      expect(reason).toContain(script.id);
      return () => { events.push('resume'); };
    };
    const queued = await service.runNow(GAME, ACCOUNT, 'task-1');
    await eventually(async () => (await service.overview(GAME)).runs.find((row) => row.runId === queued.runId)?.status === 'succeeded');
    await eventually(async () => events.includes('resume'));
    expect(actions).toEqual(['100,100']);
    // Yield first (nobody holds the lease yet), then the script runs under its labelled lease, then the give-back.
    expect(events).toEqual([`suspend:${GAME}:1:lease=none`, 'tap:lease=运行脚本计划', 'resume']);
    expect(await readLeaseOwner(home, 1)).toBeNull();
  });

  it('gives the instance back to gathering when the plan run fails or is skipped', async () => {
    const { service, port } = await setup(async () => { throw new Error('fake adb failure'); });
    let resumed = 0;
    port.suspendForScript = async () => () => { resumed++; };
    const queued = await service.runNow(GAME, ACCOUNT, 'task-1');
    await eventually(async () => (await service.overview(GAME)).runs.find((row) => row.runId === queued.runId)?.status === 'failed');
    await eventually(async () => resumed === 1);
    // A scheduler that cannot yield (it throws) never blocks the script.
    port.suspendForScript = async () => { throw new Error('调度器不可用'); };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const again = await service.runNow(GAME, ACCOUNT, 'task-1');
      await eventually(async () => (await service.overview(GAME)).runs.find((row) => row.runId === again.runId)?.status === 'failed');
      expect(warn).toHaveBeenCalledWith('[plan] 采集调度让路失败，仍然继续启动脚本', '调度器不可用');
    } finally {
      warn.mockRestore();
    }
  });

  it.each([
    ['disabled', (current: GameAccount) => { current.enabled = false; }],
    ['login reset', (current: GameAccount) => { current.login.status = 'pending'; }],
    ['rebound index', (current: GameAccount) => { current.binding!.index = 2; }],
    ['replaced AVD identity', (current: GameAccount) => { current.binding!.instanceCreatedAt = 'identity-2'; }],
  ] as const)('stops before the next input when account becomes %s', async (_name, change) => {
    const current = structuredClone(account);
    let firstTap = true;
    const { service, actions, port } = await setup(async () => {
      if (firstTap) { firstTap = false; change(current); }
    });
    port.accounts = async () => [current];
    await service.saveScript(GAME, { ...script, steps: [
      { id: 'tap-1', kind: 'tap', at: { x: 50, y: 50 } },
      { id: 'tap-2', kind: 'tap', at: { x: 60, y: 60 }, retry: 2, onFail: { kind: 'continue' } },
    ] });
    const run = await service.runNow(GAME, ACCOUNT, 'task-1');
    await eventually(async () => (await service.overview(GAME)).runs.find((row) => row.runId === run.runId)?.status === 'failed');
    expect(actions).toEqual(['100,100']);
    expect((await service.overview(GAME)).runs.find((row) => row.runId === run.runId)?.message).toContain('账号已禁用');
  });

  it('waits out a long retry delay with the instance released, and cancelling drops the pending retry', async () => {
    const { service, actions, home } = await setup(async () => { throw new Error('fake adb failure'); });
    await service.saveConfig(GAME, { retry: 1, retryDelayMs: 30 * 60_000 });
    const run = await service.runNow(GAME, ACCOUNT, 'task-1');
    await eventually(async () => (await service.overview(GAME)).runs.find((row) => row.runId === run.runId)?.status === 'failed');
    // ★ Retries happen outside the lease: during the 30-minute hold the instance is free for gathering and others.
    await eventually(async () => !service.isActiveForInstance(1));
    expect(await readLeaseOwner(home, 1)).toBeNull();
    const held = (await service.overview(GAME)).tasks[0]!;
    expect(held.holdUntil).toBeGreaterThan(Date.now() + 29 * 60_000);
    expect(held.nextRunAt).toBe(held.holdUntil);
    const started = Date.now();
    await service.cancelRun(GAME, run.runId);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect((await service.overview(GAME)).tasks[0]).toMatchObject({ holdUntil: null, retryLeft: 0 });
    expect(actions).toHaveLength(1);
    // Cancel by task drops a pending retry the same way.
    const again = await service.runNow(GAME, ACCOUNT, 'task-1');
    await eventually(async () => (await service.overview(GAME)).runs.find((row) => row.runId === again.runId)?.status === 'failed');
    await eventually(async () => (await service.overview(GAME)).tasks[0]?.holdUntil !== null);
    expect((await service.cancelTask(GAME, ACCOUNT, 'task-1')).tasks[0]).toMatchObject({ holdUntil: null });
  });

  it('§十二 the time limit stops a run even while a device call hangs; gather is given back and the phase never sticks', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'wanlong-plan-service-'));
    homes.push(home);
    const events: string[] = [];
    const device = fakeScriptDevice({ tap: async () => { events.push('tap'); await new Promise((resolve) => setTimeout(resolve, 400)); } });
    const port: PlanHostPort = {
      accounts: async () => [account],
      instance: async () => ({ status: 'running', record: { createdAt: 'identity-1' } }),
      templateDir: async () => '',
      device: async () => device,
      suspendForScript: async () => { events.push('yield'); return () => { events.push('restore'); }; },
    };
    const runner = new ScriptRunner(home, port, {
      workerFactory: inProcessWorkers({ vision: fakeVision() }).factory, pacing: FAST_PACING, foregroundPollMs: 5,
      deadlineSlackMs: 20, stopGraceMs: 50,
    });
    // One 「分钟」 of the task limit lasts 40 ms here.
    const service = new PlanService(home, port, runner, { minuteMs: 40 });
    services.push(service);
    await service.start(GAME);
    await service.saveScript(GAME, { ...script, steps: [{ id: 'tap-1', kind: 'tap', at: { x: 50, y: 50 } }, { id: 'tap-2', kind: 'tap', at: { x: 60, y: 60 } }] });
    await service.savePlan(GAME, { accountId: ACCOUNT, enabled: true, updatedAt: 0,
      tasks: [{ id: 'task-1', scriptId: script.id, enabled: true, trigger: { kind: 'manual' }, priority: 50, maxRunMinutes: 1 }] });
    await service.saveConfig(GAME, { retry: 2, retryDelayMs: 0 });
    const queued = await service.runNow(GAME, ACCOUNT, 'task-1');
    await eventually(async () => (await service.overview(GAME)).tasks[0]?.phase === 'failed', 5000);
    const overview = await service.overview(GAME);
    expect(overview.runs.find((row) => row.runId === queued.runId)?.message).toContain('时间上限');
    expect(runner.get(queued.runId)).toMatchObject({ status: 'failed', timedOut: true });
    await eventually(async () => events.includes('restore'));
    expect(events.filter((item) => item === 'yield')).toHaveLength(1); // a stopped run is never retried
    expect(overview.tasks[0]).toMatchObject({ holdUntil: null, fails: 1 });
    await eventually(async () => !service.isActiveForInstance(1));
  });

  it('only the scheduler lease owner may evaluate due tasks after another process edits plans', async () => {
    const { service: owner, home, port, actions } = await setup();
    const second = new PlanService(home, port, new ScriptRunner(home, port, { workerFactory: inProcessWorkers({ vision: fakeVision() }).factory }));
    services.push(second);
    await second.start(GAME); // contended: read/edit access remains, timed execution belongs to owner.
    const nowBeijing = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(11, 16);
    await second.savePlan(GAME, { accountId: ACCOUNT, enabled: true, updatedAt: 0,
      tasks: [{ id: 'task-1', scriptId: script.id, enabled: true,
        trigger: { kind: 'daily', at: [nowBeijing] }, priority: 50, maxRunMinutes: 1 }] });
    await second.saveConfig(GAME, { enabled: true });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await owner.overview(GAME)).runs).toHaveLength(0);
    expect(actions).toHaveLength(0);
    await expect(second.runNow(GAME, ACCOUNT, 'task-1')).rejects.toThrow('另一个万龙助手进程');
  });

  it('runs any script manually on an instance, with live snapshots and a busy instance meanwhile', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { service, actions, snapshots } = await setup(async () => { await gate; });
    const started = await service.runScript(GAME, 1, script.id, { params: {}, maxRunMinutes: 5 });
    expect(started).toMatchObject({ status: 'starting', source: 'manual', instanceIndex: 1, accountId: null, maxRunMs: 300_000 });
    expect(service.isActiveForInstance(1)).toBe(true);
    expect(service.runIdOfInstance(1)).toBe(started.runId);
    await expect(service.runScript(GAME, 1, script.id)).rejects.toThrow('实例 #1 上已有脚本在运行');
    release();
    await eventually(async () => service.listRuns(GAME).find((run) => run.runId === started.runId)?.status === 'succeeded');
    await eventually(async () => !service.isActiveForInstance(1));
    expect(actions).toEqual(['100,100']);
    expect(snapshots.some((snapshot) => snapshot.runId === started.runId && snapshot.status === 'running')).toBe(true);
    expect((await service.runLogs(GAME, { runId: started.runId })).some((line) => line.message.includes('执行成功结束'))).toBe(true);
  });

  it('checks the account of a manual run and applies defaults < account < request params', async () => {
    const { service, actions, port } = await setup();
    const withParams = { ...account, scriptParams: { typing: { who: 'account', keep: 'account' } } } as GameAccount;
    port.accounts = async () => [withParams];
    await service.saveScript(GAME, { ...script, id: 'typing', params: [{ key: 'who', label: '谁', type: 'string', default: 'script' },
      { key: 'keep', label: '保留', type: 'string', default: 'script' }], steps: [{ id: 't', kind: 'text', text: '{{who}}-{{keep}}' }] });
    const typed: string[] = [];
    const device = await port.device(1);
    port.device = async () => ({ ...device, text: async (value: string) => { typed.push(value); } });
    const run = await service.runScript(GAME, 1, 'typing', { accountId: ACCOUNT, params: { who: 'request' } });
    await eventually(async () => service.listRuns(GAME).find((item) => item.runId === run.runId)?.status === 'succeeded');
    expect(typed).toEqual(['request-account']);
    expect(actions).toEqual([]);
    await expect(service.runScript(GAME, 2, 'typing', { accountId: ACCOUNT })).rejects.toThrow('没有绑定到实例 #2');
  });

  it('refuses a manual run while another writer holds the instance lease', async () => {
    const { service, home } = await setup();
    let exit!: () => void;
    const held = new Promise<void>((resolve) => { exit = resolve; });
    let entered!: () => void;
    const inLock = new Promise<void>((resolve) => { entered = resolve; });
    const lock = withFileLock(path.join(home, 'run', 'automation-instance-1.lock'), async () => { entered(); await held; }, { timeoutMs: 1000 });
    await inLock;
    await expect(service.runScript(GAME, 1, script.id)).rejects.toThrow('正被登录、采集或脚本计划占用');
    expect(service.isActiveForInstance(1)).toBe(false);
    exit();
    await lock;
  });

  it('a manual run borrows the instance from the gather scheduler (never refused because gather auto is on)', async () => {
    const { service, port } = await setup();
    const events: string[] = [];
    port.suspendForScript = async (_game, index, reason) => { events.push(`suspend:${index}:${reason}`); return () => events.push('resume'); };
    const run = await service.runScript(GAME, 1, script.id);
    await eventually(async () => service.listRuns(GAME).find((item) => item.runId === run.runId)?.status === 'succeeded');
    await eventually(async () => events.includes('resume'));
    expect(events[0]).toMatch(/^suspend:1:临时运行脚本/);
  });

  it('a manual run preempts at once by default (最高优先) and after the plan config grace for 「普通」', async () => {
    const { service, port } = await setup();
    const graces: number[] = [];
    port.suspendForScript = async (_game, _index, _reason, graceMs) => { graces.push(graceMs); return () => undefined; };
    const first = await service.runScript(GAME, 1, script.id);
    await eventually(async () => service.listRuns(GAME).find((item) => item.runId === first.runId)?.status === 'succeeded');
    await eventually(async () => service.runIdOfInstance(1) === null);
    const second = await service.runScript(GAME, 1, script.id, { priority: 'normal' });
    await eventually(async () => service.listRuns(GAME).find((item) => item.runId === second.runId)?.status === 'succeeded');
    expect(graces).toEqual([0, (await service.config(GAME)).preemptGraceMs]);
    await eventually(async () => service.runIdOfInstance(1) === null);
    await expect(service.runScript(GAME, 1, script.id, { priority: 'urgent' as never })).rejects.toThrow('执行优先级无效');
  });

  it('runs the keep-alive example while the game is not in the foreground (its relaunch branch is reachable)', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'wanlong-plan-service-'));
    homes.push(home);
    const dir = await writeTemplateSet(path.join(home, 'set'), ['demo_target']);
    const device = fakeScriptDevice();
    device.foreground = 'com.android.launcher3';
    const port: PlanHostPort = {
      accounts: async () => [account],
      instance: async () => ({ status: 'running', record: { createdAt: 'identity-1' } }),
      templateDir: async () => dir,
      device: async () => device,
    };
    const runner = new ScriptRunner(home, port, { workerFactory: inProcessWorkers({ vision: fakeVision(() => true) }).factory, pacing: FAST_PACING, foregroundPollMs: 5 });
    const service = new PlanService(home, port, runner);
    services.push(service);
    await service.start(GAME);
    // A script that does not start with a launch is still refused off-game.
    await service.saveScript(GAME, script);
    await expect(service.runScript(GAME, 1, script.id)).rejects.toThrow('未处于前台');
    const run = await service.runScript(GAME, 1, 'builtin_keep_alive');
    await eventually(async () => service.listRuns(GAME).find((item) => item.runId === run.runId)?.status === 'succeeded');
    expect(device.actions).toEqual([`stop:${PKG}`, `start:${PKG}`]);
  });

  it('caps concurrent scripts: manual runs are refused, plan runs wait instead of failing', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { service, port } = await setup(async () => { await gate; });
    await service.saveConfig(GAME, { maxConcurrentScripts: 1 });
    const second = { ...account, id: '00000000-0000-4000-8000-000000000002', binding: { index: 2, instanceCreatedAt: 'identity-1' } };
    port.accounts = async () => [account, second];
    await service.savePlan(GAME, { accountId: second.id, enabled: false, updatedAt: 0,
      tasks: [{ id: 'task-2', scriptId: script.id, enabled: true, trigger: { kind: 'manual' }, priority: 50, maxRunMinutes: 1 }] });
    const first = await service.runScript(GAME, 1, script.id);
    await expect(service.runScript(GAME, 2, script.id)).rejects.toThrow('同时运行的脚本已达上限 1 个');
    const queued = await service.runNow(GAME, second.id, 'task-2');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await service.overview(GAME)).runs.find((row) => row.runId === queued.runId)?.status).toBe('queued');
    release();
    await eventually(async () => service.listRuns(GAME).find((item) => item.runId === first.runId)?.status === 'succeeded');
    await eventually(async () => (await service.overview(GAME)).runs.find((row) => row.runId === queued.runId)?.status === 'succeeded', 8000);
  }, 15_000);

  it('pauses, resumes and stops a manual run through the service', async () => {
    const { service, port } = await setup();
    await service.saveScript(GAME, { ...script, id: 'slow', steps: [{ id: 's', kind: 'sleep', ms: 60_000 }] });
    const run = await service.runScript(GAME, 1, 'slow');
    await eventually(async () => service.listRuns(GAME).find((item) => item.runId === run.runId)?.status === 'running');
    service.pauseRun(GAME, run.runId);
    await eventually(async () => service.listRuns(GAME).find((item) => item.runId === run.runId)?.status === 'paused');
    service.resumeRun(GAME, run.runId);
    await service.cancelRun(GAME, run.runId);
    expect(service.listRuns(GAME).find((item) => item.runId === run.runId)?.status).toBe('aborted');
    await eventually(async () => !service.isActiveForInstance(1));
    void port;
  });

  it('reports and sets up the ADBKeyboard input method under the instance lease', async () => {
    const { service, port, home } = await setup();
    const shells: string[] = [];
    let installed = false;
    let owner: LeaseOwner | null = null;
    const device = await port.device(1);
    port.device = async () => ({
      ...device,
      install: async () => { installed = true; owner = await readLeaseOwner(home, 1); return 'Success'; },
      shell: async (command: string) => {
        shells.push(command);
        if (command.startsWith('pm list packages')) return installed ? 'package:com.android.adbkeyboard\n' : '';
        if (command === 'ime list -s') return installed ? 'com.android.adbkeyboard/.AdbIME\n' : '';
        if (command.startsWith('settings get')) return installed ? 'com.android.adbkeyboard/.AdbIME\n' : 'com.android.inputmethod.latin/.LatinIME\n';
        return '';
      },
    });
    expect(await service.imeStatus(1)).toMatchObject({ installed: false, available: false });
    const apk = path.join(home, 'ADBKeyboard.apk');
    await writeFile(apk, 'apk');
    expect(await service.setupIme(1, apk)).toMatchObject({ installed: true, enabled: true, selected: true, available: true });
    expect(shells).toEqual(expect.arrayContaining(['ime enable com.android.adbkeyboard/.AdbIME', 'ime set com.android.adbkeyboard/.AdbIME']));
    expect(owner).toMatchObject({ label: '安装中文输入法', pid: process.pid });
    await expect(service.setupIme(1, path.join(home, 'not-an-apk.txt'))).rejects.toThrow('.apk');
  });
});
