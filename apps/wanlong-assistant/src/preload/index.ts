import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  EVENT_CHANNEL, INVOKE_METHODS, invokeChannel,
  type AvdmEventChannel, type AvdmEvents,
} from '@avdm/emulator-shell/shared/ipc';
import {
  WANLONG_EVENT_CHANNEL, WANLONG_INVOKE_METHODS, wanlongInvokeChannel,
  type WanlongApi, type WanlongEvents,
} from '../shared/ipc';

type Envelope = { ok: true; value: unknown } | { ok: false; error: { message: string; code?: string } };
type Listener = (payload: unknown) => void;
type EventChannel = AvdmEventChannel | keyof WanlongEvents;

const listeners = new Map<EventChannel, Set<Listener>>();

function receive(_event: IpcRendererEvent, message: { channel: EventChannel; payload: unknown }): void {
  const set = listeners.get(message?.channel);
  if (!set) return;
  for (const listener of [...set]) {
    try { listener(message.payload); }
    catch (error) { console.error(`[wanlong] 事件处理出错 (${message.channel}):`, error); }
  }
}

ipcRenderer.on(EVENT_CHANNEL, receive);
ipcRenderer.on(WANLONG_EVENT_CHANNEL, receive);

function makeInvoker(channel: string): (...args: unknown[]) => Promise<unknown> {
  return async (...args: unknown[]): Promise<unknown> => {
    const response = await ipcRenderer.invoke(channel, ...args) as Envelope;
    if (response?.ok) return response.value;
    throw new Error(response?.error?.message ?? '未知错误');
  };
}

const api: Record<string, unknown> = {};
for (const method of INVOKE_METHODS) api[method] = makeInvoker(invokeChannel(method));
for (const method of WANLONG_INVOKE_METHODS) api[method] = makeInvoker(wanlongInvokeChannel(method));

api['on'] = <C extends EventChannel>(
  channel: C,
  listener: (payload: (AvdmEvents & WanlongEvents)[C]) => void,
): (() => void) => {
  let set = listeners.get(channel);
  if (!set) { set = new Set(); listeners.set(channel, set); }
  const fn = listener as Listener;
  set.add(fn);
  return () => { set.delete(fn); };
};

contextBridge.exposeInMainWorld('avdm', api as unknown as WanlongApi);
