import { useEffect, useSyncExternalStore } from 'react';
import type { HealthReport } from '../../shared/ipc';
import { avdm, errMsg } from '../api';
import { createStore } from './store';

export interface AppHealthState {
  report: HealthReport | null;
  /** A check requested from this window is running. */
  checking: boolean;
  error: string | null;
}

const store = createStore<AppHealthState>({ report: null, checking: false, error: null });
let started = false;

/** Read the latest report once and follow `app-health` pushes for the rest of the session (shared by all users). */
function start(): void {
  if (started) return;
  started = true;
  avdm.on('app-health', (report) => store.set((state) => ({ ...state, report, error: null })));
  avdm.appHealth()
    .then((report) => { if (report) store.set((state) => (state.report && state.report.checkedAt >= report.checkedAt ? state : { ...state, report })); })
    .catch((error: unknown) => store.set((state) => ({ ...state, error: errMsg(error) })));
}

/** Run the self-check again (「重新自检」); concurrent requests join the running check in main. */
export async function recheckAppHealth(): Promise<void> {
  store.set((state) => ({ ...state, checking: true, error: null }));
  try {
    const report = await avdm.runAppHealthCheck();
    store.set((state) => ({ ...state, report, checking: false }));
  } catch (error) {
    store.set((state) => ({ ...state, checking: false, error: errMsg(error) }));
  }
}

/** The environment self-check state, shared by the top-bar badge and the settings card. */
export function useAppHealth(): AppHealthState {
  useEffect(start, []);
  return useSyncExternalStore(store.subscribe, store.get);
}

/** Badge wording: 「自检未完成」 / 「环境正常」 / 「N 项异常」 / 「N 项提醒」. */
export function healthBadgeText(report: HealthReport | null): { label: string; tone: 'neutral' | 'success' | 'warning' | 'danger' } {
  if (!report) return { label: '自检未完成', tone: 'neutral' };
  const failed = report.items.filter((item) => item.level === 'fail').length;
  if (failed > 0) return { label: `${failed} 项异常`, tone: 'danger' };
  const warned = report.items.filter((item) => item.level === 'warn').length;
  if (warned > 0) return { label: `${warned} 项提醒`, tone: 'warning' };
  return { label: '环境正常', tone: 'success' };
}
