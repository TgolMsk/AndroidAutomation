/**
 * Renderer store of the alerts module (original `features/alerts/alertStore.ts`, zustand → a tiny external store).
 *
 * First load: config, pauses and history, each on its own (one failing never blocks the others); afterwards the
 * pushes `alert-pause-changed` / `alert-raised` / `alert-config-changed` keep it current.
 * ★ Credentials: the store never holds a bot token. Main sends `AlertsConfigView` (no `botToken` key at all); a newly
 *   typed token lives only in the settings form until it is sent with the save patch.
 * ★ The red state is `pause.paused === true`, never `!auto` (switching auto off by hand is a normal action).
 */
import { useEffect, useSyncExternalStore } from 'react';
import {
  ALERT_HISTORY_LIMIT, defaultAlertsConfig, emptyPauseState, toAlertsConfigView, type AlertRecord, type AlertsConfigPatch,
  type AlertsConfigView, type InstancePauseState, type NotifierId, type NotifyResult,
} from '../../shared/alerts';
import { avdm, errMsg } from '../api';
import { createStore } from '../hooks/store';

export interface AlertsState {
  /** Masked view; the defaults (from the single authority) until main answered. */
  config: AlertsConfigView;
  configFromMain: boolean;
  /** instanceIndex → pause record (paused or cleared). */
  pauses: Record<number, InstancePauseState>;
  /** Newest first. */
  history: AlertRecord[];
  loaded: boolean;
  /** Chinese reason of a failed load (the page still renders). */
  error: string | null;
  /** Instances being resumed (spinner + no double clicks). */
  resuming: Record<number, boolean>;
}

/** The placeholder view: `defaultAlertsConfig()` through the same masking as main (no second literal copy). */
export function placeholderConfigView(): AlertsConfigView {
  return toAlertsConfigView(defaultAlertsConfig());
}

const store = createStore<AlertsState>({
  config: placeholderConfigView(), configFromMain: false, pauses: {}, history: [], loaded: false, error: null, resuming: {},
});
let started = false;

export function upsertPause(pauses: Record<number, InstancePauseState>, pause: InstancePauseState): Record<number, InstancePauseState> {
  return { ...pauses, [pause.instanceIndex]: pause };
}

export function prependRecord(history: AlertRecord[], record: AlertRecord): AlertRecord[] {
  return [record, ...history.filter((item) => item.event.id !== record.event.id)].slice(0, ALERT_HISTORY_LIMIT);
}

/** A pause record for display; a placeholder 「not paused」 when there is none. */
export function pauseOf(pauses: Record<number, InstancePauseState>, index: number | null): InstancePauseState | null {
  if (index === null) return null;
  return pauses[index] ?? emptyPauseState(index);
}

/** Indices currently paused by an alert, ascending. */
export function pausedIndexes(pauses: Record<number, InstancePauseState>): number[] {
  return Object.values(pauses).filter((pause) => pause.paused).map((pause) => pause.instanceIndex).sort((a, b) => a - b);
}

/** Load the three sources independently. */
export async function loadAlerts(): Promise<void> {
  const [config, pauses, history] = await Promise.allSettled([avdm.alertsConfig(), avdm.alertPauses(), avdm.alertHistory(ALERT_HISTORY_LIMIT)]);
  store.set((state) => ({
    ...state,
    ...(config.status === 'fulfilled' ? { config: config.value, configFromMain: true } : {}),
    ...(pauses.status === 'fulfilled' ? { pauses: Object.fromEntries(pauses.value.map((pause) => [pause.instanceIndex, pause])) } : {}),
    ...(history.status === 'fulfilled' ? { history: history.value } : {}),
    loaded: true,
    error: config.status === 'rejected' ? errMsg(config.reason) : pauses.status === 'rejected' ? errMsg(pauses.reason) : null,
  }));
}

function start(): void {
  if (started) return;
  started = true;
  avdm.on('alert-pause-changed', (pause) => store.set((state) => ({ ...state, pauses: upsertPause(state.pauses, pause) })));
  avdm.on('alert-raised', (record) => store.set((state) => ({ ...state, history: prependRecord(state.history, record) })));
  avdm.on('alert-config-changed', (config) => store.set((state) => ({ ...state, config, configFromMain: true })));
  void loadAlerts();
}

/** The shared alerts state (config view, pauses, history). */
export function useAlerts(): AlertsState {
  useEffect(start, []);
  return useSyncExternalStore(store.subscribe, store.get);
}

/** One instance's pause (null while no instance is selected). */
export function usePause(index: number | null): InstancePauseState | null {
  return pauseOf(useAlerts().pauses, index);
}

/** Save a patch; throws the Chinese error. */
export async function saveAlertsConfig(patch: AlertsConfigPatch): Promise<AlertsConfigView> {
  const config = await avdm.saveAlertsConfig(patch);
  store.set((state) => ({ ...state, config, configFromMain: true, error: null }));
  return config;
}

export function testAlertPush(channel: NotifierId): Promise<NotifyResult> {
  return avdm.testAlertPush(channel);
}

/** Resume a paused instance (re-enables automatic scheduling). Throws the Chinese error; guards double clicks. */
export async function resumePause(index: number): Promise<InstancePauseState> {
  if (store.get().resuming[index]) throw new Error('这个实例正在恢复，等它完成再点。');
  store.set((state) => ({ ...state, resuming: { ...state.resuming, [index]: true } }));
  try {
    const pause = await avdm.resumeAlertPause(index);
    store.set((state) => ({ ...state, pauses: upsertPause(state.pauses, pause) }));
    return pause;
  } finally {
    store.set((state) => {
      const resuming = { ...state.resuming };
      delete resuming[index];
      return { ...state, resuming };
    });
  }
}
