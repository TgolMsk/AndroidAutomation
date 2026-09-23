import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => import('./helpers/electron-mock'));

import type { ScreenFrame } from '@avdm/core';
import type { LiveFrame } from '../src/shared/ipc';
import { LiveService, STALL_AFTER_MS, STALL_CHECK_MS, type ViewWindow } from '../src/main/live';
import type { ManagerHost } from '../src/main/manager-host';
import { FakeWebContents } from './helpers/electron-mock';

interface Stream {
  opts: Record<string, unknown>;
  onFrame: (f: ScreenFrame) => void;
  onEnd: (err?: Error) => void;
  cancelled: boolean;
}

class FakeGrpc {
  readonly streams: Stream[] = [];
  probe: () => Promise<ScreenFrame> = async () => frame(4, 2);
  readonly probes: Array<Record<string, unknown>> = [];
  streamScreenshot(opts: Record<string, unknown>, onFrame: Stream['onFrame'], onEnd: Stream['onEnd']) {
    const s: Stream = { opts, onFrame, onEnd, cancelled: false };
    this.streams.push(s);
    return { cancel: () => void (s.cancelled = true) };
  }
  getScreenshot(opts: Record<string, unknown>): Promise<ScreenFrame> {
    this.probes.push(opts);
    return this.probe();
  }
  async sendTouch(): Promise<void> {}
  async sendKey(): Promise<void> {}
}

function frame(width: number, height: number, seq?: number): ScreenFrame {
  const f: ScreenFrame = { data: Buffer.alloc(width * height * 3), format: 'rgb888', width, height };
  if (seq !== undefined) f.seq = seq;
  return f;
}

function fakeView(shown = true) {
  let visible = shown;
  const listeners = new Set<() => void>();
  const view: ViewWindow = {
    isShown: () => visible,
    onShown: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
  return {
    view,
    set(v: boolean) {
      visible = v;
      if (v) for (const l of [...listeners]) l();
    },
  };
}

function setup(opts: { width?: number; height?: number; rotation?: () => string; getStateGate?: Promise<void> } = {}) {
  const grpc = new FakeGrpc();
  const spec = { width: opts.width ?? 1280, height: opts.height ?? 720 };
  let first = true;
  const manager = {
    async getState(index: number) {
      if (first && opts.getStateGate) {
        first = false;
        await opts.getStateGate;
      }
      return { status: 'running', record: { index, name: `实例-${index}`, spec } };
    },
    async grpc() {
      return grpc;
    },
  };
  const host = { get: async () => manager } as unknown as ManagerHost;
  const views = new Map<FakeWebContents, ReturnType<typeof fakeView>>();
  const orientation: Array<[number, number, number]> = [];
  const live = new LiveService(host, {
    viewOf: (wc) => {
      const v = views.get(wc as unknown as FakeWebContents) ?? fakeView();
      views.set(wc as unknown as FakeWebContents, v);
      return v.view;
    },
    shell: async () => (opts.rotation ? opts.rotation() : ''),
  });
  live.setOrientationListener((i, w, h) => orientation.push([i, w, h]));
  const target = (shown = true) => {
    const wc = new FakeWebContents();
    views.set(wc, fakeView(shown));
    return wc;
  };
  return { grpc, live, views, target, orientation };
}

const asWc = (wc: FakeWebContents) => wc as unknown as Electron.WebContents;
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  vi.useRealTimers();
});

describe('LiveService', () => {
  it('requests width AND height at the device aspect ratio', async () => {
    const { grpc, live, target } = setup();
    await live.start(0, asWc(target()), 640);
    expect(grpc.streams[0]?.opts).toMatchObject({ format: 'rgb888', width: 640, height: 360 });
    live.dispose();
  });

  it('a second window takes over: the first is told, and its stale liveStop cannot kill the new stream', async () => {
    const { grpc, live, target } = setup();
    const a = target();
    const b = target();
    await live.start(0, asWc(a));
    await live.start(0, asWc(b));
    expect(grpc.streams[0]?.cancelled).toBe(true);
    expect(a.events<{ index: number; error?: string }>('live-ended')).toEqual([{ index: 0, error: '实时画面已在另一个窗口中打开' }]);
    // Window A unmounts / closes: only its own stream may be stopped.
    live.stop(0, asWc(a));
    live.stopFor(asWc(a));
    expect(grpc.streams[1]?.cancelled).toBe(false);
    expect(live.targetOf(0)).toBe(b);
    live.stop(0, asWc(b));
    expect(grpc.streams[1]?.cancelled).toBe(true);
  });

  it('a start superseded by another window while it was pending tells its window', async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const { live, target } = setup({ getStateGate: gate });
    const a = target();
    const b = target();
    const first = live.start(0, asWc(a));
    await tick(0);
    await live.start(0, asWc(b));
    open();
    await first;
    expect(a.events('live-ended')).toHaveLength(1);
    expect(live.targetOf(0)).toBe(b);
    live.dispose();
  });

  it('does not copy frames to a hidden/minimised window; delivers only the newest when it is shown', async () => {
    const { grpc, live, target, views } = setup();
    const wc = target(false);
    await live.start(0, asWc(wc));
    const s = grpc.streams[0]!;
    s.onFrame(frame(1280, 720, 1));
    await tick(50);
    s.onFrame(frame(1280, 720, 2));
    await tick(50);
    expect(wc.events('live-frame')).toHaveLength(0);
    views.get(wc)!.set(true);
    await tick(60);
    const sent = wc.events<LiveFrame>('live-frame');
    expect(sent.map((f) => f.seq)).toEqual([2]);
    live.dispose();
  });

  it('a static screen is not an error: the watchdog only ends the session when the emulator stops answering', async () => {
    vi.useFakeTimers();
    const { grpc, live, target } = setup();
    const wc = target();
    await live.start(0, asWc(wc));
    grpc.streams[0]!.onFrame(frame(1280, 720, 1));
    await vi.advanceTimersByTimeAsync(100);
    expect(wc.events('live-frame')).toHaveLength(1);

    // Static screen: no frames for a minute, but the emulator answers the probe.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(grpc.probes.length).toBeGreaterThan(0);
    expect(grpc.probes[0]).toMatchObject({ width: 32, height: 18 });
    expect(wc.events('live-ended')).toHaveLength(0);

    // Wedged emulator: two failed probes in a row end the session with an error.
    grpc.probe = () => Promise.reject(new Error('deadline exceeded'));
    await vi.advanceTimersByTimeAsync(STALL_AFTER_MS + 3 * STALL_CHECK_MS);
    const ended = wc.events<{ index: number; error?: string }>('live-ended');
    expect(ended).toHaveLength(1);
    expect(ended[0]?.error).toContain('画面流无响应');
    expect(grpc.streams[0]?.cancelled).toBe(true);
  });

  it('shows Android rotation: frames stay panel-native, the view is told to turn them and the window to reshape', async () => {
    vi.useFakeTimers();
    let reply = 'mCurrentOrientation=1';
    const { grpc, live, target, orientation } = setup({ width: 720, height: 1280, rotation: () => reply });
    const wc = target();
    await live.start(0, asWc(wc));
    await vi.advanceTimersByTimeAsync(10); // first rotation poll
    grpc.streams[0]!.onFrame(frame(720, 1280, 1));
    await vi.advanceTimersByTimeAsync(50);
    let sent = wc.events<LiveFrame>('live-frame');
    expect(sent.at(-1)).toMatchObject({ width: 720, height: 1280, deviceWidth: 720, deviceHeight: 1280, rotation: 1 });
    expect(orientation.at(-1)).toEqual([0, 1280, 720]);

    // Back to portrait on a static screen: the last picture is re-sent with the new rotation.
    reply = 'mCurrentOrientation=0';
    await vi.advanceTimersByTimeAsync(1100);
    sent = wc.events<LiveFrame>('live-frame');
    expect(sent.length).toBe(2);
    expect(sent.at(-1)).toMatchObject({ seq: 1, rotation: 0 });
    expect(orientation.at(-1)).toEqual([0, 720, 1280]);
    live.dispose();
  });

  it('frames the emulator already rotated (skin rotation) are shown as-is with swapped touch space', async () => {
    const { grpc, live, target } = setup({ width: 720, height: 1280, rotation: () => 'mCurrentOrientation=1' });
    const wc = target();
    await live.start(0, asWc(wc));
    await tick(10);
    grpc.streams[0]!.onFrame(frame(1280, 720, 1));
    await tick(50);
    expect(wc.events<LiveFrame>('live-frame').at(-1)).toMatchObject({ deviceWidth: 1280, deviceHeight: 720, rotation: 0 });
    live.dispose();
  });
});
