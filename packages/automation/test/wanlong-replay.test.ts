/**
 * 真机截图回放（原版 check:sched 的真值表）。截图与模板是私有素材，**绝不进仓库**：
 *   WL_FRAMES_DIR=<抓帧目录>  WL_TEMPLATE_DIR=<模板集目录（含 manifest.json）>  pnpm --filter @avdm/automation test
 * 两个变量缺一就整组跳过。帧名沿用原版 .tplkit/frames 的命名；某一帧不存在时单条跳过。
 */
import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import type { RawFrame } from '../src/contracts.js';
import {
  buildSchedulerTemplates, loadGatherTemplates, sampleTroopPanel, type SampleIo, type SchedulerTemplates,
} from '../src/wanlong/index.js';

const FRAMES = process.env.WL_FRAMES_DIR;
const TEMPLATES = process.env.WL_TEMPLATE_DIR;
const enabled = Boolean(FRAMES && TEMPLATES && existsSync(FRAMES) && existsSync(TEMPLATES));

async function rawOf(file: string): Promise<RawFrame> {
  const { data, info } = await sharp(await readFile(file)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, format: 1, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), capturedAt: Date.now() };
}

function readOnlyIo(raw: RawFrame): SampleIo {
  return {
    serial: 'offline',
    capture: async () => raw,
    tapRef: async () => { throw new Error('离线回放里不该发生点击 —— 说明这一帧没被认成「面板已打开」'); },
    key: async () => { throw new Error('离线回放里不该发生按键'); },
  };
}

describe.skipIf(!enabled)('真机帧回放：部队管理面板采样器', () => {
  let t: SchedulerTemplates;
  const frames = enabled ? readdirSync(FRAMES!).filter((f) => f.toLowerCase().endsWith('.png')).sort() : [];
  const sample = async (file: string) => sampleTroopPanel(readOnlyIo(await rawOf(join(FRAMES!, file))), t, {
    refWidth: 2560, refHeight: 1440, maxRows: 5, readOptionalFields: true, closePanelAfterSample: false, deadlineAt: Date.now() + 120_000,
  });

  it('loads the private template set once', async () => {
    t = buildSchedulerTemplates(await loadGatherTemplates({ templateDir: TEMPLATES!, requireCritical: false }));
    expect(t.dark.glyphs.length).toBeGreaterThan(0);
    expect(t.light.glyphs.length).toBeGreaterThan(0);
  });

  const cases: Array<{ file: string; resources?: Array<string | null>; coords?: Record<number, string>; fills?: Record<number, [number, number]>; timers?: Record<number, number> }> = [
    { file: 'panel_mana5.png', resources: ['mana', 'mana', 'mana', 'mana', 'mana'], fills: { 1: [0, 0.1], 5: [0.65, 0.8] } },
    { file: 'live_panel.png', fills: { 2: [0, 0.06] } },
    { file: 'panel_gold_wood.png', resources: ['gold', 'wood', 'gold', 'wood', 'wood'], fills: { 1: [0.6, 0.75] } },
    { file: 'inst3_panel.png', resources: ['gold', null, null, null, null], fills: { 1: [0.8, 1] }, coords: { 1: '1231,717', 2: '1239,710' } },
    { file: 'panel_iron.png', resources: ['wood', 'iron', 'gold', 'wood', 'wood'], coords: { 1: '674,627', 2: '678,628', 3: '686,628', 4: '671,634', 5: '679,618' } },
    // 第 1 行「01:44:06」：绿色载重条边界正压在「44」上（压平背景之前读成「01:4:06」）。
    { file: 'troop-panel-5rows.png', timers: { 1: (3600 + 44 * 60 + 6) * 1000 }, fills: { 1: [0, 0.08] } },
  ];

  for (const c of cases) {
    it.skipIf(!frames.includes(c.file))(`${c.file} 与人眼核对过的真值一致`, async () => {
      const s = await sample(c.file);
      c.resources?.forEach((want, i) => expect(s.rows[i]?.resourceType ?? null).toBe(want));
      for (const row of s.rows) if (row.status === 'gathering') expect(row.remainingMs).not.toBeNull();
      for (const [slot, want] of Object.entries(c.coords ?? {})) expect(s.rows[Number(slot) - 1]?.targetCoord).toBe(want);
      for (const [slot, [lo, hi]] of Object.entries(c.fills ?? {})) {
        const v = s.rows[Number(slot) - 1]?.fillRatio;
        expect(v).not.toBeNull();
        expect(v!).toBeGreaterThanOrEqual(lo);
        expect(v!).toBeLessThanOrEqual(hi);
      }
      for (const [slot, ms] of Object.entries(c.timers ?? {})) expect(s.rows[Number(slot) - 1]?.remainingMs).toBe(ms);
    });
  }

  it.skipIf(!frames.some((f) => /^s13_t\d+\.png$/.test(f)))('每秒一张的连拍，倒计时逐张递减 1 秒', async () => {
    const seq = frames.filter((f) => /^s13_t\d+\.png$/.test(f)).sort((a, b) => Number(a.match(/\d+/g)!.at(-1)) - Number(b.match(/\d+/g)!.at(-1)));
    const reads: number[] = [];
    for (const f of seq) {
      const s = await sample(f);
      const first = s.rows.find((r) => r.status !== 'idle' && r.remainingMs != null);
      if (first) reads.push(first.remainingMs!);
    }
    for (let i = 1; i < reads.length; i++) expect(reads[i - 1]! - reads[i]!).toBe(1000);
  });
});
