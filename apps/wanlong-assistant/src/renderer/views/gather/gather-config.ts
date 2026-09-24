/**
 * Mapping between the saved Wanlong gather config and the page's small draft (master switch + resources).
 * Defaults come from the single source in `@avdm/automation/wanlong/pure`; the page never keeps its own copy.
 */
import { DEFAULT_GATHER_CONFIG, GATHER_CONFIG_VERSION, RESOURCE_LABEL, type GatherResourceType } from '@avdm/automation/wanlong/pure';
import type { AutomationSettings } from '../../../shared/ipc';

export interface GatherResourceOption {
  type: GatherResourceType;
  label: string;
  defaultEnabled: boolean;
  defaultQueues: number;
  defaultPriority: number;
}

export const GATHER_RESOURCES: readonly GatherResourceOption[] = DEFAULT_GATHER_CONFIG.resources.map((entry) => ({
  type: entry.type,
  label: RESOURCE_LABEL[entry.type].resource,
  defaultEnabled: entry.enabled,
  defaultQueues: entry.queues,
  defaultPriority: entry.priority,
}));

export interface WanlongDraft {
  enabled: boolean;
  resources: Record<GatherResourceType, boolean>;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function savedResource(settings: AutomationSettings, type: GatherResourceType): Record<string, unknown> | undefined {
  const raw = Array.isArray(settings.config.resources) ? settings.config.resources : [];
  const found: unknown = raw.find((entry: unknown) => record(entry) && entry.type === type);
  return record(found) ? found : undefined;
}

export function wanlongDraftOf(settings: AutomationSettings): WanlongDraft {
  const resources = {} as Record<GatherResourceType, boolean>;
  for (const item of GATHER_RESOURCES) {
    const saved = savedResource(settings, item.type);
    resources[item.type] = typeof saved?.enabled === 'boolean' ? saved.enabled : item.defaultEnabled;
  }
  return { enabled: settings.config.enabled === true, resources };
}

/** The draft merged back into the saved config; fields the page does not edit are preserved. */
export function wanlongConfig(settings: AutomationSettings, draft: WanlongDraft): Record<string, unknown> {
  const resources = GATHER_RESOURCES.map((item) => {
    const base = savedResource(settings, item.type) ?? {};
    const queues = typeof base.queues === 'number' && Number.isInteger(base.queues) ? base.queues : item.defaultQueues;
    return {
      ...base,
      type: item.type,
      enabled: draft.resources[item.type],
      priority: typeof base.priority === 'number' ? base.priority : item.defaultPriority,
      // An enabled resource needs at least one march queue.
      queues: draft.resources[item.type] ? Math.max(1, queues) : queues,
    };
  });
  return { ...settings.config, version: settings.config.version ?? GATHER_CONFIG_VERSION, enabled: draft.enabled, resources };
}
