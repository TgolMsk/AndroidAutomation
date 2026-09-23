import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  avdDirFor,
  avdDiskUsage,
  buildConfigIni,
  clearSnapshotStale,
  createAvd,
  deleteAvd,
  hasQuickBootSnapshot,
  isSnapshotStale,
  markSnapshotStale,
  purgeRetiredAvds,
  quarantineAvd,
  readAvdConfig,
  restoreRetiredAvd,
  retireAvd,
  specToConfig,
  updateAvdConfig,
  type AvdContext,
} from '../src/avd/avdfiles.js';
import { isAvdmError } from '../src/errors.js';
import { parseIni, serializeIni } from '../src/util/ini.js';
import { makeImage, makeRecord, makeSdk, makeSpec, makeTempDir } from './fixtures/avd-support/helpers.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'avd-files');

let tmp: string;
let avdHome: string;
let sdkRoot: string;
let ctx: AvdContext;

beforeEach(async () => {
  tmp = await makeTempDir('avdm-avdfiles-');
  avdHome = path.join(tmp, 'home', 'avd');
  sdkRoot = path.join(tmp, 'sdk');
  ctx = { avdHome, sdk: makeSdk(sdkRoot) };
});

afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

async function expectCode(p: Promise<unknown>, code: string): Promise<Error> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(isAvdmError(err), `expected AvdmError(${code}), got ${String(err)}`).toBe(true);
  expect((err as { code: string }).code).toBe(code);
  return err as Error;
}

describe('avdDirFor / specToConfig', () => {
  it('places the AVD dir at <avdHome>/<name>.avd', () => {
    expect(avdDirFor('/x/avd', 'avdm_7')).toBe(path.join('/x/avd', 'avdm_7.avd'));
  });

  it('returns exactly the spec-dependent keys', () => {
    expect(specToConfig(makeSpec())).toEqual({
      'hw.cpu.ncore': '2',
      'hw.ramSize': '3072',
      'hw.lcd.width': '1280',
      'hw.lcd.height': '720',
      'hw.lcd.density': '320',
      'disk.dataPartition.size': '16G',
      'hw.gpu.mode': 'host',
      'hw.initialOrientation': 'landscape',
      'skin.name': '1280x720',
    });
  });

  it('maps gpuMode software → swiftshader_indirect and auto → auto', () => {
    expect(specToConfig(makeSpec({ gpuMode: 'software' }))['hw.gpu.mode']).toBe('swiftshader_indirect');
    expect(specToConfig(makeSpec({ gpuMode: 'auto' }))['hw.gpu.mode']).toBe('auto');
  });

  it('derives orientation from width vs height (square → portrait)', () => {
    const portrait = specToConfig(makeSpec({ width: 720, height: 1280 }));
    expect(portrait['hw.initialOrientation']).toBe('portrait');
    expect(portrait['skin.name']).toBe('720x1280');
    expect(specToConfig(makeSpec({ width: 1080, height: 1080 }))['hw.initialOrientation']).toBe('portrait');
  });

  it('ignores headless/bootMode/extraArgs (launch-time only)', () => {
    const a = specToConfig(makeSpec());
    const b = specToConfig(makeSpec({ headless: false, bootMode: 'cold', extraArgs: ['-verbose'] }));
    expect(b).toEqual(a);
  });
});

describe('buildConfigIni', () => {
  it('produces the exact DESIGN.md key list and order', async () => {
    const expected = await fsp.readFile(path.join(fixturesDir, 'config.ini'), 'utf8');
    const ini = buildConfigIni(makeRecord(3), makeImage(sdkRoot));
    expect(serializeIni(ini)).toBe(expected);
  });

  it('enables PlayStore for playstore tags, adds a trailing slash to sysdir', () => {
    const image = makeImage(sdkRoot, {
      packagePath: 'system-images;android-35;google_apis_playstore;arm64-v8a',
      tagId: 'google_apis_playstore',
      tagDisplay: 'Google Play',
      sysdirRel: 'system-images/android-35/google_apis_playstore/arm64-v8a',
    });
    const ini = buildConfigIni(makeRecord(0, { name: '游戏号 A' }), image);
    expect(ini['PlayStore.enabled']).toBe('true');
    expect(ini['tag.id']).toBe('google_apis_playstore');
    expect(ini['tag.display']).toBe('Google Play');
    expect(ini['image.sysdir.1']).toBe('system-images/android-35/google_apis_playstore/arm64-v8a/');
    expect(ini['avd.ini.displayname']).toBe('游戏号 A');
  });

  it('google_apis (non-playstore) keeps PlayStore disabled; software GPU lands in config', () => {
    const image = makeImage(sdkRoot, { tagId: 'google_apis', tagDisplay: 'Google APIs' });
    const ini = buildConfigIni(makeRecord(1, { spec: makeSpec({ gpuMode: 'software', width: 720, height: 1280 }) }), image);
    expect(ini['PlayStore.enabled']).toBe('false');
    expect(ini['hw.gpu.enabled']).toBe('yes');
    expect(ini['hw.gpu.mode']).toBe('swiftshader_indirect');
    expect(ini['hw.initialOrientation']).toBe('portrait');
    expect(ini['abi.type']).toBe('arm64-v8a');
    expect(ini['hw.cpu.arch']).toBe('arm64');
  });
});

describe('createAvd', () => {
  it('writes <name>.ini and <name>.avd/config.ini exactly', async () => {
    const record = makeRecord(3);
    await createAvd(ctx, record);

    const ini = await fsp.readFile(path.join(avdHome, 'avdm_3.ini'), 'utf8');
    expect(ini).toBe(
      [
        'avd.ini.encoding=UTF-8',
        `path=${path.join(avdHome, 'avdm_3.avd')}`,
        'path.rel=avd/avdm_3.avd',
        'target=android-35',
        '',
      ].join('\n'),
    );
    const config = await fsp.readFile(path.join(avdHome, 'avdm_3.avd', 'config.ini'), 'utf8');
    expect(config).toBe(await fsp.readFile(path.join(fixturesDir, 'config.ini'), 'utf8'));
    expect(await readAvdConfig(avdHome, 'avdm_3')).toMatchObject({ AvdId: 'avdm_3', 'hw.ramSize': '3072' });
    // No temp files left behind.
    expect((await fsp.readdir(avdHome)).sort()).toEqual(['avdm_3.avd', 'avdm_3.ini']);
    expect(await fsp.readdir(path.join(avdHome, 'avdm_3.avd'))).toEqual(['config.ini']);
  });

  it('throws IMAGE_MISSING (and creates nothing) when the image is not installed', async () => {
    const record = makeRecord(0, { image: 'system-images;android-36;google_apis;arm64-v8a' });
    const err = await expectCode(createAvd(ctx, record), 'IMAGE_MISSING');
    expect(err.message).toContain('系统镜像未安装');
    expect(err.message).toContain('avdm sdk install');
    await expect(fsp.access(path.join(avdHome, 'avdm_0.avd'))).rejects.toThrow();
    await expect(fsp.access(path.join(avdHome, 'avdm_0.ini'))).rejects.toThrow();
  });

  it('throws IMAGE_MISSING with an empty SDK', async () => {
    await expectCode(createAvd({ avdHome, sdk: makeSdk(sdkRoot, { images: [] }) }, makeRecord(0)), 'IMAGE_MISSING');
  });

  it('throws INVALID_ARGUMENT if the AVD dir or .ini already exists, leaving it untouched', async () => {
    await fsp.mkdir(path.join(avdHome, 'avdm_1.avd'), { recursive: true });
    await fsp.writeFile(path.join(avdHome, 'avdm_1.avd', 'marker'), 'keep');
    await expectCode(createAvd(ctx, makeRecord(1)), 'INVALID_ARGUMENT');
    expect(await fsp.readFile(path.join(avdHome, 'avdm_1.avd', 'marker'), 'utf8')).toBe('keep');

    await fsp.writeFile(path.join(avdHome, 'avdm_2.ini'), 'path=/elsewhere\n');
    await expectCode(createAvd(ctx, makeRecord(2)), 'INVALID_ARGUMENT');
    expect(await fsp.readFile(path.join(avdHome, 'avdm_2.ini'), 'utf8')).toBe('path=/elsewhere\n');
    await expect(fsp.access(path.join(avdHome, 'avdm_2.avd'))).rejects.toThrow();
  });

  it('rejects AVD names that could escape avdHome', async () => {
    await expectCode(createAvd(ctx, makeRecord(0, { avdName: '../evil' })), 'INVALID_ARGUMENT');
    await expectCode(createAvd(ctx, makeRecord(0, { avdName: 'a/b' })), 'INVALID_ARGUMENT');
    await expectCode(createAvd(ctx, makeRecord(0, { avdName: '' })), 'INVALID_ARGUMENT');
    await expectCode(deleteAvd(avdHome, '..'), 'INVALID_ARGUMENT');
  });
});

describe('updateAvdConfig', () => {
  it('a display name can never inject another config.ini key', async () => {
    const record = makeRecord(4);
    await createAvd(ctx, record);
    await updateAvdConfig(ctx, { ...record, name: 'x\nhw.ramSize=99999\r\nhw.cpu.ncore=16' });
    const cfg = await readAvdConfig(avdHome, 'avdm_4');
    expect(cfg?.['hw.ramSize']).toBe(String(record.spec.ramMb));
    expect(cfg?.['hw.cpu.ncore']).toBe(String(record.spec.cpuCores));
    expect(cfg?.['avd.ini.displayname']).toBe('x hw.ramSize=99999  hw.cpu.ncore=16');
    expect(serializeIni({ a: 'b\u2028c' })).toBe('a=b c\n');
  });

  it('rewrites spec keys + displayname in place and preserves unknown keys and order', async () => {
    const record = makeRecord(4);
    await createAvd(ctx, record);
    const cfgFile = path.join(avdHome, 'avdm_4.avd', 'config.ini');
    // Simulate keys added by the emulator / the user.
    await fsp.appendFile(cfgFile, 'userdata.useQcow2=yes\nhw.custom.thing=42\n');

    const updated = {
      ...record,
      name: '主号',
      spec: makeSpec({ cpuCores: 4, ramMb: 4096, width: 1080, height: 1920, dpi: 440, dataPartitionGb: 32, gpuMode: 'software' as const }),
    };
    await updateAvdConfig(ctx, updated);

    const text = await fsp.readFile(cfgFile, 'utf8');
    const entries = parseIni(text);
    const cfg = Object.fromEntries(entries);
    expect(cfg).toMatchObject({
      AvdId: 'avdm_4',
      'avd.ini.displayname': '主号',
      'hw.cpu.ncore': '4',
      'hw.ramSize': '4096',
      'hw.lcd.width': '1080',
      'hw.lcd.height': '1920',
      'hw.lcd.density': '440',
      'disk.dataPartition.size': '32G',
      'hw.gpu.mode': 'swiftshader_indirect',
      'hw.initialOrientation': 'portrait',
      'skin.name': '1080x1920',
      'userdata.useQcow2': 'yes',
      'hw.custom.thing': '42',
      'image.sysdir.1': 'system-images/android-35/default/arm64-v8a/',
    });
    // Same key order as before (keys replaced in place, nothing duplicated).
    const expectedKeys = parseIni(await fsp.readFile(path.join(fixturesDir, 'config.ini'), 'utf8')).map(([k]) => k);
    expect(entries.map(([k]) => k)).toEqual([...expectedKeys, 'userdata.useQcow2', 'hw.custom.thing']);
  });

  it('throws INVALID_ARGUMENT when config.ini is missing', async () => {
    await expectCode(updateAvdConfig(ctx, makeRecord(9)), 'INVALID_ARGUMENT');
  });
});

describe('readAvdConfig / deleteAvd / avdDiskUsage', () => {
  it('readAvdConfig returns undefined for a missing AVD', async () => {
    expect(await readAvdConfig(avdHome, 'avdm_0')).toBeUndefined();
  });

  it('deleteAvd removes both the .ini and the .avd dir, and is a no-op when absent', async () => {
    await createAvd(ctx, makeRecord(5));
    await fsp.writeFile(path.join(avdHome, 'avdm_5.avd', 'userdata-qemu.img'), Buffer.alloc(4096, 1));
    await createAvd(ctx, makeRecord(6));

    await deleteAvd(avdHome, 'avdm_5');
    await expect(fsp.access(path.join(avdHome, 'avdm_5.avd'))).rejects.toThrow();
    await expect(fsp.access(path.join(avdHome, 'avdm_5.ini'))).rejects.toThrow();
    // Neighbours untouched.
    expect(await readAvdConfig(avdHome, 'avdm_6')).toBeDefined();

    await expect(deleteAvd(avdHome, 'avdm_5')).resolves.toBeUndefined();
    await expect(deleteAvd(path.join(tmp, 'nope'), 'avdm_0')).resolves.toBeUndefined();
  });

  it('retire/restore/purge: a delete takes the AVD out of service atomically and leftovers are recognisable', async () => {
    await createAvd(ctx, makeRecord(3));
    await createAvd(ctx, makeRecord(33)); // avdm_33 must not be mistaken for a leftover of avdm_3
    const retired = await retireAvd(avdHome, 'avdm_3');
    expect(retired).toMatch(/avdm_3\.avd\.deleting-/);
    await expect(fsp.access(path.join(avdHome, 'avdm_3.avd'))).rejects.toThrow();
    await restoreRetiredAvd(avdHome, 'avdm_3', retired!);
    expect(await readAvdConfig(avdHome, 'avdm_3')).toBeDefined();
    await retireAvd(avdHome, 'avdm_3');
    await retireAvd(avdHome, 'avdm_3'); // nothing left to retire
    expect(await purgeRetiredAvds(avdHome, 'avdm_3')).toBe(1);
    expect(await readAvdConfig(avdHome, 'avdm_33')).toBeDefined();
    expect((await fsp.readdir(avdHome)).sort()).toEqual(['avdm_3.ini', 'avdm_33.avd', 'avdm_33.ini']);
  });

  it('quarantineAvd moves an unregistered AVD to orphaned/ instead of deleting it', async () => {
    await createAvd(ctx, makeRecord(2));
    await fsp.writeFile(path.join(avdHome, 'avdm_2.avd', 'userdata-qemu.img'), 'data');
    const dest = await quarantineAvd(avdHome, 'avdm_2');
    expect(dest).toBeDefined();
    expect(path.dirname(dest!)).toBe(path.join(avdHome, 'orphaned'));
    expect(await fsp.readFile(path.join(dest!, 'avdm_2.avd', 'userdata-qemu.img'), 'utf8')).toBe('data');
    await fsp.access(path.join(dest!, 'avdm_2.ini'));
    await expect(fsp.access(path.join(avdHome, 'avdm_2.avd'))).rejects.toThrow();
    expect(await quarantineAvd(avdHome, 'avdm_2')).toBeUndefined();
    // a second orphan with the same name in the same second gets its own folder
    await createAvd(ctx, makeRecord(2));
    const again = await quarantineAvd(avdHome, 'avdm_2');
    expect(again).not.toBe(dest);
  });

  it('snapshot staleness marker round trip', async () => {
    await createAvd(ctx, makeRecord(1));
    expect(await isSnapshotStale(avdHome, 'avdm_1')).toBe(false);
    await markSnapshotStale(avdHome, 'avdm_1', 'crash');
    expect(await isSnapshotStale(avdHome, 'avdm_1')).toBe(true);
    await clearSnapshotStale(avdHome, 'avdm_1');
    expect(await isSnapshotStale(avdHome, 'avdm_1')).toBe(false);
    await markSnapshotStale(avdHome, 'avdm_9', 'no such AVD'); // no-op, does not create the dir
    await expect(fsp.access(path.join(avdHome, 'avdm_9.avd'))).rejects.toThrow();
    expect(await hasQuickBootSnapshot(avdHome, 'avdm_1')).toBe(false);
    await fsp.mkdir(path.join(avdHome, 'avdm_1.avd', 'snapshots', 'default_boot'), { recursive: true });
    await fsp.writeFile(path.join(avdHome, 'avdm_1.avd', 'snapshots', 'default_boot', 'snapshot.pb'), 'pb');
    expect(await hasQuickBootSnapshot(avdHome, 'avdm_1')).toBe(true);
  });

  it('avdDiskUsage reports allocated bytes (0 for a missing AVD)', async () => {
    expect(await avdDiskUsage(avdHome, 'avdm_0')).toBe(0);
    await createAvd(ctx, makeRecord(0));
    const payload = Buffer.alloc(1024 * 1024);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 2654435761) >>> 24; // incompressible-ish
    await fsp.writeFile(path.join(avdHome, 'avdm_0.avd', 'userdata-qemu.img'), payload);
    const bytes = await avdDiskUsage(avdHome, 'avdm_0');
    expect(bytes % 1024).toBe(0);
    expect(bytes).toBeGreaterThanOrEqual(1024 * 1024);
    expect(bytes).toBeLessThan(8 * 1024 * 1024);
  });
});
