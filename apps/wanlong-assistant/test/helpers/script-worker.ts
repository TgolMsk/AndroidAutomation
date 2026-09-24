import { EventEmitter } from 'node:events';
import type { MatchResult, PreparedFrame, PreparedTemplate, RawFrame } from '@avdm/automation';
import { attachScriptWorker, type ScriptWorkerDeps } from '../../src/main/plans/script-worker-core';
import type { ScriptMainToWorker, ScriptWorkerLike, ScriptWorkerPort, ScriptWorkerToMain } from '../../src/main/plans/script-protocol';
import type { ScriptDevice } from '../../src/main/plans/types';

export const PKG = 'com.lilithgames.samo.android.cn';

/** Runs the real worker core in-process over an asynchronous fake channel (like a worker thread would). */
export function inProcessWorkers(deps: ScriptWorkerDeps = {}) {
  const created: Array<ScriptWorkerLike & { sent: ScriptMainToWorker[]; received: ScriptWorkerToMain[] }> = [];
  const factory = (): ScriptWorkerLike => {
    const main = new EventEmitter() as EventEmitter & ScriptWorkerLike & { sent: ScriptMainToWorker[]; received: ScriptWorkerToMain[] };
    const inner = new EventEmitter();
    let terminated = false;
    main.sent = [];
    main.received = [];
    main.postMessage = (message: ScriptMainToWorker) => {
      if (terminated) return;
      main.sent.push(message);
      queueMicrotask(() => inner.emit('message', message));
    };
    const port: ScriptWorkerPort = {
      on: (event, listener) => inner.on(event, listener),
      postMessage: (message: ScriptWorkerToMain) => {
        if (terminated) return;
        main.received.push(message);
        queueMicrotask(() => main.emit('message', message));
      },
    };
    main.terminate = async () => {
      if (!terminated) { terminated = true; queueMicrotask(() => main.emit('exit', 1)); }
      return 1;
    };
    attachScriptWorker(port, { warmUp: async () => undefined, echoLogs: false, ...deps });
    created.push(main);
    return main;
  };
  return { factory, created };
}

/** Fast vision port: frames are prepared without sharp; `found(templateId)` decides every match. */
export function fakeVision(found: (templateId: string) => boolean = () => false): NonNullable<ScriptWorkerDeps['vision']> {
  return {
    async prepareFrame(raw: RawFrame, options: { refWidth: number; refHeight: number; shrink?: number }): Promise<PreparedFrame> {
      return { gray: new Uint8Array(1), width: 1, height: 1, w: 1, h: 1, shrink: options.shrink ?? 2, refWidth: options.refWidth,
        refHeight: options.refHeight, deviceWidth: raw.width, deviceHeight: raw.height, capturedAt: raw.capturedAt };
    },
    async prepareTemplate(_image, definition): Promise<PreparedTemplate> {
      return { id: definition.id, name: definition.name, gray: new Uint8Array(9), width: 3, height: 3, w: 3, h: 3, refWidth: 6, refHeight: 6,
        refW: 6, refH: 6, shrink: 2, threshold: 0.85, std: 40 };
    },
    async match(_frame, template): Promise<MatchResult> {
      const hit = found(template.id);
      return { templateId: template.id, found: hit, score: hit ? 0.97 : 0.2, x: 40, y: 20, w: 6, h: 6, centerX: hit ? 43 : -1,
        centerY: hit ? 23 : -1, threshold: 0.85, elapsedMs: 1 };
    },
  };
}

export interface FakeScriptDevice extends ScriptDevice {
  actions: string[];
  foreground: string | undefined;
  shells: string[];
}

export function fakeScriptDevice(overrides: Partial<ScriptDevice> = {}): FakeScriptDevice {
  const device: FakeScriptDevice = {
    actions: [],
    shells: [],
    foreground: PKG,
    screencapRaw: async () => ({ width: 200, height: 100, data: new Uint8Array(200 * 100 * 4), capturedAt: Date.now() }),
    foregroundPackage: async () => device.foreground,
    tap: async (x, y) => { device.actions.push(`tap:${x},${y}`); },
    swipe: async (x1, y1, x2, y2, ms) => { device.actions.push(`swipe:${x1},${y1},${x2},${y2},${ms}`); },
    keyevent: async (key) => { device.actions.push(`key:${key}`); },
    text: async (value, beforeEach) => { await beforeEach?.(); device.actions.push(`text:${value}`); },
    startApp: async (pkg) => { device.actions.push(`start:${pkg}`); device.foreground = pkg; },
    stopApp: async (pkg) => { device.actions.push(`stop:${pkg}`); if (device.foreground === pkg) device.foreground = 'com.android.launcher3'; },
    shell: async (command) => { device.shells.push(command); return ''; },
    ...overrides,
  };
  return device;
}

export const FAST_PACING = { minCaptureIntervalMs: 0, captureJitterMs: 0, restartGapMs: 0, restartSettleMs: 0 };

export async function eventually(check: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error('条件未在期限内满足');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
