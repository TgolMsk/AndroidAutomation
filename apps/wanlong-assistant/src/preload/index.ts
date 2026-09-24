import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { EVENT_CHANNEL, INVOKE_METHODS, invokeChannel } from '@avdm/emulator-shell/shared/ipc';
import {
  WANLONG_EVENT_CHANNEL, WANLONG_INVOKE_METHODS, wanlongInvokeChannel,
  type WanlongAllEvents, type WanlongBridge, type WanlongEnvelope,
} from '../shared/ipc';

type Listener = (payload: unknown) => void;
type EventChannel = keyof WanlongAllEvents;

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

/** Shell methods keep their contract: resolve with the value or reject with the message. */
function makeInvoker(channel: string): (...args: unknown[]) => Promise<unknown> {
  return async (...args: unknown[]): Promise<unknown> => {
    const response = await ipcRenderer.invoke(channel, ...args) as WanlongEnvelope;
    if (response?.ok) return response.value;
    throw new Error(response?.error?.message ?? '未知错误');
  };
}

/**
 * Assistant methods return the envelope itself so the error code survives contextBridge; the renderer's
 * `api.ts` turns failures into `WanlongError`s. Only plain strings cross the bridge.
 */
function makeEnvelopeInvoker(channel: string): (...args: unknown[]) => Promise<WanlongEnvelope> {
  return async (...args: unknown[]): Promise<WanlongEnvelope> => {
    const response = await ipcRenderer.invoke(channel, ...args) as WanlongEnvelope | undefined;
    if (response?.ok === true) return { ok: true, value: response.value };
    const message = typeof response?.error?.message === 'string' ? response.error.message : '未知错误';
    const code = typeof response?.error?.code === 'string' ? response.error.code : undefined;
    return { ok: false, error: code ? { message, code } : { message } };
  };
}

const api: Record<string, unknown> = {};
for (const method of INVOKE_METHODS) api[method] = makeInvoker(invokeChannel(method));
for (const method of WANLONG_INVOKE_METHODS) api[method] = makeEnvelopeInvoker(wanlongInvokeChannel(method));

api['on'] = <C extends EventChannel>(
  channel: C,
  listener: (payload: WanlongAllEvents[C]) => void,
): (() => void) => {
  let set = listeners.get(channel);
  if (!set) { set = new Set(); listeners.set(channel, set); }
  const fn = listener as Listener;
  set.add(fn);
  return () => { set.delete(fn); };
};

contextBridge.exposeInMainWorld('avdm', api as unknown as WanlongBridge);
