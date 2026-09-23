/**
 * G3~G7：搜索面板的打开、分类对账、等级上限探测、搜索下限设定、发起搜索。
 *
 * ★★ 这个面板会**随选中分类整体左右平移**（搜索按钮中心 x 实测 464/855/1269/1697/2115），
 *    所以除了底部分类栏那几个 tap 点，面板里的一切坐标都必须由 tpl_btn_search 的命中中心推出来。
 *    换分类之后必须**重新定位锚点**，拿旧锚点算出来的 [+]/[−] 会点到别的东西上。
 *
 * ★★ 「等级 N」标签也**随滑杆手柄移动**（伐木场面板 lv2..lv8 每级右移 55.3px）。
 *    读数字必须「先在整条滑杆行的宽带 ROI 里匹配 tpl_label_level，再取它右侧的窄条」，
 *    用相对搜索按钮的固定偏移开数字 ROI，等级调到 8 时会完全框空。
 */

import { AppError } from '../errors.js'
import type { Point } from '../../contracts.js'
import { parseLevel } from '../vision/digits.js'
import {
  computeSearchFloor,
  type GatherResourceType,
  type LevelPolicy,
  RESOURCE_LABEL
} from '../config.js'
import { relaxFloor } from './levelMemory.js'
import {
  CATEGORY_BAR_Y,
  CATEGORY_TAP_X,
  FIXED_TAP,
  LEVEL_DIGIT_ROI_REL_LABEL,
  SEARCH_ANCHOR_TOLERANCE,
  SEARCH_ANCHOR_X,
  SEARCH_PANEL,
  offsetPoint,
  offsetRect
} from './geometry.js'
import { ensureWorldMap } from './navigation.js'
import type { GatherSession } from './session.js'
import { GLYPH, TPL } from './templates.js'

/** 搜索按钮命中中心 = 整个面板的锚点。 */
export type SearchAnchor = Point

/** 重新定位搜索面板锚点。找不到返回 null。 */
export async function findSearchAnchor(s: GatherSession): Promise<SearchAnchor | null> {
  const m = await s.match(TPL.btnSearch, SEARCH_PANEL.anchorRoi)
  if (!m.found) return null
  return { x: m.centerX, y: m.centerY }
}

/** 重新定位锚点，带轮询等待。 */
export async function requireSearchAnchor(
  s: GatherSession,
  waitMs = 6000
): Promise<SearchAnchor> {
  const hit = await s.waitFor(TPL.btnSearch, {
    roi: SEARCH_PANEL.anchorRoi,
    waitMs,
    pollMs: 600
  })
  if (!hit) {
    await s.shot('search-anchor-lost')
    throw new AppError(
      'STEP_FAILED',
      '在搜索面板上找不到「搜索」按钮（tpl_btn_search）。' +
        '面板可能没打开，或者被别的弹窗盖住了。所有面板内坐标都靠它推算，找不到就无法继续。',
      { step: 'G3' }
    )
  }
  return { x: hit.match.centerX, y: hit.match.centerY }
}

/** G3：从世界地图打开搜索面板，返回锚点。 */
export async function openSearchPanel(s: GatherSession, maxAttempts = 3): Promise<SearchAnchor> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    s.ensureAlive()
    const already = await findSearchAnchor(s)
    if (already) return already

    await ensureWorldMap(s)
    await s.tapAt(FIXED_TAP.worldSearchIcon, 1200)
    const hit = await s.waitFor(TPL.btnSearch, {
      roi: SEARCH_PANEL.anchorRoi,
      waitMs: 8000,
      pollMs: 700
    })
    if (hit) return { x: hit.match.centerX, y: hit.match.centerY }
    s.log('warn', `搜索面板没打开（第 ${attempt}/${maxAttempts} 次），重试。`)
  }
  await s.shot('g3-search-panel-not-open')
  throw new AppError(
    'STEP_FAILED',
    `连点 ${maxAttempts} 次放大镜都没能打开搜索面板。请确认世界地图左下角放大镜的位置没变（实测 100,1112）。`,
    { step: 'G3' }
  )
}

/** 由锚点 x 反推当前选中的是哪个分类。差得太远返回 null。 */
export function classifyCategory(
  anchorX: number
): GatherResourceType | 'darkspirit' | null {
  let best: { key: GatherResourceType | 'darkspirit'; d: number } | null = null
  for (const [key, x] of Object.entries(SEARCH_ANCHOR_X)) {
    const d = Math.abs(anchorX - x)
    if (!best || d < best.d) best = { key: key as GatherResourceType | 'darkspirit', d }
  }
  if (!best || best.d > SEARCH_ANCHOR_TOLERANCE) return null
  return best.key
}

/**
 * G4：把分类切到目标资源（**对账式**：先判当前是什么，只在不一致时才点，点完复验）。
 * @returns 切换后的新锚点
 */
export async function selectCategory(
  s: GatherSession,
  target: GatherResourceType,
  anchor: SearchAnchor,
  maxAttempts = 3
): Promise<SearchAnchor> {
  let cur = anchor
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    s.ensureAlive()
    // tpl_auto_btn 只在「黑暗灵部队」页出现，是最硬的否定判据。
    const auto = await s.matchOptional(TPL.autoBtn, SEARCH_PANEL.anchorRoi)
    const onDarkSpirit = Boolean(auto?.found)
    const guessed = classifyCategory(cur.x)

    if (!onDarkSpirit && guessed === target) {
      s.log('debug', `分类已经是「${RESOURCE_LABEL[target].category}」（锚点 x=${cur.x}）。`)
      return cur
    }

    s.log(
      'info',
      `切换资源分类到「${RESOURCE_LABEL[target].category}」` +
        `（当前锚点 x=${cur.x}，推断为 ${onDarkSpirit ? '黑暗灵部队' : (guessed ?? '未知')}）。`
    )
    await s.tapAt({ x: CATEGORY_TAP_X[target], y: CATEGORY_BAR_Y }, 900)
    // ★ 面板已平移，锚点必须重新定位。
    cur = await requireSearchAnchor(s)
  }

  await s.shot('g4-category-mismatch')
  throw new AppError(
    'STEP_FAILED',
    `连点 ${maxAttempts} 次都没能把分类切到「${RESOURCE_LABEL[target].category}」` +
      `（搜索按钮锚点仍在 x=${cur.x}，期望 ${SEARCH_ANCHOR_X[target]}±${SEARCH_ANCHOR_TOLERANCE}）。` +
      '为避免无限点击，本轮中止。',
    { step: 'G4', target, anchorX: cur.x }
  )
}

/** 读滑杆当前的等级值。★必须先用模板定位「等级」标签，再取它右侧的数字。 */
export async function readSliderLevel(
  s: GatherSession,
  anchor: SearchAnchor,
  hardCap: number,
  tries = 3
): Promise<number | null> {
  return s.readNumberField<number>({
    field: '搜索面板等级',
    glyphSet: GLYPH.panelLevel,
    tries,
    resolveRoi: async () => {
      const band = offsetRect(anchor, SEARCH_PANEL.levelRowBandRoi)
      const label = await s.match(TPL.labelLevel, band)
      if (!label.found) return null
      const off = LEVEL_DIGIT_ROI_REL_LABEL
      return { x: label.x + off.x, y: label.y + off.y, w: off.w, h: off.h }
    },
    parse: (t) => parseLevel(t, hardCap)
  })
}

/**
 * G5：探测资源等级上限 —— 把滑杆推到最右再读数。
 *
 * 上限随游戏进程增长（实测当前 8，后期会到 10），所以不能写死；
 * 但它变化极慢，调用方应该按 probeIntervalMin 缓存结果。
 */
export async function probeMaxLevel(
  s: GatherSession,
  anchor: SearchAnchor,
  policy: LevelPolicy,
  maxRounds = 3
): Promise<{ maxLevel: number; probed: boolean }> {
  const assumed =
    policy.mode === 'relative' ? policy.assumedMaxLevel : policy.maxLevelHardCap
  const from = offsetPoint(anchor, SEARCH_PANEL.sliderLeft)
  // ★ 抬手点只能到 +230：再往右会落在 [+] 按钮上（实测 1513..1567），等于多点了一次加号。
  const to = offsetPoint(anchor, SEARCH_PANEL.sliderOvershootRight)

  let prev: number | null = null
  for (let round = 1; round <= maxRounds; round++) {
    s.ensureAlive()
    await s.swipe(from, to, 500, 600)
    const v = await readSliderLevel(s, anchor, policy.maxLevelHardCap, 2)
    if (v !== null && prev !== null && v === prev) {
      s.log('info', `探测到资源等级上限 = ${v}。`)
      return { maxLevel: v, probed: true }
    }
    prev = v
  }

  const fallback = prev ?? assumed
  s.warn(
    `等级上限探测不稳定（${maxRounds} 轮没有连续两次读到相同值），` +
      `退回使用 ${fallback}（配置里的 assumedMaxLevel=${assumed}）。`,
    { fallback, assumed }
  )
  return { maxLevel: fallback, probed: false }
}

/**
 * G6：把滑杆调到 searchFloor（**搜索下限**，不是目标等级）。
 *
 * 对账式：读当前值 -> 算差值 -> 只在不一致时点 -> 复验。多次点击合并成一次 adb shell。
 * 这里的 `== searchFloor` 判的是**滑杆设定值**，与「卡片等级必须 >= searchFloor」是两回事，别混。
 */
export async function setSearchFloor(
  s: GatherSession,
  anchor: SearchAnchor,
  searchFloor: number,
  hardCap: number,
  maxRounds = 3,
  maxTotalClicks = 12
): Promise<void> {
  const minus = offsetPoint(anchor, SEARCH_PANEL.levelMinus)
  const plus = offsetPoint(anchor, SEARCH_PANEL.levelPlus)
  let clicks = 0

  for (let round = 1; round <= maxRounds; round++) {
    s.ensureAlive()
    const cur = await readSliderLevel(s, anchor, hardCap, round === 1 ? 3 : 2)
    if (cur === null) {
      await s.shot('g6-level-unreadable')
      throw new AppError(
        'STEP_FAILED',
        '读不出搜索面板上的等级数字，无法确认搜索下限。滑杆值读不准就不该发起搜索，本轮中止。' +
          '（排查方向：tpl_label_level 是否命中、dig_panel_level 字形集是否齐全。）',
        { step: 'G6', searchFloor }
      )
    }
    if (cur === searchFloor) {
      s.log('debug', `搜索下限已是 ${searchFloor} 级。`)
      return
    }

    const diff = searchFloor - cur
    const need = Math.abs(diff)
    if (clicks + need > maxTotalClicks) {
      await s.shot('g6-too-many-clicks')
      throw new AppError(
        'STEP_FAILED',
        `调整搜索下限的点击次数超过上限（已点 ${clicks} 次，还需 ${need} 次，上限 ${maxTotalClicks}）。` +
          '多半是等级数字识别有误或 [+]/[−] 的位置算错了，为避免无限点击，本轮中止。',
        { step: 'G6', cur, searchFloor, clicks }
      )
    }
    s.log('info', `把搜索下限从 ${cur} 调到 ${searchFloor}（点${diff > 0 ? '[+]' : '[−]'} ${need} 次）。`)
    await s.tapRepeat(diff > 0 ? plus : minus, need, 120, 700)
    clicks += need
  }

  await s.shot('g6-floor-not-set')
  throw new AppError(
    'STEP_FAILED',
    `反复调整后搜索下限仍不等于 ${searchFloor}，本轮中止（避免无限点击）。`,
    { step: 'G6', searchFloor, clicks }
  )
}

/** G7：点搜索。★重新匹配锚点再点，因为面板可能刚平移过。 */
export async function tapSearch(s: GatherSession, anchor: SearchAnchor): Promise<void> {
  const fresh = (await findSearchAnchor(s)) ?? anchor
  await s.tapAt(fresh, s.config.searchRetry.researchDelayMs)
}

/**
 * 由「上限 + 策略」算本轮的搜索下限。放在这里是为了和 G5/G6 放在一起看。
 * ★ 返回的是下限：游戏会返回等级 >= 它的点。
 */
export function initialSearchFloor(policy: LevelPolicy, maxLevel: number): number {
  return computeSearchFloor(policy, maxLevel)
}

/**
 * 放宽下限（搜不到可用点时）。实现搬到了 levelMemory.ts（与「搜不到 / 点不合适」的状态机放在一起），
 * 这里保留同名导出给旧调用方（离线干跑脚本）。
 * ★ 语义是「放宽下限以匹配更多候选点」，**不是**「退而求其次采低级点」——
 *   放宽后游戏仍然会优先返回高等级的点。
 * @returns 新的下限；已经放宽到底（或策略不允许放宽）时返回 null
 */
export function relaxSearchFloor(
  policy: LevelPolicy,
  current: number,
  step: number
): number | null {
  return relaxFloor(policy, current, step)
}
