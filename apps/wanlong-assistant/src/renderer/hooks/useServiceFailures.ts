import { useEffect, useRef, useState } from 'react';
import type { ServiceFailure } from '../../shared/ipc';
import { avdm } from '../api';
import { useAvdmEvent } from './useAvdmEvent';

/** Why it failed, what is lost and that everything else still works (the original panel's startup warning). */
export function serviceFailureDetail(failure: ServiceFailure): string {
  const impact = failure.impact ? `${failure.impact}，` : '';
  return `${failure.message.replace(/[。.]$/, '')}。${impact}其余功能不受影响；排除问题后重启助手即可重试。`;
}

/** The full sentence, prefixed with the service name. */
export function describeServiceFailure(failure: ServiceFailure): string {
  return `${failure.name}没能启动：${serviceFailureDetail(failure)}`;
}

/** Short top-bar label for the current failures, or null when every service is up. */
export function serviceFailureLabel(failures: readonly ServiceFailure[]): string | null {
  if (failures.length === 0) return null;
  return failures.length === 1 ? `${failures[0]!.name}未启动` : `${failures.length} 项服务未启动`;
}

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
