import { formatCst, formatCstClock, formatCstShort } from '../shared/time';

export { displayStatus, displayStatusLabel, isRunning } from '@avdm/emulator-shell/renderer/format';
export { formatCst, formatCstClock, formatCstShort } from '../shared/time';

/**
 * Game-related times are shown in Beijing time whatever the host time zone is (never `toLocaleString()`).
 * `short` = `MM-DD HH:MM`, `full` = `YYYY-MM-DD HH:MM:SS`, `minute` = `YYYY-MM-DD HH:MM`, `clock` = `HH:MM:SS`.
 * Missing times (null, undefined or 0) render as 「—」.
 */
export function beijingTime(at: number | null | undefined, style: 'short' | 'full' | 'minute' | 'clock' = 'short'): string {
  if (!at || !Number.isFinite(at)) return '—';
  switch (style) {
    case 'full': return formatCst(at);
    case 'minute': return formatCst(at, false);
    case 'clock': return formatCstClock(at);
    default: return formatCstShort(at);
  }
}
