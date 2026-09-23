import { BrowserWindow, type WebContents } from 'electron';
import type { EmulatorGrpc, FrameSubscription, KeyEventType, ScreenFrame, TouchPoint } from '@avdm/core';
import type { DisplayRotation, LiveFrame } from '../shared/ipc';
import { sendEvent } from './events';
import type { ManagerHost } from './manager-host';
import { RotationProber } from './rotation';
import { errorMessage, heightFor, toU8 } from './util';

/** ~30 fps upper bound for frames pushed to a live window. */
const MIN_FRAME_INTERVAL_MS = 33;
/** How often Android's display rotation is polled while a live window is shown. */
export const ROTATION_POLL_MS = 1000;
/** How often the stall watchdog looks at a session. */
export const STALL_CHECK_MS = 5000;
/** No frame for this long → probe the emulator (the screen may simply be static). */
export const STALL_AFTER_MS = 10_000;
const STALL_PROBE_TIMEOUT_MS = 3000;
/** Consecutive failed probes before the session is ended with an error (window offers 重新连接). */
const STALL_MAX_FAILURES = 2;
/** Tiny probe image: cheap to produce, only used to see whether the emulator still answers. */
const STALL_PROBE_WIDTH = 32;

type StreamFormat = 'rgb888' | 'png';

/** The window hosting a live view, as far as a session cares. */
export interface ViewWindow {
  /** Visible and not minimised. */
  isShown(): boolean;
  /** Subscribe to the window being shown / restored; returns an unsubscribe function. */
  onShown(listener: () => void): () => void;
}

export interface LiveSessionHooks {
  finished(session: LiveSession, error?: string): void;
  /** Orientation of the upright picture changed (e.g. a landscape app on a portrait panel). */
  orientation?(session: LiveSession, width: number, height: number): void;
  /** Android display rotation, or undefined when unknown (the last known value is kept). */
  probeRotation?(): Promise<DisplayRotation | undefined>;
}

/**
 * One gRPC screenshot stream feeding one live window. Only the latest frame is kept: if frames
 * arrive faster than MIN_FRAME_INTERVAL_MS the older ones are dropped before they are copied, and
 * nothing is copied to the renderer while its window is hidden or minimised.
 */
export class LiveSession {
  stopped = false;
  private sub: FrameSubscription | undefined;
  private format: StreamFormat = 'rgb888';
  private gotFrame = false;
  private pending: ScreenFrame | undefined;
  private lastFrame: ScreenFrame | undefined;
  private lastSentAt = 0;
  private timer: NodeJS.Timeout | undefined;
  private seq = 0;
  private generation = 0;
  private started = false;
  private lastAliveAt = Date.now();
  private stallTimer: NodeJS.Timeout | undefined;
  private stallProbing = false;
  private stallFailures = 0;
  private rotation: DisplayRotation = 0;
  private rotationTimer: NodeJS.Timeout | undefined;
  private rotationBusy = false;
  private uprightLandscape: boolean | undefined;
  private unsubscribeShown: (() => void) | undefined;
  private readonly onDestroyed = () => this.onTargetGone();

  constructor(
    readonly index: number,
    readonly target: WebContents,
    private readonly grpc: EmulatorGrpc,
    private readonly width: number,
    private readonly device: { width: number; height: number },
    private readonly view: ViewWindow,
    private readonly hooks: LiveSessionHooks,
  ) {
    target.once('destroyed', this.onDestroyed);
  }

  open(format: StreamFormat): void {
    this.format = format;
    this.gotFrame = false;
    const generation = ++this.generation;
    const sub = this.grpc.streamScreenshot(
      { format, width: this.width, height: heightFor(this.width, this.device) },
      (frame) => {
        if (generation === this.generation) this.onFrame(frame);
      },
      (err) => {
        if (generation === this.generation) this.onStreamEnd(err);
      },
    );
    // onEnd may fire synchronously (and even re-open with another format) before we get here.
    if (generation === this.generation && !this.stopped && this.format === format) {
      this.sub = sub;
    } else {
      cancelQuietly(sub);
    }
    if (!this.started && !this.stopped) this.startTimers();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.stallTimer) clearInterval(this.stallTimer);
    this.stallTimer = undefined;
    if (this.rotationTimer) clearInterval(this.rotationTimer);
    this.rotationTimer = undefined;
    this.unsubscribeShown?.();
    this.unsubscribeShown = undefined;
    this.pending = undefined;
    this.lastFrame = undefined;
    if (!this.target.isDestroyed()) this.target.removeListener('destroyed', this.onDestroyed);
    this.generation++;
    const sub = this.sub;
    this.sub = undefined;
    if (sub) cancelQuietly(sub);
  }

  private startTimers(): void {
    this.started = true;
    this.lastAliveAt = Date.now();
    this.unsubscribeShown = this.view.onShown(() => {
      this.scheduleFlush();
      void this.pollRotation();
    });
    this.stallTimer = setInterval(() => void this.checkStall(), STALL_CHECK_MS);
    if (this.hooks.probeRotation) {
      this.rotationTimer = setInterval(() => void this.pollRotation(), ROTATION_POLL_MS);
      void this.pollRotation();
    }
  }

  private onTargetGone(): void {
    this.stop();
    this.hooks.finished(this);
  }

  private onFrame(frame: ScreenFrame): void {
    if (this.stopped) return;
    this.gotFrame = true;
    this.lastAliveAt = Date.now();
    this.stallFailures = 0;
    this.pending = frame;
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.timer || !this.pending || this.stopped) return;
    const wait = Math.max(0, this.lastSentAt + MIN_FRAME_INTERVAL_MS - Date.now());
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, wait);
  }

  private flush(): void {
    if (this.stopped || this.target.isDestroyed()) {
      this.pending = undefined;
      return;
    }
    const frame = this.pending;
    if (!frame) return;
    // Hidden / minimised: keep only the newest frame and deliver it when the window is shown again.
    if (!this.view.isShown()) return;
    this.pending = undefined;
    this.send(frame);
  }

  private send(frame: ScreenFrame): void {
    this.lastSentAt = Date.now();
    this.lastFrame = frame;
    // Android rotation keeps frames panel-native (the UI is drawn sideways) and gRPC touches stay in panel
    // coordinates, so the view rotates the picture by `rotation` and maps pointers back. A frame whose
    // orientation differs from the panel was already rotated by the emulator itself (skin rotation): show it
    // as is and scale touches proportionally to the swapped size.
    const swapped = this.device.width >= this.device.height !== frame.width >= frame.height;
    const [deviceWidth, deviceHeight] = swapped ? [this.device.height, this.device.width] : [this.device.width, this.device.height];
    const rotation: DisplayRotation = swapped ? 0 : this.rotation;
    const [uprightW, uprightH] = rotation % 2 ? [frame.height, frame.width] : [frame.width, frame.height];
    this.noteOrientation(uprightW, uprightH);
    const payload: LiveFrame = {
      index: this.index,
      data: toU8(frame.data),
      format: frame.format,
      width: frame.width,
      height: frame.height,
      deviceWidth,
      deviceHeight,
      rotation,
      seq: frame.seq ?? ++this.seq,
    };
    sendEvent(this.target, 'live-frame', payload);
  }

  private noteOrientation(width: number, height: number): void {
    const landscape = width > height;
    if (this.uprightLandscape === landscape) return;
    this.uprightLandscape = landscape;
    this.hooks.orientation?.(this, width, height);
  }

  private async pollRotation(): Promise<void> {
    const probe = this.hooks.probeRotation;
    if (!probe || this.stopped || this.rotationBusy || !this.view.isShown()) return;
    this.rotationBusy = true;
    try {
      const r = await probe();
      if (this.stopped || r === undefined || r === this.rotation) return;
      this.rotation = r;
      // A static screen sends no new frame: re-send the current picture with the new rotation.
      if (!this.pending && this.lastFrame) this.pending = this.lastFrame;
      this.scheduleFlush();
    } catch {
      // keep the last known rotation
    } finally {
      this.rotationBusy = false;
    }
  }

  /**
   * The emulator only streams when the picture changes, so silence usually means a static screen. After
   * STALL_AFTER_MS without frames, ask for a tiny screenshot: if the emulator does not answer twice in a
   * row the stream is considered stalled and the session ends with an error.
   */
  private async checkStall(): Promise<void> {
    if (this.stopped || this.stallProbing || !this.view.isShown()) return;
    if (Date.now() - this.lastAliveAt < STALL_AFTER_MS) return;
    this.stallProbing = true;
    try {
      await this.grpc.getScreenshot(
        { format: 'rgb888', width: STALL_PROBE_WIDTH, height: heightFor(STALL_PROBE_WIDTH, this.device) },
        STALL_PROBE_TIMEOUT_MS,
      );
      if (this.stopped) return;
      this.stallFailures = 0;
      this.lastAliveAt = Date.now();
    } catch (err) {
      if (this.stopped) return;
      this.stallFailures++;
      if (this.stallFailures >= STALL_MAX_FAILURES) {
        this.stop();
        this.hooks.finished(this, `画面流无响应：模拟器可能已卡住或已暂停（${errorMessage(err)}）`);
      }
    } finally {
      this.stallProbing = false;
    }
  }

  private onStreamEnd(err?: Error): void {
    if (this.stopped) return;
    this.sub = undefined;
    // Older emulators may reject raw RGB streaming — retry once with PNG before giving up.
    if (!this.gotFrame && this.format === 'rgb888') {
      try {
        this.open('png');
        return;
      } catch (e) {
        err = e instanceof Error ? e : new Error(String(e));
      }
    }
    // Deliver the last pending frame, then report the end.
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
      this.flush();
    }
    this.stop();
    this.hooks.finished(this, err ? `画面流已断开：${errorMessage(err)}` : undefined);
  }
}

function cancelQuietly(sub: FrameSubscription): void {
  try {
    sub.cancel();
  } catch {
    // already closed
  }
}

type InputTask = {
  move: boolean;
  run: () => Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
};

/**
 * Serialises input for one instance so down → move → up arrive in order. Consecutive pending moves
 * are coalesced (only the newest is sent) when the emulator is slower than the pointer.
 */
class InputQueue {
  private readonly queue: InputTask[] = [];
  private running = false;
  private pressed = false;

  touch(grpc: () => Promise<EmulatorGrpc>, touches: TouchPoint[]): Promise<void> {
    const pressedNow = touches.some((t) => t.pressure > 0);
    const move = pressedNow && this.pressed;
    this.pressed = pressedNow;
    return this.enqueue(move, async () => (await grpc()).sendTouch(touches));
  }

  key(grpc: () => Promise<EmulatorGrpc>, input: { key?: string; text?: string; eventType?: KeyEventType }): Promise<void> {
    return this.enqueue(false, async () => (await grpc()).sendKey(input));
  }

  private enqueue(move: boolean, run: () => Promise<void>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const task: InputTask = { move, run, resolve, reject };
      const last = this.queue[this.queue.length - 1];
      if (move && last?.move) {
        this.queue[this.queue.length - 1] = task;
        last.resolve();
      } else {
        this.queue.push(task);
      }
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (let task = this.queue.shift(); task; task = this.queue.shift()) {
        try {
          await task.run();
          task.resolve();
        } catch (err) {
          task.reject(err);
        }
      }
    } finally {
      this.running = false;
    }
  }
}

/** Visibility of the BrowserWindow hosting `wc`. */
function browserViewOf(wc: WebContents): ViewWindow {
  return {
    isShown() {
      const win = BrowserWindow.fromWebContents(wc);
      return !!win && !win.isDestroyed() && win.isVisible() && !win.isMinimized();
    },
    onShown(listener) {
      const win = BrowserWindow.fromWebContents(wc);
      if (!win) return () => undefined;
      win.on('show', listener);
      win.on('restore', listener);
      return () => {
        if (win.isDestroyed()) return;
        win.removeListener('show', listener);
        win.removeListener('restore', listener);
      };
    },
  };
}

export interface LiveServiceDeps {
  /** Visibility of the window hosting a renderer (default: its BrowserWindow). */
  viewOf?: (wc: WebContents) => ViewWindow;
  /** Run a shell command on an instance (default: adb through the manager); used to poll rotation. */
  shell?: (index: number, command: string) => Promise<string>;
}

const SUPERSEDED_MESSAGE = '实时画面已在另一个窗口中打开';

export class LiveService {
  private readonly sessions = new Map<number, LiveSession>();
  /** Latest start() per index that has not produced a session yet. */
  private readonly starting = new Map<number, { epoch: number; target: WebContents }>();
  private readonly inputs = new Map<number, InputQueue>();
  private readonly epochs = new Map<number, number>();
  private readonly viewOf: (wc: WebContents) => ViewWindow;
  private readonly shell: (index: number, command: string) => Promise<string>;
  private orientationListener: ((index: number, width: number, height: number) => void) | undefined;

  constructor(
    private readonly host: ManagerHost,
    deps: LiveServiceDeps = {},
  ) {
    this.viewOf = deps.viewOf ?? browserViewOf;
    this.shell =
      deps.shell ??
      (async (index, command) => {
        const device = await (await this.host.get()).device(index);
        return device.shell(command, { timeoutMs: 3000 });
      });
  }

  /** Called when the upright orientation of an instance's live picture changes (window resizing). */
  setOrientationListener(listener: (index: number, width: number, height: number) => void): void {
    this.orientationListener = listener;
  }

  async start(index: number, target: WebContents, maxWidth?: number): Promise<{ deviceWidth: number; deviceHeight: number }> {
    // A newer start/stop for the same index supersedes this call (e.g. quick reconnects).
    const epoch = this.bump(index);
    this.starting.set(index, { epoch, target });
    try {
      this.endSession(index, target);
      const manager = await this.host.get();
      const state = await manager.getState(index);
      if (state.status !== 'running' && state.status !== 'booting') {
        throw new Error(`实例 #${index}（${state.record.name}）未运行，无法打开实时画面`);
      }
      const grpc = await manager.grpc(index);
      const device = { width: state.record.spec.width, height: state.record.spec.height };
      if (this.epochs.get(index) !== epoch || target.isDestroyed()) {
        // Superseded by another window's start: tell this one it will not get frames.
        const owner = this.starting.get(index)?.target ?? this.sessions.get(index)?.target;
        if (owner && owner !== target) sendEvent(target, 'live-ended', { index, error: SUPERSEDED_MESSAGE });
        return { deviceWidth: device.width, deviceHeight: device.height };
      }
      const requested = Number.isFinite(maxWidth) && (maxWidth ?? 0) > 0 ? Math.round(maxWidth as number) : device.width;
      const width = Math.max(64, Math.min(requested, device.width));
      this.endSession(index, target);
      const prober = new RotationProber((command) => this.shell(index, command));
      const session = new LiveSession(index, target, grpc, width, device, this.viewOf(target), {
        finished: (s, error) => {
          if (this.sessions.get(index) !== s) return;
          this.sessions.delete(index);
          sendEvent(s.target, 'live-ended', error ? { index, error } : { index });
        },
        orientation: (s, w, h) => {
          if (this.sessions.get(index) === s) this.orientationListener?.(index, w, h);
        },
        probeRotation: () => prober.probe(),
      });
      this.sessions.set(index, session);
      try {
        session.open('rgb888');
      } catch (err) {
        session.stop();
        if (this.sessions.get(index) === session) this.sessions.delete(index);
        throw new Error(`无法打开画面流：${errorMessage(err)}`);
      }
      return { deviceWidth: device.width, deviceHeight: device.height };
    } finally {
      if (this.starting.get(index)?.epoch === epoch) this.starting.delete(index);
    }
  }

  /**
   * Stop the stream of an instance. With `requester`, only if that renderer owns the stream (or the start in
   * flight): a stale or second window must not kill the stream another window is showing.
   */
  stop(index: number, requester?: WebContents): void {
    if (requester) {
      const owns = this.sessions.get(index)?.target === requester || this.starting.get(index)?.target === requester;
      if (!owns) return;
    }
    this.bump(index);
    this.starting.delete(index);
    this.stopSession(index);
  }

  /** Stop every stream (and pending start) that feeds `target` (window closing). */
  stopFor(target: WebContents): void {
    const indices = new Set<number>();
    for (const [index, session] of this.sessions) if (session.target === target) indices.add(index);
    for (const [index, pending] of this.starting) if (pending.target === target) indices.add(index);
    for (const index of indices) this.stop(index);
  }

  /** Target currently receiving frames of `index` (tests / diagnostics). */
  targetOf(index: number): WebContents | undefined {
    return this.sessions.get(index)?.target;
  }

  touch(index: number, touches: TouchPoint[]): Promise<void> {
    return this.queueFor(index).touch(() => this.grpcFor(index), touches);
  }

  key(index: number, input: { key?: string; text?: string; eventType?: KeyEventType }): Promise<void> {
    return this.queueFor(index).key(() => this.grpcFor(index), input);
  }

  dispose(): void {
    for (const index of new Set([...this.sessions.keys(), ...this.starting.keys()])) this.stop(index);
  }

  private bump(index: number): number {
    const next = (this.epochs.get(index) ?? 0) + 1;
    this.epochs.set(index, next);
    return next;
  }

  /** Replace the current session of `index`; a different window losing its stream is told so. */
  private endSession(index: number, successor: WebContents): void {
    const session = this.sessions.get(index);
    if (!session) return;
    this.sessions.delete(index);
    session.stop();
    if (session.target !== successor) sendEvent(session.target, 'live-ended', { index, error: SUPERSEDED_MESSAGE });
  }

  private stopSession(index: number): void {
    const session = this.sessions.get(index);
    if (!session) return;
    this.sessions.delete(index);
    session.stop();
  }

  private queueFor(index: number): InputQueue {
    let q = this.inputs.get(index);
    if (!q) {
      q = new InputQueue();
      this.inputs.set(index, q);
    }
    return q;
  }

  private async grpcFor(index: number): Promise<EmulatorGrpc> {
    const manager = await this.host.get();
    return manager.grpc(index);
  }
}
