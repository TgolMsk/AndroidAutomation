/**
 * Queue snapshots of every instance in the renderer (original features/gather/marchStore.ts, zustand replaced by a
 * module-level store read with `useSyncExternalStore`). The first load reads `schedulerStates`, then
 * `scheduler-changed` pushes keep it current (samples, auto switch, re-armed wakes, operating flag).
 *
 * ★ The store keeps SAMPLES, never per-second countdowns: those are derived locally by present.ts every second and
 *   never written back (a store update per second for dozens of rows would drag the renderer down).
 * ★ A failing call is never swallowed: every action returns null on success or a Chinese reason, and a load failure
 *   is kept in `error` while the page still renders placeholder cards.
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { defaultSchedulerConfig, type SchedulerConfig } from '@avdm/automation/wanlong/pure';
import type { SchedulerQueueState, SchedulerServiceStatus, SchedulerSetAutoOptions } from '../../../shared/ipc';
import { avdm, errMsg } from '../../api';

export interface GatherQueuesSnapshot {
  gameId: string;
  /** instanceIndex → last queue snapshot. */
  byInstance: Readonly<Record<number, SchedulerQueueState>>;
  /** The scheduler's own runtime config (slack, calibration … decide when it wakes). */
  config: SchedulerConfig;
  /** Owner or read-only window (another assistant process schedules). */
  status: SchedulerServiceStatus | null;
  /** The first load finished (successfully or not). */
  loaded: boolean;
  /** Chinese reason the states could not be read; null when fine. */
  error: string | null;
  /**
   * Anti double-click: instances being sampled / switched from this window. (Resuming a pause is the alerts module's:
   * `resumePause` guards its own double clicks.)
   */
  sampling: Readonly<Record<number, true>>;
  autoBusy: Readonly<Record<number, true>>;
}

function initial(gameId: string): GatherQueuesSnapshot {
  return {
    gameId, byInstance: {}, config: defaultSchedulerConfig(), status: null, loaded: false, error: null,
    sampling: {}, autoBusy: {},
  };
}

let snapshot: GatherQueuesSnapshot = initial('');
const listeners = new Set<() => void>();
let detachEvents: (() => void) | null = null;
let loadSequence = 0;

function emit(): void {
  for (const listener of listeners) listener();
}

function update(patch: Partial<GatherQueuesSnapshot> | ((current: GatherQueuesSnapshot) => Partial<GatherQueuesSnapshot>)): void {
  const next = typeof patch === 'function' ? patch(snapshot) : patch;
  snapshot = { ...snapshot, ...next };
  emit();
}

function flag(map: Readonly<Record<number, true>>, index: number, on: boolean): Readonly<Record<number, true>> {
  const next = { ...map };
  if (on) next[index] = true;
  else delete next[index];
  return next;
}

/** Translate any failure into Chinese that points to a fix (original describeSchedulerError). */
export function describeSchedulerError(error: unknown): string {
  const message = errMsg(error).replace(/^Error:\s*/, '');
  if (/No handler registered|no handler/i.test(message)) {
    return '主进程还没有注册调度器通道。ETA 调度模块接线之后本页会自动可用，在此之前显示的是占位数据。';
  }
  return message || '未知错误';
}

/** Put a newer snapshot of one instance into the store (a push or a call's reply). Other games are ignored. */
export function upsertQueueState(state: SchedulerQueueState): void {
  if (snapshot.gameId && state.gameId !== snapshot.gameId) return;
  update((current) => ({ byInstance: { ...current.byInstance, [state.instanceIndex]: state } }));
}

function attachEvents(): void {
  if (detachEvents) return;
  try {
    const offs = [
      avdm.on('scheduler-changed', (state) => upsertQueueState(state)),
      avdm.on('scheduler-config-changed', (config) => update({ config })),
      avdm.on('scheduler-status', (status) => { if (!snapshot.gameId || status.gameId === snapshot.gameId) update({ status }); }),
    ];
    detachEvents = () => { for (const off of offs) { try { off(); } catch { /* the page is gone anyway */ } } };
  } catch (error) {
    update({ error: describeSchedulerError(error) });
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  attachEvents();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      detachEvents?.();
      detachEvents = null;
    }
  };
}

function getSnapshot(): GatherQueuesSnapshot {
  return snapshot;
}

/** The current store snapshot (what `useGatherQueues` renders). */
export function gatherQueuesSnapshot(): GatherQueuesSnapshot {
  return snapshot;
}

/**
 * Full reload for `gameId`: states first (errors go to `error`), then the scheduler's config and status separately
 * (a failure there keeps the defaults; the state error already says what is wrong). Stale replies are dropped.
 */
export async function loadQueues(gameId: string): Promise<void> {
  if (snapshot.gameId !== gameId) snapshot = initial(gameId);
  const mine = ++loadSequence;
  try {
    const list = await avdm.schedulerStates(gameId);
    if (mine !== loadSequence) return;
    const byInstance: Record<number, SchedulerQueueState> = {};
    for (const state of list) byInstance[state.instanceIndex] = state;
    update({ byInstance, error: null, loaded: true });
  } catch (error) {
    if (mine === loadSequence) update({ error: describeSchedulerError(error), loaded: true });
  }
  const [config, status] = await Promise.all([
    avdm.schedulerConfig(gameId).catch(() => null),
    avdm.schedulerStatus(gameId).catch(() => null),
  ]);
  if (mine !== loadSequence) return;
  update((current) => ({ config: config ?? current.config, status: status ?? current.status }));
}

/** Sample one instance now (opens the troop panel, never dispatches). null on success, else a Chinese reason. */
export async function sampleQueue(gameId: string, index: number): Promise<string | null> {
  if (snapshot.sampling[index]) return '这个实例正在采样，等它完成再点。';
  update((current) => ({ sampling: flag(current.sampling, index, true) }));
  try {
    upsertQueueState(await avdm.schedulerSample(gameId, index));
    return null;
  } catch (error) {
    return describeSchedulerError(error);
  } finally {
    update((current) => ({ sampling: flag(current.sampling, index, false) }));
  }
}

/**
 * Switch auto scheduling (the same path as the old 自动续跑 switch: readiness gate, first-enable probe gate, then one
 * read-only sample). The busy map is read from the store, so a stale closure cannot let a double click through.
 * `opts.probeCapturedAt`: the passing probe the user just confirmed (it counts as the first-enable probe gate).
 */
export async function setQueueAuto(gameId: string, index: number, enabled: boolean, opts?: SchedulerSetAutoOptions): Promise<string | null> {
  if (snapshot.autoBusy[index]) return '这个实例的开关正在切换，等它完成再点。';
  update((current) => ({ autoBusy: flag(current.autoBusy, index, true) }));
  try {
    upsertQueueState(await (opts ? avdm.schedulerSetAuto(gameId, index, enabled, opts) : avdm.schedulerSetAuto(gameId, index, enabled)));
    return null;
  } catch (error) {
    return describeSchedulerError(error);
  } finally {
    update((current) => ({ autoBusy: flag(current.autoBusy, index, false) }));
  }
}

/** Save part of the scheduler's runtime config. null on success, else a Chinese reason. */
export async function saveQueueConfig(gameId: string, patch: Partial<SchedulerConfig>): Promise<string | null> {
  try {
    update({ config: await avdm.saveSchedulerConfig(gameId, patch) });
    return null;
  } catch (error) {
    return describeSchedulerError(error);
  }
}

/** Placeholder for an instance the scheduler has no record of, so every instance renders the same way. */
export function emptyQueueState(index: number, accountId: string | null, gameId: string): SchedulerQueueState {
  return {
    instanceIndex: index, accountId, queueUsed: null, queueTotal: null, marches: [], lastSampledAt: 0, lastSampleOk: false,
    error: null, warnings: [], auto: false, sampling: false, nextWakeAt: null, nextWakeReason: null, backoffStep: 0,
    gameId, failureCount: 0, pause: null,
  };
}

export interface GatherQueuesApi extends GatherQueuesSnapshot {
  /** The instance's snapshot, or a placeholder. */
  stateOf(index: number, accountId?: string | null): SchedulerQueueState;
  reload(): Promise<void>;
  sample(index: number): Promise<string | null>;
  setAuto(index: number, enabled: boolean): Promise<string | null>;
  saveConfig(patch: Partial<SchedulerConfig>): Promise<string | null>;
}

/** Queue snapshots of `gameId`, loaded on mount and kept current by pushes. */
export function useGatherQueues(gameId: string): GatherQueuesApi {
  const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => { if (gameId) void loadQueues(gameId); }, [gameId]);
  const reload = useCallback(() => loadQueues(gameId), [gameId]);
  const view = current.gameId === gameId ? current : initial(gameId);
  return {
    ...view,
    stateOf: (index, accountId = null) => view.byInstance[index] ?? emptyQueueState(index, accountId, gameId),
    reload,
    sample: (index) => sampleQueue(gameId, index),
    setAuto: (index, enabled) => setQueueAuto(gameId, index, enabled),
    saveConfig: (patch) => saveQueueConfig(gameId, patch),
  };
}

/** Reset the module store (tests). */
export function resetGatherQueuesForTest(): void {
  snapshot = initial('');
  loadSequence += 1;
  emit();
}
