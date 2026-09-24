/**
 * 「道具 → 资源 → 资源统计」表格的几何常量（2560x1440 参考坐标）。
 *
 * ★ 数值的唯一权威是 packages/automation/game-data/wanlong/resource-stats.json（nav / itemsPage / dialog / rows / columns 几组）。
 *   这里是**手抄**的一份（运行期不读 JSON，打包时也不必带上它），
 *   test/wanlong-resources-layout.test.ts 会逐项断言两边一致 —— 改数值必须两边同时改。
 *
 * ★ 纯模块（只 import 类型），由 `@avdm/automation/wanlong/pure` 转出，渲染进程也能用。
 *
 * 表格结构（真机 2560x1440 资源统计弹窗实测）：
 *   · 4 行等距（行距 196）：金币 / 木材 / 铁矿石 / 魔水，行序固定。
 *   · 两列「道具总量」「资源总量」，数值在列内**居中**对齐，所以单元格 ROI 以列中心对称展开。
 *   · 值形如 `2.9亿` / `11.1亿`：浅底黑字，数字宽 17~23、高 28~31，单位「亿」35x35。
 *   · AVD 分辨率低于参考分辨率时由 createGatherIo / prepareFrame 负责换算，这里的数永远是参考坐标。
 */

import type { Point, Rect } from '../../contracts.js'
import type { ResourceType } from './contract.js'

export type ResourceStatsColumn = 'item' | 'total'

export interface ResourceStatsLayout {
  refWidth: number
  refHeight: number
  nav: {
    /** 世界地图底部导航「道具」（图标本体中心实测 (2100,1340)，此点落在图标内）。 */
    itemsTap: Point
  }
  itemsPage: {
    /** 资源页右上「资源统计」按钮中心（兜底坐标；运行时优先点 tpl_btn_res_stats 的命中中心）。 */
    statsButtonTap: Point
    /** 道具页左侧竖排分类里的「资源」分类（第二个），道具页停在别的分类时点它。 */
    resourceCategoryTap: Point
  }
  dialog: {
    /** 弹窗右上 X 的中心（只在第一次 BACK 后标题仍在时才点）。 */
    closeTap: Point
    /** 从弹窗回到世界地图需要按几次 BACK。 */
    backPresses: number
  }
  rows: ReadonlyArray<{ type: ResourceType; centerY: number }>
  rowPitchY: number
  /** 单元格 ROI 相对行中心的纵向偏移与高度。 */
  cellRoi: { yRel: number; h: number }
  columns: Record<ResourceStatsColumn, { centerX: number; x: number; w: number }>
}

export const RESOURCE_STATS_LAYOUT: ResourceStatsLayout = {
  refWidth: 2560,
  refHeight: 1440,
  nav: { itemsTap: { x: 2086, y: 1344 } },
  itemsPage: {
    statsButtonTap: { x: 1578, y: 265 },
    resourceCategoryTap: { x: 200, y: 524 }
  },
  dialog: { closeTap: { x: 2118, y: 192 }, backPresses: 2 },
  rows: [
    { type: 'gold', centerY: 452 },
    { type: 'wood', centerY: 648 },
    { type: 'iron', centerY: 844 },
    { type: 'mana', centerY: 1040 }
  ],
  rowPitchY: 196,
  cellRoi: { yRel: -23, h: 46 },
  columns: {
    item: { centerX: 1280, x: 1155, w: 250 },
    total: { centerX: 1806, x: 1681, w: 250 }
  }
}

/** 某行某列的单元格 ROI（参考坐标）。行不存在会抛错 —— 行序是常量，走到这里就是代码写错了。 */
export function rowRoi(type: ResourceType, column: ResourceStatsColumn): Rect {
  const row = RESOURCE_STATS_LAYOUT.rows.find((r) => r.type === type)
  if (!row) throw new Error(`资源统计表里没有「${type}」这一行（行序常量与 RESOURCE_TYPES 不一致）`)
  const col = RESOURCE_STATS_LAYOUT.columns[column]
  return {
    x: col.x,
    y: row.centerY + RESOURCE_STATS_LAYOUT.cellRoi.yRel,
    w: col.w,
    h: RESOURCE_STATS_LAYOUT.cellRoi.h
  }
}
