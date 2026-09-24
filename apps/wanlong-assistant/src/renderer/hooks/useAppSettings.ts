import { useEffect, useSyncExternalStore } from 'react';
import type { AppSettings } from '../../shared/app-settings';
import type { AppSettingsView } from '../../shared/ipc';
import { avdm, errMsg } from '../api';
import { createStore } from './store';

export interface AppSettingsState {
  view: AppSettingsView | null;
  error: string | null;
}

const store = createStore<AppSettingsState>({ view: null, error: null });
let started = false;

function load(): void {
  avdm.appSettings()
    .then((view) => store.set({ view, error: null }))
    .catch((error: unknown) => store.set((state) => ({ ...state, error: errMsg(error) })));
}

function start(): void {
  if (started) return;
  started = true;
  avdm.on('app-settings-changed', (view) => store.set({ view, error: null }));
  load();
}

/** Save a patch; main validates it and pushes `app-settings-changed` to every window. Throws the Chinese error. */
export async function saveAppSettings(patch: Partial<AppSettings>): Promise<AppSettingsView> {
  const view = await avdm.saveAppSettings(patch);
  store.set({ view, error: null });
  return view;
}

export function reloadAppSettings(): void {
  load();
}

/** The assistant's saved app settings (shot policy, capture interval …), shared by every reader. */
export function useAppSettings(): AppSettingsState {
  useEffect(start, []);
  return useSyncExternalStore(store.subscribe, store.get);
}
