/**
 * Condition evaluation (wanlong-panel `src/worker/conditions.ts`).
 *
 * Every condition is judged on the same frame: `ctx.frame()` reuses the frame captured within the minimum
 * capture interval, so ten template conditions in one and/or cost one screencap. To force a new look, the
 * caller invalidates the frame first.
 */
import type { MatchResult } from '../contracts.js';
import type { ScriptContext } from './context.js';
import type { Condition } from './types.js';

export interface CondResult {
  ok: boolean;
  /** Template conditions return the match (anyTemplate: the template that actually matched). */
  match?: MatchResult;
  /** Chinese reason, logged when the condition fails so the failing branch is visible. */
  reason?: string;
}

export async function evalCondition(ctx: ScriptContext, cond: Condition): Promise<CondResult> {
  switch (cond.kind) {
    case 'always': return { ok: true };
    case 'never': return { ok: false, reason: '条件恒为 false' };
    case 'template': {
      const want = cond.present ?? true;
      const match = await ctx.matchTemplate(cond.templateId, cond.roi, cond.threshold);
      const ok = match.found === want;
      return {
        ok,
        match,
        reason: ok ? undefined : want
          ? `模板「${cond.templateId}」未出现（最高分 ${match.score}，阈值 ${match.threshold}${match.reason ? `，${match.reason}` : ''}）`
          : `模板「${cond.templateId}」仍然存在（分数 ${match.score}）`,
      };
    }
    case 'anyTemplate': {
      const scores: string[] = [];
      for (const id of cond.templateIds) {
        const match = await ctx.matchTemplate(id, cond.roi, cond.threshold);
        if (match.found) return { ok: true, match };
        scores.push(`${id}=${match.score}`);
      }
      return { ok: false, reason: `候选模板都没出现（${scores.join(', ')}）` };
    }
    case 'foreground': {
      const equals = cond.equals ?? true;
      const pkg = await ctx.foregroundPackage();
      const ok = (pkg === cond.packageName) === equals;
      return {
        ok,
        reason: ok ? undefined : equals
          ? `前台应用是「${pkg ?? '未知'}」，不是期望的「${cond.packageName}」`
          : `前台应用正是不该出现的「${cond.packageName}」`,
      };
    }
    case 'and': {
      for (const item of cond.all) {
        const result = await evalCondition(ctx, item);
        if (!result.ok) return { ok: false, reason: result.reason ?? '子条件不成立' };
      }
      return { ok: true };
    }
    case 'or': {
      const reasons: string[] = [];
      for (const item of cond.any) {
        const result = await evalCondition(ctx, item);
        if (result.ok) return result;
        if (result.reason) reasons.push(result.reason);
      }
      return { ok: false, reason: `所有分支都不成立（${reasons.join('；')}）` };
    }
    case 'not': {
      const result = await evalCondition(ctx, cond.of);
      return { ok: !result.ok, reason: result.ok ? '被取反的条件成立' : undefined };
    }
    default: {
      const never: never = cond;
      return { ok: false, reason: `未知条件类型：${JSON.stringify(never)}` };
    }
  }
}
