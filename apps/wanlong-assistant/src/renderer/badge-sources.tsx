/**
 * Always-mounted components that publish top-bar badges (`useShellBadge`). A module that needs a global badge
 * (alerts paused, update available, configuration missing …) appends its source component to BADGE_SOURCES.
 */
import type { ComponentType } from 'react';
import { useShellBadge } from './state/badges';
import { useSelection } from './state/selection';

/** Game module and instance list failures: nothing else works until these load. */
function SelectionBadges() {
  const { gamesError, instancesError } = useSelection();
  useShellBadge(gamesError ? { tone: 'bad', label: '游戏模块不可用', detail: gamesError, view: 'settings' } : null);
  useShellBadge(instancesError ? { tone: 'bad', label: '实例读取失败', detail: instancesError, view: 'instances' } : null);
  return null;
}

export const BADGE_SOURCES: readonly ComponentType[] = [
  SelectionBadges,
];
