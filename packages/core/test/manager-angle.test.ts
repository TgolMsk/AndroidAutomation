import { promises as fsp } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ANGLE_OVERRIDES_DISABLED_PROP as PROP } from '../src/angle-overrides.js';
import { createManagerHarness, recordEvents, reserveIndices, type ManagerHarness } from './helpers/manager-harness.js';

/**
 * The manager turns the ANGLE override on after boot (angle-overrides.ts) against the fake emulator, which reports
 * ro.hardware.egl=angle when launched with `-feature GuestAngle` (FAKE_ANGLE=1). Instances at 58-59.
 */

const FEATURE = 'supportsSwapchainMaintenance1';
let h: ManagerHarness;
let savedAngle: string | undefined;

beforeAll(async () => {
  savedAngle = process.env.FAKE_ANGLE;
  process.env.FAKE_ANGLE = '1';
  h = await createManagerHarness();
}, 30_000);

afterAll(async () => {
  await h?.cleanup();
  if (savedAngle === undefined) delete process.env.FAKE_ANGLE;
  else process.env.FAKE_ANGLE = savedAngle;
}, 30_000);

async function adbShells(serial: string): Promise<string[]> {
  const text = await fsp.readFile(h.fake.adbLog, 'utf8').catch(() => '');
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { serial: string | null; args: string[] })
    .filter((c) => c.serial === serial && c.args[0] === 'shell').map((c) => c.args.slice(1).join(' '));
}

describe('ANGLE override after boot', () => {
  it('is set once per boot, kept in local.prop for the next boot, and never asked of a translator instance', async () => {
    const release = await reserveIndices(h.manager, 58);
    const [angle] = await h.manager.create({ count: 1 });
    const [translator] = await h.manager.create({ count: 1, spec: { glDriver: 'translator' } });
    await release();
    expect([angle!.index, translator!.index]).toEqual([58, 59]);
    const serial = (index: number) => `emulator-${5554 + 2 * index}`;
    const setprops = async () => (await adbShells(serial(58))).filter((c) => c.startsWith(`setprop ${PROP} `));
    const ev = recordEvents(h.manager);

    await h.manager.start(58, { wait: true, timeoutMs: 30_000 });
    let dev = await h.manager.device(58);
    expect(await dev.getprop(PROP)).toBe(FEATURE);
    expect(await setprops()).toEqual([`setprop ${PROP} '${FEATURE}'`]);
    expect(ev.logs.some((l) => l.index === 58 && l.message.includes('已写入 /data/local.prop'))).toBe(true);

    // The health monitor ticks (every second here) do not set it again for the same boot.
    h.manager.startMonitor();
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    h.manager.stopMonitor();
    expect(await setprops()).toHaveLength(1);

    // Next boot: init loads /data/local.prop, the manager finds the property set and only reads.
    await h.manager.stop(58);
    await h.manager.start(58, { wait: true, timeoutMs: 30_000 });
    dev = await h.manager.device(58);
    expect(await dev.getprop(PROP)).toBe(FEATURE);
    expect(await setprops()).toHaveLength(1);
    await h.manager.stop(58);

    // A translator instance (-feature -GuestAngle): no adb question at all.
    await h.manager.start(59, { wait: true, timeoutMs: 30_000 });
    expect((await adbShells(serial(59))).filter((c) => c.includes('ro.hardware.egl') || c.includes(PROP))).toEqual([]);
    await h.manager.stop(59);
    ev.stop();
  }, 90_000);
});
