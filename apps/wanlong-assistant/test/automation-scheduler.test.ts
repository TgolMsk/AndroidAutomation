import { mkdtemp, readFile, readdir, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutomationScheduler, SchedulePauseError, type ScheduledAutomation } from '../src/main/automation/scheduler';

const START = Date.parse('2026-09-23T12:00:00.000Z');

async function until(check: () => Promise<boolean> | boolean): Promise<void> {
  for (let attempt = 0; attempt < 5_000; attempt++) {
    if (await check()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('Expected asynchronous scheduler transition did not occur');
}

describe('AutomationScheduler', () => {
  let work: string;
  let home: string;
  let schedulers: AutomationScheduler[];

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(START);
    work = await mkdtemp(path.join(tmpdir(), 'avdm-automation-scheduler-'));
    home = path.join(work, 'home');
    schedulers = [];
  });

  afterEach(async () => {
    await Promise.all(schedulers.map((scheduler) => scheduler.dispose()));
    vi.useRealTimers();
    await rm(work, { recursive: true, force: true });
  });

  function make(run: ConstructorParameters<typeof AutomationScheduler>[1], options?: ConstructorParameters<typeof AutomationScheduler>[2]): AutomationScheduler {
    const scheduler = new AutomationScheduler(home, run, options);
    schedulers.push(scheduler);
    return scheduler;
  }

  function stateFile(gameId: string, index: number): string {
    return path.join(home, 'automation', 'scheduler', gameId, `${index}.json`);
  }

  it('persists private atomic state and only restores plans that were explicitly enabled', async () => {
    const first = make(async () => ({ nextWakeAt: null }));
    await first.enable('wanlong', 1, START + 60_000);
    await first.disable('wanlong', 2);
    const file = stateFile('wanlong', 1);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      version: 1, gameId: 'wanlong', index: 1, enabled: true, nextWakeAt: START + 60_000, failureCount: 0,
    });
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await readdir(path.dirname(file))).sort()).toEqual(['1.json', '2.json']);
    await first.dispose();

    const calls: number[] = [];
    const restored = make(async ({ index }) => { calls.push(index); return { nextWakeAt: null }; });
    expect(await restored.restore()).toEqual([
      { gameId: 'wanlong', index: 1, enabled: true, nextWakeAt: START + 60_000, failureCount: 0 },
      { gameId: 'wanlong', index: 2, enabled: false, nextWakeAt: null, failureCount: 0 },
    ]);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await until(async () => (await restored.get('wanlong', 1)).nextWakeAt === null);
    expect(calls).toEqual([1]);
    expect((await restored.get('wanlong', 2)).enabled).toBe(false);
  });

  it('schedules the returned wake once and moves past wake times forward to avoid tight loops', async () => {
    let calls = 0;
    const scheduler = make(async () => {
      calls++;
      return { nextWakeAt: calls === 1 ? START + 5_000 : START - 1 };
    }, { minCycleDelayMs: 1_000 });
    await scheduler.enable('wanlong', 0, START);
    await vi.advanceTimersByTimeAsync(0);
    await until(async () => (await scheduler.get('wanlong', 0)).nextWakeAt === START + 5_000);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await until(async () => (await scheduler.get('wanlong', 0)).nextWakeAt === START + 6_000);
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toBe(2);
  });

  it('backs off failed runs exponentially with a fixed upper bound', async () => {
    let calls = 0;
    const states: ScheduledAutomation[] = [];
    const scheduler = make(async () => { calls++; throw new Error('device offline'); }, {
      backoffBaseMs: 100,
      backoffMaxMs: 400,
      onStateChange: (state) => states.push(state),
    });
    await scheduler.enable('wanlong', 3, START);
    for (const [failure, delay] of [[1, 100], [2, 200], [3, 400], [4, 400]] as const) {
      if (failure > 1) await vi.advanceTimersByTimeAsync(states.at(-1)!.nextWakeAt! - Date.now());
      else await vi.advanceTimersByTimeAsync(0);
      await until(async () => (await scheduler.get('wanlong', 3)).failureCount === failure);
      expect((await scheduler.get('wanlong', 3)).nextWakeAt).toBe(Date.now() + delay);
      expect(calls).toBe(failure);
    }
    expect(JSON.parse(await readFile(stateFile('wanlong', 3), 'utf8')).failureCount).toBe(4);
  });

  it('pauses after eight consecutive failures and does not retry after restart', async () => {
    let calls = 0;
    const errors: string[] = [];
    const scheduler = make(async () => { calls++; throw new Error('not in foreground'); }, {
      backoffBaseMs: 10,
      backoffMaxMs: 20,
      onError: (_context, error) => errors.push(error instanceof Error ? error.message : String(error)),
    });
    await scheduler.enable('wanlong', 6, START);
    for (let failure = 1; failure <= 8; failure++) {
      const state = await scheduler.get('wanlong', 6);
      await vi.advanceTimersByTimeAsync(Math.max(0, (state.nextWakeAt ?? Date.now()) - Date.now()));
      await until(async () => (await scheduler.get('wanlong', 6)).failureCount === failure);
    }
    expect(calls).toBe(8);
    expect(await scheduler.get('wanlong', 6)).toEqual({
      gameId: 'wanlong', index: 6, enabled: false, nextWakeAt: null, failureCount: 8,
    });
    expect(errors.at(-1)).toContain('连续 8 次失败');
    await scheduler.dispose();
    const restored = make(async () => { calls++; return { nextWakeAt: null }; });
    await restored.restore();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toBe(8);
  });

  it('stops immediately when a game safety circuit opens', async () => {
    let calls = 0;
    const scheduler = make(async () => { calls++; throw new SchedulePauseError('单轮截图上限'); });
    await scheduler.enable('wanlong', 1, START);
    await vi.advanceTimersByTimeAsync(0);
    await until(async () => (await scheduler.get('wanlong', 1)).enabled === false);
    expect(await scheduler.get('wanlong', 1)).toEqual({
      gameId: 'wanlong', index: 1, enabled: false, nextWakeAt: null, failureCount: 1,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toBe(1);
  });

  it('reserves an instance for one game and serializes concurrent enable requests', async () => {
    const scheduler = make(async () => ({ nextWakeAt: null }));
    const outcomes = await Promise.allSettled([
      scheduler.enable('wanlong', 5, START + 60_000),
      scheduler.enable('another-game', 5, START + 60_000),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    expect((await scheduler.list()).filter((item) => item.enabled && item.index === 5)).toHaveLength(1);
  });

  it('does not overlap a second wake with the callback already running on that instance', async () => {
    let started!: () => void;
    const firstStarted = new Promise<void>((resolve) => { started = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const scheduler = make(async () => {
      calls++;
      if (calls === 1) { started(); await gate; }
      return { nextWakeAt: null };
    });
    await scheduler.enable('wanlong', 2, START);
    await vi.advanceTimersByTimeAsync(0);
    await firstStarted;
    try {
      await scheduler.enable('wanlong', 2, START);
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toBe(1);
    } finally {
      release();
    }
    await scheduler.disable('wanlong', 2);
  });

  it('persists disable and waits for a running callback to observe cancellation and settle', async () => {
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let aborted = false;
    const scheduler = make(async ({ signal }) => {
      signal.addEventListener('abort', () => { aborted = true; }, { once: true });
      started();
      await gate;
      return { nextWakeAt: START + 100_000 };
    });
    await scheduler.enable('wanlong', 4, START);
    await vi.advanceTimersByTimeAsync(0);
    await startedPromise;

    let stopped = false;
    const stopping = scheduler.disable('wanlong', 4).then((state) => { stopped = true; return state; });
    try {
      await until(async () => (await scheduler.get('wanlong', 4)).enabled === false);
      await until(() => aborted);
      expect(stopped).toBe(false);
      expect(JSON.parse(await readFile(stateFile('wanlong', 4), 'utf8')).enabled).toBe(false);
    } finally {
      release();
    }
    expect(await stopping).toEqual({ gameId: 'wanlong', index: 4, enabled: false, nextWakeAt: null, failureCount: 0 });
    await vi.advanceTimersByTimeAsync(200_000);
    expect((await scheduler.get('wanlong', 4)).nextWakeAt).toBe(null);
  });

  it('cannot re-enable an instance while disable is still waiting for its active run', async () => {
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let aborted = false;
    let calls = 0;
    const scheduler = make(async ({ signal }) => {
      calls++;
      signal.addEventListener('abort', () => { aborted = true; }, { once: true });
      started();
      await gate;
      return { nextWakeAt: START + 100_000 };
    });
    await scheduler.enable('wanlong', 4, START);
    await vi.advanceTimersByTimeAsync(0);
    await startedPromise;

    const stopping = scheduler.disable('wanlong', 4);
    try {
      await until(async () => (await scheduler.get('wanlong', 4)).enabled === false && aborted);
      await expect(scheduler.enable('wanlong', 4, START + 60_000)).rejects.toThrow('正在停止');
      expect(JSON.parse(await readFile(stateFile('wanlong', 4), 'utf8')).enabled).toBe(false);
    } finally {
      release();
    }
    expect((await stopping).enabled).toBe(false);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls).toBe(1);
    expect((await scheduler.get('wanlong', 4)).enabled).toBe(false);
    expect((await scheduler.enable('wanlong', 4, START + 180_000)).enabled).toBe(true);
  });

  it('rejects malformed persisted plans instead of arming an unsafe wake', async () => {
    const file = stateFile('wanlong', 7);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ version: 1, gameId: 'wanlong', index: 7, enabled: true, nextWakeAt: -1, failureCount: 0 }));
    const scheduler = make(async () => { throw new Error('must not execute'); });
    await expect(scheduler.restore()).rejects.toThrow('无法恢复调度状态');
  });
});
