import { INVOKE_METHODS } from '@avdm/emulator-shell/shared/ipc';
import { WANLONG_INVOKE_METHODS, type WanlongApi, type WanlongBridge, type WanlongEnvelope } from '../shared/ipc';
export { errMsg, summarize, type BatchSummary } from '@avdm/emulator-shell/renderer/api';

/**
 * A failed assistant call. Built in the renderer from the preload's envelope, so `code` (for example
 * `LOCK_TIMEOUT` or a future `CONCURRENCY_LIMIT`) survives the process boundary and UI code can branch on it.
 */
export class WanlongError extends Error {
  readonly code: string | undefined;

  constructor(message: string, code?: string) {
    super(message);
    this.name = 'WanlongError';
    this.code = code;
  }
}

/** The error code of a rejected assistant call, if the main process attached one. */
export function errorCodeOf(error: unknown): string | undefined {
  if (error instanceof WanlongError) return error.code;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** Value of a successful envelope; otherwise throws a `WanlongError` carrying the message and code. */
export function unwrapEnvelope<T>(envelope: WanlongEnvelope<T> | undefined): T {
  if (envelope?.ok === true) return envelope.value;
  const error = envelope && envelope.ok === false ? envelope.error : undefined;
  throw new WanlongError(typeof error?.message === 'string' && error.message ? error.message : '未知错误', error?.code);
}

/**
 * The renderer-facing API over the preload bridge: shell methods and `on` pass through unchanged, and every
 * assistant method is unwrapped so callers keep the familiar `await avdm.x()` / `catch` style.
 */
export function wrapBridge(bridge: WanlongBridge): WanlongApi {
  const api: Record<string, unknown> = {};
  const raw = bridge as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  for (const method of INVOKE_METHODS) api[method] = (...args: unknown[]) => raw[method]!(...args);
  for (const method of WANLONG_INVOKE_METHODS) {
    api[method] = async (...args: unknown[]) => unwrapEnvelope(await raw[method]!(...args) as WanlongEnvelope);
  }
  api['on'] = bridge.on.bind(bridge);
  return api as unknown as WanlongApi;
}

/** Browser previews report unavailable IPC without crashing during render. */
function unavailableApi(): WanlongApi {
  return new Proxy({} as WanlongApi, {
    get(_target, prop) {
      if (prop === 'on') return () => () => undefined;
      return () => Promise.reject(new Error('未连接到主进程（预加载脚本不可用）'));
    },
  });
}

const exposed = typeof window !== 'undefined'
  ? (window as Window & { avdm?: WanlongBridge }).avdm
  : undefined;
export const avdm: WanlongApi = exposed ? wrapBridge(exposed) : unavailableApi();
