/**
 * 部队管理面板采样器 sampleTroopPanel（原版 scheduler/troopPanel.ts）。
 *
 * 原版 check:sched 回放真机截图；截图与模板不能进仓库，所以这里用合成画面覆盖同样的判据：
 *   · 面板帧只读不点（closePanelAfterSample=false 时 0 次点击 / 按键）；非面板帧绝不产出假数据；
 *   · 行中心按「坐标:」标签扫描（行距 243，漂移也能跟上）；空位 / 未知状态分开；「采集中」图标兜底；
 *   · 行内资源缩略图（前缀扫描、变体后缀）、载重进度条占比；
 *   · 冷启动（加时 180s、+6 轮、只看不点）、顶号 / 更新 / AI 三种探针回复、单次 BACK + 只点「取消」。
 * 真机帧回放在 wanlong-replay.test.ts（需要 WL_FRAMES_DIR 与 WL_TEMPLATE_DIR，缺了就跳过）。
 */
import { describe, expect, it } from 'vitest';
import type { PreparedTemplate, RawFrame } from '../src/contracts.js';
import { prepareFrame } from '../src/vision.js';
import {
  buildSchedulerTemplates, detectRowCenters, readRowFill, sampleTroopPanel,
  type GatherTemplates, type SampleIo, type SampleOptions, type SchedulerTemplates,
} from '../src/wanlong/index.js';
import type { GlyphSet } from '../src/wanlong/vision/digits.js';
import { Canvas, glyphEntries, makeFont, uiTemplate, type Font } from './helpers/synthetic.js';

const BG = 200;
const darkFont = makeFont(11);
const lightFont = makeFont(23);
const coordFont = makeFont(37);

/** Every synthetic control: id → stamp rect (reference px, even). `tw` widens the template past the stamp. */
const STAMPS = {
  tpl_panel_title_troop: { x: 1000, y: 30, w: 200, h: 60 },
  tpl_queue_icon_panel: { x: 2140, y: 40, w: 32, h: 40, tw: 40 },
  tpl_nav_city_toggle: { x: 40, y: 1300, w: 120, h: 120 },
  tpl_queue_icon_map: { x: 2480, y: 560, w: 60, h: 60 },
  tpl_nav_map_toggle: { x: 200, y: 1260, w: 120, h: 120 },
  tpl_btn_close_popup: { x: 2300, y: 100, w: 60, h: 60 },
  tpl_dlg_title_notice: { x: 1100, y: 400, w: 200, h: 60 },
  tpl_btn_cancel: { x: 1488, y: 940, w: 120, h: 60 },
  // Row-relative controls (y is relative to the row centre).
  tpl_label_coord_row: { x: 1143, y: 58, w: 68, h: 30, tw: 76 },
  tpl_status_returning: { x: 1432, y: 30, w: 98, h: 34 },
  tpl_status_gather_marching: { x: 1432, y: 30, w: 160, h: 34 },
  // The word sits on the (green) load bar; its crop ends in 8 px of bar, as a real crop would.
  tpl_status_gathering: { x: 1542, y: 34, w: 90, h: 26, tw: 98, pad: [60, 150, 60] },
  tpl_status_icon_gathering: { x: 1366, y: 20, w: 56, h: 56 },
  tpl_row_res_gold: { x: 1130, y: -50, w: 100, h: 100 },
  tpl_row_res_wood_v2: { x: 1130, y: -50, w: 100, h: 100 },
  tpl_row_res_gem: { x: 1130, y: -50, w: 100, h: 100 },
} as const;
type StampId = keyof typeof STAMPS;

async function templateOf(id: StampId): Promise<PreparedTemplate> {
  const s = STAMPS[id] as { w: number; h: number; tw?: number; pad?: readonly [number, number, number] };
  const w = s.tw ?? s.w;
  const c = new Canvas(w, s.h, s.pad ? [...s.pad] : [BG, BG, BG]).stamp(id, 0, 0, s.w, s.h);
  const frame = await prepareFrame(c.raw(), { refWidth: w, refHeight: s.h, shrink: 2 });
  return uiTemplate(frame, id, 0, 0, w, s.h);
}

async function templates(omit: StampId[] = []): Promise<SchedulerTemplates> {
  const ui = new Map<string, PreparedTemplate>();
  for (const id of Object.keys(STAMPS) as StampId[]) if (!omit.includes(id)) ui.set(id, await templateOf(id));
  // buildSchedulerTemplates reads the character from each template id, so `char` is irrelevant here.
  const glyph = (name: string, entries: [string, PreparedTemplate][]) =>
    ({ name, glyphs: entries.map(([, tpl]) => ({ char: '?', tpl })), medianGlyphW: 15 }) as unknown as GlyphSet;
  const glyphSets = new Map<string, GlyphSet>([
    ['dig_dark20', glyph('dig_dark20', glyphEntries('dig_dark20', darkFont, BG, 40))],
    ['dig_light16', glyph('dig_light16', glyphEntries('dig_light16', lightFont, 138, 245))],
    ['dig_card_coord', glyph('dig_card_coord', glyphEntries('dig_card_coord', coordFont, BG, 60))],
  ]);
  const gather = {
    setId: 'synthetic', refWidth: 2560, refHeight: 1440, ui, glyphSets, missing: [],
    has: (id: string) => ui.has(id), get: (id: string) => ui.get(id),
  } as unknown as GatherTemplates;
  return buildSchedulerTemplates(gather);
}

function stampAt(c: Canvas, id: StampId, rowCenter = 0): void {
  const s = STAMPS[id];
  c.stamp(id, s.x, rowCenter + s.y, s.w, s.h);
}

interface RowSpec {
  center: number;
  kind: 'returning' | 'gatherMarching' | 'gathering' | 'gatheringIconOnly' | 'unknown';
  timer?: string;
  coord?: string;
  resource?: StampId;
  /** Green share of the load bar, 0..1 (gathering rows). */
  fill?: number;
}

function drawText(c: Canvas, font: Font, text: string, x: number, y: number, ink: number): void {
  c.text(font, text, x, y, ink);
}

function panel(rows: RowSpec[], queue = '2/5'): Canvas {
  const c = new Canvas();
  stampAt(c, 'tpl_panel_title_troop');
  stampAt(c, 'tpl_queue_icon_panel');
  drawText(c, darkFont, queue, 2182, 50, 40);
  for (const r of rows) {
    const y = r.center;
    stampAt(c, 'tpl_label_coord_row', y);
    if (r.coord) drawText(c, coordFont, r.coord, 1222, y + 64, 60);
    if (r.resource) stampAt(c, r.resource, y);
    if (r.kind === 'returning' || r.kind === 'gatherMarching') {
      const id = r.kind === 'returning' ? 'tpl_status_returning' : 'tpl_status_gather_marching';
      stampAt(c, id, y);
      if (r.timer) drawText(c, darkFont, r.timer, STAMPS[id].x + STAMPS[id].w + 6, y + 38, 40);
    }
    if (r.kind === 'gathering' || r.kind === 'gatheringIconOnly') {
      const green = Math.round((r.fill ?? 0) * 504);
      c.rect(1405, y + 29, 536, 37, [138, 138, 138]);
      if (green > 0) c.rect(1432, y + 29, green, 37, [60, 150, 60]);
      if (r.kind === 'gathering') {
        stampAt(c, 'tpl_status_gathering', y);
        if (r.timer) drawText(c, lightFont, r.timer, 1642, y + 38, 245);
      } else {
        stampAt(c, 'tpl_status_icon_gathering', y);
        if (r.timer) drawText(c, lightFont, r.timer, 1642, y + 38, 245);
      }
    }
  }
  return c;
}

function worldMap(entry = true): Canvas {
  const c = new Canvas();
  stampAt(c, 'tpl_nav_city_toggle');
  if (entry) stampAt(c, 'tpl_queue_icon_map');
  return c;
}

interface FakeIo extends SampleIo {
  taps: Array<{ x: number; y: number; intent?: string }>;
  keys: Array<{ key: string; intent?: string }>;
  captures: number;
  clock: { now: number };
}

/** `frames` is consumed in order; the last one repeats. `after` swaps the script after an input. */
function fakeIo(frames: Canvas[], extra: Partial<SampleIo> = {}, onInput?: (io: FakeIo) => void): FakeIo {
  const raws: RawFrame[] = frames.map((f) => f.raw());
  const io: FakeIo = {
    serial: '实例 #1',
    taps: [], keys: [], captures: 0, clock: { now: 1_000_000 },
    async capture() { io.captures++; return raws.length > 1 ? raws.shift()! : raws[0]!; },
    async tapRef(x, y, intent) { io.taps.push({ x, y, ...(intent ? { intent } : {}) }); onInput?.(io); },
    async key(key, intent) { io.keys.push({ key, ...(intent ? { intent } : {}) }); onInput?.(io); },
    async sleep(ms) { io.clock.now += ms; },
    ...extra,
  } as FakeIo;
  (io as { replace?: (next: Canvas[]) => void }).replace = (next) => { raws.splice(0, raws.length, ...next.map((f) => f.raw())); };
  return io;
}

function replace(io: FakeIo, next: Canvas[]): void {
  (io as unknown as { replace: (n: Canvas[]) => void }).replace(next);
}

function options(io: FakeIo, patch: Partial<SampleOptions> = {}): SampleOptions {
  return {
    refWidth: 2560, refHeight: 1440, maxRows: 5, readOptionalFields: true, closePanelAfterSample: false,
    deadlineAt: io.clock.now + 60_000, now: () => io.clock.now, ...patch,
  };
}

const t = await templates();

describe('sampleTroopPanel on an open panel', () => {
  it('reads N/M and every row without a single tap or key; rows follow the scanned centres', async () => {
    const frame = panel([
      { center: 248, kind: 'returning', timer: '00:01:04', coord: '615,535', resource: 'tpl_row_res_gold' },
      // Drift of +13 px against the fixed pitch of 243: the label scan must follow it.
      { center: 248 + 243 + 13, kind: 'gatherMarching', timer: '00:05:30', coord: '1231,717' },
    ]);
    const io = fakeIo([frame]);
    const s = await sampleTroopPanel(io, t, options(io));
    expect(io.taps).toEqual([]);
    expect(io.keys).toEqual([]);
    expect(s.queueUsed).toBe(2);
    expect(s.queueTotal).toBe(5);
    expect(s.rows.map((r) => r.status)).toEqual(['returning', 'gatherMarching', 'idle', 'idle', 'idle']);
    expect(s.rows[0]).toMatchObject({ remainingMs: 64_000, targetCoord: '615,535', resourceType: 'gold', statusText: '返回中' });
    expect(s.rows[1]).toMatchObject({ remainingMs: 330_000, targetCoord: '1231,717', resourceType: null });
    expect(s.rows[0]!.commanders).toEqual([{ current: null, max: null }, { current: null, max: null }]);
    expect(s.warnings).toEqual([]);
    expect(s.sampledAt).toBe(io.clock.now);
  });

  it('detectRowCenters finds centres at pitch 243 and ignores labels outside the row band', async () => {
    const c = panel([{ center: 248, kind: 'returning' }, { center: 491 + 1, kind: 'returning' }, { center: 734, kind: 'returning' }]);
    // A card's 「坐标:」 far to the left of the row band must not become a row.
    c.stamp('tpl_label_coord_row', 400, 1000, 68, 30);
    const ui = await prepareFrame(c.raw(), { refWidth: 2560, refHeight: 1440, shrink: 2 });
    expect(await detectRowCenters(ui, t, 5)).toEqual([248, 492, 734]);
  });

  it('classifies idle vs unknown rows, uses the gathering icon fallback and warns on an N/M mismatch', async () => {
    const frame = panel([
      { center: 248, kind: 'gatheringIconOnly', timer: '01:44:06', fill: 0.5, resource: 'tpl_row_res_wood_v2' },
      { center: 492, kind: 'unknown', coord: '674,627', resource: 'tpl_row_res_gem' },
      { center: 734, kind: 'gathering', timer: '00:00:23', fill: 0.9 },
    ], '4/5');
    const io = fakeIo([frame]);
    const s = await sampleTroopPanel(io, t, options(io, { readOptionalFields: false }));
    expect(s.rows[0]).toMatchObject({ status: 'gathering', remainingMs: (3600 + 44 * 60 + 6) * 1000, resourceType: 'wood' });
    expect(s.rows[0]!.fillRatio).toBeCloseTo(0.5, 2);
    expect(s.rows[1]).toMatchObject({ status: 'unknown', targetCoord: '674,627', resourceType: null, remainingMs: null });
    expect(s.rows[1]!.warning).toContain('状态词认不出来');
    expect(s.rows[2]).toMatchObject({ status: 'gathering', remainingMs: 23_000 });
    expect(s.rows[2]!.fillRatio).toBeCloseTo(0.9, 2);
    expect(s.rows[2]!.commanders).toEqual([]);
    expect(s.rows.slice(3).every((r) => r.status === 'idle')).toBe(true);
    expect(s.warnings.some((w) => w.includes('表头显示已用队列 4'))).toBe(true);
  });

  it('keeps N/M null with a warning when the header cannot be read', async () => {
    const io = fakeIo([panel([{ center: 248, kind: 'returning', timer: '00:01:04' }], '')]);
    const s = await sampleTroopPanel(io, t, options(io));
    expect(s.queueUsed).toBeNull();
    expect(s.queueTotal).toBeNull();
    expect(s.warnings.length).toBeGreaterThan(0);
    expect(s.rows[0]!.remainingMs).toBe(64_000);
  });

  it('closes the panel with BACK after sampling and cancels an exit dialog (never confirms)', async () => {
    const dialog = worldMap();
    dialog.stamp('tpl_dlg_title_notice', 1100, 400, 200, 60).stamp('tpl_btn_cancel', 1488, 940, 120, 60);
    const io = fakeIo([panel([{ center: 248, kind: 'returning', timer: '00:01:04' }]), dialog]);
    await sampleTroopPanel(io, t, options(io, { closePanelAfterSample: true }));
    expect(io.keys).toEqual([{ key: 'BACK' }]);
    expect(io.taps).toEqual([{ x: 1548, y: 970, intent: 'exitCancel' }]);
  });
});

describe('ensurePanelOpen ladder', () => {
  it('taps the map entry (x=2522) on the world map, then reads the panel', async () => {
    const io = fakeIo([worldMap()], {}, (self) => replace(self, [panel([{ center: 248, kind: 'returning', timer: '00:01:04' }])]));
    const s = await sampleTroopPanel(io, t, options(io));
    expect(io.taps).toEqual([{ x: 2522, y: 592 }]);
    expect(s.rows[0]!.status).toBe('returning');
  });

  it('switches from the city to the world map first', async () => {
    const city = new Canvas();
    city.stamp('tpl_nav_map_toggle', 200, 1260, 120, 120);
    const io = fakeIo([city], {}, (self) => replace(self, self.taps.length === 1 ? [worldMap()] : [panel([])]));
    await sampleTroopPanel(io, t, options(io));
    expect(io.taps).toEqual([{ x: 125, y: 1319 }, { x: 2522, y: 592 }]);
  });

  it('treats a world map without the entry icon as “no troops out” without tapping', async () => {
    const io = fakeIo([worldMap(false)]);
    const s = await sampleTroopPanel(io, t, options(io, { maxRows: 4 }));
    expect(io.taps).toEqual([]);
    expect(s).toMatchObject({ queueUsed: 0, queueTotal: 4 });
    expect(s.rows.map((r) => r.status)).toEqual(['idle', 'idle', 'idle', 'idle']);
    expect(s.warnings[0]).toContain('没有部队管理入口');
  });

  it('on an unknown screen: waits twice, taps a matched popup ×, presses BACK once, then refuses — never inventing data', async () => {
    const popup = new Canvas();
    popup.stamp('tpl_btn_close_popup', 2300, 100, 60, 60);
    const io = fakeIo([popup, popup, popup, new Canvas()]);
    await expect(sampleTroopPanel(io, t, options(io))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(io.taps).toEqual([{ x: 2330, y: 130, intent: 'closePopup' }]);
    expect(io.keys).toEqual([{ key: 'BACK', intent: 'probeBack' }]);
  });

  it('after the blind BACK, cancels the exit dialog only when the cancel template exists', async () => {
    const dialog = new Canvas();
    dialog.stamp('tpl_dlg_title_notice', 1100, 400, 200, 60).stamp('tpl_btn_cancel', 1488, 940, 120, 60);
    const withCancel = fakeIo([new Canvas(), new Canvas(), new Canvas(), dialog, new Canvas()]);
    await expect(sampleTroopPanel(withCancel, t, options(withCancel))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(withCancel.taps).toEqual([{ x: 1548, y: 970, intent: 'exitCancel' }]);

    const noCancel = await templates(['tpl_btn_cancel']);
    const without = fakeIo([new Canvas(), new Canvas(), new Canvas(), dialog, new Canvas()]);
    await expect(sampleTroopPanel(without, noCancel, options(without))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(without.taps).toEqual([]);
    expect(without.keys).toEqual([{ key: 'BACK', intent: 'probeBack' }]);
  });

  it('stops without BACK when the probe hands the instance to the alert centre', async () => {
    const io = fakeIo([new Canvas()], { onUnrecognized: async () => true });
    await expect(sampleTroopPanel(io, t, options(io))).rejects.toMatchObject({ code: 'NOT_FOUND', message: expect.stringContaining('顶号') });
    expect(io.keys).toEqual([]);
  });

  it.each(['GAME_UPDATE_REQUIRED', 'AI_RISK_BLOCKED', 'RUN_ABORTED'])('propagates %s from the probe and never presses BACK', async (code) => {
    const io = fakeIo([new Canvas()], {
      onUnrecognized: async () => { throw Object.assign(new Error('需要人工处理'), { code }); },
    });
    await expect(sampleTroopPanel(io, t, options(io))).rejects.toMatchObject({ code });
    expect(io.keys).toEqual([]);
    expect(io.taps).toEqual([]);
  });

  it('a failing probe counts as a miss, not an error', async () => {
    const io = fakeIo([new Canvas()], { onUnrecognized: async () => { throw new Error('probe broke'); } });
    await expect(sampleTroopPanel(io, t, options(io))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(io.keys).toEqual([{ key: 'BACK', intent: 'probeBack' }]);
  });

  it('“updated”: the update wait does not consume the sampling deadline and nothing is pressed', async () => {
    const io = fakeIo([new Canvas()]);
    const opts = options(io);
    let handled = 0;
    io.onUnrecognized = async () => {
      handled++;
      io.clock.now += 120_000; // A two-minute download.
      replace(io, [panel([{ center: 248, kind: 'returning', timer: '00:01:04' }])]);
      return 'updated';
    };
    const s = await sampleTroopPanel(io, t, opts);
    expect(handled).toBe(1);
    expect(opts.deadlineAt).toBeGreaterThan(io.clock.now);
    expect(io.keys).toEqual([]);
    expect(s.rows[0]!.status).toBe('returning');
  });

  it('“recovered”: recaptures instead of pressing BACK', async () => {
    const io = fakeIo([new Canvas()]);
    io.onUnrecognized = async () => { replace(io, [panel([])]); return 'recovered'; };
    await sampleTroopPanel(io, t, options(io));
    expect(io.keys).toEqual([]);
  });
});

describe('cold start inside the sampler', () => {
  it('launches once at attempt 2, extends the deadline by 180 s and 6 attempts, and only looks while loading', async () => {
    const launcher = new Canvas(undefined, undefined, [30, 30, 30]);
    const io = fakeIo([launcher]);
    const opts = options(io);
    const deadline0 = opts.deadlineAt;
    let launches = 0;
    let inputsAtLaunch = -1;
    io.ensureGameForeground = async () => {
      launches++;
      inputsAtLaunch = io.taps.length + io.keys.length;
      // Loading screen for a while, then the world map with no troops out.
      const loading = Array.from({ length: 8 }, () => new Canvas(undefined, undefined, [10, 10, 10]));
      replace(io, [...loading, worldMap(false)]);
      return 'launched';
    };
    const s = await sampleTroopPanel(io, t, opts);
    expect(launches).toBe(1);
    expect(inputsAtLaunch).toBe(0);
    expect(opts.deadlineAt).toBe(deadline0 + 180_000);
    expect(io.taps).toEqual([]);
    expect(io.keys).toEqual([]);
    expect(s.queueUsed).toBe(0);
  });

  it('a failed launch falls back to the ordinary ladder (probe, ×, one BACK)', async () => {
    const io = fakeIo([new Canvas()], { ensureGameForeground: async () => 'failed' });
    await expect(sampleTroopPanel(io, t, options(io))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(io.keys).toEqual([{ key: 'BACK', intent: 'probeBack' }]);
  });

  it('“foreground” (game already up) is only tried once and does not extend the deadline', async () => {
    let calls = 0;
    const io = fakeIo([new Canvas()], { ensureGameForeground: async () => { calls++; return 'foreground'; } });
    const opts = options(io);
    await expect(sampleTroopPanel(io, t, opts)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(calls).toBe(1);
    expect(opts.deadlineAt).toBe(1_000_000 + 60_000);
  });

  it('times out with guidance when the deadline passes', async () => {
    const io = fakeIo([new Canvas()]);
    const opts = options(io, { deadlineAt: io.clock.now + 1000 });
    await expect(sampleTroopPanel(io, t, opts)).rejects.toMatchObject({ code: 'TIMEOUT', message: expect.stringContaining('超时') });
  });
});

describe('readRowFill', () => {
  it('measures the green share on two scan lines and rejects lines that are not a bar', () => {
    const c = new Canvas();
    c.rect(1405, 248 + 29, 536, 37, [138, 138, 138]).rect(1432, 248 + 29, 126, 37, [60, 150, 60]);
    expect(readRowFill(c.raw(), { refWidth: 2560, refHeight: 1440 }, 248)).toBeCloseTo(0.25, 2);
    const short = new Canvas();
    short.rect(1432, 248 + 29, 200, 37, [138, 138, 138]);
    expect(readRowFill(short.raw(), { refWidth: 2560, refHeight: 1440 }, 248)).toBeNull();
    const empty = new Canvas();
    empty.rect(1405, 248 + 29, 536, 37, [138, 138, 138]);
    expect(readRowFill(empty.raw(), { refWidth: 2560, refHeight: 1440 }, 248)).toBe(0);
  });
});
