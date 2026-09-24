/** Reading the in-game resource statistics table (道具 → 资源统计). */
import type { ResourceSeedFrame, ResourceSnapshot } from '@avdm/automation/wanlong/pure';
import type { Assert, ListsExactly } from './contract';

export type { ResourceSeedFrame, ResourceSnapshot, ResourceSnapshotRow, ResourceType } from '@avdm/automation/wanlong/pure';

/**
 * Where the frames of 「资源统计模板」 come from: a folder of screenshots the user picks in a dialog (wanlong-panel's
 * `docs/game/shots/resources/` or their own, matched by file name), or the instance's current screen as one frame role.
 */
export type ResourceTemplateSeedSource = { kind: 'folder' } | { kind: 'screen'; frame: ResourceSeedFrame };

/** What cropping the resource-statistics templates by the spec did (template page 「资源统计模板」). */
export interface ResourceTemplateSeedResult {
  setId: string;
  /** Canonical folder of the set written to. */
  directory: string;
  /** Frame roles that were provided (and, for a folder, the file used for each). */
  frames: ResourceSeedFrame[];
  files: Partial<Record<ResourceSeedFrame, string>>;
  saved: string[];
  /** Kept ids (already in the set, not overwritten), spec entries without material (待补裁) and frames not provided. */
  skipped: Array<{ id: string; reason: string }>;
  /** Rejected by the library (too little texture, bad frame …), with the Chinese reason. */
  failed: Array<{ id: string; reason: string }>;
  /** The instance's auto-resume was switched off (a changed template needs a fresh probe, like any template save). */
  pausedSchedule: boolean;
}

export interface ResourcesApi {
  /**
   * Open 道具 → 资源 → 资源统计 on the instance, read the 4 × 2 table and go back to the main screen, inside the
   * instance lock. No input at all unless the game is on the world map or in the city. The snapshot is recorded
   * into today's statistics. Busy instances are refused with CONCURRENCY_LIMIT (retry later, not a failure).
   */
  resourcesRead(gameId: string, index: number): Promise<ResourceSnapshot>;
  /** Instances whose resource table is being read right now (the page's busy state after a bot-triggered read). */
  resourcesReading(gameId: string): Promise<number[]>;
  /**
   * Crop the resource-statistics templates (RESOURCE_TEMPLATE_CATALOG) out of screenshots into the instance's template
   * set, like a template save (instance idle, auto-resume switched off, device lease held). `overwrite` re-crops ids
   * the set already has; without it they are kept. Null: the folder dialog was cancelled.
   */
  resourcesSeedTemplates(gameId: string, index: number, source: ResourceTemplateSeedSource, overwrite?: boolean): Promise<ResourceTemplateSeedResult | null>;
}

export const RESOURCES_METHODS = ['resourcesRead', 'resourcesReading', 'resourcesSeedTemplates'] as const satisfies readonly (keyof ResourcesApi)[];

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
