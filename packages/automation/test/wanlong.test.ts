import { describe, expect, it } from 'vitest';
import type { DevicePort, RawFrame } from '../src/index.js';
import {
  computeSearchFloor, createGatherIo, createRuntimeState, normalizeGatherConfig,
  runGatherCycle,
} from '../src/wanlong/index.js';
import type { GatherTemplates } from '../src/wanlong/index.js';

function device(actions: string[]): DevicePort {
  const raw: RawFrame = {
    width: 960, height: 540, capturedAt: 1, data: new Uint8Array(960 * 540 * 4),
  };
  return {
    async capture() { actions.push('capture'); return raw; },
    async foregroundPackage() { return 'com.lilithgames.samo.android.cn'; },
    async tap(x, y) { actions.push(`tap:${x},${y}`); },
    async swipe(x1, y1, x2, y2, ms) { actions.push(`swipe:${x1},${y1},${x2},${y2},${ms}`); },
    async key(key) { actions.push(`key:${key}`); },
    async launchApp(pkg) { actions.push(`launch:${pkg}`); },
    async stopApp(pkg) { actions.push(`stop:${pkg}`); },
  };
}

describe('Wanlong AVD adapter', () => {
  it('converts 2560×1440 reference actions to 960×540 device pixels', async () => {
    const actions: string[] = [];
    const io = createGatherIo(device(actions), { refWidth: 2560, refHeight: 1440 });
    await io.tap(1280, 720);
    await io.swipe(0, 0, 2560, 1440, 300);
    expect(actions).toEqual(['capture', 'tap:480,270', 'swipe:0,0,960,540,300']);
  });

  it('does not touch the device when gather is disabled; preserves incoming state', async () => {
    const actions: string[] = [];
    const io = createGatherIo(device(actions), { refWidth: 2560, refHeight: 1440 });
    const templates: GatherTemplates = {
      setId: 'test', refWidth: 2560, refHeight: 1440,
      ui: new Map(), glyphSets: new Map(), missing: [],
      require() { throw new Error('unexpected template use'); },
      get() { return undefined; }, has() { return false; },
      requireGlyphs() { throw new Error('unexpected OCR use'); },
      hasGlyphs() { return false; },
    };
    const state = createRuntimeState();
    state.backoffIndex = 2;
    const result = await runGatherCycle({ io, templates, config: { enabled: false }, state });
    expect(result.outcome).toBe('noResourceWanted');
    expect(result.nextWakeAt).toBeNull();
    expect(result.captures).toBe(0);
    expect(result.state.backoffIndex).toBe(2);
    expect(actions).toEqual([]);
  });

  it('normalizes untrusted config and interprets level as a lower bound', () => {
    const config = normalizeGatherConfig({ safety: { maxCapturesPerCycle: 100_000 } });
    expect(config.safety.maxCapturesPerCycle).toBe(500);
    expect(computeSearchFloor({ mode: 'absolute', level: 6, minLevel: 1, allowRelax: true, maxLevelHardCap: 10 }, 9)).toBe(6);
  });
});
