/**
 * The engine on the real vision pipeline (wanlong-panel scripts/smoke.ts §5, offline): synthetic RGBA frames,
 * a template cut from the frame plus a negative sample from another frame, sharp + OpenCV matching, offset and
 * ROI maths across the three coordinate spaces, and a trace shot encoded from the frame the match used.
 */
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  ScriptContext, ScriptEngine, defaultVision, encodeTraceShot, prepareTemplate,
  type PreparedTemplate, type RawFrame, type TemplateDefinition, type TemplateSet,
} from '../src/index.js';
import type { LogEntry, ScriptDef } from '../src/script/index.js';
import { PKG, fakeDevice } from './script-fakes.js';

/** Device frame 640×360 (as the screencap header says), template set canvas 320×180, script canvas 1280×720. */
const DEVICE = { width: 640, height: 360 };
const SET_REF = { width: 320, height: 180 };
const SCRIPT_REF = { width: 1280, height: 720 };
/** Template bounds on the device frame; 16 px blocks keep edges aligned through every down-sampling. */
const CUT = { x: 192, y: 96, w: 128, h: 80 };
const BLOCK = 16;

/** Block noise: every 16×16 block gets its own colour (deterministic per seed). */
function blockFrame(seed: number): RawFrame {
  const data = new Uint8Array(DEVICE.width * DEVICE.height * 4);
  const colours = new Map<string, [number, number, number]>();
  // mulberry32: an LCG's low bytes repeat every 256 draws, which would make two seeds shifted copies of each other.
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
  for (let y = 0; y < DEVICE.height; y++) {
    for (let x = 0; x < DEVICE.width; x++) {
      const key = `${Math.floor(x / BLOCK)},${Math.floor(y / BLOCK)}`;
      let colour = colours.get(key);
      if (!colour) { const value = next(); colour = [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff]; colours.set(key, colour); }
      const i = (y * DEVICE.width + x) * 4;
      data[i] = colour[0]; data[i + 1] = colour[1]; data[i + 2] = colour[2]; data[i + 3] = 255;
    }
  }
  return { width: DEVICE.width, height: DEVICE.height, data, capturedAt: Date.now() };
}

async function cutTemplate(frame: RawFrame, id: string, set: TemplateSet): Promise<PreparedTemplate> {
  const png = await sharp(Buffer.from(frame.data), { raw: { width: frame.width, height: frame.height, channels: 4 } })
    .extract({ left: CUT.x, top: CUT.y, width: CUT.w, height: CUT.h }).png().toBuffer();
  const definition: TemplateDefinition = {
    id, name: id, file: `${id}.png`, authoredWidth: DEVICE.width, authoredHeight: DEVICE.height, bounds: CUT, threshold: 0.8,
  };
  return prepareTemplate(new Uint8Array(png), definition, set, 2);
}

describe('script engine on real vision (synthetic frames)', () => {
  it('matches a template cut from the frame, rejects a negative sample, applies ROI / offset maths and shoots the matched frame', async () => {
    const screen = blockFrame(7);
    const set: TemplateSet = { id: 'set', name: '合成模板集', packageName: PKG, refWidth: SET_REF.width, refHeight: SET_REF.height, templates: [], directory: '/nonexistent' };
    const anchor = await cutTemplate(screen, 'anchor', set);
    const decoy = await cutTemplate(blockFrame(99), 'decoy', set);

    const device = fakeDevice({ async capture() { device.captures++; return screen; } });
    const encoded: RawFrame[] = [];
    const saved: Array<{ file: string; bytes: Uint8Array }> = [];
    const logs: LogEntry[] = [];
    const def: ScriptDef = {
      id: 'vision', name: '真实视觉', version: '1.0.0', packageName: PKG, templateSetId: 'set',
      refWidth: SCRIPT_REF.width, refHeight: SCRIPT_REF.height, updatedAt: 0,
      steps: [
        { id: 'wait', kind: 'waitFor', cond: { kind: 'template', templateId: 'anchor' }, waitMs: 1000 },
        // Negative sample: a template from another frame must not be found anywhere on this one.
        { id: 'decoy', kind: 'if', cond: { kind: 'template', templateId: 'decoy' },
          then: [{ id: 'never-1', kind: 'tap', at: { x: 1, y: 1 } }], else: [{ id: 'no-decoy', kind: 'log', level: 'info', message: '没有诱饵' }] },
        // ROI in the script canvas that leaves the anchor out: the same template must miss there.
        { id: 'roi-miss', kind: 'if', cond: { kind: 'template', templateId: 'anchor', roi: { x: 0, y: 0, w: 300, h: 150 } },
          then: [{ id: 'never-2', kind: 'tap', at: { x: 2, y: 2 } }], else: [{ id: 'roi-out', kind: 'log', level: 'info', message: 'ROI 外' }] },
        { id: 'hit', kind: 'tapTemplate', templateId: 'anchor', roi: { x: 320, y: 160, w: 400, h: 240 }, offset: { x: 80, y: -40 } },
        { id: 'shot', kind: 'screenshot', label: 'after-tap' },
      ],
    };
    const ctx = new ScriptContext({
      runId: 'run-vision', instanceIndex: 0, script: def, params: {},
      templates: new Map([['anchor', anchor], ['decoy', decoy]]),
      refWidth: SET_REF.width, refHeight: SET_REF.height, shrink: 2,
      device, vision: defaultVision,
      shots: {
        encode: async (raw) => { encoded.push(raw); return encodeTraceShot(raw); },
        save: async (file, bytes) => { saved.push({ file, bytes }); return `run-vision/${file}`; },
      },
      onLogs: (entries) => logs.push(...entries),
      minCaptureIntervalMs: 0, captureJitterMs: 0, statusIntervalMs: 0, logFlushMs: 5,
    });
    const result = await new ScriptEngine(ctx).run();
    ctx.dispose();

    expect(result.status).toBe('succeeded');
    expect(logs.some((line) => line.message === '没有诱饵')).toBe(true);
    expect(logs.some((line) => line.message === 'ROI 外')).toBe(true);
    // Template at device (192, 96) 128×80 → set canvas (96, 48) 64×40, centre (128, 68). The script offset
    // (80, -40) on the 1280×720 canvas is (20, -10) on the set canvas → (148, 58) → device ×2 = (296, 116).
    expect(device.actions).toEqual(['tap:296,116']);
    const hit = logs.find((line) => line.stepId === 'hit' && line.message.startsWith('点中模板'));
    expect(hit?.message).toContain('参考 (148, 58)');
    expect(Number(hit?.data?.score)).toBeGreaterThan(0.9);
    expect(result.stats.matches).toBe(4);
    expect(result.stats.matchHits).toBe(2);
    expect(result.stats.taps).toBe(1);

    // The shot is the frame the match ran on (no extra capture), encoded as a real JPEG.
    expect(encoded).toHaveLength(1);
    expect(encoded[0]).toBe(screen);
    expect(saved.map((item) => item.file)).toEqual(['0001-after-tap.jpg']);
    const meta = await sharp(Buffer.from(saved[0]!.bytes)).metadata();
    expect(meta.format).toBe('jpeg');
    // At most 1280 wide and never enlarged: this 640-wide frame stays 640.
    expect(meta.width).toBe(Math.min(1280, DEVICE.width));
    expect(logs.find((line) => line.stepId === 'shot')?.shot).toBe('run-vision/0001-after-tap.jpg');
  });

  it('scores the negative sample far below the threshold and the real template near 1', async () => {
    const screen = blockFrame(7);
    const set: TemplateSet = { id: 'set', name: '合成模板集', refWidth: SET_REF.width, refHeight: SET_REF.height, templates: [], directory: '/nonexistent' };
    const frame = await defaultVision.prepareFrame(screen, { refWidth: SET_REF.width, refHeight: SET_REF.height, shrink: 2 });
    const positive = await defaultVision.match(frame, await cutTemplate(screen, 'anchor', set));
    const negative = await defaultVision.match(frame, await cutTemplate(blockFrame(99), 'decoy', set));
    expect(positive).toMatchObject({ found: true, x: 96, y: 48, centerX: 128, centerY: 68 });
    expect(positive.score).toBeGreaterThan(0.9);
    expect(negative.found).toBe(false);
    expect(negative.score).toBeLessThan(0.6);
  });
});
