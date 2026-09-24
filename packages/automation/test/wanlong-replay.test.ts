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
import type { RawFrame, TemplateDefinition, TemplateSet } from '../src/contracts.js';
import { buildTemplateAlpha, matchTemplate, prepareFrame, prepareTemplate } from '../src/index.js';
import {
  applySample, buildSchedulerTemplates, defaultSchedulerConfig, emptyInstanceState, loadGatherTemplates, planNextWake,
  sampleTroopPanel, type GatherTemplates, type SampleIo, type SchedulerTemplates,
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

/** 不透明像素占比（掩码 255 = 参与匹配）。 */
function coverage(mask: Uint8Array): number {
  let on = 0
  for (const v of mask) if (v) on++
  return on / mask.length
}

describe.skipIf(!enabled)('真机帧回放：部队管理面板采样器', () => {
  let g: GatherTemplates;
  let t: SchedulerTemplates;
  const frames = enabled ? readdirSync(FRAMES!).filter((f) => f.toLowerCase().endsWith('.png')).sort() : [];
  const sample = async (file: string) => sampleTroopPanel(readOnlyIo(await rawOf(join(FRAMES!, file))), t, {
    refWidth: 2560, refHeight: 1440, maxRows: 5, readOptionalFields: true, closePanelAfterSample: false, deadlineAt: Date.now() + 120_000,
  });

  it('loads the private template set once', async () => {
    g = await loadGatherTemplates({ templateDir: TEMPLATES!, requireCritical: false });
    t = buildSchedulerTemplates(g);
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

  /**
   * ★ 整个帧目录扫一遍（原版 check:sched 主循环）：认成「面板已打开」的帧一律只读读完（点击 / 按键会抛错），
   *   读出来的状态必须能排出下一次唤醒；文件名带 panel 的帧必须读得出来。别的帧（城内、世界地图）抛错算正常跳过。
   */
  it.skipIf(frames.length === 0)('帧目录里的面板帧全部只读读出，并能排出下一次唤醒', async () => {
    const config = defaultSchedulerConfig()
    let panels = 0
    for (const f of frames) {
      let s
      try {
        s = await sample(f)
      } catch (error) {
        if (/panel/i.test(f)) throw new Error(`${f} 应当读得出部队管理面板：${(error as Error).message}`)
        continue
      }
      panels++
      let st = emptyInstanceState(0)
      st.auto = true
      st = applySample(st, s, [], config)
      expect(planNextWake(st, config, s.sampledAt), f).not.toBeNull()
    }
    expect(panels).toBeGreaterThan(0)
  })

  /**
   * 透明底模板 + 阵营变体（原版 checkMaskedVariants，2026-09-10）：兽族小号城内时主号的地图按钮只有 0.72，
   * 补的 tpl_nav_map_toggle_b 圆环里透着会变的地形，是多帧差分去底的透明底模板。
   */
  describe('透明底模板 / 阵营变体', () => {
    const cases: Array<[string, boolean]> = [
      ['huadong_city.png', true],
      ['huadong_city_pan2.png', true],
      ['huadong_after2.png', true],
      ['zhuhao_city.png', false],
      ['s24_city.png', false],
      ['inst1_worldmap.png', false],
      ['s00_now.png', false],
    ]

    it('tpl_nav_map_toggle_b 已编译，带掩码且不透明占比在 0.3~0.9', () => {
      const tpl = g.ui.get('tpl_nav_map_toggle_b')
      expect(tpl).toBeDefined()
      expect(tpl!.mask).toBeDefined()
      expect(tpl!.mask!.length).toBe(tpl!.width * tpl!.height)
      const c = coverage(tpl!.mask!)
      expect(c).toBeGreaterThanOrEqual(0.3)
      expect(c).toBeLessThanOrEqual(0.9)
    })

    for (const [file, hit] of cases) {
      it.skipIf(!frames.includes(file))(`${file} → ${hit ? '应命中（≥0.9）' : '应不命中'}`, async () => {
        const tpl = g.ui.get('tpl_nav_map_toggle_b')
        expect(tpl).toBeDefined()
        const frame = await prepareFrame(await rawOf(join(FRAMES!, file)), { refWidth: 2560, refHeight: 1440, shrink: tpl!.shrink })
        const m = await matchTemplate(frame, tpl!)
        if (hit) {
          expect(m.found).toBe(true)
          expect(m.score).toBeGreaterThanOrEqual(0.9)
        } else {
          expect(m.found).toBe(false)
        }
      })
    }

    const a = 'huadong_after2.png'
    const b = 'huadong_city_pan2.png'
    it.skipIf(!frames.includes(a) || !frames.includes(b))('α 管线：两帧差分 → 带 α 的 PNG 编译出掩码，同一裁剪不带 α 则没有', async () => {
      const fa = await readFile(join(FRAMES!, a))
      const fb = await readFile(join(FRAMES!, b))
      const crop = { x: 22, y: 1224, w: 196, h: 192 }
      const diff = await buildTemplateAlpha([new Uint8Array(fa), new Uint8Array(fb)], crop, 24)
      expect(diff.coverage).toBeGreaterThan(0.3)
      expect(diff.coverage).toBeLessThan(0.9)
      const cropPng = await sharp(fa).extract({ left: crop.x, top: crop.y, width: crop.w, height: crop.h }).png().toBuffer()
      const alpha = await sharp(diff.alphaPng).resize(crop.w, crop.h, { fit: 'fill' }).extractChannel(0).raw().toBuffer()
      const masked = await sharp(cropPng).removeAlpha().joinChannel(alpha, { raw: { width: crop.w, height: crop.h, channels: 1 } }).png().toBuffer()
      const set: TemplateSet = { id: 'replay', name: '回放', refWidth: 2560, refHeight: 1440, templates: [], directory: FRAMES! }
      const def = (id: string): TemplateDefinition => ({
        id, name: id, file: `${id}.png`, authoredWidth: 2560, authoredHeight: 1440, bounds: { ...crop },
      })
      const withAlpha = await prepareTemplate(new Uint8Array(masked), def('tmp_masked'), set, 2)
      expect(withAlpha.mask).toBeDefined()
      expect(coverage(withAlpha.mask!)).toBeGreaterThan(0.3)
      const plain = await prepareTemplate(new Uint8Array(cropPng), def('tmp_plain'), set, 2)
      expect(plain.mask).toBeUndefined()
      // 透明底模板的 std 只统计不透明像素（与整块不同）。
      expect(Math.abs(withAlpha.std - plain.std)).toBeGreaterThan(1)
    })
  })
});
