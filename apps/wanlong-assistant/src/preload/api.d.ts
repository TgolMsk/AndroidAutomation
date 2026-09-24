import type { WanlongBridge } from '../shared/ipc';

declare global {
  interface Window {
    /**
     * Exposed by the Assistant preload script via contextBridge. Assistant methods resolve to envelopes;
     * use `avdm` from `src/renderer/api.ts`, which unwraps them into values or `WanlongError`s.
     */
    avdm: WanlongBridge;
  }
}

export {};
