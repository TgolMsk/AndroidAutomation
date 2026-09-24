import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AutomationRun, AutomationSchedule } from '../../shared/ipc';
import { avdm, errMsg } from '../api';
import { useAvdmEvent } from '../hooks/useAvdmEvent';

/** Safety-net refresh; normal updates arrive as `automation-run` / `automation-schedule` events. */
const POLL_MS = 15_000;

export function upsertRun(previous: readonly AutomationRun[], next: AutomationRun): AutomationRun[] {
  return [next, ...previous.filter((run) => run.runId !== next.runId)].sort((a, b) => b.startedAt - a.startedAt);
}

export function upsertSchedule(previous: readonly AutomationSchedule[], next: AutomationSchedule): AutomationSchedule[] {
  return [next, ...previous.filter((item) => item.gameId !== next.gameId || item.index !== next.index)];
}

export const RUN_LABEL: Record<AutomationRun['status'], string> = {
  running: '运行中',
  stopping: '停止中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

export function isRunActive(run: AutomationRun): boolean {
  return run.status === 'running' || run.status === 'stopping';
}

export interface ActivityState {
  /** Gather runs of every instance, newest first. */
  runs: AutomationRun[];
  runningCount: number;
  refreshRuns(): Promise<void>;
  upsertRun(run: AutomationRun): void;
  schedules: AutomationSchedule[];
  schedulesLoading: boolean;
  schedulesError?: string;
  refreshSchedules(): Promise<void>;
  upsertSchedule(schedule: AutomationSchedule): void;
  /** While held, polled schedules are ignored so an optimistic toggle is not overwritten mid-request. */
  holdSchedules(hold: boolean): void;
}

const ActivityContext = createContext<ActivityState | null>(null);

/** App-wide gather activity: runs and auto-resume schedules, shared by the top bar, targets and pages. */
export function ActivityProvider({ children }: { children: ReactNode }) {
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [schedules, setSchedules] = useState<AutomationSchedule[]>([]);
  const [schedulesLoading, setSchedulesLoading] = useState(true);
  const [schedulesError, setSchedulesError] = useState<string>();
  const held = useRef(false);

  const refreshRuns = useCallback(async () => {
    try { setRuns(await avdm.automationRuns()); }
    catch { /* The next poll or event retries; pages show their own errors. */ }
  }, []);

  const refreshSchedules = useCallback(async () => {
    if (held.current) return;
    try {
      const current = await avdm.automationSchedules();
      if (held.current) return;
      setSchedules(current);
      setSchedulesError(undefined);
    } catch (error) {
      if (!held.current) setSchedulesError(errMsg(error));
    } finally {
      setSchedulesLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshRuns();
    void refreshSchedules();
    const timer = window.setInterval(() => { void refreshRuns(); void refreshSchedules(); }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [refreshRuns, refreshSchedules]);

  useAvdmEvent('automation-run', (run) => setRuns((previous) => upsertRun(previous, run)));
  useAvdmEvent('automation-schedule', (schedule) => setSchedules((previous) => upsertSchedule(previous, schedule)));

  const value = useMemo<ActivityState>(() => ({
    runs,
    runningCount: runs.filter((run) => run.status === 'running').length,
    refreshRuns,
    upsertRun: (run) => setRuns((previous) => upsertRun(previous, run)),
    schedules,
    schedulesLoading,
    schedulesError,
    refreshSchedules,
    upsertSchedule: (schedule) => {
      setSchedules((previous) => upsertSchedule(previous, schedule));
      setSchedulesError(undefined);
    },
    holdSchedules: (hold) => { held.current = hold; },
  }), [runs, schedules, schedulesLoading, schedulesError, refreshRuns, refreshSchedules]);

  return <ActivityContext.Provider value={value}>{children}</ActivityContext.Provider>;
}

export function useActivity(): ActivityState {
  const value = useContext(ActivityContext);
  if (!value) throw new Error('ActivityProvider 未挂载');
  return value;
}
