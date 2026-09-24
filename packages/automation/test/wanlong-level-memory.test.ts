/**
 * 搜索等级记忆 + 下限状态机（gather/levelMemory.ts，原版 check:level）。纯决策，不需要真机截图。
 * 状态文件往返（含旧文件）在应用的 gather-runner.test.ts 里对 GatherRuntimeStore 做。
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GATHER_CONFIG, DEFAULT_LEVEL_POLICY, computeSearchFloor, createRuntimeState,
  type LevelPolicy, type SearchRetry,
} from '../src/wanlong/index.js';
import {
  GATHER_RESOURCE_TYPES, effectiveMaxLevel, emptyLevelMemory, expireNoResult, hasFreshNoResult, isMaxLevelStale,
  learnFromSearch, levelMemoryOf, onCard, onNoCard, onUnsuitable, planStartFloor, recordMaxLevel, relaxFloor,
  sanitizeLevelMemory, startFloorSearch, type FloorSearch,
} from '../src/wanlong/gather/levelMemory.js';

const MIN = 60_000;
const T0 = 1_700_000_000_000;
const retry: SearchRetry = { ...DEFAULT_GATHER_CONFIG.searchRetry };
const relative: LevelPolicy = { ...DEFAULT_LEVEL_POLICY };
const fixedNoRelax: LevelPolicy = { mode: 'absolute', level: 9, minLevel: 5, allowRelax: false, maxLevelHardCap: 15 };
const ttl = retry.probeIntervalMin;

describe('一、起步下限：策略 / 记忆 / 过期 / minLevel / 不放宽', () => {
  it('按策略、记忆与过期决定起步下限', () => {
    const p0 = planStartFloor(relative, emptyLevelMemory(), 10, T0, ttl);
    expect(p0).toMatchObject({ floor: 9, fromMemory: false, policyFloor: 9 });
    expect(p0.policyFloor).toBe(computeSearchFloor(relative, 10));

    const remembered = { ...emptyLevelMemory(), noResultFloor: 9, noResultAt: T0 };
    expect(planStartFloor(relative, remembered, 10, T0 + 30 * MIN, ttl)).toMatchObject({ floor: 8, fromMemory: true, policyFloor: 9 });
    expect(planStartFloor(relative, remembered, 10, T0 + (ttl + 1) * MIN, ttl)).toMatchObject({ floor: 9, fromMemory: false });
    expect(hasFreshNoResult(remembered, T0 + (ttl + 1) * MIN, ttl)).toBe(false);
    expect(expireNoResult(remembered, T0 + (ttl + 1) * MIN, ttl)).toBe(9);
    expect(remembered.noResultFloor).toBeNull();
    expect(expireNoResult({ ...emptyLevelMemory(), noResultFloor: 9, noResultAt: T0 }, T0 + MIN, ttl)).toBeNull();

    const lowOffset: LevelPolicy = { mode: 'relative', offset: -3, minLevel: 5, assumedMaxLevel: 8, maxLevelHardCap: 15 };
    expect(planStartFloor(lowOffset, { ...emptyLevelMemory(), noResultFloor: 9, noResultAt: T0 }, 10, T0, ttl))
      .toMatchObject({ floor: 7, fromMemory: false });
    expect(planStartFloor(relative, { ...emptyLevelMemory(), noResultFloor: 5, noResultAt: T0 }, 10, T0, ttl))
      .toMatchObject({ floor: 5, fromMemory: true });
    expect(planStartFloor(fixedNoRelax, { ...emptyLevelMemory(), noResultFloor: 9, noResultAt: T0 }, 10, T0, ttl))
      .toMatchObject({ floor: 9, fromMemory: false });
  });

  it('上限缺省值、过期判定与放宽步长', () => {
    expect(effectiveMaxLevel(emptyLevelMemory(), relative)).toBe(8);
    expect(effectiveMaxLevel(emptyLevelMemory(), fixedNoRelax)).toBe(15);
    expect(effectiveMaxLevel({ ...emptyLevelMemory(), maxLevel: 10, probedAt: T0 }, relative)).toBe(10);
    expect(isMaxLevelStale(emptyLevelMemory(), T0, ttl)).toBe(true);
    expect(isMaxLevelStale({ ...emptyLevelMemory(), maxLevel: 10, probedAt: T0 }, T0 + 5 * MIN, ttl)).toBe(false);
    expect(isMaxLevelStale({ ...emptyLevelMemory(), maxLevel: 10, probedAt: T0 }, T0 + (ttl + 1) * MIN, ttl)).toBe(true);
    expect(relaxFloor(relative, 9, 1)).toBe(8);
    expect(relaxFloor(relative, 9, 2)).toBe(7);
    expect(relaxFloor(relative, 5, 1)).toBeNull();
    expect(relaxFloor(fixedNoRelax, 9, 1)).toBeNull();
  });
});

describe('二、★ 真机场景：魔水池滑杆 10、附近只有 8 级', () => {
  it('一次空搜就放宽到 8、记住，下一轮直接从 8 起步；各资源独立；12 小时后过期', () => {
    const state = createRuntimeState();
    let clock = T0;
    const mem = levelMemoryOf(state, 'mana');
    const probed = recordMaxLevel(mem, 10, clock);
    expect(state.levelByResource.mana?.maxLevel).toBe(10);
    expect(probed).toMatchObject({ changed: true, previous: null });

    const plan1 = planStartFloor(relative, mem, effectiveMaxLevel(mem, relative), clock, ttl);
    expect(plan1).toMatchObject({ floor: 9, fromMemory: false });
    let st: FloorSearch = startFloorSearch(plan1.floor);
    const step = onNoCard(st, relative, retry);
    expect(step).toMatchObject({ kind: 'relaxed', to: 8 });
    st = step.state;
    expect(st).toMatchObject({ lowestEmptyFloor: 9, unsuitableFails: 0, cardSeen: false });

    const learned = learnFromSearch(mem, st, clock, ttl, st.floor);
    st = onCard(st);
    expect(learned).toMatchObject({ committed: 9, forgot: null });
    expect(mem).toMatchObject({ noResultFloor: 9, noResultAt: clock });
    expect(st).toMatchObject({ cardSeen: true, lowestEmptyFloor: null });

    clock += 30 * MIN;
    expect(isMaxLevelStale(mem, clock, ttl)).toBe(false);
    expect(planStartFloor(relative, mem, effectiveMaxLevel(mem, relative), clock, ttl)).toMatchObject({ floor: 8, fromMemory: true });

    const wood = levelMemoryOf(state, 'wood');
    expect(wood.maxLevel).toBeNull();
    expect(isMaxLevelStale(wood, clock, ttl)).toBe(true);
    recordMaxLevel(wood, 8, clock);
    expect(planStartFloor(relative, wood, 8, clock, ttl).floor).toBe(7);
    expect(planStartFloor(relative, mem, 10, clock, ttl).floor).toBe(8);

    clock = T0 + (ttl + 1) * MIN;
    expect(expireNoResult(mem, clock, ttl)).toBe(9);
    expect(planStartFloor(relative, mem, 10, clock, ttl).floor).toBe(9);
  });
});

describe('三、下限状态机：搜不到 vs 点不合适', () => {
  it('点不合适重试够 occupiedRetryLimit 才放宽；搜不到立刻放宽且不消耗次数', () => {
    const r1 = onUnsuitable(startFloorSearch(9), relative, retry);
    const r2 = onUnsuitable(r1.state, relative, retry);
    const r3 = onUnsuitable(r2.state, relative, retry);
    expect([r1.kind, r2.kind, r3.kind]).toEqual(['retry', 'retry', 'retry']);
    expect(r3.state.unsuitableFails).toBe(3);
    const r4 = onUnsuitable(r3.state, relative, retry);
    expect(r4).toMatchObject({ kind: 'relaxed', to: 8 });
    expect(r4.state).toMatchObject({ unsuitableFails: 0, lowestEmptyFloor: null });

    const n1 = onNoCard({ ...startFloorSearch(9), unsuitableFails: 2 }, relative, retry);
    expect(n1).toMatchObject({ kind: 'relaxed', to: 8 });
    expect(n1.state.unsuitableFails).toBe(0);

    const wide: SearchRetry = { ...retry, floorRelaxStep: 2 };
    expect(onNoCard(startFloorSearch(9), relative, wide)).toMatchObject({ kind: 'relaxed', to: 7 });
  });

  it('放到底就放弃，原因写明 minLevel / 连续次数 / 配置不允许', () => {
    const g1 = onNoCard(startFloorSearch(5), relative, retry);
    expect(g1.kind).toBe('giveUp');
    expect(g1.reason).toContain('minLevel=5');

    let bottom: FloorSearch = startFloorSearch(5);
    let last = onUnsuitable(bottom, relative, retry);
    for (let i = 0; i < 3 && last.kind !== 'giveUp'; i++) {
      bottom = last.state;
      last = onUnsuitable(bottom, relative, retry);
    }
    expect(last.kind).toBe('giveUp');
    expect(last.reason).toContain('连续 4 次');

    const a1 = onNoCard(startFloorSearch(9), fixedNoRelax, retry);
    expect(a1.kind).toBe('giveUp');
    expect(a1.reason).toContain('配置不允许放宽');

    expect(onUnsuitable(startFloorSearch(9), relative, { ...retry, occupiedRetryLimit: 1 }).kind).toBe('relaxed');
  });

  it('见过卡片之后的空搜只放宽、不记忆（按一次性故障处理）', () => {
    const n2 = onNoCard(onCard(startFloorSearch(8)), relative, retry);
    expect(n2).toMatchObject({ kind: 'relaxed', to: 7 });
    expect(n2.state.lowestEmptyFloor).toBeNull();
    const mem = emptyLevelMemory();
    expect(learnFromSearch(mem, n2.state, T0, ttl).committed).toBeNull();
    expect(mem.noResultFloor).toBeNull();
  });
});

describe('四、记忆的写入与作废', () => {
  it('放弃时也写；记忆下限起步后又搜不到就往下修；保留更低者', () => {
    {
      const mem = emptyLevelMemory();
      let st = startFloorSearch(9);
      st = (onNoCard(st, relative, retry) as { state: FloorSearch }).state;
      st = (onNoCard(st, relative, retry) as { state: FloorSearch }).state;
      expect(st).toMatchObject({ floor: 7, lowestEmptyFloor: 8 });
      expect(learnFromSearch(mem, st, T0, ttl).committed).toBe(8);
      expect(planStartFloor(relative, mem, 10, T0 + MIN, ttl).floor).toBe(7);
    }
    {
      const mem = { ...emptyLevelMemory(), noResultFloor: 9, noResultAt: T0 };
      const plan = planStartFloor(relative, mem, 10, T0 + MIN, ttl);
      let st = startFloorSearch(plan.floor);
      st = (onNoCard(st, relative, retry) as { state: FloorSearch }).state;
      const learned = learnFromSearch(mem, st, T0 + MIN, ttl, st.floor);
      expect(plan.floor).toBe(8);
      expect(learned.committed).toBe(8);
      expect(mem.noResultFloor).toBe(8);
    }
    {
      const mem = { ...emptyLevelMemory(), noResultFloor: 8, noResultAt: T0 };
      const learned = learnFromSearch(mem, { ...startFloorSearch(7), lowestEmptyFloor: 9 }, T0 + MIN, ttl, 7);
      expect(learned).toMatchObject({ committed: 8, forgot: null });
      expect(mem).toMatchObject({ noResultFloor: 8, noResultAt: T0 + MIN });
    }
    {
      const mem = { ...emptyLevelMemory(), noResultFloor: 8, noResultAt: T0 };
      const learned = learnFromSearch(mem, { ...startFloorSearch(8), lowestEmptyFloor: 9 }, T0 + MIN, ttl, 8);
      expect(learned).toMatchObject({ forgot: 8, committed: 9 });
      expect(mem.noResultFloor).toBe(9);
    }
  });

  it('在记忆说搜不到的下限搜到了点就作废；上限变化作废；按资源分别记', () => {
    const contradicted = { ...emptyLevelMemory(), noResultFloor: 9, noResultAt: T0 };
    expect(learnFromSearch(contradicted, startFloorSearch(9), T0 + MIN, ttl, 9)).toMatchObject({ forgot: 9, committed: null });
    expect(contradicted.noResultFloor).toBeNull();
    const consistent = { ...emptyLevelMemory(), noResultFloor: 9, noResultAt: T0 };
    expect(learnFromSearch(consistent, startFloorSearch(8), T0 + MIN, ttl, 8).forgot).toBeNull();
    expect(consistent.noResultFloor).toBe(9);

    const mem = { ...emptyLevelMemory(), maxLevel: 10, probedAt: T0, noResultFloor: 9, noResultAt: T0 };
    const same = recordMaxLevel(mem, 10, T0 + MIN);
    expect(same).toMatchObject({ changed: false, forgotNoResult: null });
    expect(mem).toMatchObject({ noResultFloor: 9, probedAt: T0 + MIN });
    const changed = recordMaxLevel(mem, 11, T0 + 2 * MIN);
    expect(changed).toMatchObject({ changed: true, previous: 10, forgotNoResult: 9 });
    expect(mem).toMatchObject({ noResultFloor: null, maxLevel: 11 });

    const state = createRuntimeState();
    recordMaxLevel(levelMemoryOf(state, 'mana'), 10, T0);
    recordMaxLevel(levelMemoryOf(state, 'wood'), 8, T0);
    learnFromSearch(levelMemoryOf(state, 'mana'), { ...startFloorSearch(8), lowestEmptyFloor: 9 }, T0, ttl, 8);
    expect(state.levelByResource.mana).toMatchObject({ maxLevel: 10, noResultFloor: 9 });
    expect(state.levelByResource.wood).toMatchObject({ maxLevel: 8, noResultFloor: null });
    expect(state.levelByResource.gold).toBeUndefined();
    expect(state.levelByResource.iron).toBeUndefined();
    expect(levelMemoryOf(state, 'mana')).toBe(state.levelByResource.mana);
  });
});

describe('五、落盘形状与坏数据收敛', () => {
  it('新状态没有旧的共用 maxLevel；sanitizeLevelMemory 逐条收敛', () => {
    const fresh = createRuntimeState();
    expect(JSON.stringify(fresh.levelByResource)).toBe('{}');
    expect('maxLevel' in fresh).toBe(false);
    const cleaned = sanitizeLevelMemory({
      mana: { maxLevel: 10, probedAt: T0, noResultFloor: 9, noResultAt: T0 },
      wood: { maxLevel: '8', probedAt: T0 },
      gold: { maxLevel: 8 },
      iron: { noResultFloor: 7, noResultAt: T0 },
      junk: { maxLevel: 3, probedAt: T0 },
    });
    expect(cleaned.mana).toMatchObject({ maxLevel: 10, noResultFloor: 9 });
    expect(cleaned.wood).toBeUndefined();
    expect(cleaned.gold).toBeUndefined();
    expect(cleaned.iron).toMatchObject({ noResultFloor: 7, maxLevel: null });
    expect('junk' in cleaned).toBe(false);
    expect(sanitizeLevelMemory(undefined)).toEqual({});
    expect(sanitizeLevelMemory(null)).toEqual({});
    expect(sanitizeLevelMemory([1])).toEqual({});
    expect(GATHER_RESOURCE_TYPES.join(',')).toBe('wood,gold,iron,mana');
  });
});
