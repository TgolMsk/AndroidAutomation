import { useEffect } from 'react';
import { avdm } from '../api';
import type { WanlongEvents } from '../../shared/ipc';
import type { AvdmEvents } from '@avdm/emulator-shell/shared/ipc';

type AllEvents = AvdmEvents & WanlongEvents;
export function useAvdmEvent<C extends keyof AllEvents>(channel: C, listener: (payload: AllEvents[C]) => void): void {
  useEffect(() => {
    const subscribe = avdm.on as (name: keyof AllEvents, fn: (payload: AllEvents[keyof AllEvents]) => void) => () => void;
    return subscribe(channel, listener as (payload: AllEvents[keyof AllEvents]) => void);
  }, [channel, listener]);
}
