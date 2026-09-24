/**
 * Port of scripts/game-update-offline-check.ts. The four calibrated crops are game art and cannot be committed,
 * so synthetic high-texture stand-ins are placed at the original geometry. With WANLONG_UPDATE_TEMPLATES pointing to
 * the old panel's resources/game-update folder, the same detection cases also run on the real crops.
 */
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TemplateLibrary, loadTemplateSet, type AndroidKey, type RawFrame } from '../src/index.js';
import {
  AI_RISK_BLOCKED, GAME_UPDATE_DEFAULT_THRESHOLD, GAME_UPDATE_LEGACY_FILES, GAME_UPDATE_REQUIRED, GAME_UPDATE_ROI,
  GAME_UPDATE_TPL, GameUpdateRecovery, createUpdateAwareAdvisor, importGameUpdateTemplates,
  isNeedsAttentionError, loadGatherTemplates, normalizeGatherConfig, recoverUnknownWithUpdate,
  type GatherIo, type OverlayConsultResult, type UpdateContext,
} from '../src/wanlong/index.js';
import { AppError } from '../src/wanlong/errors.js';
import { ensureWorldMap } from '../src/wanlong/gather/navigation.js';
import { GatherSession } from '../src/wanlong/gather/session.js';
import {
  GAME, Screen, blockPatch, criticalTemplates, removeTempDirs, tempDir, toPng, writeTemplateSet, type Gray, type SynthTemplate,
} from './helpers/synth.js';

// Original crop sizes and positions (message 870×52 @ 844,570; confirm 450×155 @ 1320,827; progress text @ 1010,1207).
const MESSAGE = blockPatch(870, 52, 301, 32);
const CONFIRM = blockPatch(450, 155, 302, 32);
const DOWNLOADING = blockPatch(192, 42, 303, 16);
const CHECKING = blockPatch(193, 42, 304, 16);

function updateTemplates(overrides: Partial<Record<keyof typeof GAME_UPDATE_TPL, Partial<SynthTemplate> | null>> = {}): SynthTemplate[] {
  const base: Record<keyof typeof GAME_UPDATE_TPL, SynthTemplate> = {
    message: { id: GAME_UPDATE_TPL.message, image: MESSAGE, bounds: { x: 844, y: 570, w: 870, h: 52 } },
    confirm: { id: GAME_UPDATE_TPL.confirm, image: CONFIRM, bounds: { x: 1320, y: 827, w: 450, h: 155 } },
    downloading: { id: GAME_UPDATE_TPL.downloading, image: DOWNLOADING, bounds: { x: 1010, y: 1207, w: 192, h: 42 } },
    checking: { id: GAME_UPDATE_TPL.checking, image: CHECKING, bounds: { x: 1010, y: 1207, w: 193, h: 42 } },
  };
  const out: SynthTemplate[] = [];
  for (const key of Object.keys(base) as (keyof typeof GAME_UPDATE_TPL)[]) {
    const o = overrides[key];
    if (o === null) continue;
    out.push({ ...base[key], ...o });
  }
  return out;
}

function screen(options: { text?: boolean; button?: boolean; dx?: number; progress?: Gray | null; seed?: number } = {}): Screen {
  const s = new Screen(2560, 1440, options.seed ?? 21).fill({ x: 600, y: 420, w: 1400, h: 700 }, 238);
  if (options.text !== false) s.paste(MESSAGE, 844, 570);
  if (options.button !== false) s.paste(CONFIRM, 1320 + (options.dx ?? 0), 827);
  if (options.progress) s.paste(options.progress, 1010, 1207);
  return s;
}

const promptScreen = screen();
const prompt = promptScreen.raw();
const ready = new Screen(2560, 1440, 22).raw();
const downloading = screen({ text: false, button: false, progress: DOWNLOADING, seed: 23 }).raw();
const checking = screen({ text: false, button: false, progress: CHECKING, seed: 24 }).raw();

let dir: string;
beforeAll(async () => { dir = await writeTemplateSet(updateTemplates()); });
afterAll(removeTempDirs);

function scenario(options: {
  maxWait?: number; frame?: (n: number) => RawFrame; abortAt?: number; foreground?: () => string;
  templateDir?: string;
} = {}) {
  let time = 0;
  let captures = 0;
  const taps: [number, number][] = [];
  const messages: string[] = [];
  const updater = new GameUpdateRecovery({
    templateDir: () => options.templateDir ?? dir,
    now: () => time,
    sleep: async (ms) => { time += ms; },
    maxWaitMs: options.maxWait ?? 60_000,
  });
  const ctx: UpdateContext = {
    raw: prompt,
    refWidth: 2560,
    refHeight: 1440,
    io: {
      capture: async () => { captures++; return options.frame ? options.frame(captures) : captures === 1 ? prompt : ready; },
      foregroundPackage: async () => options.foreground?.() ?? GAME,
      tap: async (x, y) => { taps.push([x, y]); },
    },
    check: () => {
      if (options.abortAt !== undefined && time >= options.abortAt) throw new AppError('RUN_ABORTED', 'stopped');
    },
    recognize: async (raw) => raw === ready,
    log: (message) => { messages.push(message); },
  };
  return { updater, ctx, taps, messages, time: () => time };
}

describe('GameUpdateRecovery.detect / progress', () => {
  it('needs both templates in the calibrated relative geometry, on 16:9 frames of any size', async () => {
    const matcher = new GameUpdateRecovery({ templateDir: () => dir });
    const hit = (await matcher.detect(prompt))!;
    expect(Math.abs(hit.x - 1545)).toBeLessThanOrEqual(2);
    expect(Math.abs(hit.y - 904.5)).toBeLessThanOrEqual(2);
    expect(await matcher.detect(await promptScreen.rawResized(1280, 720))).toBeTruthy();
    expect(await matcher.detect(screen({ text: false }).raw())).toBeNull(); // an ordinary confirmation cannot authorize an update
    expect(await matcher.detect(screen({ button: false }).raw())).toBeNull();
    expect(await matcher.detect(screen({ dx: 70 }).raw())).toBeNull(); // unrelated button
    expect(await matcher.detect(await promptScreen.rawResized(1280, 800))).toBeNull(); // not 16:9
    expect(await matcher.detect(ready)).toBeNull();
  });

  it('detects on 960×540 AVD frames once the two templates are recaptured at that resolution', async () => {
    const k = 960 / 2560;
    const scaled = (r: { x: number; y: number; w: number; h: number }) =>
      ({ x: Math.round(r.x * k), y: Math.round(r.y * k), w: Math.round(r.w * k), h: Math.round(r.h * k) });
    const [m, c] = [scaled({ x: 844, y: 570, w: 870, h: 52 }), scaled({ x: 1320, y: 827, w: 450, h: 155 })];
    const avdSet = await writeTemplateSet([
      { id: GAME_UPDATE_TPL.message, image: await promptScreen.cropResized(960, 540, m), bounds: { x: 844, y: 570, w: 870, h: 52 }, authoredWidth: 960, authoredHeight: 540 },
      { id: GAME_UPDATE_TPL.confirm, image: await promptScreen.cropResized(960, 540, c), bounds: { x: 1320, y: 827, w: 450, h: 155 }, authoredWidth: 960, authoredHeight: 540 },
    ]);
    const avd = new GameUpdateRecovery({ templateDir: () => avdSet });
    const hit = await avd.detect(await promptScreen.rawResized(960, 540));
    expect(hit).toBeTruthy();
    expect(Math.abs(hit!.x - 1545)).toBeLessThanOrEqual(6);
    expect(await avd.detect(await screen({ dx: 70 }).rawResized(960, 540))).toBeNull();
    expect(await avd.detect(await screen({ text: false }).rawResized(960, 540))).toBeNull();
  });

  it('matches only the stable progress wording', async () => {
    const matcher = new GameUpdateRecovery({ templateDir: () => dir });
    expect(await matcher.progress(downloading, false)).toBe(true);
    expect(await matcher.progress(checking, false)).toBe(false);
    expect(await matcher.progress(checking, true)).toBe(true);
    expect(await matcher.progress(prompt, true)).toBe(false);
  });

  it('treats the original thresholds as a floor: the manifest can only tighten them', async () => {
    const defaults = new GameUpdateRecovery({ templateDir: () => dir });
    expect((await defaults.status()).thresholds).toEqual(GAME_UPDATE_DEFAULT_THRESHOLD);
    // TemplateLibrary.save / the template page write 0.85 when no threshold is given: it must not loosen the gate.
    const loose = await writeTemplateSet(updateTemplates({
      message: { threshold: 0.85 }, confirm: { threshold: 0.85 }, downloading: { threshold: 0.5 }, checking: { threshold: 0.9 },
    }));
    expect((await new GameUpdateRecovery({ templateDir: () => loose }).status()).thresholds).toEqual(GAME_UPDATE_DEFAULT_THRESHOLD);
    const tighter = await writeTemplateSet(updateTemplates({ message: { threshold: 0.97 }, confirm: { threshold: 0.99 } }));
    expect((await new GameUpdateRecovery({ templateDir: () => tighter }).status()).thresholds)
      .toEqual({ message: 0.97, confirm: 0.99, downloading: 0.94, checking: 0.94 });
    const strict = await writeTemplateSet(updateTemplates({ message: { threshold: 1 } }));
    expect(await new GameUpdateRecovery({ templateDir: () => strict }).detect(await promptScreen.rawResized(960, 540))).toBeNull();
  });

  it('keeps the calibrated confirm gate for templates captured in the app with the default 0.85 threshold', async () => {
    // A slightly different button (a few blocks inverted, confirm score ≈ 0.91) passes 0.85 but must never authorize the tap.
    const similar: Gray = { ...CONFIRM, px: CONFIRM.px.slice() };
    for (let y = 64; y < 96; y++) for (let x = 160; x < 240; x++) similar.px[y * CONFIRM.w + x] = 255 - similar.px[y * CONFIRM.w + x]!;
    const home = await tempDir('avdm-update-capture-');
    const library = new TemplateLibrary(home);
    const set = await library.createSet('wanlong', '万龙觉醒', GAME, 2560, 1440);
    for (const [key, at] of [['message', { x: 844, y: 570, w: 870, h: 52 }], ['confirm', { x: 1320, y: 827, w: 450, h: 155 }]] as const) {
      await library.save(set.directory, {
        id: GAME_UPDATE_TPL[key], name: key, image: await promptScreen.png(), authoredWidth: 2560, authoredHeight: 1440, crop: at,
      });
    }
    const saved = await loadTemplateSet(set.directory);
    expect(saved.templates.find((t) => t.id === GAME_UPDATE_TPL.confirm)!.threshold).toBe(0.85);
    const updater = new GameUpdateRecovery({ templateDir: () => set.directory });
    expect((await updater.status()).thresholds).toMatchObject({ message: 0.94, confirm: 0.96 });
    expect(await updater.detect(prompt)).toBeTruthy();
    const lookalike = new Screen(2560, 1440, 21).fill({ x: 600, y: 420, w: 1400, h: 700 }, 238).paste(MESSAGE, 844, 570).paste(similar, 1320, 827);
    expect(await updater.detect(lookalike.raw())).toBeNull();
  });

  it('degrades silently when templates or the template set are missing', async () => {
    const missing: string[][] = [];
    const partial = await writeTemplateSet(updateTemplates({ confirm: null, checking: null }));
    const updater = new GameUpdateRecovery({ templateDir: () => partial, onTemplatesMissing: (ids) => missing.push(ids) });
    expect(await updater.detect(prompt)).toBeNull();
    expect(await updater.progress(downloading, true)).toBe(true);
    expect(await updater.available()).toBe(false);
    expect(missing).toEqual([[GAME_UPDATE_TPL.confirm, GAME_UPDATE_TPL.checking]]);
    expect((await updater.status()).missing).toEqual([GAME_UPDATE_TPL.confirm, GAME_UPDATE_TPL.checking]);
    const none = new GameUpdateRecovery({ templateDir: () => null });
    const s = scenario();
    expect(await none.handle(s.ctx)).toBe(false);
    expect(s.taps).toEqual([]);
    const broken = new GameUpdateRecovery({ templateDir: () => join(tmpdir(), 'no-such-template-set') });
    expect(await broken.detect(prompt)).toBeNull();
  });
});

describe('GameUpdateRecovery.handle / wait (virtual clock)', () => {
  it('clicks the calibrated confirm exactly once and waits for a known screen', async () => {
    const complete = scenario();
    expect(await complete.updater.handle(complete.ctx)).toBe(true);
    expect(complete.taps).toHaveLength(1);
    expect(Math.abs(complete.taps[0]![0] - 1545)).toBeLessThanOrEqual(2);
    expect(complete.messages.some((m) => m.includes('识别到游戏资源更新'))).toBe(true);
  });

  it('taps in the caller reference space', async () => {
    const s = scenario();
    s.ctx.refWidth = 1280; s.ctx.refHeight = 720;
    await s.updater.handle(s.ctx);
    expect(Math.abs(s.taps[0]![0] - 772.5)).toBeLessThanOrEqual(1);
    expect(Math.abs(s.taps[0]![1] - 452.25)).toBeLessThanOrEqual(1);
  });

  it('re-detects on a fresh frame before tapping (stale frames never click)', async () => {
    const stale = scenario({ frame: () => ready });
    expect(await stale.updater.handle(stale.ctx)).toBe(true);
    expect(stale.taps).toHaveLength(0);
  });

  it('is cancellable promptly while waiting, and before starting', async () => {
    const cancel = scenario({ frame: () => prompt, abortAt: 100 });
    await expect(cancel.updater.handle(cancel.ctx)).rejects.toMatchObject({ code: 'RUN_ABORTED' });
    expect(cancel.taps).toHaveLength(1);
    expect(cancel.time()).toBe(100);
    const early = scenario({ abortAt: 0 });
    await expect(early.updater.handle(early.ctx)).rejects.toMatchObject({ code: 'RUN_ABORTED' });
    expect(early.taps).toHaveLength(0);
  });

  it('never clicks the update confirmation twice', async () => {
    const unchanged = scenario({ frame: () => prompt });
    await expect(unchanged.updater.handle(unchanged.ctx)).rejects.toMatchObject({ code: GAME_UPDATE_REQUIRED });
    expect(unchanged.taps).toHaveLength(1);
    expect(unchanged.time()).toBeGreaterThanOrEqual(20_000);
  });

  it('times out into GAME_UPDATE_REQUIRED', async () => {
    const timeout = scenario({ maxWait: 6000, frame: (n) => (n === 1 ? prompt : ready) });
    timeout.ctx.recognize = async () => false;
    const error = await timeout.updater.handle(timeout.ctx).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: GAME_UPDATE_REQUIRED });
    expect(isNeedsAttentionError(error)).toBe(true);
    expect(timeout.taps).toHaveLength(1);
  });

  it('stops without clicking when another app takes the foreground', async () => {
    const wrongApp = scenario({ foreground: () => 'com.android.settings' });
    await expect(wrongApp.updater.handle(wrongApp.ctx)).rejects.toMatchObject({ code: GAME_UPDATE_REQUIRED });
    expect(wrongApp.taps).toHaveLength(0);
  });

  it('waits out a slow update without exhausting the AI budget', async () => {
    const slow = scenario({ maxWait: 120_000 });
    slow.ctx.recognize = async () => slow.time() >= 75_000;
    let overlayChecks = 0;
    slow.ctx.recoverOverlay = async () => { overlayChecks++; return false; };
    expect(await slow.updater.handle(slow.ctx)).toBe(true);
    expect(slow.taps).toHaveLength(1);
    expect(overlayChecks).toBe(2);
    expect(slow.messages.some((m) => m.includes('等待游戏更新'))).toBe(true);
  });

  it('resumes an existing download without another confirmation or AI call', async () => {
    const resumed = scenario({ maxWait: 120_000, frame: () => downloading });
    resumed.ctx.raw = downloading;
    resumed.ctx.recognize = async () => resumed.time() >= 75_000;
    let aiCalls = 0;
    resumed.ctx.recoverOverlay = async () => { aiCalls++; return false; };
    expect(await resumed.updater.handle(resumed.ctx)).toBe(true);
    expect(resumed.taps).toHaveLength(0);
    expect(aiCalls).toBe(0);
    expect(resumed.messages.some((m) => m.includes('不重复点击'))).toBe(true);
  });

  it('returns false for an unrelated unknown screen', async () => {
    const s = scenario();
    s.ctx.raw = ready;
    expect(await s.updater.handle(s.ctx)).toBe(false);
    expect(s.taps).toEqual([]);
  });
});

describe('recoverUnknownWithUpdate', () => {
  function base(consult?: (raw: RawFrame, waiting: boolean) => Promise<OverlayConsultResult | null>, frame?: (n: number) => RawFrame) {
    const s = scenario({ frame, maxWait: 60_000 });
    const attention: AppError[] = [];
    const logs: string[] = [];
    const run = (raw: RawFrame, foreground = GAME) => recoverUnknownWithUpdate({
      updater: s.updater, raw, refWidth: 2560, refHeight: 1440,
      io: { capture: s.ctx.io.capture, tap: s.ctx.io.tap },
      foregroundPackage: async () => foreground,
      check: s.ctx.check!, recognize: s.ctx.recognize,
      log: (level, message) => logs.push(`${level}:${message}`),
      consult, onNeedsAttention: (e) => { attention.push(e); },
    });
    return { s, attention, logs, run };
  }

  it('routes an update prompt to the handler even without AI', async () => {
    const { s, run, logs, attention } = base();
    expect(await run(prompt)).toBe('updated');
    expect(s.taps).toHaveLength(1);
    expect(logs.some((l) => l.startsWith('info:[游戏更新]'))).toBe(true);
    expect(attention).toEqual([]);
  });

  it('returns false when nothing applies and AI is off, recovered when AI handled something', async () => {
    expect(await base().run(ready)).toBe(false);
    const handled = base(async () => ({ handled: true, outcome: 'verified', action: 'tap_close' }));
    expect(await handled.run(ready)).toBe('recovered');
    expect(await base(async () => null).run(ready)).toBe(false);
  });

  it('hands an AI-confirmed update on another layout to wait() without a second click', async () => {
    const calls: boolean[] = [];
    const { s, run } = base(async (_raw, waiting) => {
      calls.push(waiting);
      return { handled: false, action: 'none', riskEffect: 'download_update' };
    }, () => ready);
    expect(await run(ready)).toBe('updated');
    expect(s.taps).toEqual([]);
    expect(calls).toEqual([false]);
  });

  it('asks AI with waiting=true for overlays during the download wait', async () => {
    const calls: boolean[] = [];
    const notice = new Screen(2560, 1440, 25).raw(); // an unknown post-update notice, no progress wording
    const { s } = base(undefined, (n) => (n === 1 ? prompt : notice));
    const recognize = async (): Promise<boolean> => s.time() >= 40_000;
    s.ctx.recognize = recognize;
    await expect(recoverUnknownWithUpdate({
      updater: s.updater, raw: prompt, refWidth: 2560, refHeight: 1440,
      io: { capture: s.ctx.io.capture, tap: s.ctx.io.tap }, foregroundPackage: async () => GAME,
      check: () => undefined, recognize, log: () => undefined,
      consult: async (_raw, waiting) => { calls.push(waiting); return { handled: false }; },
    })).resolves.toBe('updated');
    expect(calls).toEqual([true]);
    expect(s.taps).toHaveLength(1);
  });

  it('raises needs-attention for AI_RISK_BLOCKED and rethrows', async () => {
    const { run, attention, s } = base(async () => ({ handled: false, requiresAttention: true, message: '登录确认框，需要人工处理' }));
    await expect(run(ready)).rejects.toMatchObject({ code: AI_RISK_BLOCKED, message: '登录确认框，需要人工处理' });
    expect(attention.map((e) => e.code)).toEqual([AI_RISK_BLOCKED]);
    expect(s.taps).toEqual([]);
  });

  it('raises needs-attention for GAME_UPDATE_REQUIRED even when the hook itself fails', async () => {
    const s = scenario();
    const logs: string[] = [];
    await expect(recoverUnknownWithUpdate({
      updater: s.updater, raw: prompt, refWidth: 2560, refHeight: 1440,
      io: { capture: s.ctx.io.capture, tap: s.ctx.io.tap },
      foregroundPackage: async () => 'com.android.settings',
      check: () => undefined,
      log: (level, message) => logs.push(`${level}:${message}`),
      onNeedsAttention: () => { throw new Error('推送失败'); },
    })).rejects.toMatchObject({ code: GAME_UPDATE_REQUIRED });
    expect(logs.some((l) => l.startsWith('warn:') && l.includes('推送失败'))).toBe(true);
  });

  it('does not raise needs-attention for cancellation', async () => {
    const { attention, s } = base();
    s.ctx.check = () => { throw new AppError('RUN_ABORTED', 'stopped'); };
    const stopped = recoverUnknownWithUpdate({
      updater: s.updater, raw: prompt, refWidth: 2560, refHeight: 1440,
      io: { capture: s.ctx.io.capture, tap: s.ctx.io.tap }, foregroundPackage: async () => GAME,
      check: s.ctx.check, log: () => undefined, onNeedsAttention: (e) => { attention.push(e); },
    });
    await expect(stopped).rejects.toMatchObject({ code: 'RUN_ABORTED' });
    expect(attention).toEqual([]);
  });
});

describe('G0 integration: createUpdateAwareAdvisor inside ensureWorldMap', () => {
  class ScriptedIo implements GatherIo {
    cursor = 0;
    readonly actions: string[] = [];
    constructor(private readonly script: RawFrame[], private readonly fg: () => string = () => GAME) {}
    private advance(what: string): void { this.actions.push(what); if (this.cursor < this.script.length - 1) this.cursor++; }
    async capture(): Promise<RawFrame> { return this.script[this.cursor]!; }
    async tap(x: number, y: number): Promise<void> { this.advance(`tap ${Math.round(x)},${Math.round(y)}`); }
    async tapMany(): Promise<void> { this.advance('tapMany'); }
    async swipe(): Promise<void> { this.advance('swipe'); }
    async key(k: AndroidKey): Promise<void> { this.advance(`key ${k}`); }
    async launchApp(): Promise<void> { this.advance('launchApp'); }
    async foregroundPackage(): Promise<string | null> { return this.fg(); }
  }

  const cityToggle = blockPatch(150, 140, 777);
  let gatherDir: string;
  let worldMap: RawFrame;

  beforeAll(async () => {
    gatherDir = await writeTemplateSet([
      ...criticalTemplates(),
      { id: 'tpl_nav_city_toggle', image: cityToggle, bounds: { x: 50, y: 1270, w: 150, h: 140 }, defaultRoi: { x: 10, y: 1230, w: 280, h: 210 }, threshold: 0.8 },
      ...updateTemplates(),
    ]);
    worldMap = new Screen(2560, 1440, 31).paste(cityToggle, 50, 1270).raw();
  });

  function session(io: GatherIo, updater: GameUpdateRecovery, attention: AppError[], templates: Awaited<ReturnType<typeof loadGatherTemplates>>) {
    let t = 0;
    return new GatherSession({
      io, templates, config: normalizeGatherConfig({}), now: () => (t += 1000), instanceIndex: 2,
      advisor: createUpdateAwareAdvisor({ updater, onNeedsAttention: (e) => { attention.push(e); } }),
    });
  }

  it('confirms the update once, waits, and reaches the world map without any BACK', async () => {
    const templates = await loadGatherTemplates({ templateDir: gatherDir });
    let time = 0;
    const updater = new GameUpdateRecovery({ templateDir: () => gatherDir, now: () => time, sleep: async (ms) => { time += ms; } });
    const io = new ScriptedIo([prompt, downloading, worldMap]);
    let captures = 0;
    const original = io.capture.bind(io);
    io.capture = async () => { captures++; if (captures > 4 && io.cursor === 1) io.cursor = 2; return original(); };
    const attention: AppError[] = [];
    await ensureWorldMap(session(io, updater, attention, templates), 3);
    expect(io.actions).toHaveLength(1);
    expect(io.actions[0]).toMatch(/^tap 154[4-7],90[3-7]$/);
    expect(io.actions.some((a) => a.startsWith('key'))).toBe(false);
    expect(attention).toEqual([]);
  });

  it('propagates GAME_UPDATE_REQUIRED through G0 with zero BACK presses and one attention event', async () => {
    const templates = await loadGatherTemplates({ templateDir: gatherDir });
    let time = 0;
    let fgCalls = 0;
    const updater = new GameUpdateRecovery({ templateDir: () => gatherDir, now: () => time, sleep: async (ms) => { time += ms; } });
    // The game leaves the foreground in the middle of the update wait.
    const io = new ScriptedIo([prompt], () => (++fgCalls > 3 ? 'com.android.launcher3' : GAME));
    const attention: AppError[] = [];
    await expect(ensureWorldMap(session(io, updater, attention, templates), 3)).rejects.toMatchObject({ code: GAME_UPDATE_REQUIRED });
    expect(io.actions.filter((a) => a.startsWith('key'))).toEqual([]);
    expect(attention.map((e) => e.code)).toEqual([GAME_UPDATE_REQUIRED]);
  });
});

describe('importGameUpdateTemplates', () => {
  it('re-anchors the legacy crops on a 2560×1440 canvas and saves them with the calibrated thresholds and ROIs', async () => {
    const library = new TemplateLibrary(await tempDir('avdm-update-import-'));
    const set = await library.createSet('wanlong', '万龙觉醒', GAME, 2560, 1440);
    const result = await importGameUpdateTemplates({
      library, templateDir: set.directory,
      crops: { message: await toPng(MESSAGE), confirm: await toPng(CONFIRM), downloading: await toPng(DOWNLOADING), checking: await toPng(blockPatch(20, 20, 1, 20)) },
    });
    expect(result.saved.sort()).toEqual([GAME_UPDATE_TPL.confirm, GAME_UPDATE_TPL.downloading, GAME_UPDATE_TPL.message].sort());
    expect(result.failed.map((f) => f.id)).toEqual([GAME_UPDATE_TPL.checking]); // a flat crop fails the std guard
    const manifest = await loadTemplateSet(set.directory);
    const confirm = manifest.templates.find((t) => t.id === GAME_UPDATE_TPL.confirm)!;
    expect(confirm).toMatchObject({ threshold: 0.96, bounds: { x: 1320, y: 827, w: 450, h: 155 }, defaultRoi: GAME_UPDATE_ROI.confirm });
    expect(manifest.templates.find((t) => t.id === GAME_UPDATE_TPL.message)!.threshold).toBe(0.94);
    const updater = new GameUpdateRecovery({ templateDir: () => set.directory });
    expect(await updater.detect(prompt)).toMatchObject({ x: 1545 });
    expect(await updater.progress(downloading, false)).toBe(true);
  });

  it('rejects crops that do not fit the legacy geometry', async () => {
    const library = new TemplateLibrary(await tempDir('avdm-update-import-'));
    const set = await library.createSet('wanlong', '万龙觉醒', GAME, 2560, 1440);
    const result = await importGameUpdateTemplates({ library, templateDir: set.directory, crops: { message: await toPng(blockPatch(2000, 52, 5)) } });
    expect(result.saved).toEqual([]);
    expect(result.failed[0]!.reason).toContain('与旧版模板不符');
  });

  it('refuses with a Chinese TEMPLATE_NOT_FOUND (no raw ENOENT) when the template set cannot be read', async () => {
    const library = new TemplateLibrary(await tempDir('avdm-update-import-'));
    const gone = join(await tempDir('avdm-update-gone-'), 'no-such-set');
    const error = await importGameUpdateTemplates({ library, templateDir: gone, crops: {} }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'TEMPLATE_NOT_FOUND' });
    const message = (error as Error).message;
    expect(message).toContain('目录不存在或缺少 manifest.json');
    expect(message).toContain('导入不了游戏资源更新模板');
    expect(message).toContain('请在「模板」页重新选择模板集');
    expect(message).not.toMatch(/ENOENT|realpath/);
  });
});

const REAL = process.env.WANLONG_UPDATE_TEMPLATES;
describe.skipIf(!REAL)('real calibrated crops (private, WANLONG_UPDATE_TEMPLATES)', () => {
  it('imports the legacy folder and detects the composited prompt at 2560 / 1280 / 960 widths', async () => {
    const crops = Object.fromEntries(await Promise.all(Object.entries(GAME_UPDATE_LEGACY_FILES)
      .map(async ([k, f]) => [k, await readFile(join(REAL!, f))])));
    const library = new TemplateLibrary(await tempDir('avdm-update-real-'));
    const set = await library.createSet('wanlong', '万龙觉醒', GAME, 2560, 1440);
    const result = await importGameUpdateTemplates({ library, templateDir: set.directory, crops });
    expect(result.failed).toEqual([]);
    const composite = async (text: boolean, button: boolean, dx = 0, width = 2560): Promise<RawFrame> => {
      const overlays = [
        ...(text ? [{ input: crops.message as Buffer, left: 844, top: 570 }] : []),
        ...(button ? [{ input: crops.confirm as Buffer, left: 1320 + dx, top: 827 }] : []),
      ];
      const png = await sharp({ create: { width: 2560, height: 1440, channels: 4, background: '#f6f6f6' } }).composite(overlays).png().toBuffer();
      const { data, info } = await sharp(png).resize(width).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      return { data: new Uint8Array(data), width: info.width, height: info.height, capturedAt: 0 };
    };
    const updater = new GameUpdateRecovery({ templateDir: () => set.directory });
    expect(await updater.detect(await composite(true, true))).toBeTruthy();
    expect(await updater.detect(await composite(true, true, 0, 1280))).toBeTruthy();
    expect(await updater.detect(await composite(false, true))).toBeNull();
    expect(await updater.detect(await composite(true, false))).toBeNull();
    expect(await updater.detect(await composite(true, true, 70))).toBeNull();
    // 960×540 is reported, not asserted: the calibration was done at 2560×1440 (see docs/wanlong/游戏资源更新.md).
    console.info('[update] 960×540 detect:', await updater.detect(await composite(true, true, 0, 960)));
  });
});
