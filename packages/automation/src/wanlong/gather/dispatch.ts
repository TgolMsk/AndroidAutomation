/**
 * G10~G14：采集 -> 创建部队 -> 一键采集编成 -> 读行军耗时 -> 行军。
 *
 * ★ travelTime（单程行军秒数）是整个 ETA 调度的关键输入：
 *   队列真正释放的时刻 freeAt = 采集完成时刻 + 回程行军时间，
 *   而回程时间只有在派兵这一刻能从「行军」按钮上直接读到（实测显示 00:01:04）。
 *   一旦离开这个页面就再也读不到了，所以必须在这里读、并随本次派兵一起记账。
 *
 * ★ 行军耗时是**金底白字**（早期文档写成「金底黑字」是错的）。TM_CCOEFF_NORMED 跨极性
 *   会给出强负相关，黑字模板打白字一个都匹配不上 —— 必须用 dig_march_btn 这套白字字形。
 */

import type { MatchResult, Point } from '../../contracts.js'
import { parseGrouped, parseGroupedRatio } from '../vision/digits.js'
import type { GatherConfig, ResourceEntry } from '../config.js'
import { effectiveMaxTravelSeconds } from '../config.js'
import { CARD, CREATE_TROOP, VALUE_RIGHT_OF_LABEL } from './geometry.js'
import { closeResourceCard, leaveCreateTroopPage } from './navigation.js'
import { parseHmsFlexible } from './parse.js'
import type { GatherSession } from './session.js'
import { GLYPH, TPL } from './templates.js'

/** 锚点漂移超过这么多像素就记一句日志。小于它是匹配噪声，不值得刷屏。 */
const CARD_ANCHOR_DRIFT_LOG_PX = 8

export type DispatchResult =
  | {
      ok: true
      travelTimeSec: number | null
      troops: number | null
      load: number | null
    }
  | {
      ok: false
      /** retrySearch = 换个点重搜；abort = 中止本轮 */
      kind: 'retrySearch' | 'abort'
      reason: string
    }

/**
 * 从「资源点卡片」一路点到「行军」。
 *
 * @param cardAnchor G8 读卡片时的采集按钮命中中心。**只用来比对漂移**，
 *                   真正点的位置每次点前重新匹配（见 refindGather）。
 * @param cardStorage 卡片上的储量，preferLoadCoversStorage 校验用
 */
export async function dispatchTroop(
  s: GatherSession,
  cardAnchor: Point,
  cfg: GatherConfig,
  entry: ResourceEntry,
  cardStorage: number | null
): Promise<DispatchResult> {
  // ── G10：点采集 ────────────────────────────────────────────────────────
  // ★ 点之前重新定位一次，不用 cardAnchor 盲点。
  //   cardAnchor 是 G8 那一刻的命中中心，中间还隔着 readCard 与 G9 的对账（可能点过勾选框），
  //   卡片若当时还在滑入、或已经被关掉，那个坐标就是错的 —— 点空之后只能靠 6 秒超时兜底，
  //   还会白吃一格 occupiedRetryLimit。搜索按钮（findSearchAnchor）与行军按钮（refindMarch）
  //   本来就是点前重新匹配的，这里补齐，也与契约 gather-flow.json 的 G10「tapTemplate」一致。
  const gatherBtn = await refindGather(s)
  if (gatherBtn) {
    // 顺手把「锚点漂了多少」记下来：这正是「卡片还在动就把坐标锁死」那个竞态的直接证据，
    // 真机日志里能看到它到底有没有发生、漂了多少像素。不漂就一个字都不打。
    const drift = Math.max(
      Math.abs(gatherBtn.centerX - cardAnchor.x),
      Math.abs(gatherBtn.centerY - cardAnchor.y)
    )
    if (drift > CARD_ANCHOR_DRIFT_LOG_PX) {
      s.log(
        'warn',
        `「采集」按钮比读卡片时挪了 ${Math.round(drift)}px（卡片当时多半还在滑入），已按新位置点。`
      )
    }
  }
  if (!gatherBtn) {
    await s.shot('g10-gather-lost')
    await closeResourceCard(s)
    return {
      ok: false,
      kind: 'retrySearch',
      reason:
        '准备点「采集」时按钮已经不在原位：卡片可能还在动、或者被别的弹窗盖住 / 自己关掉了。' +
        '这一下没有点出去（以前会盲点一次再等 6 秒超时），换个点重搜。'
    }
  }
  await s.tapAt({ x: gatherBtn.centerX, y: gatherBtn.centerY }, 800)
  const createBtn = await s.waitFor(TPL.btnCreateTroop, { waitMs: 6000, pollMs: 700 })
  if (!createBtn) {
    await s.shot('g10-no-create-troop')
    // 按钮确实点到了（点之前刚匹配过），所以这里是**点下去之后**游戏没给创建部队页：
    // 常见原因是弹了「队列已满」「体力不足」这类提示（对应的模板还没裁，只能靠超时兜底）。
    await closeResourceCard(s)
    return {
      ok: false,
      kind: 'retrySearch',
      reason:
        '「采集」点下去了，但 6 秒内没出现「创建部队」按钮。多半是弹了「队列已满 / 体力不足 / ' +
        '无可用部队」之类的提示（这几个提示的模板尚未采集，无法分辨具体是哪一个，已留痕）。'
    }
  }

  // ── G11：进创建部队页 ──────────────────────────────────────────────────
  await s.tapAt({ x: createBtn.match.centerX, y: createBtn.match.centerY }, 1200)
  const march = await s.waitFor(TPL.btnMarch, {
    roi: CREATE_TROOP.anchorRoi,
    waitMs: 8000,
    pollMs: 700
  })
  if (!march) {
    await s.shot('g11-no-create-page')
    await leaveCreateTroopPage(s)
    await closeResourceCard(s)
    return {
      ok: false,
      kind: 'retrySearch',
      reason: '点「创建部队」之后没进到创建部队页（找不到金色「行军」按钮），换一个点重试。'
    }
  }

  // ── G12：一键采集编成 ──────────────────────────────────────────────────
  await tapGatherPreset(s)

  // ── G13：读行军耗时 / 兵力 / 负载量 ────────────────────────────────────
  const travelTimeSec = await readTravelTime(s)
  let troopsPair = await readTroops(s)

  if (troopsPair && troopsPair[0] === 0) {
    // 编成没成功，再点一次预设。
    s.log('warn', '编成后兵力为 0，再点一次「采集」一键编成。')
    await tapGatherPreset(s)
    troopsPair = await readTroops(s)
  }
  if (troopsPair && troopsPair[0] === 0) {
    await s.shot('g13-no-troops')
    await leaveCreateTroopPage(s)
    await closeResourceCard(s)
    return {
      ok: false,
      kind: 'abort',
      reason: '一键编成后兵力仍为 0：当前没有可用部队（可能全部在外或伤兵未治疗），本轮中止。'
    }
  }

  const maxTravel = effectiveMaxTravelSeconds(cfg, entry)
  if (travelTimeSec === null) {
    s.warn(
      '读不出行军按钮上的行军耗时，本次派兵的 freeAt 只能用保守估计值' +
        `（safety.unknownEtaFallbackSeconds / 6 = ${Math.round(cfg.safety.unknownEtaFallbackSeconds / 6)} 秒）。` +
        '同时意味着「最长单程行军」这条阈值本次无法生效。' +
        '（已知原因：dig_march_btn 字形集缺 3/4/6/7/8，等补齐后即可恢复。）'
    )
  } else if (maxTravel > 0 && travelTimeSec > maxTravel) {
    await leaveCreateTroopPage(s)
    await closeResourceCard(s)
    return {
      ok: false,
      kind: 'retrySearch',
      reason: `单程行军 ${travelTimeSec} 秒超过上限 ${maxTravel} 秒，目标太远，换一个点。`
    }
  }

  const load = await readLoad(s)
  if (cfg.thresholds.preferLoadCoversStorage && load !== null && cardStorage !== null) {
    if (load < cardStorage) {
      await leaveCreateTroopPage(s)
      await closeResourceCard(s)
      return {
        ok: false,
        kind: 'retrySearch',
        reason:
          `负载量 ${load.toLocaleString('zh-CN')} 小于该点储量 ${cardStorage.toLocaleString('zh-CN')}，` +
          '按「优先一趟采空」策略换一个更小的点。'
      }
    }
  }

  // ── G14：行军 ──────────────────────────────────────────────────────────
  //
  // ★★ 真机实测（2026-09-09）：这里**必须**允许重点一次，原因见 tapGatherPreset 的注释 ——
  //    上一步点「采集」打开的是一个**编成模式下拉菜单**，菜单是模态的，
  //    会把接下来的第一次点击整个吃掉（只用来关菜单），行军按钮根本收不到。
  //    症状是「日志说点了行军、画面却还停在创建部队页、队列一点没涨」。
  //    这里按「点完复验：行军按钮还在 ⇒ 上一次点击被吞了 ⇒ 再点一次」处理。
  //    ★ 复验是硬前置：只有**确认按钮已经消失**才会再点，所以绝不会派出两支队。
  const MARCH_ATTEMPTS = 3
  for (let attempt = 1; attempt <= MARCH_ATTEMPTS; attempt++) {
    const marchNow = await refindMarch(s)
    if (!marchNow) {
      if (attempt === 1) {
        await s.shot('g14-march-lost')
        await leaveCreateTroopPage(s)
        await closeResourceCard(s)
        return { ok: false, kind: 'abort', reason: '准备点「行军」时按钮不见了，本轮中止。' }
      }
      // 按钮消失 = 页面已经跳走 = 上一次点击生效了。
      s.log('info', `行军已生效（第 ${attempt - 1} 次点击后创建部队页已退出）。`)
      return {
        ok: true,
        travelTimeSec,
        troops: troopsPair ? troopsPair[0] : null,
        load
      }
    }

    const tapAt: Point = {
      x: marchNow.x + CREATE_TROOP.marchTap.x,
      y: marchNow.y + CREATE_TROOP.marchTap.y
    }
    s.log(
      'info',
      `派兵：点行军（第 ${attempt}/${MARCH_ATTEMPTS} 次，单程 ` +
        `${travelTimeSec === null ? '未知' : `${travelTimeSec} 秒`}），` +
        `按钮命中框 (${marchNow.x},${marchNow.y}) ${marchNow.w}x${marchNow.h} 分数 ${marchNow.score}，` +
        `点击点 (${Math.round(tapAt.x)},${Math.round(tapAt.y)})。`
    )
    // ★ 这是整条链路上唯一「花掉体力」的一次点击，第一次点击前后各留一帧痕：
    //   出了问题（点空 / 被菜单吞掉 / 弹二次确认框）时，没有这两帧根本无从判断是哪一种。
    if (attempt === 1) await s.shot('g14-before-march')
    await s.tapAt(tapAt, 1500)
    if (attempt === 1) {
      await s.frame(true)
      await s.shot('g14-after-march')
    }
  }

  // 连点 MARCH_ATTEMPTS 次行军按钮仍在原地 —— 不是被菜单吞了，是真的点不动。
  await s.shot('g14-march-stuck')
  await leaveCreateTroopPage(s)
  await closeResourceCard(s)
  return {
    ok: false,
    kind: 'retrySearch',
    reason:
      `连点 ${MARCH_ATTEMPTS} 次「行军」后仍停在创建部队页（按钮还在原位），本次派兵没生效。` +
      '可能是弹了未知的二次确认框，或该目标当下不可派兵。已留痕 g14-march-stuck，换一个点重试。'
  }
}

/**
 * 点「采集」一键编成。找不到按钮只告警不失败（有的编队槽可能已经预设好了，由兵力校验兜底）。
 *
 * ★★ 真机实测纠正（2026-09-09）：这个按钮**不是**「点一下就编好」的一键按钮，
 *    它是「部队增益 | 采集 | 最大」那一行里的**编成模式下拉框**。点它会向上弹出一个
 *    2x3 的模式菜单（打野 / 野战 / 攻城 / 驻防 / 工程 / 采集），当前模式带白色描边。
 *    这个菜单是**模态**的：它开着的时候，下一次点击不管落在哪，都只会被用来关菜单。
 *    留痕证据：docs/live/001-g14-before-march.jpg（菜单开着、采集已选中）与
 *              docs/live/002-g14-after-march.jpg（点了行军按钮，结果只是菜单没了、页面没动）。
 *    ⇒ 所以 G14 必须做「点完复验、按钮还在就再点一次」，见上面的 MARCH_ATTEMPTS 循环。
 */
async function tapGatherPreset(s: GatherSession): Promise<void> {
  const preset = await s.matchOptional(TPL.btnPresetGather, CREATE_TROOP.presetGatherRoi)
  if (!preset || !preset.found) {
    s.warn('找不到「采集」一键编成按钮，跳过编成（后面会用兵力 > 0 兜底校验）。')
    return
  }
  await s.tapAt({ x: preset.centerX, y: preset.centerY }, 800)
}

/**
 * 重新定位「采集」按钮。
 * ★ 必须显式 invalidate：G9 若没点勾选框，当前帧还是 G8 命中的那一张（frame() 默认复用），
 *   不换帧就等于拿旧帧再匹配一遍，白做。
 */
async function refindGather(s: GatherSession): Promise<MatchResult | null> {
  s.invalidate()
  const m = await s.match(TPL.btnGather, CARD.anchorRoi)
  return m.found ? m : null
}

/** 重新定位行军按钮（前面的点击会让帧作废）。 */
async function refindMarch(s: GatherSession): Promise<MatchResult | null> {
  const m = await s.match(TPL.btnMarch, CREATE_TROOP.anchorRoi)
  return m.found ? m : null
}

/** 读行军按钮上的单程行军耗时。★ROI 相对行军按钮命中框，已排除左侧那个白色小鸟图标。 */
async function readTravelTime(s: GatherSession): Promise<number | null> {
  return s.readNumberField<number>({
    field: '单程行军耗时',
    glyphSet: GLYPH.marchBtn,
    tries: 3,
    resolveRoi: async () => {
      const m = await refindMarch(s)
      if (!m) return null
      const off = CREATE_TROOP.travelTimeRoi
      return { x: m.x + off.x, y: m.y + off.y, w: off.w, h: off.h }
    },
    parse: parseHmsFlexible
  })
}

/** 读「兵力 36,995/253,125」。 */
async function readTroops(s: GatherSession): Promise<[number, number] | null> {
  return s.readNumberField<[number, number]>({
    field: '编成兵力',
    glyphSet: GLYPH.dark20,
    tries: 2,
    resolveRoi: async () => {
      const label = await s.matchOptional(TPL.labelTroops)
      if (!label || !label.found) return null
      return {
        x: label.x + label.w + VALUE_RIGHT_OF_LABEL.dx,
        y: label.y + VALUE_RIGHT_OF_LABEL.dy,
        w: VALUE_RIGHT_OF_LABEL.w,
        h: VALUE_RIGHT_OF_LABEL.h
      }
    },
    parse: parseGroupedRatio
  })
}

/** 读「负载量 1,331,820」。 */
async function readLoad(s: GatherSession): Promise<number | null> {
  return s.readNumberField<number>({
    field: '负载量',
    glyphSet: GLYPH.dark20,
    tries: 1,
    resolveRoi: async () => {
      const label = await s.matchOptional(TPL.labelLoad)
      if (!label || !label.found) return null
      return {
        x: label.x + label.w + VALUE_RIGHT_OF_LABEL.dx,
        y: label.y + VALUE_RIGHT_OF_LABEL.dy,
        w: VALUE_RIGHT_OF_LABEL.w,
        h: VALUE_RIGHT_OF_LABEL.h
      }
    },
    parse: parseGrouped
  })
}
