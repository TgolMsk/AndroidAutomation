/**
 * ETA 调度的纯逻辑（原版 state.ts / fatigue.ts / shared/scheduler.ts；断言来自调度设计文档的实测表、
 * sched-offline-check 的排期打印与 alerts-offline-check 的调度段）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  HEALTH_PROBE_REASON,
  MARCH_STATUS_TEXT,
  applySample,
  backoffMs,
  defaultSchedulerConfig,
  deriveMarchView,
  earliestFreeAt,
  emptyInstanceState,
  fatigueAdjustedDoneAt,
  formatDuration,
  freeQueueSlots,
  hasFreeSlot,
  isFatigueExempt,
  isFatigueWindow,
  marchesGone,
  mergeSchedulerConfig,
  nextCstBoundary,
  planNextWake,
  summarizeQueues,
  toMarchState,
  type InstanceQueueState,
  type MarchState,
  type PanelSample,
  type RowSample,
  type TravelHint,
} from '../src/wanlong/pure.js';

const H = 3_600_000;
const MIN = 60_000;
/** 北京时间 y-m-d h:mm 的绝对时刻（显式 UTC+8，与宿主时区无关）。 */
const cst = (y: number, m: number, d: number, h: number, min = 0): number => Date.UTC(y, m - 1, d, h, min) - 8 * H;

function row(patch: Partial<RowSample> = {}): RowSample {
  return {
    slot: 1, status: 'gathering', statusText: '采集中', remainingMs: 2 * H, targetCoord: '615,535',
    troopCount: null, commanders: [], fillRatio: null, resourceType: 'wood', ...patch,
  };
}

const config = defaultSchedulerConfig();
const originalTz = process.env.TZ;
afterEach(() => { process.env.TZ = originalTz; });

describe.each(['America/Los_Angeles', 'Asia/Shanghai', 'UTC'])('深夜疲惫换算（宿主时区 %s）', (tz) => {
  it('按设计文档的实测表把显示倒计时换算成真实完成时刻', () => {
    process.env.TZ = tz;
    expect(fatigueAdjustedDoneAt(cst(2026, 9, 10, 1), 10 * H)).toBe(cst(2026, 9, 10, 9, 24));
    expect(fatigueAdjustedDoneAt(cst(2026, 9, 10, 22), 4 * H)).toBe(cst(2026, 9, 11, 9, 12));
    expect(fatigueAdjustedDoneAt(cst(2026, 9, 10, 10), 2 * H)).toBe(cst(2026, 9, 10, 12));
    expect(fatigueAdjustedDoneAt(cst(2026, 9, 10, 2), 3 * H)).toBe(cst(2026, 9, 10, 5));
    // 宝石矿豁免：原样相加。
    expect(fatigueAdjustedDoneAt(cst(2026, 9, 10, 1), 10 * H, { exempt: isFatigueExempt('gem') })).toBe(cst(2026, 9, 10, 11));
    expect(isFatigueExempt('wood')).toBe(false);
    expect(fatigueAdjustedDoneAt(cst(2026, 9, 10, 1), 0)).toBe(cst(2026, 9, 10, 1));
  });

  it('北京时间边界与疲劳期判定不随宿主时区漂移', () => {
    process.env.TZ = tz;
    expect(nextCstBoundary(cst(2026, 9, 10, 8, 59), 9)).toBe(cst(2026, 9, 10, 9));
    expect(nextCstBoundary(cst(2026, 9, 10, 9), 9)).toBe(cst(2026, 9, 11, 9));
    expect(nextCstBoundary(cst(2026, 9, 10, 23), 0)).toBe(cst(2026, 9, 11, 0));
    expect(isFatigueWindow(cst(2026, 9, 10, 0))).toBe(true);
    expect(isFatigueWindow(cst(2026, 9, 10, 8, 59))).toBe(true);
    expect(isFatigueWindow(cst(2026, 9, 10, 9))).toBe(false);
    expect(isFatigueWindow(cst(2026, 9, 10, 23, 59))).toBe(false);
  });
});

describe('toMarchState：绝对时刻与 travelTime 优先级', () => {
  const at = cst(2026, 9, 10, 12);

  it('采集中：freeAt = 疲劳换算后的完成时刻 + 单程；偏差超过 60s 时给中文说明', () => {
    const day = toMarchState(row(), at, [], config);
    expect(day.gatherDoneAt).toBe(at + 2 * H);
    expect(day.freeAt).toBe(at + 2 * H + 90_000);
    expect(day.travelTimeSource).toBe('unrecorded');
    expect(day.warning).toBeUndefined();

    const night = toMarchState(row({ remainingMs: 4 * H }), cst(2026, 9, 10, 22), [], config);
    expect(night.gatherDoneAt).toBe(cst(2026, 9, 11, 9, 12));
    expect(night.timerEndsAt).toBe(cst(2026, 9, 11, 2));
    expect(night.warning).toContain('晚 7.2 小时');
  });

  it('采集中读不出倒计时：按兜底 ETA 并提示；去程 freeAt 绝不编造；返回中以倒计时为准', () => {
    const unknown = toMarchState(row({ remainingMs: null }), at, [], config);
    expect(unknown.gatherDoneAt).toBeNull();
    expect(unknown.freeAt).toBe(at + config.unknownEtaFallbackSeconds * 1000);
    expect(unknown.warning).toContain('兜底 ETA');

    const marching = toMarchState(row({ status: 'gatherMarching', statusText: '采集行军中', remainingMs: 64_000 }), at, [], config);
    expect(marching.gatherDoneAt).toBeNull();
    expect(marching.freeAt).toBeNull();
    expect(marching.timerEndsAt).toBe(at + 64_000);
    expect(marching.travelTimeSource).toBe('observed');
    expect(marching.travelTimeMs).toBe(90_000);

    const returning = toMarchState(row({ status: 'returning', remainingMs: 30_000 }), at, [], config);
    expect(returning.gatherDoneAt).toBe(at);
    expect(returning.freeAt).toBe(at + 30_000);

    const odd = toMarchState(row({ status: 'unknown', remainingMs: null }), at, [], config);
    expect(odd.freeAt).toBe(at + 300_000);

    const idle = toMarchState(row({ status: 'idle', remainingMs: null, targetCoord: null }), at, [], config);
    expect(idle).toMatchObject({ freeAt: null, travelTimeMs: null, timerEndsAt: null });
  });

  it('pickTravel：坐标命中 > 最近一次派兵 > 观察值 > 兜底；资源类型只在坐标对上时采信', () => {
    const hints: TravelHint[] = [
      { travelTimeMs: 64_000, source: 'dispatch', at: at - 10 * MIN, coord: '615,535', resourceType: 'gold' },
      { travelTimeMs: 40_000, source: 'fallback', at: at - MIN, coord: '700,700', resourceType: 'mana' },
    ];
    const byCoord = toMarchState(row({ resourceType: null }), at, hints, config);
    expect(byCoord).toMatchObject({ travelTimeMs: 64_000, travelTimeSource: 'dispatch', resourceType: 'gold' });
    const latest = toMarchState(row({ targetCoord: '1,1', resourceType: null }), at, hints, config);
    expect(latest).toMatchObject({ travelTimeMs: 40_000, travelTimeSource: 'fallback', resourceType: null });
    const thumb = toMarchState(row({ targetCoord: '1,1', resourceType: 'iron' }), at, hints, config);
    expect(thumb.resourceType).toBe('iron');
  });

  it('applySample 覆盖队列与告警，marchesGone 只按坐标比对', () => {
    const prev = { ...emptyInstanceState(3), auto: true };
    const sample: PanelSample = {
      sampledAt: at, queueUsed: 2, queueTotal: 5, warnings: ['w'],
      rows: [row(), row({ slot: 2, status: 'returning', targetCoord: '700,700', remainingMs: 10_000 })],
    };
    const next = applySample(prev, sample, [], config);
    expect(next).toMatchObject({ queueUsed: 2, queueTotal: 5, lastSampledAt: at, lastSampleOk: true, error: null, warnings: ['w'], auto: true });
    expect(next.marches).toHaveLength(2);
    expect(prev.marches).toHaveLength(0);
    expect(marchesGone(next, { rows: [row({ slot: 1 })] })).toEqual([{ slot: 2, coord: '700,700' }]);
    expect(marchesGone(next, { rows: [row(), row({ targetCoord: '700,700' })] })).toEqual([]);
  });
});

describe('planNextWake：候选、理由字面量、地板与抖动', () => {
  const now = cst(2026, 9, 10, 12);
  const base = (patch: Partial<InstanceQueueState> = {}): InstanceQueueState =>
    ({ ...emptyInstanceState(0), auto: true, lastSampledAt: now, queueUsed: 5, queueTotal: 5, ...patch });
  const march = (patch: Partial<MarchState>): MarchState => ({ ...toMarchState(row(), now, [], config), ...patch });
  const noJitter = { random: () => 0 };
  /** 健康探针关掉，单独看其余候选（探针 3 分钟一次，否则总是它最早）。 */
  const noProbe = mergeSchedulerConfig(config, { healthProbeIntervalMin: 0 });

  it('关着自动调度时不排', () => {
    expect(planNextWake({ ...base(), auto: false }, config, now)).toBeNull();
  });

  it('队列释放校验：freeAt + slack', () => {
    const plan = planNextWake(base({ marches: [march({ freeAt: now + 10 * MIN })] }), noProbe, now, noJitter);
    expect(plan).toEqual({ dueAt: now + 10 * MIN + 60_000, reason: '第 1 队队列释放校验' });
  });

  it('去程：抵达后读采集时长', () => {
    const plan = planNextWake(base({ marches: [march({ status: 'gatherMarching', timerEndsAt: now + 5 * MIN, freeAt: null })] }), noProbe, now, noJitter);
    expect(plan).toEqual({ dueAt: now + 6 * MIN, reason: '第 1 队抵达资源点后读采集时长' });
  });

  it('有空位 / 队列未知：现在就去，但不早于 30s 地板', () => {
    expect(planNextWake(base({ queueUsed: 3 }), config, now, noJitter)).toEqual({ dueAt: now + 30_000, reason: '队列有空位，尽快派遣' });
    expect(planNextWake(base({ queueUsed: null }), config, now, noJitter)).toEqual({ dueAt: now + 30_000, reason: '队列状态未知，先读一次面板' });
    const slow = mergeSchedulerConfig(config, { minSampleIntervalMs: 45_000 });
    expect(planNextWake(base({ queueUsed: 3 }), slow, now, noJitter)?.dueAt).toBe(now + 45_000);
  });

  it('有队伍在外时加疲劳期边界（北京 0 点 / 9 点 + 30s）', () => {
    const evening = cst(2026, 9, 10, 23, 50);
    const plan = planNextWake(base({ lastSampledAt: evening, marches: [march({ freeAt: evening + 5 * H })] }), noProbe, evening, noJitter);
    expect(plan).toEqual({ dueAt: cst(2026, 9, 11, 0) + 30_000, reason: '进入疲劳期，重读倒计时' });
    const morning = cst(2026, 9, 11, 8, 55);
    expect(planNextWake(base({ lastSampledAt: morning, marches: [march({ freeAt: morning + 3 * H })] }), noProbe, morning, noJitter))
      .toEqual({ dueAt: cst(2026, 9, 11, 9) + 30_000, reason: '疲劳期结束，重读倒计时' });
    // 没有队伍在外：不排边界。
    expect(planNextWake(base({ lastSampledAt: evening }), noProbe, evening, noJitter)?.reason).toBe('周期校准');
  });

  it('周期校准与健康探针（字面量不可改）', () => {
    expect(planNextWake(base(), noProbe, now, noJitter)).toEqual({ dueAt: now + 15 * MIN, reason: '周期校准' });
    expect(planNextWake(base(), config, now, { ...noJitter, lastHealthProbeAt: now - MIN })).toEqual({ dueAt: now + 2 * MIN, reason: HEALTH_PROBE_REASON });
    expect(HEALTH_PROBE_REASON).toBe('健康探针');
    // 从没采样过也没探测过：探针按「现在」起算，不会抢走「先读一次面板」。
    expect(planNextWake(base({ lastSampledAt: 0, queueUsed: null }), config, now, noJitter)?.reason).toBe('队列状态未知，先读一次面板');
  });

  it('抖动在 [0, jitterSeconds) 内', () => {
    const plan = planNextWake(base(), noProbe, now, { random: () => 0.999 });
    expect(plan!.dueAt - (now + 15 * MIN)).toBeGreaterThanOrEqual(0);
    expect(plan!.dueAt - (now + 15 * MIN)).toBeLessThan(20_000);
  });
});

describe('退避阶梯、空位判定与本地递推视图', () => {
  it('backoffMs 按阶梯取值、封顶 maxBackoffSeconds，空阶梯退回 30/60/120', () => {
    expect([0, 1, 2, 3, 4, 5, 9].map((step) => backoffMs(config, step) / 1000)).toEqual([30, 30, 60, 120, 240, 300, 300]);
    const capped = mergeSchedulerConfig(config, { maxBackoffSeconds: 100 });
    expect(backoffMs(capped, 4)).toBe(100_000);
    expect(backoffMs({ ...config, retryBackoffSeconds: [] }, 5)).toBe(120_000);
  });

  it('hasFreeSlot / freeQueueSlots：读不出 N/M 是 null，绝不当成有空位', () => {
    expect(hasFreeSlot({ queueUsed: null, queueTotal: 5 })).toBeNull();
    expect(hasFreeSlot({ queueUsed: 5, queueTotal: 5 })).toBe(false);
    expect(hasFreeSlot({ queueUsed: 4, queueTotal: 5 })).toBe(true);
    expect(freeQueueSlots({ queueUsed: null, queueTotal: 5 })).toBeNull();
    expect(freeQueueSlots({ queueUsed: 7, queueTotal: 5 })).toBe(0);
  });

  it('deriveMarchView：去程到点标「待校准」、采集完本地切返回中、载重占比外推', () => {
    const at = 1_000_000;
    const gathering = toMarchState(row({ remainingMs: 100_000, fillRatio: 0.5 }), at, [], config);
    expect(deriveMarchView(gathering, at)).toMatchObject({ phase: 'gathering', remainingMs: 100_000, progress: 0.5 });
    expect(deriveMarchView(gathering, at + 50_000).progress).toBeCloseTo(0.75, 5);
    expect(deriveMarchView(gathering, at + 120_000)).toMatchObject({ phase: 'returning', phaseText: '返回中', remainingMs: 70_000 });
    expect(deriveMarchView(gathering, at + 200_000)).toMatchObject({ phase: 'due', phaseText: '应已归队' });
    const noFill = toMarchState(row({ remainingMs: 100_000, fillRatio: null }), at, [], config);
    expect(deriveMarchView(noFill, at + 50_000).progress).toBeCloseTo(0.5, 5);

    const marching = toMarchState(row({ status: 'gatherMarching', remainingMs: 60_000 }), at, [], config);
    expect(deriveMarchView(marching, at + 30_000)).toMatchObject({ phase: 'marching', remainingMs: 30_000, progress: 0.5 });
    expect(deriveMarchView(marching, at + 61_000)).toMatchObject({ phase: 'due', phaseText: '已抵达，待校准', remainingMs: null });

    const returning = toMarchState(row({ status: 'returning', remainingMs: 10_000 }), at, [], config);
    expect(deriveMarchView(returning, at + 5_000)).toMatchObject({ phase: 'returning', remainingMs: 5_000 });
    expect(deriveMarchView(returning, at + 11_000)).toMatchObject({ phase: 'due', phaseText: '应已归队' });

    expect(deriveMarchView(toMarchState(row({ status: 'idle' }), at, [], config), at).phaseText).toBe('空闲');
    expect(deriveMarchView(toMarchState(row({ status: 'unknown', statusText: '' }), at, [], config), at)).toMatchObject({ phase: 'unknown', phaseText: '未知状态' });
    expect(MARCH_STATUS_TEXT.gatherMarching).toBe('采集行军中');
  });

  it('formatDuration / earliestFreeAt / summarizeQueues', () => {
    expect(formatDuration(null)).toBe('--:--:--');
    expect(formatDuration(Number.NaN)).toBe('--:--:--');
    expect(formatDuration(64_000)).toBe('00:01:04');
    expect(formatDuration(90_061_000)).toBe('1天 01:01:01');
    const at = 5_000;
    const s: InstanceQueueState = {
      ...emptyInstanceState(1), queueUsed: 2, queueTotal: 5, auto: true,
      marches: [toMarchState(row({ remainingMs: 10_000 }), at, [], config), toMarchState(row({ status: 'idle' }), at, [], config)],
    };
    expect(earliestFreeAt(s)).toBe(at + 10_000 + 90_000);
    expect(summarizeQueues([s, emptyInstanceState(2)])).toEqual({
      instances: 2, auto: 1, marchesOut: 1, freeSlots: 3, unknownQueues: 1, earliestFreeAt: at + 100_000,
    });
  });

  it('mergeSchedulerConfig 逐字段夹取，单个字段非法只回退它自己', () => {
    const merged = mergeSchedulerConfig(config, {
      slackSeconds: 99_999, maxRows: 0, sampleTimeoutMs: Number.NaN, retryBackoffSeconds: [10, -1, 20],
      closePanelAfterSample: 'no' as unknown as boolean, healthProbeIntervalMin: 0, templateSetId: '  tset_x  ',
    });
    expect(merged).toMatchObject({
      slackSeconds: 3600, maxRows: 1, sampleTimeoutMs: 60_000, retryBackoffSeconds: [10, 20],
      closePanelAfterSample: true, healthProbeIntervalMin: 0, templateSetId: 'tset_x',
    });
    expect(mergeSchedulerConfig(config, { retryBackoffSeconds: [] }).retryBackoffSeconds).toEqual([30, 60, 120, 240, 300]);
    expect(mergeSchedulerConfig(config, null)).toEqual(config);
  });
});
