/**
 * Port of scripts/resources-offline-check.ts 【六】: the full 道具 → 资源 → 资源统计 flow over a scripted GatherIo.
 * Screens advance only on input, like the original ScriptedIo. A virtual clock makes every wait instant.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { AndroidKey, RawFrame, Rect } from '../src/index.js';
import {
  loadGatherTemplates, readResourceStatsPanel, snapshotRow, type GatherIo, type GatherTemplates,
} from '../src/wanlong/index.js';
import type { AppError } from '../src/wanlong/errors.js';
import { TRUTH, TRUTH_VALUES, buildScreens, writeResourceTemplateSet, type ResourceScreens } from './helpers/resource-fixture.js';
import { GAME, blockPatch, type Screen } from './helpers/synth.js';

class ScriptedIo implements GatherIo {
  cursor = 0;
  captures = 0;
  readonly actions: string[] = [];
  private readonly raws = new Map<Screen, RawFrame>();
  constructor(private readonly script: Screen[], private readonly fg: string | null = GAME) {}
  private advance(what: string): void {
    this.actions.push(what);
    if (this.cursor < this.script.length - 1) this.cursor++;
  }
  async capture(): Promise<RawFrame> {
    this.captures++;
    const screen = this.script[this.cursor]!;
    let raw = this.raws.get(screen);
    if (!raw) { raw = screen.raw(); this.raws.set(screen, raw); }
    return raw;
  }
  async tap(x: number, y: number): Promise<void> { this.advance(`tap ${x},${y}`); }
  async tapMany(points: [number, number][]): Promise<void> { this.advance(`tapMany x${points.length}`); }
  async swipe(x1: number, y1: number, x2: number, y2: number): Promise<void> { this.advance(`swipe ${x1},${y1}->${x2},${y2}`); }
  async key(k: AndroidKey): Promise<void> { this.advance(`key ${k}`); }
  async launchApp(): Promise<void> { this.advance('launchApp'); }
  async foregroundPackage(): Promise<string | null> { return this.fg; }
}

function inside(action: string | undefined, box: Rect): boolean {
  const m = /^tap (\d+),(\d+)$/.exec(action ?? '');
  if (!m) return false;
  const x = Number(m[1]);
  const y = Number(m[2]);
  return x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h;
}

let dir: string;
let templates: GatherTemplates;
let screens: ResourceScreens;

beforeAll(async () => {
  dir = await writeResourceTemplateSet({
    extra: [{ id: 'tpl_btn_close_popup', image: blockPatch(64, 64, 4242), bounds: { x: 1960, y: 300, w: 64, h: 64 }, threshold: 0.8 }],
  });
  templates = await loadGatherTemplates({ templateDir: dir });
  screens = buildScreens();
});

async function run(io: ScriptedIo, extra: { signal?: AbortSignal; templates?: GatherTemplates; templateDir?: string } = {}) {
  let t = 1_789_000_000_000;
  const shots: string[] = [];
  const logs: string[] = [];
  try {
    const snap = await readResourceStatsPanel({
      io, templates: extra.templates ?? templates, templateDir: extra.templateDir ?? dir, instanceIndex: 1,
      log: (level, message) => logs.push(`${level}:${message}`),
      onShot: (label) => { shots.push(label); },
      now: () => (t += 1000),
      signal: extra.signal,
    });
    return { snap, error: null as AppError | null, shots, logs };
  } catch (e) {
    return { snap: null, error: e as AppError, shots, logs };
  }
}

describe('readResourceStatsPanel', () => {
  it('opens the dialog, reads the truth and restores with exactly [tap 道具, tap 资源统计, BACK, BACK]', async () => {
    const io = new ScriptedIo([screens.map, screens.items, screens.dialog, screens.items, screens.map]);
    const r = await run(io);
    expect(r.error).toBeNull();
    for (const row of r.snap!.rows) {
      expect([row.itemTotal, row.total]).toEqual([TRUTH[row.type].item, TRUTH[row.type].total]);
    }
    expect(r.snap!.warnings).toEqual([]);
    expect(io.actions).toHaveLength(4);
    expect(inside(io.actions[0], { x: 2030, y: 1295, w: 145, h: 95 })).toBe(true);
    expect(inside(io.actions[1], { x: 1480, y: 234, w: 200, h: 62 })).toBe(true);
    expect(io.actions.slice(2)).toEqual(['key BACK', 'key BACK']);
    expect(r.shots).toEqual([]);
    expect(io.captures).toBeLessThanOrEqual(15);
    expect(r.logs.some((l) => l.startsWith('info:资源统计读取完成') && l.includes('精度 1000 万'))).toBe(true);
  });

  it.each([
    ['the dialog is open', 'dialog' as const],
    ['the items page is open', 'items' as const],
    ['an unknown screen is shown', 'blank' as const],
  ])('★ sends zero input when %s (当前不在主界面)', async (_name, which) => {
    const io = new ScriptedIo([screens[which]]);
    const r = await run(io);
    expect(r.error?.message).toContain('当前不在主界面');
    expect(r.error?.code).toBe('STEP_FAILED');
    expect(io.actions).toEqual([]);
    expect(r.shots).toEqual(['res-precheck-not-main']);
  });

  it('★ sends zero input and takes no capture when the game is not in the foreground', async () => {
    const io = new ScriptedIo([screens.map], 'com.android.launcher3');
    const r = await run(io);
    expect(r.error?.message).toContain('游戏不在前台');
    expect(r.error?.message).toContain('com.android.launcher3');
    expect(io.actions).toEqual([]);
    expect(io.captures).toBe(0);
  });

  it('closes an event popup by its own × (the only precheck input), then proceeds', async () => {
    const popup = screens.blank.clone().paste(blockPatch(64, 64, 4242), 1960, 300);
    const io = new ScriptedIo([popup, screens.map, screens.items, screens.dialog, screens.items, screens.map]);
    const r = await run(io);
    expect(r.error).toBeNull();
    expect(inside(io.actions[0], { x: 1960, y: 300, w: 64, h: 64 })).toBe(true);
    expect(io.actions).toHaveLength(5);
    expect(snapshotRow(r.snap!, 'gold')!.total).toBe(TRUTH.gold.total);
  });

  it('still restores with BACK×2 when the items page never opens', async () => {
    const io = new ScriptedIo([screens.map]);
    const r = await run(io);
    expect(r.error?.message).toContain('没打开资源页');
    expect(io.actions.filter((a) => a === 'key BACK')).toHaveLength(2);
    expect(inside(io.actions[1], { x: 190, y: 514, w: 20, h: 20 })).toBe(true);
    expect(r.shots).toContain('res-items-page-missing');
  });

  it('taps the close X when the first BACK leaves the dialog open, and says so', async () => {
    const io = new ScriptedIo([screens.map, screens.items, screens.dialog, screens.dialog, screens.items, screens.map]);
    const r = await run(io);
    expect(r.error).toBeNull();
    expect(io.actions.slice(2, 5).map((a) => a.split(' ')[0])).toEqual(['key', 'tap', 'key']);
    expect(inside(io.actions[3], { x: 2068, y: 142, w: 102, h: 102 })).toBe(true);
    expect(r.snap!.warnings).toEqual(['BACK 没关掉资源统计弹窗，用右上角 X 关的']);
  });

  it('falls back to the G0 ladder when BACK×2 does not reach the main screen', async () => {
    const io = new ScriptedIo([screens.map, screens.items, screens.dialog, screens.blank, screens.blank, screens.map]);
    const r = await run(io);
    expect(r.error).toBeNull();
    expect(r.shots).toContain('res-restore-failed');
    expect(r.snap!.warnings.at(-1)).toContain('靠 G0 兜底才回来的');
  });

  it('appends a restore failure to the original error', async () => {
    const io = new ScriptedIo([screens.map, screens.blank]);
    const r = await run(io);
    expect(r.error?.message).toContain('没打开资源页');
    expect(r.error?.message).toContain('另外：读完资源统计后没能回到主界面');
    expect(r.shots).toEqual(expect.arrayContaining(['res-items-page-missing', 'res-restore-failed']));
  });

  it('throws a restore STEP_FAILED after a successful read that cannot get back', async () => {
    const io = new ScriptedIo([screens.map, screens.items, screens.dialog, screens.blank]);
    const r = await run(io);
    expect(r.error?.code).toBe('STEP_FAILED');
    expect(r.error?.detail).toMatchObject({ step: 'restore' });
    expect(r.error?.message).toContain('读完资源统计后没能回到主界面');
  });

  it('re-reads a second frame when a cell is unreadable, merges, and leaves a shot', async () => {
    const bad = buildScreens({ ...TRUTH_VALUES, gold: { item: '25.1亿', total: '11.1亿' } }).dialog;
    const io = new ScriptedIo([screens.map, screens.items, bad, screens.items, screens.map]);
    const r = await run(io);
    expect(r.error).toBeNull();
    expect(snapshotRow(r.snap!, 'gold')).toMatchObject({ itemTotal: null, total: TRUTH.gold.total });
    expect(r.snap!.warnings.some((w) => w.includes('两帧都读不出'))).toBe(true);
    expect(r.shots).toEqual(['res-cell-unreadable']);
    expect(r.logs.some((l) => l.startsWith('warn:第一帧有格子读不出'))).toBe(true);
  });

  it('warns (without moving values) when a row label template does not match', async () => {
    const unlabeled = buildScreens(TRUTH_VALUES, { labels: false }).dialog;
    const io = new ScriptedIo([screens.map, screens.items, unlabeled, screens.items, screens.map]);
    const r = await run(io);
    expect(r.snap!.warnings).toEqual([
      '第 1 行标签不像「金币」，行序可能变了', '第 2 行标签不像「木材」，行序可能变了',
      '第 3 行标签不像「铁矿石」，行序可能变了', '第 4 行标签不像「魔水」，行序可能变了',
    ]);
    expect(snapshotRow(r.snap!, 'mana')!.itemTotal).toBe(TRUTH.mana.item);
  });

  it.each([
    ['tpl_btn_res_stats', 'tpl_btn_res_stats'],
    ['tpl_title_res_stats', 'tpl_title_res_stats'],
    ['the dig_resstat glyph set', 'dig_resstat'],
  ])('refuses before any input or capture when %s is missing', async (_name, missing) => {
    const partial = await writeResourceTemplateSet(missing === 'dig_resstat' ? { noGlyphs: true } : { omit: [missing] });
    const t = await loadGatherTemplates({ templateDir: partial });
    const io = new ScriptedIo([screens.map]);
    const r = await run(io, { templates: t, templateDir: partial });
    expect(r.error?.code).toBe('TEMPLATE_NOT_FOUND');
    expect(r.error?.message).toContain(missing);
    expect(r.error?.message).toContain('导入资源统计模板');
    expect(io.actions).toEqual([]);
    expect(io.captures).toBe(0);
  });

  it('stops without input when the run is already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const io = new ScriptedIo([screens.map]);
    const r = await run(io, { signal: controller.signal });
    expect(r.error?.code).toBe('CANCELLED');
    expect(io.actions).toEqual([]);
  });
});
