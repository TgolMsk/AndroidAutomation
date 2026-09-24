/**
 * Layer 1 (generic fallback): turn gather and sampling FACTS into CONCLUSIONS (port of the original `detect.ts`).
 *
 * Why a counter of its own: the scheduler's backoff step also grows in the perfectly normal 5/5-queue steady state,
 * and the gather runtime's backoff index is capped and also moves on `queueFull`. Judging 「needs a human」 from them
 * would alert while idling normally. Only real failures count here: gather cycles with outcome 'error' and failed
 * troop-panel samples.
 *
 * Pure verdicts: no disk, no notification, no scheduler call. It answers one question — is this enough for an alert
 * under the current thresholds? — and returns an AlertEvent or null. What happens next is the AlertCenter's job.
 * ★ Thresholds come from AlertDetectConfig through a getter: a settings change applies at once.
 * ★ Counters are memory only on purpose: a restart is a human intervention; carrying old failures over would pause
 *   right after start.
 */
import type { GatherCycleFact } from '@avdm/automation/wanlong';
import {
  isAlertType, makeAlertEvent, pausesInstance, type AlertDetail, type AlertDetectConfig, type AlertEvent, type PausingAlertType,
} from '../../shared/alerts';
import type { AlertLogLevel } from './notifier';

export interface FailureTrackerDeps {
  config(): AlertDetectConfig;
  log(level: AlertLogLevel, message: string, index?: number): void;
  now?(): number;
}

interface Counters {
  /** Consecutive failed cycles (outcome 'error'). */
  cycleFail: number;
  /** Consecutive exhausted recovery ladders (step 'G0'). */
  recoveryFail: number;
  /** Consecutive failed troop-panel samples. */
  sampleFail: number;
  /** Last successful dispatch, or when observation started. */
  lastDispatchAt: number;
  /** Last dispatchStalled alert (one per stall window). */
  stalledNotifiedAt: number | null;
  lastFailReason: string | null;
}

function emptyCounters(now: number): Counters {
  return { cycleFail: 0, recoveryFail: 0, sampleFail: 0, lastDispatchAt: now, stalledNotifiedAt: null, lastFailReason: null };
}

/** The alert type a layer-2 hit becomes (`suspectedKicked`, or `needsAttention` for maintenance / update notices). */
function kickedType(type: string): PausingAlertType {
  return isAlertType(type) && pausesInstance(type) ? type : 'needsAttention';
}

/** Per-instance failure counters. */
export class FailureTracker {
  private readonly counters = new Map<number, Counters>();

  constructor(private readonly deps: FailureTrackerDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private of(index: number): Counters {
    let c = this.counters.get(index);
    if (!c) {
      c = emptyCounters(this.now());
      this.counters.set(index, c);
    }
    return c;
  }

  /** Back to normal (「恢复」, a recovered freeze): start counting afresh. */
  reset(index: number): void {
    this.counters.delete(index);
    this.deps.log('debug', `[告警] 实例 #${index} 的失败计数已清零。`, index);
  }

  peek(index: number): Readonly<Counters> | null {
    const c = this.counters.get(index);
    return c ? { ...c } : null;
  }

  /**
   * Record one gather cycle and maybe produce an event. Order (precise first, fallback last):
   *   ① a layer-2 hit (kicked / maintenance / update)  → at once, no threshold (the evidence is strong)
   *   ② recovery ladder exhausted ≥ threshold          → needsAttention (default 2, earlier than plain failures)
   *   ③ plain failures ≥ threshold                     → consecutiveFailures (default 3)
   *   ④ no dispatch for a long time                    → dispatchStalled (warning, never pauses)
   * ★ queueFull / noResourceWanted / giveUp / staminaLow / circuitBroken are not failures and reset both counters.
   */
  noteCycle(index: number, fact: GatherCycleFact): AlertEvent | null {
    const cfg = this.deps.config();
    const c = this.of(index);
    const now = this.now();
    if (fact.dispatched > 0) {
      c.lastDispatchAt = now;
      c.stalledNotifiedAt = null;
    }
    if (fact.outcome === 'cancelled') return null;

    if (fact.outcome !== 'error') {
      // The game is fine, there was just nothing to do this round: the failure chain is broken.
      if (c.cycleFail > 0 || c.recoveryFail > 0) {
        this.deps.log('info', `[告警] 实例 #${index} 本轮结果为 ${fact.outcome}（非失败），连续失败计数由 ${c.cycleFail} 清零。`, index);
      }
      c.cycleFail = 0;
      c.recoveryFail = 0;
      c.lastFailReason = null;
      return this.checkStalled(index, now, fact);
    }

    c.cycleFail += 1;
    c.lastFailReason = fact.message;
    const recoveryExhausted = fact.step === 'G0';
    c.recoveryFail = recoveryExhausted ? c.recoveryFail + 1 : 0;
    this.deps.log('warn',
      `[告警] 实例 #${index} 采集失败计数 ${c.cycleFail}/${cfg.cycleFailThreshold}` +
      (recoveryExhausted ? `，其中「未知界面恢复阶梯用尽」${c.recoveryFail}/${cfg.recoveryFailThreshold}` : '') +
      `：${fact.message}`, index);

    const detail: AlertDetail = {
      outcome: fact.outcome, step: fact.step, errorCode: fact.errorCode, 连续失败次数: c.cycleFail,
    };

    // ① Layer 2. With the templates missing `fact.kicked` is always null and this degrades to ② / ③.
    if (fact.kicked) {
      this.resetFailCounts(c);
      return makeAlertEvent({
        type: kickedType(fact.kicked.type), instanceIndex: index, at: now, reason: fact.kicked.reason, shotPath: fact.shotPath,
        detail: {
          ...detail,
          ...(fact.kicked.templateId ? { 命中模板: fact.kicked.templateId } : {}),
          ...(typeof fact.kicked.score === 'number' ? { 匹配分: Number(fact.kicked.score.toFixed(3)) } : {}),
        },
      });
    }

    // ② The recovery ladder exhausted several times in a row.
    if (recoveryExhausted && c.recoveryFail >= Math.max(1, cfg.recoveryFailThreshold)) {
      const times = c.recoveryFail;
      this.resetFailCounts(c);
      return makeAlertEvent({
        type: 'needsAttention', instanceIndex: index, at: now, shotPath: fact.shotPath,
        reason:
          `连续 ${times} 轮都回不到世界地图（未知界面恢复阶梯已用尽：关弹窗、返回键、重新拉起游戏都试过了）。` +
          '游戏很可能被顶号踢回了登录界面，或者弹了维护 / 强制更新公告。',
        detail: { ...detail, 恢复阶梯用尽次数: times },
      });
    }

    // ③ Plain consecutive failures.
    if (c.cycleFail >= Math.max(1, cfg.cycleFailThreshold)) {
      const times = c.cycleFail;
      this.resetFailCounts(c);
      return makeAlertEvent({
        type: 'consecutiveFailures', instanceIndex: index, at: now, shotPath: fact.shotPath,
        reason: `连续 ${times} 轮采集都失败，最后一次的原因是：${fact.message}`,
        detail: { ...detail, 连续失败次数: times },
      });
    }
    return null;
  }

  /** After an event the chain restarts (the pause is idempotent, but the history would fill up). */
  private resetFailCounts(c: Counters): void {
    c.cycleFail = 0;
    c.recoveryFail = 0;
  }

  /**
   * The game works but nothing was dispatched for a long time. ★ A warning, never a pause: it is a resource matter
   * (stamina, troops, a full queue) and pausing would only hide an empty queue longer.
   */
  private checkStalled(index: number, now: number, fact: GatherCycleFact): AlertEvent | null {
    const cfg = this.deps.config();
    const c = this.of(index);
    const windowMs = Math.max(1, cfg.stalledMinutes) * 60_000;
    if (fact.dispatched > 0) return null;
    if (now - c.lastDispatchAt < windowMs) return null;
    // Once per stall window.
    if (c.stalledNotifiedAt !== null && now - c.stalledNotifiedAt < windowMs) return null;
    c.stalledNotifiedAt = now;
    const minutes = Math.round((now - c.lastDispatchAt) / 60_000);
    return makeAlertEvent({
      type: 'dispatchStalled', instanceIndex: index, at: now, shotPath: null,
      reason:
        `已经 ${minutes} 分钟没有成功派出过采集队，最近一轮的结果是「${fact.message}」。` +
        '常见原因是兵力不够、行军队列一直占满，或搜索下限太高找不到合格资源点。',
      detail: { outcome: fact.outcome, 停滞分钟: minutes },
    });
  }

  /** A troop-panel sample worked: the offline counter restarts. */
  noteSampleOk(index: number): void {
    const c = this.of(index);
    if (c.sampleFail > 0) this.deps.log('info', `[告警] 实例 #${index} 采样恢复正常，连续采样失败计数由 ${c.sampleFail} 清零。`, index);
    c.sampleFail = 0;
  }

  /**
   * A troop-panel sample failed: N in a row → deviceOffline. ★ The caller filters normal yields
   * (CONCURRENCY_LIMIT: a script or login owns the instance) — the scheduler already does.
   */
  noteSampleFailed(index: number, message: string): AlertEvent | null {
    const cfg = this.deps.config();
    const c = this.of(index);
    c.sampleFail += 1;
    this.deps.log('warn', `[告警] 实例 #${index} 采样失败计数 ${c.sampleFail}/${cfg.sampleFailThreshold}：${message}`, index);
    if (c.sampleFail < Math.max(1, cfg.sampleFailThreshold)) return null;
    const times = c.sampleFail;
    c.sampleFail = 0;
    return makeAlertEvent({
      type: 'deviceOffline', instanceIndex: index, at: this.now(), shotPath: null,
      reason:
        `连续 ${times} 次打不开部队管理面板，最后一次的原因是：${message}。` +
        '模拟器可能已经关闭或崩溃，也可能是 adb 掉线、游戏被系统杀掉了。',
      detail: { 连续采样失败次数: times },
    });
  }
}
