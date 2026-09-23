import type { PreparedTemplate } from '../../contracts.js';
import { loadTemplateSet, readTemplatePng } from '../../templates.js';
import { prepareTemplate } from '../../vision.js';
import type { Glyph, GlyphSet } from '../vision/digits.js';
import { AppError } from '../errors.js';

export const TPL = {
  /** 世界地图-放大镜：判定在世界地图 + 点它开搜索面板 */
  worldSearchIcon: 'tpl_world_search_icon',
  /** 城内-切到世界地图按钮 */
  navMapToggle: 'tpl_nav_map_toggle',
  /** 世界地图-回城内按钮 */
  navCityToggle: 'tpl_nav_city_toggle',

  /** ★搜索面板唯一锚点：面板随分类左右平移，所有按钮坐标都由它推 */
  btnSearch: 'tpl_btn_search',
  /** 搜索面板-等级标签（★随滑杆手柄移动，必须宽带 ROI 定位） */
  labelLevel: 'tpl_label_level',
  /** 搜索面板-自动按钮（黑暗灵部队页专属，用作「选错分类」的否定判据） */
  autoBtn: 'tpl_auto_btn',

  /** ★资源点卡片锚点 */
  btnGather: 'tpl_btn_gather',
  resWoodTitle: 'tpl_res_wood_title',
  resGoldTitle: 'tpl_res_gold_title',
  resIronTitle: 'tpl_res_iron_title',
  resManaTitle: 'tpl_res_mana_title',
  labelStorage: 'tpl_label_storage',
  labelGatherer: 'tpl_label_gatherer',
  labelAlliance: 'tpl_label_alliance',
  /** ★「无」：采集者是否空闲的核心判据，兼作所属联盟的中立判据 */
  valueNone: 'tpl_value_none',
  /** 本方联盟缩写（★按账号一张，公共模板集里通常没有，缺失时降级为「只接受中立」） */
  allianceOwn: 'tpl_alliance_own',
  labelAutoUntilEmpty: 'tpl_label_auto_until_empty',
  checkboxAutoOn: 'tpl_checkbox_auto_on',
  checkboxAutoOff: 'tpl_checkbox_auto_off',
  labelCoordCard: 'tpl_label_coord_card',

  btnCreateTroop: 'tpl_btn_create_troop',
  titleCreateTroop: 'tpl_title_create_troop',
  btnPresetGather: 'tpl_btn_preset_gather',
  /** ★创建部队页锚点：行军按钮，下方就是行军耗时 */
  btnMarch: 'tpl_btn_march',
  labelTroops: 'tpl_label_troops',
  labelLoad: 'tpl_label_load',

  panelTitleTroop: 'tpl_panel_title_troop',
  queueIconPanel: 'tpl_queue_icon_panel',
  /** 世界地图右侧的部队管理入口。★ 只在有队伍在野外时出现；不在 ⇒ 判定 0 支队在外，不要去点。 */
  queueIconMap: 'tpl_queue_icon_map',
  /**
   * ★ 阵营变体 B（兽族）。游戏有三套 UI 美术：法师（变体 A）、兽族（变体 B）、精灵（暂不适配）。
   *   城内↔世界地图两态按钮每个阵营各一套，主号模板打在兽族号上只有 0.2~0.6，判据必须 anyTemplate。
   *   世界地图回城按钮 B：主号模板打小号 0.20，2026-09-10 从小号帧裁出。
   */
  navCityToggleB: 'tpl_nav_city_toggle_b',
  /**
   * 城内切世界地图按钮 B（兽族）。圆环里透着城内地形、城一拖动就变，所以是**透明底**模板
   * （多帧差分去底，vision/alpha.ts）：整块匹配换个背景只有 0.79~0.89，掩码后 0.97~0.98。
   */
  navMapToggleB: 'tpl_nav_map_toggle_b',
  staminaDrop: 'tpl_stamina_drop',
  labelCoordRow: 'tpl_label_coord_row',
  statusGathering: 'tpl_status_gathering',
  statusGatheringGreen: 'tpl_status_gathering_green',
  statusGatherMarching: 'tpl_status_gather_marching',
  statusReturning: 'tpl_status_returning',

  btnBackGeneric: 'tpl_btn_back_generic',
  /**
   * 活动弹窗右上角的「×」（「光明精铸-自选宝物」这类带「前往」的推送弹窗）。可选：
   * 认不出界面时先在右上半屏找它，找到就点，找不到才盲按 BACK。
   * 弹窗不可复现，模板要等它再出现时用面板裁（ID 填 tpl_btn_close_popup，两帧去底更稳）。
   */
  btnClosePopup: 'tpl_btn_close_popup',
  dlgTitleNotice: 'tpl_dlg_title_notice',
  btnCancel: 'tpl_btn_cancel',
  btnConfirm: 'tpl_btn_confirm'
} as const

/** 字形集名。 */
export const GLYPH = {
  /** 通用深字浅底 21x29：卡片储量 / 队列 N/M / 行军·返回倒计时 / 兵力 / 负载量 */
  dark20: 'dig_dark20',
  /** 白字深底 16x25：部队管理「采集中」进度条上的倒计时（ETA 数据源） */
  light16: 'dig_light16',
  /** 搜索面板「等级 N」 */
  panelLevel: 'dig_panel_level',
  /** 卡片/行内坐标 */
  cardCoord: 'dig_card_coord',
  /** 行军按钮上的行军耗时（白字金底） */
  marchBtn: 'dig_march_btn',
  /** 指挥官耐力 N/M */
  stamina: 'dig_stamina',
  /** 卡片标题里的等级数字 */
  cardTitle: 'dig_card_title'
} as const

/**
 * 少了这几张，自动采集根本跑不起来（gather-templates.json 的 criticalPath）。
 * 加载时缺一张就直接报错，别等到跑到一半才在某个状态里失败。
 */
const CRITICAL_TEMPLATES: string[] = [
  TPL.worldSearchIcon,
  TPL.btnSearch,
  TPL.labelLevel,
  TPL.btnGather,
  TPL.valueNone,
  TPL.btnCreateTroop,
  TPL.btnMarch,
  TPL.panelTitleTroop,
  TPL.queueIconPanel
]

/** 缺了会明显降低容错、但还能跑的模板。加载时只告警。 */
const OPTIONAL_TEMPLATES: string[] = [
  TPL.navMapToggle,
  TPL.navMapToggleB,
  TPL.queueIconMap,
  TPL.navCityToggleB,
  TPL.autoBtn,
  TPL.labelAutoUntilEmpty,
  TPL.labelCoordCard,
  TPL.labelCoordRow,
  TPL.btnPresetGather,
  TPL.labelTroops,
  TPL.labelLoad,
  TPL.staminaDrop,
  TPL.statusGathering,
  TPL.statusGatheringGreen,
  TPL.statusGatherMarching,
  TPL.statusReturning,
  TPL.dlgTitleNotice,
  TPL.btnCancel,
  TPL.btnClosePopup,
  TPL.allianceOwn
]

/** id 后缀 -> 字符。数字直接用后缀本身。 */
const SUFFIX_TO_CHAR: Record<string, string> = {
  colon: ':',
  slash: '/',
  comma: ',',
  dot: '.',
  percent: '%'
}

export interface GatherTemplates {
  setId: string
  refWidth: number
  refHeight: number
  /** 界面模板（shrink=2）。 */
  ui: Map<string, PreparedTemplate>
  /** 字形集（shrink=1）。 */
  glyphSets: Map<string, GlyphSet>
  /** 编译失败或根本没裁的模板 id。 */
  missing: string[]
  /** 取界面模板，缺失时抛中文错误。 */
  require(id: string): PreparedTemplate
  /** 取界面模板，缺失返回 undefined（用于可选判据）。 */
  get(id: string): PreparedTemplate | undefined
  has(id: string): boolean
  /** 取字形集，缺失时抛中文错误。 */
  requireGlyphs(name: string): GlyphSet
  hasGlyphs(name: string): boolean
}

export interface LoadGatherTemplatesOptions {
  /** The one user-selected directory containing manifest.json and PNGs. */
  templateDir: string;
  shrink?: number;
  onWarn?: (message: string, detail?: Record<string, unknown>) => void;
}

/** Compile UI anchors at shrink=2 and OCR glyphs at shrink=1. */
export async function loadGatherTemplates(options: LoadGatherTemplatesOptions): Promise<GatherTemplates> {
  const set = await loadTemplateSet(options.templateDir);
  if (set.packageName && set.packageName !== 'com.lilithgames.samo.android.cn') {
    throw new AppError('TEMPLATE_NOT_FOUND', `模板集属于 ${set.packageName}，不是万龙觉醒`);
  }
  const ui = new Map<string, PreparedTemplate>();
  const buckets = new Map<string, Glyph[]>();
  const missing: string[] = [];
  for (const item of set.templates) {
    const glyphName = item.tags?.includes('digit') ? item.tags.find((tag) => tag !== 'digit') : undefined;
    try {
      const image = await readTemplatePng(set, item.id);
      const prepared = await prepareTemplate(image, item, set, glyphName ? 1 : (options.shrink ?? 2));
      if (glyphName) {
        const char = charOf(item.id, glyphName);
        if (!char) { missing.push(item.id); continue; }
        const list = buckets.get(glyphName) ?? [];
        list.push({ char, tpl: prepared });
        buckets.set(glyphName, list);
      } else {
        ui.set(item.id, prepared);
      }
    } catch (error) {
      missing.push(item.id);
      options.onWarn?.(`模板 ${item.id} 编译失败：${error instanceof Error ? error.message : String(error)}`, { templateId: item.id });
    }
  }
  const critical = CRITICAL_TEMPLATES.filter((id) => !ui.has(id));
  if (critical.length) {
    throw new AppError('TEMPLATE_NOT_FOUND', `缺少采集关键模板：${critical.join('、')}`, { missing: critical });
  }
  const optional = OPTIONAL_TEMPLATES.filter((id) => !ui.has(id));
  if (optional.length) options.onWarn?.(`可选模板缺失：${optional.join('、')}`, { missing: optional });
  const glyphSets = new Map<string, GlyphSet>();
  for (const [name, glyphs] of buckets) {
    glyphs.sort((a, b) => a.char.localeCompare(b.char));
    const widths = glyphs.map((glyph) => glyph.tpl.refW).sort((a, b) => a - b);
    glyphSets.set(name, { name, glyphs, medianGlyphW: widths[Math.floor(widths.length / 2)] ?? 20 });
  }
  return {
    setId: set.id,
    refWidth: set.refWidth,
    refHeight: set.refHeight,
    ui,
    glyphSets,
    missing: [...new Set([...missing, ...optional])],
    require(id) {
      const value = ui.get(id);
      if (!value) throw new AppError('TEMPLATE_NOT_FOUND', `缺少模板 ${id}`);
      return value;
    },
    get: (id) => ui.get(id),
    has: (id) => ui.has(id),
    requireGlyphs(name) {
      const value = glyphSets.get(name);
      if (!value?.glyphs.length) throw new AppError('TEMPLATE_NOT_FOUND', `缺少字形集 ${name}`);
      return value;
    },
    hasGlyphs: (name) => Boolean(glyphSets.get(name)?.glyphs.length),
  };
}

function charOf(id: string, glyphName: string): string | null {
  const suffix = id.startsWith(`${glyphName}_`) ? id.slice(glyphName.length + 1) : id.split('_').at(-1);
  if (!suffix) return null;
  return SUFFIX_TO_CHAR[suffix] ?? (/^[0-9]$/.test(suffix) ? suffix : null);
}
