import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AdvisorTemplateProposal } from '../../main/automation/advisor/types';
import type { TemplateInsertRequest, TemplateInsertResult, TemplateSavedForScript } from '../views/automation/script-template-flow';
import { useNavigation } from './navigation';
import { useSelection } from './selection';

/**
 * Cross-page template flows:
 *  - AI page: an advisor template proposal opens the template library with the proposed crop;
 *  - script editor: 「从画面截取」 opens the template library, and saving returns to the script with the new
 *    template inserted. Request ids make stale callbacks harmless (`script-template-flow.ts`).
 */
export interface TemplateFlowState {
  proposal: AdvisorTemplateProposal | null;
  openTemplateProposal(proposal: AdvisorTemplateProposal): void;
  scriptInsert: TemplateInsertRequest | null;
  scriptResult: TemplateInsertResult | null;
  startScriptTemplate(request: TemplateInsertRequest): void;
  finishScriptTemplate(saved: TemplateSavedForScript, requestId: string): void;
  cancelScriptTemplate(): void;
  clearScriptResult(requestId: string): void;
}

const TemplateFlowContext = createContext<TemplateFlowState | null>(null);

export function TemplateFlowProvider({ children }: { children: ReactNode }) {
  const { view, navigate } = useNavigation();
  const { gameId, index } = useSelection();
  const [proposal, setProposal] = useState<AdvisorTemplateProposal | null>(null);
  const [scriptInsert, setScriptInsert] = useState<TemplateInsertRequest | null>(null);
  const [scriptResult, setScriptResult] = useState<TemplateInsertResult | null>(null);
  const insertRef = useRef<TemplateInsertRequest | null>(null);

  // A pending insert or result for another game/instance no longer applies.
  useEffect(() => {
    if (insertRef.current && (insertRef.current.gameId !== gameId || insertRef.current.index !== index)) {
      insertRef.current = null;
      setScriptInsert(null);
    }
    setScriptResult((current) => current && (current.gameId !== gameId || current.index !== index) ? null : current);
  }, [gameId, index]);

  // Leaving the template library abandons a pending script insert (the script keeps its draft).
  useEffect(() => {
    if (view !== 'templates' && insertRef.current) {
      insertRef.current = null;
      setScriptInsert(null);
    }
  }, [view]);

  const openTemplateProposal = useCallback((next: AdvisorTemplateProposal) => {
    setProposal(next);
    navigate('templates');
  }, [navigate]);

  const startScriptTemplate = useCallback((request: TemplateInsertRequest) => {
    insertRef.current = request;
    setScriptInsert(request);
    setScriptResult(null);
    setProposal(null);
    navigate('templates');
  }, [navigate]);

  const finishScriptTemplate = useCallback((saved: TemplateSavedForScript, requestId: string) => {
    const request = insertRef.current;
    if (!request || request.id !== requestId) return;
    insertRef.current = null;
    setScriptResult({ ...request, ...saved });
    setScriptInsert(null);
    navigate('scripts');
  }, [navigate]);

  const cancelScriptTemplate = useCallback(() => {
    insertRef.current = null;
    setScriptInsert(null);
    navigate('scripts');
  }, [navigate]);

  const clearScriptResult = useCallback((requestId: string) => {
    setScriptResult((current) => current?.id === requestId ? null : current);
  }, []);

  const value = useMemo<TemplateFlowState>(() => ({
    proposal, openTemplateProposal, scriptInsert, scriptResult,
    startScriptTemplate, finishScriptTemplate, cancelScriptTemplate, clearScriptResult,
  }), [proposal, openTemplateProposal, scriptInsert, scriptResult, startScriptTemplate, finishScriptTemplate,
    cancelScriptTemplate, clearScriptResult]);

  return <TemplateFlowContext.Provider value={value}>{children}</TemplateFlowContext.Provider>;
}

export function useTemplateFlow(): TemplateFlowState {
  const value = useContext(TemplateFlowContext);
  if (!value) throw new Error('TemplateFlowProvider 未挂载');
  return value;
}
