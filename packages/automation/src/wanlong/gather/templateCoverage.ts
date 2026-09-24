/**
 * 模板覆盖检查：当前模板集缺了哪些采集要用的模板、哪些字形集没补齐 0~9。
 *
 * 模板库页用它生成「缺失的关键 / 可选模板」快捷列表（点一下就把固定 ID、名称、标签填好），
 * 省得用户去翻 gather-templates.json 抄 id。判据与 loadGatherTemplates 同一份（GATHER_CRITICAL_TEMPLATES /
 * GATHER_OPTIONAL_TEMPLATES / glyphCharOf），这里只数数，不编译、不读图。
 *
 * ★ 字形集必须覆盖 0~9（采集铁律 3）：滑杆上限会从 8 涨到 10，缺 0/9 时「10」会被读成「16」，
 *   对账式调滑杆一次都点不中。所以每套字形都单独列出缺的数字。
 */

import type { TemplateDefinition } from '../../contracts.js'
import { GATHER_CRITICAL_TEMPLATES, GATHER_OPTIONAL_TEMPLATES, GLYPH, TPL, glyphCharOf } from './templates.js'

/** 采集流程会引用的界面模板的中文说明（只覆盖关键 + 可选两张清单）。 */
export const GATHER_TEMPLATE_LABELS: Readonly<Record<string, string>> = {
  [TPL.worldSearchIcon]: '世界地图：放大镜（判定世界地图、打开搜索面板）',
  [TPL.btnSearch]: '搜索面板：搜索按钮（面板锚点）',
  [TPL.labelLevel]: '搜索面板：「等级」标签（随滑杆移动）',
  [TPL.btnGather]: '资源点卡片：采集按钮（卡片锚点）',
  [TPL.valueNone]: '资源点卡片：「无」（采集者空闲判据）',
  [TPL.btnCreateTroop]: '资源点卡片：创建部队按钮',
  [TPL.btnMarch]: '创建部队页：行军按钮（页面锚点）',
  [TPL.panelTitleTroop]: '部队管理：面板标题',
  [TPL.queueIconPanel]: '部队管理：队列图标',
  [TPL.navMapToggle]: '城内：切世界地图按钮（法师）',
  [TPL.navMapToggleB]: '城内：切世界地图按钮（兽族，建议透明底）',
  [TPL.queueIconMap]: '世界地图：右侧部队管理入口',
  [TPL.navCityToggleB]: '世界地图：回城按钮（兽族）',
  [TPL.autoBtn]: '搜索面板：自动按钮（选错分类的否定判据）',
  [TPL.labelAutoUntilEmpty]: '资源点卡片：「自动采集至耗尽」标签',
  [TPL.labelCoordCard]: '资源点卡片：坐标标签',
  [TPL.labelCoordRow]: '部队管理：行内坐标标签',
  [TPL.btnPresetGather]: '创建部队页：采集编成按钮',
  [TPL.labelTroops]: '创建部队页：兵力标签',
  [TPL.labelLoad]: '创建部队页：负载标签',
  [TPL.staminaDrop]: '指挥官体力图标',
  [TPL.statusGathering]: '部队管理：「采集中」图标',
  [TPL.statusGatheringGreen]: '部队管理：「采集中」图标（绿）',
  [TPL.statusGatherMarching]: '部队管理：前往采集图标',
  [TPL.statusReturning]: '部队管理：返回图标',
  [TPL.dlgTitleNotice]: '「提示」弹窗标题',
  [TPL.btnCancel]: '弹窗：取消按钮',
  [TPL.btnClosePopup]: '活动弹窗右上角 ×（建议两帧去底）',
  [TPL.allianceOwn]: '本方联盟缩写（按账号一张）',
}

/** 字形集的中文说明。 */
export const GLYPH_SET_LABELS: Readonly<Record<string, string>> = {
  [GLYPH.dark20]: '深字浅底（储量 / 队列 / 倒计时 / 兵力 / 负载）',
  [GLYPH.light16]: '白字深底（「采集中」进度条倒计时）',
  [GLYPH.panelLevel]: '搜索面板「等级 N」',
  [GLYPH.cardCoord]: '卡片 / 行内坐标',
  [GLYPH.marchBtn]: '行军按钮上的行军耗时',
  [GLYPH.stamina]: '指挥官体力 N/M',
  [GLYPH.cardTitle]: '卡片标题里的等级数字',
}

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']

export interface MissingTemplate {
  id: string
  label: string
  /** 'missing' = 模板集里没有；'failed' = 有但编译不过（见 reason）。 */
  state: 'missing' | 'failed'
  reason?: string
}

export interface GlyphCoverage {
  name: string
  label: string
  /** 已有的字符（排好序）。 */
  present: string[]
  /** 缺的数字 0~9。 */
  missingDigits: string[]
}

export interface GatherTemplateCoverage {
  critical: MissingTemplate[]
  optional: MissingTemplate[]
  glyphs: GlyphCoverage[]
  /** 没有关键模板缺失（字形与可选模板不影响能否起跑）。 */
  ready: boolean
}

/**
 * @param templates 模板集里的定义（只看 id / tags，不读图）
 * @param failures  编译失败的模板（可选：loadPreparedSet 的 failed），它们按「有但不能用」算
 */
export function gatherTemplateCoverage(
  templates: readonly Pick<TemplateDefinition, 'id' | 'tags'>[],
  failures: readonly { id: string; reason: string }[] = []
): GatherTemplateCoverage {
  const failed = new Map(failures.map((item) => [item.id, item.reason]))
  const ids = new Set(templates.map((item) => item.id))
  const check = (id: string): MissingTemplate | null => {
    const label = GATHER_TEMPLATE_LABELS[id] ?? id
    if (!ids.has(id)) return { id, label, state: 'missing' }
    const reason = failed.get(id)
    return reason === undefined ? null : { id, label, state: 'failed', reason }
  }
  const critical = GATHER_CRITICAL_TEMPLATES.map(check).filter((item): item is MissingTemplate => item !== null)
  const optional = GATHER_OPTIONAL_TEMPLATES.map(check).filter((item): item is MissingTemplate => item !== null)

  const glyphs: GlyphCoverage[] = Object.values(GLYPH).map((name) => {
    const present = new Set<string>()
    for (const item of templates) {
      if (!item.tags?.includes('digit') || item.tags.find((tag) => tag !== 'digit') !== name) continue
      if (failed.has(item.id)) continue
      const char = glyphCharOf(item.id, name)
      if (char) present.add(char)
    }
    return {
      name,
      label: GLYPH_SET_LABELS[name] ?? name,
      present: [...present].sort(),
      missingDigits: DIGITS.filter((digit) => !present.has(digit))
    }
  })
  return { critical, optional, glyphs, ready: critical.length === 0 }
}
