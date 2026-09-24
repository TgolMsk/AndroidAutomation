import { describe, expect, it } from 'vitest';
import {
  ABSOLUTE_LEVEL_POLICY_DEFAULT, DEFAULT_GATHER_CONFIG, coerceGatherConfig, defaultGatherConfig, defaultLevelPolicy,
  describeBlockingIssues, describeLevelPolicy, exportGatherConfig, formatSeconds, formatStorage, hasBlockingIssue,
  importGatherConfig, normalizeGatherConfig, validateGatherConfig, type ConfigIssue, type GatherConfig,
} from '../src/wanlong/pure.js';

function cfg(patch: (draft: GatherConfig) => void): GatherConfig {
  const draft = defaultGatherConfig();
  patch(draft);
  return draft;
}

function at(issues: ConfigIssue[], path: string): ConfigIssue[] {
  return issues.filter((issue) => issue.path === path);
}

describe('采集配置：默认值只有一份', () => {
  it('defaultGatherConfig 是 DEFAULT_GATHER_CONFIG 的深拷贝，改它不会污染权威默认值', () => {
    const copy = defaultGatherConfig();
    expect(copy).toEqual(DEFAULT_GATHER_CONFIG);
    copy.resources[0]!.queues = 5;
    copy.schedule.retryBackoffSeconds.push(999);
    expect(DEFAULT_GATHER_CONFIG.resources[0]!.queues).toBe(2);
    expect(DEFAULT_GATHER_CONFIG.schedule.retryBackoffSeconds).toEqual([30, 60, 120, 240, 300]);
    expect(defaultLevelPolicy()).toEqual({ mode: 'relative', offset: -1, minLevel: 5, assumedMaxLevel: 8, maxLevelHardCap: 15 });
  });

  it('默认配置零错误（原版三镜像教训：onUnknownLevel=acceptCard、maxCaptures=60、魔水 0 队列）', () => {
    const issues = validateGatherConfig(defaultGatherConfig());
    expect(issues.filter((issue) => issue.level === 'error')).toEqual([]);
    expect(hasBlockingIssue(issues)).toBe(false);
    expect(DEFAULT_GATHER_CONFIG.safety).toMatchObject({ onUnknownLevel: 'acceptCard', maxCapturesPerCycle: 60 });
  });
});

describe('coerceGatherConfig：补缺字段、取整，不夹值', () => {
  it('越界值原样保留交给校验报，而不是悄悄夹掉（normalize 会夹）', () => {
    const raw = { resources: [{ type: 'wood', enabled: true, priority: 1, queues: 20 }], schedule: { slackSeconds: 5000 } };
    const coerced = coerceGatherConfig(raw);
    expect(coerced.resources.find((r) => r.type === 'wood')?.queues).toBe(20);
    expect(coerced.schedule.slackSeconds).toBe(5000);
    expect(normalizeGatherConfig(raw as never).schedule.slackSeconds).toBe(900);
    const issues = validateGatherConfig(coerced);
    expect(at(issues, 'resources.wood.queues')[0]).toMatchObject({ level: 'error', message: '「木材」的队列数必须在 0 ~ 5 之间，当前是 20。' });
    expect(at(issues, 'schedule.slackSeconds')[0]?.level).toBe('error');
  });

  it('资源固定按 木/金/铁/魔 排、每项覆盖原样保留、联盟缩写截到 8 字、未知输入回落默认', () => {
    const coerced = coerceGatherConfig({
      resources: [
        { type: 'mana', enabled: true, priority: 1, queues: 1, minStorage: 5 },
        { type: 'wood', enabled: false, priority: 4, queues: 0 },
      ],
      thresholds: { ownAllianceTag: 'ABCDEFGHIJ', allianceTerritory: 'bogus' },
      levelPolicy: { mode: 'absolute' },
    });
    expect(coerced.resources.map((r) => r.type)).toEqual(['wood', 'gold', 'iron', 'mana']);
    expect(coerced.resources[3]).toEqual({ type: 'mana', enabled: true, priority: 1, queues: 1, minStorage: 5 });
    expect(coerced.thresholds.ownAllianceTag).toBe('ABCDEFGH');
    expect(coerced.thresholds.allianceTerritory).toBe('any');
    expect(coerced.levelPolicy).toEqual(ABSOLUTE_LEVEL_POLICY_DEFAULT);
    expect(coerceGatherConfig(null)).toEqual(DEFAULT_GATHER_CONFIG);
    expect(coerceGatherConfig([1, 2])).toEqual(DEFAULT_GATHER_CONFIG);
    expect(coerceGatherConfig({ enabled: true, queuePlan: { reserveQueues: 1.6 } }).queuePlan.reserveQueues).toBe(2);
  });
});

describe('validateGatherConfig（原版每条规则的路径与级别）', () => {
  it('资源：开了总开关一种都没选是错误；启用却 0 队列、优先级重复、队列之和超上限是提醒', () => {
    const none = validateGatherConfig(cfg((d) => { d.enabled = true; for (const r of d.resources) r.enabled = false; }));
    expect(at(none, 'resources')[0]).toMatchObject({ level: 'error', message: '已启用自动采集，但一种资源都没选。至少勾一种，否则调度器无事可做。' });

    const zero = validateGatherConfig(cfg((d) => { d.resources.find((r) => r.type === 'mana')!.enabled = true; }));
    expect(at(zero, 'resources.mana.queues')[0]?.level).toBe('warning');
    expect(hasBlockingIssue(zero)).toBe(false);

    const dup = validateGatherConfig(cfg((d) => { d.resources[1]!.priority = 1; }));
    expect(at(dup, 'resources')[0]).toMatchObject({ level: 'warning', message: '有多种资源都用了优先级 1，同优先级之间的先后顺序不确定。' });

    const sum = validateGatherConfig(cfg((d) => { d.queuePlan.maxConcurrentGather = 3; }));
    expect(at(sum, 'queuePlan.maxConcurrentGather')[0]?.message).toContain('各资源分配的队列数之和是 4');
    expect(at(sum, 'queuePlan.maxConcurrentGather')[0]?.level).toBe('warning');

    const bad = validateGatherConfig(cfg((d) => { d.resources[0]!.priority = 1.5; d.resources[2]!.priority = 9; }));
    expect(at(bad, 'resources.wood.priority')[0]?.message).toBe('「木材」的优先级必须是整数。');
    expect(at(bad, 'resources.iron.priority')[0]?.message).toBe('「铁矿石」的优先级必须在 1 ~ 4 之间，当前是 9。');
  });

  it('等级：相对模式的范围与「放宽形同虚设」提醒；绝对模式 minLevel > level 是错误；硬顶护栏', () => {
    const relaxed = validateGatherConfig(cfg((d) => { d.levelPolicy = { ...defaultLevelPolicy(), offset: -5, minLevel: 5 }; }));
    expect(at(relaxed, 'levelPolicy.offset')[0]).toMatchObject({ level: 'warning' });
    expect(at(relaxed, 'levelPolicy.offset')[0]?.message).toContain('按当前假定上限 8 算出的搜索下限是 3');

    const offset = validateGatherConfig(cfg((d) => { d.levelPolicy = { ...defaultLevelPolicy(), offset: 1 }; }));
    expect(at(offset, 'levelPolicy.offset')[0]?.level).toBe('error');

    const cap = validateGatherConfig(cfg((d) => { d.levelPolicy = { ...defaultLevelPolicy(), assumedMaxLevel: 12, maxLevelHardCap: 10 }; }));
    expect(at(cap, 'levelPolicy.assumedMaxLevel')[0]?.level).toBe('error');

    const absolute = validateGatherConfig(cfg((d) => { d.levelPolicy = { ...ABSOLUTE_LEVEL_POLICY_DEFAULT, level: 6, minLevel: 7 }; }));
    expect(at(absolute, 'levelPolicy.minLevel')[0]).toMatchObject({
      level: 'error', message: '「可放宽到的最低值 7」比「固定搜索下限 6」还高，放宽将永远无法生效。',
    });
    const absCap = validateGatherConfig(cfg((d) => { d.levelPolicy = { ...ABSOLUTE_LEVEL_POLICY_DEFAULT, level: 12, maxLevelHardCap: 10 }; }));
    expect(at(absCap, 'levelPolicy.level')[0]?.level).toBe('error');
  });

  it('阈值：负数是错误，0 < 行军 < 30 秒、关掉「采集者 无」、筛联盟却没填缩写是提醒', () => {
    const issues = validateGatherConfig(cfg((d) => {
      d.thresholds.minStorage = -1;
      d.thresholds.maxTravelSeconds = 20;
      d.thresholds.requireGathererNone = false;
      d.thresholds.allianceTerritory = 'own-only';
    }));
    expect(at(issues, 'thresholds.minStorage')[0]).toMatchObject({ level: 'error', message: '最低储量不能是负数。' });
    expect(at(issues, 'thresholds.maxTravelSeconds')[0]?.level).toBe('warning');
    expect(at(issues, 'thresholds.requireGathererNone')[0]?.level).toBe('warning');
    expect(at(issues, 'thresholds.ownAllianceTag')[0]?.level).toBe('warning');
    const neg = validateGatherConfig(cfg((d) => { d.thresholds.maxTravelSeconds = -5; }));
    expect(at(neg, 'thresholds.maxTravelSeconds')[0]).toMatchObject({ level: 'error', message: '最长单程行军不能是负数。填 0 表示不限制。' });
  });

  it('队列与搜索重试的范围；搜索间隔 < 300ms 是提醒', () => {
    const issues = validateGatherConfig(cfg((d) => {
      d.queuePlan.reserveQueues = 6;
      d.queuePlan.maxConcurrentGather = 0;
      d.searchRetry.occupiedRetryLimit = 0;
      d.searchRetry.floorRelaxStep = 4;
      d.searchRetry.researchDelayMs = 200;
    }));
    expect(at(issues, 'queuePlan.reserveQueues')[0]?.level).toBe('error');
    expect(at(issues, 'queuePlan.maxConcurrentGather').some((issue) => issue.level === 'error')).toBe(true);
    expect(at(issues, 'searchRetry.occupiedRetryLimit')[0]?.level).toBe('error');
    expect(at(issues, 'searchRetry.floorRelaxStep')[0]?.level).toBe('error');
    expect(at(issues, 'searchRetry.researchDelayMs')[0]?.level).toBe('warning');
  });

  it('调度：退避序列为空或含 <5 是错误、不递增是提醒；冗余 <15 秒提醒；上限类下限是错误', () => {
    const empty = validateGatherConfig(cfg((d) => { d.schedule.retryBackoffSeconds = []; }));
    expect(at(empty, 'schedule.retryBackoffSeconds')[0]).toMatchObject({ level: 'error', message: '退避序列不能为空，否则队列没空时会原地疯狂重试。' });
    const small = validateGatherConfig(cfg((d) => { d.schedule.retryBackoffSeconds = [3, 60]; }));
    expect(at(small, 'schedule.retryBackoffSeconds')[0]).toMatchObject({ level: 'error', message: '退避序列里每一项都必须 ≥ 5 秒。' });
    const down = validateGatherConfig(cfg((d) => { d.schedule.retryBackoffSeconds = [60, 30]; }));
    expect(at(down, 'schedule.retryBackoffSeconds')).toEqual([{ level: 'warning', path: 'schedule.retryBackoffSeconds', message: '退避序列不是递增的，指数退避的意义会被削弱。' }]);
    const issues = validateGatherConfig(cfg((d) => {
      d.schedule.slackSeconds = 10;
      d.schedule.maxBackoffSeconds = 20;
      d.schedule.calibrateIntervalMin = 0;
      d.schedule.jitterSeconds = -1;
      d.schedule.giveUpCooldownMin = 0;
    }));
    expect(at(issues, 'schedule.slackSeconds')[0]?.level).toBe('warning');
    for (const path of ['schedule.maxBackoffSeconds', 'schedule.calibrateIntervalMin', 'schedule.jitterSeconds', 'schedule.giveUpCooldownMin']) {
      expect(at(issues, path)[0]?.level, path).toBe('error');
    }
  });

  it('安全：保守 ETA <60、截图上限 <6 是错误；滑动重试 0、关掉对账复验是提醒', () => {
    const issues = validateGatherConfig(cfg((d) => {
      d.safety.unknownEtaFallbackSeconds = 30;
      d.safety.maxCapturesPerCycle = 5;
      d.safety.swipeRetry = 0;
      d.safety.abortOnReconcileFail = false;
    }));
    expect(at(issues, 'safety.unknownEtaFallbackSeconds')[0]?.level).toBe('error');
    expect(at(issues, 'safety.maxCapturesPerCycle')[0]?.level).toBe('error');
    expect(at(issues, 'safety.swipeRetry')[0]?.level).toBe('warning');
    expect(at(issues, 'safety.abortOnReconcileFail')[0]?.level).toBe('warning');
  });

  it('运行期会夹掉的上限一律报错（保存时不再悄悄改用户的值）', () => {
    const issues = validateGatherConfig(cfg((d) => {
      d.thresholds.minStorage = 200_000_000;
      d.schedule.jitterSeconds = 601;
      d.safety.maxCapturesPerCycle = 501;
      d.safety.swipeRetry = 11;
    }));
    for (const path of ['thresholds.minStorage', 'schedule.jitterSeconds', 'safety.maxCapturesPerCycle', 'safety.swipeRetry']) {
      expect(at(issues, path)[0]?.level, path).toBe('error');
    }
  });

  it('describeBlockingIssues：只拼错误，最多 6 条', () => {
    expect(describeBlockingIssues(validateGatherConfig(defaultGatherConfig()))).toBeNull();
    const many = validateGatherConfig(cfg((d) => {
      d.schedule.retryBackoffSeconds = [];
      d.safety.unknownEtaFallbackSeconds = 1;
      d.safety.maxCapturesPerCycle = 1;
      d.schedule.maxBackoffSeconds = 1;
      d.schedule.calibrateIntervalMin = 0;
      d.schedule.giveUpCooldownMin = 0;
      d.schedule.jitterSeconds = -1;
    }));
    const text = describeBlockingIssues(many)!;
    expect(text.startsWith('采集配置有错误（等 7 处），没有保存：')).toBe(true);
    expect(text.split('；')).toHaveLength(6);
  });
});

describe('导入 / 导出', () => {
  it('非法 JSON、数组、version 1/3 拒绝；缺 version 接受并补默认值', () => {
    expect(() => importGatherConfig('{oops')).toThrow(/^不是合法的 JSON：/);
    expect(() => importGatherConfig('[]')).toThrow('顶层必须是一个 JSON 对象。');
    expect(() => importGatherConfig('null')).toThrow('顶层必须是一个 JSON 对象。');
    expect(() => importGatherConfig('{"version":1}')).toThrow('配置版本是 1，当前面板只认 version = 2（缺失的字段会补默认值）。');
    expect(() => importGatherConfig('{"version":3}')).toThrow(/配置版本是 3/);
    expect(importGatherConfig('{"enabled":true}')).toEqual({ ...defaultGatherConfig(), enabled: true });
  });

  it('导出是 2 空格缩进的 JSON，导出→导入往返不变', () => {
    const original = cfg((d) => { d.enabled = true; d.levelPolicy = { ...ABSOLUTE_LEVEL_POLICY_DEFAULT, level: 8 }; d.resources[3]!.queues = 1; });
    const text = exportGatherConfig(original);
    expect(text).toBe(JSON.stringify(original, null, 2));
    expect(importGatherConfig(text)).toEqual(original);
  });
});

describe('人话说明', () => {
  it('describeLevelPolicy：相对 / 绝对（放宽开关两种）', () => {
    expect(describeLevelPolicy(defaultLevelPolicy(), null)).toBe(
      '当前等级上限按 8 计（未探测，用假定值），搜索下限 = 8 − 1 = 7 级。实际会采到 7 级及以上的点，采到 8 级收益更高、属于正常结果。连续搜不到时下限逐步放宽，最低放到 5 级。',
    );
    expect(describeLevelPolicy(defaultLevelPolicy(), 10)).toContain('当前等级上限按 10 计（已从滑杆探测），搜索下限 = 10 − 1 = 9 级。');
    expect(describeLevelPolicy({ ...ABSOLUTE_LEVEL_POLICY_DEFAULT, level: 6 }, null)).toBe(
      '固定按 6 级作为搜索下限去搜：6 级及以上的点都算合格，搜到 7、8 级是好事，不是失败。连续搜不到时会把下限一路放宽到 5 级。',
    );
    expect(describeLevelPolicy({ ...ABSOLUTE_LEVEL_POLICY_DEFAULT, allowRelax: false }, null)).toContain('已关闭放宽，搜不到就直接放弃本轮。');
  });

  it('formatStorage / formatSeconds', () => {
    expect(formatStorage(0)).toBe('不限制');
    expect(formatStorage(300000)).toBe('30 万');
    expect(formatStorage(1_260_000)).toBe('126 万');
    expect(formatStorage(12_345)).toBe('1.2 万');
    expect(formatStorage(250_000_000)).toBe('2.5 亿');
    expect(formatStorage(9_999)).toBe('9999');
    expect(formatSeconds(0)).toBe('不限制');
    expect(formatSeconds(45)).toBe('45 秒');
    expect(formatSeconds(600)).toBe('10 分钟');
    expect(formatSeconds(90)).toBe('1 分 30 秒');
  });
});
