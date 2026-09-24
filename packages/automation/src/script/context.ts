/**
 * Runtime context of one script execution (wanlong-panel `src/worker/context.ts`). It is the engine's only
 * window to the outside world: frames (with pacing, jitter and reuse), template matching, device input through
 * a port, logs, trace shots and status.
 *
 * ★ One capture, many consumers: every condition evaluated within `minCaptureIntervalMs` reuses the same frame,
 *   so an and/or over ten templates costs one screencap. Every input invalidates the cached frame.
 * ★ Three coordinate spaces, never mixed: the script's canvas (`script.refWidth × refHeight`, everything the
 *   steps contain) → the global reference canvas (the template set's, where templates and prepared frames live)
 *   → device pixels, taken from the screencap header of the last frame only (never `wm size`).
 */
import type { AndroidKey, MatchResult, Point, PreparedFrame, PreparedTemplate, RawFrame, Rect } from '../contracts.js';
import { ScriptError, isExecutionGuardError } from './errors.js';
import { interpolate } from './interpolate.js';
import { RunLogger } from './logger.js';
import type {
  AiAssistResult, AiConsultRequest, LogEntry, LogLevel, RunSnapshot, RunStatus, ScriptDef, ScriptParamValue, ShotPolicy,
} from './types.js';

/** Device capabilities in device pixels. The host resolves the real device and checks ownership per call. */
export interface ScriptDevicePort {
  /** Tightly packed RGBA; the size comes from the screencap header. */
  capture(): Promise<RawFrame>;
  foregroundPackage(): Promise<string | null>;
  tap(x: number, y: number): Promise<void>;
  swipe(x1: number, y1: number, x2: number, y2: number, durationMs: number): Promise<void>;
  /** ★ motionevent DOWN; sleep; UP in one adb shell — never a swipe. */
  longPress(x: number, y: number, durationMs: number): Promise<void>;
  /** ★ Non-ASCII text needs ADBKeyboard's base64 broadcast. */
  inputText(text: string): Promise<void>;
  key(key: AndroidKey): Promise<void>;
  /** ★ The host launches through monkey and waits for the app to reach the foreground. */
  launchApp(packageName: string, cold: boolean): Promise<void>;
  stopApp(packageName: string): Promise<void>;
}

/** The part of VisionPort the executor needs; roi / threshold are in the global reference canvas. */
export interface ScriptVisionPort {
  prepareFrame(raw: RawFrame, options: { refWidth: number; refHeight: number; shrink?: number }): Promise<PreparedFrame>;
  match(frame: PreparedFrame, template: PreparedTemplate, options?: { roi?: Rect; threshold?: number }): Promise<MatchResult>;
}

export interface ScriptShotPort {
  /** Encode a trace shot from a raw frame (JPEG, 1280 wide, quality 72). */
  encode(raw: RawFrame): Promise<Uint8Array>;
  /** Persist it under `file`; returns the path stored in `LogEntry.shot`. */
  save(file: string, jpeg: Uint8Array): Promise<string>;
}

export interface ScriptContextInit {
  runId: string;
  instanceIndex: number;
  script: ScriptDef;
  /** Merged parameters (defaults < account < task < request). */
  params: Readonly<Record<string, ScriptParamValue>>;
  accountId?: string | null;
  accountName?: string | null;
  /** Prepared templates the script references, keyed by id. */
  templates?: ReadonlyMap<string, PreparedTemplate>;
  /** Global reference canvas (the template set's); defaults to the script's own canvas. */
  refWidth?: number;
  refHeight?: number;
  /** Frame/template down-sampling; must equal the templates' shrink. */
  shrink?: number;
  shotPolicy?: ShotPolicy;
  device: ScriptDevicePort;
  vision: ScriptVisionPort;
  shots?: ScriptShotPort;
  /** Asks the host's AI advisor to look at the screen. Implementations never throw. */
  consultAi?: (request: AiConsultRequest) => Promise<AiAssistResult>;
  onLogs?: (entries: LogEntry[]) => void;
  onStatus?: (snapshot: RunSnapshot) => void;
  onMatches?: (results: MatchResult[]) => void;
  minCaptureIntervalMs?: number;
  captureJitterMs?: number;
  statusIntervalMs?: number;
  logFlushMs?: number;
  matchesIntervalMs?: number;
  echoLogs?: boolean;
  debugMatches?: boolean;
  /** Shots already saved for this run id; numbering continues after them. */
  shotSeqStart?: number;
  now?: () => number;
  random?: () => number;
}

/** Default pacing: the pipeline is designed for ≈3 frames per second. */
export const MIN_CAPTURE_INTERVAL_MS = 400;
/** Instances share one adb server; random jitter keeps them from queueing in lockstep. */
export const CAPTURE_JITTER_MS = 120;
const FOREGROUND_CACHE_MS = 1000;
const STATUS_INTERVAL_MS = 250;
const MATCHES_INTERVAL_MS = 334;
const MAX_PENDING_MATCHES = 200;

/** A step attempt that can be cancelled on its own (step timeout) without stopping the whole run. */
export class StepScope {
  cancelled = false;
  private readonly wakers = new Set<() => void>();

  cancel(): void {
    this.cancelled = true;
    for (const wake of [...this.wakers]) wake();
  }

  /** @internal */
  onCancel(wake: () => void): () => void {
    this.wakers.add(wake);
    return () => this.wakers.delete(wake);
  }
}

export class ScriptContext {
  readonly runId: string;
  readonly instanceIndex: number;
  readonly script: ScriptDef;
  readonly params: Readonly<Record<string, ScriptParamValue>>;
  readonly templates: ReadonlyMap<string, PreparedTemplate>;
  readonly refWidth: number;
  readonly refHeight: number;
  readonly shrink: number;
  readonly shotPolicy: ShotPolicy;
  readonly snapshot: RunSnapshot;
  readonly logger: RunLogger;
  readonly device: ScriptDevicePort;
  readonly vision: ScriptVisionPort;
  readonly consultAi: ((request: AiConsultRequest) => Promise<AiAssistResult>) | null;
  readonly now: () => number;

  /** Last raw frame; trace shots reuse it instead of capturing again. */
  lastRaw: RawFrame | null = null;
  /** Set on stop: every sleep returns at once and new captures are refused. */
  aborted = false;
  /** Set on pause: the engine waits at the next step boundary. */
  paused = false;

  private readonly minInterval: number;
  private readonly jitterMs: number;
  private readonly random: () => number;
  private readonly sx: number;
  private readonly sy: number;
  private prepared: PreparedFrame | null = null;
  private preparedAt = 0;
  private capturing: Promise<PreparedFrame> | null = null;
  private lastCaptureAt = 0;
  private foregroundCache: { pkg: string | null; at: number } | null = null;
  private shotSeq = 0;
  private disposed = false;
  private readonly sleepers = new Set<() => void>();
  private readonly pauseWaiters = new Set<() => void>();
  private readonly onStatus?: (snapshot: RunSnapshot) => void;
  private readonly statusIntervalMs: number;
  private lastStatusAt = 0;
  private statusTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly onMatches?: (results: MatchResult[]) => void;
  private readonly matchesIntervalMs: number;
  private debugMatches: boolean;
  private pendingMatches: MatchResult[] = [];
  private matchesTimer: ReturnType<typeof setTimeout> | null = null;
  private lastMatchesAt = 0;
  private readonly shots?: ScriptShotPort;

  constructor(init: ScriptContextInit) {
    this.runId = init.runId;
    this.instanceIndex = init.instanceIndex;
    this.script = init.script;
    this.params = init.params;
    this.templates = init.templates ?? new Map();
    this.refWidth = init.refWidth ?? init.script.refWidth;
    this.refHeight = init.refHeight ?? init.script.refHeight;
    this.shrink = init.shrink ?? 2;
    this.shotPolicy = init.shotPolicy ?? 'onFail';
    this.device = init.device;
    this.vision = init.vision;
    this.shots = init.shots;
    this.consultAi = init.consultAi ?? null;
    this.now = init.now ?? Date.now;
    this.random = init.random ?? Math.random;
    this.minInterval = Math.max(0, init.minCaptureIntervalMs ?? MIN_CAPTURE_INTERVAL_MS);
    this.jitterMs = Math.max(0, init.captureJitterMs ?? CAPTURE_JITTER_MS);
    this.statusIntervalMs = Math.max(0, init.statusIntervalMs ?? STATUS_INTERVAL_MS);
    this.matchesIntervalMs = Math.max(0, init.matchesIntervalMs ?? MATCHES_INTERVAL_MS);
    this.onStatus = init.onStatus;
    this.onMatches = init.onMatches;
    this.debugMatches = init.debugMatches ?? false;
    this.shotSeq = Math.max(0, Math.floor(init.shotSeqStart ?? 0));
    this.sx = this.refWidth / (init.script.refWidth || this.refWidth);
    this.sy = this.refHeight / (init.script.refHeight || this.refHeight);
    this.logger = new RunLogger(init.runId, init.instanceIndex, (entries) => init.onLogs?.(entries), {
      flushMs: init.logFlushMs, echo: init.echoLogs, now: this.now,
    });
    this.snapshot = {
      runId: init.runId,
      scriptId: init.script.id,
      scriptName: init.script.name,
      instanceIndex: init.instanceIndex,
      accountId: init.accountId ?? null,
      accountName: init.accountName ?? null,
      status: 'pending',
      startedAt: this.now(),
      endedAt: null,
      stepDone: 0,
      // A loop script has no meaningful total.
      stepTotal: init.script.loop ? null : init.script.steps.length,
      currentStepId: null,
      currentStepName: null,
      iteration: 0,
      error: null,
      stats: { captures: 0, matches: 0, matchHits: 0, taps: 0, retries: 0, lastTickMs: 0, avgCaptureMs: 0 },
    };
  }

  // ── Coordinates ───────────────────────────────────────────────────────

  /** Script canvas → global reference canvas. */
  pointToRef(point: Point): Point {
    return { x: Math.round(point.x * this.sx), y: Math.round(point.y * this.sy) };
  }

  rectToRef(rect: Rect): Rect {
    return {
      x: Math.round(rect.x * this.sx),
      y: Math.round(rect.y * this.sy),
      w: Math.max(1, Math.round(rect.w * this.sx)),
      h: Math.max(1, Math.round(rect.h * this.sy)),
    };
  }

  /** Global reference canvas → device pixels, from the last screencap header. The only way to adb. */
  async refToDevicePoint(ref: Point): Promise<Point> {
    const { width, height } = await this.deviceSize();
    return { x: Math.round(ref.x * width / this.refWidth), y: Math.round(ref.y * height / this.refHeight) };
  }

  /** Script canvas → device pixels. */
  async toDevice(point: Point): Promise<Point> {
    return this.refToDevicePoint(this.pointToRef(point));
  }

  /** Device resolution; captures once when no frame exists yet. */
  async deviceSize(): Promise<{ width: number; height: number }> {
    if (this.lastRaw) return { width: this.lastRaw.width, height: this.lastRaw.height };
    const frame = await this.frame();
    return { width: frame.deviceWidth, height: frame.deviceHeight };
  }

  // ── Frames ────────────────────────────────────────────────────────────

  /**
   * A prepared frame. Reused while younger than `minCaptureIntervalMs`; concurrent callers share one capture;
   * `force` captures anew (the screen changed).
   */
  async frame(force = false): Promise<PreparedFrame> {
    if (this.aborted) throw new ScriptError('CANCELLED', '执行已停止，不再抓取新画面。');
    if (!force && this.prepared && this.now() - this.preparedAt < this.minInterval) return this.prepared;
    if (this.capturing) return this.capturing;
    this.capturing = this.capture().finally(() => { this.capturing = null; });
    return this.capturing;
  }

  /** The cached frame is stale; the next judgement captures again. Called after every input. */
  invalidateFrame(): void {
    this.prepared = null;
  }

  private async capture(): Promise<PreparedFrame> {
    const jitter = Math.floor(this.random() * this.jitterMs);
    const wait = this.lastCaptureAt + this.minInterval + jitter - this.now();
    if (wait > 0) await this.sleep(wait);
    if (this.aborted) throw new ScriptError('CANCELLED', '执行已停止，不再抓取新画面。');
    const started = this.now();
    let raw: RawFrame;
    try { raw = await this.device.capture(); }
    catch (error) {
      if (isExecutionGuardError(error)) throw error;
      throw ScriptError.from(error, 'DEVICE');
    }
    const captureMs = this.now() - started;
    this.lastCaptureAt = this.now();
    this.lastRaw = raw;
    const stats = this.snapshot.stats;
    stats.captures += 1;
    stats.avgCaptureMs = Math.round(stats.avgCaptureMs + (captureMs - stats.avgCaptureMs) / stats.captures);
    const prepared = await this.vision.prepareFrame(raw, { refWidth: this.refWidth, refHeight: this.refHeight, shrink: this.shrink });
    this.prepared = prepared;
    this.preparedAt = this.lastCaptureAt;
    return prepared;
  }

  // ── Matching ──────────────────────────────────────────────────────────

  /** Match one template. `roi` is in the script canvas; without it the template's default ROI applies. */
  async matchTemplate(templateId: string, roi?: Rect, threshold?: number): Promise<MatchResult> {
    const template = this.templates.get(templateId);
    if (!template) {
      throw new ScriptError('TEMPLATE_NOT_FOUND',
        `模板「${templateId}」不在模板集里。请检查实例当前的模板集（以及脚本的 templateSetId）是否正确，或先在模板库里截好这张模板。`,
        { templateId, templateSetId: this.script.templateSetId });
    }
    const frame = await this.frame();
    const options: { roi?: Rect; threshold?: number } = {};
    if (roi) options.roi = this.rectToRef(roi);
    else if (template.defaultRoi) options.roi = template.defaultRoi;
    if (threshold !== undefined) options.threshold = threshold;
    let result: MatchResult;
    try { result = await this.vision.match(frame, template, options); }
    catch (error) { throw ScriptError.from(error, 'UNKNOWN'); }
    this.snapshot.stats.matches += 1;
    if (result.found) this.snapshot.stats.matchHits += 1;
    if (this.debugMatches) this.queueMatches(result);
    return result;
  }

  setDebugMatches(enabled: boolean): void {
    this.debugMatches = enabled;
    if (!enabled) this.pendingMatches = [];
  }

  private queueMatches(result: MatchResult): void {
    if (!this.onMatches) return;
    if (this.pendingMatches.length < MAX_PENDING_MATCHES) this.pendingMatches.push(result);
    if (this.matchesTimer) return;
    const wait = Math.max(0, this.lastMatchesAt + this.matchesIntervalMs - this.now());
    this.matchesTimer = setTimeout(() => {
      this.matchesTimer = null;
      this.lastMatchesAt = this.now();
      const batch = this.pendingMatches;
      this.pendingMatches = [];
      if (batch.length && this.debugMatches && !this.disposed) {
        try { this.onMatches?.(batch); } catch { /* A closed monitor must not stop the script. */ }
      }
    }, wait);
    (this.matchesTimer as { unref?: () => void }).unref?.();
  }

  // ── Device state ──────────────────────────────────────────────────────

  /** Foreground package, cached for one second. */
  async foregroundPackage(force = false): Promise<string | null> {
    if (!force && this.foregroundCache && this.now() - this.foregroundCache.at < FOREGROUND_CACHE_MS) return this.foregroundCache.pkg;
    let pkg: string | null;
    try { pkg = await this.device.foregroundPackage(); }
    catch (error) {
      if (isExecutionGuardError(error)) throw error;
      throw ScriptError.from(error, 'DEVICE');
    }
    this.foregroundCache = { pkg, at: this.now() };
    return pkg;
  }

  invalidateForeground(): void {
    this.foregroundCache = null;
  }

  /** The step's package, else the script's. */
  resolvePackage(stepPackage: string | undefined, stepId: string): string {
    const pkg = stepPackage ?? this.script.packageName;
    if (!pkg) {
      throw new ScriptError('INVALID_ARGUMENT', `步骤「${stepId}」要操作应用，但既没写 packageName，脚本头部也没设 packageName。`, { stepId });
    }
    return pkg;
  }

  interpolate(text: string): string {
    return interpolate(text, this.params);
  }

  // ── Logs and trace shots ──────────────────────────────────────────────

  log(level: LogLevel, message: string, data?: Record<string, unknown>, options?: { stepId?: string; scope?: string; shot?: string }): void {
    this.logger.push({ level, scope: options?.scope ?? 'engine', message, stepId: options?.stepId, data, shot: options?.shot });
  }

  /**
   * Keep a trace shot of the last frame (captured only when none exists) and return its path. Any failure is a
   * warning: a missing shot must never fail the script.
   */
  async shot(label: string): Promise<string | null> {
    if (!this.shots) return null;
    try {
      let raw = this.lastRaw;
      if (!raw) { await this.frame(); raw = this.lastRaw; }
      if (!raw) return null;
      const jpeg = await this.shots.encode(raw);
      this.shotSeq += 1;
      const file = `${String(this.shotSeq).padStart(4, '0')}-${sanitizeLabel(label)}.jpg`;
      return await this.shots.save(file, jpeg);
    } catch (error) {
      this.logger.push({ level: 'warn', scope: 'engine', message: `留痕截图失败（不影响脚本继续）：${error instanceof Error ? error.message : String(error)}` });
      return null;
    }
  }

  // ── Status ────────────────────────────────────────────────────────────

  /** Publish the snapshot: at most every `statusIntervalMs`, with a trailing update; `force` sends now. */
  publishStatus(force = false): void {
    if (!this.onStatus || this.disposed) return;
    const due = this.lastStatusAt + this.statusIntervalMs - this.now();
    if (force || due <= 0) {
      if (this.statusTimer) { clearTimeout(this.statusTimer); this.statusTimer = null; }
      this.emitStatus();
      return;
    }
    if (this.statusTimer) return;
    this.statusTimer = setTimeout(() => { this.statusTimer = null; this.emitStatus(); }, due);
    (this.statusTimer as { unref?: () => void }).unref?.();
  }

  private emitStatus(): void {
    this.lastStatusAt = this.now();
    try { this.onStatus?.(this.snapshotCopy()); } catch { /* Observers cannot break the run. */ }
  }

  setStatus(status: RunStatus): void {
    this.snapshot.status = status;
    this.publishStatus(true);
  }

  snapshotCopy(): RunSnapshot {
    return { ...this.snapshot, stats: { ...this.snapshot.stats } };
  }

  // ── Pacing ────────────────────────────────────────────────────────────

  /** A sleep that stop (and the step's own timeout) interrupts at once. Every wait must use it. */
  sleep(ms: number, scope?: StepScope): Promise<void> {
    if (ms <= 0 || this.aborted || scope?.cancelled) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let detach: (() => void) | undefined;
      const done = (): void => {
        clearTimeout(timer);
        this.sleepers.delete(done);
        detach?.();
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.sleepers.add(done);
      detach = scope?.onCancel(done);
    });
  }

  /** Waits while paused; returns at once on stop. */
  async waitWhilePaused(): Promise<void> {
    while (this.paused && !this.aborted) {
      await new Promise<void>((resolve) => this.pauseWaiters.add(resolve));
    }
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    if (!paused) this.releasePauseWaiters();
  }

  /** Stop: wakes every sleeper and pause waiter; later captures are refused. */
  abort(): void {
    this.aborted = true;
    for (const wake of [...this.sleepers]) wake();
    this.releasePauseWaiters();
  }

  private releasePauseWaiters(): void {
    const waiters = [...this.pauseWaiters];
    this.pauseWaiters.clear();
    for (const resolve of waiters) resolve();
  }

  dispose(): void {
    this.disposed = true;
    if (this.statusTimer) { clearTimeout(this.statusTimer); this.statusTimer = null; }
    if (this.matchesTimer) { clearTimeout(this.matchesTimer); this.matchesTimer = null; }
    this.logger.dispose();
    this.prepared = null;
    this.lastRaw = null;
  }
}

export function sanitizeLabel(label: string): string {
  const cleaned = label.replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '');
  return (cleaned || 'shot').slice(0, 40);
}

