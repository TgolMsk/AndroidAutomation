/**
 * Always-mounted components that publish top-bar badges (`useShellBadge`). A module that needs a global badge
 * (alerts paused, update available, configuration missing …) appends its source component to BADGE_SOURCES.
 */
import { useEffect, useRef, type ComponentType } from 'react';
import { useToast } from './components/Toasts';
import { describeServiceFailure, serviceFailureDetail, serviceFailureLabel, useServiceFailures } from './hooks/useServiceFailures';
import { useShellBadge } from './state/badges';
import { useSelection } from './state/selection';

/** Game module and instance list failures: nothing else works until these load. */
function SelectionBadges() {
  const { gamesError, instancesError } = useSelection();
  useShellBadge(gamesError ? { tone: 'bad', label: '游戏模块不可用', detail: gamesError, view: 'settings' } : null);
  useShellBadge(instancesError ? { tone: 'bad', label: '实例读取失败', detail: instancesError, view: 'instances' } : null);
  return null;
}

/** Background services that failed to start (schedules, plans, monitoring, bot): toast once, badge until restart. */
function ServiceFailureBadges() {
  const failures = useServiceFailures();
  const toast = useToast();
  const announced = useRef(new Set<string>());
  useEffect(() => {
    for (const failure of failures) {
      const key = `${failure.name}@${failure.at}`;
      if (announced.current.has(key)) continue;
      announced.current.add(key);
      toast.push({ kind: 'warn', title: `${failure.name}没能启动`, detail: serviceFailureDetail(failure) });
    }
  }, [failures, toast]);
  const label = serviceFailureLabel(failures);
  useShellBadge(label ? { tone: 'warn', label, detail: failures.map(describeServiceFailure).join('\n'), view: 'settings' } : null);
  return null;
}

export const BADGE_SOURCES: readonly ComponentType[] = [
  SelectionBadges,
  ServiceFailureBadges,
];
