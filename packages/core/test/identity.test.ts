import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildPropertyFile } from '../src/build-profile.js';
import { resolveIdentity } from '../src/identity.js';
import { createManagerHarness, reserveIndices, type ManagerHarness } from './helpers/manager-harness.js';

describe('device identity presets', () => {
  it('generates distinct locally administered unicast MACs and stable format serials', () => {
    const a = resolveIdentity('random', 0)!;
    const b = resolveIdentity('random', 0)!;
    expect(a.serialNumber).toMatch(/^[0-9A-F]{12}$/);
    expect(a.wifiMac).toMatch(/^02(?::[0-9a-f]{2}){5}$/);
    expect(a.androidId).toMatch(/^[0-9a-f]{16}$/);
    expect(a).not.toEqual(b);
  });

  it('expands index placeholders and rejects unsupported identifiers', () => {
    expect(resolveIdentity({ serialNumber: 'SER-{index}', wifiMac: '02:aa:bb:cc:dd:{indexHex2}' }, 12)).toEqual({
      serialNumber: 'SER-12', wifiMac: '02:aa:bb:cc:dd:0c',
    });
    expect(() => resolveIdentity({ imei: '123' } as never, 0)).toThrow(/不支持设置 imei/);
    expect(() => resolveIdentity({ wifiMac: '03:aa:bb:cc:dd:ee' }, 0)).toThrow(/单播地址/);
  });

  it('validates a coherent build profile and rewrites matching partition properties', () => {
    const build = {
      brand: 'google', manufacturer: 'Google', model: 'Pixel 8', device: 'shiba', product: 'shiba',
      fingerprint: 'google/shiba/shiba:15/AP3A.240905.015/12345678:user/release-keys',
    };
    expect(resolveIdentity({ serialNumber: 'random', wifiMac: 'random', androidId: 'random', build }, 3)?.build).toEqual(build);
    const file = buildPropertyFile(build, '[ro.product.system.model]: [mainline]\n[ro.vendor.build.fingerprint]: [old]\n');
    expect(file).toContain('ro.product.model=Pixel 8\n');
    expect(file).toContain('ro.product.system.model=Pixel 8\n');
    expect(file).toContain(`ro.vendor.build.fingerprint=${build.fingerprint}\n`);
    expect(file).toContain('ro.build.type=user\n');
    expect(() => resolveIdentity({ build: { ...build, device: 'husky' } }, 3)).toThrow(/不一致/);
  });
});

describe('managed identity lifecycle with fake emulator', () => {
  let h: ManagerHarness;
  beforeAll(async () => { h = await createManagerHarness(); }, 30_000);
  afterAll(async () => { await h?.cleanup(); }, 30_000);

  it('persists and reapplies serial and Wi-Fi MAC across restarts', async () => {
    const release = await reserveIndices(h.manager, 55);
    const [record] = await h.manager.create({ count: 1, identity: { serialNumber: 'random', wifiMac: 'random' } });
    await release();
    const index = record!.index;
    const first = await h.manager.start(index, { wait: true, timeoutMs: 30_000 });
    expect(first.status).toBe('running');
    let dev = await h.manager.device(index);
    expect(await dev.getprop('ro.serialno')).toBe(record!.identity!.serialNumber);
    expect((await dev.shell('cat /sys/class/net/wlan0/address')).trim()).toBe(record!.identity!.wifiMac);
    await h.manager.stop(index);
    const second = await h.manager.start(index, { wait: true, timeoutMs: 30_000 });
    expect(second.record.identity).toEqual(record!.identity);
    dev = await h.manager.device(index);
    expect((await dev.shell('cat /sys/class/net/wlan0/address')).trim()).toBe(record!.identity!.wifiMac);
    await h.manager.stop(index);
    const edited = await h.manager.update(index, { identity: { serialNumber: 'NEW-{index}', wifiMac: '02:aa:bb:cc:dd:{indexHex2}' } });
    expect(edited.identity).toEqual({ serialNumber: 'NEW-55', wifiMac: '02:aa:bb:cc:dd:37' });
    await h.manager.start(index, { wait: true, timeoutMs: 30_000 });
    dev = await h.manager.device(index);
    expect(await dev.getprop('ro.serialno')).toBe('NEW-55');
    expect((await dev.shell('cat /sys/class/net/wlan0/address')).trim()).toBe('02:aa:bb:cc:dd:37');
    await h.manager.stop(index);
    const [clone] = await h.manager.clone(index, { count: 1 });
    expect(clone!.identity?.serialNumber).not.toBe(edited.identity?.serialNumber);
    expect(clone!.identity?.wifiMac).not.toBe(edited.identity?.wifiMac);
    await expect(h.manager.update(clone!.index, { identity: edited.identity! })).rejects.toThrow(/已用于实例/);
  }, 90_000);
});
