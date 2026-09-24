import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { readStoredView, sectionForView, storeView, viewForSection, type SectionKey, type ViewKey } from '../navigation';

export interface NavigationState {
  view: ViewKey;
  /** Open a page; it is remembered across restarts. */
  navigate(view: ViewKey): void;
  /** Open a section at the page last used in it during this session. */
  openSection(section: SectionKey): void;
}

const NavigationContext = createContext<NavigationState | null>(null);

export function NavigationProvider({ children }: { children: ReactNode }) {
  const [view, setView] = useState<ViewKey>(() => readStoredView());
  const sectionMemory = useRef<Partial<Record<SectionKey, ViewKey>>>({ [sectionForView(view).key]: view });

  const navigate = useCallback((next: ViewKey) => {
    sectionMemory.current[sectionForView(next).key] = next;
    storeView(next);
    setView(next);
  }, []);

  const openSection = useCallback((section: SectionKey) => {
    navigate(viewForSection(section, sectionMemory.current));
  }, [navigate]);

  const value = useMemo(() => ({ view, navigate, openSection }), [view, navigate, openSection]);
  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>;
}

export function useNavigation(): NavigationState {
  const value = useContext(NavigationContext);
  if (!value) throw new Error('NavigationProvider 未挂载');
  return value;
}
