import { BrowserWindow } from 'electron';
import { broadcast as broadcastCore } from '@avdm/emulator-shell/main/events';
import type { LogEntry } from '@avdm/emulator-shell/shared/ipc';
import { WANLONG_EVENT_CHANNEL, type WanlongEvents } from '../shared/ipc';

/** Channels main may push: the assistant's own events plus the shell's user-visible `log`. */
export type BroadcastEvents = WanlongEvents & { log: LogEntry };

/**
 * Push one event to every window. Assistant events have their own channel (the emulator product never
 * registers them); `log` goes through the shell's channel. Services receive this as an injected callback.
 */
export function broadcast<C extends keyof BroadcastEvents>(channel: C, payload: BroadcastEvents[C]): void {
  if (channel === 'log') {
    broadcastCore('log', payload as LogEntry);
    return;
  }
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.webContents.isDestroyed()) continue;
    try { win.webContents.send(WANLONG_EVENT_CHANNEL, { channel, payload }); }
    catch { /* The renderer is going away. */ }
  }
}
