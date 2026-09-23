import { promises as fsp, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { isAvdmError } from '../src/errors.js';
import { AvdManager } from '../src/manager.js';
import { isLicenseAccepted } from '../src/sdk/installer.js';
import { sleeper } from './helpers/manager-harness.js';

/**
 * License consent and SDK-replacement guards of the manager, fully offline: the Google manifests from
 * test/fixtures/sdk are served from file:// via AVDM_SDK_REPOSITORY, discovery files live in a temp dir.
 */

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sdk');
const EMPTY_SYSIMG =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  '<sys-img:sdk-sys-img xmlns:sys-img="http://schemas.android.com/sdk/android/repo/sys-img2/04"></sys-img:sdk-sys-img>\n';

let tmp: string;
const saved = { repo: process.env.AVDM_SDK_REPOSITORY, disc: process.env.AVDM_DISCOVERY_DIR };
const managers: AvdManager[] = [];
const sleepers: number[] = [];

async function googleRepo(name: string, licenseEdit?: (xml: string) => string): Promise<string> {
  const repo = path.join(tmp, name);
  await fsp.mkdir(repo, { recursive: true });
  let xml = readFileSync(path.join(FIXTURES, 'repository2-3.xml'), 'utf8');
  if (licenseEdit) xml = licenseEdit(xml);
  await fsp.writeFile(path.join(repo, 'repository2-3.xml'), xml);
  for (const [tag, file] of [
    ['android', 'sys-img-android.xml'],
    ['google_apis', 'sys-img-google_apis.xml'],
    ['google_apis_playstore', undefined],
  ] as const) {
    await fsp.mkdir(path.join(repo, 'sys-img', tag), { recursive: true });
    await fsp.writeFile(
      path.join(repo, 'sys-img', tag, 'sys-img2-4.xml'),
      file ? readFileSync(path.join(FIXTURES, file), 'utf8') : EMPTY_SYSIMG,
    );
  }
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
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'avdm-consent-'));
  process.env.AVDM_DISCOVERY_DIR = path.join(tmp, 'discovery');
  await fsp.mkdir(process.env.AVDM_DISCOVERY_DIR, { recursive: true });
});

afterEach(async () => {
  for (const m of managers.splice(0)) await m.dispose();
  for (const pid of sleepers.splice(0)) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // gone
    }
  }
  for (const f of await fsp.readdir(process.env.AVDM_DISCOVERY_DIR!)) {
    await fsp.rm(path.join(process.env.AVDM_DISCOVERY_DIR!, f), { force: true });
  }
});

afterAll(async () => {
  if (saved.repo === undefined) delete process.env.AVDM_SDK_REPOSITORY;
  else process.env.AVDM_SDK_REPOSITORY = saved.repo;
  if (saved.disc === undefined) delete process.env.AVDM_DISCOVERY_DIR;
  else process.env.AVDM_DISCOVERY_DIR = saved.disc;
  await fsp.rm(tmp, { recursive: true, force: true });
});

describe('acceptLicenses records the text the user was shown', () => {
  it('uses the catalog the plan showed even after its TTL, never a silently re-fetched one', async () => {
    const original = pathToFileURL(await googleRepo('repo-v1')).href;
    process.env.AVDM_SDK_REPOSITORY = original;
    const sdkRoot = path.join(tmp, 'sdk-ttl');
    const m = await openManager(sdkRoot);
    const plan = await m.planSdkInstall(['platform-tools']);
    const id = plan.unaccepted[0]!;
    const shown = plan.licenses[id]!;

    // the user reads for more than 10 minutes; meanwhile Google revised the license and the network is down
    (m as unknown as { catalog: { at: number } }).catalog.at -= 11 * 60_000;
    await googleRepo('repo-v2', (xml) => xml.replace('Android Software Development Kit License Agreement', 'REVISED AGREEMENT'));
    process.env.AVDM_SDK_REPOSITORY = pathToFileURL(path.join(tmp, 'does-not-exist')).href;

    await m.acceptLicenses([id]); // no fetch, no DOWNLOAD_FAILED after the user said yes
    expect(await isLicenseAccepted(sdkRoot, id, shown)).toBe(true);

    // installing against the revised repository now asks for consent again
    process.env.AVDM_SDK_REPOSITORY = pathToFileURL(path.join(tmp, 'repo-v2')).href;
    const revised = await m.planSdkInstall(['platform-tools']);
    expect(revised.unaccepted).toEqual([id]);
    expect(revised.licenses[id]).toContain('REVISED AGREEMENT');
  }, 30_000);

  it('records exactly the passed texts and refuses ones that differ from the repository', async () => {
    process.env.AVDM_SDK_REPOSITORY = pathToFileURL(await googleRepo('repo-shown')).href;
    const sdkRoot = path.join(tmp, 'sdk-shown');
    const m = await openManager(sdkRoot);
    const plan = await m.planSdkInstall(['platform-tools']);
    const id = plan.unaccepted[0]!;

    const err = await m.acceptLicenses([id], { [id]: 'some other text the user never saw' }).catch((e: unknown) => e);
    expect(isAvdmError(err, 'LICENSE_NOT_ACCEPTED')).toBe(true);
    expect((err as Error).message).toContain('不一致');
    expect(await isLicenseAccepted(sdkRoot, id, plan.licenses[id]!)).toBe(false);

    await m.acceptLicenses([id], plan.licenses);
    expect(await isLicenseAccepted(sdkRoot, id, plan.licenses[id]!)).toBe(true);
    expect((await m.planSdkInstall(['platform-tools'])).unaccepted).toEqual([]);
  }, 30_000);
});

describe('replacing the shared emulator', () => {
  it('refuses while an emulator we do not manage runs from this SDK (e.g. an Android Studio AVD)', async () => {
    process.env.AVDM_SDK_REPOSITORY = pathToFileURL(await googleRepo('repo-busy')).href;
    const sdkRoot = path.join(tmp, 'sdk-shared');
    const m = await openManager(sdkRoot);
    await m.acceptLicenses((await m.planSdkInstall(['emulator'])).unaccepted);
    const pid = await sleeper();
    sleepers.push(pid);
    const file = path.join(process.env.AVDM_DISCOVERY_DIR!, `pid_${pid}.ini`);
    const emulatorBin = path.join(sdkRoot, 'emulator', 'qemu', 'darwin-aarch64', 'qemu-system-aarch64');
    await fsp.writeFile(
      file,
      `avd.id=Pixel_8_API_35\navd.dir=${path.join(tmp, 'studio-avd', 'Pixel_8_API_35.avd')}\nport.serial=5554\n` +
        `cmdline="${emulatorBin}" "-avd" "Pixel_8_API_35"\n`,
    );
    const err = await m.installSdkPackages(['emulator']).catch((e: unknown) => e);
    expect(isAvdmError(err, 'INSTANCE_RUNNING')).toBe(true);
    expect((err as Error).message).toContain('Pixel_8_API_35');
    expect((err as Error).message).toContain(`pid ${pid}`);
    expect(await fsp.readdir(m.paths.downloadsDir)).toEqual([]);

    // an emulator running from a different SDK is not affected by this install
    await fsp.writeFile(
      file,
      `avd.id=Pixel_8_API_35\nport.serial=5554\ncmdline="/Applications/Other.app/sdk/emulator/emulator" "-avd" "x"\n`,
    );
    const other = await m.installSdkPackages(['emulator']).catch((e: unknown) => e);
    expect(isAvdmError(other, 'INSTANCE_RUNNING')).toBe(false);
  }, 30_000);
});
