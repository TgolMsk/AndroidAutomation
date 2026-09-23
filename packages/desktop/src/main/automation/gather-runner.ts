import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import path, { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { withFileLock, type RawScreencapFrame } from '@avdm/core';
import type { AndroidKey, ProbeReport, RawFrame } from '@avdm/automation';
import {
  createRuntimeState,
  normalizeGatherConfig,
  wanlongPlugin,
  type GatherConfig,
  type GatherCycleResult,
  type GatherRuntimeState,
} from '@avdm/automation/wanlong';
import { inspectGatherProbe } from './gather-probe-guard';

const GAME_ID = 'wanlong';
const STATE_VERSION = 1;
const MAX_STATE_BYTES = 512 * 1024;
const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const ABORT_GRACE_MS = 5_000;
const COORD_RE = /^\d{1,5},\d{1,5}$/;
const RESOURCES = ['wood', 'gold', 'iron', 'mana'] as const;
const STATUSES = ['gathering', 'gatherMarching', 'returning', 'unknown'] as const;

/** Only the methods needed from AvdManager.device(index). */
export interface GatherAdbDevice {
  screencapRaw(): Promise<RawScreencapFrame>;
  foregroundPackage(): Promise<string | undefined>;
  tap(x: number, y: number): Promise<void>;
  swipe(x1: number, y1: number, x2: number, y2: number, durationMs: number): Promise<void>;
  keyevent(key: AndroidKey): Promise<void>;
  startApp(packageName: string): Promise<void>;
  stopApp(packageName: string): Promise<void>;
}

/** AvdManager satisfies this contract; the narrow shape makes the boundary testable. */
export interface GatherManager {
  getState(index: number): Promise<{ status: string; record: { createdAt: string } }>;
  device(index: number): Promise<GatherAdbDevice>;
}

export interface RunGatherOnceOptions {
  /** Explicit local directory containing manifest.json; templates never enter the repository. */
  templateDir: string;
  config: Parameters<typeof normalizeGatherConfig>[0];
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type GatherDeviceRequest =
  | { type: 'request'; id: number; op: 'capture' | 'foregroundPackage'; args: [] }
  | { type: 'request'; id: number; op: 'tap'; args: [number, number] }
  | { type: 'request'; id: number; op: 'swipe'; args: [number, number, number, number, number] }
  | { type: 'request'; id: number; op: 'key'; args: [AndroidKey] }
  | { type: 'request'; id: number; op: 'launchApp'; args: [string, boolean?] }
  | { type: 'request'; id: number; op: 'stopApp'; args: [string] };

export type GatherWorkerToMain = GatherDeviceRequest
  | { type: 'ready'; probe: ProbeReport }
  | { type: 'result'; result: GatherCycleResult }
  | { type: 'failed'; error: string };

export type GatherMainToWorker =
  | { type: 'start'; templateDir: string; config: GatherConfig; state: GatherRuntimeState; instanceIndex: number }
  | { type: 'response'; id: number; ok: true; value?: unknown }
  | { type: 'response'; id: number; ok: false; error: string }
  | { type: 'approved' }
  | { type: 'abort'; reason: string };

interface GatherWorkerLike {
  on(event: 'message', listener: (message: GatherWorkerToMain) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
  postMessage(message: GatherMainToWorker, transferList?: ArrayBuffer[]): void;
  terminate(): Promise<number>;
}

interface ActiveRun {
  controller: AbortController;
  done: Promise<void>;
  worker?: GatherWorkerLike;
}

const activeKeys = new Set<string>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function optionalNumber(value: unknown): value is number | null {
  return value === null || nonnegative(value);
}

function isResource(value: unknown): value is typeof RESOURCES[number] {
  return typeof value === 'string' && (RESOURCES as readonly string[]).includes(value);
}

/** Reject malformed or oversized state rather than feeding it to the game state machine. */
function parseRuntimeState(value: unknown): GatherRuntimeState {
  if (!isRecord(value) || !isRecord(value.levelByResource) || !Array.isArray(value.dispatchTimestamps) ||
    !Array.isArray(value.inFlight) || !isRecord(value.travelTimeByCoord) || !isRecord(value.resourceByCoord) ||
    !nonnegative(value.backoffIndex) || !optionalNumber(value.giveUpUntil) || !optionalNumber(value.lastPanelSampledAt)) {
    throw new Error('采集运行状态格式无效');
  }
  const levelByResource: GatherRuntimeState['levelByResource'] = {};
  for (const [resource, memory] of Object.entries(value.levelByResource)) {
    if (!isResource(resource) || !isRecord(memory) || !optionalNumber(memory.maxLevel) ||
      !optionalNumber(memory.probedAt) || !optionalNumber(memory.noResultFloor) || !optionalNumber(memory.noResultAt)) {
      throw new Error('采集等级记忆格式无效');
    }
    levelByResource[resource] = {
      maxLevel: memory.maxLevel,
      probedAt: memory.probedAt,
      noResultFloor: memory.noResultFloor,
      noResultAt: memory.noResultAt,
    };
  }
  if (value.dispatchTimestamps.length > 10_000 || !value.dispatchTimestamps.every(nonnegative) || value.inFlight.length > 100) {
    throw new Error('采集运行状态记录过多或格式无效');
  }
  const inFlight: GatherRuntimeState['inFlight'] = value.inFlight.map((row: unknown) => {
    if (!isRecord(row) || !nonnegative(row.rowIndex) || !(row.coord === null || (typeof row.coord === 'string' && COORD_RE.test(row.coord))) ||
      typeof row.status !== 'string' || !(STATUSES as readonly string[]).includes(row.status) ||
      !optionalNumber(row.remainingSec) || !nonnegative(row.sampledAt) || !optionalNumber(row.travelTimeSec) ||
      !optionalNumber(row.etaAt) || !optionalNumber(row.freeAt) || typeof row.ownDispatch !== 'boolean' ||
      (row.resource !== undefined && !isResource(row.resource))) {
      throw new Error('在途部队记录格式无效');
    }
    return {
      rowIndex: row.rowIndex,
      coord: row.coord,
      status: row.status as typeof STATUSES[number],
      remainingSec: row.remainingSec,
      sampledAt: row.sampledAt,
      travelTimeSec: row.travelTimeSec,
      etaAt: row.etaAt,
      freeAt: row.freeAt,
      ...(row.resource === undefined ? {} : { resource: row.resource }),
      ownDispatch: row.ownDispatch,
    };
  });
  const travelTimeByCoord: Record<string, number> = {};
  for (const [coord, seconds] of Object.entries(value.travelTimeByCoord)) {
    if (!COORD_RE.test(coord) || !nonnegative(seconds)) throw new Error('行军时间记忆格式无效');
    travelTimeByCoord[coord] = seconds;
  }
  const resourceByCoord: GatherRuntimeState['resourceByCoord'] = {};
  for (const [coord, resource] of Object.entries(value.resourceByCoord)) {
    if (!COORD_RE.test(coord) || !isResource(resource)) throw new Error('资源坐标记忆格式无效');
    resourceByCoord[coord] = resource;
  }
  return {
    levelByResource,
    backoffIndex: value.backoffIndex,
    giveUpUntil: value.giveUpUntil,
    dispatchTimestamps: [...value.dispatchTimestamps],
    inFlight,
    lastPanelSampledAt: value.lastPanelSampledAt,
    travelTimeByCoord,
    resourceByCoord,
  };
}

/** Per-instance state survives app restarts, but is reset when the AVD at that index changes. */
export class GatherRuntimeStore {
  constructor(readonly home: string) {
    if (!path.isAbsolute(home)) throw new Error('AVDM home 必须是绝对路径');
  }

  fileFor(index: number): string {
    assertIndex(index);
    return join(this.home, 'automation', GAME_ID, 'state', `${index}.json`);
  }

  async load(index: number, instanceCreatedAt: string): Promise<GatherRuntimeState> {
    const file = this.fileFor(index);
    let json: string;
    try {
      const size = (await stat(file)).size;
      if (size > MAX_STATE_BYTES) throw new Error('采集运行状态超过 512 KB');
      json = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return createRuntimeState();
      throw error;
    }
    let value: unknown;
    try { value = JSON.parse(json); }
    catch { throw new Error(`采集运行状态 JSON 无效：${file}`); }
    if (!isRecord(value) || value.version !== STATE_VERSION || typeof value.instanceCreatedAt !== 'string') {
      throw new Error(`采集运行状态版本不兼容：${file}`);
    }
    if (value.instanceCreatedAt !== instanceCreatedAt) return createRuntimeState();
    return parseRuntimeState(value.state);
  }

  async save(index: number, instanceCreatedAt: string, state: GatherRuntimeState): Promise<void> {
    const file = this.fileFor(index);
    const value = { version: STATE_VERSION, instanceCreatedAt, state: parseRuntimeState(state) };
    const json = JSON.stringify(value, null, 2) + '\n';
    if (Buffer.byteLength(json) > MAX_STATE_BYTES) throw new Error('采集运行状态超过 512 KB');
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
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

function assertIndex(index: number): void {
  if (!Number.isInteger(index) || index < 0 || index > 63) throw new Error('实例编号无效');
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('采集已取消');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One G0–G16 cycle per instance. Vision and flow execute only in gather-worker.js. */
export class WanlongGatherRunner {
  private readonly active = new Map<number, ActiveRun>();
  private readonly store: GatherRuntimeStore;
  private readonly workerFactory: (entry: string) => GatherWorkerLike;

  constructor(private readonly manager: GatherManager, home: string, workerFactory?: (entry: string) => GatherWorkerLike) {
    this.store = new GatherRuntimeStore(home);
    this.workerFactory = workerFactory ?? ((entry) => new Worker(entry) as GatherWorkerLike);
  }

  isRunning(index: number): boolean { return this.active.has(index); }

  runOnce(index: number, options: RunGatherOnceOptions): Promise<GatherCycleResult> {
    assertIndex(index);
    const key = this.store.fileFor(index);
    if (activeKeys.has(key)) return Promise.reject(new Error(`实例 #${index} 已有采集任务在运行`));
    activeKeys.add(key);
    const controller = new AbortController();
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => { resolveDone = resolve; });
    const entry: ActiveRun = { controller, done };
    this.active.set(index, entry);
    const onExternalAbort = () => controller.abort(options.signal?.reason ?? new Error('采集已取消'));
    if (options.signal?.aborted) onExternalAbort();
    else options.signal?.addEventListener('abort', onExternalAbort, { once: true });
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > DEFAULT_TIMEOUT_MS) {
      options.signal?.removeEventListener('abort', onExternalAbort);
      this.active.delete(index);
      activeKeys.delete(key);
      resolveDone();
      return Promise.reject(new Error('采集超时参数无效'));
    }
    const timer = setTimeout(() => controller.abort(new Error('采集单轮超时')), timeoutMs);
    timer.unref?.();
    const lock = join(this.store.home, 'run', `automation-instance-${index}.lock`);
    return withFileLock(lock, () => this.execute(index, options, entry), { timeoutMs: 100 })
      .finally(() => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onExternalAbort);
        this.active.delete(index);
        activeKeys.delete(key);
        resolveDone();
      });
  }

  async stop(index: number): Promise<void> {
    const entry = this.active.get(index);
    if (!entry) return;
    entry.controller.abort(new Error('采集已取消'));
    await entry.done;
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.active.keys()].map((index) => this.stop(index)));
  }

  private async execute(index: number, options: RunGatherOnceOptions, entry: ActiveRun): Promise<GatherCycleResult> {
    const signal = entry.controller.signal;
    checkAbort(signal);
    const config = normalizeGatherConfig(options.config);
    if (!config.enabled) throw new Error('自动采集未启用');
    if (!options.templateDir || !path.isAbsolute(options.templateDir)) throw new Error('模板集目录必须是绝对路径');
    const templateDir = await realpath(options.templateDir);
    if (!(await stat(templateDir)).isDirectory()) throw new Error('模板路径不是目录');
    const instance = await this.manager.getState(index);
    if (instance.status !== 'running') throw new Error(`实例 #${index} 尚未就绪`);
    const adb = await this.manager.device(index);
    const foreground = await adb.foregroundPackage();
    if (foreground !== wanlongPlugin.packageName) throw new Error(`万龙觉醒未处于前台（当前：${foreground ?? '未知'}）`);
    checkAbort(signal);
    const state = await this.store.load(index, instance.record.createdAt);
    const result = await this.runWorker(index, templateDir, config, state, adb, entry);
    // A cycle can report an error after dispatching a troop. Preserve its returned bookkeeping.
    await this.store.save(index, instance.record.createdAt, result.state);
    return result;
  }

  private runWorker(
    index: number, templateDir: string, config: GatherConfig, state: GatherRuntimeState,
    adb: GatherAdbDevice, entry: ActiveRun,
  ): Promise<GatherCycleResult> {
    const workerPath = join(dirname(fileURLToPath(import.meta.url)), 'gather-worker.js');
    const worker = this.workerFactory(workerPath);
    entry.worker = worker;
    const signal = entry.controller.signal;
    let approved = false;
    let approvalPending = false;
    let settled = false;
    let deviceQueue: Promise<void> = Promise.resolve();
    let abortTimer: NodeJS.Timeout | undefined;
    return new Promise((resolve, reject) => {
      const queueDeviceCall = (operation: () => Promise<void>): Promise<void> => {
        const call = deviceQueue.then(operation);
        // The queue tail always resolves, while callers still receive the failure.
        deviceQueue = call.catch(() => undefined);
        return call;
      };
      const finish = (error?: Error, result?: GatherCycleResult) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        if (abortTimer) clearTimeout(abortTimer);
        // Discard queued writes after the worker has failed or returned. ADB calls
        // already started still have to finish before the instance lease is released.
        entry.controller.abort(error ?? new Error('采集工作线程已结束'));
        // ADB commands already in flight cannot be cancelled. Keep the instance lease
        // until every queued request settles so the next run cannot overlap an old tap.
        void (async () => {
          await deviceQueue;
          entry.worker = undefined;
          await worker.terminate().catch(() => undefined);
          if (error) reject(error);
          else if (result) resolve(result);
          else reject(new Error('采集工作线程未返回结果'));
        })();
      };
      const onAbort = () => {
        try { worker.postMessage({ type: 'abort', reason: errorMessage(signal.reason ?? new Error('采集已取消')) }); }
        catch { /* exit handler will settle */ }
        abortTimer = setTimeout(() => finish(signal.reason instanceof Error ? signal.reason : new Error('采集已取消')), ABORT_GRACE_MS);
        abortTimer.unref?.();
      };
      signal.addEventListener('abort', onAbort, { once: true });
      worker.on('message', (message) => {
        if (settled) return;
        if (message.type === 'request') {
          const wasApproved = approved;
          void queueDeviceCall(() => this.handleDeviceRequest(worker, adb, message, wasApproved, signal))
            .catch((error) => finish(error instanceof Error ? error : new Error(String(error))));
          return;
        }
        if (message.type === 'ready') {
          const decision = inspectGatherProbe(message.probe);
          if (approved || approvalPending || !decision.ok) {
            finish(new Error(decision.ok ? '采集探针重复上报' : decision.reason));
            return;
          }
          approvalPending = true;
          void queueDeviceCall(async () => {
            checkAbort(signal);
            await this.assertForeground(adb);
            checkAbort(signal);
            if (settled) return;
            approved = true;
            approvalPending = false;
            worker.postMessage({ type: 'approved' });
          }).catch((error) => finish(error instanceof Error ? error : new Error(String(error))));
          return;
        }
        if (message.type === 'result') {
          if (!approved) { finish(new Error('采集工作线程越过探针门槛')); return; }
          finish(undefined, message.result);
          return;
        }
        if (message.type === 'failed') finish(new Error(message.error));
      });
      worker.on('error', (error) => finish(error));
      worker.on('exit', (code) => finish(new Error(`采集工作线程已退出 (${code})`)));
      worker.postMessage({ type: 'start', templateDir, config, state, instanceIndex: index });
      if (signal.aborted) onAbort();
    });
  }

  private async handleDeviceRequest(
    worker: GatherWorkerLike, adb: GatherAdbDevice, request: GatherDeviceRequest,
    approved: boolean, signal: AbortSignal,
  ): Promise<void> {
    const reply = (value?: unknown, transfer?: ArrayBuffer[]) => worker.postMessage({ type: 'response', id: request.id, ok: true, value }, transfer);
    try {
      checkAbort(signal);
      if (request.op === 'foregroundPackage') { reply((await adb.foregroundPackage()) ?? null); return; }
      if (request.op === 'capture') {
        if (approved) await this.assertForeground(adb);
        const frame = await adb.screencapRaw();
        checkAbort(signal);
        const data = Uint8Array.from(frame.data);
        reply({ ...frame, data } satisfies RawFrame, [data.buffer]);
        return;
      }
      if (!approved) throw new Error('探针通过前禁止注入设备输入');
      checkAbort(signal);
      switch (request.op) {
        case 'tap': await this.assertForeground(adb); checkAbort(signal); await adb.tap(...request.args); break;
        case 'swipe': await this.assertForeground(adb); checkAbort(signal); await adb.swipe(...request.args); break;
        case 'key': await this.assertForeground(adb); checkAbort(signal); await adb.keyevent(...request.args); break;
        case 'launchApp': {
          const [packageName, cold] = request.args;
          if (packageName !== wanlongPlugin.packageName) throw new Error('禁止启动其他应用');
          checkAbort(signal);
          if (cold) await adb.stopApp(packageName);
          checkAbort(signal);
          await adb.startApp(packageName);
          await this.waitForForeground(adb, signal);
          break;
        }
        case 'stopApp': {
          const [packageName] = request.args;
          if (packageName !== wanlongPlugin.packageName) throw new Error('禁止停止其他应用');
          await this.assertForeground(adb);
          checkAbort(signal);
          await adb.stopApp(packageName);
          break;
        }
      }
      checkAbort(signal);
      reply();
    } catch (error) {
      worker.postMessage({ type: 'response', id: request.id, ok: false, error: errorMessage(error) });
    }
  }

  private async assertForeground(adb: GatherAdbDevice): Promise<void> {
    const foreground = await adb.foregroundPackage();
    if (foreground !== wanlongPlugin.packageName) throw new Error(`万龙觉醒已离开前台（当前：${foreground ?? '未知'}）`);
  }

  private async waitForForeground(adb: GatherAdbDevice, signal: AbortSignal): Promise<void> {
    const deadline = Date.now() + 60_000;
    for (;;) {
      checkAbort(signal);
      if (await adb.foregroundPackage() === wanlongPlugin.packageName) return;
      if (Date.now() >= deadline) throw new Error('启动万龙觉醒后 60 秒仍未进入前台');
      await new Promise<void>((resolve) => setTimeout(resolve, 1000));
    }
  }
}
