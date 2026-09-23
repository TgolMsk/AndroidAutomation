import { BrowserWindow } from 'electron';
import { broadcast as broadcastCore } from '@avdm/emulator-shell/main/events';
import type { LogEntry } from '@avdm/emulator-shell/shared/ipc';
import type { AutomationRun, AutomationSchedule } from '../shared/ipc';

/** Assistant events have their own channel; the emulator product never registers them. */
export function broadcast(channel: 'automation-run', payload: AutomationRun): void;
export function broadcast(channel: 'automation-schedule', payload: AutomationSchedule): void;
export function broadcast(channel: 'log', payload: LogEntry): void;
export function broadcast(channel: string, payload: unknown): void {
  if (channel === 'log') {
    broadcastCore('log', payload as LogEntry);
    return;
  }
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.webContents.isDestroyed()) win.webContents.send('wanlong:event', { channel, payload });
  }
}
