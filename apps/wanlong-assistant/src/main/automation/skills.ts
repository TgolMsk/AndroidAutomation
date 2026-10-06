/**
 * The skill layer's main-process half (contract: packages/automation/src/skills.ts; wanlong's game state and the
 * gather check: packages/automation/src/wanlong/skills/).
 *
 * The first skill is the gather cycle that already runs when the ETA scheduler finds a free march queue: its `run` is
 * that hand-off, unchanged. Its pure `check` runs in shadow mode next to it (`AutomationHost.queueFreeTurn`): the
 * verdict is only compared with what the cycle really did, and a disagreement is logged — it never gates a cycle.
 * A decision layer (rules today, a model such as Jev later) picks among skills here once there is more than one.
 */
import { auditVerdict, type Skill, type SkillRunResult, type SkillVerdict } from '@avdm/automation';
import type { GatherOutcome } from '@avdm/automation/wanlong';
import { gatherSkill, gatherSkillOutcome, type WanlongGameState } from '@avdm/automation/wanlong/pure';
import type { QueueFreeResult } from '../scheduler/types';

export interface SkillRunContext {
  index: number;
  signal: AbortSignal;
}

/** The scheduler's hand-off result plus the cycle's own outcome and message (what the skill result is built from). */
export interface GatherHandoff extends QueueFreeResult {
  outcome: Exclude<GatherOutcome, 'error' | 'cancelled'>;
  message: string;
}

export type WanlongSkill = Skill<WanlongGameState, SkillRunContext>;

/** The existing scheduled gather cycle as the first skill. `handoff` throws on a failed cycle, exactly as before. */
export function createGatherSkill(handoff: (index: number, signal: AbortSignal) => Promise<GatherHandoff>): WanlongSkill {
  return {
    ...gatherSkill,
    async run({ index, signal }) {
      const result = await handoff(index, signal);
      return {
        skillId: gatherSkill.id,
        outcome: gatherSkillOutcome(result.outcome, result.dispatched),
        // The scheduler's own reason (the circuit breaker's) wins: the queue view shows it as the next wake's reason.
        message: result.reason ?? result.message,
        count: result.dispatched,
        notBefore: result.notBefore ?? null,
      };
    },
  };
}

/** Back to the scheduler's contract: the same object the hand-off returned before skills existed. */
export function toQueueFreeResult(result: SkillRunResult): QueueFreeResult {
  if (result.outcome === 'deferred') return { dispatched: result.count, notBefore: result.notBefore, reason: result.message };
  return { dispatched: result.count };
}

/**
 * Shadow-mode bookkeeping: which verdict/result disagreements to log. The same disagreement is logged once per
 * instance and skill until the two agree again, so a steady state (e.g. a quota the cycle keeps finding full) does
 * not repeat every backoff wake.
 */
export class SkillShadow {
  private readonly last = new Map<string, string>();

  /** The line to log for this verdict and result, or null (they agree, or this disagreement was just logged). */
  note(index: number, skill: Pick<WanlongSkill, 'id' | 'title'>, verdict: SkillVerdict, result: SkillRunResult): string | null {
    const key = `${index}:${skill.id}`;
    const audit = auditVerdict(verdict, result);
    if (audit === 'agree') {
      this.last.delete(key);
      return null;
    }
    const line = audit === 'falseReady'
      ? `[影子模式] 技能「${skill.title}」预判可做（${verdict.reason}），实际没做成：${result.message}`
      : `[影子模式] 技能「${skill.title}」预判不可做（${verdict.reason}），实际做成了：${result.message}`;
    if (this.last.get(key) === line) return null;
    this.last.set(key, line);
    return line;
  }
}
