import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import path, { dirname, join } from 'node:path';
import type { MatchResult, ProbeReport, RawFrame } from '@avdm/automation';
import {
  FAILURE_SHOT_LABELS,
  createRuntimeState,
  cycleFactOf,
  normalizeGatherConfig,
  sanitizeLevelMemory,
  shouldKeepShot,
  wanlongPlugin,
  type GatherCycleFact,
  type GatherCycleResult,
  type GatherRuntimeState,
  type KickedProbeResult,
  type PanelSample,
  type SchedulerConfig,
  type ShotPolicy,
} from '@avdm/automation/wanlong';
import { SchedulerError, codeOf, messageOf } from '../scheduler/errors';
import { InstanceLocks } from '../scheduler/instance-lock';
import type { HealthFrame, LogLevel } from '../scheduler/types';
import { VisionWorkerPool, type VisionDevice, type VisionJobContext, type VisionWorkerLike } from '../scheduler/vision-pool';
import type { VisionQuery } from '../scheduler/vision-protocol';
import { inspectGatherProbe } from './gather-probe-guard';

const GAME_ID = 'wanlong';
const STATE_VERSION = 1;
const MAX_STATE_BYTES = 512 * 1024;
const DEFAULT_TIMEOUT_MS = 15 * 60_000;
/** A game-update wait may stretch one cycle up to this (the extra time is granted by suspended hook calls). */
const MAX_TIMEOUT_MS = 30 * 60_000;
/** Cold start (+180 s), an update-refreshed budget (+60 s) and slack on top of the sampler's own deadline. */
const SAMPLE_TIMEOUT_EXTRA_MS = 180_000 + 60_000 + 30_000;
const COORD_RE = /^\d{1,5},\d{1,5}$/;
const RESOURCES = ['wood', 'gold', 'iron', 'mana'] as const;
const STATUSES = ['gathering', 'gatherMarching', 'returning', 'unknown'] as const;

/** Only the methods needed from AvdManager.device(index). */
export type GatherAdbDevice = VisionDevice;

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
  /**
   * Cold-start recovery (monkey launch of the game, then look-only wait) when the game is not in front. On by default
   * (DECISIONS C) for scheduled cycles and explicit manual runs; the instance itself is never started here.
   */
  allowColdStart?: boolean;
  /** Screenshot retention; defaults to the gather config's `safety.shotPolicy`. */
  shotPolicy?: ShotPolicy;
  log?(level: LogLevel, message: string): void;
  /** Persist a failure scene; returns the saved path (relative to the data directory). */
  saveShot?(label: string, raw: RawFrame): Promise<string | null>;
  /** Second-layer kicked probe on the failure frame already captured (no extra screenshot). */
  probeKicked?(raw: RawFrame): Promise<KickedProbeResult | null>;
  /** Unknown-screen advisor at G0, before the blind BACK (AI / game update). true = the screen changed. */
  advise?(raw: RawFrame, attempt: number): Promise<boolean>;
}

/** A cycle result plus the facts only available while the cycle ran (failure shot, kicked probe, step). */
export interface GatherRunResult extends GatherCycleResult {
  fact: GatherCycleFact;
}

export interface SampleOnceOptions {
  templateDir: string;
  config: SchedulerConfig;
  deadlineAt: number;
  signal: AbortSignal;
  allowColdStart: boolean;
  onFrame?(raw: RawFrame): void;
  onCaptureFailed?(error: unknown): void;
  onUnrecognized?(raw: RawFrame): Promise<boolean | 'recovered' | 'updated'>;
  log?(level: LogLevel, message: string): void;
}

/** Options of a read-only template match on a frame main already holds (kicked probe, AI verification). */
export interface MatchQueryOptions {
  /** Overrides each template's own threshold. */
  threshold?: number;
  /** Reference-coordinate search region; defaults to each template's own ROI. */
  roi?: { x: number; y: number; w: number; h: number };
  signal?: AbortSignal;
}

/** The app shell's per-instance device lane (`DeviceLanes.run`): runs a check-then-act sequence as one unit. */
export type DeviceLaneRun = <T>(index: number, work: () => Promise<T>) => Promise<T>;

export interface WanlongGatherRunnerOptions {
  locks?: InstanceLocks;
  pool?: VisionWorkerPool;
  workerFactory?: (entry: string) => VisionWorkerLike;
  /**
   * Device lane of each instance. The manager's devices already route every adb call through the lanes (the
   * composition root passes the lane-wrapped `deviceHost`); this also keeps "check foreground → input" and the
   * health probe's "frame + foreground + pidof" together on the lane.
   */
  lane?: DeviceLaneRun;
}

interface ActiveRun {
  controller: AbortController;
  done: Promise<void>;
}

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

/**
 * Reject structurally corrupt state rather than feed it to the game state machine; per-resource level memory is
 * sanitized like the original loader (half entries and a legacy shared `maxLevel` are dropped, not fatal).
 */
function parseRuntimeState(value: unknown): GatherRuntimeState {
  if (!isRecord(value) || !Array.isArray(value.dispatchTimestamps) ||
    !Array.isArray(value.inFlight) || !isRecord(value.travelTimeByCoord) || !isRecord(value.resourceByCoord) ||
    !nonnegative(value.backoffIndex) || !optionalNumber(value.giveUpUntil) || !optionalNumber(value.lastPanelSampledAt) ||
    (value.levelByResource !== undefined && !isRecord(value.levelByResource))) {
    throw new Error('采集运行状态格式无效');
  }
  const levelByResource = sanitizeLevelMemory(value.levelByResource);
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
  private readonly writes = new Map<number, Promise<void>>();

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

  /** Writes to one instance's file are serialized; a corrupt file is replaced only by a valid document. */
  save(index: number, instanceCreatedAt: string, state: GatherRuntimeState): Promise<void> {
    const previous = this.writes.get(index) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.write(index, instanceCreatedAt, state));
    const tail = next.catch(() => undefined);
    this.writes.set(index, tail);
    void tail.then(() => { if (this.writes.get(index) === tail) this.writes.delete(index); });
    return next;
  }

  private async write(index: number, instanceCreatedAt: string, state: GatherRuntimeState): Promise<void> {
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

function stepOf(error: unknown): unknown {
  return (error as { detail?: { step?: unknown } } | null)?.detail?.step;
}

/**
 * One G0–G16 cycle, one troop-panel sample or one health frame per call. Vision runs in the long-lived per-instance
 * worker (templates compiled once); every device write goes through main, which enforces the probe gate, the
 * foreground package and the instance lease (`InstanceLocks`, re-entered when the scheduler already holds it).
 */
export class WanlongGatherRunner {
  readonly locks: InstanceLocks;
  private readonly active = new Map<number, ActiveRun>();
  private readonly store: GatherRuntimeStore;
  private readonly pool: VisionWorkerPool;
  private readonly lane: DeviceLaneRun | undefined;

  constructor(private readonly manager: GatherManager, home: string, options: WanlongGatherRunnerOptions = {}) {
    this.store = new GatherRuntimeStore(home);
    this.locks = options.locks ?? new InstanceLocks(home);
    this.pool = options.pool ?? new VisionWorkerPool(options.workerFactory ? { workerFactory: options.workerFactory } : {});
    this.lane = options.lane;
  }

  isRunning(index: number): boolean { return this.active.has(index); }

  /** Drop compiled templates in every worker (the manifest stamp check covers normal template-library edits). */
  invalidateTemplates(): void { this.pool.invalidate(); }

  runOnce(index: number, options: RunGatherOnceOptions): Promise<GatherRunResult> {
    assertIndex(index);
    if (this.active.has(index)) return Promise.reject(new Error(`实例 #${index} 已有采集任务在运行`));
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > MAX_TIMEOUT_MS) {
      return Promise.reject(new Error('采集超时参数无效'));
    }
    const controller = new AbortController();
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => { resolveDone = resolve; });
    this.active.set(index, { controller, done });
    const onExternalAbort = () => controller.abort(options.signal?.reason ?? new Error('采集已取消'));
    if (options.signal?.aborted) onExternalAbort();
    else options.signal?.addEventListener('abort', onExternalAbort, { once: true });
    return this.locks.run(index, '运行采集', () => this.execute(index, options, controller.signal, timeoutMs), { signal: controller.signal })
      .finally(() => {
        options.signal?.removeEventListener('abort', onExternalAbort);
        this.active.delete(index);
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
    await this.pool.dispose();
  }

  /** Read the troop panel (look, open, read, close). Never dispatches. */
  sample(index: number, options: SampleOnceOptions): Promise<PanelSample> {
    assertIndex(index);
    return this.locks.run(index, '读取部队管理面板', async () => {
      // No device at all counts as "no frame" for the freeze watchdog (original resolveDevice → onCaptureFailed).
      const onDeviceError = (error: unknown): void => {
        if (!options.signal.aborted) {
          try { options.onCaptureFailed?.(error); } catch { /* observers never break a sample */ }
        }
      };
      const { device, createdAt, templateDir } = await this.prepare(index, options.templateDir, options.signal, onDeviceError);
      const timeoutMs = Math.max(1000, options.deadlineAt - Date.now()) + SAMPLE_TIMEOUT_EXTRA_MS;
      const result = await this.pool.run(index, {
        kind: 'sample', instanceIndex: index, templateDir, config: options.config, deadlineAt: options.deadlineAt,
        allowColdStart: options.allowColdStart,
      }, {
        ...this.context(index, device, createdAt, options.signal, timeoutMs, options.allowColdStart),
        ...(options.log ? { log: options.log } : {}),
        ...(options.onFrame ? { onFrame: options.onFrame } : {}),
        ...(options.onCaptureFailed ? { onCaptureFailed: options.onCaptureFailed } : {}),
        ...(options.onUnrecognized ? { onUnrecognized: options.onUnrecognized } : {}),
      });
      if (result.kind !== 'sample') throw new SchedulerError('UNKNOWN', '视觉工作线程返回了错误的结果类型');
      return result.sample;
    }, { signal: options.signal });
  }

  /** Health probe: one frame, the foreground package and whether the game process is alive. No panel, no input. */
  async healthFrame(index: number, signal: AbortSignal): Promise<HealthFrame> {
    const instance = await this.manager.getState(index);
    if (instance.status !== 'running') throw new SchedulerError('DEVICE_NOT_READY', `实例 #${index} 未运行（${instance.status}）`);
    checkAbort(signal);
    const device = await this.manager.device(index);
    const probe = async (): Promise<HealthFrame> => {
      let raw: RawFrame;
      try { raw = await device.screencapRaw(); }
      catch (error) { throw new SchedulerError(codeOf(error) === 'UNKNOWN' ? 'COMMAND_FAILED' : codeOf(error), `ADB 截图失败: ${messageOf(error)}`); }
      checkAbort(signal);
      const foreground = (await device.foregroundPackage().catch(() => undefined)) ?? null;
      const running = device.isAppRunning ? await device.isAppRunning(wanlongPlugin.packageName).catch(() => null) : null;
      return { raw, foreground, running };
    };
    // The frame, the foreground package and pidof describe one moment: nothing else on the lane runs in between.
    return this.lane ? this.lane(index, probe) : probe();
  }

  /**
   * Whether a frame shows a known screen (world map, city, panels…), with the instance worker's cached templates.
   * ★ Answered even while that instance's sample or cycle is running (from a hook it awaits): a read-only query,
   * not a job. No device access, no lock.
   */
  async recognize(index: number, templateDir: string, raw: RawFrame, signal?: AbortSignal): Promise<boolean> {
    assertIndex(index);
    const result = await this.pool.query(index, { kind: 'recognize', templateDir: await realpath(templateDir), frame: raw }, signal);
    if (result.kind !== 'recognize') throw new SchedulerError('UNKNOWN', '视觉工作线程返回了错误的结果类型');
    return result.recognized;
  }

  /**
   * Match UI templates (by id) on a frame main already holds — the kicked probe on a failure frame, AI checks — with
   * the cached compiled set. Missing templates answer `found: false` (reason「模板缺失」), never throw. Same
   * read-only query path as `recognize`: also works inside a running job's hook.
   */
  async match(index: number, templateDir: string, raw: RawFrame, templateIds: string[], options: MatchQueryOptions = {}): Promise<MatchResult[]> {
    assertIndex(index);
    if (!Array.isArray(templateIds) || templateIds.length > 64 || !templateIds.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 128)) {
      throw new SchedulerError('INVALID_ARGUMENT', '模板 id 列表无效');
    }
    if (templateIds.length === 0) return [];
    const query: VisionQuery = {
      kind: 'match', templateDir: await realpath(templateDir), frame: raw, templateIds: [...templateIds],
      ...(options.threshold === undefined ? {} : { threshold: options.threshold }),
      ...(options.roi ? { roi: { ...options.roi } } : {}),
    };
    const result = await this.pool.query(index, query, options.signal);
    if (result.kind !== 'match') throw new SchedulerError('UNKNOWN', '视觉工作线程返回了错误的结果类型');
    return result.matches;
  }

  private async prepare(
    index: number, templateDir: string, signal: AbortSignal, onDeviceError?: (error: unknown) => void,
  ): Promise<{ device: GatherAdbDevice; createdAt: string; templateDir: string }> {
    checkAbort(signal);
    if (!templateDir || !path.isAbsolute(templateDir)) throw new Error('模板集目录必须是绝对路径');
    const dir = await realpath(templateDir);
    if (!(await stat(dir)).isDirectory()) throw new Error('模板路径不是目录');
    try {
      const instance = await this.manager.getState(index);
      if (instance.status !== 'running') throw new SchedulerError('DEVICE_NOT_READY', `实例 #${index} 尚未就绪`);
      const device = await this.manager.device(index);
      checkAbort(signal);
      return { device, createdAt: instance.record.createdAt, templateDir: dir };
    } catch (error) {
      if (!signal.aborted) onDeviceError?.(error);
      throw error;
    }
  }

  /** Main-side gate shared by every job: the probe decision, the game in front, the same AVD (at approval and before every input). */
  private context(index: number, device: GatherAdbDevice, createdAt: string, signal: AbortSignal, timeoutMs: number, allowColdStart: boolean): VisionJobContext {
    const assertInstance = async (): Promise<void> => {
      const now = await this.manager.getState(index);
      if (now.status !== 'running' || now.record.createdAt !== createdAt) {
        throw new SchedulerError('DEVICE_NOT_READY', `实例 #${index} 已停止或被替换`);
      }
    };
    const lane = this.lane;
    return {
      device,
      packageName: wanlongPlugin.packageName,
      signal,
      timeoutMs,
      allowColdStart,
      assertInstance,
      ...(lane ? { lane: <T>(work: () => Promise<T>) => lane(index, work) } : {}),
      approve: async (probe: ProbeReport) => {
        const decision = inspectGatherProbe(probe);
        if (!decision.ok) throw new Error(decision.reason);
        const foreground = await device.foregroundPackage();
        if (foreground !== wanlongPlugin.packageName) throw new Error(`万龙觉醒已离开前台（当前：${foreground ?? '未知'}）`);
        await assertInstance();
      },
    };
  }

  private async execute(index: number, options: RunGatherOnceOptions, signal: AbortSignal, timeoutMs: number): Promise<GatherRunResult> {
    checkAbort(signal);
    const config = normalizeGatherConfig(options.config);
    if (!config.enabled) throw new Error('自动采集未启用');
    const allowColdStart = options.allowColdStart ?? true;
    const { device, createdAt, templateDir } = await this.prepare(index, options.templateDir, signal);
    if (!allowColdStart) {
      const foreground = await device.foregroundPackage();
      if (foreground !== wanlongPlugin.packageName) throw new Error(`万龙觉醒未处于前台（当前：${foreground ?? '未知'}）`);
    }
    checkAbort(signal);
    const state = await this.store.load(index, createdAt);
    const policy = options.shotPolicy ?? config.safety.shotPolicy;
    let shotPath: string | null = null;
    let kicked: KickedProbeResult | null = null;
    let probed = false;
    const warnings: string[] = [];
    // The pool's job timeout aborts the worker like a stop does: the cycle ends as `cancelled` with its state intact.
    const job = this.pool.run(index, {
      kind: 'gather', instanceIndex: index, templateDir, config, state, allowColdStart, shotPolicy: policy,
      advisor: Boolean(options.advise),
    }, {
      ...this.context(index, device, createdAt, signal, timeoutMs, allowColdStart),
      ...(options.log ? { log: options.log } : {}),
      ...(options.advise ? { onAdvise: options.advise } : {}),
      onShot: async (label, raw) => {
        const failure = FAILURE_SHOT_LABELS.has(label);
        if (options.saveShot && shouldKeepShot(policy, label)) {
          try {
            const saved = await options.saveShot(label, raw);
            if (failure && saved && !shotPath) shotPath = saved;
          } catch (error) {
            // A lost screenshot must never fail the cycle (or the pause decision after it).
            options.log?.('warn', `留痕「${label}」落盘失败：${messageOf(error)}`);
          }
        }
        if (failure && !probed && options.probeKicked) {
          probed = true;
          try { kicked = await options.probeKicked(raw); }
          catch (error) { options.log?.('warn', `顶号识别出错，本次按通用兜底处理：${messageOf(error)}`); }
        }
      },
    });
    let outcome: Awaited<typeof job>;
    try {
      outcome = await job;
    } catch (error) {
      // ★ The pre-gate recovery ladder ran out (the worker left a「g0-failed」shot, saved and kicked-probed above):
      //   a failed cycle at step G0 like the original, not a generic start-up failure. Nothing was dispatched and
      //   the runtime state is untouched, so there is nothing to save.
      if (signal.aborted || codeOf(error) !== 'STEP_FAILED' || stepOf(error) !== 'G0') throw error;
      const message = messageOf(error);
      const failed: GatherCycleResult = {
        outcome: 'error', message, dispatched: [], queue: null, nextWakeAt: null,
        nextWakeReason: '开跑前回不到可识别的界面', captures: 0, state, warnings: [],
        error: { code: 'STEP_FAILED', message, detail: { step: 'G0' } },
      };
      options.log?.('error', message);
      return { ...failed, fact: cycleFactOf(failed, { shotPath, kicked }) };
    }
    if (outcome.kind !== 'gather') throw new SchedulerError('UNKNOWN', '视觉工作线程返回了错误的结果类型');
    const result: GatherCycleResult = outcome.result;
    // ★ Must save back (level memory, in-flight bookkeeping, backoff). A failed save only warns: the troops already
    //   dispatched must still reach statistics and the scheduler.
    try {
      await this.store.save(index, createdAt, result.state);
    } catch (error) {
      const message = `实例 #${index} 的采集运行期状态没存下来（下一轮会重新探测等级上限）：${messageOf(error)}`;
      warnings.push(message);
      options.log?.('warn', message);
    }
    return { ...result, warnings: [...result.warnings, ...warnings], fact: cycleFactOf(result, { shotPath, kicked }) };
  }
}
