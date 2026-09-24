import { afterEach, describe, expect, it } from 'vitest';
import {
  cstDateKey, cstDayStart, cstDayStartOf, cstHourOf, cstNextDayStart, cstOffsetOfDay, dateKeyRange, dateKeyToDayStart,
  formatClock, formatCst, formatCstClock, formatCstShort, inClockWindow, isDateKey, nextCstBoundary, nextFireAt,
  nextWindowStart, parseClock, previousFireAt, shiftDateKey, type ClockTrigger,
} from '../src/shared/time';
import { beijingTime } from '../src/renderer/format';
import { cstDateKey as insightDateKey, shiftDateKey as insightShift } from '../src/main/automation/insights/stats';
import { beijingDayStart, inWindow, parseClock as planParseClock } from '../src/main/plans/clock';

const MIN = 60_000;
const HOUR = 3_600_000;
// Beijing 2026-09-09 23:59 = UTC 15:59 (stats-offline-check section 一).
const T_2359 = Date.UTC(2026, 8, 9, 15, 59);
const T_0000 = T_2359 + MIN;
const DAY_A = '2026-09-09';
const DAY_B = '2026-09-10';
const originalTz = process.env.TZ;

afterEach(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

describe('Beijing date keys (stats-offline-check 一、北京日切边界)', () => {
  it('splits days at Beijing midnight', () => {
    expect(cstDateKey(T_2359)).toBe(DAY_A);
    expect(cstDateKey(T_0000)).toBe(DAY_B);
    expect(cstDayStart(T_2359)).toBe(Date.UTC(2026, 8, 8, 16));
    expect(cstNextDayStart(T_2359)).toBe(T_0000);
    expect(dateKeyToDayStart(DAY_A)).toBe(cstDayStart(T_2359));
    expect(shiftDateKey('2026-09-30', 1)).toBe('2026-10-01');
    expect(shiftDateKey('2026-10-01', -1)).toBe('2026-09-30');
  });

  it('gives identical results whatever the host time zone is', () => {
    const results: Record<string, string> = {};
    const localHours: Record<string, number> = {};
    for (const tz of ['America/Los_Angeles', 'Asia/Shanghai', 'UTC']) {
      process.env.TZ = tz;
      results[tz] = `${cstDateKey(T_2359)}|${cstDateKey(T_0000)}|${formatCst(T_2359)}|${cstDayStart(T_2359)}`;
      localHours[tz] = new Date(T_2359).getHours();
    }
    expect(new Set(Object.values(results)).size).toBe(1);
    // Evidence that the host zone really changed underneath.
    expect(new Set(Object.values(localHours)).size).toBe(3);
  });

  it('validates, ranges and rejects invalid input like the original', () => {
    expect(isDateKey('2026-09-09')).toBe(true);
    expect(isDateKey('2026-13-01')).toBe(false);
    expect(isDateKey(20260909)).toBe(false);
    expect(cstDateKey(Number.NaN)).toBe('0000-00-00');
    expect(dateKeyToDayStart('bad')).toBeNaN();
    expect(dateKeyRange('2026-09-29', '2026-10-02')).toEqual(['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']);
    expect(dateKeyRange('2026-10-02', '2026-09-29')).toEqual([]);
    expect(dateKeyRange('2025-01-01', '2027-01-01')).toHaveLength(366);
  });
});

describe('Beijing formatting', () => {
  it('formats absolute times in UTC+8', () => {
    expect(formatCst(T_2359)).toBe('2026-09-09 23:59:00');
    expect(formatCst(T_2359, false)).toBe('2026-09-09 23:59');
    expect(formatCstClock(T_0000 + 5_000)).toBe('00:00:05');
    expect(formatCstShort(T_0000)).toBe('09-10 00:00');
    expect(formatCst(Number.NaN)).toBe('--');
    expect(formatCstClock(Number.POSITIVE_INFINITY)).toBe('--:--:--');
    expect(beijingTime(null)).toBe('—');
    expect(beijingTime(0)).toBe('—');
    expect(beijingTime(T_2359)).toBe('09-09 23:59');
    expect(beijingTime(T_2359, 'full')).toBe('2026-09-09 23:59:00');
    expect(beijingTime(T_2359, 'clock')).toBe('23:59:00');
  });
});

describe('Beijing clock and triggers (plan-offline-check 一、触发时刻)', () => {
  const utcNoon = Date.UTC(2026, 8, 18, 12, 0); // Beijing 2026-09-18 20:00
  const daily: ClockTrigger = { kind: 'daily', at: ['08:00', '20:30'] };

  it('parses and formats clocks', () => {
    expect(parseClock('08:30')).toBe(8 * HOUR + 30 * MIN);
    expect(parseClock(' 08:30 ')).toBe(8 * HOUR + 30 * MIN);
    expect(parseClock('24:00')).toBeNull();
    expect(parseClock('8:5')).toBeNull();
    expect(formatClock(8 * HOUR + 30 * MIN)).toBe('08:30');
    expect(formatClock(-MIN)).toBe('23:59');
    expect(cstOffsetOfDay(utcNoon)).toBe(20 * HOUR);
    expect(cstHourOf(utcNoon)).toBe(20);
    expect(cstDayStartOf(utcNoon)).toBe(Date.UTC(2026, 8, 17, 16, 0));
  });

  it('schedules daily triggers on Beijing clock times', () => {
    expect(nextFireAt(daily, utcNoon, null)).toBe(Date.UTC(2026, 8, 18, 12, 30));
    expect(nextFireAt(daily, Date.UTC(2026, 8, 18, 13, 0), null)).toBe(Date.UTC(2026, 8, 19, 0, 0));
    expect(previousFireAt(daily, utcNoon)).toBe(Date.UTC(2026, 8, 18, 0, 0));
    expect(previousFireAt(daily, Date.UTC(2026, 8, 17, 23, 0))).toBe(Date.UTC(2026, 8, 17, 12, 30));
    expect(nextFireAt({ kind: 'manual' }, utcNoon, null)).toBeNull();
    expect(nextFireAt({ kind: 'daily', at: ['bad'] }, utcNoon, null)).toBeNull();
    expect(previousFireAt({ kind: 'interval', everyMinutes: 5 }, utcNoon)).toBeNull();
  });

  it('schedules interval triggers from the last run and inside windows', () => {
    const every: ClockTrigger = { kind: 'interval', everyMinutes: 30 };
    expect(nextFireAt(every, utcNoon, null)).toBe(utcNoon);
    expect(nextFireAt(every, utcNoon, utcNoon - 10 * MIN)).toBe(utcNoon + 20 * MIN);
    expect(nextFireAt(every, utcNoon, utcNoon - 5 * HOUR)).toBe(utcNoon);
    const windowed: ClockTrigger = { kind: 'interval', everyMinutes: 30, window: { from: '09:00', to: '23:00' } };
    const nightly = Date.UTC(2026, 8, 17, 19, 0); // Beijing 03:00
    expect(nextFireAt(windowed, nightly, null)).toBe(Date.UTC(2026, 8, 18, 1, 0));
    expect(nextFireAt(windowed, utcNoon, null)).toBe(utcNoon);
    expect(nextWindowStart(utcNoon, { from: '09:00', to: '23:00' })).toBe(Date.UTC(2026, 8, 19, 1, 0));
  });

  it('handles windows across midnight and invalid windows', () => {
    const overnight = { from: '22:00', to: '06:00' };
    expect(inClockWindow(Date.UTC(2026, 8, 18, 15, 0), overnight)).toBe(true);
    expect(inClockWindow(Date.UTC(2026, 8, 17, 19, 0), overnight)).toBe(true);
    expect(inClockWindow(Date.UTC(2026, 8, 18, 4, 0), overnight)).toBe(false);
    expect(inClockWindow(utcNoon, { from: 'x', to: '06:00' })).toBe(true);
    expect(inClockWindow(utcNoon, { from: '06:00', to: '06:00' })).toBe(true);
  });

  it('finds the next Beijing hour boundary (scheduler fatigue window)', () => {
    expect(nextCstBoundary(utcNoon, 0)).toBe(Date.UTC(2026, 8, 18, 16, 0));
    expect(nextCstBoundary(utcNoon, 9)).toBe(Date.UTC(2026, 8, 19, 1, 0));
    expect(nextCstBoundary(Date.UTC(2026, 8, 18, 16, 0), 0)).toBe(Date.UTC(2026, 8, 19, 16, 0));
    expect(nextCstBoundary(T_2359, 0)).toBe(cstNextDayStart(T_2359));
  });
});

describe('existing helpers delegate to the shared implementation', () => {
  it('keeps the insights semantics (strict dates, throwing on invalid time)', () => {
    expect(insightDateKey(T_2359)).toBe(cstDateKey(T_2359));
    expect(insightShift('2026-09-30', 1)).toBe('2026-10-01');
    expect(() => insightDateKey(Number.NaN)).toThrow('统计时间无效');
    expect(() => insightShift('2026-02-30', 1)).toThrow('统计日期无效');
    expect(() => insightShift('2026-09-30', 0.5)).toThrow('统计日期无效');
  });

  it('keeps the plans semantics (strict clocks, invalid windows never match)', () => {
    expect(beijingDayStart(T_2359)).toBe(cstDayStart(T_2359));
    expect(planParseClock(' 08:00')).toBeNull();
    expect(planParseClock('08:00')).toBe(parseClock('08:00'));
    expect(inWindow(T_2359, { from: 'x', to: '06:00' })).toBe(false);
    expect(inWindow(Date.UTC(2026, 8, 18, 15, 0), { from: '22:00', to: '06:00' })).toBe(true);
  });
});
