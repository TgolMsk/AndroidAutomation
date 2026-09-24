/**
 * Always-mounted components that publish top-bar badges (`useShellBadge`). A module that needs a global badge
 * (alerts paused, update available, configuration missing …) appends its source component to BADGE_SOURCES.
 */
import { useEffect, useRef, type ComponentType } from 'react';
import type { AppToast } from '../shared/ipc';
import { avdm } from './api';
import { useToast } from './components/Toasts';
import { useAvdmEvent } from './hooks/useAvdmEvent';
import { describeServiceFailure, serviceFailureLabel, useServiceFailures } from './hooks/useServiceFailures';
import { VIEW_KEYS, type ViewKey } from './navigation';
import { pausedIndexes, useAlerts } from './state/alerts';
import { useShellBadge } from './state/badges';
import { useNavigation } from './state/navigation';
import { useSelection } from './state/selection';

/** Game module and instance list failures: nothing else works until these load. */
function SelectionBadges() {
  const { gamesError, instancesError } = useSelection();
  useShellBadge(gamesError ? { tone: 'bad', label: '游戏模块不可用', detail: gamesError, view: 'settings' } : null);
  useShellBadge(instancesError ? { tone: 'bad', label: '实例读取失败', detail: instancesError, view: 'instances' } : null);
  return null;
}

/**
 * Background services that failed to start (schedules, plans, monitoring, bot): a badge until restart. The one-time
 * toast comes from main as an `app-toast` (see AppToasts below), so it is not repeated here.
 */
function ServiceFailureBadges() {
  const failures = useServiceFailures();
  const label = serviceFailureLabel(failures);
  useShellBadge(label ? { tone: 'warn', label, detail: failures.map(describeServiceFailure).join('\n'), view: 'settings' } : null);
  return null;
}

const TOAST_KIND: Record<AppToast['level'], 'info' | 'success' | 'warn' | 'error'> = { info: 'info', success: 'success', warn: 'warn', error: 'error' };

/**
 * Main-process notices (`app-toast`: services that failed to start, self-check problems …). Toasts sent while this
 * window was still loading are read once from `appRecentToasts()`; ids make sure each one shows exactly once.
 */
function AppToasts() {
  const toast = useToast();
  const { navigate } = useNavigation();
  const shown = useRef(new Set<number>());
  const show = (item: AppToast) => {
    if (shown.current.has(item.id)) return;
    shown.current.add(item.id);
    const view = item.view && (VIEW_KEYS as readonly string[]).includes(item.view) ? item.view as ViewKey : undefined;
    toast.push({
      kind: TOAST_KIND[item.level] ?? 'info', title: item.title, ...(item.detail ? { detail: item.detail } : {}),
      ...(view ? { action: { label: '前往查看', onClick: () => navigate(view) } } : {}),
      ...(item.level === 'warn' ? { duration: 10_000 } : {}),
    });
  };
  const showRef = useRef(show);
  showRef.current = show;
  useEffect(() => {
    let active = true;
    avdm.appRecentToasts().then((items) => { if (active) for (const item of items) showRef.current(item); })
      .catch(() => { /* Only a replay is lost; live toasts still arrive. */ });
    return () => { active = false; };
  }, []);
  useAvdmEvent('app-toast', show);
  return null;
}

/** Instances an alert paused (kicked, offline, consecutive failures …): red until 「恢复」 on the gather overview. */
function PausedInstancesBadge() {
  const { pauses } = useAlerts();
  const paused = pausedIndexes(pauses);
  useShellBadge(paused.length > 0 ? {
    tone: 'bad', label: `${paused.length} 个实例已被异常暂停`,
    detail: paused.map((index) => `实例 #${index}：${pauses[index]?.reason ?? '已暂停'}`).join('\n'),
    view: 'gatherOverview',
  } : null);
  return null;
}

export const BADGE_SOURCES: readonly ComponentType[] = [
  SelectionBadges,
  ServiceFailureBadges,
  AppToasts,
  PausedInstancesBadge,
];
