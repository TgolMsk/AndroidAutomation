/**
 * G8「等卡片停稳」waitForCard（原版 check:card 的 15 项断言）。假 GatherSession 直接喂「按钮一帧帧滑到位」的序列：
 *   ① 见过卡片就绝不能退化成 null；② 帧数有硬上限；③ waitMs <= 0 退化成单帧。
 */
import { describe, expect, it } from 'vitest';
import { waitForCard } from '../src/wanlong/gather/card.js';
import type { GatherSession } from '../src/wanlong/gather/session.js';

function fakeSession(frames: (readonly [number, number] | null)[]) {
  let t = 0;
  let i = 0;
  let captures = 0;
  let slept = 0;
  const logs: string[] = [];
  const next = () => {
    const f = frames[Math.min(i, frames.length - 1)];
    i++;
    captures++;
    t += 750;
    return f;
  };
  const s = {
    now: () => t,
    invalidate: () => undefined,
    async sleep(ms: number) { t += ms; slept += ms; },
    log: (lvl: string, m: string) => logs.push(`${lvl}:${m}`),
    async match() {
      const f = next();
      return f ? { found: true, centerX: f[0], centerY: f[1] } : { found: false, centerX: 0, centerY: 0 };
    },
    async waitFor(_ids: unknown, opts: { waitMs: number; pollMs?: number }) {
      const deadline = t + Math.max(0, opts.waitMs);
      for (;;) {
        const f = next();
        if (f) return { id: 'tpl_btn_gather', match: { centerX: f[0], centerY: f[1] } };
        if (t >= deadline) return null;
        t += opts.pollMs ?? 600;
      }
    },
  };
  return { s: s as unknown as GatherSession, logs, frames: () => captures, slept: () => slept };
}

describe('waitForCard', () => {
  it('滑入两帧后返回停稳位，不是第一帧', async () => {
    const f = fakeSession([[1700, 1040], [1780, 1044], [1800, 1045], [1800, 1045]]);
    expect(await waitForCard(f.s, 8000)).toEqual({ x: 1800, y: 1045 });
  });

  it('一上来就静止：只多吃一帧、复验前静置 300ms、没有告警', async () => {
    const f = fakeSession([[1800, 1045], [1800, 1045]]);
    expect((await waitForCard(f.s, 8000))?.x).toBe(1800);
    expect(f.frames()).toBe(2);
    expect(f.slept()).toBe(300);
    expect(f.logs).toEqual([]);
  });

  it('容差内的抖动算停稳（5px/3px）', async () => {
    expect((await waitForCard(fakeSession([[1800, 1045], [1805, 1042]]).s, 8000))?.x).toBe(1805);
  });

  it('一次都没看见 → null（「附近没有这个等级的点」的唯一语义）', async () => {
    expect(await waitForCard(fakeSession([null]).s, 8000)).toBeNull();
  });

  it('★ 见过卡片、复验帧没匹配上 → 返回上一帧位置，绝不返回 null', async () => {
    const f = fakeSession([[1800, 1045], null, null, null]);
    expect(await waitForCard(f.s, 8000)).toEqual({ x: 1800, y: 1045 });
    expect(f.logs.some((l) => l.includes('没再匹配到'))).toBe(true);
  });

  it('★ 一直在动：总帧数 ≤ 3（1 次命中 + 2 次复验），并告警「仍在移动」', async () => {
    const moving: [number, number][] = [];
    for (let k = 0; k < 60; k++) moving.push([1700 + k * 30, 1045]);
    const f = fakeSession(moving);
    const p = await waitForCard(f.s, 8000);
    expect(p!.x).toBeGreaterThan(1700);
    expect(f.frames()).toBeLessThanOrEqual(3);
    expect(f.logs.some((l) => l.includes('仍在移动'))).toBe(true);
  });

  it('waitMs=0（离线回放）退化成单帧：只吃 1 帧、不静置', async () => {
    const f = fakeSession([[1800, 1045], [9999, 9999]]);
    expect((await waitForCard(f.s, 0))?.x).toBe(1800);
    expect(f.frames()).toBe(1);
    expect(f.slept()).toBe(0);
  });
});
