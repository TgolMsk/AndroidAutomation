/**
 * Script execution engine (wanlong-panel `src/worker/engine.ts`). This comment is the DSL's behaviour spec:
 *
 *  · `when` false → the step is skipped, which is not a failure.
 *  · A failing step is retried `retry` times (`retryDelayMs`, default 800 ms); then the AI advisor may look once;
 *    then `onFail` decides: abort (default) ends the run / continue / goto a label / restartApp cold-starts the
 *    app and reruns the script from the top (at most `maxRestarts`, default 10).
 *  · Control flow (label / goto / if / loop) runs outside retry and onFail: a failure inside an if or loop body
 *    that aborts ends the whole run; it is never retried by the enclosing block.
 *  · goto overflowing `maxTimes` (default 1000) and a loop reaching `maxIterations` (default 1000) fail the run.
 *    goto only reaches labels in the same or an outer block. One block executes at most 200 000 steps.
 *  · `timeoutMs` bounds one attempt of a step; a timeout is a step failure (retry / onFail apply).
 *  · `script.loop` reruns the steps every `loopIntervalMs` (≥ 1000) until stopped; `iteration` counts rounds.
 *  · Pause takes effect at the next step boundary; stop lets the current step end and finishes as aborted.
 *  · Assistant additions: an ExecutionGuardError (instance replaced, account changed, game left the foreground
 *    before an input) ends the run regardless of retry / onFail / AI, and `maxRunMs` bounds the whole run
 *    (pause time included) and marks the snapshot `timedOut`: a one-shot script that overruns it fails; a loop
 *    script (which only ends by a stop or this limit) has run its allotted time and ends as succeeded.
 *  · Judgement is paced for ≈3 fps (one screencap ≈ 300 ms); do not write steps that need 10 fps reactions.
 *  · Failure shots are always taken unless the shot policy is `never` or the step says `capture: false`.
 */
import { evalCondition } from './conditions.js';
import { execStep } from './actions.js';
import { StepScope, type ScriptContext } from './context.js';
import { describeCondition } from './describe.js';
import { ScriptError, isExecutionGuardError } from './errors.js';
import type { Condition, FailPolicy, RunFailureCode, RunSnapshot, RunStatus, ScriptParamDef, ScriptParamValue, ScriptStep } from './types.js';

export const DEFAULT_MAX_ITERATIONS = 1000;
export const DEFAULT_MAX_GOTO = 1000;
/** Executions allowed in one block; catches label + goto loops. */
export const MAX_BLOCK_STEPS = 200_000;
export const DEFAULT_RETRY_DELAY_MS = 800;
/** More restarts than this means the script (or the environment) cannot get through. */
export const DEFAULT_MAX_RESTARTS = 10;
/** Wait after a cold start before the script reruns. */
export const RESTART_SETTLE_MS = 8000;
const RESTART_GAP_MS = 2000;
export const MIN_LOOP_INTERVAL_MS = 1000;

type StepOutcome =
  | { type: 'next' }
  | { type: 'goto'; label: string; fromStepId: string }
  | { type: 'stop' }
  | { type: 'restart'; fromStepId: string };

type BlockOutcome = Exclude<StepOutcome, { type: 'next' }> | { type: 'done' };

/** Why the run was halted from outside the step flow. */
type Halt = { status: 'aborted' | 'succeeded' | 'failed'; message: string; code?: RunFailureCode };

export interface ScriptEngineOptions {
  /** Whole-run limit in ms (pause time counts); null / 0 = unlimited. */
  maxRunMs?: number | null;
  maxRestarts?: number;
  restartGapMs?: number;
  restartSettleMs?: number;
  /** Aborting it stops the run like `stop()`. */
  signal?: AbortSignal;
}

/**
 * Parameters for the start line. Free-text values are masked: they are what text steps type (account names,
 * passwords, codes) and the log is persisted. Numbers, switches and enum choices are shown as they are.
 */
export function loggableParams(defs: readonly ScriptParamDef[] | undefined, params: Readonly<Record<string, ScriptParamValue>>): Record<string, ScriptParamValue> {
  const out: Record<string, ScriptParamValue> = {};
  for (const [key, value] of Object.entries(params)) {
    const def = defs?.find((item) => item.key === key);
    out[key] = typeof value === 'string' && def?.type !== 'enum' ? `（${value.length} 字，已隐藏）` : value;
  }
  return out;
}

export class ScriptEngine {
  private stopping = false;
  private finished = false;
  private halt: Halt | null = null;
  private readonly gotoCounts = new Map<string, number>();
  private readonly maxRestarts: number;
  private readonly restartGapMs: number;
  private readonly restartSettleMs: number;
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly ctx: ScriptContext, private readonly options: ScriptEngineOptions = {}) {
    this.maxRestarts = options.maxRestarts ?? DEFAULT_MAX_RESTARTS;
    this.restartGapMs = options.restartGapMs ?? RESTART_GAP_MS;
    this.restartSettleMs = options.restartSettleMs ?? RESTART_SETTLE_MS;
  }

  get isFinished(): boolean { return this.finished; }

  // ── Controls ──────────────────────────────────────────────────────────

  pause(): void {
    if (this.finished || this.stopping || this.ctx.paused) return;
    this.ctx.setPaused(true);
    this.ctx.setStatus('paused');
    this.ctx.log('info', '已暂停（当前步骤跑完后挂起）。');
  }

  resume(): void {
    if (this.finished || this.stopping || !this.ctx.paused) return;
    this.ctx.setPaused(false);
    this.ctx.setStatus('running');
    this.ctx.log('info', '已继续。');
  }

  /** Graceful stop: the current step ends, then the run finishes as aborted. */
  stop(reason = '收到停止指令，正在收尾。'): void {
    this.haltWith({ status: 'aborted', message: reason });
  }

  private haltWith(halt: Halt): void {
    if (this.finished || this.stopping) return;
    this.stopping = true;
    this.halt = halt;
    this.ctx.setPaused(false);
    this.ctx.abort();
    if (halt.status === 'failed') {
      this.ctx.log('error', halt.message);
    } else {
      this.ctx.setStatus('stopping');
      this.ctx.log('info', halt.message);
    }
  }

  // ── Main flow ─────────────────────────────────────────────────────────

  async run(): Promise<RunSnapshot> {
    const ctx = this.ctx;
    const signal = this.options.signal;
    const onAbort = (): void => {
      const reason = signal?.reason instanceof Error ? signal.reason.message : '执行已被取消';
      this.stop(reason);
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    const maxRunMs = this.options.maxRunMs ?? 0;
    if (maxRunMs > 0) {
      this.deadlineTimer = setTimeout(() => {
        if (this.finished || this.stopping) return;
        const minutes = Math.round(maxRunMs / 6000) / 10;
        ctx.snapshot.timedOut = true;
        // ★ A loop script has no other natural end: running its allotted time is success, never a retryable failure.
        if (ctx.script.loop) this.haltWith({ status: 'succeeded', message: `循环脚本已运行满本次时间上限（${minutes} 分钟），按时结束。` });
        else this.haltWith({ status: 'failed', message: `脚本运行超过本次时间上限（${minutes} 分钟），已停止。`, code: 'TIMEOUT' });
      }, Math.min(maxRunMs, 2_147_483_647));
      (this.deadlineTimer as { unref?: () => void }).unref?.();
    }

    ctx.snapshot.startedAt = ctx.now();
    if (!this.stopping) ctx.setStatus('running');
    ctx.log('info', `开始执行脚本「${ctx.script.name}」v${ctx.script.version}（实例 #${ctx.instanceIndex}）` +
      `${ctx.snapshot.accountName ? `，账号：${ctx.snapshot.accountName}` : ''}`, { scriptId: ctx.script.id, params: loggableParams(ctx.script.params, ctx.params) });

    let restarts = 0;
    try {
      for (;;) {
        this.gotoCounts.clear();
        ctx.snapshot.stepDone = 0;
        const outcome = await this.runBlock(ctx.script.steps, true);
        if (outcome.type === 'stop') break;
        if (outcome.type === 'restart') {
          restarts += 1;
          if (restarts > this.maxRestarts) {
            throw new ScriptError('STEP_FAILED',
              `已按 onFail=restartApp 重启应用 ${this.maxRestarts} 次仍然过不去，判定为脚本或环境有问题，停止执行。`,
              { fromStepId: outcome.fromStepId });
          }
          await this.restartApp(restarts);
          if (this.stopping) break;
          continue;
        }
        if (outcome.type === 'goto') {
          throw new ScriptError('SCRIPT_INVALID',
            `步骤「${outcome.fromStepId}」要跳到 label「${outcome.label}」，但顶层脚本里没有这个 label（goto 只能跳到同级或外层）。`,
            { stepId: outcome.fromStepId, label: outcome.label });
        }
        if (!ctx.script.loop || this.stopping) break;
        ctx.snapshot.iteration += 1;
        const gap = Math.max(MIN_LOOP_INTERVAL_MS, ctx.script.loopIntervalMs ?? 0);
        ctx.log('info', `第 ${ctx.snapshot.iteration} 轮结束，${gap}ms 后开始下一轮。`);
        ctx.publishStatus(true);
        await ctx.sleep(gap);
        if (this.stopping) break;
      }
      this.finish(this.halt ? this.halt.status : 'succeeded', this.halt?.status === 'failed' ? this.halt.message : null, this.halt?.code);
    } catch (error) {
      if (this.halt) {
        this.finish(this.halt.status, this.halt.status === 'failed' ? this.halt.message : null, this.halt.code);
      } else if (isExecutionGuardError(error)) {
        ctx.log('error', `执行被安全检查终止：${error.message}`);
        this.finish('failed', error.message, 'GUARD');
      } else {
        const failure = ScriptError.from(error, 'UNKNOWN');
        ctx.log('error', `执行失败：${failure.message}`, { code: failure.code, ...(failure.detail ?? {}) });
        this.finish('failed', failure.message, failure.code);
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
      if (this.deadlineTimer) { clearTimeout(this.deadlineTimer); this.deadlineTimer = null; }
    }
    return ctx.snapshotCopy();
  }

  // ── Blocks and steps ──────────────────────────────────────────────────

  /** Runs a block; only the top level counts toward `stepDone`. */
  private async runBlock(steps: readonly ScriptStep[], top: boolean): Promise<BlockOutcome> {
    let index = 0;
    let guard = 0;
    while (index < steps.length) {
      if (this.stopping) return { type: 'stop' };
      if (++guard > MAX_BLOCK_STEPS) {
        throw new ScriptError('STEP_FAILED', `单个步骤序列已执行 ${MAX_BLOCK_STEPS} 次仍未结束，判定为死循环（多半是 goto 跳回了自己前面）。`);
      }
      const outcome = await this.runStep(steps[index]!);
      if (outcome.type === 'next') {
        if (top) {
          this.ctx.snapshot.stepDone += 1;
          this.ctx.publishStatus();
        }
        index += 1;
        continue;
      }
      if (outcome.type === 'stop' || outcome.type === 'restart') return outcome;
      // goto: look for the label in this block first, otherwise bubble up to the outer block.
      const target = steps.findIndex((step) => step.kind === 'label' && step.label === outcome.label);
      if (target < 0) return outcome;
      this.ctx.log('info', `跳转到 label「${outcome.label}」`, undefined, { stepId: outcome.fromStepId });
      index = target;
    }
    return { type: 'done' };
  }

  private async runStep(step: ScriptStep): Promise<StepOutcome> {
    const ctx = this.ctx;
    if (this.stopping) return { type: 'stop' };
    await ctx.waitWhilePaused();
    if (this.stopping) return { type: 'stop' };

    const started = ctx.now();
    ctx.snapshot.currentStepId = step.id;
    ctx.snapshot.currentStepName = step.name ?? step.kind;
    ctx.publishStatus();

    if (step.when) {
      const result = await evalCondition(ctx, step.when);
      if (!result.ok) {
        ctx.log('debug', `跳过步骤（when 不成立：${describeCondition(step.when)}${result.reason ? ` —— ${result.reason}` : ''}）`, undefined, { stepId: step.id });
        return { type: 'next' };
      }
    }

    // ── Control flow: never retried, never subject to onFail ──
    switch (step.kind) {
      case 'label':
        return { type: 'next' };
      case 'goto': {
        const count = (this.gotoCounts.get(step.id) ?? 0) + 1;
        this.gotoCounts.set(step.id, count);
        const max = step.maxTimes ?? DEFAULT_MAX_GOTO;
        if (count > max) {
          throw new ScriptError('STEP_FAILED', `goto「${step.label}」已经跳了 ${max} 次（maxTimes 上限），判定为死循环，停止执行。`, { stepId: step.id });
        }
        return { type: 'goto', label: step.label, fromStepId: step.id };
      }
      case 'if': {
        const result = await evalCondition(ctx, step.cond);
        ctx.log('debug', `if 条件${result.ok ? '成立' : '不成立'}：${describeCondition(step.cond)}`, undefined, { stepId: step.id });
        const outcome = await this.runBlock(result.ok ? step.then : (step.else ?? []), false);
        return outcome.type === 'done' ? { type: 'next' } : outcome;
      }
      case 'loop': {
        const maxIterations = step.maxIterations ?? DEFAULT_MAX_ITERATIONS;
        for (let n = 0; ; n++) {
          if (this.stopping) return { type: 'stop' };
          if (step.repeat !== undefined && n >= step.repeat) break;
          if (n >= maxIterations) {
            throw new ScriptError('STEP_FAILED',
              `循环步骤「${step.name ?? step.id}」达到硬上限 ${maxIterations} 次仍未结束，停止执行。请给它设置 repeat 或一个迟早会不成立的 while 条件。`,
              { stepId: step.id });
          }
          if (step.while) {
            ctx.invalidateFrame();
            const result = await evalCondition(ctx, step.while);
            if (!result.ok) {
              ctx.log('debug', `循环结束（while 不成立：${result.reason ?? ''}），共 ${n} 轮。`, undefined, { stepId: step.id });
              break;
            }
          }
          const outcome = await this.runBlock(step.steps, false);
          if (outcome.type !== 'done') return outcome;
        }
        return { type: 'next' };
      }
      default:
        break;
    }

    // ── Actions: execute + retry ──
    const retry = Math.max(0, step.retry ?? 0);
    let lastError: ScriptError | null = null;
    for (let attempt = 0; attempt <= retry; attempt++) {
      try {
        await this.attempt(step);
        lastError = null;
        break;
      } catch (error) {
        if (isExecutionGuardError(error)) throw error;
        if (this.stopping || ctx.aborted) return { type: 'stop' };
        lastError = ScriptError.from(error, 'STEP_FAILED');
        if (attempt < retry) {
          ctx.snapshot.stats.retries += 1;
          ctx.log('warn', `步骤「${step.name ?? step.id}」第 ${attempt + 1} 次失败：${lastError.message} —— 准备重试（还剩 ${retry - attempt} 次）。`,
            undefined, { stepId: step.id });
          await ctx.sleep(step.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
          ctx.invalidateFrame();
          if (this.stopping || ctx.aborted) return { type: 'stop' };
        }
      }
    }

    // ── AI fallback: once per step, never for onFail=continue (the author already accepted the failure) ──
    if (lastError && ctx.consultAi && (step.onFail?.kind ?? 'abort') !== 'continue' && !this.stopping && !ctx.aborted) {
      const assisted = await this.consultAndRetry(step, lastError);
      lastError = assisted.error;
      if (assisted.retried && !lastError) {
        // The advisor cleared the obstacle and the step succeeded: finish it like any success.
        ctx.snapshot.stats.lastTickMs = ctx.now() - started;
        if (step.afterDelayMs) await ctx.sleep(step.afterDelayMs);
        return { type: 'next' };
      }
      if (this.stopping || ctx.aborted) return { type: 'stop' };
    }

    if (lastError) return this.handleFailure(step, lastError);

    if (step.capture === true || (step.capture === undefined && ctx.shotPolicy === 'always')) {
      const shot = await ctx.shot(`${step.id}-ok`);
      ctx.log('debug', '步骤完成留痕', undefined, { stepId: step.id, shot: shot ?? undefined });
    }
    if (step.afterDelayMs) await ctx.sleep(step.afterDelayMs);
    ctx.snapshot.stats.lastTickMs = ctx.now() - started;
    return { type: 'next' };
  }

  /** One attempt, bounded by the step's timeout; a timed-out attempt is cancelled so it never inputs later. */
  private async attempt(step: ScriptStep): Promise<void> {
    const scope = new StepScope();
    const running = execStep(this.ctx, step, scope);
    const ms = step.timeoutMs;
    if (!ms || ms <= 0) return running;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        scope.cancel();
        reject(new ScriptError('TIMEOUT', `步骤「${step.name ?? step.id}」超过 ${ms}ms 仍未完成。`, { stepId: step.id }));
      }, ms);
    });
    try { await Promise.race([running, timeout]); }
    finally {
      clearTimeout(timer);
      // The attempt settles on its own (adb calls have their own timeouts); its late rejection is irrelevant.
      running.catch(() => undefined);
    }
  }

  /**
   * ★ AI fallback: ask the host's advisor to look at the screen (usually a pop-up in the way). Three limits:
   * once per step; `requiresAttention` fails the step without a retry; the port never throws.
   */
  private async consultAndRetry(step: ScriptStep, error: ScriptError): Promise<{ retried: boolean; error: ScriptError | null }> {
    const ctx = this.ctx;
    if (!ctx.consultAi) return { retried: false, error };
    const stepName = step.name ?? step.id;
    // Debug on purpose: without an enabled advisor every failing step passes through here.
    ctx.log('debug', `步骤「${stepName}」重试耗尽，问一下 AI 顾问…`, undefined, { stepId: step.id });
    let answer;
    try {
      // A stop or the whole-run limit must not wait for the advisor (up to 3 minutes): answer "not handled".
      answer = await ctx.raceAbort(ctx.consultAi({
        stepId: step.id,
        reason: `步骤「${stepName}」重试 ${Math.max(0, step.retry ?? 0)} 次后仍然失败：${error.message}`,
        expectTemplateIds: expectedTemplateIds(step),
      }), { handled: false, message: '执行已停止，不再等待 AI 顾问。' });
    } catch (cause) {
      ctx.log('debug', `AI 顾问出错，按未处理继续：${cause instanceof Error ? cause.message : String(cause)}`, undefined, { stepId: step.id });
      return { retried: false, error };
    }
    if (answer.requiresAttention) {
      ctx.log('error', `AI 顾问判定需要人工处理：${answer.message}`, undefined, { stepId: step.id });
      return { retried: false, error: new ScriptError('AI_RISK_BLOCKED', answer.message) };
    }
    if (!answer.handled) {
      ctx.log('debug', `AI 顾问没有介入：${answer.message}`, undefined, { stepId: step.id });
      return { retried: false, error };
    }
    ctx.log('info', `AI 顾问已处理：${answer.message}${answer.harvestedTemplateId ? `（并学到模板「${answer.harvestedTemplateId}」）` : ''} —— 重试这一步。`,
      undefined, { stepId: step.id });
    // The host touched the screen; any cached frame is stale.
    ctx.invalidateFrame();
    ctx.invalidateForeground();
    if (this.stopping || ctx.aborted) return { retried: false, error };
    try {
      await this.attempt(step);
      ctx.log('info', `AI 介入后步骤「${stepName}」成功。`, undefined, { stepId: step.id });
      return { retried: true, error: null };
    } catch (cause) {
      if (isExecutionGuardError(cause)) throw cause;
      const again = ScriptError.from(cause, 'STEP_FAILED');
      ctx.log('warn', `AI 介入后重试仍然失败：${again.message}`, undefined, { stepId: step.id });
      return { retried: true, error: again };
    }
  }

  private async handleFailure(step: ScriptStep, error: ScriptError): Promise<StepOutcome> {
    const ctx = this.ctx;
    const policy: FailPolicy = step.onFail ?? { kind: 'abort' };
    // The failure scene is worth more than any log line: always keep one unless explicitly disabled.
    let shot: string | null = null;
    if (ctx.shotPolicy !== 'never' && step.capture !== false) shot = await ctx.shot(`fail-${step.id}`);
    ctx.log('error', `步骤「${step.name ?? step.id}」失败：${error.message}`, { code: error.code, ...(error.detail ?? {}) },
      { stepId: step.id, shot: shot ?? undefined });
    ctx.logger.flush();
    switch (policy.kind) {
      case 'continue':
        ctx.log('warn', '按 onFail=continue 忽略该失败，继续下一步。', undefined, { stepId: step.id });
        return { type: 'next' };
      case 'goto':
        ctx.log('warn', `按 onFail=goto 跳到 label「${policy.label}」。`, undefined, { stepId: step.id });
        return { type: 'goto', label: policy.label, fromStepId: step.id };
      case 'restartApp':
        ctx.log('warn', '按 onFail=restartApp 冷启动应用后回到脚本开头。', undefined, { stepId: step.id });
        return { type: 'restart', fromStepId: step.id };
      case 'abort':
      default:
        throw error;
    }
  }

  /** onFail=restartApp: force-stop, gap, cold launch (the host waits for the foreground), settle. */
  private async restartApp(nth: number): Promise<void> {
    const ctx = this.ctx;
    const pkg = ctx.script.packageName;
    if (!pkg) throw new ScriptError('SCRIPT_INVALID', 'onFail=restartApp 需要脚本头部设置 packageName，否则不知道该重启哪个应用。');
    ctx.log('warn', `第 ${nth} 次重启应用 ${pkg}…`);
    await ctx.device.stopApp(pkg);
    await ctx.sleep(this.restartGapMs);
    if (this.stopping) return;
    await ctx.device.launchApp(pkg, true);
    ctx.invalidateFrame();
    ctx.invalidateForeground();
    await ctx.sleep(this.restartSettleMs);
  }

  // ── Finish ────────────────────────────────────────────────────────────

  private finish(status: RunStatus, error: string | null, code?: RunFailureCode): void {
    if (this.finished) return;
    this.finished = true;
    const ctx = this.ctx;
    ctx.snapshot.status = status;
    ctx.snapshot.endedAt = ctx.now();
    ctx.snapshot.error = error;
    if (status === 'failed' && code) ctx.snapshot.failureCode = code;
    ctx.snapshot.currentStepId = null;
    ctx.snapshot.currentStepName = null;
    const seconds = Math.round((ctx.snapshot.endedAt - ctx.snapshot.startedAt) / 1000);
    const stats = ctx.snapshot.stats;
    ctx.log(status === 'failed' ? 'error' : 'info',
      `执行${statusText(status)}，耗时 ${seconds}s：截图 ${stats.captures} 次（均 ${stats.avgCaptureMs}ms）、` +
      `匹配 ${stats.matches} 次命中 ${stats.matchHits} 次、点击 ${stats.taps} 次、重试 ${stats.retries} 次。`);
    // Logs first, then the final status, so the last line is never lost.
    ctx.logger.flush();
    ctx.publishStatus(true);
  }
}

/**
 * Templates this step was waiting for — the advisor's "known screen" check: only when they appear after it
 * closed something is the script really back where it wanted to be.
 */
export function expectedTemplateIds(step: ScriptStep): string[] {
  const out: string[] = [];
  const fromCondition = (cond: Condition): void => {
    switch (cond.kind) {
      case 'template': if (cond.present !== false) out.push(cond.templateId); break;
      case 'anyTemplate': out.push(...cond.templateIds); break;
      case 'and': for (const item of cond.all) fromCondition(item); break;
      case 'or': for (const item of cond.any) fromCondition(item); break;
      default: break; // not / foreground / always / never contain no template that should appear.
    }
  };
  if (step.kind === 'tapTemplate') out.push(step.templateId);
  else if (step.kind === 'waitFor') fromCondition(step.cond);
  return [...new Set(out)];
}

export function statusText(status: RunStatus): string {
  switch (status) {
    case 'succeeded': return '成功结束';
    case 'failed': return '失败';
    case 'aborted': return '已被手动停止';
    default: return status;
  }
}

