import { parentPort } from 'node:worker_threads';
import { probeGame, type DevicePort, type RawFrame } from '@avdm/automation';
import {
  createGatherIo,
  loadGatherTemplates,
  runGatherCycle,
  wanlongPlugin,
} from '@avdm/automation/wanlong';
import type { GatherDeviceRequest, GatherMainToWorker, GatherWorkerToMain } from './gather-runner';
import { GATHER_PROBE_TEMPLATE_IDS, inspectGatherProbe } from './gather-probe-guard';

if (!parentPort) throw new Error('采集工作线程缺少通信端口');
const port = parentPort;
const controller = new AbortController();
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
let nextRequestId = 1;
let started = false;
let approve: (() => void) | undefined;
let deny: ((error: Error) => void) | undefined;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function checkAbort(): void {
  if (controller.signal.aborted) {
    throw controller.signal.reason instanceof Error ? controller.signal.reason : new Error('采集已取消');
  }
}

function request<T>(op: GatherDeviceRequest['op'], args: unknown[]): Promise<T> {
  checkAbort();
  const id = nextRequestId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    port.postMessage({ type: 'request', id, op, args } as GatherDeviceRequest);
  });
}

const device: DevicePort = {
  capture: () => request<RawFrame>('capture', []),
  foregroundPackage: () => request<string | null>('foregroundPackage', []),
  tap: (x, y) => request<void>('tap', [x, y]),
  swipe: (x1, y1, x2, y2, durationMs) => request<void>('swipe', [x1, y1, x2, y2, durationMs]),
  key: (key) => request<void>('key', [key]),
  launchApp: (packageName, cold) => request<void>('launchApp', [packageName, cold]),
  stopApp: (packageName) => request<void>('stopApp', [packageName]),
};

async function run(input: Extract<GatherMainToWorker, { type: 'start' }>): Promise<void> {
  try {
    const probe = await probeGame({
      plugin: wanlongPlugin,
      templateDir: input.templateDir,
      templateIds: GATHER_PROBE_TEMPLATE_IDS,
      device,
      signal: controller.signal,
    });
    const decision = inspectGatherProbe(probe);
    if (!decision.ok) throw new Error(decision.reason);
    const templates = await loadGatherTemplates({ templateDir: input.templateDir });
    checkAbort();
    if (await device.foregroundPackage() !== wanlongPlugin.packageName) {
      throw new Error('加载模板期间万龙觉醒已离开前台');
    }
    const approval = new Promise<void>((resolve, reject) => { approve = resolve; deny = reject; });
    port.postMessage({ type: 'ready', probe } satisfies GatherWorkerToMain);
    await approval;
    checkAbort();
    const io = createGatherIo(device, {
      refWidth: templates.refWidth,
      refHeight: templates.refHeight,
      signal: controller.signal,
    });
    const result = await runGatherCycle({
      io,
      templates,
      config: input.config,
      state: input.state,
      signal: controller.signal,
      instanceIndex: input.instanceIndex,
    });
    port.postMessage({ type: 'result', result } satisfies GatherWorkerToMain);
  } catch (error) {
    port.postMessage({ type: 'failed', error: errorMessage(error) } satisfies GatherWorkerToMain);
  }
}

port.on('message', (message: GatherMainToWorker) => {
  if (message.type === 'response') {
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    if (message.ok) item.resolve(message.value);
    else item.reject(new Error(message.error));
    return;
  }
  if (message.type === 'abort') {
    const error = new Error(message.reason);
    controller.abort(error);
    deny?.(error);
    deny = undefined;
    for (const item of pending.values()) item.reject(error);
    pending.clear();
    return;
  }
  if (message.type === 'approved') {
    approve?.();
    approve = undefined;
    deny = undefined;
    return;
  }
  if (message.type === 'start' && !started) {
    started = true;
    void run(message);
  }
});
