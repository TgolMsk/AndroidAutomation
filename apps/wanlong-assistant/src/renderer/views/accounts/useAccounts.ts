import { useCallback, useEffect, useRef, useState } from 'react';
import type { AccountLoginSession, GameAccount } from '../../../main/automation/accounts/types';
import type { BaseInstanceView } from '../../../main/instances/types';
import { avdm, errMsg } from '../../api';
import { useAvdmEvent } from '../../hooks/useAvdmEvent';
import { acceptSession } from './account-model';

export interface AccountsState {
  accounts: GameAccount[];
  loaded: boolean;
  error?: string;
  reload(): Promise<void>;
}

/**
 * The account list of one game, kept current by the `account-changed` push event (login prepare / complete,
 * binds from other pages) with a stale-response guard, so pages never poll for it.
 */
export function useAccounts(gameId: string | undefined): AccountsState {
  const [accounts, setAccounts] = useState<GameAccount[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string>();
  const sequence = useRef(0);

  const reload = useCallback(async () => {
    if (!gameId) return;
    const mine = ++sequence.current;
    try {
      const list = await avdm.accountList(gameId);
      if (mine !== sequence.current) return;
      setAccounts(list);
      setError(undefined);
    } catch (cause) {
      if (mine === sequence.current) setError(errMsg(cause));
    } finally {
      if (mine === sequence.current) setLoaded(true);
    }
  }, [gameId]);

  useEffect(() => {
    setAccounts([]);
    setLoaded(false);
    void reload();
  }, [reload]);

  useAvdmEvent('account-changed', (event) => {
    if (event.gameId !== gameId) return;
    sequence.current += 1; // a push is newer than any reply still in flight
    setAccounts(event.accounts);
    setLoaded(true);
    setError(undefined);
  });

  return { accounts, loaded, error, reload };
}

/**
 * Latest login session per instance, from `login-changed` pushes plus a slow safety poll (5 s). Snapshots older
 * than the one shown are ignored.
 */
export function useLoginSessions(): Map<number, AccountLoginSession> {
  const [sessions, setSessions] = useState<Map<number, AccountLoginSession>>(new Map());
  const merge = useCallback((list: readonly AccountLoginSession[]) => {
    setSessions((current) => {
      let next: Map<number, AccountLoginSession> | null = null;
      for (const session of list) {
        const accepted = acceptSession(current.get(session.index) ?? null, session);
        if (accepted && accepted !== current.get(session.index)) {
          next ??= new Map(current);
          next.set(session.index, accepted);
        }
      }
      return next ?? current;
    });
  }, []);

  useEffect(() => {
    let active = true;
    const load = () => void avdm.accountLoginSessions().then((list) => { if (active) merge(list); }).catch(() => undefined);
    load();
    const timer = window.setInterval(load, 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, [merge]);

  useAvdmEvent('login-changed', (session) => merge([session]));
  return sessions;
}

export interface BaseInstanceState {
  view: BaseInstanceView | null;
  error?: string;
  reload(): Promise<void>;
}

/** The game's base instance, refreshed on `instance-base-changed` and whenever the instance list changes. */
export function useBaseInstance(gameId: string | undefined, onCleared?: (view: BaseInstanceView) => void): BaseInstanceState {
  const [view, setView] = useState<BaseInstanceView | null>(null);
  const [error, setError] = useState<string>();
  const sequence = useRef(0);
  const clearedRef = useRef(onCleared);
  clearedRef.current = onCleared;
  const announced = useRef(new Set<string>());

  /** The clearing call's reply and its push event carry the same clear: tell the user once. */
  const noteCleared = useCallback((next: BaseInstanceView) => {
    if (!next.cleared) return;
    const key = `${next.gameId}:${next.cleared.index}:${next.cleared.setAt}`;
    if (announced.current.has(key)) return;
    announced.current.add(key);
    clearedRef.current?.(next);
  }, []);

  const reload = useCallback(async () => {
    if (!gameId) return;
    const mine = ++sequence.current;
    try {
      const next = await avdm.instanceBase(gameId);
      noteCleared(next); // even when a newer push already replaced the view
      if (mine !== sequence.current) return;
      setView(next);
      setError(undefined);
    } catch (cause) {
      if (mine === sequence.current) setError(errMsg(cause));
    }
  }, [gameId, noteCleared]);

  useEffect(() => { setView(null); void reload(); }, [reload]);
  useAvdmEvent('instance-base-changed', (event) => {
    if (event.gameId !== gameId) return;
    sequence.current += 1;
    setView(event.view);
    setError(undefined);
    noteCleared(event.view);
  });
  useAvdmEvent('instances-changed', () => { void reload(); });
  // Start / stop of the base changes whether cloning is possible.
  useAvdmEvent('instance-state', (state) => {
    if (state.record.index === view?.base?.index) void reload();
  });
  return { view, error, reload };
}
