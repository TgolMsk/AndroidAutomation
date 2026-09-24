import { useEffect, useRef } from 'react';
import { avdm } from '../api';
import type { WanlongAllEvents } from '../../shared/ipc';

/**
 * Subscribe to a shell or assistant push event for the lifetime of the component. The latest listener is kept
 * in a ref, so inline callbacks do not resubscribe on every render.
 */
export function useAvdmEvent<C extends keyof WanlongAllEvents>(channel: C, listener: (payload: WanlongAllEvents[C]) => void): void {
  const ref = useRef(listener);
  ref.current = listener;
  useEffect(() => avdm.on(channel, (payload) => ref.current(payload)), [channel]);
}
