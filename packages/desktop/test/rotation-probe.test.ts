import { describe, expect, it } from 'vitest';
import { parseDisplayRotation, ROTATION_PROBES, RotationProber } from '../src/main/rotation';

describe('parseDisplayRotation', () => {
  it('reads dumpsys display (emulator 37 / android-35, verified on hardware)', () => {
    expect(parseDisplayRotation('    mCurrentOrientation=1\n')).toBe(1);
    expect(parseDisplayRotation('mCurrentOrientation=0')).toBe(0);
  });
  it('reads the input dump of older images', () => {
    expect(parseDisplayRotation('      SurfaceOrientation: 3\n')).toBe(3);
    expect(
      parseDisplayRotation('    Viewport INTERNAL: displayId=0, uniqueId=local:1, port=1, orientation=2, logicalFrame=[0, 0, 720, 1280]'),
    ).toBe(2);
    expect(parseDisplayRotation('Viewport INTERNAL: displayId=0, orientation=ROTATION_270, isActive=true')).toBe(3);
  });
  it('returns undefined for anything else', () => {
    expect(parseDisplayRotation('')).toBeUndefined();
    expect(parseDisplayRotation('WINDOW MANAGER WINDOWS (dumpsys window windows)')).toBeUndefined();
    expect(parseDisplayRotation('mCurrentOrientation=7')).toBeUndefined();
  });
});

describe('RotationProber', () => {
  it('sticks to the first probe that works', async () => {
    const calls: string[] = [];
    const prober = new RotationProber(async (cmd) => {
      calls.push(cmd);
      if (cmd === ROTATION_PROBES[0]) throw new Error('grep: exit 1');
      return 'SurfaceOrientation: 1';
    });
    expect(await prober.probe()).toBe(1);
    expect(await prober.probe()).toBe(1);
    expect(calls).toEqual([ROTATION_PROBES[0], ROTATION_PROBES[1], ROTATION_PROBES[1]]);
  });

  it('backs off when no probe works on this image', async () => {
    let now = 0;
    let calls = 0;
    const prober = new RotationProber(
      async () => {
        calls++;
        return '';
      },
      10_000,
      () => now,
    );
    expect(await prober.probe()).toBeUndefined();
    expect(calls).toBe(ROTATION_PROBES.length);
    now = 5000;
    expect(await prober.probe()).toBeUndefined();
    expect(calls).toBe(ROTATION_PROBES.length); // no adb traffic during the back-off
    now = 10_001;
    await prober.probe();
    expect(calls).toBe(2 * ROTATION_PROBES.length);
  });
});
