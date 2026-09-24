import { afterEach, describe, expect, it } from 'vitest';
import {
  clampToRange, comparePlanRows, cstDayStartOf, defaultPlanConfig, describeTrigger, dueReason, emptyTask, inClockWindow, lastRunAtOf,
  makeTaskId, mergePlanConfig, nextFireAt, parseClock, PLAN_ID_RE, PLAN_PHASE_TEXT, PLAN_RANGE, previousFireAt, sanitizePlan,
  sanitizeTrigger, type TaskTrigger,
} from '../src/shared/plan';

/**
 * Port of wanlong-panel `scripts/plan-offline-check.ts` §一 (trigger pure functions, Beijing time) plus the plan
 * contract's config / sanitize rules. Every case runs under three host time zones: the result must never depend
 * on the host (the original host was America/Los_Angeles).
 */
const MIN = 60_000;
const HOUR = 3_600_000;
const ZONES = ['America/Los_Angeles', 'Asia/Shanghai', 'UTC'] as const;
const originalTz = process.env.TZ;
afterEach(() => { if (originalTz === undefined) delete process.env.TZ; else process.env.TZ = originalTz; });

describe.each(ZONES)('plan triggers in Beijing time (host TZ=%s)', (zone) => {
  it('§一 parses clocks and computes daily / interval / window times', () => {
    process.env.TZ = zone;
    expect(parseClock('08:30')).toBe(8 * HOUR + 30 * MIN);
    expect(parseClock('24:00')).toBeNull();
    expect(parseClock('8:5')).toBeNull();

    // Beijing 08:00 = UTC 00:00; Beijing 2026-09-18 20:00 = UTC 12:00.
    const utcNoon = Date.UTC(2026, 8, 18, 12, 0);
    const daily: TaskTrigger = { kind: 'daily', at: ['08:00', '20:30'] };
    expect(nextFireAt(daily, utcNoon, null)).toBe(Date.UTC(2026, 8, 18, 12, 30));
    expect(nextFireAt(daily, Date.UTC(2026, 8, 18, 13, 0), null)).toBe(Date.UTC(2026, 8, 19, 0, 0));
    expect(previousFireAt(daily, utcNoon)).toBe(Date.UTC(2026, 8, 18, 0, 0));
    expect(previousFireAt(daily, Date.UTC(2026, 8, 17, 23, 0))).toBe(Date.UTC(2026, 8, 17, 12, 30));
    expect(cstDayStartOf(utcNoon)).toBe(Date.UTC(2026, 8, 17, 16, 0));

    const every: TaskTrigger = { kind: 'interval', everyMinutes: 30 };
    expect(nextFireAt(every, utcNoon, null)).toBe(utcNoon);
    expect(nextFireAt(every, utcNoon, utcNoon - 10 * MIN)).toBe(utcNoon + 20 * MIN);
    expect(nextFireAt(every, utcNoon, utcNoon - 5 * HOUR)).toBe(utcNoon);

    const windowed: TaskTrigger = { kind: 'interval', everyMinutes: 30, window: { from: '09:00', to: '23:00' } };
    const beijing3am = Date.UTC(2026, 8, 17, 19, 0);
    expect(nextFireAt(windowed, beijing3am, null)).toBe(Date.UTC(2026, 8, 18, 1, 0));
    expect(nextFireAt(windowed, utcNoon, null)).toBe(utcNoon);

    const overnight = { from: '22:00', to: '06:00' };
    expect(inClockWindow(Date.UTC(2026, 8, 18, 15, 0), overnight)).toBe(true);
    expect(inClockWindow(Date.UTC(2026, 8, 17, 19, 0), overnight)).toBe(true);
    expect(inClockWindow(Date.UTC(2026, 8, 18, 4, 0), overnight)).toBe(false);

    // A Los Angeles daylight-saving change (2026-03-08) moves nothing.
    const dst = Date.UTC(2026, 2, 8, 0, 0);
    expect(nextFireAt({ kind: 'daily', at: ['08:00'] }, dst - 1, null)).toBe(dst);
    expect(previousFireAt({ kind: 'daily', at: ['08:00'] }, dst + 1)).toBe(dst);
  });

  it('§一 describes triggers in Chinese (one text for the page and the logs)', () => {
    process.env.TZ = zone;
    expect(describeTrigger({ kind: 'daily', at: ['08:00', '20:30'] })).toBe('每天 08:00、20:30');
    expect(describeTrigger({ kind: 'daily', at: [] })).toBe('每天（未设时刻）');
    expect(describeTrigger({ kind: 'interval', everyMinutes: 120 })).toBe('每 2 小时');
    expect(describeTrigger({ kind: 'interval', everyMinutes: 45, window: { from: '09:00', to: '23:00' } })).toBe('每 45 分钟（09:00–23:00）');
    expect(describeTrigger({ kind: 'manual' })).toBe('仅手动');
  });
});

describe('dueReason (original PlanRunner.dueReason, now shared)', () => {
  const at = (h: number, m = 0) => Date.UTC(2026, 8, 18, h - 8, m); // Beijing h:m on 2026-09-18
  const daily: TaskTrigger = { kind: 'daily', at: ['08:00'] };
  const catchUp = 30 * MIN;

  it('fires a daily time once, catches up within the window and drops older rounds', () => {
    expect(dueReason(daily, at(8, 0) + 5_000, null, catchUp)).toBe('到点（每天 08:00）');
    expect(dueReason(daily, at(8, 7), null, catchUp)).toBe('补跑错过的触发点（晚了 7 分钟）');
    // §十三: two hours late is not caught up; §十四: five minutes late is.
    expect(dueReason(daily, at(10, 0), null, catchUp)).toBeNull();
    expect(dueReason(daily, at(8, 5), null, catchUp)).not.toBeNull();
    // Already claimed / started this round (★ iron rule 5: a restart at 08:05 does not run it again).
    expect(dueReason(daily, at(8, 5), at(8, 0), catchUp)).toBeNull();
    // A manual run the minute before the time does not count for the round.
    expect(dueReason(daily, at(8, 1), at(7, 59), catchUp)).not.toBeNull();
  });

  it('★ an overdue interval fires once after any downtime (catch-up never applies to intervals)', () => {
    const hourly: TaskTrigger = { kind: 'interval', everyMinutes: 60 };
    // Never ran: now.
    expect(dueReason(hourly, at(12), null, catchUp)).toBe('到点（每 1 小时）');
    // App closed three hours (far beyond catch-up): due now, not stalled forever (old target bug).
    expect(dueReason(hourly, at(15), at(12), catchUp)).not.toBeNull();
    expect(dueReason(hourly, at(15) + 24 * HOUR, at(12), catchUp)).not.toBeNull();
    // Not yet.
    expect(dueReason(hourly, at(12, 59), at(12), catchUp)).toBeNull();
    expect(dueReason(hourly, at(13), at(12), 0)).not.toBeNull();
  });

  it('★ a windowed interval waits outside its window and fires when the window reopens', () => {
    const windowed: TaskTrigger = { kind: 'interval', everyMinutes: 60, window: { from: '09:00', to: '23:00' } };
    const lastEvening = at(22, 30);
    expect(dueReason(windowed, lastEvening + 3 * HOUR, lastEvening, catchUp)).toBeNull(); // 01:30, closed
    expect(dueReason(windowed, at(8, 59) + 24 * HOUR, lastEvening, catchUp)).toBeNull();
    expect(dueReason(windowed, at(9) + 24 * HOUR, lastEvening, catchUp)).not.toBeNull(); // reopened, far beyond catch-up
    expect(nextFireAt(windowed, lastEvening + 3 * HOUR, lastEvening)).toBe(at(9) + 24 * HOUR);
  });

  it('never fires a manual task', () => {
    expect(dueReason({ kind: 'manual' }, at(12), null, catchUp)).toBeNull();
    expect(nextFireAt({ kind: 'manual' }, at(12), null)).toBeNull();
  });

  it('uses the later of the round claim and the last start as the baseline', () => {
    expect(lastRunAtOf(undefined)).toBeNull();
    expect(lastRunAtOf({ lastClaimedAt: null, lastStartedAt: 5 })).toBe(5);
    expect(lastRunAtOf({ lastClaimedAt: 7, lastStartedAt: null })).toBe(7);
    expect(lastRunAtOf({ lastClaimedAt: 7, lastStartedAt: 9 })).toBe(9);
  });
});

describe('plan config, ranges and task defaults', () => {
  it('has the original defaults (aiAssist on, one retry, 8 s preemption grace) plus the script cap', () => {
    expect(defaultPlanConfig()).toEqual({
      version: 1, enabled: false, preemptGraceMs: 8_000, catchUpMs: 30 * MIN, queueWaitMs: 30 * MIN, retry: 1, retryDelayMs: 60_000,
      aiAssist: true, maxConcurrentScripts: 4,
    });
    expect(PLAN_RANGE.maxRunMinutes).toEqual([0, 720]);
    expect(PLAN_RANGE.maxConcurrentScripts).toEqual([1, 16]);
    expect(emptyTask('task_1', 'daily')).toEqual({ id: 'task_1', scriptId: 'daily', enabled: true, trigger: { kind: 'daily', at: ['08:00'] }, priority: 50, maxRunMinutes: 30 });
    expect(PLAN_PHASE_TEXT).toEqual({ idle: '等待', queued: '排队中', running: '执行中', done: '已完成', failed: '失败', skipped: '已跳过' });
  });

  it('clamps and merges field by field: one bad field never voids the config', () => {
    expect(clampToRange(50.5, PLAN_RANGE.priority)).toBe(51);
    expect(clampToRange(Number.NaN, PLAN_RANGE.retry)).toBe(0);
    expect(clampToRange(999, PLAN_RANGE.retry)).toBe(5);
    const merged = mergePlanConfig(defaultPlanConfig(), { retry: 999, preemptGraceMs: -5, aiAssist: 'yes', enabled: true, maxConcurrentScripts: 40 } as never);
    expect(merged).toMatchObject({ retry: 5, preemptGraceMs: 0, aiAssist: true, enabled: true, maxConcurrentScripts: 16, catchUpMs: 30 * MIN });
  });

  it('makes task ids the store accepts', () => {
    const id = makeTaskId(1_700_000_000_000, () => 0.5);
    expect(id).toMatch(/^task_[0-9a-z]+$/);
    expect(PLAN_ID_RE.test(id)).toBe(true);
  });

  it('orders rows by account (zh-CN), then priority desc, then task id', () => {
    const rows = [
      { accountName: '乙', priority: 50, taskId: 'b' }, { accountName: '甲', priority: 10, taskId: 'a' },
      { accountName: '甲', priority: 90, taskId: 'z' }, { accountName: '甲', priority: 90, taskId: 'c' },
    ];
    expect(rows.sort(comparePlanRows).map((row) => `${row.accountName}${row.taskId}`)).toEqual(['甲c', '甲z', '甲a', '乙b']);
  });
});

describe('tolerant sanitizers (original store.ts)', () => {
  it('turns a broken daily trigger into manual, clamps intervals and drops bad windows', () => {
    const warnings: string[] = [];
    const warn = (message: string) => warnings.push(message);
    expect(sanitizeTrigger({ kind: 'daily', at: ['25:00'] }, warn)).toEqual({ kind: 'manual' });
    expect(sanitizeTrigger({ kind: 'daily', at: ['20:30', ' 08:00', '08:00', 'x'] }, warn)).toEqual({ kind: 'daily', at: ['08:00', '20:30'] });
    expect(sanitizeTrigger({ kind: 'interval', everyMinutes: 99_999 }, warn)).toEqual({ kind: 'interval', everyMinutes: 1440 });
    expect(sanitizeTrigger({ kind: 'interval', everyMinutes: 30, window: { from: '9', to: '23:00' } }, warn)).toEqual({ kind: 'interval', everyMinutes: 30 });
    expect(sanitizeTrigger({ kind: 'weekly' }, warn)).toEqual({ kind: 'manual' });
    expect(warnings.some((w) => w.includes('已改成仅手动'))).toBe(true);
  });

  it('drops tasks without ids and duplicate ids (or renames them when importing), clamps numbers', () => {
    const warnings: string[] = [];
    const raw = {
      accountId: 'acc', enabled: true, tasks: [
        { id: 't1', scriptId: 's1', enabled: true, trigger: { kind: 'daily', at: ['25:00'] }, priority: 50.4, maxRunMinutes: 900, params: { n: 1, bad: {} } },
        { id: 't1', scriptId: 's2', enabled: true, trigger: { kind: 'manual' } },
        { scriptId: 's4' },
      ],
    };
    const plan = sanitizePlan(raw, (m) => warnings.push(m))!;
    expect(plan.tasks.map((task) => task.id)).toEqual(['t1']);
    expect(plan.tasks[0]).toMatchObject({ trigger: { kind: 'manual' }, priority: 50, maxRunMinutes: 720, params: { n: 1 } });
    expect(warnings.some((w) => w.includes('重复'))).toBe(true);
    let n = 0;
    const imported = sanitizePlan(raw, () => undefined, { newId: () => `task_new${++n}` })!;
    expect(imported.tasks.map((task) => task.id)).toEqual(['t1', 'task_new1', 'task_new2']);
    expect(sanitizePlan({ enabled: true }, (m) => warnings.push(m))).toBeNull();
  });
});
