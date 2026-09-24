/**
 * 一轮采集结束后交给告警 / 统计模块的「事实」，以及结果分类。移植自原版 src/main/game/gatherRunner.ts 的契约部分。
 *
 * ★ 纯模块（只有类型与常量），主进程、工作线程与渲染进程共用同一份定义。
 */

import type { DispatchRecord, GatherCycleResult, GatherOutcome } from './types.js'

/**
 * 哪些留痕标签算「失败现场」。
 *   g0-failed    未知界面恢复阶梯全跑完仍回不到世界地图（ensureWorldMap 抛错前留的）
 *   cycle-error  本轮以异常收场（flow.ts 的兜底 catch 里留的）
 *   kicked       顶号探针命中时的现场
 *   health-probe 健康探针发现异常时的现场
 *   frozen       卡死看门狗判定「画面纹丝不动」时的最后一帧（重启前留痕）
 * 只有这些标签会触发第二层顶号识别与「现场截图」记账，别的标签（g0-unknown-N 等）只是过程留痕。
 */
export const FAILURE_SHOT_LABELS: ReadonlySet<string> = new Set([
  'g0-failed',
  'cycle-error',
  'kicked',
  'health-probe',
  'frozen'
])

/** 截图留存策略（原版 AppSettings.shotPolicy / GatherConfig.safety.shotPolicy 同值）。 */
export type ShotPolicy = 'never' | 'onFail' | 'always'

/** 这张留痕按策略该不该存。onFail 只存失败现场；always 连过程留痕也存；never 一张都不存。 */
export function shouldKeepShot(policy: ShotPolicy, label: string): boolean {
  if (policy === 'never') return false
  return policy === 'always' || FAILURE_SHOT_LABELS.has(label)
}

/**
 * ★ 告警铁律 1：这几个结果**不是失败**，还要清零失败计数。
 *   队列 5/5 是挂机稳态；熔断 / 放弃 / 体力不足都是流程按设计停下来。拿它们判故障必然误报。
 */
export const NON_FAILURE_OUTCOMES: ReadonlySet<GatherOutcome> = new Set<GatherOutcome>([
  'dispatched',
  'queueFull',
  'noResourceWanted',
  'giveUp',
  'staminaLow',
  'circuitBroken'
])

/**
 * 需要人处理、但**不算设备 / 周期失败**的错误码（专用告警负责，失败计数不涨，采样不判掉线）。
 *   GAME_UPDATE_REQUIRED  游戏资源更新未完成或遇到未校准的更新提示
 *   AI_RISK_BLOCKED       AI 评估某个确认类弹窗的点击后果有风险，拒绝自动处理
 */
export const ATTENTION_ERROR_CODES: ReadonlySet<string> = new Set(['GAME_UPDATE_REQUIRED', 'AI_RISK_BLOCKED'])

/** 第二层顶号识别的结论（告警模块实现；模板缺失时为 null）。 */
export interface KickedProbeResult {
  /** 命中的场景类别，如 kicked / maintenance / updateRequired。 */
  type: string
  /** 中文说明。 */
  reason: string
  /** 命中的模板 id 与分数（排障用）。 */
  templateId?: string
  score?: number
}

/** 一轮采集结束后交给告警模块的事实。只有事实，不含结论。 */
export interface GatherCycleFact {
  outcome: GatherOutcome
  /** 中文摘要，可直接显示。 */
  message: string
  /**
   * 失败发生在哪一步。★ `'G0'` 表示「未知界面恢复阶梯已用尽」——
   * 这是最强的「卡死/顶号」信号，告警模块用更小的阈值对待它。
   * 必须在往调度器抛错之前取出来：调度器那层会把错误重新包一层，detail.step 就丢了。
   */
  step: string | null
  /** 失败的错误码（SerializedError.code）。 */
  errorCode: string | null
  /** 本轮派出了几支队。 */
  dispatched: number
  /** 本轮截图数。 */
  captures: number
  /** 现场截图（相对助手数据目录的路径）；没留到为 null。 */
  shotPath: string | null
  /** 第二层顶号识别的结论；模板缺失或没命中为 null。 */
  kicked: KickedProbeResult | null
}

/** 从一轮结果里抽出事实（shotPath / kicked 由接线层在留痕那一刻取到后传进来）。 */
export function cycleFactOf(
  result: GatherCycleResult,
  extras: { shotPath?: string | null; kicked?: KickedProbeResult | null } = {}
): GatherCycleFact {
  const detailStep = (result.error?.detail as { step?: unknown } | undefined)?.step
  return {
    outcome: result.outcome,
    message: result.message,
    step: typeof detailStep === 'string' ? detailStep : null,
    errorCode: result.error?.code ?? null,
    dispatched: result.dispatched.length,
    captures: result.captures,
    shotPath: extras.shotPath ?? null,
    kicked: extras.kicked ?? null
  }
}

/** 「这一轮压根没跑起来」（模板 / 实例 / 配置读不出）时补报的事实：没有步骤号，只进普通的连续失败计数。 */
export function startupFailureFact(message: string, errorCode: string | null): GatherCycleFact {
  return {
    outcome: 'error',
    message: `采集流程没能启动：${message}`,
    step: null,
    errorCode,
    dispatched: 0,
    captures: 0,
    shotPath: null,
    kicked: null
  }
}

export type { DispatchRecord }
