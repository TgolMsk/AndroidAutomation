import { describe, expect, it } from 'vitest';
import {
  BATCH_VERB, batchTargets, collectOutcome, describeBatchOutcome, mapLimited, type BatchCandidate,
} from '../src/renderer/views/gather/batch';

function c(index: number, patch: Partial<BatchCandidate> = {}): BatchCandidate {
  return { index, up: true, paused: false, isBase: false, auto: false, autoBusy: false, sampling: false, operating: false, ...patch };
}

describe('batchTargets (only the filtered list; skip reasons grouped verbatim)', () => {
  const list = [
    c(0),
    c(1, { up: false }),
    c(2, { paused: true }),
    c(3, { isBase: true }),
    c(4, { auto: true }),
    c(5, { autoBusy: true }),
    c(6, { sampling: true }),
    c(7, { operating: true }),
    c(8, { up: false, auto: true }),
  ];

  it('on: skips stopped, paused, base, already on and switching', () => {
    expect(batchTargets('on', list)).toEqual({
      targets: [0, 6, 7],
      skipped: ['未开机：#1、#8', '已被异常暂停，请单独点「恢复」：#2', '是基础实例：#3', '本来就是开的：#4', '开关正在切换：#5'],
    });
  });

  it('off: only instances that are on and not switching (a stopped one can still be switched off)', () => {
    expect(batchTargets('off', list)).toEqual({ targets: [4, 8], skipped: ['本来就是关的：#0、#1、#2、#3、#5、#6、#7'] });
    expect(batchTargets('off', [c(1, { auto: true, autoBusy: true })])).toEqual({ targets: [], skipped: ['开关正在切换：#1'] });
  });

  it('sample: skips stopped, paused, sampling and operating (a base instance may be sampled)', () => {
    expect(batchTargets('sample', list)).toEqual({
      targets: [0, 3, 4, 5],
      skipped: ['未开机：#1、#8', '已被异常暂停，请单独点「恢复」：#2', '正在采样：#6', '设备操作中：#7'],
    });
  });
});

describe('describeBatchOutcome', () => {
  it('reads like the original toast', () => {
    const out = collectOutcome([{ index: 0, reason: null }, { index: 3, reason: '实例 #3 尚未就绪' }, { index: 5, reason: null }]);
    expect(out).toEqual({ ok: [0, 5], failed: [{ index: 3, reason: '实例 #3 尚未就绪' }] });
    expect(describeBatchOutcome(BATCH_VERB.on, out)).toBe('已开启自动采集 2 个实例（#0、#5）。1 个失败：#3 实例 #3 尚未就绪。');
    expect(describeBatchOutcome('采样', { ok: [1], failed: [] })).toBe('已采样 1 个实例（#1）。');
    expect(describeBatchOutcome('采样', { ok: [], failed: [{ index: 2, reason: 'a' }, { index: 4, reason: 'b' }] })).toBe('2 个失败：#2 a；#4 b。');
  });

  it('mapLimited keeps the order and never runs more than the limit at once', async () => {
    let active = 0;
    let peak = 0;
    const result = await mapLimited([5, 1, 3, 2, 4], 2, async (n) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, n));
      active -= 1;
      return n * 10;
    });
    expect(result).toEqual([50, 10, 30, 20, 40]);
    expect(peak).toBe(2);
    expect(await mapLimited([], 3, async (n: number) => n)).toEqual([]);
  });
});
