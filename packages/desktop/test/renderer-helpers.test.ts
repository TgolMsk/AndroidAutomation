import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings, type Settings } from '@avdm/core';
import { agreedLicenseIds, allLicensesAgreed, hasNonAscii } from '../src/renderer/src/format';
import { ScriptOutputStore } from '../src/renderer/src/hooks/scriptOutputStore';
import { frameRateLabel } from '../src/renderer/src/live/frameRate';
import { uprightSize, uprightToPanel, uprightTransform } from '../src/renderer/src/live/rotation';
import { settingsPatch } from '../src/renderer/src/settingsPatch';
import type { DisplayRotation } from '../src/shared/ipc';

afterEach(() => {
  vi.useRealTimers();
});

describe('settingsPatch', () => {
  const base = (): Settings => defaultSettings();

  it('contains only what the user changed, so concurrent CLI edits survive the save', () => {
    const opened = base(); // maxRunning 6 when the dialog opened; the CLI then sets 12 on disk
    const draft = { ...opened, scrcpyPath: '/opt/homebrew/bin/scrcpy' };
    expect(settingsPatch(opened, draft)).toEqual({ scrcpyPath: '/opt/homebrew/bin/scrcpy' });
  });

  it('diffs defaultSpec field by field and compares arrays by value', () => {
    const opened = base();
    const draft: Settings = {
      ...opened,
      defaultSpec: { ...opened.defaultSpec, cpuCores: 4, extraArgs: [...opened.defaultSpec.extraArgs] },
      emulatorExtraArgs: [...opened.emulatorExtraArgs],
    };
    expect(settingsPatch(opened, draft)).toEqual({ defaultSpec: { cpuCores: 4 } });
    draft.emulatorExtraArgs = ['-no-audio'];
    expect(settingsPatch(opened, draft)).toEqual({ defaultSpec: { cpuCores: 4 }, emulatorExtraArgs: ['-no-audio'] });
  });

  it('is empty when nothing changed', () => {
    expect(settingsPatch(base(), base())).toEqual({});
  });
});

describe('live rotation mapping', () => {
  it('maps the real-hardware case: 720×1280 panel, ROTATION_90, logical (310, 606) → panel (114, 310)', () => {
    const up = uprightSize(720, 1280, 1);
    expect(up).toEqual({ width: 1280, height: 720 });
    expect(uprightToPanel(310 / up.width, 606 / up.height, 1, 720, 1280)).toEqual({ x: 114, y: 310 });
  });

  it('is the identity without rotation and clamps to the panel', () => {
    expect(uprightToPanel(0.5, 0.5, 0, 1280, 720)).toEqual({ x: 640, y: 360 });
    expect(uprightToPanel(1.2, -0.1, 0, 1280, 720)).toEqual({ x: 1279, y: 0 });
  });

  it('drawing transform and pointer mapping are inverse for every rotation', () => {
    const W = 720;
    const H = 1280;
    for (const r of [0, 1, 2, 3] as DisplayRotation[]) {
      const [a, b, c, d, e, f] = uprightTransform(r, W, H);
      const up = uprightSize(W, H, r);
      for (const [px, py] of [
        [100, 200],
        [700, 30],
        [360, 1200],
      ] as const) {
        // Where the panel pixel lands on the upright canvas…
        const cx = a * px + c * py + e;
        const cy = b * px + d * py + f;
        expect(cx).toBeGreaterThanOrEqual(0);
        expect(cx).toBeLessThanOrEqual(up.width);
        expect(cy).toBeGreaterThanOrEqual(0);
        expect(cy).toBeLessThanOrEqual(up.height);
        // …and clicking there maps back to the same panel pixel.
        const back = uprightToPanel(cx / up.width, cy / up.height, r, W, H);
        expect(back).toEqual({ x: px, y: py });
      }
    }
  });
});

describe('frameRateLabel', () => {
  it('shows fps while frames arrive', () => {
    expect(frameRateLabel(30, 0)).toEqual({ text: '30 fps', idle: false });
  });
  it('says 画面静止 instead of "0 fps" for a static screen, then how long', () => {
    expect(frameRateLabel(0, 1200)).toEqual({ text: '画面静止', idle: true });
    expect(frameRateLabel(0, 5400).text).toBe('画面静止 · 5 秒无变化');
    expect(frameRateLabel(0, 150_000).text).toBe('画面静止 · 2 分钟无变化');
    expect(frameRateLabel(0, 2 * 3600_000).text).toBe('画面静止 · 2 小时无变化');
  });
});

describe('ScriptOutputStore', () => {
  it('buffers a burst of lines and notifies subscribers once per throttle window', () => {
    vi.useFakeTimers();
    const store = new ScriptOutputStore({ throttleMs: 100, maxLinesPerRun: 50 });
    const seen: number[] = [];
    store.subscribe(() => seen.push(store.getVersion()));
    for (let i = 0; i < 1000; i++) store.push('run-1', `line ${i}`);
    expect(seen).toEqual([]); // nothing rendered per line
    vi.advanceTimersByTime(100);
    expect(seen).toEqual([1]);
    expect(store.output('run-1')).toHaveLength(50);
    expect(store.output('run-1').at(-1)).toBe('line 999');
    vi.advanceTimersByTime(1000);
    expect(seen).toEqual([1]);
  });

  it('keeps output of at most maxRuns runs', () => {
    const store = new ScriptOutputStore({ maxRuns: 2 });
    store.push('a', '1');
    store.push('b', '1');
    store.push('c', '1');
    expect(store.output('a')).toEqual([]);
    expect(store.output('c')).toEqual(['1']);
    store.dispose();
  });
});

describe('license consent', () => {
  it('needs every license ticked individually', () => {
    const needed = ['android-sdk-license', 'android-sdk-arm-dbt-license'];
    expect(allLicensesAgreed(needed, new Set(['android-sdk-license']))).toBe(false);
    expect(allLicensesAgreed(needed, new Set(needed))).toBe(true);
    expect(allLicensesAgreed([], new Set())).toBe(true);
    expect(agreedLicenseIds(needed, new Set(['android-sdk-arm-dbt-license', 'other']))).toEqual(['android-sdk-arm-dbt-license']);
  });
});

describe('hasNonAscii', () => {
  it('flags text the emulator key channel would drop', () => {
    expect(hasNonAscii('hi !')).toBe(false);
    expect(hasNonAscii('hi 世界!')).toBe(true);
    expect(hasNonAscii('é')).toBe(true);
    expect(hasNonAscii('\t\n~')).toBe(false);
  });
});
