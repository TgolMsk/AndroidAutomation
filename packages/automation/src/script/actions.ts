/**
 * One step's action (wanlong-panel `src/worker/actions.ts`): how to do one thing. Retries, onFail and jumps
 * belong to the engine. Failures throw a Chinese ScriptError.
 *
 * ★ Coordinates in steps are in the script canvas and must pass through `ctx.toDevice()` before adb.
 * ★ Every input invalidates the cached frame.
 * ★ A step whose timeout fired (`scope.cancelled`) never sends another input: its polling stops and a late
 *   match cannot tap while the engine is already on the next step.
 */
import type { Point } from '../contracts.js';
import { describeCondition } from './describe.js';
import { evalCondition } from './conditions.js';
import { ScriptError } from './errors.js';
import type { ScriptContext, StepScope } from './context.js';
import type { ScriptStep } from './types.js';

/** Default poll gap of tapTemplate / waitFor; judgement runs at ≈3 fps, faster polling is pointless. */
export const DEFAULT_POLL_MS = 500;
const MIN_POLL_MS = 50;
export const DEFAULT_SWIPE_MS = 300;

function beforeInput(ctx: ScriptContext, scope: StepScope, step: ScriptStep): void {
  if (scope.cancelled) throw new ScriptError('TIMEOUT', `步骤「${step.name ?? step.id}」已超时，放弃后续输入。`, { stepId: step.id });
  if (ctx.aborted) throw new ScriptError('CANCELLED', '执行已停止，不再发送输入。');
}

function afterInput(ctx: ScriptContext): void {
  ctx.invalidateFrame();
}

export async function execStep(ctx: ScriptContext, step: ScriptStep, scope: StepScope): Promise<void> {
  switch (step.kind) {
    case 'tap': {
      const device = await ctx.toDevice(step.at);
      beforeInput(ctx, scope, step);
      await ctx.device.tap(device.x, device.y);
      ctx.snapshot.stats.taps += 1;
      afterInput(ctx);
      ctx.log('debug', `点击 (${step.at.x}, ${step.at.y}) → 设备 (${device.x}, ${device.y})`, undefined, { stepId: step.id });
      return;
    }

    case 'tapTemplate': {
      const waitMs = step.waitMs ?? 0;
      const pollMs = Math.max(MIN_POLL_MS, step.pollMs ?? DEFAULT_POLL_MS);
      const deadline = ctx.now() + waitMs;
      let attempt = 0;
      let last = '';
      for (;;) {
        if (attempt > 0) ctx.invalidateFrame();
        const match = await ctx.matchTemplate(step.templateId, step.roi, step.threshold);
        attempt += 1;
        if (match.found) {
          const offset = step.offset ? ctx.pointToRef(step.offset) : { x: 0, y: 0 };
          const ref: Point = { x: match.centerX + offset.x, y: match.centerY + offset.y };
          const device = await ctx.refToDevicePoint(ref);
          beforeInput(ctx, scope, step);
          await ctx.device.tap(device.x, device.y);
          ctx.snapshot.stats.taps += 1;
          afterInput(ctx);
          ctx.log('info', `点中模板「${step.templateId}」(分数 ${match.score}) → 参考 (${Math.round(ref.x)}, ${Math.round(ref.y)}) / 设备 (${device.x}, ${device.y})`,
            { score: match.score, threshold: match.threshold, attempt }, { stepId: step.id });
          return;
        }
        last = `最高分 ${match.score}，阈值 ${match.threshold}${match.reason ? `（${match.reason}）` : ''}`;
        if (ctx.now() >= deadline || ctx.aborted || scope.cancelled) break;
        await ctx.sleep(Math.min(pollMs, Math.max(0, deadline - ctx.now())), scope);
        if (ctx.aborted || scope.cancelled) break;
      }
      throw new ScriptError('STEP_FAILED',
        `没找到模板「${step.templateId}」，等了 ${waitMs}ms 共 ${attempt} 次（${last}）。` +
        '排查方向：ROI 是不是框小了、模板是不是在别的分辨率下截的、阈值是不是太高。',
        { stepId: step.id, templateId: step.templateId, attempts: attempt });
    }

    case 'waitFor': {
      const pollMs = Math.max(MIN_POLL_MS, step.pollMs ?? DEFAULT_POLL_MS);
      const deadline = ctx.now() + step.waitMs;
      let attempt = 0;
      let reason = '';
      for (;;) {
        if (attempt > 0) ctx.invalidateFrame();
        const result = await evalCondition(ctx, step.cond);
        attempt += 1;
        if (result.ok) {
          ctx.log('debug', `条件成立：${describeCondition(step.cond)}（第 ${attempt} 次判定）`, undefined, { stepId: step.id });
          return;
        }
        reason = result.reason ?? '条件不成立';
        if (ctx.now() >= deadline || ctx.aborted || scope.cancelled) break;
        await ctx.sleep(Math.min(pollMs, Math.max(0, deadline - ctx.now())), scope);
        if (ctx.aborted || scope.cancelled) break;
      }
      throw new ScriptError('STEP_FAILED',
        `等待超时（${step.waitMs}ms，判定 ${attempt} 次）：${describeCondition(step.cond)}。最后一次的原因是 ${reason}。`,
        { stepId: step.id, attempts: attempt });
    }

    case 'swipe': {
      const from = await ctx.toDevice(step.from);
      const to = await ctx.toDevice(step.to);
      const ms = step.durationMs ?? DEFAULT_SWIPE_MS;
      beforeInput(ctx, scope, step);
      await ctx.device.swipe(from.x, from.y, to.x, to.y, ms);
      afterInput(ctx);
      ctx.log('debug', `滑动 (${step.from.x}, ${step.from.y}) → (${step.to.x}, ${step.to.y})，${ms}ms`, undefined, { stepId: step.id });
      return;
    }

    case 'longPress': {
      const device = await ctx.toDevice(step.at);
      beforeInput(ctx, scope, step);
      await ctx.device.longPress(device.x, device.y, step.durationMs);
      afterInput(ctx);
      ctx.log('debug', `长按 (${step.at.x}, ${step.at.y}) ${step.durationMs}ms`, undefined, { stepId: step.id });
      return;
    }

    case 'text': {
      const text = ctx.interpolate(step.text);
      if (text.length === 0) {
        ctx.log('warn', '要输入的文本为空，跳过。', undefined, { stepId: step.id });
        return;
      }
      beforeInput(ctx, scope, step);
      await ctx.device.inputText(text);
      afterInput(ctx);
      // The content itself is never logged: it may be an account or a code.
      ctx.log('info', `输入文本（${text.length} 字）`, undefined, { stepId: step.id });
      return;
    }

    case 'key': {
      beforeInput(ctx, scope, step);
      await ctx.device.key(step.key);
      afterInput(ctx);
      ctx.log('debug', `按键 ${step.key}`, undefined, { stepId: step.id });
      return;
    }

    case 'sleep':
      await ctx.sleep(step.ms, scope);
      return;

    case 'launchApp': {
      const pkg = ctx.resolvePackage(step.packageName, step.id);
      const cold = step.cold ?? false;
      beforeInput(ctx, scope, step);
      await ctx.device.launchApp(pkg, cold);
      afterInput(ctx);
      ctx.invalidateForeground();
      ctx.log('info', `${cold ? '冷启动' : '启动'}应用 ${pkg}`, undefined, { stepId: step.id });
      return;
    }

    case 'stopApp': {
      const pkg = ctx.resolvePackage(step.packageName, step.id);
      beforeInput(ctx, scope, step);
      await ctx.device.stopApp(pkg);
      afterInput(ctx);
      ctx.invalidateForeground();
      ctx.log('info', `强制停止应用 ${pkg}`, undefined, { stepId: step.id });
      return;
    }

    case 'screenshot': {
      const label = step.label ?? step.id;
      const shot = await ctx.shot(label);
      ctx.log('info', `留痕截图：${label}`, undefined, { stepId: step.id, shot: shot ?? undefined });
      return;
    }

    case 'log':
      ctx.log(step.level, ctx.interpolate(step.message), undefined, { stepId: step.id, scope: 'script' });
      return;

    case 'label':
      return;

    case 'goto':
    case 'if':
    case 'loop':
      // The engine handles control flow itself; reaching this is an engine bug, but it must not kill the run.
      ctx.log('error', `控制流步骤「${step.kind}」被当成动作执行了，请报告这个问题。`, undefined, { stepId: step.id });
      return;

    default: {
      const never: never = step;
      throw new ScriptError('SCRIPT_INVALID', `未知的步骤类型：${JSON.stringify(never)}`);
    }
  }
}
