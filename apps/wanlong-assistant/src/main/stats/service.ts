import { randomUUID } from 'node:crypto';
import { RESOURCE_NAME, normalizeResourceSnapshot, type ResourceSnapshot, type ResourceType } from '@avdm/automation/wanlong/pure';
import type { StatsSnapshotPush } from '../../shared/ipc/stats';
import {
  STATS_GAME_ID, STATS_RANGE_MAX_DAYS, STATS_RETENTION_DAYS, type DailyStats, type StatsEvent,
} from '../../shared/stats';
import {
  cstDateKey, cstNextDayStart, dateKeyRange, dateKeyToDayStart, shiftDateKey, type DateKey,
} from '../../shared/time';
import { aggregateDay, capSnapshots, mostDispatchedResource, sortFacts } from './aggregate';
import { StatsError, assertDateKey, isRealDateKey } from './errors';
import { FACT_LIMITS, clip, validIndex, type PauseCarryFact, type StatsFact, type TripCompletedFact } from './facts';
import { legacyDailyStatsFacts, migrateInsightsLedger } from './migrate';
import { StatsStore, type OpenPause } from './store';

export type StatsLogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Who is at an instance index right now (identity + the account bound to that exact AVD). */
export interface StatsInstanceInfo {
  createdAt: string | null;
  accountName: string | null;
}

/**
 * What really holds for an instance the ledger still counts as paused (see `StatsService.reconcilePauses`):
 * 'paused' the auto switch is still off; 'resumed' it is on (the resume fact was lost); 'gone' no AVD at that index;
 * 'unknown' could not tell (the pause is kept).
 */
export type StatsPauseReality = 'paused' | 'resumed' | 'gone' | 'unknown';

export interface StatsServicePorts {
  /** Identity (`record.createdAt`) and bound account name of the AVD at `index`; cached for a minute. */
  instanceInfo?(index: number): Promise<StatsInstanceInfo>;
  /**
   * The scheduler's real auto switch and the AVD's existence for these indexes. With this port the open pauses read
   * back at start are only carried over missed days after `reconcilePauses()` checked them; every midnight checks
   * them again before carrying them into the new day.
   */
  pauseStates?(indexes: readonly number[]): Promise<ReadonlyMap<number, StatsPauseReality>>;
  /** 「读一次资源统计」: read the resource table inside the instance lock. Absent → a Chinese「未接线」error. */
  snapshotNow?(index: number): Promise<ResourceSnapshot>;
  /** Today's bucket changed (throttled to one per second; the new empty day right after midnight). */
  onToday?(stats: DailyStats): void;
  /** A snapshot was recorded. */
  onSnapshot?(push: StatsSnapshotPush): void;
  log?(level: StatsLogLevel, message: string): void;
  now?(): number;
  /** Import the old insights ledger once at start (default true). */
  migrateInsights?: boolean;
}

/** Disk writes of today's facts are debounced (a dispatch sends several facts at once). */
const SAVE_DEBOUNCE_MS = 1_000;
/** `stats-today` pushes are throttled. */
const EMIT_THROTTLE_MS = 1_000;
/** Account names / identities are looked up again after this. */
const INFO_TTL_MS = 60_000;
/** setTimeout's largest delay. */
const MAX_TIMER_MS = 2_147_483_647;
/** Wake a little after midnight so the date has certainly turned. */
const ROLLOVER_GRACE_MS = 1_000;
/** A query that arrives before `start()` waits this long for it (the page may ask while the app is still starting). */
const START_WAIT_MS = 60_000;
/** The pause check never holds the fact chain longer than this (the emulator manager may still be opening). */
const PAUSE_CHECK_TIMEOUT_MS = 15_000;

/**
 * 「每日数据统计」 (original StatsCenter): facts in → Beijing day ledgers on disk → buckets for the page and the bot.
 *
 *  · `record()` is synchronous and never throws: a statistics problem must never break gathering. Facts are applied
 *    in order on one internal chain (the instance identity and account name are looked up first, cached).
 *  · Today's facts live in memory and are written with a 1 s debounce; a fact of an earlier day goes straight into
 *    that day's file; a fact of a later day (the timer slept) rolls the day over first.
 *  · Beijing midnight: a timer (next midnight + 1 s) switches the day, writes a `pauseCarry` for every pause still
 *    open (the pause continues from 00:00) and pushes the new, empty day at once.
 *  · Events arriving before `start()` wait for it; after `stop()` they are dropped with a warning.
 */
export class StatsService {
  readonly gameId: string;
  private readonly store: StatsStore;
  private readonly now: () => number;
  private todayKey: DateKey = '';
  private todayFacts: StatsFact[] = [];
  private todayIds = new Set<string>();
  private dirty = false;
  private openPauses = new Map<number, OpenPause>();
  /** Dispatch bookkeeping `${index}|${coord}` → resource, for trips that come home (kept across days). */
  private readonly coordResource = new Map<string, ResourceType>();
  private readonly info = new Map<number, { at: number; value: StatsInstanceInfo }>();
  private chain: Promise<void>;
  /** Resolves once `start()` has finished (or `stop()` ran first): early events and queries wait for it. */
  private readonly startGate: Promise<void>;
  private openGate!: () => void;
  private startPromise: Promise<void> | null = null;
  /** Carrying the pauses read back at start waits for `reconcilePauses()` (only with the `pauseStates` port). */
  private backfillPending = false;
  private stopped = false;
  private saveTimer?: NodeJS.Timeout;
  private emitTimer?: NodeJS.Timeout;
  private rolloverTimer?: NodeJS.Timeout;

  constructor(private readonly home: string, private readonly ports: StatsServicePorts = {}, gameId = STATS_GAME_ID) {
    this.gameId = gameId;
    this.now = ports.now ?? Date.now;
    this.store = new StatsStore(home, gameId, (message) => this.log('warn', message));
    this.startGate = new Promise<void>((resolve) => { this.openGate = resolve; });
    this.chain = this.startGate;
  }

  // ── lifecycle ───────────────────────────────────────────────────────────

  /** Load today, import the old ledger once, carry open pauses over missed midnights, prune, arm the timer. */
  start(): Promise<void> {
    this.startPromise ??= this.doStart().finally(() => this.openGate());
    return this.startPromise;
  }

  private async doStart(): Promise<void> {
    const now = this.now();
    this.todayKey = cstDateKey(now);
    try { this.openPauses = await this.store.readPauses(); }
    catch (error) { this.log('warn', `读取暂停状态失败，按没有暂停处理：${messageOf(error)}`); }
    if (this.ports.migrateInsights !== false) {
      try {
        const result = await migrateInsightsLedger({ home: this.home, gameId: this.gameId, store: this.store, now, warn: (m) => this.log('warn', m) });
        if (result.ran && result.facts > 0) this.log('info', `已把旧版统计（${result.days} 天、${result.facts} 条记录）并入数据统计。`);
      } catch (error) {
        this.log('warn', `导入旧统计日账失败（下次启动再试）：${messageOf(error)}`);
      }
    }
    try { this.setToday(this.todayKey, await this.store.readDay(this.todayKey)); }
    catch (error) {
      this.log('error', `读取今天的统计失败，本次从空账开始：${messageOf(error)}`);
      this.setToday(this.todayKey, []);
    }
    // Trips that come home after a restart still find the resource they were sent for.
    try {
      const yesterday = await this.store.readDay(shiftDateKey(this.todayKey, -1));
      for (const fact of sortFacts([...yesterday, ...this.todayFacts])) this.noteCoord(fact);
    } catch { /* bookkeeping only */ }
    // With the pause check, pauses are carried only after `reconcilePauses()`: an instance deleted (or resumed with the
    // resume fact lost) while the app was closed must not gain a 24-hour pause for every missed day.
    if (this.ports.pauseStates && this.openPauses.size > 0) this.backfillPending = true;
    else await this.backfillCarries();
    this.armRolloverTimer();
    void this.prune(now);
    this.log('info', `数据统计已就绪：今天（北京）${this.todayKey}，已有派兵 ${this.today().dispatches} 次。`);
  }

  /** Write what is pending, wait for queued facts, stop the timers. Later events are dropped with a warning. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (!this.startPromise) this.openGate();
    for (const timer of [this.saveTimer, this.emitTimer, this.rolloverTimer]) if (timer) clearTimeout(timer);
    this.saveTimer = this.emitTimer = this.rolloverTimer = undefined;
    await this.chain.catch(() => undefined);
    if (this.startPromise) await this.flushSave();
  }

  /** Resolves once every fact recorded so far has been applied (tests, snapshotNow). */
  async idle(): Promise<void> {
    await this.chain.catch(() => undefined);
  }

  /** Apply everything queued and write today's facts now instead of after the debounce. */
  flush(): Promise<void> {
    return this.enqueue(() => this.flushSave());
  }

  // ── recording ───────────────────────────────────────────────────────────

  /** Record one fact. ★ Synchronous and never throws: a statistics problem must never break gathering. */
  record(event: StatsEvent): void {
    void this.recordAsync(event);
  }

  /** `record()` that resolves when the fact is applied (never rejects). */
  recordAsync(event: StatsEvent): Promise<void> {
    try {
      if (this.stopped) {
        this.log('warn', `数据统计已停止，事件 ${String(event?.kind)} 被丢弃。`);
        return Promise.resolve();
      }
      if (!event || typeof event !== 'object') {
        this.log('warn', `未知事件种类，已忽略：${safeJson(event)}`);
        return Promise.resolve();
      }
      const at = Number.isFinite(event.at) ? event.at : this.now();
      const e = at === event.at ? event : { ...event, at };
      return this.enqueue(() => this.apply(e));
    } catch (error) {
      this.log('error', `记录事件 ${String((event as { kind?: unknown } | null)?.kind ?? '?')} 失败（已忽略）：${messageOf(error)}`);
      return Promise.resolve();
    }
  }

  /** A resource-table snapshot read by any path (page, bot); returns once it is in its day bucket. */
  recordSnapshot(snapshot: ResourceSnapshot): Promise<void> {
    const snap = normalizeResourceSnapshot(snapshot);
    if (!snap) {
      this.log('warn', '资源统计快照格式不对，没有记入统计。');
      return Promise.resolve();
    }
    return this.recordAsync({ kind: 'snapshot', at: snap.at, instanceIndex: snap.instanceIndex, snapshot: snap });
  }

  /**
   * Check the open pauses against reality (`pauseStates` port; call it once the scheduler has restored its state):
   * a pause whose instance is gone, or whose auto switch is on again (the resume fact was lost to a crash or a failed
   * write), is closed — today's open span ends now — and never carried again. Then the remaining pauses are carried
   * over the days the app was closed. Never throws; without the port it does nothing.
   */
  reconcilePauses(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.todayKey || this.stopped) return;
      const closed = await this.checkOpenPauses(true);
      let carried = false;
      if (this.backfillPending) {
        this.backfillPending = false;
        const before = this.todayFacts.length;
        await this.backfillCarries();
        carried = this.todayFacts.length !== before;
      }
      if (closed.length > 0 || carried) this.scheduleEmit();
    });
  }

  /** Switch the day if Beijing midnight has passed (the timer calls this; tests pass a fake time). */
  checkRollover(at: number = this.now()): Promise<void> {
    return this.enqueue(() => this.rollTo(at));
  }

  /**
   * Explicit 「导入旧版数据」 of wanlong-panel day buckets (`<dataDir>/stats/<YYYY-MM-DD>.json`). Idempotent (fact
   * ids are deterministic); days outside the retention window are skipped. `mapIndex` maps old instance indexes onto
   * current AVD indexes (null = skip that instance).
   */
  async importLegacyDays(days: ReadonlyArray<{ dateKey: string; raw: unknown }>, mapIndex?: (legacyIndex: number) => number | null): Promise<{ days: number; facts: number }> {
    const result = { days: 0, facts: 0 };
    let failure: unknown = null;
    await this.enqueue(async () => {
      if (!this.todayKey) { failure = new StatsError('STEP_FAILED', '数据统计模块尚未启动。'); return; }
      const oldest = shiftDateKey(this.todayKey, -(STATS_RETENTION_DAYS - 1));
      for (const { dateKey, raw } of days) {
        if (!isRealDateKey(dateKey) || dateKey < oldest || dateKey > this.todayKey) continue;
        const facts = legacyDailyStatsFacts(raw, dateKey, mapIndex);
        if (facts.length === 0) continue;
        try {
          if (dateKey === this.todayKey) {
            await this.flushSave();
            this.setToday(dateKey, await this.store.appendFacts(dateKey, facts));
            this.scheduleEmit();
          } else {
            await this.store.appendFacts(dateKey, facts);
          }
        } catch (error) {
          failure = error;
          return;
        }
        result.days++;
        result.facts += facts.length;
      }
    });
    if (failure) throw failure;
    return result;
  }

  // ── queries ─────────────────────────────────────────────────────────────

  /** Today's bucket (a fresh object; pauses still running today are in `pausedSince`). */
  today(): DailyStats {
    const now = this.now();
    const key = this.todayKey || cstDateKey(now);
    return aggregateDay(this.gameId, key, key === this.todayKey ? this.todayFacts : [], now);
  }

  /** One day; omitted = today. A day without data is an empty bucket, never null. */
  async daily(key?: DateKey | null): Promise<DailyStats> {
    if (key !== undefined && key !== null) assertDateKey(key);
    await this.ready();
    const k = key ?? this.todayKey;
    if (k === this.todayKey) return this.today();
    return aggregateDay(this.gameId, k, await this.store.readDay(k), this.now());
  }

  /** Every day in [from, to] (both included, at most 366). */
  async range(from: DateKey, to: DateKey): Promise<DailyStats[]> {
    if (!assertValid(from) || !assertValid(to)) {
      throw new StatsError('INVALID_ARGUMENT', `日期格式应为 YYYY-MM-DD，收到：${String(from)} ~ ${String(to)}`);
    }
    if (dateKeyToDayStart(from) > dateKeyToDayStart(to)) throw new StatsError('INVALID_ARGUMENT', `起始日期 ${from} 晚于结束日期 ${to}。`);
    const keys = dateKeyRange(from, to).slice(0, STATS_RANGE_MAX_DAYS);
    const out: DailyStats[] = [];
    for (const key of keys) out.push(await this.daily(key));
    return out;
  }

  /** 「读一次资源统计」: the wiring reads the table inside the instance lock; the snapshot becomes today's. */
  async snapshotNow(index: number): Promise<ResourceSnapshot> {
    const read = this.ports.snapshotNow;
    if (!read) throw new StatsError('STEP_FAILED', '资源统计读取尚未接线（snapshotNow 未提供），暂时无法从面板读取。');
    if (!validIndex(index)) throw new StatsError('INVALID_ARGUMENT', `实例序号非法：${String(index)}`);
    const snapshot = await read(index);
    await this.recordSnapshot(snapshot);
    return snapshot;
  }

  // ── internals ───────────────────────────────────────────────────────────

  /**
   * Queries wait for the start gate instead of failing: the page can ask before the app's `restore()` reaches the
   * statistics (the shell reopens the last page right away). Only a start that never comes is an error.
   */
  private async ready(): Promise<void> {
    if (!this.startPromise && !this.stopped) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        this.startGate,
        new Promise<void>((resolve) => { timer = setTimeout(resolve, START_WAIT_MS); timer.unref?.(); }),
      ]);
      clearTimeout(timer);
      if (!this.startPromise && !this.stopped) throw new StatsError('STEP_FAILED', '数据统计模块尚未启动，请稍后再试。');
    }
    await this.startPromise?.catch(() => undefined);
  }

  private enqueue(job: () => Promise<void>): Promise<void> {
    const next = this.chain.then(job).catch((error: unknown) => this.log('error', `统计处理失败（已忽略）：${messageOf(error)}`));
    this.chain = next;
    return next;
  }

  private async apply(event: StatsEvent): Promise<void> {
    if (!event || typeof event !== 'object' || !EVENT_KINDS.has(event.kind)) {
      this.log('warn', `未知事件种类，已忽略：${safeJson(event)}`);
      return;
    }
    if (!this.todayKey) {
      this.log('warn', `数据统计没有启动，事件 ${String(event.kind)} 被丢弃。`);
      return;
    }
    if (!validIndex(event.instanceIndex)) {
      this.log('warn', `事件 ${String(event.kind)} 的实例序号无效（${String(event.instanceIndex)}），已忽略。`);
      return;
    }
    const info = await this.infoOf(event.instanceIndex);
    const fact = this.factOf(event, info);
    if (fact) await this.append(fact);
  }

  private factOf(event: StatsEvent, info: StatsInstanceInfo): StatsFact | null {
    const base = { at: event.at, index: event.instanceIndex, instance: info.createdAt, account: info.accountName };
    const id = (kind: string) => `${kind}:${randomUUID()}`;
    switch (event.kind) {
      case 'dispatch':
        return {
          ...base, id: id('d'), kind: 'dispatch', resource: event.resource,
          storage: typeof event.storage === 'number' && Number.isFinite(event.storage) && event.storage >= 0 ? event.storage : null,
          coord: event.coord ? clip(event.coord, FACT_LIMITS.coord) : null,
          level: finiteOrNull(event.level), travelTimeSec: finiteOrNull(event.travelTimeSec),
        };
      case 'cycleFailed':
        return {
          ...base, id: id('f'), kind: 'cycleFailed', outcome: event.outcome, message: clip(event.message ?? '', FACT_LIMITS.message),
          step: event.step ? clip(event.step, FACT_LIMITS.step) : null,
          errorCode: event.errorCode ? clip(event.errorCode, FACT_LIMITS.errorCode) : null,
        };
      case 'tripCompleted':
        // Without the event's own resource this is a placeholder: `append` resolves it against the day's dispatches
        // (coordinate → top resource) or drops the trip; `via: 'coord'` marks it as not yet resolved.
        return {
          ...base, id: id('t'), kind: 'tripCompleted', coord: event.coord ? clip(event.coord, FACT_LIMITS.coord) : null,
          resource: event.resource ?? 'wood', via: event.resource ? 'event' : 'coord',
        };
      case 'alertRaised':
        return { ...base, id: id('a'), kind: 'alertRaised', alertType: clip(String(event.alertType || 'unknown'), FACT_LIMITS.alertType) };
      case 'paused':
        return { ...base, id: id('p'), kind: 'paused', reason: event.reason ? clip(event.reason, FACT_LIMITS.reason) : null };
      case 'resumed':
        return { ...base, id: id('r'), kind: 'resumed' };
      case 'snapshot':
        return { ...base, id: `snapshot:${event.instanceIndex}:${event.snapshot.at}`, at: event.snapshot.at, kind: 'snapshot', snapshot: event.snapshot };
      default: {
        const never: never = event;
        this.log('warn', `未知事件种类，已忽略：${JSON.stringify(never)}`);
        return null;
      }
    }
  }

  private async append(input: StatsFact): Promise<void> {
    let fact: StatsFact | null = input;
    const key = cstDateKey(fact.at);
    if (key > this.todayKey) await this.rollTo(fact.at);
    if (key === this.todayKey) {
      if (fact.kind === 'tripCompleted') fact = this.resolveTrip(fact, this.todayFacts);
      if (!fact || this.todayIds.has(fact.id)) return;
      this.noteCoord(fact);
      this.todayFacts.push(fact);
      this.todayIds.add(fact.id);
      if (fact.kind === 'snapshot') this.setToday(this.todayKey, capSnapshots(this.todayFacts));
      this.dirty = true;
      this.scheduleSave();
      this.scheduleEmit();
      if (fact.kind === 'paused' || fact.kind === 'resumed') await this.notePause(fact);
    } else {
      // An earlier day (a late fact): fold it into that day's file; today is untouched.
      const dayFacts = await this.store.readDay(key);
      if (fact.kind === 'tripCompleted') fact = this.resolveTrip(fact, dayFacts);
      if (!fact) return;
      this.noteCoord(fact);
      await this.store.appendFacts(key, [fact]);
    }
    if (fact.kind === 'snapshot') {
      try { this.ports.onSnapshot?.({ gameId: this.gameId, dateKey: key, snapshot: fact.snapshot }); }
      catch (error) { this.log('warn', `推送快照失败：${messageOf(error)}`); }
    }
  }

  /**
   * The original resolution chain: the event's own resource → the dispatch bookkeeping by coordinate → the resource
   * this instance dispatched most that day → the one dispatched most overall. Nothing dispatched that day: the trip
   * is dropped with a note (usually a march sent yesterday whose bookkeeping was lost), never guessed.
   */
  private resolveTrip(fact: TripCompletedFact, dayFacts: readonly StatsFact[]): TripCompletedFact | null {
    const coordKey = `${fact.index}|${fact.coord ?? ''}`;
    const booked = fact.coord ? this.coordResource.get(coordKey) : undefined;
    if (fact.coord) this.coordResource.delete(coordKey);
    if (fact.via === 'event') return fact;
    if (booked) return { ...fact, resource: booked, via: 'coord' };
    const where = fact.coord ?? '坐标未知';
    const own = mostDispatchedResource(dayFacts, fact.index);
    if (own) {
      this.log('warn', `实例 ${fact.index} 的队伍（${where}）回城时查不到资源类型，按该实例今日派兵最多的资源归类：${RESOURCE_NAME[own]}。`);
      return { ...fact, resource: own, via: 'instanceTop' };
    }
    const all = mostDispatchedResource(dayFacts, null);
    if (all) {
      this.log('warn', `实例 ${fact.index} 的队伍（${where}）回城时查不到资源类型，按全局今日派兵最多的资源归类：${RESOURCE_NAME[all]}。`);
      return { ...fact, resource: all, via: 'globalTop' };
    }
    this.log('warn', `实例 ${fact.index} 的队伍（${where}）回城，但今天没有任何派兵记录可归类，此趟未计入完成趟数。`);
    return null;
  }

  private noteCoord(fact: StatsFact): void {
    if (fact.kind === 'dispatch' && fact.coord) this.coordResource.set(`${fact.index}|${fact.coord}`, fact.resource);
    else if (fact.kind === 'tripCompleted' && fact.coord) this.coordResource.delete(`${fact.index}|${fact.coord}`);
  }

  /** Keep the open-pause file current: a paused start is never moved later; a resumed closes it. */
  private async notePause(fact: StatsFact): Promise<void> {
    let changed = false;
    if (fact.kind === 'paused' && !this.openPauses.has(fact.index)) {
      this.openPauses.set(fact.index, { since: fact.at, reason: fact.reason, instance: fact.instance, account: fact.account });
      changed = true;
    } else if (fact.kind === 'resumed' && this.openPauses.delete(fact.index)) {
      changed = true;
    }
    if (!changed) return;
    try { await this.store.writePauses(this.openPauses); }
    catch (error) { this.log('warn', `保存暂停状态失败（重启后这段暂停可能少算）：${messageOf(error)}`); }
  }

  /**
   * Ask the `pauseStates` port about every open pause and drop the ones that no longer hold ('gone' / 'resumed').
   * `closeToday`: a dropped pause still open in today's facts gets a `resumed` fact now, so today stops counting it.
   * A failing or slow port keeps every pause (as before the check). @returns the closed indexes
   */
  private async checkOpenPauses(closeToday: boolean): Promise<number[]> {
    const port = this.ports.pauseStates;
    if (!port || this.openPauses.size === 0) return [];
    const indexes = [...this.openPauses.keys()].sort((a, b) => a - b);
    let states: ReadonlyMap<number, StatsPauseReality>;
    let timer: NodeJS.Timeout | undefined;
    try {
      states = await Promise.race([
        port(indexes),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${PAUSE_CHECK_TIMEOUT_MS / 1000} 秒内没有答复`)), PAUSE_CHECK_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
    } catch (error) {
      this.log('warn', `核对暂停状态失败，暂停照旧记账：${messageOf(error)}`);
      return [];
    } finally {
      clearTimeout(timer);
    }
    const now = this.now();
    const closed: number[] = [];
    for (const index of indexes) {
      const state = states.get(index);
      if (state !== 'gone' && state !== 'resumed') continue;
      const pause = this.openPauses.get(index)!;
      this.openPauses.delete(index);
      closed.push(index);
      this.log('info', state === 'gone'
        ? `实例 ${index} 已不存在，它的暂停不再计入之后的日子。`
        : `实例 ${index} 的自动调度已经开着，补记这段暂停的结束（恢复记录丢失）。`);
      if (closeToday && cstDateKey(now) === this.todayKey && this.pauseOpenToday(index)) {
        const fact: StatsFact = { id: `reconcile:${index}:${now}`, kind: 'resumed', at: Math.max(now, pause.since), index, instance: pause.instance, account: null };
        if (!this.todayIds.has(fact.id)) {
          this.todayFacts.push(fact);
          this.todayIds.add(fact.id);
          this.dirty = true;
          this.scheduleSave();
        }
      }
    }
    if (closed.length > 0) {
      try { await this.store.writePauses(this.openPauses); }
      catch (error) { this.log('warn', `保存暂停状态失败：${messageOf(error)}`); }
    }
    return closed;
  }

  /** Whether today's facts leave a pause of this index open (paused / carried, not resumed since). */
  private pauseOpenToday(index: number): boolean {
    let open = false;
    for (const fact of sortFacts(this.todayFacts)) {
      if (fact.index !== index) continue;
      if (fact.kind === 'paused' || fact.kind === 'pauseCarry') open = true;
      else if (fact.kind === 'resumed') open = false;
    }
    return open;
  }

  private carriesFor(key: DateKey): PauseCarryFact[] {
    const dayStart = dateKeyToDayStart(key);
    const out: PauseCarryFact[] = [];
    for (const [index, pause] of this.openPauses) {
      if (pause.since >= dayStart) continue;
      out.push({ id: `carry:${index}:${key}`, kind: 'pauseCarry', at: dayStart, index, instance: pause.instance, account: pause.account, since: pause.since });
    }
    return out;
  }

  /** At start: open pauses continue through every day the app was closed (within the retention window). */
  private async backfillCarries(): Promise<void> {
    if (this.openPauses.size === 0) return;
    const oldest = shiftDateKey(this.todayKey, -(STATS_RETENTION_DAYS - 1));
    const first = [...this.openPauses.values()].reduce((min, pause) => Math.min(min, pause.since), Infinity);
    let key = shiftDateKey(cstDateKey(first), 1);
    if (key < oldest) key = oldest;
    for (let guard = 0; key < this.todayKey && guard < STATS_RETENTION_DAYS; guard++, key = shiftDateKey(key, 1)) {
      const carries = this.carriesFor(key);
      if (carries.length === 0) continue;
      try { await this.store.appendFacts(key, carries); }
      catch (error) { this.log('warn', `补记 ${key} 的暂停失败：${messageOf(error)}`); }
    }
    this.addTodayCarries();
  }

  private addTodayCarries(): void {
    let added = false;
    for (const carry of this.carriesFor(this.todayKey)) {
      if (this.todayIds.has(carry.id)) continue;
      this.todayFacts.push(carry);
      this.todayIds.add(carry.id);
      added = true;
    }
    if (added) { this.dirty = true; this.scheduleSave(); }
  }

  /** Switch to the Beijing day of `at` when it is later than today (original checkRollover + rolloverDay). */
  private async rollTo(at: number): Promise<void> {
    const target = cstDateKey(at);
    if (!this.todayKey || !(target > this.todayKey)) return;
    await this.flushSave();
    // An instance deleted (or resumed without a fact) during the day never carries its pause into the next one; the
    // day it paused closes that span at 24:00 on its own.
    await this.checkOpenPauses(false);
    const from = this.todayKey;
    const oldest = shiftDateKey(target, -(STATS_RETENTION_DAYS - 1));
    let rolled = 1;
    for (let key = shiftDateKey(from, 1); key < target && rolled < STATS_RETENTION_DAYS * 40; key = shiftDateKey(key, 1), rolled++) {
      if (key < oldest || this.openPauses.size === 0) continue;
      try { await this.store.appendFacts(key, this.carriesFor(key)); }
      catch (error) { this.log('warn', `补记 ${key} 的暂停失败：${messageOf(error)}`); }
    }
    let facts: StatsFact[] = [];
    try { facts = await this.store.readDay(target); }
    catch (error) { this.log('warn', `读取 ${target} 的统计失败，从空账开始：${messageOf(error)}`); }
    this.setToday(target, facts);
    this.addTodayCarries();
    this.log('info', `北京时间已过 0 点，统计换到新的一天：${target}（滚过 ${rolled} 天）。`);
    this.emitNow();
    void this.prune(at);
  }

  private setToday(key: DateKey, facts: readonly StatsFact[]): void {
    this.todayKey = key;
    this.todayFacts = [...facts];
    this.todayIds = new Set(this.todayFacts.map((fact) => fact.id));
  }

  private scheduleSave(): void {
    if (this.saveTimer || this.stopped) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.enqueue(() => this.flushSave());
    }, SAVE_DEBOUNCE_MS);
    this.saveTimer.unref?.();
  }

  /** Write today's facts (merged by id with what is on disk). A failed write keeps them dirty for the next try. */
  private async flushSave(): Promise<void> {
    if (!this.dirty || !this.todayKey) return;
    this.dirty = false;
    const key = this.todayKey;
    try {
      const merged = await this.store.appendFacts(key, this.todayFacts);
      if (key === this.todayKey) this.setToday(key, merged);
    } catch (error) {
      this.log('error', `保存 ${key} 的统计失败（下一条记录时再试）：${messageOf(error)}`);
      if (key === this.todayKey) this.dirty = true;
    }
  }

  private scheduleEmit(): void {
    if (this.emitTimer || this.stopped) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = undefined;
      this.emitNow();
    }, EMIT_THROTTLE_MS);
    this.emitTimer.unref?.();
  }

  private emitNow(): void {
    if (this.emitTimer) { clearTimeout(this.emitTimer); this.emitTimer = undefined; }
    try { this.ports.onToday?.(this.today()); }
    catch (error) { this.log('warn', `推送今天的统计失败：${messageOf(error)}`); }
  }

  private armRolloverTimer(): void {
    if (this.rolloverTimer) clearTimeout(this.rolloverTimer);
    if (this.stopped) return;
    const now = this.now();
    const delay = Math.min(MAX_TIMER_MS, Math.max(1_000, cstNextDayStart(now) - now + ROLLOVER_GRACE_MS));
    this.rolloverTimer = setTimeout(() => {
      this.rolloverTimer = undefined;
      void this.checkRollover(this.now());
      this.armRolloverTimer();
    }, delay);
    this.rolloverTimer.unref?.();
  }

  private async prune(now: number): Promise<void> {
    try {
      const removed = await this.store.prune(STATS_RETENTION_DAYS, now);
      if (removed.length > 0) this.log('info', `已清理 ${removed.length} 个超过 ${STATS_RETENTION_DAYS} 天的日统计文件。`);
    } catch (error) {
      this.log('warn', `清理旧统计文件失败：${messageOf(error)}`);
    }
  }

  private async infoOf(index: number): Promise<StatsInstanceInfo> {
    const cached = this.info.get(index);
    const now = this.now();
    if (cached && now - cached.at < INFO_TTL_MS) return cached.value;
    if (!this.ports.instanceInfo) return { createdAt: null, accountName: null };
    try {
      const value = await this.ports.instanceInfo(index);
      const clean: StatsInstanceInfo = {
        createdAt: typeof value?.createdAt === 'string' ? clip(value.createdAt, FACT_LIMITS.instance) : null,
        accountName: typeof value?.accountName === 'string' && value.accountName ? clip(value.accountName, FACT_LIMITS.account) : null,
      };
      this.info.set(index, { at: now, value: clean });
      return clean;
    } catch (error) {
      // Only the display suffers: keep the last known answer and ask again next time.
      this.log('debug', `查询实例 ${index} 的身份与账号失败：${messageOf(error)}`);
      return cached?.value ?? { createdAt: null, accountName: null };
    }
  }

  private log(level: StatsLogLevel, message: string): void {
    try { this.ports.log?.(level, `[统计] ${message}`); } catch { /* logging never breaks statistics */ }
  }
}

const EVENT_KINDS: ReadonlySet<string> = new Set<StatsEvent['kind']>([
  'dispatch', 'cycleFailed', 'tripCompleted', 'alertRaised', 'paused', 'resumed', 'snapshot',
]);

function safeJson(value: unknown): string {
  try { return JSON.stringify(value)?.slice(0, 200) ?? String(value); } catch { return String(value); }
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function assertValid(value: unknown): boolean {
  try { assertDateKey(value); return true; } catch { return false; }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
