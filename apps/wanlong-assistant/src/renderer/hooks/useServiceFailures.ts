import { useEffect, useRef, useState } from 'react';
import type { ServiceFailure } from '../../shared/ipc';
import { avdm } from '../api';
import { useAvdmEvent } from './useAvdmEvent';

export { describeServiceFailure, serviceFailureDetail, serviceFailureLabel } from '../../shared/service-failures';

/**
 * Services that failed to start. Read once on mount (the push can fire while the window is still loading),
 * then kept current by `service-failures` events, which always carry the complete list.
 */
export function useServiceFailures(): ServiceFailure[] {
  const [failures, setFailures] = useState<ServiceFailure[]>([]);
  const pushed = useRef(false);
  useEffect(() => {
    let active = true;
    avdm.appServiceFailures().then((list) => { if (active && !pushed.current) setFailures(list); })
      .catch(() => { /* Only the badge is lost; the failure itself is in the main-process log. */ });
    return () => { active = false; };
  }, []);
  useAvdmEvent('service-failures', (list) => {
    pushed.current = true;
    setFailures(list);
  });
  return failures;
}
