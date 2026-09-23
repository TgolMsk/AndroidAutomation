import type { AvdmApi } from '../shared/ipc';

declare global {
  interface Window {
    avdm: AvdmApi;
  }
}

export {};
