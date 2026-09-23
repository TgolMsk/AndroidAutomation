import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
  promises as fsPromises,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  acceptLicense,
  installPackage,
  isLicenseAccepted,
  licenseHashes,
  packageInstallDir,
  sdkmanagerLicenseText,
} from '../src/sdk/installer.js';
import { parseRepositoryXml } from '../src/sdk/catalog.js';
import { locateSdk } from '../src/sdk/locate.js';
import { isAvdmError } from '../src/errors.js';
import type { InstallProgress, RemotePackage } from '../src/types.js';

const sha1 = (data: string | Buffer) => createHash('sha1').update(data).digest('hex');

const IMAGE_PATH = 'system-images;android-35;default;arm64-v8a';
const LICENSE_ID = 'android-sdk-license';
const LICENSE_TEXT = 'Terms and Conditions\n\nThis is a test\nlicense text.\n';

let tmp: string;

beforeAll(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'avdm-sdk-installer-'));
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Build a zip whose single top-level dir is `top`, containing `files` (relative path → content/mode). */
function makeZip(name: string, top: string, files: Record<string, string | { content: string; mode: number }>): string {
  const staging = mkdtempSync(path.join(tmp, 'zipsrc-'));
  for (const [rel, spec] of Object.entries(files)) {
    const file = path.join(staging, top, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    const content = typeof spec === 'string' ? spec : spec.content;
    writeFileSync(file, content);
    if (typeof spec !== 'string') chmodSync(file, spec.mode);
  }
  const zip = path.join(tmp, name);
  rmSync(zip, { force: true });
  execFileSync('/usr/bin/zip', ['-q', '-r', '-y', zip, top], { cwd: staging });
  return zip;
}

function pkgFor(zip: string, over: Partial<RemotePackage> = {}): RemotePackage {
  const data = readFileSync(zip);
  return {
    path: IMAGE_PATH,
    displayName: 'ARM 64 v8a System Image',
    revision: '2',
    channel: 'channel-0',
    licenseId: LICENSE_ID,
    archives: [{ url: pathToFileURL(zip).href, size: data.length, sha1: sha1(data) }],
    apiLevel: '35',
    tagId: 'default',
    tagDisplay: 'Default Android System Image',
    abi: 'arm64-v8a',
    ...over,
  };
}

function imageSourceProps(revision: string): string {
  return [
    'Pkg.Desc=ARM 64 v8a System Image',
    'SystemImage.TagId=default',
    'SystemImage.TagDisplay=Default Android System Image',
    'SystemImage.Abi=arm64-v8a',
    'AndroidVersion.ApiLevel=35',
    `Pkg.Revision=${revision}`,
    '',
  ].join('\n');
}

describe('licenseHashes', () => {
  it('returns sha1 of raw, trimmed and sdkmanager-normalised text, de-duplicated', () => {
    const text = '  Hello\n  world\n\nBye \n';
    const hashes = licenseHashes(text);
    expect(hashes).toEqual([sha1(text), sha1(text.trim()), sha1('Hello world\n\nBye')]);
    expect(sdkmanagerLicenseText(text)).toBe('Hello world\n\nBye');
    expect(licenseHashes('abc')).toEqual([sha1('abc')]);
    expect(licenseHashes('abc\n')).toEqual([sha1('abc\n'), sha1('abc')]);
  });

  it('reproduces the well-known sdkmanager hashes for the real Google licenses', () => {
    const xml = readFileSync(path.join(import.meta.dirname, 'fixtures', 'sdk', 'sys-img-android.xml'), 'utf8');
    const { licenses } = parseRepositoryXml(xml, 'https://dl.google.com/android/repository/sys-img/android/');
    expect(licenseHashes(licenses['android-sdk-license']!)).toContain('24333f8a63b6825ea9c5514f83c2829b004d1fee');
    expect(licenseHashes(licenses['android-sdk-arm-dbt-license']!)).toContain('859f317696f67ef3d7f30a50a5560e7834b43903');
    expect(licenseHashes(licenses['android-sdk-preview-license']!)).toContain('84831b9409646a918e30573bab4c9c91346d8abd');
    const raw = licenses['android-sdk-license']!;
    expect(licenseHashes(raw).slice(0, 2)).toEqual([sha1(raw), sha1(raw.trim())]);
  });
});

describe('license acceptance files', () => {
  it('records acceptance by appending missing hashes (creating the licenses dir)', async () => {
    const sdk = path.join(tmp, 'lic-sdk');
    expect(await isLicenseAccepted(sdk, LICENSE_ID, LICENSE_TEXT)).toBe(false);
    await acceptLicense(sdk, LICENSE_ID, LICENSE_TEXT);
    const file = path.join(sdk, 'licenses', LICENSE_ID);
    expect(readFileSync(file, 'utf8')).toBe(licenseHashes(LICENSE_TEXT).join('\n') + '\n');
    expect(await isLicenseAccepted(sdk, LICENSE_ID, LICENSE_TEXT)).toBe(true);
    expect(await isLicenseAccepted(sdk, LICENSE_ID, 'a different license')).toBe(false);

    // Idempotent.
    await acceptLicense(sdk, LICENSE_ID, LICENSE_TEXT);
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(licenseHashes(LICENSE_TEXT).length);
  });

  it('keeps hashes written by Android Studio and accepts a file holding only the sdkmanager hash', async () => {
    const sdk = path.join(tmp, 'lic-sdk2');
    const file = path.join(sdk, 'licenses', LICENSE_ID);
    mkdirSync(path.dirname(file), { recursive: true });
    const studioHash = sha1(sdkmanagerLicenseText(LICENSE_TEXT));
    writeFileSync(file, `\n8933bad161af4178b1185d1a37fbf41ea5269c55\n${studioHash.toUpperCase()}`);
    expect(await isLicenseAccepted(sdk, LICENSE_ID, LICENSE_TEXT)).toBe(true);

    await acceptLicense(sdk, LICENSE_ID, 'Another text');
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    expect(lines.slice(0, 2)).toEqual(['8933bad161af4178b1185d1a37fbf41ea5269c55', studioHash.toUpperCase()]);
    expect(lines.slice(2)).toEqual(licenseHashes('Another text'));
  });

  it('treats packages without a license as accepted and rejects unsafe license ids', async () => {
    expect(await isLicenseAccepted(path.join(tmp, 'nowhere'), '', 'x')).toBe(true);
    const err = await acceptLicense(path.join(tmp, 'nowhere'), '../evil', 'x').catch((e: unknown) => e);
    expect(isAvdmError(err, 'INVALID_ARGUMENT')).toBe(true);
    expect(existsSync(path.join(tmp, 'evil'))).toBe(false);
  });
});

describe('packageInstallDir', () => {
  it('maps package paths to directories', () => {
    expect(packageInstallDir('/sdk', 'emulator')).toBe(path.join('/sdk', 'emulator'));
    expect(packageInstallDir('/sdk', 'platform-tools')).toBe(path.join('/sdk', 'platform-tools'));
    expect(packageInstallDir('/sdk', IMAGE_PATH)).toBe(path.join('/sdk', 'system-images', 'android-35', 'default', 'arm64-v8a'));
    expect(packageInstallDir('/sdk', 'a;b;c')).toBe(path.join('/sdk', 'a', 'b', 'c'));
  });

  it('rejects traversal and empty segments', () => {
    for (const bad of ['', '..', 'a;..;b', 'a;;b', 'a/b', 'system-images;android-35;default;..']) {
      expect(() => packageInstallDir('/sdk', bad), bad).toThrow(/无效的 SDK 包路径/);
    }
  });
});

describe('installPackage (offline, file:// archives)', () => {
  let sdk: string;
  let downloads: string;
  const installDir = () => packageInstallDir(sdk, IMAGE_PATH);

  beforeAll(() => {
    sdk = path.join(tmp, 'sdk');
    downloads = path.join(tmp, 'downloads');
    mkdirSync(sdk, { recursive: true });
  });

  it('refuses with LICENSE_NOT_ACCEPTED before downloading anything', async () => {
    const zip = makeZip('img-r2.zip', 'arm64-v8a', { 'system.img': 'v2', 'source.properties': imageSourceProps('2') });
    const events: InstallProgress[] = [];
    const err = await installPackage({
      sdkRoot: sdk,
      pkg: pkgFor(zip),
      licenseText: LICENSE_TEXT,
      downloadsDir: downloads,
      onProgress: (p) => events.push(p),
    }).catch((e: unknown) => e);
    expect(isAvdmError(err, 'LICENSE_NOT_ACCEPTED')).toBe(true);
    expect(events.map((e) => e.phase)).toEqual(['error']);
    expect(existsSync(downloads)).toBe(false);
    expect(existsSync(installDir())).toBe(false);
  });

  it('downloads, verifies, extracts and installs a system image', async () => {
    await acceptLicense(sdk, LICENSE_ID, LICENSE_TEXT);
    const zip = makeZip('img-r2.zip', 'arm64-v8a', { 'system.img': 'v2', 'source.properties': imageSourceProps('2') });
    const pkg = pkgFor(zip);
    const events: InstallProgress[] = [];
    await installPackage({
      sdkRoot: sdk,
      pkg,
      licenseText: LICENSE_TEXT,
      downloadsDir: downloads,
      onProgress: (p) => events.push(p),
    });

    const phases = events.map((e) => e.phase).filter((p, i, a) => a[i - 1] !== p);
    expect(phases).toEqual(['download', 'verify', 'extract', 'done']);
    for (const e of events) expect(e.packagePath).toBe(IMAGE_PATH);
    const lastDownload = events.filter((e) => e.phase === 'download').at(-1)!;
    expect(lastDownload.receivedBytes).toBe(pkg.archives[0]!.size);
    expect(lastDownload.totalBytes).toBe(pkg.archives[0]!.size);

    const dir = installDir();
    expect(readFileSync(path.join(dir, 'system.img'), 'utf8')).toBe('v2');
    expect(existsSync(path.join(dir, 'arm64-v8a'))).toBe(false); // top-level dir was unwrapped
    const marker = JSON.parse(readFileSync(path.join(dir, '.avdm-package.json'), 'utf8'));
    expect(marker).toMatchObject({
      path: IMAGE_PATH,
      revision: '2',
      channel: 'channel-0',
      licenseId: LICENSE_ID,
      sha1: pkg.archives[0]!.sha1,
    });
    expect(Number.isNaN(Date.parse(marker.installedAt))).toBe(false);

    // Cleanup: no archive left in the cache, no temp dir in the SDK.
    expect(readdirSync(downloads)).toEqual([]);
    const tempDir = path.join(sdk, '.temp');
    if (existsSync(tempDir)) expect(readdirSync(tempDir)).toEqual([]);

    const info = await locateSdk(sdk);
    expect(info.images.map((i) => [i.packagePath, i.revision, i.sysdirRel])).toEqual([
      [IMAGE_PATH, '2', 'system-images/android-35/default/arm64-v8a/'],
    ]);
  });

  it('replaces an existing install', async () => {
    const dir = installDir();
    writeFileSync(path.join(dir, 'userdata-leftover.img'), 'old');
    const zip = makeZip('img-r3.zip', 'arm64-v8a', { 'system.img': 'v3', 'source.properties': imageSourceProps('3') });
    await installPackage({ sdkRoot: sdk, pkg: pkgFor(zip, { revision: '3' }), licenseText: LICENSE_TEXT, downloadsDir: downloads });
    expect(readFileSync(path.join(dir, 'system.img'), 'utf8')).toBe('v3');
    expect(existsSync(path.join(dir, 'userdata-leftover.img'))).toBe(false);
    expect(JSON.parse(readFileSync(path.join(dir, '.avdm-package.json'), 'utf8')).revision).toBe('3');
    const siblings = readdirSync(path.dirname(dir));
    expect(siblings).toEqual(['arm64-v8a']); // old dir removed after success
    expect((await locateSdk(sdk)).images[0]!.revision).toBe('3');
  });

  it('fails with CHECKSUM_MISMATCH, deletes the download and keeps the existing install', async () => {
    const zip = makeZip('img-bad.zip', 'arm64-v8a', { 'system.img': 'evil', 'source.properties': imageSourceProps('4') });
    const good = pkgFor(zip);
    const pkg = pkgFor(zip, {
      revision: '4',
      archives: [{ ...good.archives[0]!, sha1: '0'.repeat(40) }],
    });
    const events: InstallProgress[] = [];
    const err = await installPackage({
      sdkRoot: sdk,
      pkg,
      licenseText: LICENSE_TEXT,
      downloadsDir: downloads,
      onProgress: (p) => events.push(p),
    }).catch((e: unknown) => e);
    expect(isAvdmError(err, 'CHECKSUM_MISMATCH')).toBe(true);
    expect(events.at(-1)!.phase).toBe('error');
    expect(readdirSync(downloads)).toEqual([]);
    expect(readFileSync(path.join(installDir(), 'system.img'), 'utf8')).toBe('v3');
  });

  it('reuses a verified archive already in the download cache', async () => {
    const zip = makeZip('img-r5.zip', 'arm64-v8a', { 'system.img': 'v5', 'source.properties': imageSourceProps('5') });
    const real = pkgFor(zip, { revision: '5' });
    const archive = real.archives[0]!;
    // The URL does not exist: the install can only succeed from the cache.
    const url = pathToFileURL(path.join(tmp, 'missing', 'arm64-v8a-35_r05.zip')).href;
    mkdirSync(downloads, { recursive: true });
    copyFileSync(zip, path.join(downloads, `${archive.sha1}-arm64-v8a-35_r05.zip`));
    const events: InstallProgress[] = [];
    await installPackage({
      sdkRoot: sdk,
      pkg: { ...real, archives: [{ ...archive, url }] },
      licenseText: LICENSE_TEXT,
      downloadsDir: downloads,
      onProgress: (p) => events.push(p),
    });
    expect(events.some((e) => e.phase === 'download')).toBe(false);
    expect(readFileSync(path.join(installDir(), 'system.img'), 'utf8')).toBe('v5');
  });

  it('installs a host-specific tool package preserving executable bits', async () => {
    const zip = makeZip('emu.zip', 'emulator', {
      emulator: { content: '#!/bin/sh\necho emu\n', mode: 0o755 },
      'qemu-img': { content: '#!/bin/sh\n', mode: 0o755 },
      'source.properties': 'Pkg.Revision=37.1.11\n',
    });
    const base = pkgFor(zip);
    const archive = base.archives[0]!;
    const pkg: RemotePackage = {
      path: 'emulator',
      displayName: 'Android Emulator',
      revision: '37.1.11',
      channel: 'channel-0',
      licenseId: LICENSE_ID,
      archives: [
        { ...archive, url: 'https://invalid.example/emulator-other-host.zip', sha1: '1'.repeat(40), hostOs: 'plan9' },
        { ...archive, hostOs: process.platform === 'darwin' ? 'macosx' : process.platform === 'win32' ? 'windows' : 'linux' },
      ],
    };
    await installPackage({ sdkRoot: sdk, pkg, licenseText: LICENSE_TEXT, downloadsDir: downloads });
    const bin = path.join(sdk, 'emulator', 'emulator');
    expect(statSync(bin).mode & 0o111).not.toBe(0);
    const info = await locateSdk(sdk);
    expect(info.emulator?.version).toBe('37.1.11');
    expect(info.emulator?.qemuImg).toBe(path.join(sdk, 'emulator', 'qemu-img'));
  });

  it('fails with UNSUPPORTED when there is no archive for this host', async () => {
    const zip = makeZip('x.zip', 'thing', { a: 'b' });
    const base = pkgFor(zip);
    const err = await installPackage({
      sdkRoot: sdk,
      pkg: { ...base, path: 'thing', archives: [{ ...base.archives[0]!, hostOs: 'plan9' }] },
      licenseText: LICENSE_TEXT,
      downloadsDir: downloads,
    }).catch((e: unknown) => e);
    expect(isAvdmError(err, 'UNSUPPORTED')).toBe(true);
    expect(existsSync(path.join(sdk, 'thing'))).toBe(false);
  });

  it('honours an aborted signal', async () => {
    const zip = makeZip('img-r6.zip', 'arm64-v8a', { 'system.img': 'v6' });
    const ac = new AbortController();
    ac.abort();
    const err = await installPackage({
      sdkRoot: sdk,
      pkg: pkgFor(zip, { revision: '6' }),
      licenseText: LICENSE_TEXT,
      downloadsDir: downloads,
      signal: ac.signal,
    }).catch((e: unknown) => e);
    expect(isAvdmError(err, 'DOWNLOAD_FAILED')).toBe(true);
    expect(readFileSync(path.join(installDir(), 'system.img'), 'utf8')).toBe('v5');
  });
  describe('interrupted installs', () => {
    afterEach(() => vi.restoreAllMocks());

    /** Make renames out of <sdk>/.temp fail with EXDEV, as when system-images/ is a symlink to another volume. */
    function crossVolume(onRename?: () => void) {
      const realRename = fsPromises.rename.bind(fsPromises);
      return vi.spyOn(fsPromises, 'rename').mockImplementation(async (from, to) => {
        if (String(from).startsWith(path.join(sdk, '.temp') + path.sep)) {
          onRename?.();
          throw Object.assign(new Error(`EXDEV: cross-device link not permitted, rename '${String(from)}'`), {
            code: 'EXDEV',
          });
        }
        return realRename(from, to);
      });
    }

    const leftovers = () =>
      readdirSync(path.dirname(installDir())).filter((n) => n.includes('.avdm-new-') || n.includes('.avdm-old-'));

    it('copies across volumes into a staging dir and renames it into place', async () => {
      const zip = makeZip('img-r7.zip', 'arm64-v8a', {
        'system.img': 'v7',
        'source.properties': imageSourceProps('7'),
        'data/nested.img': 'nested',
      });
      const rename = crossVolume();
      await installPackage({ sdkRoot: sdk, pkg: pkgFor(zip, { revision: '7' }), licenseText: LICENSE_TEXT, downloadsDir: downloads });
      expect(rename).toHaveBeenCalled();
      const dir = installDir();
      expect(readFileSync(path.join(dir, 'system.img'), 'utf8')).toBe('v7');
      expect(readFileSync(path.join(dir, 'data', 'nested.img'), 'utf8')).toBe('nested');
      expect(JSON.parse(readFileSync(path.join(dir, '.avdm-package.json'), 'utf8')).revision).toBe('7');
      expect(leftovers()).toEqual([]);
      expect(readdirSync(path.join(sdk, '.temp'))).toEqual([]);
    });

    it('an abort during the cross-volume copy never leaves a partial install behind', async () => {
      const zip = makeZip('img-r8.zip', 'arm64-v8a', { 'system.img': 'v8', 'source.properties': imageSourceProps('8') });
      const ac = new AbortController();
      crossVolume(() => ac.abort());
      const err = await installPackage({
        sdkRoot: sdk,
        pkg: pkgFor(zip, { revision: '8' }),
        licenseText: LICENSE_TEXT,
        downloadsDir: downloads,
        signal: ac.signal,
      }).catch((e: unknown) => e);
      expect(isAvdmError(err, 'DOWNLOAD_FAILED')).toBe(true);
      // The previous install is untouched and still the one locateSdk reports.
      expect(readFileSync(path.join(installDir(), 'system.img'), 'utf8')).toBe('v7');
      expect((await locateSdk(sdk)).images[0]!.revision).toBe('7');
      expect(leftovers()).toEqual([]);
      expect(readdirSync(path.join(sdk, '.temp'))).toEqual([]);
    });

    it('sweeps temp/staged/old dirs left by dead processes, keeping live and recent ones', async () => {
      const temp = path.join(sdk, '.temp');
      const parent = path.dirname(installDir());
      const deadPid = 999_999; // above macOS/Linux default pid_max: never a live process
      const mk = (dir: string, name: string, ageMs = 0) => {
        const full = path.join(dir, name);
        mkdirSync(full, { recursive: true });
        writeFileSync(path.join(full, 'system.img'), 'partial');
        if (ageMs) {
          const t = new Date(Date.now() - ageMs);
          utimesSync(full, t, t);
        }
        return name;
      };
      mk(temp, `extract-${deadPid}-AbC123`);
      const ownTemp = mk(temp, `extract-${process.pid}-XyZ789`);
      mk(temp, 'extract-Legacy', 2 * 60 * 60_000);
      const freshLegacy = mk(temp, 'extract-Fresh1');
      mk(parent, `.arm64-v8a.avdm-new-${deadPid}-0badc0de`);
      mk(parent, `.arm64-v8a.avdm-old-${deadPid}-deadbeef`);
      const ownOld = mk(parent, `.arm64-v8a.avdm-old-${process.pid}-feedface`);

      const zip = makeZip('img-r9.zip', 'arm64-v8a', { 'system.img': 'v9', 'source.properties': imageSourceProps('9') });
      await installPackage({ sdkRoot: sdk, pkg: pkgFor(zip, { revision: '9' }), licenseText: LICENSE_TEXT, downloadsDir: downloads });

      expect(readdirSync(temp).sort()).toEqual([ownTemp, freshLegacy].sort());
      expect(leftovers()).toEqual([ownOld]);
      expect(readFileSync(path.join(installDir(), 'system.img'), 'utf8')).toBe('v9');
      rmSync(path.join(temp, ownTemp), { recursive: true });
      rmSync(path.join(temp, freshLegacy), { recursive: true });
      rmSync(path.join(parent, ownOld), { recursive: true });
    });
  });
});
