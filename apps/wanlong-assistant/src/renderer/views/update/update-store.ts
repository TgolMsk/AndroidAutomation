/**
 * The renderer's single copy of the update state (ported from wanlong-panel `features/update/updateStore.ts`).
 *
 * Two places show it — the version entry at the bottom of the sidebar and the 「版本与更新」 card in settings. Each
 * keeping its own useState + subscription would show "downloading" in one and "up to date" in the other, and the
 * phase → tone / text mappings would drift apart. So state, tone map and action wrapper live here; the views only
 * lay it out. Source: `updateState()` once, then `update-changed` pushes (progress is pushed too, never polled).
 * A tiny external store read through `useSyncExternalStore` (no zustand in this app).
 */
import { useEffect, useSyncExternalStore } from 'react';
import type { UpdatePhase, UpdateState } from '../../../shared/update';
import { avdm, errMsg } from '../../api';

export type UpdateTone = 'ok' | 'warn' | 'bad' | 'info' | 'neutral';

/** Phase → tone. Tags, the sidebar dot and notices all read it; there is only this copy. */
export const UPDATE_TONE: Record<UpdatePhase, UpdateTone> = {
  idle: 'neutral',
  checking: 'info',
  latest: 'ok',
  available: 'warn',
  downloading: 'info',
  downloaded: 'ok',
  error: 'bad',
  unsupported: 'neutral',
};

/**
 * Whether the sidebar dot is lit.
 * ★ Only when a new version really exists: available / downloading / downloaded. A failed check does NOT light it —
 *   an unattended machine that is offline or rate limited for weeks would otherwise wear the dot forever, and the
 *   dot would stop meaning "something to do". The failure is spelled out in the popover and the settings card.
 */
export function hasPendingUpdate(state: UpdateState | null): boolean {
  if (!state) return false;
  return state.phase === 'available' || state.phase === 'downloading' || state.phase === 'downloaded';
}

/** What the store needs from the main process (the real one is `avdm`; tests pass a fake). */
export interface UpdateClient {
  updateState(): Promise<UpdateState>;
  on(channel: 'update-changed', listener: (state: UpdateState) => void): () => void;
}

export interface UpdateSnapshot {
  /** Latest state from main; null until the first read arrives. */
  state: UpdateState | null;
  /** An action (check / download / cancel / install) is in flight: buttons spin and ignore repeated clicks. */
  busy: boolean;
  /** Why the first read failed (shown inline; a missing version must not blank the sidebar). */
  loadError: string | null;
}

export interface UpdateStore {
  getSnapshot(): UpdateSnapshot;
  subscribe(listener: () => void): () => void;
  load(): Promise<void>;
  /**
   * Run an action with the busy guard; errors go to `onError` (a toast), never thrown. A returned state is applied
   * only when no push arrived meanwhile, so a late response can never roll the state back.
   */
  run(action: () => Promise<UpdateState | void>, onError: (error: unknown) => void): Promise<void>;
  /** Reference-counted feed: the first holder loads and subscribes, the last one unsubscribes. */
  retain(): () => void;
  /** Number of current holders (for tests). */
  holders(): number;
}

export function createUpdateStore(client: UpdateClient): UpdateStore {
  let snapshot: UpdateSnapshot = { state: null, busy: false, loadError: null };
  const listeners = new Set<() => void>();
  /** Bumped on every push; responses that started before a push are stale. */
  let pushes = 0;
  let refs = 0;
  let off: (() => void) | null = null;

  const set = (patch: Partial<UpdateSnapshot>): void => {
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) {
      try { listener(); }
      catch { /* One broken subscriber must not starve the others. */ }
    }
  };

  const store: UpdateStore = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    async load() {
      const seen = pushes;
      try {
        const state = await client.updateState();
        if (seen === pushes) set({ state, loadError: null });
      } catch (error) {
        if (!snapshot.state) set({ loadError: errMsg(error) });
      }
    },
    async run(action, onError) {
      if (snapshot.busy) return;
      set({ busy: true });
      const seen = pushes;
      try {
        const next = await action();
        if (next && seen === pushes) set({ state: next });
      } catch (error) {
        onError(error);
      } finally {
        set({ busy: false });
      }
    },
    retain() {
      refs += 1;
      if (refs === 1) {
        try {
          off = client.on('update-changed', (state) => { pushes += 1; set({ state, loadError: null }); });
        } catch {
          // Without the push channel the state stays at what load() read; the views still render.
          off = null;
        }
        void store.load();
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        refs -= 1;
        if (refs === 0 && off) {
          try { off(); }
          catch { /* The view is gone anyway. */ }
          off = null;
        }
      };
    },
    holders: () => refs,
  };
  return store;
}

/** The app-wide store over the preload bridge. */
export const updateStore = createUpdateStore({
  updateState: () => avdm.updateState(),
  on: (channel, listener) => avdm.on(channel, listener),
});

/** Read the shared update state (re-renders on every change). */
export function useUpdateStore(): UpdateSnapshot {
  return useSyncExternalStore(updateStore.subscribe, updateStore.getSnapshot);
}

/** Connect this view to main's pushes; any number of views may call it, only one subscription exists. */
export function useUpdateFeed(): void {
  useEffect(() => updateStore.retain(), []);
}
