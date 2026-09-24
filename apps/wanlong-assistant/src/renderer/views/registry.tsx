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
  /** Stays mounted (hidden) after the first visit, e.g. to keep an unsaved editor draft across pages. */
  keepAlive?: boolean;
}

export const VIEW_REGISTRY: Readonly<Record<ViewKey, ViewEntry>> = {
  instances: { component: InstancesView },
  accounts: { component: AccountsView, needsGame: true },
  gatherOverview: { component: GatherOverviewView, needsGame: true },
  plans: { component: PlansView, needsGame: true },
  runs: { component: RunsView },
  stats: { component: StatsView, needsGame: true },
  ai: { component: AiView, needsGame: true },
  scripts: { component: ScriptsView, needsGame: true, keepAlive: true },
  templates: { component: TemplatesView, needsGame: true },
  settings: { component: SettingsView },
};
