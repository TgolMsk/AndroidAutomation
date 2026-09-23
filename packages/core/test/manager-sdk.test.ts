import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fsp, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_IMAGE, DEFAULT_SDK_PACKAGES } from '../src/constants.js';
import { isAvdmError } from '../src/errors.js';
import { AvdManager } from '../src/manager.js';
import { selectArchive } from '../src/sdk/catalog.js';
import type { InstallProgress } from '../src/types.js';
import { isAlive, sleeper } from './helpers/manager-harness.js';

/**
 * SDK flows through the manager, fully offline: Google manifests (test fixtures) and a crafted
 * repository with a tiny platform-tools zip are served from file:// via AVDM_SDK_REPOSITORY.
 */

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sdk');
const EMPTY_SYSIMG =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  '<sys-img:sdk-sys-img xmlns:sys-img="http://schemas.android.com/sdk/android/repo/sys-img2/04"></sys-img:sdk-sys-img>\n';
const TEST_LICENSE = 'Terms and Conditions\n\nThis is a test license for the avdm manager tests.';

let tmp: string;
const savedRepo = process.env.AVDM_SDK_REPOSITORY;
const managers: AvdManager[] = [];

async function writeRepo(dir: string, repositoryXml: string, sysImgAndroid = EMPTY_SYSIMG, sysImgGoogle = EMPTY_SYSIMG) {
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'repository2-3.xml'), repositoryXml);
  for (const [tag, xml] of [
    ['android', sysImgAndroid],
    ['google_apis', sysImgGoogle],
    ['google_apis_playstore', EMPTY_SYSIMG],
  ] as const) {
    await fsp.mkdir(path.join(dir, 'sys-img', tag), { recursive: true });
    await fsp.writeFile(path.join(dir, 'sys-img', tag, 'sys-img2-4.xml'), xml);
  }
}

/** The real Google manifests from test/fixtures/sdk laid out like dl.google.com/android/repository/. */
async function googleRepo(): Promise<string> {
  const repo = path.join(tmp, 'google');
  await writeRepo(
    repo,
    readFileSync(path.join(FIXTURES, 'repository2-3.xml'), 'utf8'),
    readFileSync(path.join(FIXTURES, 'sys-img-android.xml'), 'utf8'),
    readFileSync(path.join(FIXTURES, 'sys-img-google_apis.xml'), 'utf8'),
  );
  return repo;
}

async function openManager(sdkRoot: string): Promise<AvdManager> {
  const home = await fsp.mkdtemp(path.join(tmp, 'home-'));
  await fsp.writeFile(path.join(home, 'settings.json'), JSON.stringify({ sdkRoot }));
  const m = await AvdManager.open({ home });
  managers.push(m);
  return m;
}

beforeAll(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'avdm-mgr-sdk-'));
});

afterEach(async () => {
  for (const m of managers.splice(0)) await m.dispose();
  if (savedRepo === undefined) delete process.env.AVDM_SDK_REPOSITORY;
  else process.env.AVDM_SDK_REPOSITORY = savedRepo;
});

afterAll(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

describe('planSdkInstall / acceptLicenses (real Google manifests)', () => {
  it('resolves packages, licenses, missing paths and sizes; records consent', async () => {
    const repo = await googleRepo();
    process.env.AVDM_SDK_REPOSITORY = pathToFileURL(repo).href;
    const sdkRoot = path.join(tmp, 'sdk-google');
    const m = await openManager(sdkRoot);

    const plan = await m.planSdkInstall(['emulator', 'platform-tools', DEFAULT_IMAGE, 'bogus;package', 'emulator']);
    expect(plan.packages.map((p) => p.path)).toEqual(['emulator', 'platform-tools', DEFAULT_IMAGE]);
    expect(plan.missing).toEqual(['bogus;package']);
    expect(Object.keys(plan.licenses)).toContain('android-sdk-license');
    expect(plan.licenses['android-sdk-license']).toContain('Android Software Development Kit License Agreement');
    expect(plan.unaccepted.sort()).toEqual(Object.keys(plan.licenses).sort());
    expect(plan.totalBytes).toBe(plan.packages.reduce((s, p) => s + (selectArchive(p)?.size ?? 0), 0));
    expect(plan.totalBytes).toBeGreaterThan(100 * 1024 * 1024);

    const defaults = await m.planSdkInstall([]);
    expect(defaults.packages.map((p) => p.path)).toEqual(DEFAULT_SDK_PACKAGES);

    await m.acceptLicenses(plan.unaccepted);
    for (const id of plan.unaccepted) {
      const text = await fsp.readFile(path.join(sdkRoot, 'licenses', id), 'utf8');
      expect(text.trim().length).toBeGreaterThan(0);
    }
    expect((await m.getSdk()).acceptedLicenses.sort()).toEqual(plan.unaccepted.sort());
    expect((await m.planSdkInstall(['emulator', DEFAULT_IMAGE])).unaccepted).toEqual([]);

    const unknown = await m.acceptLicenses(['no-such-license']).catch((e: unknown) => e);
    expect(isAvdmError(unknown, 'INVALID_ARGUMENT')).toBe(true);
    const missing = await m.installSdkPackages(['bogus;package']).catch((e: unknown) => e);
    expect(isAvdmError(missing, 'INVALID_ARGUMENT')).toBe(true);
  }, 30_000);

  it('refuses to replace the emulator while an instance is running', async () => {
    process.env.AVDM_SDK_REPOSITORY = pathToFileURL(await googleRepo()).href;
    const m = await openManager(path.join(tmp, 'sdk-google-busy'));
    await m.acceptLicenses((await m.planSdkInstall(['emulator'])).unaccepted);
    const [rec] = await m.registry.allocate(1, (index) => ({
      index,
      name: `实例-${index}`,
      avdName: `avdm_${index}`,
      image: DEFAULT_IMAGE,
      spec: m.getSettings().defaultSpec,
      createdAt: new Date().toISOString(),
      autoRestart: false,
    }));
    const pid = await sleeper();
    try {
      await m.registry.writeRun({
        index: rec!.index,
        pid,
        startedAt: new Date().toISOString(),
        ports: { console: 5554, adb: 5555, grpc: 8554, serial: 'emulator-5554' },
        argv: [],
      });
      const err = await m.installSdkPackages(['emulator']).catch((e: unknown) => e);
      expect(isAvdmError(err, 'INSTANCE_RUNNING')).toBe(true);
      expect((err as Error).message).toContain('#0');
      const downloads = await fsp.readdir(m.paths.downloadsDir);
      expect(downloads).toEqual([]);
    } finally {
      process.kill(-pid, 'SIGKILL');
      await new Promise((r) => setTimeout(r, 50));
      expect(isAlive(pid)).toBe(false);
    }
  }, 30_000);
});

describe('installSdkPackages (crafted file:// repository)', () => {
  async function craftedRepo(): Promise<string> {
    const repo = path.join(tmp, 'crafted');
    const staging = path.join(tmp, 'staging');
    await fsp.mkdir(path.join(staging, 'platform-tools'), { recursive: true });
    await fsp.writeFile(path.join(staging, 'platform-tools', 'adb'), '#!/bin/sh\necho "Android Debug Bridge version 1.0.41"\n', {
      mode: 0o755,
    });
    await fsp.writeFile(
      path.join(staging, 'platform-tools', 'source.properties'),
      'Pkg.Desc=Android SDK Platform-Tools\nPkg.Revision=99.0.1\nPkg.Path=platform-tools\n',
    );
    await fsp.mkdir(repo, { recursive: true });
    const zip = path.join(repo, 'platform-tools-test.zip');
    execFileSync('/usr/bin/zip', ['-q', '-r', '-y', zip, 'platform-tools'], { cwd: staging });
    const data = readFileSync(zip);
    const sha1 = createHash('sha1').update(data).digest('hex');
    await writeRepo(
      repo,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sdk:sdk-repository xmlns:sdk="http://schemas.android.com/sdk/android/repo/repository2/03" xmlns:common="http://schemas.android.com/repository/android/common/02" xmlns:generic="http://schemas.android.com/repository/android/generic/02" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <license id="android-sdk-license" type="text">${TEST_LICENSE}</license>
  <channel id="channel-0">stable</channel>
  <remotePackage path="platform-tools">
    <type-details xsi:type="generic:genericDetailsType"/>
    <revision><major>99</major><minor>0</minor><micro>1</micro></revision>
    <display-name>Android SDK Platform-Tools</display-name>
    <uses-license ref="android-sdk-license"/>
    <channelRef ref="channel-0"/>
    <archives>
      <archive>
        <complete>
          <size>${data.length}</size>
          <checksum type="sha1">${sha1}</checksum>
          <url>platform-tools-test.zip</url>
        </complete>
      </archive>
    </archives>
  </remotePackage>
</sdk:sdk-repository>
`,
    );
    return repo;
  }

  it('requires consent, then downloads, verifies, extracts and rescans the SDK', async () => {
    const repo = await craftedRepo();
    process.env.AVDM_SDK_REPOSITORY = pathToFileURL(repo).href;
    const sdkRoot = path.join(tmp, 'sdk-crafted');
    const m = await openManager(sdkRoot);
    expect((await m.getSdk()).adb).toBeUndefined();

    const plan = await m.planSdkInstall(['platform-tools']);
    expect(plan.unaccepted).toEqual(['android-sdk-license']);
    expect(plan.licenses['android-sdk-license']).toBe(TEST_LICENSE);

    const noConsent = await m.installSdkPackages(['platform-tools']).catch((e: unknown) => e);
    expect(isAvdmError(noConsent, 'LICENSE_NOT_ACCEPTED')).toBe(true);
    await expect(fsp.access(path.join(sdkRoot, 'platform-tools'))).rejects.toThrow();

    const aborted = new AbortController();
    aborted.abort();
    await m.acceptLicenses(['android-sdk-license']);
    const cancelled = await m.installSdkPackages(['platform-tools'], { signal: aborted.signal }).catch((e: unknown) => e);
    expect(isAvdmError(cancelled, 'DOWNLOAD_FAILED')).toBe(true);

    const progress: InstallProgress[] = [];
    m.on('sdk-progress', (p) => progress.push(p));
    await m.installSdkPackages(['platform-tools']);
    const phases = [...new Set(progress.map((p) => p.phase))];
    expect(phases).toContain('extract');
    expect(phases[phases.length - 1]).toBe('done');
    expect(progress.every((p) => p.packagePath === 'platform-tools')).toBe(true);

    const sdk = await m.getSdk();
    expect(sdk.adb?.bin).toBe(path.join(sdkRoot, 'platform-tools', 'adb'));
    expect(sdk.adb?.version).toBe('99.0.1');
    expect((await m.adb()).bin).toBe(sdk.adb?.bin);
  }, 60_000);
});
