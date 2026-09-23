import type { WanlongApi } from '../shared/ipc';

declare global {
  interface Window {
    /** Exposed by the Assistant preload script via contextBridge. */
    avdm: WanlongApi;
  }
}

export {};
