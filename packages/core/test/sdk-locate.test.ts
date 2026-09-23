import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  compareApiLevels,
  findInstalledImage,
  isFinalPlatformName,
  locateSdk,
  parseImagePackagePath,
} from '../src/sdk/locate.js';
import { isAvdmError } from '../src/errors.js';

function write(file: string, content: string, mode?: number): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  if (mode !== undefined) chmodSync(file, mode);
}

describe('parseImagePackagePath', () => {
  it('splits a standard image path', () => {
    expect(parseImagePackagePath('system-images;android-35;default;arm64-v8a')).toEqual({
      platform: 'android-35',
      apiLevel: '35',
      tagId: 'default',
      abi: 'arm64-v8a',
      relDir: 'system-images/android-35/default/arm64-v8a',
    });
  });

  it('handles minor API levels and extension levels', () => {
    expect(parseImagePackagePath('system-images;android-36.1;google_apis;arm64-v8a')).toMatchObject({
      platform: 'android-36.1',
      apiLevel: '36.1',
      tagId: 'google_apis',
      relDir: 'system-images/android-36.1/google_apis/arm64-v8a',
    });
    expect(parseImagePackagePath('system-images;android-35-ext15;google_apis_playstore;arm64-v8a')).toMatchObject({
      platform: 'android-35-ext15',
      apiLevel: '35-ext15',
      tagId: 'google_apis_playstore',
    });
    expect(parseImagePackagePath('  system-images;android-CANARY;google_apis_ps16k;arm64-v8a ').apiLevel).toBe('CANARY');
  });

  it('rejects malformed paths with INVALID_ARGUMENT', () => {
    for (const bad of [
      '',
      'emulator',
      'platforms;android-35',
      'system-images;android-35;default',
      'system-images;android-35;default;arm64-v8a;extra',
      'sys-images;android-35;default;arm64-v8a',
      'system-images;35;default;arm64-v8a',
      'system-images;android-;default;arm64-v8a',
      'system-images;android-35;..;arm64-v8a',
      'system-images;android-35;default;../../etc',
      'system-images;android-35;de fault;arm64-v8a',
    ]) {
      let err: unknown;
      try {
        parseImagePackagePath(bad);
      } catch (e) {
        err = e;
      }
      expect(isAvdmError(err, 'INVALID_ARGUMENT'), bad).toBe(true);
    }
  });
});

describe('compareApiLevels / isFinalPlatformName', () => {
  it('orders API levels', () => {
    const sorted = ['35', '36.1', '35-ext15', '9', 'CANARY', '36', '36-ext19', '34'].sort(compareApiLevels);
    expect(sorted).toEqual(['9', '34', '35', '35-ext15', '36', '36-ext19', '36.1', 'CANARY']);
    expect(compareApiLevels('35', '35')).toBe(0);
  });

  it('recognises released platform names', () => {
    expect(isFinalPlatformName('android-35')).toBe(true);
    expect(isFinalPlatformName('android-36.1')).toBe(true);
    expect(isFinalPlatformName('android-35-ext15')).toBe(true);
    expect(isFinalPlatformName('android-CANARY')).toBe(false);
    expect(isFinalPlatformName('android-37.2-beta3')).toBe(false);
    expect(isFinalPlatformName('android-canary-20260909')).toBe(false);
  });
});

describe('locateSdk', () => {
  let tmp: string;
  let sdk: string;

  beforeAll(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'avdm-sdk-locate-'));
    sdk = path.join(tmp, 'sdk');
    write(path.join(sdk, 'emulator', 'source.properties'), 'Pkg.Desc=Android Emulator\nPkg.Revision=37.1.11\n');
    write(path.join(sdk, 'emulator', 'emulator'), '#!/bin/sh\n', 0o755);
    write(path.join(sdk, 'emulator', 'qemu-img'), '#!/bin/sh\n', 0o755);
    write(path.join(sdk, 'platform-tools', 'adb'), '#!/bin/sh\n', 0o755);
    write(path.join(sdk, 'platform-tools', 'source.properties'), 'Pkg.Revision=37.0.1\n');

    const img = path.join(sdk, 'system-images', 'android-35', 'default', 'arm64-v8a');
    write(path.join(img, 'system.img'), 'x');
    write(
      path.join(img, 'source.properties'),
      [
        'Pkg.Desc=ARM 64 v8a System Image',
        'SystemImage.TagId=default',
        'SystemImage.TagDisplay=Default Android System Image',
        'SystemImage.Abi=arm64-v8a',
        'AndroidVersion.ApiLevel=35',
        'Pkg.Revision=2',
        '',
      ].join('\n'),
    );

    // Installed by us without source.properties: revision from .avdm-package.json, display from tag id.
    const gimg = path.join(sdk, 'system-images', 'android-36.1', 'google_apis_playstore', 'arm64-v8a');
    write(path.join(gimg, 'system.img'), 'x');
    write(
      path.join(gimg, '.avdm-package.json'),
      JSON.stringify({
        path: 'system-images;android-36.1;google_apis_playstore;arm64-v8a',
        revision: '4',
        channel: 'channel-0',
        licenseId: 'android-sdk-arm-dbt-license',
        installedAt: new Date().toISOString(),
        sha1: 'a'.repeat(40),
      }),
    );

    // Not images: no system.img, and a dot-prefixed leftover from a replaced install.
    mkdirSync(path.join(sdk, 'system-images', 'android-34', 'default', 'arm64-v8a'), { recursive: true });
    write(path.join(sdk, 'system-images', 'android-35', 'default', '.arm64-v8a.avdm-old-1234', 'system.img'), 'x');
    write(path.join(sdk, 'system-images', 'stray-file'), 'x');

    write(path.join(sdk, 'licenses', 'android-sdk-license'), '\n24333f8a63b6825ea9c5514f83c2829b004d1fee');
    write(path.join(sdk, 'licenses', 'android-sdk-arm-dbt-license'), '859f317696f67ef3d7f30a50a5560e7834b43903\n');
    write(path.join(sdk, 'licenses', '.DS_Store'), '');
  });

  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it('never throws for a missing SDK', async () => {
    const info = await locateSdk(path.join(tmp, 'does-not-exist'));
    expect(info).toEqual({
      root: path.join(tmp, 'does-not-exist'),
      exists: false,
      images: [],
      acceptedLicenses: [],
    });
  });

  it('treats an existing but empty dir as an SDK without components', async () => {
    const empty = path.join(tmp, 'empty');
    mkdirSync(empty);
    const info = await locateSdk(empty);
    expect(info.exists).toBe(true);
    expect(info.emulator).toBeUndefined();
    expect(info.adb).toBeUndefined();
    expect(info.images).toEqual([]);
    expect(info.acceptedLicenses).toEqual([]);
  });

  it('finds emulator, adb, images and accepted licenses', async () => {
    const info = await locateSdk(sdk);
    expect(info.root).toBe(sdk);
    expect(info.exists).toBe(true);
    expect(info.emulator).toEqual({
      dir: path.join(sdk, 'emulator'),
      bin: path.join(sdk, 'emulator', 'emulator'),
      version: '37.1.11',
      qemuImg: path.join(sdk, 'emulator', 'qemu-img'),
    });
    expect(info.adb).toEqual({ bin: path.join(sdk, 'platform-tools', 'adb'), version: '37.0.1' });
    expect(info.acceptedLicenses).toEqual(['android-sdk-arm-dbt-license', 'android-sdk-license']);

    expect(info.images.map((i) => i.packagePath)).toEqual([
      'system-images;android-36.1;google_apis_playstore;arm64-v8a',
      'system-images;android-35;default;arm64-v8a',
    ]);
    const img = info.images[1]!;
    expect(img).toEqual({
      packagePath: 'system-images;android-35;default;arm64-v8a',
      dir: path.join(sdk, 'system-images', 'android-35', 'default', 'arm64-v8a'),
      sysdirRel: 'system-images/android-35/default/arm64-v8a/',
      platform: 'android-35',
      apiLevel: '35',
      tagId: 'default',
      tagDisplay: 'Default Android System Image',
      abi: 'arm64-v8a',
      revision: '2',
    });
    const g = info.images[0]!;
    expect(g).toMatchObject({
      sysdirRel: 'system-images/android-36.1/google_apis_playstore/arm64-v8a/',
      platform: 'android-36.1',
      apiLevel: '36.1',
      tagId: 'google_apis_playstore',
      tagDisplay: 'Google Play',
      abi: 'arm64-v8a',
      revision: '4',
    });
  });

  it('expands ~ and resolves relative roots', async () => {
    const info = await locateSdk('~/definitely-not-an-avdm-sdk-dir-xyz');
    expect(info.root).toBe(path.join(os.homedir(), 'definitely-not-an-avdm-sdk-dir-xyz'));
    expect(info.exists).toBe(false);
  });

  it('findInstalledImage looks up by package path', async () => {
    const info = await locateSdk(sdk);
    expect(findInstalledImage(info, 'system-images;android-35;default;arm64-v8a')!.revision).toBe('2');
    expect(findInstalledImage(info, 'system-images;android-34;default;arm64-v8a')).toBeUndefined();
  });
});
