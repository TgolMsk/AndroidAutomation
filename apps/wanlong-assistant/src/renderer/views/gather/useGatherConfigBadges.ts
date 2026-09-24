import { useCallback, useEffect, useMemo, useState } from 'react';
import { avdm, errMsg } from '../../api';
import { useAvdmEvent } from '../../hooks/useAvdmEvent';
import { describeGatherConfigBadge, type GatherConfigBadge, type GatherConfigEntry } from './config-model';

export interface GatherConfigBadges {
  /** instanceIndex → badge. */
  badges: Readonly<Record<number, GatherConfigBadge>>;
  /** instanceIndex → loaded settings (or the load error). */
  entries: Readonly<Record<number, GatherConfigEntry>>;
  /** Instances that need attention (tone non-null): the number on the header button. */
  problemCount: number;
  /** Reload after a save. */
  refresh(): void;
}

/**
 * Config-health badges of the given instances (original useGatherConfigBadges): loads each instance's settings once,
 * again after `refresh()`, any settings save (`automation-settings-changed`, from whichever page), a template change or
 * any account change (binding moves configs).
 */
export function useGatherConfigBadges(
  gameId: string, indices: readonly number[], autoOf: (index: number) => boolean, boundOf: (index: number) => boolean,
): GatherConfigBadges {
  const [entries, setEntries] = useState<Record<number, GatherConfigEntry>>({});
  const [nonce, setNonce] = useState(0);
  const key = indices.join(',');
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!gameId) return;
    let alive = true;
    const wanted = key ? key.split(',').map(Number) : [];
    void Promise.all(wanted.map(async (index): Promise<[number, GatherConfigEntry]> => {
      try { return [index, { settings: await avdm.getAutomationSettings(gameId, index) }]; }
      catch (error) { return [index, { error: errMsg(error) }]; }
    })).then((list) => { if (alive) setEntries(Object.fromEntries(list)); });
    return () => { alive = false; };
  }, [gameId, key, nonce]);

  useAvdmEvent('account-changed', (event) => { if (event.gameId === gameId) refresh(); });
  useAvdmEvent('templates-changed', () => refresh());
  // A save from any page (the other page's drawer, a template set choice, a bind moving a config) reaches kept-alive
  // pages too, so every page shows the same badges.
  useAvdmEvent('automation-settings-changed', (event) => { if (event.gameId === gameId) refresh(); });

  const badges = useMemo(() => {
    const map: Record<number, GatherConfigBadge> = {};
    for (const index of indices) map[index] = describeGatherConfigBadge(entries[index], autoOf(index), boundOf(index));
    return map;
    // autoOf / boundOf are fresh closures each render; the badges only depend on what they return (the last key).
  }, [entries, key, indices.map((index) => `${autoOf(index) ? 1 : 0}${boundOf(index) ? 1 : 0}`).join('')]);

  const problemCount = useMemo(() => Object.values(badges).filter((badge) => badge.tone !== null).length, [badges]);
  return { badges, entries, problemCount, refresh };
}
