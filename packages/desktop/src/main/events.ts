import { BrowserWindow, type WebContents } from 'electron';
import { EVENT_CHANNEL, type AvdmEventChannel, type AvdmEvents } from '../shared/ipc';

/** Push one event to a single renderer. */
export function sendEvent<C extends AvdmEventChannel>(wc: WebContents, channel: C, payload: AvdmEvents[C]): void {
  if (wc.isDestroyed()) return;
  try {
    wc.send(EVENT_CHANNEL, { channel, payload });
  } catch {
    // Renderer is going away; nothing to do.
  }
}

/** Push one event to every open window. */
export function broadcast<C extends AvdmEventChannel>(channel: C, payload: AvdmEvents[C]): void {
  for (const win of BrowserWindow.getAllWindows()) sendEvent(win.webContents, channel, payload);
}
