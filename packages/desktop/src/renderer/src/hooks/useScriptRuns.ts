import { useCallback, useEffect, useRef, useState } from 'react';
import type { ScriptRunInfo } from '@avdm/core';
import { avdm } from '../api';
import { ScriptOutputStore } from './scriptOutputStore';
import { useAvdmEvent } from './useAvdmEvent';

export interface ScriptRunsStore {
  runs: ScriptRunInfo[];
  /** Live output, buffered outside React state; output views subscribe to it themselves. */
  output: ScriptOutputStore;
  refresh: () => Promise<void>;
}

function sortRuns(runs: ScriptRunInfo[]): ScriptRunInfo[] {
  return [...runs].sort((a, b) => {
    const ra = a.status === 'running' ? 0 : 1;
    const rb = b.status === 'running' ? 0 : 1;
    return ra - rb || b.startedAt.localeCompare(a.startedAt);
  });
}

/**
 * Script runs + their live output, buffered even while the scripts dialog is closed. Output lines do not
 * touch this hook's state, so they never re-render the component that owns it (the main view).
 */
export function useScriptRuns(): ScriptRunsStore {
  const [runs, setRuns] = useState<ScriptRunInfo[]>([]);
  const output = useRef<ScriptOutputStore | null>(null);
  if (!output.current) output.current = new ScriptOutputStore();

  const refresh = useCallback(async () => {
    try {
      const list = await avdm.listScriptRuns();
      setRuns(sortRuns(list));
    } catch {
      // manager not ready yet
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useAvdmEvent('script-run', (run) => {
    setRuns((prev) => sortRuns([run, ...prev.filter((r) => r.runId !== run.runId)]));
  });

  useAvdmEvent('script-output', ({ runId, line }) => {
    output.current?.push(runId, line);
  });

  return { runs, output: output.current, refresh };
}
