/**
 * 技能层的纯部分：契约的影子对账、万龙的游戏状态快照、采集技能的预判，以及它与采集流程共用的名额规则。
 */
import { describe, expect, it } from 'vitest';
import { auditVerdict, blockedVerdict, readyVerdict } from '../src/skills.js';
import { pickResource, wantedResources } from '../src/wanlong/gather/quota.js';
import { createRuntimeState, type GatherRuntimeState } from '../src/wanlong/gather/types.js';
import {
  buildGameState,
  checkGather,
  emptyInstanceState,
  gatherSkill,
  gatherSkillOutcome,
  normalizeGatherConfig,
  type InstanceQueueState,
  type MarchState,
} from '../src/wanlong/pure.js';

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const H = 60 * MIN;

function march(patch: Partial<MarchState> = {}): MarchState {
  return {
    slot: 1, status: 'gathering', statusText: '采集中', targetCoord: null, troopCount: null, commanders: [],
    remainingMs: null, timerEndsAt: null, gatherDoneAt: null, freeAt: null, travelTimeMs: null,
    travelTimeSource: 'unrecorded', resourceType: null, sampledAt: NOW, ...patch,
  };
}

function queue(used: number | null, total: number | null, marches: MarchState[] = []): InstanceQueueState {
  return { ...emptyInstanceState(3), accountId: 'acc-1', queueUsed: used, queueTotal: total, marches, lastSampledAt: NOW, lastSampleOk: true };
}

/** 本引擎派过的队：坐标记在 travelTimeByCoord / resourceByCoord 里。 */
function runtime(own: Record<string, 'wood' | 'gold' | 'iron' | 'mana'>, patch: Partial<GatherRuntimeState> = {}): GatherRuntimeState {
  const state = createRuntimeState();
  for (const [coord, resource] of Object.entries(own)) {
    state.travelTimeByCoord[coord] = 60;
    state.resourceByCoord[coord] = resource;
  }
  return { ...state, ...patch };
}

// 默认配置：木材 2 队、金币 1 队、铁矿 1 队，魔水关闭；并发上限 5，不预留。
const config = (patch: Parameters<typeof normalizeGatherConfig>[0] = {}) => normalizeGatherConfig({ enabled: true, ...patch });

describe('skill contract', () => {
  it('audits a verdict against what the run really did (shadow mode)', () => {
    expect(auditVerdict(readyVerdict('可派'), { outcome: 'done' })).toBe('agree');
    expect(auditVerdict(blockedVerdict('满了'), { outcome: 'idle' })).toBe('agree');
    expect(auditVerdict(blockedVerdict('熔断'), { outcome: 'deferred' })).toBe('agree');
    expect(auditVerdict(readyVerdict('可派'), { outcome: 'idle' })).toBe('falseReady');
    expect(auditVerdict(blockedVerdict('满了'), { outcome: 'done' })).toBe('falseBlocked');
    expect(blockedVerdict('冷却', 123)).toEqual({ ready: false, reason: '冷却', retryAt: 123 });
    expect(readyVerdict('可派')).toEqual({ ready: true, reason: '可派', retryAt: null });
  });
});

describe('shared gather quota (flow.ts and the skill check use the same rules)', () => {
  it('counts this round\'s own dispatches even when the panel row coordinate was unreadable', () => {
    const cfg = config();
    // 面板上那支刚派出的伐木场坐标没读出来：记账查不到它采什么，只能靠本轮 dispatched 兜底。
    const inFlight = [{ coord: null, ownDispatch: false }];
    expect(pickResource(cfg, inFlight, [])?.type).toBe('wood');
    expect(wantedResources(cfg, inFlight, [{ coord: '10,20', resource: 'wood' }, { coord: '11,21', resource: 'wood' }]).map((e) => e.type))
      .toEqual(['gold', 'iron']);
    // 坐标已在面板行认出来的，不重复计数。
    const seen = [{ coord: '10,20', ownDispatch: true, resource: 'wood' as const }];
    expect(wantedResources(cfg, seen, [{ coord: '10,20', resource: 'wood' }]).map((e) => e.type)).toEqual(['wood', 'gold', 'iron']);
  });
});

describe('buildGameState', () => {
  it('attributes marches to the engine by the dispatch bookkeeping and computes free slots and wanted resources', () => {
    const marches = [
      march({ slot: 1, targetCoord: '100,200', resourceType: 'wood', freeAt: NOW + 30 * MIN }),
      march({ slot: 2, targetCoord: '300,400', resourceType: 'wood', freeAt: NOW + 10 * MIN }),
      // 手动派的金矿：面板缩略图认得出资源，但不在记账里 —— 不占自动采集的配额（与 flow.ts 一致）。
      march({ slot: 3, targetCoord: '500,600', resourceType: 'gold', freeAt: NOW + 20 * MIN }),
      march({ slot: 4, status: 'idle', statusText: '空闲' }),
    ];
    const game = buildGameState({
      queue: queue(3, 5, marches), config: config(), runtime: runtime({ '100,200': 'wood', '300,400': 'wood' }), now: NOW,
    });
    expect(game).toMatchObject({ instanceIndex: 3, accountId: 'acc-1', at: NOW, pausedReason: null });
    expect(game.queue).toMatchObject({ used: 3, total: 5, sampledAt: NOW, nextFreeAt: NOW + 10 * MIN });
    expect(game.queue.marches.map((m) => [m.coord, m.resource, m.own])).toEqual([
      ['100,200', 'wood', true], ['300,400', 'wood', true], ['500,600', 'gold', false],
    ]);
    expect(game.gather).toMatchObject({
      enabled: true, reserveQueues: 0, maxConcurrent: 5, ownOut: 2, freeSlots: 2, wanted: ['gold', 'iron'],
      cooldownUntil: null, dispatchesLastHour: 0, maxDispatchesPerHour: 30, circuitUntil: null, bookkeeping: true,
    });
  });

  it('applies the reserve and the concurrency cap, counting unreadable coordinates as the engine\'s own', () => {
    const marches = [march({ targetCoord: null }), march({ targetCoord: '1,1' })];
    const cfg = config({ queuePlan: { reserveQueues: 1, maxConcurrentGather: 2 } });
    const game = buildGameState({ queue: queue(2, 5, marches), config: cfg, runtime: runtime({ '1,1': 'iron' }), now: NOW });
    // 队列：5 − 2 − 预留 1 = 2；并发：上限 2 − 在外 2（坐标读不出的也算自己的）= 0。
    expect(game.gather).toMatchObject({ ownOut: 2, freeSlots: 0 });
  });

  it('works out the circuit breaker and cooldown exactly like the cycle does', () => {
    const recent = [NOW - 50 * MIN, NOW - 20 * MIN];
    const game = buildGameState({
      queue: queue(1, 5), config: config({ schedule: { maxDispatchesPerHour: 2 } }),
      runtime: runtime({}, { dispatchTimestamps: [NOW - 2 * H, ...recent], giveUpUntil: NOW + 5 * MIN }), now: NOW,
    });
    expect(game.gather).toMatchObject({ dispatchesLastHour: 2, circuitUntil: NOW - 50 * MIN + H, cooldownUntil: NOW + 5 * MIN });
    const later = buildGameState({
      queue: queue(1, 5), config: config(), runtime: runtime({}, { giveUpUntil: NOW - 1 }), now: NOW,
    });
    expect(later.gather).toMatchObject({ cooldownUntil: null, circuitUntil: null });
  });

  it('says "unknown" instead of guessing without bookkeeping or a readable queue', () => {
    const game = buildGameState({
      queue: queue(null, null, [march({ targetCoord: '100,200', resourceType: 'wood' })]), config: config(), runtime: null, now: NOW,
      pausedReason: '疑似被顶号',
    });
    expect(game.pausedReason).toBe('疑似被顶号');
    expect(game.gather).toMatchObject({
      freeSlots: null, ownOut: 0, wanted: ['wood', 'gold', 'iron'], dispatchesLastHour: null, circuitUntil: null, bookkeeping: false,
    });
  });
});

describe('gather skill check', () => {
  const ready = () => buildGameState({ queue: queue(1, 5), config: config(), runtime: runtime({}), now: NOW });

  it('is ready with the free slots and the resources still wanted', () => {
    expect(gatherSkill).toMatchObject({ id: 'gather', title: '自动采集', summary: expect.stringContaining('gather') });
    expect(checkGather(ready(), NOW)).toEqual({ ready: true, reason: '可派 4 支，还欠：木材、金币、铁矿石', retryAt: null });
  });

  it('blocks in the same order as the cycle, with a retry time where one is known', () => {
    const base = ready();
    const at = (patch: Partial<typeof base.gather>, extra: Partial<typeof base> = {}) =>
      checkGather({ ...base, ...extra, gather: { ...base.gather, ...patch } }, NOW);

    expect(at({ enabled: false })).toEqual({ ready: false, reason: '自动采集未启用', retryAt: null });
    expect(at({}, { pausedReason: '维护中' }).reason).toBe('实例已暂停：维护中');
    expect(at({ cooldownUntil: NOW + 90_000 })).toEqual({
      ready: false, reason: '上一轮搜不到可用资源点，冷却中（还剩 00:01:30）', retryAt: NOW + 90_000,
    });
    expect(at({ circuitUntil: NOW + H, dispatchesLastHour: 30 })).toEqual({
      ready: false, reason: '最近一小时已派兵 30 次，达到熔断上限 30 次', retryAt: NOW + H,
    });
    expect(at({ freeSlots: null }).reason).toBe('行军队列占用没读出来');
    expect(at({ freeSlots: 0 }, { queue: { ...base.queue, nextFreeAt: NOW + 7 * MIN } })).toEqual({
      ready: false, reason: '没有可派的队列（已用 1/5，预留 0，自动采集在外 0/5）', retryAt: NOW + 7 * MIN,
    });
    expect(at({ wanted: [] }).reason).toBe('每种资源的队列配额都已满足');
  });

  it('agrees with the cycle on a full quota and a reserved last slot', () => {
    const marches = [
      march({ targetCoord: '1,1' }), march({ targetCoord: '2,2' }), march({ targetCoord: '3,3' }), march({ targetCoord: '4,4' }),
    ];
    const own = runtime({ '1,1': 'wood', '2,2': 'wood', '3,3': 'gold', '4,4': 'iron' });
    const full = buildGameState({ queue: queue(4, 5, marches), config: config(), runtime: own, now: NOW });
    expect(checkGather(full, NOW).reason).toBe('每种资源的队列配额都已满足');
    const reserved = buildGameState({
      queue: queue(4, 5, marches), config: config({ queuePlan: { reserveQueues: 1 } }), runtime: own, now: NOW,
    });
    expect(checkGather(reserved, NOW).reason).toBe('没有可派的队列（已用 4/5，预留 1，自动采集在外 4/5）');
  });

  it('maps the cycle outcome to the skill outcome', () => {
    expect(gatherSkillOutcome('dispatched', 2)).toBe('done');
    expect(gatherSkillOutcome('queueFull', 0)).toBe('idle');
    expect(gatherSkillOutcome('noResourceWanted', 0)).toBe('idle');
    expect(gatherSkillOutcome('giveUp', 0)).toBe('idle');
    expect(gatherSkillOutcome('circuitBroken', 0)).toBe('deferred');
  });
});
