/** Reading the in-game resource statistics table (道具 → 资源统计). */
import type { ResourceSnapshot } from '@avdm/automation/wanlong/pure';
import type { Assert, ListsExactly } from './contract';

export type { ResourceSnapshot, ResourceSnapshotRow, ResourceType } from '@avdm/automation/wanlong/pure';

export interface ResourcesApi {
  /**
   * Open 道具 → 资源 → 资源统计 on the instance, read the 4 × 2 table and go back to the main screen, inside the
   * instance lock. No input at all unless the game is on the world map or in the city. The snapshot is recorded
   * into today's statistics. Busy instances are refused with CONCURRENCY_LIMIT (retry later, not a failure).
   */
  resourcesRead(gameId: string, index: number): Promise<ResourceSnapshot>;
  /** Instances whose resource table is being read right now (the page's busy state after a bot-triggered read). */
  resourcesReading(gameId: string): Promise<number[]>;
}

export const RESOURCES_METHODS = ['resourcesRead', 'resourcesReading'] as const satisfies readonly (keyof ResourcesApi)[];

/** A resource-table read started or ended on an instance (page busy state). */
export interface ResourcesReadingPush {
  gameId: string;
  index: number;
  reading: boolean;
}

export interface ResourcesEvents {
  'resources-reading': ResourcesReadingPush;
}

export const RESOURCES_EVENTS = ['resources-reading'] as const satisfies readonly (keyof ResourcesEvents)[];

export type ResourcesContractCheck = [
  Assert<ListsExactly<ResourcesApi, typeof RESOURCES_METHODS>>,
  Assert<ListsExactly<ResourcesEvents, typeof RESOURCES_EVENTS>>,
];
