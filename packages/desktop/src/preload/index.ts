import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  EVENT_CHANNEL,
  INVOKE_METHODS,
  invokeChannel,
  type AvdmApi,
  type AvdmEventChannel,
  type AvdmEvents,
} from '../shared/ipc';

/** Mirrors IpcEnvelope in main/ipc-handlers.ts (preload is sandboxed, so no import from main). */
type Envelope = { ok: true; value: unknown } | { ok: false; error: { message: string; code?: string } };

type Listener = (payload: unknown) => void;

const listeners = new Map<AvdmEventChannel, Set<Listener>>();

// One IPC listener for every event channel; fan out to renderer subscribers.
ipcRenderer.on(EVENT_CHANNEL, (_event: IpcRendererEvent, message: { channel: AvdmEventChannel; payload: unknown }) => {
  const set = listeners.get(message?.channel);
  if (!set) return;
  for (const listener of [...set]) {
    try {
      listener(message.payload);
    } catch (err) {
      console.error(`[avdm] 事件处理出错 (${message.channel}):`, err);
    }
  }
});

function makeInvoker(method: (typeof INVOKE_METHODS)[number]) {
  const channel = invokeChannel(method);
  return async (...args: unknown[]): Promise<unknown> => {
    const res = (await ipcRenderer.invoke(channel, ...args)) as Envelope;
    if (res && res.ok) return res.value;
    // Only the message survives the context bridge; it is already user-facing Chinese.
    throw new Error(res?.error?.message ?? '未知错误');
  };
}

const api: Record<string, unknown> = {};
for (const method of INVOKE_METHODS) api[method] = makeInvoker(method);

api['on'] = <C extends AvdmEventChannel>(channel: C, listener: (payload: AvdmEvents[C]) => void): (() => void) => {
  let set = listeners.get(channel);
  if (!set) {
    set = new Set();
    listeners.set(channel, set);
  }
  const fn = listener as Listener;
  set.add(fn);
  return () => {
    set.delete(fn);
  };
};

contextBridge.exposeInMainWorld('avdm', api as unknown as AvdmApi);
