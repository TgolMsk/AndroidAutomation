/**
 * 资源统计识别模块的统一出口。
 *
 *   · readResourceStatsPanel —— 完整流程（预检 → 打开弹窗 → 读表 → 还原），★必须在实例设备租约内调
 *   · readResourceStatsFromFrame —— 纯识别，离线测试 / 模板页试读用
 *   · mergeSnapshots —— 两帧对账
 *   · loadResourceUnitTemplates / invalidateResourceUnitTemplates —— 单位字（shrink=1）缓存
 *   · seedResourceTemplates —— 把用户提供的截图按规格裁成模板入库
 *   · 纯部分（契约 / 几何 / 模板 id）见 pure.ts
 */

export * from './pure.js'
export {
  invalidateResourceUnitTemplates,
  loadResourceUnitTemplates,
  seedResourceTemplates
} from './templates.js'
export type {
  ResourceUnitTemplates,
  SeedResourceTemplatesOptions,
  SeedResourceTemplatesResult
} from './templates.js'
export {
  DIGIT_MIN_SCORE,
  RESOURCE_READ_MAX_CAPTURES,
  UNIT_THRESHOLD,
  mergeSnapshots,
  readResourceStatsFromFrame,
  readResourceStatsPanel
} from './read.js'
export type { ReadFromFrameOptions, ReadResourceStatsOptions } from './read.js'
