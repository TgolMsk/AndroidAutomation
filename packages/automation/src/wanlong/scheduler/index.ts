/**
 * ETA 调度的游戏侧逻辑（不含定时器、锁、落盘与 IPC —— 那些在应用的 src/main/scheduler/）。
 *
 *   model.ts      契约类型 + 本地递推（纯，渲染进程经 `@avdm/automation/wanlong/pure` 使用）
 *   fatigue.ts    深夜疲惫换算 + 北京时间边界（纯）
 *   state.ts      toMarchState / planNextWake / 退避 / 空位判定（纯）
 *   parse.ts      读数解析器（纯）
 *   digits.ts     列投影数字识别 readNumberText（需要视觉层，跑在工作线程）
 *   templates.ts  调度器模板 id 与派生（复用采集流程已编译的模板，绝不重编）
 *   troopPanel.ts 部队管理面板采样器 sampleTroopPanel（需要视觉层，跑在工作线程）
 */
export * from './model.js'
export * from './fatigue.js'
export * from './state.js'
export * from './parse.js'
export {
  buildGlyphSet,
  charOfSuffix,
  glyphChars,
  readNumberText,
  type GlyphSet as NumberGlyphSet,
  type ReadOptions as NumberReadOptions,
  type ReadResult as NumberReadResult
} from './digits.js'
export {
  TPL as SCHED_TPL,
  STATUS_TEMPLATES,
  SCHEDULER_OPTIONAL_TEMPLATES,
  SCHEDULER_REQUIRED_TEMPLATES,
  buildSchedulerTemplates,
  optionalUi,
  requireUi,
  type SchedulerTemplates,
  type StatusTemplateSpec
} from './templates.js'
export {
  CITY_TO_MAP_TAP,
  COLD_START_EXTRA_ATTEMPTS,
  COLD_START_POLL_MS,
  COLD_START_RECOGNIZE_MS,
  COLD_START_SETTLE_MS,
  COORD_LABEL_REL,
  COORD_LABEL_TO_ROW_CENTER,
  DEFAULT_COLD_START_GRACE_MS,
  ENTRY_TAP,
  FILL_BAR_X0,
  FILL_BAR_X1,
  FILL_SCAN_LINES_REL,
  OPEN_PANEL_ATTEMPTS,
  PANEL_TITLE_ROI,
  ROW_FIRST_CENTER_Y,
  ROW_PITCH_Y,
  STAMINA_BANDS_REL,
  STATUS_BAR_REL,
  STATUS_ICON_REL,
  STATUS_WORD_FALLBACK_REL,
  THUMB_REL,
  detectRowCenters,
  readRowFill,
  readRowResource,
  readStatusWord,
  rowY,
  sampleTroopPanel,
  type SampleIo,
  type SampleKeyIntent,
  type SampleOptions,
  type SampleTapIntent
} from './troopPanel.js'
