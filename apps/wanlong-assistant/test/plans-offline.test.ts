import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AvdmError } from '@avdm/core';
import { readLeaseOwner, withLabelledLease } from '../src/main/app/instance-access';
import type { GameAccount } from '../src/main/automation/accounts/types';
import { AiRecoveryService } from '../src/main/automation/ai-recover';
import { PlanService, ScriptRunner } from '../src/main/plans';
import type { ScriptExecuteOptions } from '../src/main/plans/script-runner';
import type { AccountPlan, PlanConfig, PlanConfigEvent, PlanHostPort, PlanOverview, PlanTask, PlanTaskState, ScriptDef, ScriptRunSnapshot } from '../src/main/plans/types';
import { cstDayStartOf } from '../src/shared/plan';
import { eventually, FAST_PACING, fakeScriptDevice, fakeVision, inProcessWorkers, PKG } from './helpers/script-worker';

/**
 * Port of wanlong-panel `scripts/plan-offline-check.ts` §三–§十四 (the planner end to end). No emulator, no adb,
 * no worker thread: the script runner's `run` is a fake whose runs end when the scenario says so, and the gather
 * scheduler is a fake that records the 「让路 / 放回」 order.
 */
const GAME = 'wanlong';
const MIN = 60_000;
const HOUR = 3_600_000;

const accountId = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function account(n: number, index: number | null, extra: Partial<GameAccount> = {}): GameAccount {
  return {
    id: accountId(n), gameId: GAME, packageName: PKG, name: `账号${n}`, server: '', role: '', note: '', enabled: true,
    binding: index === null ? null : { index, instanceCreatedAt: `identity-${index}` },
    login: { status: 'ready', attemptId: null, verifiedAt: 1 }, createdAt: 1, updatedAt: 1, ...extra,
  };
}
const script = (id: string, extra: Partial<ScriptDef> = {}): ScriptDef => ({
  id, name: `脚本${id}`, version: '1.0.0', packageName: PKG, refWidth: 100, refHeight: 100, updatedAt: 0,
  steps: [{ id: 'tap-1', kind: 'tap', at: { x: 50, y: 50 } }], ...extra,
});
const task = (id: string, scriptId: string, patch: Partial<PlanTask> = {}): PlanTask => ({
  id, scriptId, enabled: true, trigger: { kind: 'interval', everyMinutes: 60 }, priority: 50, maxRunMinutes: 30, ...patch,
});
const plan = (n: number, tasks: PlanTask[], enabled = true): AccountPlan => ({ accountId: accountId(n), enabled, tasks, updatedAt: 0 });

/** The Beijing `HH:MM` of now + delta. */
function clockOffsetFromNow(deltaMs: number): string {
  const at = Date.now() + deltaMs;
  const offset = at - cstDayStartOf(at);
  return `${String(Math.floor(offset / HOUR)).padStart(2, '0')}:${String(Math.floor((offset % HOUR) / MIN)).padStart(2, '0')}`;
}

function snapshot(options: ScriptExecuteOptions, status: ScriptRunSnapshot['status'], extra: Partial<ScriptRunSnapshot> = {}): ScriptRunSnapshot {
  return {
    runId: options.runId, scriptId: options.script.id, scriptName: options.script.name, instanceIndex: options.instanceIndex,
    accountId: options.accountId, accountName: options.accountName, status, startedAt: 1, endedAt: 2, stepDone: 0, stepTotal: 1,
    currentStepId: null, currentStepName: null, iteration: 0, error: null,
    stats: { captures: 0, matches: 0, matchHits: 0, taps: 0, retries: 0, lastTickMs: 0, avgCaptureMs: 0 },
    gameId: options.gameId, source: options.source, taskId: options.taskId, shotPolicy: options.shotPolicy, maxRunMs: options.maxRunMs, ...extra,
  };
}

interface World {
  service: PlanService;
  runner: ScriptRunner;
  port: PlanHostPort;
  home: string;
  accounts: GameAccount[];
  /** Order of 「让路 / 启动 / 放回」 calls. */
  trace: string[];
  started: ScriptExecuteOptions[];
  graces: number[];
  instanceStatus: Map<number, string>;
  changes: PlanOverview[];
  configEvents: PlanConfigEvent[];
  /** Ends a started run. */
  finish(runId: string, status: ScriptRunSnapshot['status'], extra?: Partial<ScriptRunSnapshot>): void;
  /** The next started run ends before `run()` even returns (the script's first step failed). */
  finishInstantly(status: ScriptRunSnapshot['status'], extra?: Partial<ScriptRunSnapshot>): void;
  overview(): Promise<PlanOverview>;
  row(taskId: string): Promise<PlanTaskState>;
}

const worlds: World[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const world of worlds.splice(0)) {
    await world.service.shutdown();
    await rm(world.home, { recursive: true, force: true });
  }
});

async function scenario(plans: AccountPlan[], accounts: GameAccount[], scripts: ScriptDef[], config: Partial<PlanConfig> = {}): Promise<World> {
  const home = await mkdtemp(path.join(tmpdir(), 'wanlong-plan-offline-'));
  const trace: string[] = [];
  const started: ScriptExecuteOptions[] = [];
  const graces: number[] = [];
  const instanceStatus = new Map<number, string>();
  const changes: PlanOverview[] = [];
  const configEvents: PlanConfigEvent[] = [];
  const pending = new Map<string, { options: ScriptExecuteOptions; resolve: (s: ScriptRunSnapshot) => void }>();
  let instant: { status: ScriptRunSnapshot['status']; extra: Partial<ScriptRunSnapshot> } | null = null;
  const port: PlanHostPort = {
    accounts: async () => accounts,
    instance: async (index) => ({ status: instanceStatus.get(index) ?? 'running', record: { createdAt: `identity-${index}` } }),
    templateDir: async () => '',
    device: async () => fakeScriptDevice(),
    suspendForScript: async (_gameId, index, _reason, graceMs) => {
      trace.push(`yield:${index}`);
      graces.push(graceMs);
      return () => { trace.push(`restore:${index}`); };
    },
    onChanged: (overview) => changes.push(overview),
    onConfigChanged: (event) => configEvents.push(event),
  };
  const runner = new ScriptRunner(home, port, { workerFactory: () => { throw new Error('假执行器不起线程'); } });
  vi.spyOn(runner, 'run').mockImplementation((options) => {
    started.push(options);
    trace.push(`start:${options.script.id}`);
    if (instant) {
      const { status, extra } = instant;
      instant = null;
      return Promise.resolve(snapshot(options, status, extra));
    }
    return new Promise<ScriptRunSnapshot>((resolve) => {
      pending.set(options.runId, { options, resolve });
      options.signal?.addEventListener('abort', () => resolve(snapshot(options, 'aborted')), { once: true });
    });
  });
  const service = new PlanService(home, port, runner, { busyRetryMs: 50 });
  for (const item of scripts) await service.saveScript(GAME, item);
  for (const item of plans) await service.store.savePlan(GAME, item);
  await service.store.saveConfig(GAME, { enabled: true, preemptGraceMs: 0, retry: 0, retryDelayMs: 0, ...config });
  const world: World = {
    service, runner, port, home, accounts, trace, started, graces, instanceStatus, changes, configEvents,
    finish(runId, status, extra = {}) {
      const item = pending.get(runId);
      if (!item) throw new Error(`没有这次执行：${runId}`);
      pending.delete(runId);
      item.resolve(snapshot(item.options, status, extra));
    },
    finishInstantly(status, extra = {}) { instant = { status, extra }; },
    overview: () => service.overview(GAME),
    async row(taskId) {
      const row = (await service.overview(GAME)).tasks.find((item) => item.taskId === taskId);
      if (!row) throw new Error(`没有任务 ${taskId}`);
      return row;
    },
  };
  worlds.push(world);
  await service.start(GAME);
  return world;
}

const count = (trace: string[], entry: string): number => trace.filter((item) => item === entry).length;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Another writer (a login, a manual gather round …) holds the instance lease until `release()`. */
async function holdLease(home: string, index: number, label: string): Promise<{ release(): Promise<void> }> {
  let entered!: () => void;
  let exit!: () => void;
  const acquired = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { exit = resolve; });
  const done = withLabelledLease(home, index, label, async () => { entered(); await held; });
  await acquired;
  return { release: async () => { exit(); await done; } };
}

describe('plan-offline-check §三–§十四: the planner end to end', () => {
  it('§三 due → ★ yield first → start → bookkeeping → next run scheduled', async () => {
    const w = await scenario([plan(1, [task('t1', 's1')])], [account(1, 0)], [script('s1')]);
    await eventually(() => w.started.length === 1);
    expect(w.trace.indexOf('yield:0')).toBeGreaterThanOrEqual(0);
    expect(w.trace.indexOf('yield:0')).toBeLessThan(w.trace.indexOf('start:s1'));
    expect(w.started[0]?.accountId).toBe(accountId(1));
    expect((await w.row('t1')).phase).toBe('running');
    w.finish(w.started[0]!.runId, 'succeeded');
    await eventually(async () => (await w.row('t1')).phase === 'done');
    await eventually(() => w.trace.includes('restore:0'));
    expect(w.trace.indexOf('restore:0')).toBeGreaterThan(w.trace.indexOf('start:s1'));
    const row = await w.row('t1');
    expect(row).toMatchObject({ runs: 1, fails: 0, lastResult: 'succeeded' });
    expect(row.nextRunAt).not.toBeNull();
    expect(row.nextRunAt!).toBeGreaterThan(Date.now());
    // The run history shows the round with its Chinese reason.
    expect((await w.overview()).runs[0]).toMatchObject({ status: 'succeeded', origin: 'schedule', attempt: 1 });
  });

  it('§四 one instance runs its queue serially, higher priority first; each run yields and restores once', async () => {
    const w = await scenario([plan(1, [task('t-low', 's-low', { priority: 10 }), task('t-high', 's-high', { priority: 90 })])],
      [account(1, 0)], [script('s-low'), script('s-high')]);
    await eventually(() => w.started[0]?.script.id === 's-high');
    await pause(120);
    expect(w.started).toHaveLength(1);
    expect((await w.row('t-low')).phase).toBe('queued');
    const queue = (await w.overview()).queues[0];
    expect(queue).toMatchObject({ instanceIndex: 0, runningTaskId: 't-high', waitingTaskIds: ['t-low'] });
    w.finish(w.started[0]!.runId, 'succeeded');
    await eventually(() => w.started.length === 2);
    expect(w.started[1]?.script.id).toBe('s-low');
    w.finish(w.started[1]!.runId, 'succeeded');
    await eventually(() => count(w.trace, 'restore:0') === 2);
    expect(count(w.trace, 'yield:0')).toBe(2);
  });

  it('§五 different instances never queue behind each other and each yields its own instance', async () => {
    const w = await scenario([plan(1, [task('t1', 's1')]), plan(2, [task('t2', 's2')])],
      [account(1, 0), account(2, 1)], [script('s1'), script('s2')]);
    await eventually(() => w.started.length === 2);
    expect(w.trace).toEqual(expect.arrayContaining(['yield:0', 'yield:1']));
  });

  it('§六 the global script cap only defers (stays queued, no failure, never yielded twice) and retries after the back-off', async () => {
    const w = await scenario([plan(1, [task('t1', 's1')]), plan(2, [task('t2', 's2')])],
      [account(1, 0), account(2, 1)], [script('s1'), script('s2')], { maxConcurrentScripts: 1 });
    await eventually(() => w.started.length === 1);
    await pause(150);
    expect(w.started).toHaveLength(1);
    const blocked = (await w.overview()).tasks.find((row) => row.phase === 'queued')!;
    expect(blocked).toMatchObject({ fails: 0, runs: 0 });
    expect(w.trace.filter((item) => item.startsWith('yield:'))).toHaveLength(1);
    w.finish(w.started[0]!.runId, 'succeeded');
    await eventually(() => w.started.length === 2);
    w.finish(w.started[1]!.runId, 'succeeded');
    await eventually(() => w.trace.filter((item) => item.startsWith('restore:')).length === 2);
    expect(w.trace.filter((item) => item.startsWith('yield:'))).toHaveLength(2);

    // A slot held by another script (a manual run reserved on instance 0) also defers the plan run on instance 1.
    const release = w.runner.reserve(0, 'manual-run');
    await w.service.runNow(GAME, accountId(2), 't2');
    await pause(150);
    expect(w.started).toHaveLength(2);
    expect((await w.row('t2')).phase).toBe('queued');
    release();
    await eventually(() => w.started.length === 3); // picked up by the back-off timer, not a failure
    expect((await w.row('t2')).fails).toBe(0);
  });

  it('§七 an instance that is not running only skips the round (no failure, Chinese reason, yield balanced)', async () => {
    const w = await scenario([plan(1, [task('t1', 's1')])], [account(1, 0)], [script('s1')], { retry: 2 });
    w.instanceStatus.set(0, 'stopped');
    await w.service.runNow(GAME, accountId(1), 't1').catch(() => undefined);
    await eventually(async () => (await w.row('t1')).phase === 'skipped');
    let row = await w.row('t1');
    expect(row).toMatchObject({ fails: 0, lastResult: 'skipped' });
    expect(row.lastError).toContain('未运行');
    expect(w.started).toHaveLength(0);
    await eventually(() => count(w.trace, 'restore:0') === count(w.trace, 'yield:0'));
    expect(row.holdUntil).toBeNull(); // never retried

    // A core error code from the instance lookup is classified by its code, not by its message.
    w.instanceStatus.delete(0);
    const instance = vi.spyOn(w.port, 'instance').mockRejectedValueOnce(new AvdmError('INSTANCE_NOT_RUNNING', '实例 #0 未运行'));
    await w.service.runNow(GAME, accountId(1), 't1');
    await eventually(async () => (await w.overview()).runs[0]?.status === 'skipped');
    expect((await w.row('t1')).fails).toBe(0);
    instance.mockRestore();

    // The runner refusing the start before any input (START_CHECK) is a skip too.
    await w.service.runNow(GAME, accountId(1), 't1');
    await eventually(() => w.started.length === 1);
    w.finish(w.started[0]!.runId, 'failed', { error: '实例已停止或被替换，脚本已停止', failureCode: 'START_CHECK' });
    await eventually(async () => (await w.overview()).runs[0]?.status === 'skipped');
    row = await w.row('t1');
    expect(row).toMatchObject({ fails: 0, phase: 'skipped', holdUntil: null });
  });

  it('§八 a failed script is recorded as failed with its Chinese reason', async () => {
    const w = await scenario([plan(1, [task('t1', 's1')])], [account(1, 0)], [script('s1')]);
    await eventually(() => w.started.length === 1);
    w.finish(w.started[0]!.runId, 'failed', { error: '步骤「点联盟」失败：模板没找到' });
    await eventually(async () => (await w.row('t1')).phase === 'failed');
    const row = await w.row('t1');
    expect(row.fails).toBe(1);
    expect(row.lastError).toContain('模板没找到');
  });

  it('§九 with the total switch off only 「立即运行」 runs (still yielding first); turning it on resumes scheduling', async () => {
    const w = await scenario([plan(1, [task('t1', 's1')])], [account(1, 0)], [script('s1')], { enabled: false });
    await pause(150);
    expect(w.started).toHaveLength(0);
    expect((await w.row('t1')).nextRunAt).toBeNull();
    const run = await w.service.runNow(GAME, accountId(1), 't1');
    expect(run).toMatchObject({ origin: 'manual', attempt: 1, status: 'queued' });
    await eventually(() => w.started.length === 1);
    expect(w.trace.indexOf('yield:0')).toBeLessThan(w.trace.indexOf('start:s1'));
    // ★ Deduplicated with a clear message instead of a second queued run.
    await expect(w.service.runNow(GAME, accountId(1), 't1')).rejects.toThrow('已经在队列里了');
    await w.service.saveConfig(GAME, { enabled: true });
    expect(w.configEvents.at(-1)).toMatchObject({ gameId: GAME, config: { enabled: true } });
    w.finish(w.started[0]!.runId, 'succeeded');
    await eventually(async () => (await w.row('t1')).nextRunAt !== null);
  });

  it('§十 the task checkbox and the account switch; switching a task off takes its queued round off the queue', async () => {
    const w = await scenario([plan(1, [task('t1', 's1', { enabled: false }), task('t2', 's2', { priority: 10 })])],
      [account(1, 0)], [script('s1'), script('s2')]);
    await eventually(() => w.started.length === 1);
    expect(w.started[0]?.script.id).toBe('s2');
    await pause(100);
    expect(w.started).toHaveLength(1);
    // Checked while t2 runs: t1 is due at once and waits behind it.
    let overview = await w.service.setTaskEnabled(GAME, accountId(1), 't1', true);
    await eventually(async () => (await w.row('t1')).phase === 'queued');
    // Unchecked again: dequeued immediately (no stale run left behind), back to 「等待」.
    overview = await w.service.setTaskEnabled(GAME, accountId(1), 't1', false);
    expect(overview.tasks.find((row) => row.taskId === 't1')).toMatchObject({ phase: 'idle', enabled: false, nextRunAt: null });
    expect(overview.queues[0]?.waitingTaskIds).toEqual([]);
    expect(overview.runs.find((item) => item.taskId === 't1')).toMatchObject({ status: 'cancelled', message: '任务已关闭，排队取消' });
    w.finish(w.started[0]!.runId, 'succeeded');
    await pause(100);
    expect(w.started).toHaveLength(1);
    await w.service.setTaskEnabled(GAME, accountId(1), 't1', true);
    await eventually(() => w.started.length === 2);
    w.finish(w.started[1]!.runId, 'succeeded');
    await eventually(async () => (await w.row('t1')).phase === 'done');
    overview = await w.service.setAccountEnabled(GAME, accountId(1), false);
    const row = overview.tasks.find((item) => item.taskId === 't1')!;
    expect(row.nextRunAt).toBeNull();
    expect(row.enabled).toBe(true);
    expect(row.accountEnabled).toBe(false);
  });

  it('§十一 an account without an instance never starts; 「立即运行」 explains how to bind', async () => {
    const w = await scenario([plan(1, [task('t1', 's1')])], [account(1, null)], [script('s1')]);
    await pause(150);
    expect(w.started).toHaveLength(0);
    expect(await w.row('t1')).toMatchObject({ instanceIndex: null, accountIssue: '未绑定实例' });
    await expect(w.service.runNow(GAME, accountId(1), 't1')).rejects.toThrow('还没绑定实例');
  });

  it('§十二之二 a run that ends at once is still settled promptly (no wait for the time limit)', async () => {
    const w = await scenario([plan(1, [task('t1', 's1')])], [account(1, 0)], [script('s1')]);
    w.finishInstantly('failed', { error: '第一步就失败了' });
    await eventually(async () => (await w.row('t1')).phase === 'failed');
    expect((await w.row('t1')).lastError).toContain('第一步就失败');
    await eventually(() => w.trace.includes('restore:0'));
  });

  it('§十二之三 retry=1: a failure is retried once outside the instance lease, then stops; fails = 2', async () => {
    const w = await scenario([plan(1, [task('t1', 's1', { trigger: { kind: 'manual' } })])], [account(1, 0)], [script('s1')],
      { retry: 1, retryDelayMs: 300 });
    await w.service.runNow(GAME, accountId(1), 't1');
    await eventually(() => w.started.length === 1);
    w.finish(w.started[0]!.runId, 'failed', { error: '模板没找到' });
    // Between the attempts the instance is free (lease released, gather given back) and the hold is visible.
    await eventually(async () => (await w.row('t1')).holdUntil !== null);
    expect(await readLeaseOwner(w.home, 0)).toBeNull();
    expect(w.service.isActiveForInstance(0)).toBe(false);
    expect(w.trace).toEqual(['yield:0', 'start:s1', 'restore:0']);
    await eventually(() => w.started.length === 2);
    expect(w.trace).toEqual(['yield:0', 'start:s1', 'restore:0', 'yield:0', 'start:s1']);
    w.finish(w.started[1]!.runId, 'failed', { error: '模板还是没找到' });
    await eventually(async () => (await w.row('t1')).phase === 'failed');
    await pause(400);
    expect(w.started).toHaveLength(2);
    const overview = await w.overview();
    expect(overview.tasks[0]).toMatchObject({ fails: 2, runs: 2, holdUntil: null });
    expect(overview.runs.slice(0, 2).map((item) => [item.attempt, item.status])).toEqual([[2, 'failed'], [1, 'failed']]);
    expect(overview.runs[0]?.message).toContain('模板还是没找到');
  });

  it('never retries guard stops, 「需要人处理」 or time-limit stops; a user stop is cancelled, not failed', async () => {
    const w = await scenario([plan(1, [task('t1', 's1', { trigger: { kind: 'manual' } })])], [account(1, 0)], [script('s1')], { retry: 3 });
    for (const [i, extra] of ([
      { error: '账号已禁用、退出登录或绑定发生变化，脚本已停止', failureCode: 'GUARD' },
      { error: 'AI 顾问判定需要人工处理', failureCode: 'AI_RISK_BLOCKED' },
      { error: '脚本运行超过本次时间上限（30 分钟），已停止。', timedOut: true, failureCode: 'TIMEOUT' },
    ] as const).entries()) {
      await w.service.runNow(GAME, accountId(1), 't1');
      await eventually(() => w.started.length === i + 1);
      w.finish(w.started[i]!.runId, 'failed', extra);
      await eventually(async () => (await w.overview()).runs[0]?.status === 'failed' && !w.service.isActiveForInstance(0));
      expect((await w.row('t1')).holdUntil).toBeNull();
    }
    await pause(100);
    expect(w.started).toHaveLength(3);
    await w.service.runNow(GAME, accountId(1), 't1');
    await eventually(() => w.started.length === 4);
    const overview = await w.service.cancelTask(GAME, accountId(1), 't1');
    expect(overview.runs[0]).toMatchObject({ status: 'cancelled', message: '用户停止脚本' });
    expect(overview.tasks[0]).toMatchObject({ phase: 'idle', fails: 3, holdUntil: null });
  });

  it('§十三 a daily time missed by two hours is not caught up and waits for tomorrow', async () => {
    const w = await scenario([plan(1, [task('t1', 's1', { trigger: { kind: 'daily', at: [clockOffsetFromNow(-2 * HOUR)] } })])],
      [account(1, 0)], [script('s1')]);
    await pause(150);
    expect(w.started).toHaveLength(0);
    const next = (await w.row('t1')).nextRunAt;
    expect(next).not.toBeNull();
    expect(next! - Date.now()).toBeGreaterThan(20 * HOUR);
  });

  it('§十四 a daily time missed by five minutes is caught up', async () => {
    const w = await scenario([plan(1, [task('t1', 's1', { trigger: { kind: 'daily', at: [clockOffsetFromNow(-5 * MIN)] } })])],
      [account(1, 0)], [script('s1')]);
    await eventually(() => w.started.length === 1);
    expect((await w.overview()).runs[0]?.reason).toMatch(/补跑错过的触发点（晚了 [56] 分钟）/);
  });
});

describe('planner additions', () => {
  it('★ waiting rounds older than queueWaitMs are skipped by the sweep; the running one is never touched', async () => {
    let offset = 0;
    const w = await scenario([plan(1, [task('t1', 's1', { priority: 90 }), task('t2', 's2', { priority: 10 })])],
      [account(1, 0)], [script('s1'), script('s2')], { queueWaitMs: MIN });
    await eventually(() => w.started.length === 1);
    await eventually(async () => (await w.row('t2')).phase === 'queued');
    // Move the planner clock two minutes on, then trigger an evaluation.
    Object.assign(w.service as unknown as { now: () => number }, { now: () => Date.now() + offset });
    offset = 2 * MIN;
    await w.service.saveConfig(GAME, { queueWaitMs: MIN });
    await eventually(async () => (await w.row('t2')).phase === 'skipped');
    const row = await w.row('t2');
    expect(row.lastError).toBe('等了 2 分钟仍没轮到（实例一直忙），这一轮跳过。');
    expect(row.fails).toBe(0);
    expect((await w.row('t1')).phase).toBe('running');
  });

  it('passes preemptGraceMs, aiAssist and the three-level params (script < account < task) to the run', async () => {
    const parametric = script('p1', { params: [
      { key: 'who', label: '谁', type: 'string', default: 'script' },
      { key: 'keep', label: '保留', type: 'string', default: 'script' },
      { key: 'n', label: '次数', type: 'number', default: 1 },
    ] });
    const owner = account(1, 0, { scriptParams: { p1: { who: 'account', keep: 'account' } } });
    const w = await scenario([plan(1, [task('t1', 'p1', { params: { who: 'task' } })])], [owner], [parametric],
      { preemptGraceMs: 12_000, aiAssist: false });
    await eventually(() => w.started.length === 1);
    expect(w.graces).toEqual([12_000]);
    expect(w.started[0]).toMatchObject({ aiAssist: false, params: { who: 'task', keep: 'account', n: 1 }, source: 'plan', taskId: 't1' });
    expect(w.started[0]?.maxRunMs).toBe(30 * MIN);
  });

  it('the AI module reads PlanConfig.aiAssist live (composition root: planAiAssist → aiAssistEnabled)', async () => {
    const w = await scenario([], [account(1, 0)], [script('s1')]);
    const deviceTouched: string[] = [];
    const ai = new AiRecoveryService({
      gameId: GAME, packageName: PKG,
      advisor: {
        isActive: () => true,
        consultFrame: async () => { throw new Error('不该问到模型'); },
        claimConfirmation: () => false, note: () => undefined,
        settings: () => ({ minConfidence: 0.7, autoActions: true, autoHarvest: false }),
      },
      manager: {
        getState: async () => { deviceTouched.push('getState'); throw new Error('离线自检：不碰设备'); },
        device: async () => { throw new Error('离线自检：不碰设备'); },
      },
      instanceTemplateSet: async () => null,
      loadTemplateSet: async () => { throw new Error('unused'); },
      recognize: async () => false,
      match: async () => [],
      updateVerdict: async () => ({ target: null, downloading: false, progress: false }),
      saveTemplate: async () => { throw new Error('unused'); },
      planAiAssist: (gameId) => w.service.aiAssistEnabled(gameId),
      log: () => undefined,
    });
    const request = {
      gameId: GAME, runId: 'r1', instanceIndex: 0, instanceIdentity: 'identity-0', scriptId: 's1', templateSetId: null, templateDir: null,
      stepId: 'tap-1', reason: '等不到按钮', expectTemplateIds: [], signal: new AbortController().signal,
    };
    expect(await w.service.aiAssistEnabled(GAME)).toBe(true);
    await ai.assistScript(request);
    expect(deviceTouched).toEqual(['getState']);
    // Switched off in 「计划设置」: the next consult of a run already going is refused before the device is touched.
    await w.service.saveConfig(GAME, { aiAssist: false });
    expect(await w.service.aiAssistEnabled(GAME)).toBe(false);
    expect(await ai.assistScript(request)).toMatchObject({ handled: false, message: expect.stringContaining('关掉了') });
    expect(deviceTouched).toEqual(['getState']);
  });

  it('pushes plan-changed overviews with flattened rows, queue views and orphan warnings', async () => {
    const w = await scenario([plan(1, [task('t1', 's1', { trigger: { kind: 'manual' } })]), plan(9, [task('gone', 'missing-script')])],
      [account(1, 0)], [script('s1')]);
    await w.service.runNow(GAME, accountId(1), 't1');
    await eventually(() => w.changes.some((item) => item.tasks.some((row) => row.taskId === 't1' && row.phase === 'running')));
    const latest = w.changes.at(-1)!;
    expect(latest.gameId).toBe(GAME);
    const orphan = latest.tasks.find((row) => row.taskId === 'gone')!;
    expect(orphan).toMatchObject({ accountName: '（账号已删除）', accountMissing: true, accountIssue: '账号已删除', scriptName: null, instanceIndex: null });
    expect(latest.queues).toEqual([expect.objectContaining({ instanceIndex: 0, runningTaskId: 't1', running: expect.objectContaining({ accountId: accountId(1) }) })]);
    // An orphaned task can still be deleted; its plan entry goes with the last task.
    const after = await w.service.removeTask(GAME, accountId(9), 'gone');
    expect(after.plans.map((item) => item.accountId)).toEqual([accountId(1)]);
    await expect(w.service.runNow(GAME, accountId(9), 'gone')).rejects.toThrow('刷新一下再试');
  });

  it('removing or disabling a task in a saved plan drops its queued round', async () => {
    const w = await scenario([plan(1, [task('t1', 's1', { priority: 90 }), task('t2', 's2', { priority: 10 })])],
      [account(1, 0)], [script('s1'), script('s2')]);
    await eventually(() => w.started.length === 1);
    await eventually(async () => (await w.row('t2')).phase === 'queued');
    await w.service.savePlan(GAME, plan(1, [task('t1', 's1', { priority: 90 })]));
    const overview = await w.overview();
    expect(overview.queues[0]?.waitingTaskIds).toEqual([]);
    expect(overview.runs.find((item) => item.taskId === 't2')).toMatchObject({ status: 'cancelled' });
  });

  it('★ a round waiting for a busy instance lease stays 排队中 and starts (执行中) once the lease frees', async () => {
    const w = await scenario([plan(1, [task('t1', 's1', { trigger: { kind: 'manual' } })])], [account(1, 0)], [script('s1')], { queueWaitMs: 30 * MIN });
    const other = await holdLease(w.home, 0, '登录');
    await w.service.runNow(GAME, accountId(1), 't1');
    await eventually(() => w.trace.includes('yield:0'));
    await pause(400);
    expect(w.started).toHaveLength(0);
    expect(await w.row('t1')).toMatchObject({ phase: 'queued', nextRunAt: null });
    expect((await w.row('t1')).queuedAt).not.toBeNull();
    // The queue view lists it first among the waiting rounds, not as the running one.
    expect((await w.overview()).queues).toEqual([expect.objectContaining({ instanceIndex: 0, running: null, runningTaskId: null, waitingTaskIds: ['t1'] })]);
    await other.release();
    await eventually(() => w.started.length === 1);
    expect((await w.row('t1')).phase).toBe('running');
    expect((await w.overview()).queues).toEqual([expect.objectContaining({ runningTaskId: 't1', waitingTaskIds: [] })]);
    w.finish(w.started[0]!.runId, 'succeeded');
    await eventually(async () => (await w.row('t1')).phase === 'done');
  });

  it('★ 停止 / 删除 / 关开关 / 退出 never wait out queueWaitMs while a round waits for the instance lease', async () => {
    const w = await scenario([plan(1, [task('t1', 's1', { trigger: { kind: 'manual' } }), task('t2', 's2', { trigger: { kind: 'manual' } })])],
      [account(1, 0)], [script('s1'), script('s2')], { queueWaitMs: 30 * MIN });
    const other = await holdLease(w.home, 0, '手动采集一轮');
    try {
      const waitingFor = async (taskId: string): Promise<void> => {
        await w.service.runNow(GAME, accountId(1), taskId);
        await eventually(() => count(w.trace, 'yield:0') > count(w.trace, 'restore:0'));
        await pause(300);
      };
      const timed = async (work: () => Promise<unknown>): Promise<number> => {
        const began = Date.now();
        await work();
        return Date.now() - began;
      };

      // 停止 (the row's stop button).
      await waitingFor('t1');
      expect(await timed(() => w.service.cancelTask(GAME, accountId(1), 't1'))).toBeLessThan(2_000);
      expect((await w.row('t1')).phase).toBe('idle');
      expect((await w.overview()).runs[0]).toMatchObject({ taskId: 't1', status: 'cancelled', startedAt: null, message: '用户取消排队' });
      await eventually(() => count(w.trace, 'restore:0') === count(w.trace, 'yield:0'));

      // Switching the task off takes it back like a queued round.
      await waitingFor('t1');
      expect(await timed(() => w.service.setTaskEnabled(GAME, accountId(1), 't1', false))).toBeLessThan(2_000);
      expect((await w.overview()).runs[0]).toMatchObject({ taskId: 't1', status: 'cancelled', message: '任务已关闭，排队取消' });

      // 删除 (the row's delete button).
      await waitingFor('t1');
      expect(await timed(() => w.service.removeTask(GAME, accountId(1), 't1'))).toBeLessThan(2_000);
      expect((await w.overview()).tasks.map((row) => row.taskId)).toEqual(['t2']);

      // Quitting the assistant.
      await waitingFor('t2');
      expect(await timed(() => w.service.shutdown())).toBeLessThan(2_000);
      expect((await w.service.store.overview(GAME)).runs[0]).toMatchObject({ taskId: 't2', status: 'cancelled', message: '助手正在退出' });
      expect(w.started).toHaveLength(0);
      expect(count(w.trace, 'restore:0')).toBe(count(w.trace, 'yield:0'));
    } finally {
      await other.release();
    }
  });

  it('a claimed round that loses the race to 「立即运行」 is closed as cancelled (never left 排队中) and its claim released', async () => {
    const w = await scenario([plan(1, [task('t1', 's1')])], [account(1, 0)], [script('s1')], { enabled: false });
    const claim = w.service.store.claimScheduled.bind(w.service.store);
    let raced = false;
    vi.spyOn(w.service.store, 'claimScheduled').mockImplementation(async (...args) => {
      const claimed = await claim(...args);
      if (claimed && !raced) {
        raced = true;
        // A 「立即运行」 click lands while the planner was waiting for its claim to be written.
        await w.service.runNow(GAME, accountId(1), 't1');
      }
      return claimed;
    });
    await w.service.saveConfig(GAME, { enabled: true });
    await eventually(() => w.started.length === 1);
    await eventually(async () => (await w.overview()).runs.some((run) => run.origin === 'schedule' && run.status === 'cancelled'));
    const { runs, runtime } = await w.overview();
    const scheduled = runs.filter((run) => run.origin === 'schedule');
    expect(scheduled).toEqual([expect.objectContaining({ status: 'cancelled', message: '同一任务已在队列里', startedAt: null })]);
    expect(runs.filter((run) => run.status === 'queued')).toEqual([]);
    expect(runtime.find((row) => row.taskId === 't1')?.lastClaimedAt).toBeNull();
    expect(w.started[0]?.source).toBe('plan');
  });

  it('starts on a damaged plans.json (repaired, backed up, warned) instead of blocking startup', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'wanlong-plan-offline-'));
    const file = path.join(home, 'automation', 'games', GAME, 'plans.json');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '{ 这不是 JSON');
    const port: PlanHostPort = {
      accounts: async () => [], instance: async () => ({ status: 'running', record: { createdAt: 'x' } }), templateDir: async () => '',
      device: async () => fakeScriptDevice(),
    };
    const service = new PlanService(home, port, new ScriptRunner(home, port, { workerFactory: inProcessWorkers({ vision: fakeVision() }).factory, pacing: FAST_PACING }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await service.start(GAME);
      const overview = await service.overview(GAME);
      expect(overview.plans).toEqual([]);
      expect(overview.warnings.join('')).toContain('不是合法 JSON');
      expect(overview.warnings.join('')).toContain('已备份为');
    } finally {
      warn.mockRestore();
      await service.shutdown();
      await rm(home, { recursive: true, force: true });
    }
  });
});
