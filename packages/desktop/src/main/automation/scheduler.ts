import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

const FILE_VERSION = 1;
const GAME_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_FILE_BYTES = 16 * 1024;
const MAX_TIMEOUT_MS = 2_147_483_647;

export interface ScheduledAutomation {
  gameId: string;
  index: number;
  enabled: boolean;
  nextWakeAt: number | null;
  failureCount: number;
}

export interface ScheduledRunContext {
  gameId: string;
  index: number;
  signal: AbortSignal;
}

export type ScheduledRunOnce = (context: ScheduledRunContext) => Promise<{ nextWakeAt: number | null }>;

export interface AutomationSchedulerOptions {
  now?: () => number;
  /** A returned wake in the past is moved forward by this much to prevent a tight loop. */
  minCycleDelayMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** Disable the plan after this many consecutive failures; defaults to eight. */
  maxConsecutiveFailures?: number;
  onStateChange?: (state: ScheduledAutomation) => void;
  onError?: (context: Omit<ScheduledRunContext, 'signal'>, error: unknown) => void;
}

interface ActiveRun {
  key: string;
  controller: AbortController;
  done: Promise<void>;
  resolveDone: () => void;
}

function assertKey(gameId: string, index: number): void {
  if (!GAME_ID_RE.test(gameId)) throw new Error('游戏包 ID 无效');
  if (!Number.isInteger(index) || index < 0 || index > 63) throw new Error('实例编号无效');
}

function finiteTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function keyOf(gameId: string, index: number): string { return `${gameId}:${index}`; }

function parseState(value: unknown, gameId: string, index: number): ScheduledAutomation {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('调度状态格式无效');
  const item = value as Record<string, unknown>;
  if (item.version !== FILE_VERSION || item.gameId !== gameId || item.index !== index ||
      typeof item.enabled !== 'boolean' ||
      (item.nextWakeAt !== null && !finiteTime(item.nextWakeAt)) ||
      !Number.isInteger(item.failureCount) || (item.failureCount as number) < 0 || (item.failureCount as number) > 32) {
    throw new Error('调度状态格式无效');
  }
  return {
    gameId, index, enabled: item.enabled, nextWakeAt: item.nextWakeAt as number | null,
    failureCount: item.failureCount as number,
  };
}

/** Persistent, per-instance wake scheduling. The injected runner owns game and device checks. */
export class AutomationScheduler {
  private readonly root: string;
  private readonly now: () => number;
  private readonly minCycleDelayMs: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly maxConsecutiveFailures: number;
  private readonly onStateChange?: AutomationSchedulerOptions['onStateChange'];
  private readonly onError?: AutomationSchedulerOptions['onError'];
  private readonly entries = new Map<string, ScheduledAutomation>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly activeByIndex = new Map<number, ActiveRun>();
  /** A disable stays in progress until its prior callback has fully settled. */
  private readonly stoppingByIndex = new Map<number, number>();
  private serial: Promise<void> = Promise.resolve();
  private loaded = false;
  private disposed = false;

  constructor(home: string, private readonly runOnce: ScheduledRunOnce, options: AutomationSchedulerOptions = {}) {
    if (!path.isAbsolute(home)) throw new Error('调度数据目录必须是绝对路径');
    this.root = path.join(home, 'automation', 'scheduler');
    this.now = options.now ?? Date.now;
    this.minCycleDelayMs = options.minCycleDelayMs ?? 1_000;
    this.backoffBaseMs = options.backoffBaseMs ?? 30_000;
    this.backoffMaxMs = options.backoffMaxMs ?? 5 * 60_000;
    this.maxConsecutiveFailures = options.maxConsecutiveFailures ?? 8;
    for (const [name, value] of [
      ['minCycleDelayMs', this.minCycleDelayMs], ['backoffBaseMs', this.backoffBaseMs], ['backoffMaxMs', this.backoffMaxMs],
    ] as const) {
      if (!finiteTime(value) || value < 1) throw new Error(`调度参数 ${name} 无效`);
    }
    if (this.backoffMaxMs < this.backoffBaseMs) throw new Error('最大退避不能小于初始退避');
    if (!Number.isInteger(this.maxConsecutiveFailures) || this.maxConsecutiveFailures < 1 || this.maxConsecutiveFailures > 32) {
      throw new Error('连续失败上限无效');
    }
    this.onStateChange = options.onStateChange;
    this.onError = options.onError;
  }

  /** Load saved plans once. Only explicitly enabled plans with a wake time are armed. */
  async restore(): Promise<ScheduledAutomation[]> {
    return this.mutate(async () => {
      this.assertOpen();
      if (!this.loaded) {
        const found = new Map<string, ScheduledAutomation>();
        for (const gameDir of await readdir(this.root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return [];
          throw error;
        })) {
          if (!gameDir.isDirectory() || !GAME_ID_RE.test(gameDir.name)) continue;
          const directory = path.join(this.root, gameDir.name);
          for (const item of await readdir(directory, { withFileTypes: true })) {
            if (!item.isFile() || !/^\d{1,2}\.json$/.test(item.name)) continue;
            const index = Number(item.name.slice(0, -5));
            if (index > 63) continue;
            const file = path.join(directory, item.name);
            try {
              if ((await stat(file)).size > MAX_FILE_BYTES) throw new Error('调度状态超过大小上限');
              const state = parseState(JSON.parse(await readFile(file, 'utf8')), gameDir.name, index);
              if (state.enabled && [...found.values()].some((other) => other.enabled && other.index === index)) {
                throw new Error(`实例 #${index} 存在多个已启用的游戏调度`);
              }
              found.set(keyOf(state.gameId, index), state);
            } catch (error) {
              throw new Error(`无法恢复调度状态 ${file}：${error instanceof Error ? error.message : String(error)}`);
            }
          }
        }
        for (const [key, state] of found) this.entries.set(key, state);
        this.loaded = true;
        for (const [key, state] of this.entries) this.arm(key, state);
      }
      return this.listLoaded();
    });
  }

  async list(): Promise<ScheduledAutomation[]> {
    await this.restore();
    return this.mutate(() => Promise.resolve(this.listLoaded()));
  }

  async get(gameId: string, index: number): Promise<ScheduledAutomation> {
    assertKey(gameId, index);
    await this.restore();
    return this.mutate(() => Promise.resolve({ ...this.entries.get(keyOf(gameId, index)) ?? this.empty(gameId, index) }));
  }

  /** Persist the intent before scheduling. A second game cannot own the same instance. */
  async enable(gameId: string, index: number, firstWakeAt = this.now()): Promise<ScheduledAutomation> {
    assertKey(gameId, index);
    if (!finiteTime(firstWakeAt)) throw new Error('唤醒时间无效');
    await this.restore();
    return this.mutate(async () => {
      this.assertOpen();
      if (this.stoppingByIndex.has(index)) throw new Error(`实例 #${index} 的自动化正在停止，请稍后再启用`);
      for (const state of this.entries.values()) {
        if (state.enabled && state.index === index && state.gameId !== gameId) {
          throw new Error(`实例 #${index} 已启用 ${state.gameId} 的调度`);
        }
      }
      const key = keyOf(gameId, index);
      const next: ScheduledAutomation = { gameId, index, enabled: true, nextWakeAt: firstWakeAt, failureCount: 0 };
      await this.save(next);
      this.entries.set(key, next);
      this.arm(key, next);
      this.emitState(next);
      return { ...next };
    });
  }

  /** Persist disabled state, abort this plan's callback, then wait until it has settled. */
  async disable(gameId: string, index: number): Promise<ScheduledAutomation> {
    assertKey(gameId, index);
    await this.restore();
    const key = keyOf(gameId, index);
    let activeToCancel: ActiveRun | undefined;
    const next = await this.mutate(async () => {
      this.assertOpen();
      const state: ScheduledAutomation = { gameId, index, enabled: false, nextWakeAt: null, failureCount: 0 };
      await this.save(state);
      this.entries.set(key, state);
      this.arm(key, state);
      const active = this.activeByIndex.get(index);
      if (active?.key === key) {
        activeToCancel = active;
        this.stoppingByIndex.set(index, (this.stoppingByIndex.get(index) ?? 0) + 1);
      }
      this.emitState(state);
      return state;
    });
    if (activeToCancel) {
      try {
        activeToCancel.controller.abort(new Error('调度已停止'));
        await activeToCancel.done;
      } finally {
        const pending = this.stoppingByIndex.get(index) ?? 0;
        if (pending <= 1) this.stoppingByIndex.delete(index);
        else this.stoppingByIndex.set(index, pending - 1);
      }
    }
    return { ...next };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    const active = [...this.activeByIndex.values()];
    for (const run of active) run.controller.abort(new Error('调度器已关闭'));
    await Promise.all(active.map((run) => run.done));
  }

  private empty(gameId: string, index: number): ScheduledAutomation {
    return { gameId, index, enabled: false, nextWakeAt: null, failureCount: 0 };
  }

  private listLoaded(): ScheduledAutomation[] {
    return [...this.entries.values()].map((state) => ({ ...state })).sort((a, b) => a.index - b.index || a.gameId.localeCompare(b.gameId));
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error('调度器已关闭');
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.serial;
    let release!: () => void;
    this.serial = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); }
    finally { release(); }
  }

  private arm(key: string, state: ScheduledAutomation): void {
    const old = this.timers.get(key);
    if (old) clearTimeout(old);
    this.timers.delete(key);
    if (this.disposed || !state.enabled || state.nextWakeAt === null) return;
    const delay = Math.min(MAX_TIMEOUT_MS, Math.max(0, state.nextWakeAt - this.now()));
    const timer = setTimeout(() => {
      this.timers.delete(key);
      void this.fire(key).catch((error: unknown) => this.emitError(state, error));
    }, delay);
    timer.unref?.();
    this.timers.set(key, timer);
  }

  private async fire(key: string): Promise<void> {
    let started: { state: ScheduledAutomation; run: ActiveRun } | undefined;
    let occupying: Promise<void> | undefined;
    await this.mutate(async () => {
      const state = this.entries.get(key);
      if (this.disposed || !state?.enabled || state.nextWakeAt === null) return;
      if (state.nextWakeAt > this.now()) { this.arm(key, state); return; }
      const active = this.activeByIndex.get(state.index);
      if (active) { occupying = active.done; return; }
      let resolveDone!: () => void;
      const done = new Promise<void>((resolve) => { resolveDone = resolve; });
      const run: ActiveRun = { key, controller: new AbortController(), done, resolveDone };
      this.activeByIndex.set(state.index, run);
      started = { state, run };
    });
    if (occupying) {
      await occupying;
      await this.mutate(async () => {
        const state = this.entries.get(key);
        if (state) this.arm(key, state);
      });
    }
    if (started) void this.execute(started.state, started.run);
  }

  private async execute(state: ScheduledAutomation, run: ActiveRun): Promise<void> {
    const context = { gameId: state.gameId, index: state.index };
    try {
      if (run.controller.signal.aborted) return;
      const result = await this.runOnce({ ...context, signal: run.controller.signal });
      if (result === null || typeof result !== 'object' ||
          (result.nextWakeAt !== null && !finiteTime(result.nextWakeAt))) {
        throw new Error('运行结果缺少有效的 nextWakeAt');
      }
      if (run.controller.signal.aborted) return;
      await this.mutate(async () => {
        if (this.disposed || this.entries.get(run.key) !== state) return;
        const nextWakeAt = result.nextWakeAt === null ? null : Math.max(result.nextWakeAt, this.now() + this.minCycleDelayMs);
        const next: ScheduledAutomation = { ...state, nextWakeAt, failureCount: 0 };
        await this.save(next);
        this.entries.set(run.key, next);
        this.arm(run.key, next);
        this.emitState(next);
      });
    } catch (error) {
      if (!run.controller.signal.aborted) {
        try {
          await this.mutate(async () => {
            if (this.disposed || this.entries.get(run.key) !== state) return;
            const failureCount = Math.min(32, state.failureCount + 1);
            const disabled = failureCount >= this.maxConsecutiveFailures;
            const delay = Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** Math.min(20, failureCount - 1));
            const next: ScheduledAutomation = {
              ...state, enabled: !disabled, failureCount, nextWakeAt: disabled ? null : this.now() + delay,
            };
            await this.save(next);
            this.entries.set(run.key, next);
            this.arm(run.key, next);
            this.emitState(next);
          });
        } catch (persistError) {
          this.emitError(state, persistError);
        }
        this.emitError(state, this.entries.get(run.key)?.enabled === false
          ? new Error(`连续 ${this.maxConsecutiveFailures} 次失败，自动调度已暂停：${error instanceof Error ? error.message : String(error)}`)
          : error);
      }
    } finally {
      if (this.activeByIndex.get(state.index) === run) this.activeByIndex.delete(state.index);
      run.resolveDone();
    }
  }

  private emitState(state: ScheduledAutomation): void {
    try { this.onStateChange?.({ ...state }); } catch { /* Observers cannot break scheduling. */ }
  }

  private emitError(state: ScheduledAutomation, error: unknown): void {
    try { this.onError?.({ gameId: state.gameId, index: state.index }, error); } catch { /* Same isolation. */ }
  }

  private async save(state: ScheduledAutomation): Promise<void> {
    const file = path.join(this.root, state.gameId, `${state.index}.json`);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const json = JSON.stringify({ version: FILE_VERSION, ...state }, null, 2) + '\n';
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temp, 'wx', 0o600);
      try { await handle.writeFile(json); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temp, file);
      await chmod(file, 0o600);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
