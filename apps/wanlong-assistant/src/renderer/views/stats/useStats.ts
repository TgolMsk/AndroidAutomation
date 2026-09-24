import { useCallback, useEffect, useRef, useState } from 'react';
import { emptyDailyStats, type DailyStats } from '../../../shared/stats';
import { cstDateKey, shiftDateKey, type DateKey } from '../../../shared/time';
import { avdm, errMsg, errorCodeOf } from '../../api';
import { useAvdmEvent } from '../../hooks/useAvdmEvent';
import { RECENT_DAYS, applyTodayPush, cachedDay, type StatsViewState } from './stats-model';

/** Today is re-read this often while the page is shown, in case a push was missed (pushes normally keep it live). */
const SAFETY_POLL_MS = 60_000;

export interface SnapshotFailure {
  message: string;
  /** The instance was busy (another activity holds it): retry later, not a failure. */
  retry: boolean;
}

export interface StatsStore extends StatsViewState {
  /** The first load finished (successfully or not). */
  loaded: boolean;
  loading: boolean;
  /** Chinese reason of the last failed read; the page still renders empty buckets. */
  error: string | null;
  /** Instances whose resource table is being read (this page's clicks and reads started elsewhere, e.g. the bot). */
  reading: ReadonlySet<number>;
  /** A read started from this page is running (the global instance picker is locked meanwhile). */
  readingHere: boolean;
  load(): Promise<void>;
  selectDay(key: DateKey): Promise<void>;
  /** Read the resource table once; null on success. */
  snapshotNow(index: number): Promise<SnapshotFailure | null>;
}

/**
 * The page's store (original zustand statsStore): today + the selected day + the recent list, live through the
 * `stats-today` push (Beijing midnight included), with a stale-response guard when the day changes quickly.
 */
export function useStats(gameId: string, visible: boolean): StatsStore {
  const [state, setState] = useState<StatsViewState>(() => ({
    today: null, selectedKey: cstDateKey(Date.now()), selected: null, recent: [],
  }));
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mine, setMine] = useState<ReadonlySet<number>>(new Set());
  const [elsewhere, setElsewhere] = useState<ReadonlySet<number>>(new Set());
  const stateRef = useRef(state);
  stateRef.current = state;
  const mineRef = useRef(mine);
  mineRef.current = mine;
  const selectSeq = useRef(0);

  const update = useCallback((fn: (current: StatsViewState) => StatsViewState) => {
    setState((current) => {
      const next = fn(current);
      stateRef.current = next;
      return next;
    });
  }, []);

  const load = useCallback(async () => {
    if (!gameId) return;
    setLoading(true);
    const localToday = cstDateKey(Date.now());
    let todayKey = localToday;
    let failure: string | null = null;
    try {
      const today = await avdm.statsDaily(gameId, null);
      todayKey = today.dateKey;
      update((current) => ({ ...current, today, ...(current.selectedKey === today.dateKey ? { selected: today } : {}) }));
    } catch (cause) {
      failure = errMsg(cause);
      update((current) => ({ ...current, today: current.today ?? emptyDailyStats(localToday, 0, gameId) }));
    }
    const selectedKey = stateRef.current.selectedKey;
    if (selectedKey !== todayKey) {
      try {
        const selected = await avdm.statsDaily(gameId, selectedKey);
        update((current) => (current.selectedKey === selectedKey ? { ...current, selected } : current));
      } catch (cause) {
        failure ??= errMsg(cause);
        update((current) => (current.selectedKey === selectedKey ? { ...current, selected: emptyDailyStats(selectedKey, 0, gameId) } : current));
      }
    } else {
      update((current) => (current.selected || current.selectedKey !== todayKey ? current : { ...current, selected: current.today }));
    }
    try {
      const recent = await avdm.statsRange(gameId, shiftDateKey(todayKey, -(RECENT_DAYS - 1)), todayKey);
      update((current) => ({ ...current, recent }));
    } catch {
      // The recent table is secondary: the error above already says what is wrong.
    }
    try {
      setElsewhere(new Set(await avdm.resourcesReading(gameId)));
    } catch { /* busy state only */ }
    setError(failure);
    setLoaded(true);
    setLoading(false);
  }, [gameId, update]);

  const selectDay = useCallback(async (key: DateKey) => {
    const seq = ++selectSeq.current;
    const cached = cachedDay(stateRef.current, key);
    if (cached) {
      update((current) => ({ ...current, selectedKey: key, selected: cached }));
      return;
    }
    update((current) => ({ ...current, selectedKey: key, selected: null }));
    setLoading(true);
    try {
      const selected = await avdm.statsDaily(gameId, key);
      // The user moved on while this was loading: the answer is stale.
      if (seq === selectSeq.current) { update((current) => ({ ...current, selected })); setError(null); }
    } catch (cause) {
      if (seq === selectSeq.current) {
        update((current) => ({ ...current, selected: emptyDailyStats(key, 0, gameId) }));
        setError(errMsg(cause));
      }
    } finally {
      if (seq === selectSeq.current) setLoading(false);
    }
  }, [gameId, update]);

  const snapshotNow = useCallback(async (index: number): Promise<SnapshotFailure | null> => {
    if (mineRef.current.has(index)) return { message: '这个实例正在读资源统计，等它完成再点。', retry: true };
    setMine((current) => new Set(current).add(index));
    try {
      // The snapshot comes back through the stats-today push as well; nothing to insert by hand.
      await avdm.statsSnapshotNow(gameId, index);
      return null;
    } catch (cause) {
      return { message: errMsg(cause), retry: errorCodeOf(cause) === 'CONCURRENCY_LIMIT' };
    } finally {
      setMine((current) => {
        const next = new Set(current);
        next.delete(index);
        return next;
      });
    }
  }, [gameId]);

  useEffect(() => {
    setState({ today: null, selectedKey: cstDateKey(Date.now()), selected: null, recent: [] });
    setLoaded(false);
    void load();
  }, [load]);

  useEffect(() => {
    if (!visible || !gameId) return;
    const timer = window.setInterval(() => {
      avdm.statsDaily(gameId, null).then((today) => update((current) => applyTodayPush(current, today))).catch(() => undefined);
    }, SAFETY_POLL_MS);
    return () => window.clearInterval(timer);
  }, [visible, gameId, update]);

  useAvdmEvent('stats-today', (today) => {
    if (today.gameId !== gameId) return;
    update((current) => applyTodayPush(current, today));
  });

  useAvdmEvent('resources-reading', (event) => {
    if (event.gameId !== gameId) return;
    setElsewhere((current) => {
      const next = new Set(current);
      if (event.reading) next.add(event.index); else next.delete(event.index);
      return next;
    });
  });

  const reading = new Set([...mine, ...elsewhere]);
  return { ...state, loaded, loading, error, reading, readingHere: mine.size > 0, load, selectDay, snapshotNow };
}

export type { DailyStats };
