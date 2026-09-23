import type { WanlongApi } from '../shared/ipc';
export { errMsg, summarize, type BatchSummary } from '@avdm/emulator-shell/renderer/api';

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
  ? (window as Window & { avdm?: WanlongApi }).avdm
  : undefined;
export const avdm: WanlongApi = exposed ?? unavailableApi();
