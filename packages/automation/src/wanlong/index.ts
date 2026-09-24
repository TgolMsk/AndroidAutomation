import type { GamePlugin } from '../contracts.js';

export const wanlongPlugin: GamePlugin = {
  id: 'wanlong',
  name: '万龙觉醒',
  packageName: 'com.lilithgames.samo.android.cn',
  referenceSize: { width: 2560, height: 1440 },
  probeAnchors: [
    'tpl_world_search_icon',
    'tpl_nav_map_toggle',
    'tpl_nav_map_toggle_b',
    'tpl_panel_title_troop',
  ],
};

export * from './config.js';
export type { GatherConfig } from './config.js';
export type { GatherIo, GatherLogger } from './gather/session.js';
export type { GatherCycleResult, GatherRuntimeState } from './gather/types.js';
export { createRuntimeState } from './gather/types.js';
export type { GatherTemplates, LoadGatherTemplatesOptions } from './gather/templates.js';
export { loadGatherTemplates } from './gather/templates.js';
export type { RunGatherCycleOptions } from './gather/flow.js';
export { runGatherCycle } from './gather/flow.js';
export type { GatherIoOptions } from './io.js';
export { createGatherIo } from './io.js';

// ── game-data 模块：冷启动 / 游戏资源更新 / 资源统计 ─────────────────────────
export type { GameLaunchIo, GameLaunchOptions, GamePresence } from './launch.js';
export { DEFAULT_FOREGROUND_POLL_MS, DEFAULT_FOREGROUND_TIMEOUT_MS, ensureGameForeground } from './launch.js';
export type {
  GameUpdateRecoveryOptions, ImportGameUpdateTemplatesOptions, OverlayConsult, OverlayConsultResult,
  RecoverUnknownWithUpdateOptions, UnknownScreenRecovery, UpdateAwareAdvisorOptions, UpdateContext,
} from './update.js';
export {
  GAME_UPDATE_MAX_WAIT_MS, GameUpdateRecovery, createUpdateAwareAdvisor, importGameUpdateTemplates,
  recoverUnknownWithUpdate,
} from './update.js';
export * from './update-ids.js';
export type { UnknownScreenAdvisor, UnknownScreenContext } from './gather/session.js';
export * from './resources/index.js';
