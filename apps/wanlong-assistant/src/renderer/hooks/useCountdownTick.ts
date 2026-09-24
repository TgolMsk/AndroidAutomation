/**
 * One "tick every second" clock shared by every countdown (original features/gather/useCountdownTick.ts).
 *
 * 1. A single module-level `setInterval`: however many cards and rows are on screen, they share one timer and one
 *    `now`, so no two rows ever show different seconds.
 * 2. Stops while the window is hidden (`document.hidden`); on becoming visible it broadcasts at once, then restarts.
 * 3. Never touches adb: countdowns are absolute timestamps minus `now`.
 */
import { useEffect, useState } from 'react';

type Listener = (now: number) => void;

const listeners = new Set<Listener>();
let timer: ReturnType<typeof setInterval> | null = null;
let visibilityBound = false;

function broadcast(): void {
  const now = Date.now();
  for (const fn of listeners) fn(now);
}

function startTimer(): void {
  if (timer !== null) return;
  if (typeof document !== 'undefined' && document.hidden) return;
  timer = setInterval(broadcast, 1000);
}

function stopTimer(): void {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
}

function onVisibilityChange(): void {
  if (document.hidden) {
    stopTimer();
    return;
  }
  // Back in front: refresh right away so nobody sees a stale second.
  broadcast();
  if (listeners.size > 0) startTimer();
}

function bindVisibility(): void {
  if (visibilityBound || typeof document === 'undefined') return;
  document.addEventListener('visibilitychange', onVisibilityChange);
  visibilityBound = true;
}

/**
 * The current time in ms, updated once a second.
 * @param enabled false unsubscribes (e.g. a kept-alive page that is hidden).
 */
export function useCountdownTick(enabled = true): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled) return;
    bindVisibility();
    const fn: Listener = (t) => setNow(t);
    listeners.add(fn);
    startTimer();
    // The first frame after mounting shows a fresh value, not the initial state.
    setNow(Date.now());
    return () => {
      listeners.delete(fn);
      if (listeners.size === 0) stopTimer();
    };
  }, [enabled]);

  return now;
}

/** Number of live subscribers (tests). */
export function countdownListenerCount(): number {
  return listeners.size;
}
