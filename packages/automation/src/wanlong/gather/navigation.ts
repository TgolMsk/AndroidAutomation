/**
 * G0：把游戏拉回「世界地图」这个已知状态，以及关闭各种面板的通用手法。
 *
 * ★ 世界地图上按 BACK 会弹「确定要退出游戏吗」，误点确定就直接退出游戏了。
 *   所以关面板一律优先「点面板外的空地」或「点左上角返回箭头」，
 *   只有在确实认不出当前界面时才盲按一次 BACK，并且**紧接着必须检查并取消退出确认框**。
 */

import { DEFAULT_SHRINK } from '../constants.js'
import { AppError } from '../errors.js'
import type { Point, PreparedTemplate, RawFrame, Rect } from '../../contracts.js'
import { matchIn, prepareFrame } from '../../vision.js'
import {
  CARD,
  FIXED_TAP,
  GAME_PACKAGE,
  POPUP_CLOSE_ROI,
  SEARCH_PANEL,
  offsetPoint
} from './geometry.js'
import type { GatherSession } from './session.js'
import { TPL, type GatherTemplates } from './templates.js'

/** 「取消」按钮的兜底坐标（模板缺失时用）。实测按钮墨迹 1488..1608 / 940..1000。 */
const CANCEL_FALLBACK: Point = { x: 1548, y: 970 }
/** 创建部队页左上角返回箭头的兜底坐标。 */
const BACK_ARROW_FALLBACK: Point = { x: 55, y: 68 }
/**
 * 拉起游戏后等它回到世界地图的最长时间。
 * 热启动 3~5s，被系统回收过十几秒；**模拟器刚开机的冷启动实测 90s 以上**（MuMu 6.6.4，2026-09-15），
 * 所以按最慢的给。等不到会落到下面的兜底阶梯，不会直接判死。
 */
const GAME_LAUNCH_WAIT_MS = 150_000

/**
 * 如果屏幕上是「注意 / 确定要退出游戏吗」这类确认框，点「取消」把它关掉。
 * @returns 是否处理了一个对话框
 */
export async function dismissNoticeDialog(s: GatherSession): Promise<boolean> {
  const notice = await s.matchOptional(TPL.dlgTitleNotice)
  if (!notice || !notice.found) return false

  s.log('warn', '检测到确认框（多半是刚才那次 BACK 触发的「退出游戏」提示），点「取消」关闭。')
  const cancel = await s.matchOptional(TPL.btnCancel)
  const at = cancel && cancel.found ? { x: cancel.centerX, y: cancel.centerY } : CANCEL_FALLBACK
  // ★ 绝不点「确定」：那会退出游戏。
  await s.tapAt(at, 900)
  return true
}

/**
 * 模板集里所有「弹窗关闭按钮」模板的 id：手裁的 tpl_btn_close_popup，以及 AI 顾问自学的
 * tpl_btn_close_popup_ai2 / _ai3 …（src/main/ai/harvest.ts）。不同活动弹窗的 × 长得不一样，按前缀全收。
 */
export function closePopupTemplateIds(templates: GatherTemplates): string[] {
  return [...templates.ui.keys()].filter(
    (id) => id === TPL.btnClosePopup || id.startsWith(`${TPL.btnClosePopup}_`)
  )
}

export function closePopupTemplates(templates: GatherTemplates): PreparedTemplate[] {
  return closePopupTemplateIds(templates)
    .map((id) => templates.get(id))
    .filter((t): t is PreparedTemplate => Boolean(t))
}

/** 矩形 a 是否完全落在 b 里。 */
function rectInside(a: Rect, b: Rect): boolean {
  return a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h
}

/**
 * 活动弹窗（带「前往」和右上角 ×）盖住主界面时，点 × 关掉它。
 * 每张关闭模板先在右上半屏找（绝大多数弹窗的 × 在那里），没找到再按它自己的 defaultRoi 找一遍
 * （AI 自学的模板会记住那个弹窗的 × 在哪，可能不在右上半屏）。都没命中返回 false（由调用方退回盲按 BACK）。
 */
export async function dismissPopupByClose(s: GatherSession): Promise<boolean> {
  for (const id of closePopupTemplateIds(s.templates)) {
    const tpl = s.templates.get(id)
    let x = await s.matchOptional(id, POPUP_CLOSE_ROI)
    if ((!x || !x.found) && tpl?.defaultRoi && !rectInside(tpl.defaultRoi, POPUP_CLOSE_ROI)) {
      x = await s.matchOptional(id, tpl.defaultRoi)
    }
    if (!x || !x.found) continue
    s.log('info', `找到弹窗关闭按钮（${id} ${x.score}），点它关掉活动弹窗。`)
    await s.tapAt({ x: x.centerX, y: x.centerY }, 900)
    return true
  }
  return false
}

/** 关掉资源点卡片：点卡片外的空地（比 BACK 安全）。 */
export async function closeResourceCard(s: GatherSession): Promise<void> {
  const gather = await s.matchOptional(TPL.btnGather, CARD.anchorRoi)
  if (gather && gather.found) {
    const outside = offsetPoint({ x: gather.centerX, y: gather.centerY }, CARD.closeByTapOutside)
    await s.tapAt(clampToScreen(s, outside), 700)
    return
  }
  await s.tapAt(FIXED_TAP.emptyArea, 700)
}

/** 关掉「部队管理」面板：这是个二级面板，BACK 能关，关完确认已回到世界地图。 */
export async function closeTroopPanel(s: GatherSession): Promise<void> {
  const title = await s.matchOptional(TPL.panelTitleTroop, undefined)
  if (!title || !title.found) return
  await s.key('BACK', 800)
  await dismissNoticeDialog(s)
}

/**
 * 关掉搜索面板（开着就按一次 BACK）。
 *
 * ★ 2026-09-18 加：本轮失败时如果不关它，游戏就**停在搜索页**不动了 ——
 *   用户看到的是「卡在搜索页面」，其实每 5 分钟都在退避重试，只是界面没退回去。
 *   下一轮的 G0 虽然能把界面拉回世界地图，但中间这几分钟里游戏挂在子页面上，
 *   人看一眼根本不知道发生了什么。收尾动作失败无所谓，吞掉即可。
 */
export async function closeSearchPanel(s: GatherSession): Promise<void> {
  const btn = await s.matchOptional(TPL.btnSearch, SEARCH_PANEL.anchorRoi)
  if (!btn || !btn.found) return
  await s.key('BACK', 800)
  await dismissNoticeDialog(s)
}

/** 从「创建部队」页退回去（左上角返回箭头）。 */
export async function leaveCreateTroopPage(s: GatherSession): Promise<void> {
  const back = await s.matchOptional(TPL.btnBackGeneric)
  const at = back && back.found ? { x: back.centerX, y: back.centerY } : BACK_ARROW_FALLBACK
  await s.tapAt(at, 900)
}

/**
 * 「当前是不是世界地图」的判据模板集合（anyTemplate）。
 *
 * ★★ 真机实测纠正（2026-09-09）：**不能只用放大镜**。
 *    `tpl_world_search_icon` 的镜片是**半透明**的，透出来的是它底下的地图地形，
 *    所以同一个图标在不同地形上分数会大幅漂移：草地上 0.981，图标底下压着一座伐木场时只有 0.794
 *    （峰值位置仍是精确的 (95,1109)，位置没错、只是相似度被地形拉低了）。
 *    症状极其难查：流程会在一块「明明就是世界地图」的画面上连按 6 次 BACK，
 *    每按一次弹一个「确定要退出游戏吗」，靠 dismissNoticeDialog 一次次取消，最后报 G0 失败。
 *    留痕证据：docs/live/003-g0-unknown-2.jpg ~ 007-g0-unknown-6.jpg（全是干净的世界地图）。
 *
 *    `tpl_nav_city_toggle`（左下角回城的城堡按钮）是**不透明**的，同一批帧上稳定 0.985~0.987，
 *    而且它只在世界地图出现（城内是 tpl_nav_map_toggle），判别力一样强。
 *    两张组成 anyTemplate 之后，地形再怎么变也至少有一张顶得住。
 */
export const WORLD_MAP_TEMPLATES = [TPL.navCityToggle, TPL.navCityToggleB, TPL.worldSearchIcon]

/**
 * 「当前是不是城内」的判据模板集合（anyTemplate）。
 *
 * ★ 阵营变体（2026-09-10）：游戏有三套 UI 美术 —— 法师（变体 A）、兽族（变体 B）、
 *   精灵（暂不适配）。城内左下角的「切世界地图」按钮两套阵营长得完全不一样，只认 A 的话
 *   兽族号一进城内就「认不出界面」，采样连续失败。B 是透明底模板（圆环里透着会变的地形）。
 *   ⚠️ 以后每接一个新阵营的号，这里和 WORLD_MAP_TEMPLATES 都要补一张变体。
 */
export const CITY_TEMPLATES = [TPL.navMapToggle, TPL.navMapToggleB]

/**
 * 「这一帧是不是流程认识的界面」的判据集合：世界地图 / 城内 / 部队管理面板 / 搜索面板 / 资源点卡片 / 创建部队页。
 * AI 顾问点掉弹窗之后用它复验 —— 只有回到这些界面之一，才承认那次点击有效、才允许自学模板。
 */
export const KNOWN_SCREEN_TEMPLATES: readonly string[] = [
  ...WORLD_MAP_TEMPLATES,
  ...CITY_TEMPLATES,
  TPL.panelTitleTroop,
  TPL.btnSearch,
  TPL.btnGather,
  TPL.titleCreateTroop
]

/** 用模板判断一帧是不是已知界面。纯计算，不碰设备。 */
export async function isRecognizableScreen(
  templates: GatherTemplates,
  raw: RawFrame,
  opts: { refWidth: number; refHeight: number; shrink?: number }
): Promise<boolean> {
  const shrink = opts.shrink ?? DEFAULT_SHRINK
  const frame = await prepareFrame(raw, { refW: opts.refWidth, refH: opts.refHeight, shrink })
  for (const id of KNOWN_SCREEN_TEMPLATES) {
    const tpl = templates.get(id)
    if (!tpl || tpl.shrink !== shrink) continue
    const m = await matchIn(frame, tpl, { roi: tpl.defaultRoi })
    if (m.found) return true
  }
  return false
}

/**
 * G0：确保游戏在前台，且当前处于世界地图。
 *
 * @throws AppError 尝试若干次仍回不到世界地图
 */
export async function ensureWorldMap(s: GatherSession, maxAttempts = 6): Promise<void> {
  // ① 前台包名。不是游戏就拉起来（热启动，不 force-stop 用户正在用的游戏）。
  const fg = await s.io.foregroundPackage()
  if (fg !== GAME_PACKAGE) {
    s.log('info', `当前前台是「${fg ?? '未知'}」，不是万龙觉醒，正在拉起游戏……`)
    // ★ 优先走 ensureGameForeground（内部用 monkey 并等到前台）。
    //   直接用 launchApp 等于 `am start`：对本游戏返回成功但进程根本起不来，
    //   模拟器刚开机时会在下面白等一分钟再判失败（2026-09-15 真机踩到）。
    if (s.io.ensureGameForeground) await s.io.ensureGameForeground(GAME_PACKAGE)
    else await s.io.launchApp(GAME_PACKAGE, false)
    s.invalidate()
    // ★ 等的是「**游戏加载完了**」，判据有两类，命中任一就往下走：
    //     ① 任一已知界面（世界地图 / 城内 / 面板 / 卡片…）
    //     ② 活动弹窗的关闭 ×  —— 它出现就说明主界面已经加载出来了，只是被盖住
    //   只等世界地图是不够的：冷启动后游戏多半加载进的是**城内**，而且常压着一张全屏活动弹窗，
    //   两种情况都会白白等满超时（2026-09-15 真机实测，为此多花了 60s）。
    //   命中之后交给下面的兜底阶梯 —— 关弹窗、从城内切地图都是它的活。
    const loadedSignals = [
      ...KNOWN_SCREEN_TEMPLATES,
      ...closePopupTemplates(s.templates).map((t) => t.id)
    ]
    const known = await s.waitFor(loadedSignals, {
      waitMs: GAME_LAUNCH_WAIT_MS,
      pollMs: 2500
    })
    s.log(
      known ? 'info' : 'warn',
      known
        ? '游戏已经加载出已知界面，继续回到世界地图。'
        : `等了 ${Math.round(GAME_LAUNCH_WAIT_MS / 1000)}s 仍然认不出界面，交给下面的兜底阶梯。`
    )
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    s.ensureAlive()
    s.invalidate()

    // 已经在世界地图。
    // ★ 注意：资源点卡片只是压在地图上的气泡，这两个判据仍然可见（离线回放实测 12 帧都是如此），
    //   所以这里还要顺手把残留的卡片关掉，否则「回到世界地图」只是看起来干净。
    const hit = await s.bestOf(WORLD_MAP_TEMPLATES)
    const map = hit?.match
    if (map && map.found) {
      const leftover = await s.matchOptional(TPL.btnGather, CARD.anchorRoi)
      if (leftover && leftover.found) {
        s.log('debug', '世界地图上还压着一张资源点卡片，先关掉。')
        await closeResourceCard(s)
        continue
      }
      s.log('debug', `已处于世界地图（${hit?.id} 命中 ${map.score}）。`)
      return
    }

    // 弹窗优先处理，否则下面任何点击都会被它吃掉。
    if (await dismissNoticeDialog(s)) continue

    // 搜索面板开着（它会盖住左下角的放大镜）。这是二级面板，BACK 能关，不会触发退出确认框。
    const searchPanel = await s.matchOptional(TPL.btnSearch)
    if (searchPanel && searchPanel.found) {
      s.log('debug', '当前是搜索面板，按 BACK 关闭。')
      await s.key('BACK', 800)
      await dismissNoticeDialog(s)
      continue
    }

    // 部队管理面板开着。
    const troop = await s.matchOptional(TPL.panelTitleTroop, undefined)
    if (troop && troop.found) {
      s.log('debug', '当前是部队管理面板，按 BACK 关闭。')
      await s.key('BACK', 800)
      await dismissNoticeDialog(s)
      continue
    }

    // 创建部队页。
    const createPage = await s.matchOptional(TPL.titleCreateTroop)
    if (createPage && createPage.found) {
      s.log('debug', '当前是创建部队页，点左上角返回。')
      await leaveCreateTroopPage(s)
      continue
    }

    // 资源点卡片开着（地图上的气泡）。
    const card = await s.matchOptional(TPL.btnGather, CARD.anchorRoi)
    if (card && card.found) {
      s.log('debug', '当前有资源点卡片，点卡片外空地关闭。')
      await closeResourceCard(s)
      continue
    }

    // 在城内 —— 点地图按钮切到世界地图（按钮按阵营各一张，anyTemplate）。
    const city = await s.bestOf(CITY_TEMPLATES)
    if (city && city.match.found) {
      s.log('info', `当前在城内（${city.id} 命中 ${city.match.score}），切到世界地图。`)
      await s.tapAt(FIXED_TAP.cityToMap, 2500)
      continue
    }

    // 认不出来了。先看右上角有没有活动弹窗的 ×（有就点它，比 BACK 精准）。
    if (await dismissPopupByClose(s)) continue

    // 再问 AI 顾问（若启用）：它只会执行「点关闭 / 点取消」并自行复验、自学模板；
    // 「按返回」「不动」这类建议它不执行，交回下面的 BACK 阶梯（安全逻辑只写一份）。
    if (s.advisor) {
      const f = await s.frame()
      let handled = false
      try {
        handled = await s.advisor.handleUnknownScreen({
          checkAlive: () => s.ensureAlive(),
          instanceIndex: s.instanceIndex,
          raw: f.raw,
          attempt,
          io: s.io,
          setId: s.templates.setId,
          refWidth: s.refWidth,
          refHeight: s.refHeight,
          recognize: (raw) =>
            isRecognizableScreen(s.templates, raw, {
              refWidth: s.refWidth,
              refHeight: s.refHeight,
              shrink: s.shrink
            }),
          existingCloseTemplates: closePopupTemplates(s.templates),
          log: (level, message, data) => s.log(level, message, data)
        })
      } catch (e) {
        if (['GAME_UPDATE_REQUIRED', 'AI_RISK_BLOCKED'].includes(AppError.from(e).code)) throw e
        s.ensureAlive()
        s.log('warn', `AI 顾问出错，按未处理继续：${e instanceof Error ? e.message : String(e)}`)
      }
      s.invalidate()
      if (handled) {
        s.log('info', 'AI 顾问处理了认不出的界面，重新判断。')
        continue
      }
    }

    // 再盲按一次 BACK，然后**必须**检查退出确认框。
    s.log('warn', `认不出当前界面（第 ${attempt}/${maxAttempts} 次），按一次 BACK 试探。`)
    await s.shot(`g0-unknown-${attempt}`)
    await s.key('BACK', 1200)
    await dismissNoticeDialog(s)
  }

  await s.shot('g0-failed')
  throw new AppError(
    'STEP_FAILED',
    `尝试 ${maxAttempts} 次仍无法回到世界地图（${WORLD_MAP_TEMPLATES.join(' / ')} 都始终不命中）。` +
      '请手动把游戏切到世界地图，或检查这几张模板是否仍然有效；' +
      '若这是一个新阵营的账号（精灵等），需要补裁城内 / 世界地图两态按钮的变体模板。' +
      '（★ 放大镜的镜片是半透明的，分数会随镜片底下的地形漂移，所以它一张顶不住；' +
      '真出问题时优先看不透明的 tpl_nav_city_toggle。）',
    { step: 'G0' }
  )
}

/** 把点夹进画面内，避免点到屏幕外（关卡片时相对偏移可能算出负值）。 */
function clampToScreen(s: GatherSession, p: Point): Point {
  return {
    x: Math.min(s.refWidth - 10, Math.max(10, Math.round(p.x))),
    y: Math.min(s.refHeight - 10, Math.max(10, Math.round(p.y)))
  }
}
