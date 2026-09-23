/**
 * 采集流程的全部几何常量（参考分辨率 2560x1440 空间）。
 *
 * 数据来源：resources/game-data/gather-flow.json 的 anchors / fixedTaps，
 * 其中带「真机复量」标注的值优先（早期从 1280x720 缩放图量的值已作废）。
 *
 * ★ 铁律：除了下面 FIXED_TAP 里那几个确认不动的坐标，**其余一律由模板命中位置推算**。
 *   搜索面板会随选中分类整体左右平移（搜索按钮中心 x 从 464 一路挪到 2115），
 *   写死坐标必然点空。资源点卡片也会随资源点在屏幕上的位置轻微漂移（实测 <25px）。
 */

import type { Point, Rect } from '../../contracts.js'
import type { GatherResourceType } from '../config.js'

export const GAME_PACKAGE = 'com.lilithgames.samo.android.cn'

/** 相对某个锚点的偏移。 */
export interface Offset {
  x: number
  y: number
}

/** 少数确认稳定、不随面板平移的坐标。 */
/**
 * 活动弹窗右上角「×」的搜索区（右上半屏）。不同活动弹窗大小不一，× 的位置跟着变，
 * 所以只限定到右上象限。只在「认不出界面」时才拿 tpl_btn_close_popup 来这里搜，
 * 主界面上没有别的 × 会掉进来。
 */
export const POPUP_CLOSE_ROI: Rect = { x: 1280, y: 40, w: 1280, h: 900 }

export const FIXED_TAP = {
  /** 城内 -> 世界地图 */
  cityToMap: { x: 115, y: 1330 } as Point,
  /** 世界地图 -> 打开搜索面板（放大镜） */
  worldSearchIcon: { x: 100, y: 1112 } as Point,
  /**
   * 世界地图右侧边缘的部队管理入口。
   * ★务必 x=2522：点 2468 会落到地图上把地图拖走；(2524,682) 是收起右侧栏的双箭头。
   */
  troopPanelEntry: { x: 2522, y: 592 } as Point,
  /** 关面板用的「面板外空地」。★不要在世界地图上乱点，只在确认有面板/卡片时用。 */
  emptyArea: { x: 400, y: 700 } as Point
} as const

/** 底部资源分类栏的 y。 */
export const CATEGORY_BAR_Y = 1310

/** 底部资源分类栏各分类的 tap x（实测）。 */
export const CATEGORY_TAP_X: Record<GatherResourceType | 'darkspirit', number> = {
  darkspirit: 460,
  gold: 874,
  wood: 1276,
  iron: 1686,
  mana: 2088
}

/**
 * 各分类被选中后，搜索按钮（tpl_btn_search）中心的实测 x。
 * 用来「反推当前选中的是哪个分类」—— 比去认分类栏的图标便宜且可靠。
 */
export const SEARCH_ANCHOR_X: Record<GatherResourceType | 'darkspirit', number> = {
  darkspirit: 464,
  gold: 855,
  wood: 1269,
  iron: 1697,
  mana: 2115
}

/** 分类判定容差（实测相邻分类间距 ~420，40 的容差非常宽松）。 */
export const SEARCH_ANCHOR_TOLERANCE = 40

/** 资源类型 -> 卡片标题模板 id 的映射键（真正的 id 在 templates.ts）。 */
export const RESOURCE_TITLE_KEY: Record<GatherResourceType, 'wood' | 'gold' | 'iron' | 'mana'> = {
  wood: 'wood',
  gold: 'gold',
  iron: 'iron',
  mana: 'mana'
}

// ── 搜索面板：全部相对 tpl_btn_search 的**命中中心** ──────────────────────
// 实测锚点：伐木场页 (1269,1055)。y 恒 1055，各分类只有 x 变。

export const SEARCH_PANEL = {
  /** 匹配搜索按钮用的横带 ROI（覆盖五个平移位置）。 */
  anchorRoi: { x: 300, y: 996, w: 2000, h: 118 } as Rect,
  /** [−] 按钮 */
  levelMinus: { x: -254, y: -144 } as Offset,
  /** [+] 按钮 */
  levelPlus: { x: 270, y: -144 } as Offset,
  /** 滑杆轨道左端（探测上限时的起手点） */
  sliderLeft: { x: -180, y: -144 } as Offset,
  /**
   * 滑杆推到底的抬手点。
   * ★ 只能到 +230（绝对 ~1499）：+300 会把抬手点落在 [+] 按钮（实测 1513..1567）上，
   *   变成「拖完又点了一下加号」，读数会多 1。
   */
  sliderOvershootRight: { x: 230, y: -144 } as Offset,
  /**
   * 「等级 N」标签的宽带搜索区。
   * ★★ 已在真机上定论：标签**随滑杆手柄一起左右移动**（伐木场面板 lv2..lv8 每级右移 55.3px），
   *    所以必须先在这条宽带里把标签匹配出来，再取它右边的窄条当数字 ROI。
   *    用相对搜索按钮的固定偏移开数字 ROI，等级调到 8 时会完全框空。
   */
  levelRowBandRoi: { x: -290, y: -243, w: 620, h: 70 } as Rect
} as const

/**
 * 等级数字 ROI：相对 tpl_label_level **命中框左上角**。
 * 实测（lv5）标签命中 (1256,828)、数字墨迹 1330..1350 / 834..864，即数字左边缘 ≈ 标签左边缘 + 74。
 * w 给到 64 是为了兼容两位数等级（版本上限会到 10）。
 */
export const LEVEL_DIGIT_ROI_REL_LABEL: Rect = { x: 66, y: -4, w: 64, h: 46 }

// ── 资源点卡片：全部相对 tpl_btn_gather 的**命中中心** ────────────────────
// 真机复量锚点 (1840,1048)（采集按钮矩形 1669..2011 / 993..1104）。
// 早期基于 1280x720 缩放图推出的 (1819,1045) 偏左 21px，已作废。

export const CARD = {
  /** 采集按钮的搜索区（卡片出现判定也用它）。 */
  anchorRoi: { x: 1240, y: 880, w: 1320, h: 320 } as Rect,
  /** 标题横带：认资源类型（tpl_res_*_title）。 */
  titleBandRoi: { x: -540, y: -448, w: 1000, h: 120 } as Rect,
  /**
   * 储量数值（右对齐到 x≈2124）。
   * ★ 高度必须给足 60：dark20 的逗号字形是 18x44（比数字的 36 高），
   *   ROI 只留 48 高时逗号会被下边缘切掉 2 像素，分数从 0.97 掉到 0.68 而漏识别，
   *   拼串时中间就多出一个 '?' 让整串校验失败 —— 离线回放实测过，别改小。
   */
  storageValueRoi: { x: 60, y: -344, w: 250, h: 60 } as Rect,
  /** 采集者数值（判 tpl_value_none）。 */
  gathererValueRoi: { x: 180, y: -280, w: 118, h: 48 } as Rect,
  /**
   * 所属联盟数值。
   * ★ 特意开宽：值是右对齐的，「无」贴在 x≈2091..2126，而联盟缩写 [T89S] 在 1958..2074，
   *   两种情况的位置差很多，窄 ROI 会漏掉其中一种。
   */
  allianceValueRoi: { x: 90, y: -222, w: 210, h: 50 } as Rect,
  /** 「自动采集至清空」文字（勾选框探针的锚）。 */
  autoLabelRoi: { x: -120, y: -166, w: 290, h: 80 } as Rect,
  /** 勾选框圆心兜底位置（模板定位失败时用）。实测绝对坐标 (1721,921)。 */
  autoCheckboxFallback: { x: -119, y: -127 } as Offset,
  /**
   * 坐标数值（「坐标:」标签匹配不到时的兜底 ROI）。
   * ★ 纵向必须卡紧到 44 高：坐标行右侧有装饰元素，在 y≈1125 处能给逗号字形 0.70~0.76 的虚假峰，
   *   靠横向裁不掉（长坐标会被截断），只能靠纵向把它挡在窗口外。离线回放实测过。
   */
  coordValueRoi: { x: 24, y: 64, w: 176, h: 44 } as Rect,
  /** 关卡片：点卡片外的空地。 */
  closeByTapOutside: { x: -1440, y: -648 } as Offset
} as const

/**
 * 勾选框探针 / 点击点：相对 tpl_label_auto_until_empty **命中框左上角**。
 * 实测文字模板 bounds (1756,898)、勾选圆心 (1721,921) ⇒ (-35, +23)。
 */
export const CHECKBOX_PROBE_REL_LABEL: Offset = { x: -35, y: 23 }

/**
 * 「自动采集至清空」两态的实测 RGB（7x7 均值）与判据。
 * ON  = (255,255,103) 饱和亮黄；OFF = (83,83,83) 深灰。两态差异极大，判据非常稳。
 */
export const CHECKBOX_RULE = {
  onRgb: { r: 255, g: 255, b: 103 },
  offRgb: { r: 83, g: 83, b: 83 },
  isOn: (c: { r: number; g: number; b: number }): boolean => c.r > 200 && c.b < 160,
  isOff: (c: { r: number; g: number; b: number }): boolean =>
    c.r < 130 && Math.abs(c.r - c.g) < 10 && Math.abs(c.g - c.b) < 10
} as const

/**
 * 卡片标题里的等级数字 ROI：相对 tpl_res_*_title **命中框左上角**。
 * ★ 标题「等级N 资源名」整体居中 ⇒ 等级变两位数时整行左移，
 *   必须以资源名模板为锚往左反推，禁止固定 ROI。
 * narrow 覆盖一位数（实测伐木场名左 1830、数字 1793..1817），wide 兼容两位数。
 */
export const CARD_LEVEL_ROI_NARROW: Rect = { x: -50, y: -10, w: 48, h: 66 }
export const CARD_LEVEL_ROI_WIDE: Rect = { x: -100, y: -10, w: 98, h: 66 }

// ── 创建部队页：全部相对 tpl_btn_march 的**命中框左上角** ─────────────────
// 模板 bounds (2058,1212) 122x64（只框「行军」两个汉字，绝不能把下面会变的倒计时裁进去）。

export const CREATE_TROOP = {
  /** 行军按钮搜索区。 */
  anchorRoi: { x: 1800, y: 1150, w: 760, h: 230 } as Rect,
  /**
   * 行军点击点 = 金色按钮几何中心。
   * 真机实测金按钮 1895..2355 / 1185..1348，中心 (2125,1266) = 命中框左上角 + (67,54)。
   */
  marchTap: { x: 67, y: 54 } as Offset,
  /**
   * 行军耗时 ROI。★ 从 x 偏移 -8 起是为了排除倒计时左边那个白色小鸟图标（实测 2004..2040）。
   * 实测倒计时墨迹 2055..2214 / 1287..1314，**金底白字**（早期文档写成黑字是错的）。
   */
  travelTimeRoi: { x: -8, y: 73, w: 170, h: 42 } as Rect,
  /** 「采集」一键编成按钮的搜索区（绝对坐标，页面不平移）。 */
  presetGatherRoi: { x: 1700, y: 330, w: 700, h: 150 } as Rect,
  /** 左上角返回箭头。 */
  backButton: { x: 55, y: 68 } as Point
} as const

/**
 * 兵力 / 负载量数值 ROI：相对各自标签（tpl_label_troops / tpl_label_load）命中框右边缘。
 * ★ dx 必须是 0：负载量的第一个字符实测紧贴在标签命中框右边缘外 3px（1488 -> 1491），
 *   dx=10 会把首位数字切掉，读成 ",323,000" 而不是 "1,323,000"。离线回放实测过。
 */
export const VALUE_RIGHT_OF_LABEL = { dx: 0, dy: -8, w: 520, h: 62 }

// ── 部队管理面板 ──────────────────────────────────────────────────────────

export const TROOP_PANEL = {
  /**
   * 面板标题搜索区。
   * ★ 左边界必须 <= 900：标题模板的 bounds 是 (944,32) 238x68，
   *   设计文档里写的 {950,20,500,90} 会把模板左边缘切掉 —— matchIn 要求模板**整个**装进 ROI，
   *   差 6 像素就永远匹配不上，表现为「面板明明开着却判定没打开」。离线回放实测到过。
   */
  titleRoi: { x: 880, y: 8, w: 700, h: 124 } as Rect,
  /** 表头队列图标搜索区。 */
  queueIconRoi: { x: 2020, y: 14, w: 340, h: 100 } as Rect,
  /**
   * 队列「N/M」数字 ROI：相对 tpl_queue_icon_panel **命中框左上角**（模板 bounds x=2134）。
   * 真机实测图标 2139..2181、数字墨迹 2188..2245 / y 42..80，右边 2330+ 是「i」按钮，别框进去。
   */
  queueDigitRoiRelIcon: { x: 46, y: -2, w: 82, h: 54 } as Rect,

  /** 第 1 行的中心 y。 */
  firstRowCenterY: 248,
  /** 行距（真机复量 250；旧值 243 来自缩放图）。 */
  /** ★ 实测 242~244，不是 250：按 250 算第 4/5 行会漂出识别带（调度器侧已改为扫描真实行中心）。 */
  rowPitchY: 243,
  /** 面板最多显示几行。 */
  maxRows: 5,

  /** 每行里「状态词 + 倒计时」所在的横向范围。 */
  statusBandX: 1400,
  statusBandW: 620,
  /** 每行里「坐标:」所在的横向范围。 */
  coordBandX: 1080,
  coordBandW: 400,
  /** 每行里指挥官耐力（水滴图标 + N/M）所在的横向范围。 */
  staminaBandX: 1960,
  staminaBandW: 420
} as const

/** 第 i 行（1 起）的整行纵向带。用整行带而不是紧偏移：同一行里每个模板只会出现一次，反而更稳。 */
export function rowBand(i: number): { y: number; h: number } {
  const centerY = TROOP_PANEL.firstRowCenterY + (i - 1) * TROOP_PANEL.rowPitchY
  return { y: centerY - 130, h: TROOP_PANEL.rowPitchY }
}

/** 状态倒计时 ROI：紧贴状态词命中框右侧。两类行（深字浅底 / 白字进度条）都适用。 */
export function timerRoiRightOf(hit: { x: number; y: number; w: number; h: number }): Rect {
  return { x: hit.x + hit.w - 6, y: hit.y - 10, w: 195, h: hit.h + 20 }
}

/**
 * 坐标值 ROI：紧贴「坐标:」命中框右侧。资源点卡片与部队管理行内共用一套公式。
 * ★ 高度卡死 44（而不是跟着命中框高度走）：坐标行上下都有能给逗号字形 0.6~0.76 虚假峰的装饰，
 *   窗口一高就会混进假峰；44 刚好只装得下 34 高的字形。离线回放实测过。
 */
export function coordRoiRightOf(hit: { x: number; y: number; w: number; h: number }): Rect {
  return { x: hit.x + hit.w - 6, y: hit.y - 4, w: 176, h: 44 }
}

/** 指挥官耐力数值 ROI：紧贴水滴图标右侧（实测图标 2042.. / 数字 2102..2219）。 */
export function staminaRoiRightOf(hit: { x: number; y: number; w: number; h: number }): Rect {
  return { x: hit.x + hit.w, y: hit.y + 2, w: 180, h: hit.h + 6 }
}

/** 把「相对锚点的偏移」换成绝对参考坐标。 */
export function offsetPoint(anchor: Point, off: Offset): Point {
  return { x: Math.round(anchor.x + off.x), y: Math.round(anchor.y + off.y) }
}

/** 把「相对锚点的矩形偏移」换成绝对参考矩形。 */
export function offsetRect(anchor: Point, rect: Rect): Rect {
  return { x: Math.round(anchor.x + rect.x), y: Math.round(anchor.y + rect.y), w: rect.w, h: rect.h }
}

/**
 * 坐标读数的接受阈值。
 *
 * ★★ 必须比默认的 0.78 高很多。真机实测（2026-09-09）：`dig_card_coord` 字形集当时缺 0 和 4（2026-09-10 已从面板行补齐），
 *    缺字时逐字位 argmax **不会**输出 '?'，而是挑一个最像的现有字形顶上，
 *    于是读出来的是一个格式完全合法、值却是错的坐标（`607,560` → `697,566`，minScore 0.787），
 *    正则一点都拦不住。假坐标会污染「目标去重」和「每种资源占了几个队列」的配额记账，
 *    表现为同一个点被派两队、或者配额永远算不满而反复派兵。
 *    读对时的分数是 0.967~0.980，读错时是 0.787~0.789，0.90 能干净地把两者分开。
 *    ⇒ 宁可判成「读不出」（下游按未知处理，方向安全），也绝不接受一个假坐标。
 *    字形集已齐，但这个值先不动：假坐标污染记账的代价远大于偶尔读不出。
 */
export const COORD_MIN_SCORE = 0.9
