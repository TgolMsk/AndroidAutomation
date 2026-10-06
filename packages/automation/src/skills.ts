/**
 * 技能（Skill）契约：给决策层用的「高层游戏操作」。
 *
 * 决策层（今天是写死的规则，以后可以换成 Jev 这类决策模型）只回答「这个号现在做哪个技能」；
 * 技能自己负责「怎么做」—— 导航、模板确认、点击、复验，全是确定性代码，出错可重试、可测试。
 *
 *   check(state, now)  纯函数：只看状态快照、不碰设备。空位、配额、冷却这类算数全在这里（或拼快照时）算完，
 *                      决策层拿到的只是「能不能做 + 一句理由」—— 决策模型不擅长算数和比时间。
 *   run(ctx)           真正操作设备，由宿主（主进程）实现。正常结束只有 done / idle / deferred 三种；
 *                      失败一律抛错（带错误码），交给调用方原有的退避 / 暂停逻辑，技能层不另起一套。
 *
 * ★ 纯模块：不引 sharp / OpenCV / node:*，渲染进程也能用。
 */

/** check 的结论。 */
export interface SkillVerdict {
  /** 现在值得跑一次。 */
  ready: boolean;
  /** 中文一句话：能做的依据 / 不能做的原因（日志、面板直接显示）。 */
  reason: string;
  /** 不能做时，最早什么时候可能变成能做（绝对毫秒）；不知道为 null。能做时恒为 null。 */
  retryAt: number | null;
}

/** 技能的静态说明与纯判定。S = 这个游戏的状态快照类型。 */
export interface SkillSpec<S> {
  /** 稳定的英文 id：决策模型的选项名、日志键。改名等于换了一个技能。 */
  readonly id: string;
  /** 中文名（界面、日志）。 */
  readonly title: string;
  /** 给决策模型看的英文说明：做什么、什么时候值得做（Jev 这类模型英文精度最高）。 */
  readonly summary: string;
  check(state: S, now: number): SkillVerdict;
}

/** 技能正常结束的三种结果（失败不在这里：run 直接抛错）。 */
export type SkillOutcome =
  /** 做成了（例如至少派出一支队）。 */
  | 'done'
  /** 跑完了，但没有可做的事（队列满、配额已满足、搜不到点……）。 */
  | 'idle'
  /** 主动推迟：notBefore 之前别再跑（熔断、冷却）。 */
  | 'deferred';

export interface SkillRunResult {
  skillId: string;
  outcome: SkillOutcome;
  /** 中文一句话：这次做了什么 / 为什么没做。 */
  message: string;
  /** 做成了几件事（采集 = 派出几支队）。 */
  count: number;
  /** 在这之前别再跑这个技能；没有要求为 null。 */
  notBefore: number | null;
}

/** 完整的技能 = 说明 + 纯判定 + 宿主实现的 run。C = 宿主给的执行上下文（实例号、中止信号……）。 */
export interface Skill<S, C> extends SkillSpec<S> {
  run(ctx: C): Promise<SkillRunResult>;
}

export function readyVerdict(reason: string): SkillVerdict {
  return { ready: true, reason, retryAt: null };
}

export function blockedVerdict(reason: string, retryAt: number | null = null): SkillVerdict {
  return { ready: false, reason, retryAt };
}

/**
 * 影子模式的对账：check 的预判 vs. run 的实际结果。
 *   agree         预判与实际一致
 *   falseReady    预判「能做」，实际没做成（白跑一轮，代价是几秒截图）
 *   falseBlocked  预判「不能做」，实际做成了 —— ★ 若按预判拦截就会漏做，放权前必须先把它压到零
 */
export type VerdictAudit = 'agree' | 'falseReady' | 'falseBlocked';

export function auditVerdict(verdict: SkillVerdict, result: Pick<SkillRunResult, 'outcome'>): VerdictAudit {
  const done = result.outcome === 'done';
  if (verdict.ready === done) return 'agree';
  return verdict.ready ? 'falseReady' : 'falseBlocked';
}
