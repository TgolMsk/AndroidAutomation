import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { PlanRun, ScriptRunSnapshot } from '../../main/plans/types';
import { avdm, errMsg } from '../api';
import { useAvdmEvent } from '../hooks/useAvdmEvent';
import { pushRunLogs } from './run-log-store';
import { useSelection } from './selection';

/** Safety-net refresh for the top bar; the 执行监控 page polls faster while it is shown. */
const POLL_MS = 15_000;

/** Queued runs count as in progress: they hold a place in the instance's queue (the original 「执行中」 did too). */
export function isPlanRunActive(run: Pick<PlanRun, 'status'>): boolean {
  return run.status === 'queued' || run.status === 'running';
}

/** A live script execution (the runner's snapshot): starting, running, paused or stopping. */
export function isScriptRunActive(run: Pick<ScriptRunSnapshot, 'status'>): boolean {
  return run.status === 'pending' || run.status === 'starting' || run.status === 'running' || run.status === 'paused' || run.status === 'stopping';
}

/** Insert or replace by run id, newest first; a stale snapshot (older status of an ended run) never wins. */
export function upsertSnapshot(list: readonly ScriptRunSnapshot[], next: ScriptRunSnapshot): ScriptRunSnapshot[] {
  const current = list.find((run) => run.runId === next.runId);
  if (current && !isScriptRunActive(current) && isScriptRunActive(next) && (current.endedAt ?? 0) >= next.startedAt) return list as ScriptRunSnapshot[];
  return [next, ...list.filter((run) => run.runId !== next.runId)].sort((a, b) => b.startedAt - a.startedAt);
}

export function upsertPlanRun(list: readonly PlanRun[], next: PlanRun): PlanRun[] {
  const index = list.findIndex((run) => run.runId === next.runId);
  if (index < 0) return [next, ...list];
  const copy = list.slice();
  copy[index] = next;
  return copy;
}

/** Active work in the top bar: queued / running plan runs plus manual script runs (without double counting). */
export function countActiveScriptWork(planRuns: readonly PlanRun[], scriptRuns: readonly ScriptRunSnapshot[]): number {
  const planIds = new Set(planRuns.filter(isPlanRunActive).map((run) => run.runId));
  const extra = scriptRuns.filter((run) => isScriptRunActive(run) && !planIds.has(run.runId)).length;
  return planIds.size + extra;
}

/**
 * The live script run of each instance (the original run:start put the run id on the instance card), for the
 * instance list and the top-bar picker. Newest first wins; a runner never has two live runs on one instance.
 */
export function scriptRunsByInstance(scriptRuns: readonly ScriptRunSnapshot[]): Map<number, ScriptRunSnapshot> {
  const out = new Map<number, ScriptRunSnapshot>();
  for (const run of scriptRuns) if (isScriptRunActive(run) && !out.has(run.instanceIndex)) out.set(run.instanceIndex, run);
  return out;
}

/** Short badge text of a live script run on an instance. */
export function scriptRunBadge(run: Pick<ScriptRunSnapshot, 'status'>): string {
  if (run.status === 'paused') return '脚本已暂停';
  if (run.status === 'stopping') return '脚本停止中';
  return '脚本运行中';
}

export interface PlanRunsState {
  /** Plan queue records of the current game (plans.json), newest first. */
  planRuns: PlanRun[];
  /** Live and recently finished script executions of the current game (plan and manual), newest first. */
  scriptRuns: ScriptRunSnapshot[];
  planRunsError?: string;
  activePlanRuns: number;
  /** Instance index → its live script run (current game). */
  scriptRunByInstance: ReadonlyMap<number, ScriptRunSnapshot>;
  refreshPlanRuns(): Promise<void>;
}

const PlanRunsContext = createContext<PlanRunsState | null>(null);

/**
 * Script runs of the current game, shared by the top bar's running count and the 执行监控 page. Push events keep
 * it live (`plan-run`), and every `run-logs` batch goes into the log ring so no line is missed while the monitor
 * page is hidden.
 */
export function PlanRunsProvider({ children }: { children: ReactNode }) {
  const { gameId } = useSelection();
  const [planRuns, setPlanRuns] = useState<PlanRun[]>([]);
  const [scriptRuns, setScriptRuns] = useState<ScriptRunSnapshot[]>([]);
  const [planRunsError, setPlanRunsError] = useState<string>();
  const current = useRef(gameId);
  current.current = gameId;

  const refreshPlanRuns = useCallback(async () => {
    if (!gameId) return;
    try {
      const [overview, live] = await Promise.all([avdm.planOverview(gameId), avdm.runList(gameId)]);
      if (current.current !== gameId) return;
      setPlanRuns(overview.runs);
      setScriptRuns(live);
      setPlanRunsError(undefined);
    } catch (error) {
      if (current.current === gameId) setPlanRunsError(errMsg(error));
    }
  }, [gameId]);

  useEffect(() => {
    setPlanRuns([]);
    setScriptRuns([]);
    setPlanRunsError(undefined);
    void refreshPlanRuns();
    const timer = window.setInterval(() => void refreshPlanRuns(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [refreshPlanRuns]);

  useAvdmEvent('plan-run', (event) => {
    if (event.kind === 'snapshot') {
      if (event.snapshot.gameId === current.current) setScriptRuns((list) => upsertSnapshot(list, event.snapshot));
    } else if (event.run.gameId === current.current) {
      setPlanRuns((list) => upsertPlanRun(list, event.run));
    }
  });
  useAvdmEvent('run-logs', (event) => pushRunLogs(event.entries));

  const value = useMemo<PlanRunsState>(() => ({
    planRuns, scriptRuns, planRunsError, activePlanRuns: countActiveScriptWork(planRuns, scriptRuns),
    scriptRunByInstance: scriptRunsByInstance(scriptRuns), refreshPlanRuns,
  }), [planRuns, scriptRuns, planRunsError, refreshPlanRuns]);
  return <PlanRunsContext.Provider value={value}>{children}</PlanRunsContext.Provider>;
}

export function usePlanRuns(): PlanRunsState {
  const value = useContext(PlanRunsContext);
  if (!value) throw new Error('PlanRunsProvider 未挂载');
  return value;
}
