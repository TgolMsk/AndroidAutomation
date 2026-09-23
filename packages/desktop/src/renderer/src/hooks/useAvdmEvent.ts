import { useEffect, useRef } from 'react';
import type { AvdmEventChannel, AvdmEvents } from '../../../shared/ipc';
import { avdm } from '../api';

/** Subscribe to a main-process event channel for the lifetime of the component. */
export function useAvdmEvent<C extends AvdmEventChannel>(channel: C, handler: (payload: AvdmEvents[C]) => void): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => avdm.on(channel, (payload) => ref.current(payload)), [channel]);
}
