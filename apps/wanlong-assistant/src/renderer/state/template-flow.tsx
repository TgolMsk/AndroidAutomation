import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { AdvisorTemplateProposal } from '../../main/automation/advisor/types';
import { useNavigation } from './navigation';

/** A template-set change made in the template library (select / create / save / delete). */
export interface TemplateChange {
  /** Increases with every change, so each one is seen exactly once. */
  seq: number;
  gameId: string;
  index: number | null;
  directory: string;
}

/**
 * Cross-page template flows:
 *  - AI page: an advisor template proposal opens the template library with the proposed crop;
 *  - gather page (kept alive): a template change (template library, or a capture in the script editor, which
 *    saves in its own dialog) invalidates its probe result for that instance.
 */
export interface TemplateFlowState {
  proposal: AdvisorTemplateProposal | null;
  openTemplateProposal(proposal: AdvisorTemplateProposal): void;
  templateChange: TemplateChange | null;
  noteTemplateChanged(gameId: string, index: number | null, directory: string): void;
}

const TemplateFlowContext = createContext<TemplateFlowState | null>(null);

export function TemplateFlowProvider({ children }: { children: ReactNode }) {
  const { navigate } = useNavigation();
  const [proposal, setProposal] = useState<AdvisorTemplateProposal | null>(null);
  const [templateChange, setTemplateChange] = useState<TemplateChange | null>(null);

  const openTemplateProposal = useCallback((next: AdvisorTemplateProposal) => {
    setProposal(next);
    navigate('templates');
  }, [navigate]);

  const noteTemplateChanged = useCallback((changedGameId: string, changedIndex: number | null, directory: string) => {
    setTemplateChange((current) => ({ seq: (current?.seq ?? 0) + 1, gameId: changedGameId, index: changedIndex, directory }));
  }, []);

  const value = useMemo<TemplateFlowState>(() => ({
    proposal, openTemplateProposal, templateChange, noteTemplateChanged,
  }), [proposal, openTemplateProposal, templateChange, noteTemplateChanged]);

  return <TemplateFlowContext.Provider value={value}>{children}</TemplateFlowContext.Provider>;
}

export function useTemplateFlow(): TemplateFlowState {
  const value = useContext(TemplateFlowContext);
  if (!value) throw new Error('TemplateFlowProvider 未挂载');
  return value;
}
