/**
 * 资源统计表用到的模板 id、字形集名，以及「从截图按规格裁模板」的纯计划（不读文件、不碰 sharp）。
 *
 * ★ 纯模块，由 `@avdm/automation/wanlong/pure` 转出：模板页的「资源统计模板」清单、导入向导都能直接用。
 *
 * 模板分三类，编译倍率不同，**绝不能混**：
 *   · 界面模板 tpl_*（弹窗标题、资源统计按钮、关闭 X、行标签、导航「道具」）：
 *     跟其它采集模板一样由 loadGatherTemplates 按 shrink=2 编入 ui 表，走 GatherSession.matchOptional。
 *   · 字形 dig_resstat_<0-9|dot|comma>（tags ['digit','dig_resstat']）：
 *     loadGatherTemplates 按 shrink=1 编成字形集 `dig_resstat`，走 readDigits。
 *   · 单位字 tpl_resstat_unit_yi / tpl_resstat_unit_wan（tags ['resstat_unit']，★没有 digit 标签）：
 *     loadGatherTemplates 会把它们当界面模板按 shrink=2 编一份（无害），但读表要的是**像素级**的 x 落点
 *     （数字 ROI 的右边界 = 单位字左边界），所以 templates.ts 自己再按 shrink=1 编一份并缓存。
 *     ★ 为什么单位字不进字形集：readDigits 是逐字形多峰匹配，「亿」的亻/乙两部分会被当成 1 或小数点的候选；
 *       用整字 matchIn 定位再把它切出 ROI 之外，是离线验证 8/8 读对的关键（见 resource-stats.json 的 segmentationHazard）。
 *
 * ★ id 字符串与旧版面板完全一致：旧模板集原样导入即可用，别改名。
 */

import type { Rect } from '../../contracts.js'
import type { ResourceType } from './contract.js'

/** 界面模板 id。改名前先确认模板库与 game-data/wanlong/resource-stats.json 一起改。 */
export const RES_TPL = {
  /** 资源页右上「资源统计」按钮（必需：判定道具页已开 + 点击点） */
  btnResStats: 'tpl_btn_res_stats',
  /** 资源统计弹窗标题（必需：判定弹窗已开 / 已关） */
  titleResStats: 'tpl_title_res_stats',
  /** 弹窗右上关闭 X（可选：BACK 失效时的兜底） */
  btnCloseResStats: 'tpl_btn_close_res_stats',
  /** 道具页左上标题「资源」（可选） */
  titleItemsRes: 'tpl_title_items_res',
  /** 单位「亿」（shrink=1 单独编译，见文件头） */
  unitYi: 'tpl_resstat_unit_yi',
  /** 单位「万」（★现有截图里没有，待真机补裁） */
  unitWan: 'tpl_resstat_unit_wan',
  /** 世界地图底部导航「道具」（可选：缺失时按固定坐标点） */
  navItems: 'tpl_nav_items'
} as const

/** 行标签模板（可选：存在时顺手校验行序）。 */
export const RES_LABEL_TPL: Readonly<Record<ResourceType, string>> = {
  gold: 'tpl_label_res_gold',
  wood: 'tpl_label_res_wood',
  iron: 'tpl_label_res_iron',
  mana: 'tpl_label_res_mana'
}

/** 字形集名（loadGatherTemplates 按 tags 里的这个名字归类）。 */
export const RES_GLYPH = 'dig_resstat'

/** 字形模板的 tags：带 digit ⇒ 按 shrink=1 编进字形集 dig_resstat。 */
export const RES_GLYPH_TAGS: readonly string[] = ['digit', RES_GLYPH]

/** 单位字模板的 tags（★没有 digit：绝不能进字形集）。 */
export const RES_UNIT_TAGS: readonly string[] = ['resstat_unit']

/** 单位字 → 字符。 */
export const RES_UNIT_CHAR: Readonly<Record<string, '亿' | '万'>> = {
  [RES_TPL.unitYi]: '亿',
  [RES_TPL.unitWan]: '万'
}

/** readResourceStatsPanel 动手之前必须齐的界面模板（外加字形集 dig_resstat）。 */
export const RESOURCE_REQUIRED_TEMPLATES: readonly string[] = [RES_TPL.btnResStats, RES_TPL.titleResStats]

// ══════════════════════════════════════════════════════════════════════════
// 模板目录（规格的手抄件）+ 从截图裁模板的纯计划
// ══════════════════════════════════════════════════════════════════════════

/** 裁模板要用的几帧（按「画面角色」认帧，不认文件名）。 */
export type ResourceSeedFrame = 'items' | 'stats' | 'back1' | 'worldMap'

export const RESOURCE_SEED_FRAMES: readonly ResourceSeedFrame[] = ['items', 'stats', 'back1', 'worldMap']

/** 帧角色的中文说明（导入向导 / 模板页提示用）。 */
export const RESOURCE_SEED_FRAME_LABEL: Readonly<Record<ResourceSeedFrame, string>> = {
  items: '道具→资源页（右上有「资源统计」按钮）',
  stats: '资源统计弹窗（4 行 × 2 列的表）',
  back1: '弹窗上按一次 BACK 之后（回到资源页，按钮仍在）',
  worldMap: '世界地图（底部导航里能看到「道具」）'
}

/**
 * 旧版面板仓库里这几帧的文件名（docs/game/shots/resources/）。
 * 只用于「导入旧版数据」时按名认帧；新截的帧由用户按角色指定。
 */
export const RESOURCE_SEED_LEGACY_FILES: Readonly<Record<ResourceSeedFrame, string>> = {
  items: 'res_02_items.png',
  stats: 'res_04_stats.png',
  back1: 'res_05_back1.png',
  worldMap: 'res_06_back2.png'
}

/** 一张模板在规格里的样子（参考坐标 2560x1440）。 */
export interface ResourceTemplateSpec {
  id: string
  name: string
  kind: 'ui' | 'unit' | 'glyph'
  priority: '必需' | '可选'
  /** 字形才有：对应的字符。 */
  char?: string
  /** 从哪一帧裁；null = 现有截图里没有素材（规格里标 missing，待真机补裁）。 */
  frame: ResourceSeedFrame | null
  /** 裁剪框（参考坐标）。frame 为 null 时没有。 */
  bounds?: Rect
  /** 默认搜索范围（参考坐标）。 */
  roi?: Rect
  tags?: readonly string[]
  /** 写进模板 note 的说明（用途 + 裁剪要点）。 */
  note: string
}

/**
 * 资源统计模板目录 —— resource-stats.json 的 templates[] 与 glyphs.items[] 的手抄件。
 * ★ test/wanlong-resources-layout.test.ts 逐项断言与 JSON 一致，改一边必须改另一边。
 */
export const RESOURCE_TEMPLATE_CATALOG: readonly ResourceTemplateSpec[] = [
  {
    id: RES_TPL.titleResStats,
    name: '资源统计-弹窗标题',
    kind: 'ui',
    priority: '必需',
    frame: 'stats',
    bounds: { x: 1155, y: 144, w: 236, h: 66 },
    roi: { x: 1000, y: 100, w: 560, h: 160 },
    note: '① 判定弹窗已打开；② 还原时判定弹窗已关。白字「资源统计」+ 四周黑色笔刷底，不要框到笔刷毛边。'
  },
  {
    id: RES_TPL.btnResStats,
    name: '资源页-资源统计按钮',
    kind: 'ui',
    priority: '必需',
    frame: 'items',
    bounds: { x: 1480, y: 234, w: 200, h: 62 },
    roi: { x: 1380, y: 200, w: 400, h: 130 },
    note: '① 判定已在「道具→资源」页；② 它的中心就是点击点；③ 还原第一步的校验。深灰字「资源统计」+ 右侧深棕色小图标。'
  },
  {
    id: RES_TPL.btnCloseResStats,
    name: '资源统计-右上关闭X',
    kind: 'ui',
    priority: '可选',
    frame: 'stats',
    bounds: { x: 2068, y: 142, w: 102, h: 102 },
    roi: { x: 2000, y: 90, w: 260, h: 220 },
    note: '第一次 BACK 后标题仍在时点它关弹窗；命中才点，不命中不点。'
  },
  {
    id: RES_TPL.titleItemsRes,
    name: '道具页-左上标题「资源」',
    kind: 'ui',
    priority: '可选',
    frame: 'items',
    bounds: { x: 133, y: 33, w: 122, h: 66 },
    roi: { x: 100, y: 10, w: 220, h: 110 },
    note: '辅助判定「道具页已打开且选中资源分类」。'
  },
  {
    id: RES_TPL.navItems,
    name: '主界面-底部导航「道具」',
    kind: 'ui',
    priority: '可选',
    frame: 'worldMap',
    bounds: { x: 2046, y: 1312, w: 108, h: 66 },
    roi: { x: 1980, y: 1270, w: 240, h: 170 },
    note: '预检时确认底部导航可见；缺失时按固定坐标点。只框米色宝箱本体的下半段，避开右上角红色角标与下方白字「道具」。'
  },
  {
    id: RES_LABEL_TPL.gold,
    name: '资源统计-行标签「金币」',
    kind: 'ui',
    priority: '可选',
    frame: 'stats',
    bounds: { x: 808, y: 431, w: 78, h: 42 },
    roi: { x: 780, y: 412, w: 200, h: 80 },
    note: '行序校验（可选）。'
  },
  {
    id: RES_LABEL_TPL.wood,
    name: '资源统计-行标签「木材」',
    kind: 'ui',
    priority: '可选',
    frame: 'stats',
    bounds: { x: 807, y: 626, w: 81, h: 43 },
    roi: { x: 780, y: 608, w: 200, h: 80 },
    note: '行序校验（可选）。'
  },
  {
    id: RES_LABEL_TPL.iron,
    name: '资源统计-行标签「铁矿石」',
    kind: 'ui',
    priority: '可选',
    frame: 'stats',
    bounds: { x: 807, y: 822, w: 118, h: 43 },
    roi: { x: 780, y: 804, w: 200, h: 80 },
    note: '行序校验（可选）。'
  },
  {
    id: RES_LABEL_TPL.mana,
    name: '资源统计-行标签「魔水」',
    kind: 'ui',
    priority: '可选',
    frame: 'stats',
    bounds: { x: 807, y: 1018, w: 81, h: 42 },
    roi: { x: 780, y: 1000, w: 200, h: 80 },
    note: '行序校验（可选）。'
  },
  {
    id: RES_TPL.unitYi,
    name: '资源统计-单位「亿」',
    kind: 'unit',
    priority: '必需',
    frame: 'stats',
    bounds: { x: 1291, y: 434, w: 37, h: 37 },
    tags: RES_UNIT_TAGS,
    note: '单位字。★不进字形集（没有 digit 标签），读表模块自己按 shrink=1 编译后在单元格里定位，把数字 ROI 截到它左边。'
  },
  {
    id: RES_TPL.unitWan,
    name: '资源统计-单位「万」',
    kind: 'unit',
    priority: '必需',
    frame: null,
    tags: RES_UNIT_TAGS,
    note: '★现有截图里没有「万」。绝不能拿顶栏的「万」裁（白字黑边、字号与极性都不同），必须等表里真出现「万」时补裁。'
  },
  ...glyph('0', { x: 1269, y: 828, w: 21, h: 31 }, '铁矿石·道具总量 2.0亿'),
  ...glyph('1', { x: 1748, y: 437, w: 19, h: 30 }, '金币·资源总量 11.1亿（首位）'),
  ...glyph('2', { x: 1233, y: 437, w: 21, h: 30 }, '金币·道具总量 2.9亿'),
  ...glyph('3', { x: 1233, y: 632, w: 21, h: 31 }, '木材·道具总量 3.2亿'),
  ...glyph('4', { x: 1758, y: 633, w: 23, h: 30 }, '木材·资源总量 4.1亿'),
  ...glyph('5', null, '本帧 8 个数值里没有 5，待真机表里出现时补裁'),
  ...glyph('6', { x: 1233, y: 1024, w: 21, h: 31 }, '魔水·道具总量 6.2亿'),
  ...glyph('7', { x: 1759, y: 1024, w: 21, h: 30 }, '魔水·资源总量 7.2亿'),
  ...glyph('8', null, '本帧没有 8，待真机补裁'),
  ...glyph('9', { x: 1269, y: 437, w: 21, h: 30 }, '金币·道具总量 2.9亿'),
  ...glyph('.', { x: 1255, y: 456, w: 12, h: 12 }, '金币·道具总量 2.9亿 的小数点（7x7 字芯，四周多留 2px 底）'),
  ...glyph(',', null, '只有值 < 1 万时才会出现千分位整数（如 9,999）；本帧没有')
]

/** 字形 id：数字用自身，小数点 / 逗号用 dot / comma（与 loadGatherTemplates 的后缀表一致）。 */
export function resourceGlyphId(char: string): string {
  const suffix = char === '.' ? 'dot' : char === ',' ? 'comma' : char
  return `${RES_GLYPH}_${suffix}`
}

function glyph(char: string, bounds: Rect | null, from: string): ResourceTemplateSpec[] {
  return [
    {
      id: resourceGlyphId(char),
      name: `资源统计数字-${char}`,
      kind: 'glyph',
      priority: '必需',
      char,
      frame: bounds ? 'stats' : null,
      ...(bounds ? { bounds } : {}),
      tags: RES_GLYPH_TAGS,
      note: bounds ? `资源统计表数字（浅底黑字，shrink=1）。来源：${from}` : from
    }
  ]
}

/** 裁模板计划里的一张（坐标都是参考坐标；换算到实际截图像素是执行方的事）。 */
export interface ResourceSeedDraft {
  id: string
  name: string
  frame: ResourceSeedFrame
  crop: Rect
  defaultRoi?: Rect
  tags?: string[]
  note: string
}

export interface ResourceSeedPlan {
  drafts: ResourceSeedDraft[]
  /** 规格里标了 missing（现有截图没有素材）的条目，附中文原因。 */
  skipped: Array<{ id: string; reason: string }>
}

/**
 * 按规格列出「从哪一帧、裁哪一块、存成什么 id」。纯函数：不读文件、不写模板库。
 * 规格里标 missing 的条目（5 / 8 / 逗号 / 「万」）进 skipped，等真机出现时再补。
 */
export function resourceSeedPlan(catalog: readonly ResourceTemplateSpec[] = RESOURCE_TEMPLATE_CATALOG): ResourceSeedPlan {
  const drafts: ResourceSeedDraft[] = []
  const skipped: Array<{ id: string; reason: string }> = []
  for (const t of catalog) {
    if (!t.frame || !t.bounds) {
      skipped.push({ id: t.id, reason: `现有截图里没有素材，跳过（${t.note || '待真机补裁'}）` })
      continue
    }
    drafts.push({
      id: t.id,
      name: t.name,
      frame: t.frame,
      crop: { ...t.bounds },
      ...(t.roi ? { defaultRoi: { ...t.roi } } : {}),
      ...(t.tags ? { tags: [...t.tags] } : {}),
      note: t.note
    })
  }
  return { drafts, skipped }
}
