import { useEffect, useState } from 'react';
import type { HostStats } from '@avdm/core';
import { avdm } from '../api';

/** Host resources polled every `intervalMs` (default 3 s). */
export function useHostStats(intervalMs = 3000): HostStats | undefined {
  const [stats, setStats] = useState<HostStats>();
  useEffect(() => {
    let alive = true;
    let busy = false;
    const poll = async () => {
      if (busy) return;
      busy = true;
      try {
        const s = await avdm.hostStats();
        if (alive) setStats(s);
      } catch {
        // keep last value
      } finally {
        busy = false;
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), intervalMs);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [intervalMs]);
  return stats;
}
