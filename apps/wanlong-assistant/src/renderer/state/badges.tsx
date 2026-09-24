import { createContext, useCallback, useContext, useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import type { SectionKey, ViewKey } from '../navigation';
import { sectionForView } from '../navigation';

/** A status chip in the top bar (errors / configuration needed), optionally linked to the page that fixes it. */
export interface ShellBadge {
  tone: 'bad' | 'warn' | 'info';
  /** Short Chinese label, e.g. 「实例读取失败」. */
  label: string;
  /** Longer explanation for the tooltip and screen readers. */
  detail?: string;
  /** Page that resolves it; its section also gets a dot in the side navigation. */
  view?: ViewKey;
}

export interface PublishedBadge extends ShellBadge {
  id: string;
}

interface BadgesState {
  badges: PublishedBadge[];
  publish(id: string, badge: ShellBadge | null): void;
}

const BadgesContext = createContext<BadgesState | null>(null);

const TONE_ORDER: Record<ShellBadge['tone'], number> = { bad: 0, warn: 1, info: 2 };

/** Most severe first, then by label so the order is stable. */
export function sortBadges(badges: readonly PublishedBadge[]): PublishedBadge[] {
  return [...badges].sort((a, b) => TONE_ORDER[a.tone] - TONE_ORDER[b.tone] || a.label.localeCompare(b.label, 'zh-CN'));
}

/** The most severe tone per navigation section, for the sidebar dots. */
export function sectionTones(badges: readonly ShellBadge[]): Partial<Record<SectionKey, ShellBadge['tone']>> {
  const tones: Partial<Record<SectionKey, ShellBadge['tone']>> = {};
  for (const badge of badges) {
    if (!badge.view) continue;
    const key = sectionForView(badge.view).key;
    const current = tones[key];
    if (!current || TONE_ORDER[badge.tone] < TONE_ORDER[current]) tones[key] = badge.tone;
  }
  return tones;
}

export function BadgesProvider({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<Record<string, ShellBadge>>({});
  const publish = useCallback((id: string, badge: ShellBadge | null) => {
    setEntries((current) => {
      const previous = current[id];
      if (!badge && !previous) return current;
      if (badge && previous && JSON.stringify(badge) === JSON.stringify(previous)) return current;
      const next = { ...current };
      if (badge) next[id] = badge;
      else delete next[id];
      return next;
    });
  }, []);
  const value = useMemo<BadgesState>(() => ({
    badges: sortBadges(Object.entries(entries).map(([id, badge]) => ({ id, ...badge }))),
    publish,
  }), [entries, publish]);
  return <BadgesContext.Provider value={value}>{children}</BadgesContext.Provider>;
}

export function useShellBadges(): PublishedBadge[] {
  const value = useContext(BadgesContext);
  if (!value) throw new Error('BadgesProvider 未挂载');
  return value.badges;
}

/** Show `badge` in the top bar while the calling component is mounted and `badge` is non-null. */
export function useShellBadge(badge: ShellBadge | null): void {
  const id = useId();
  const value = useContext(BadgesContext);
  if (!value) throw new Error('BadgesProvider 未挂载');
  const { publish } = value;
  const key = badge ? JSON.stringify(badge) : '';
  useEffect(() => {
    publish(id, key ? JSON.parse(key) as ShellBadge : null);
    return () => publish(id, null);
  }, [id, key, publish]);
}
