/**
 * ViewKey → page component. One file per page under `views/<area>/`; a new page adds its key to
 * `navigation.ts` and one entry here (the Record type makes a missing entry a compile error).
 */
import type { ComponentType } from 'react';
import type { ViewKey } from '../navigation';
import { AccountsView } from './accounts/AccountsView';
import { AiView } from './ai/AiView';
import { GatherOverviewView } from './gather/GatherOverviewView';
import { InstancesView } from './instances/InstancesView';
import { PlansView } from './plans/PlansView';
import { RunsView } from './runs/RunsView';
import { ScriptsView } from './scripts/ScriptsView';
import { SettingsView } from './settings/SettingsView';
import { StatsView } from './stats/StatsView';
import { TemplatesView } from './templates/TemplatesView';
import type { ViewProps } from './types';

export interface ViewEntry {
  component: ComponentType<ViewProps>;
  /** Needs the game module (accounts, templates, scripts …); the shell shows a loading/error state until then. */
  needsGame?: boolean;
  /**
   * Stays mounted (hidden) after the first visit so unsaved drafts survive page switches: the gather config
   * draft and probe result, the account plan and 调度设置 drafts, the script editor. The page gets
   * `visible=false` while hidden and should pause its polling; the shell restores its scroll position.
   */
  keepAlive?: boolean;
}

export const VIEW_REGISTRY: Readonly<Record<ViewKey, ViewEntry>> = {
  instances: { component: InstancesView },
  accounts: { component: AccountsView, needsGame: true },
  gatherOverview: { component: GatherOverviewView, needsGame: true, keepAlive: true },
  plans: { component: PlansView, needsGame: true, keepAlive: true },
  runs: { component: RunsView },
  stats: { component: StatsView, needsGame: true },
  ai: { component: AiView, needsGame: true },
  scripts: { component: ScriptsView, needsGame: true, keepAlive: true },
  templates: { component: TemplatesView, needsGame: true },
  settings: { component: SettingsView },
};

/**
 * Where the shared content area scrolls to when `view` is shown: a kept-alive page comes back where the user
 * left it (e.g. the script step just inserted after 「从画面截取并添加」); a freshly mounted page starts at the top.
 */
export function restoredScrollTop(view: ViewKey, saved: ReadonlyMap<ViewKey, number>): number {
  return VIEW_REGISTRY[view].keepAlive ? saved.get(view) ?? 0 : 0;
}
