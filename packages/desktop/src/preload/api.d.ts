import type { AvdmApi } from '../shared/ipc';

declare global {
  interface Window {
    /** Exposed by the preload script via contextBridge. */
    avdm: AvdmApi;
  }
}

export {};
