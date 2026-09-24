/**
 * AlertCenter: turns a judged event into actions (port of the original `center.ts`).
 *
 *   raise(event)
 *     ├─ enrich the account (never fatal)
 *     ├─ pause when the type pauses (switch the instance's automatic schedule off)      ← idempotent
 *     ├─ persist the pause record and push it to the UI                                 ← pause FIRST
 *     ├─ hand it to the channels (★ a failed push never undoes the pause)
 *     ├─ store the push result in the pause record, the history and the daily ledger
 *     └─ push `alert-raised` to the UI
 *
 * ★ Pause = `EtaScheduler.setAuto(i, false)`: it aborts the in-flight wake, cancels the timer, clears nextWakeAt,
 *   persists and publishes; no path re-arms an instance with auto off. It never takes the instance lock, so it is safe
 *   from inside a hook that runs in the lock (gather cycle facts, sample results, health probes).
 * ★ `resume()` calls `setAuto(i, true)`, which samples and takes the lock: call it only from IPC or the bot, never
 *   from inside the lock (deadlock). It only re-enables what an alert switched off: an instance without an active
 *   pause is refused (turning auto on for the first time goes through the probe + confirmation gate of the host).
 * ★ The scheduler's published queue view reads the pause through `pauseInfo()` (`SchedulerHooks.pauseOf`): the record
 *   is set BEFORE auto goes off (setAuto publishes), and every record change republishes the view (`refreshScheduler`).
 */
import {
  ALERT_HISTORY_LIMIT, ALERT_SPECS, defaultAlertDetectConfig, emptyPauseState, makeAlertEvent, pauseStateFromEvent,
  pausesInstance, renderAlertSummary, type AlertDetectConfig, type AlertEvent, type AlertRecord, type InstancePauseState,
  type NotifyResult,
} from '../../shared/alerts';
import type { SchedulerPauseInfo } from '../../shared/ipc/scheduler';
import type { AlertLogLevel, DispatchOutcome } from './notifier';
import { AlertRecordsStore, type StoredPause } from './records';

/** The part of NotifyHub the center uses (structural, so the center still pauses when pushes are not wired). */
export interface AlertNotifyPort {
  getDetectConfig(): AlertDetectConfig;
  /** Never throws by contract (failures are results). */
  dispatch(event: AlertEvent): Promise<DispatchOutcome>;
  resetThrottleForInstance(instanceIndex: number): Promise<void> | void;
}

export interface AlertCenterPorts {
  notify(): AlertNotifyPort | null;
  /** The pause / resume primitive (`EtaScheduler.setAuto`). ★ false must be idempotent and never re-arm. */
  setAuto(index: number, enabled: boolean, reason?: string): Promise<unknown>;
  /** The account bound to this AVD (same index and instance identity); null when none. */
  accountOf(index: number): Promise<{ id: string; name: string } | null>;
  /** `record.createdAt` of the AVD at this index; null when no instance exists. Throws when it cannot be read. */
  identityOf(index: number): Promise<string | null>;
  /** Clear the failure counters and freeze evidence of an instance (on resume). */
  resetCounters(index: number): void;
  log(level: AlertLogLevel, message: string, index?: number): void;
  onPauseChanged?(pause: InstancePauseState): void;
  /** Republish the scheduler's queue view of the instance (its `pause` comes from `pauseInfo()`). */
  refreshScheduler?(index: number): void;
  onRaised?(record: AlertRecord): void;
  /** Daily ledger (statistics: alerts per day). Info events (resume, test) are not ledger alerts. */
  ledger?(record: AlertRecord): Promise<void>;
}

export interface RaiseOptions {
  /**
   * The scheduler already paused the instance itself (a human-needed update / AI risk, the readiness gate, the
   * consecutive-failure safety pause): the pause record is written even when 「自动暂停」 is off.
   */
  schedulerPaused?: boolean;
}

export class AlertCenter {
  private readonly store: AlertRecordsStore;
  private readonly pauses = new Map<number, StoredPause>();
  private records: AlertRecord[] = [];
  /** Per-instance chain for the pause step (two events at once must not both think they paused). */
  private readonly pauseChains = new Map<number, Promise<unknown>>();
  /** Deliveries still in flight (dispose / tests wait for them). */
  private readonly inFlight = new Set<Promise<unknown>>();
  private disposed = false;
  readonly ready: Promise<void>;

  constructor(home: string, private readonly ports: AlertCenterPorts, now: () => number = Date.now) {
    this.store = new AlertRecordsStore(home, now);
    this.ready = this.init();
    void this.ready.catch(() => undefined);
  }

  private async init(): Promise<void> {
    try {
      const [{ pauses, warnings }, history] = await Promise.all([this.store.loadPauses(), this.store.loadHistory()]);
      for (const warning of [...warnings, ...history.warnings]) this.log('warn', `[告警] ${warning}`);
      for (const pause of pauses) this.pauses.set(pause.instanceIndex, pause);
      this.records = history.records;
      await this.reconcileIdentities([...this.pauses.keys()]);
      const paused = [...this.pauses.values()].filter((pause) => pause.paused).map((pause) => pause.instanceIndex);
      this.log('info', `[告警] 告警中心已就绪，恢复了 ${paused.length} 个处于暂停状态的实例` +
        (paused.length > 0 ? `（实例 ${paused.map((i) => `#${i}`).join('、')}）` : '') + '。');
    } catch (error) {
      this.log('error', `[告警] 读取暂停状态失败，本次从空状态开始：${messageOf(error)}`);
    }
  }

  // ── Queries ─────────────────────────────────────────────────────────────

  /** Every pause record (paused or cleared), sorted; identities are re-checked (a recreated AVD loses its pause). */
  async listPauses(): Promise<InstancePauseState[]> {
    await this.ready;
    await this.reconcileIdentities([...this.pauses.keys()].filter((index) => this.pauses.get(index)?.paused));
    return [...this.pauses.values()].map(toView).sort((a, b) => a.instanceIndex - b.instanceIndex);
  }

  getPause(index: number): InstancePauseState {
    const pause = this.pauses.get(index);
    return pause ? toView(pause) : emptyPauseState(index);
  }

  /** Synchronous (hooks call it in the lock). */
  isPaused(index: number): boolean {
    return this.pauses.get(index)?.paused === true;
  }

  /** The scheduler's queue view (`SchedulerHooks.pauseOf`). */
  pauseInfo(index: number): SchedulerPauseInfo | null {
    const pause = this.pauses.get(index);
    if (!pause?.paused) return null;
    return { reason: pause.reason ?? '已暂停', at: pause.pausedAt ?? 0, ...(pause.type ? { kind: pause.type } : {}) };
  }

  history(limit = ALERT_HISTORY_LIMIT): AlertRecord[] {
    const n = Math.max(1, Math.min(ALERT_HISTORY_LIMIT, Math.floor(Number.isFinite(limit) ? limit : ALERT_HISTORY_LIMIT)));
    return this.records.slice(0, n).map((record) => structuredClone(record));
  }

  /** Thresholds in force (defaults while pushes are not wired; never an error). */
  detectConfig(): AlertDetectConfig {
    try {
      const port = this.ports.notify();
      if (port) return port.getDetectConfig();
    } catch (error) {
      this.log('warn', `[告警] 读取检测阈值失败，本次用默认阈值：${messageOf(error)}`);
    }
    return defaultAlertDetectConfig();
  }

  // ── Raising ─────────────────────────────────────────────────────────────

  /**
   * Handle one event through the whole pipeline and resolve with its record. ★ Never throws: the alert path breaking
   * must never affect gathering or scheduling.
   */
  async raise(event: AlertEvent, options: RaiseOptions = {}): Promise<AlertRecord> {
    const staged = await this.pauseStep(event, options);
    return this.deliver(staged.event, staged.pausedNow);
  }

  /**
   * For hooks inside the instance lock: resolves once the pause (if any) is in force and persisted; the push runs on
   * in the background (a network request of up to a minute must not hold the device lock). Never throws.
   */
  async raiseInLock(event: AlertEvent, options: RaiseOptions = {}): Promise<void> {
    const staged = this.pauseStep(event, options);
    // Tracked from the start (not once the pause is done): `whenIdle()` / `dispose()` never miss a delivery that is
    // about to begin — the pause record is visible (`isPaused`) before `setAuto(false)` returns.
    this.track(staged.then((step) => this.deliver(step.event, step.pausedNow)));
    await staged;
  }

  /** Fire and forget (non-pausing events from anywhere). */
  raiseQuietly(event: AlertEvent, options: RaiseOptions = {}): void {
    this.track(this.raise(event, options));
  }

  /** Wait for every delivery started so far (tests, dispose). */
  async whenIdle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
  }

  private track(work: Promise<unknown>): void {
    const tracked = work.catch((error: unknown) => this.log('error', `[告警] 处理告警时出错：${messageOf(error)}`));
    this.inFlight.add(tracked);
    void tracked.finally(() => this.inFlight.delete(tracked));
  }

  private pauseStep(event: AlertEvent, options: RaiseOptions): Promise<{ event: AlertEvent; pausedNow: boolean }> {
    const index = event.instanceIndex;
    const previous = this.pauseChains.get(index) ?? Promise.resolve();
    const step = previous.catch(() => undefined).then(async () => {
      await this.ready;
      const enriched = await this.enrich(event);
      let pausedNow = false;
      if (pausesInstance(enriched.type) && index >= 0) {
        const detect = this.detectConfig();
        if (!detect.autoPauseEnabled && !options.schedulerPaused) {
          this.log('warn', `[告警] ${renderAlertSummary(enriched)}｜「判定为异常时自动暂停」是关的，本次只记录不暂停。`, index);
        } else {
          // A recreated AVD must not inherit the old pause (and must be pausable afresh).
          await this.reconcileIdentities([index]);
          if (this.isPaused(index)) {
            // Idempotent: never switch off twice, never overwrite the first reason.
            this.log('info', `[告警] 实例 #${index} 已处于暂停状态，本次不重复暂停：${enriched.reason}`, index);
          } else {
            pausedNow = await this.doPause(enriched);
          }
        }
      }
      return { event: enriched, pausedNow };
    });
    this.pauseChains.set(index, step);
    void step.finally(() => { if (this.pauseChains.get(index) === step) this.pauseChains.delete(index); });
    return step.catch((error: unknown) => {
      this.log('error', `[告警] 暂停流程出错：${messageOf(error)}`, index);
      return { event, pausedNow: false };
    });
  }

  /**
   * Record the pause in memory, switch auto off, then persist and publish the record at once (the push result is
   * filled in later). ★ The record comes first: `setAuto` publishes the scheduler's queue view, whose `pause` is read
   * from `pauseInfo()`; recorded afterwards, the published state would say「not paused」. A failed switch rolls the
   * record back.
   */
  private async doPause(event: AlertEvent): Promise<boolean> {
    const index = event.instanceIndex;
    const previous = this.pauses.get(index);
    // The identity is looked up after the switch: nothing may delay the pause itself.
    const pause: StoredPause = { ...pauseStateFromEvent(event, { notified: null, notifyError: null }), instanceIdentity: null };
    this.pauses.set(index, pause);
    try {
      await this.ports.setAuto(index, false, `${ALERT_SPECS[event.type].title}：${event.reason}`);
    } catch (error) {
      if (this.pauses.get(index) === pause) {
        if (previous) this.pauses.set(index, previous);
        else this.pauses.delete(index);
      }
      this.refreshScheduler(index);
      this.log('error', `[告警] 想暂停实例 #${index} 但没成功（自动调度可能还开着，请到采集页手动关闭）：${messageOf(error)}`, index);
      return false;
    }
    let identity: string | null = null;
    try { identity = await this.ports.identityOf(index); } catch { identity = null; }
    const current = this.pauses.get(index);
    const recorded: StoredPause = current?.eventId === pause.eventId ? { ...current, instanceIdentity: identity } : pause;
    if (current?.eventId === pause.eventId) this.pauses.set(index, recorded);
    this.log('warn', `[告警] 已暂停实例 #${index} 的自动调度：${event.reason}`, index);
    await this.persistPausesQuietly();
    this.emitPause(recorded);
    return true;
  }

  private async deliver(event: AlertEvent, pausedNow: boolean): Promise<AlertRecord> {
    const { results, suppressed } = await this.dispatchQuietly(event);
    // Channels that are switched off do not count as「pushed or failed」: nothing was configured for them.
    const attempted = results.filter((result) => result.failure !== 'disabled');
    const ok = attempted.some((result) => result.ok);
    const firstError = attempted.find((result) => !result.ok);
    const notified = attempted.length === 0 ? null : ok;
    const notifyError = ok ? null : firstError?.message ?? null;
    const current = this.pauses.get(event.instanceIndex);
    if (pausedNow && current?.paused && current.eventId === event.id) {
      const updated: StoredPause = { ...current, notified, notifyError };
      this.pauses.set(event.instanceIndex, updated);
      await this.persistPausesQuietly();
      this.emitPause(updated);
    }
    const record: AlertRecord = { event, results, suppressed, pausedNow };
    if (!this.disposed) {
      this.records = [record, ...this.records].slice(0, ALERT_HISTORY_LIMIT);
      await this.store.saveHistory(this.records).catch((error: unknown) => this.log('warn', `[告警] 保存告警历史失败：${messageOf(error)}`));
    }
    if (event.type !== 'instanceResumed' && event.type !== 'test' && this.ports.ledger) {
      await this.ports.ledger(record).catch((error: unknown) => this.log('warn', `[告警] 告警写入统计日账失败：${messageOf(error)}`));
    }
    try { this.ports.onRaised?.(structuredClone(record)); } catch (error) { this.log('warn', `[告警] 推送告警记录到界面失败：${messageOf(error)}`); }
    this.log(ALERT_SPECS[event.type].severity === 'info' ? 'info' : 'warn',
      `[告警] ${renderAlertSummary(event)}｜${pausedNow ? '已暂停该实例' : '未暂停'}｜` +
      (notified === null ? '未配置推送' : ok ? '已推送' : `推送未发出：${firstError?.message ?? '原因未知'}`), event.instanceIndex);
    return record;
  }

  /** ★ Every exception is swallowed here: a broken push must never touch the pause. */
  private async dispatchQuietly(event: AlertEvent): Promise<DispatchOutcome> {
    const port = this.ports.notify();
    if (!port) return { results: [], suppressed: false };
    try {
      return await port.dispatch(event);
    } catch (error) {
      const message = `推送模块内部出错：${messageOf(error)}`;
      this.log('error', `[告警] ${message}`, event.instanceIndex);
      const failed: NotifyResult = { ok: false, channel: 'telegram', failure: 'unknown', message, attempts: 0, elapsedMs: 0, at: Date.now(), retryAfterSec: null };
      return { results: [failed], suppressed: false };
    }
  }

  // ── Resume ──────────────────────────────────────────────────────────────

  /**
   * The user's 「恢复」 (or the bot's). ★ Only from IPC / the bot, never inside the instance lock: `setAuto(true)` samples
   * and takes the lock. The pause is cleared FIRST so a failing first sample can pause again cleanly.
   * ★ Only an active pause can be resumed: this path skips the host's first-enable probe + confirmation gate, so it
   *   may only re-enable what an alert switched off. @throws Chinese when the instance is not paused.
   */
  async resume(index: number): Promise<InstancePauseState> {
    await this.ready;
    // A pause of a deleted / recreated AVD is void (and must not switch the new one on).
    await this.reconcileIdentities([index]);
    const before = this.pauses.get(index);
    if (!before?.paused) {
      throw new Error(`实例 #${index} 当前没有因异常被暂停，无需恢复。要开启自动调度，请到「采集总览」里打开该实例的自动调度开关（首次开启需要先通过只读探针并确认）。`);
    }
    const cleared: StoredPause = { ...emptyPauseState(index), instanceIdentity: before?.instanceIdentity ?? null };
    this.pauses.set(index, cleared);
    try { this.ports.resetCounters(index); } catch (error) { this.log('warn', `[告警] 清零实例 #${index} 的失败计数失败：${messageOf(error)}`, index); }
    try { await this.ports.notify()?.resetThrottleForInstance(index); } catch (error) {
      this.log('warn', `[告警] 清理实例 #${index} 的推送冷却失败：${messageOf(error)}`, index);
    }
    await this.persistPausesQuietly();
    this.emitPause(cleared);
    try {
      await this.ports.setAuto(index, true);
    } catch (error) {
      this.log('error', `[告警] 恢复实例 #${index} 失败：${messageOf(error)}`, index);
      throw new Error(`恢复实例 #${index} 的自动调度失败：${messageOf(error)}`, { cause: error });
    }
    this.log('info', `[告警] 实例 #${index} 已恢复自动调度${before?.reason ? `（此前的暂停原因：${before.reason}）` : ''}。`, index);
    // Close the loop for the user (info, never pauses); a failed push does not affect the resume.
    this.raiseQuietly(makeAlertEvent({
      type: 'instanceResumed', instanceIndex: index,
      reason: before?.paused && before.reason ? `已人工恢复自动调度。此前因「${before.reason}」被暂停。` : '已人工恢复自动调度。',
    }));
    return this.getPause(index);
  }

  /** Forget an instance's pause without resuming (the instance was deleted or replaced). */
  async forget(index: number): Promise<void> {
    await this.ready;
    const pause = this.pauses.get(index);
    if (!pause) return;
    this.pauses.delete(index);
    await this.persistPausesQuietly();
    if (pause.paused) this.emitPause(emptyPauseState(index));
  }

  async dispose(): Promise<void> {
    await Promise.race([this.whenIdle(), new Promise((resolve) => { const timer = setTimeout(resolve, 5_000); timer.unref?.(); })]);
    this.disposed = true;
    await this.persistPausesQuietly();
    await this.store.flush();
  }

  // ── Internals ───────────────────────────────────────────────────────────

  /** Drop pause records whose AVD was deleted or recreated (identity changed). A failed read keeps them. */
  private async reconcileIdentities(indices: number[]): Promise<void> {
    let changed = false;
    for (const index of indices) {
      const pause = this.pauses.get(index);
      if (!pause?.paused || pause.instanceIdentity === null) continue;
      let identity: string | null;
      try { identity = await this.ports.identityOf(index); } catch { continue; }
      if (identity === pause.instanceIdentity) continue;
      this.pauses.set(index, { ...emptyPauseState(index), instanceIdentity: identity });
      changed = true;
      this.log('info', `[告警] 实例 #${index} 已被删除或替换，原来的暂停记录已作废（${pause.reason ?? '无原因'}）。`, index);
      this.emitPause(emptyPauseState(index));
    }
    if (changed) await this.persistPausesQuietly();
  }

  private async enrich(event: AlertEvent): Promise<AlertEvent> {
    if (event.accountName !== null || event.instanceIndex < 0) return event;
    try {
      const account = await this.ports.accountOf(event.instanceIndex);
      return account ? { ...event, accountId: account.id, accountName: account.name } : event;
    } catch {
      // Unknown account only degrades the text to 「未绑定账号」.
      return event;
    }
  }

  private emitPause(pause: InstancePauseState): void {
    this.refreshScheduler(pause.instanceIndex);
    try { this.ports.onPauseChanged?.(toView(pause)); } catch (error) { this.log('warn', `[告警] 推送暂停态到界面失败：${messageOf(error)}`); }
  }

  /** The scheduler's published queue view carries the pause (`pauseInfo`): republish it after every record change. */
  private refreshScheduler(index: number): void {
    try { this.ports.refreshScheduler?.(index); } catch (error) { this.log('warn', `[告警] 刷新实例 #${index} 的调度视图失败：${messageOf(error)}`, index); }
  }

  private async persistPausesQuietly(): Promise<void> {
    try {
      await this.store.savePauses([...this.pauses.values()]);
    } catch (error) {
      // The pause is in force in memory already; losing the file write must not undo it, but it is never silent.
      this.log('error', `[告警] 保存暂停状态失败：${messageOf(error)}`);
    }
  }

  private log(level: AlertLogLevel, message: string, index?: number): void {
    try { this.ports.log(level, message, index); } catch { /* A log sink never breaks alerts. */ }
  }
}

function toView(pause: InstancePauseState & { instanceIdentity?: string | null }): InstancePauseState {
  const { instanceIdentity: _identity, ...view } = pause;
  return structuredClone(view);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
