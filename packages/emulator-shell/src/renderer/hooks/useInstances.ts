import { useCallback, useEffect, useRef, useState } from 'react';
import type { InstanceState } from '@avdm/core';
import { avdm, errMsg } from '../api';
import { useAvdmEvent } from './useAvdmEvent';

/** Safety-net refresh; normal updates arrive as 'instance-state' events from the health monitor. */
const POLL_MS = 15_000;

export interface InstancesStore {
  instances: InstanceState[];
  loaded: boolean;
  error?: string;
  reload: () => Promise<void>;
}

export function useInstances(): InstancesStore {
  const [instances, setInstances] = useState<InstanceState[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string>();
  const loading = useRef<Promise<void> | null>(null);
  const again = useRef(false);

  const reload = useCallback((): Promise<void> => {
    if (loading.current) {
      // Coalesce: run once more after the in-flight load.
      again.current = true;
      return loading.current;
    }
    const run = async () => {
      do {
        again.current = false;
        try {
          const list = await avdm.listInstances();
          setInstances([...list].sort((a, b) => a.record.index - b.record.index));
          setError(undefined);
        } catch (err) {
          setError(errMsg(err));
        }
      } while (again.current);
      setLoaded(true);
    };
    loading.current = run().finally(() => {
      loading.current = null;
    });
    return loading.current;
  }, []);

  useEffect(() => {
    void reload();
    const timer = window.setInterval(() => void reload(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [reload]);

  const current = useRef(instances);
  current.current = instances;

  useAvdmEvent('instance-state', (state) => {
    if (!current.current.some((p) => p.record.index === state.record.index)) {
      // Unknown index (just created, or a late event for a deleted one): let a reload decide.
      void reload();
      return;
    }
    setInstances((prev) => prev.map((p) => (p.record.index === state.record.index ? state : p)));
  });

  useAvdmEvent('instances-changed', () => void reload());

  return { instances, loaded, error, reload };
}
