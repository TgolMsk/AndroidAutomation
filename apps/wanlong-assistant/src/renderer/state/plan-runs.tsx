import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { PlanRun } from '../../main/plans/types';
import { avdm, errMsg } from '../api';
import { useSelection } from './selection';

/** Safety-net refresh for the top bar; the 执行监控 page polls faster while it is shown. */
const POLL_MS = 15_000;

/** Queued runs count as in progress: they hold a place in the instance's queue (the original 「执行中」 did too). */
export function isPlanRunActive(run: Pick<PlanRun, 'status'>): boolean {
  return run.status === 'queued' || run.status === 'running';
}

export interface PlanRunsState {
  /** Script runs of the current game, newest first. */
  planRuns: PlanRun[];
  planRunsError?: string;
  activePlanRuns: number;
  refreshPlanRuns(): Promise<void>;
}

const PlanRunsContext = createContext<PlanRunsState | null>(null);

/** Script (plan) runs of the current game, shared by the top bar's running count and the 执行监控 page. */
export function PlanRunsProvider({ children }: { children: ReactNode }) {
  const { gameId } = useSelection();
  const [planRuns, setPlanRuns] = useState<PlanRun[]>([]);
  const [planRunsError, setPlanRunsError] = useState<string>();
  const current = useRef(gameId);
  current.current = gameId;

  const refreshPlanRuns = useCallback(async () => {
    if (!gameId) return;
    try {
      const runs = (await avdm.planOverview(gameId)).runs;
      if (current.current !== gameId) return;
      setPlanRuns(runs);
      setPlanRunsError(undefined);
    } catch (error) {
      if (current.current === gameId) setPlanRunsError(errMsg(error));
    }
  }, [gameId]);

  useEffect(() => {
    setPlanRuns([]);
    setPlanRunsError(undefined);
    void refreshPlanRuns();
    const timer = window.setInterval(() => void refreshPlanRuns(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [refreshPlanRuns]);

  const value = useMemo<PlanRunsState>(() => ({
    planRuns, planRunsError, activePlanRuns: planRuns.filter(isPlanRunActive).length, refreshPlanRuns,
  }), [planRuns, planRunsError, refreshPlanRuns]);
  return <PlanRunsContext.Provider value={value}>{children}</PlanRunsContext.Provider>;
}

export function usePlanRuns(): PlanRunsState {
  const value = useContext(PlanRunsContext);
  if (!value) throw new Error('PlanRunsProvider 未挂载');
  return value;
}
