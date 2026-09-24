import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { EMPTY_LEGACY_IMPORT, type LegacyImportState } from '../views/automation/plan-legacy-import';
import { useSelection } from './selection';

export interface PlanImportState {
  /** The legacy import session of the current game. */
  legacy: LegacyImportState;
  updateLegacy(change: (current: LegacyImportState) => LegacyImportState): void;
}

const PlanImportContext = createContext<PlanImportState | null>(null);

/**
 * One legacy import session per game, shared by the 脚本 page (imports scripts) and the 任务计划 page (imports
 * plans): a plan import must see where 「导入旧脚本 JSON」 saved scripts whose ids were already taken.
 */
export function PlanImportProvider({ children }: { children: ReactNode }) {
  const { gameId } = useSelection();
  const [session, setSession] = useState<{ gameId: string; legacy: LegacyImportState }>({ gameId, legacy: EMPTY_LEGACY_IMPORT });
  const legacy = session.gameId === gameId ? session.legacy : EMPTY_LEGACY_IMPORT;

  const updateLegacy = useCallback((change: (current: LegacyImportState) => LegacyImportState) => {
    setSession((current) => ({ gameId, legacy: change(current.gameId === gameId ? current.legacy : EMPTY_LEGACY_IMPORT) }));
  }, [gameId]);

  const value = useMemo<PlanImportState>(() => ({ legacy, updateLegacy }), [legacy, updateLegacy]);
  return <PlanImportContext.Provider value={value}>{children}</PlanImportContext.Provider>;
}

export function usePlanImport(): PlanImportState {
  const value = useContext(PlanImportContext);
  if (!value) throw new Error('PlanImportProvider 未挂载');
  return value;
}
