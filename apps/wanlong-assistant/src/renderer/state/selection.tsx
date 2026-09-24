import { createContext, useCallback, useContext, useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import type { InstanceState } from '@avdm/core';
import type { AutomationGameSummary, AutomationSchedule } from '../../shared/ipc';
import { avdm, errMsg } from '../api';
import { isRunning } from '../format';
import { useInstances } from '../hooks/useInstances';
import { useActivity } from './activity';

export interface AutomationTarget {
  index: number;
  /** Absent when the instance was deleted but an enabled schedule still points at it. */
  instance?: InstanceState;
}

/** Retain stopped instances and enabled schedules whose instance has since been removed, so both can be switched off. */
export function automationTargets(instances: InstanceState[], schedules: AutomationSchedule[], gameId: string): AutomationTarget[] {
  const targets: AutomationTarget[] = instances.map((instance) => ({ index: instance.record.index, instance }));
  for (const schedule of schedules) {
    if (schedule.gameId === gameId && schedule.enabled && !targets.some((target) => target.index === schedule.index)) {
      targets.push({ index: schedule.index });
    }
  }
  return targets.sort((a, b) => a.index - b.index);
}

export function canLaunchOnTarget(instance: InstanceState | undefined): boolean {
  return Boolean(instance && isRunning(instance));
}

/** Keep the current choice while it exists; otherwise prefer a running instance, then any live one, then the first. */
export function pickTargetIndex(current: number | null, targets: readonly AutomationTarget[]): number | null {
  if (targets.length === 0) return null;
  if (current !== null && targets.some((target) => target.index === current)) return current;
  return (targets.find((target) => canLaunchOnTarget(target.instance)) ??
    targets.find((target) => target.instance) ?? targets[0]!).index;
}

/** The game to show: keep the current one while it is still registered, else the first. */
export function pickGameId(current: string, games: readonly AutomationGameSummary[]): string {
  return games.some((game) => game.id === current) ? current : games[0]?.id ?? '';
}

export interface SelectionState {
  games: AutomationGameSummary[];
  gamesLoaded: boolean;
  gamesError?: string;
  reloadGames(): Promise<void>;
  gameId: string;
  game?: AutomationGameSummary;
  setGameId(id: string): void;

  instances: InstanceState[];
  instancesLoaded: boolean;
  instancesError?: string;
  reloadInstances(): Promise<void>;

  /** Instances plus orphaned enabled schedules of the current game. */
  targets: AutomationTarget[];
  index: number | null;
  setIndex(index: number): void;
  selectedTarget?: AutomationTarget;
  selectedInstance?: InstanceState;
  selectedInstanceReady: boolean;

  /** Why the global instance picker is disabled right now (a page has a device action in flight), or null. */
  lockReason: string | null;
  setLock(owner: string, reason: string | null): void;
}

const SelectionContext = createContext<SelectionState | null>(null);

/** Global game + instance selection shared by every page (the old per-page selector moved to the top bar). */
export function SelectionProvider({ children }: { children: ReactNode }) {
  const { instances, loaded: instancesLoaded, error: instancesError, reload: reloadInstances } = useInstances();
  const { schedules } = useActivity();
  const [games, setGames] = useState<AutomationGameSummary[]>([]);
  const [gamesLoaded, setGamesLoaded] = useState(false);
  const [gamesError, setGamesError] = useState<string>();
  const [gameId, setGameId] = useState('');
  const [index, setIndexState] = useState<number | null>(null);
  const [locks, setLocks] = useState<Record<string, string>>({});

  const reloadGames = useCallback(async () => {
    try {
      const list = await avdm.automationGames();
      setGames(list);
      setGameId((current) => pickGameId(current, list));
      setGamesError(undefined);
    } catch (error) {
      setGamesError(errMsg(error));
    } finally {
      setGamesLoaded(true);
    }
  }, []);

  useEffect(() => { void reloadGames(); }, [reloadGames]);

  const targets = useMemo(() => automationTargets(instances, schedules, gameId), [instances, schedules, gameId]);
  useEffect(() => { setIndexState((current) => pickTargetIndex(current, targets)); }, [targets]);

  const setLock = useCallback((owner: string, reason: string | null) => {
    setLocks((current) => {
      if ((current[owner] ?? null) === reason) return current;
      const next = { ...current };
      if (reason === null) delete next[owner];
      else next[owner] = reason;
      return next;
    });
  }, []);

  const lockReason = Object.values(locks)[0] ?? null;
  const setIndex = useCallback((next: number) => setIndexState(next), []);
  const game = games.find((item) => item.id === gameId);
  const selectedTarget = targets.find((target) => target.index === index);
  const selectedInstance = selectedTarget?.instance;

  const value = useMemo<SelectionState>(() => ({
    games, gamesLoaded, gamesError, reloadGames, gameId, game, setGameId,
    instances, instancesLoaded, instancesError, reloadInstances,
    targets, index, setIndex, selectedTarget, selectedInstance,
    selectedInstanceReady: canLaunchOnTarget(selectedInstance),
    lockReason, setLock,
  }), [games, gamesLoaded, gamesError, reloadGames, gameId, game, instances, instancesLoaded, instancesError,
    reloadInstances, targets, index, setIndex, selectedTarget, selectedInstance, lockReason, setLock]);

  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
}

export function useSelection(): SelectionState {
  const value = useContext(SelectionContext);
  if (!value) throw new Error('SelectionProvider 未挂载');
  return value;
}

/**
 * Disable the global instance picker while `reason` is non-null, e.g. during a probe or a manual run, so a
 * result can never land on a different instance than the one it was started for.
 */
export function useSelectionLock(reason: string | null): void {
  const owner = useId();
  const { setLock } = useSelection();
  useEffect(() => {
    setLock(owner, reason);
    return () => setLock(owner, null);
  }, [owner, reason, setLock]);
}
