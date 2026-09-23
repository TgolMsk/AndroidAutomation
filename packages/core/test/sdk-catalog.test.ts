import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  compareRevisions,
  decodeXmlEntities,
  fetchCatalog,
  findPackage,
  listSystemImages,
  parseRepositoryXml,
  parseXml,
  selectArchive,
  type HostPlatform,
} from '../src/sdk/catalog.js';
import { isAvdmError } from '../src/errors.js';
import type { RemotePackage, SdkCatalog } from '../src/types.js';

const FIXTURES = path.join(import.meta.dirname, 'fixtures', 'sdk');
const REPO_BASE = 'https://dl.google.com/android/repository/';
const MAC_ARM: HostPlatform = { os: 'macosx', arch: 'aarch64' };
const MAC_X64: HostPlatform = { os: 'macosx', arch: 'x64' };
const LINUX: HostPlatform = { os: 'linux', arch: 'x64' };

function fixture(name: string): string {
  return readFileSync(path.join(FIXTURES, name), 'utf8');
}

let repo: ReturnType<typeof parseRepositoryXml>;
let sysAndroid: ReturnType<typeof parseRepositoryXml>;
let sysGoogle: ReturnType<typeof parseRepositoryXml>;
let catalog: SdkCatalog;

beforeAll(() => {
  repo = parseRepositoryXml(fixture('repository2-3.xml'), REPO_BASE);
  sysAndroid = parseRepositoryXml(fixture('sys-img-android.xml'), `${REPO_BASE}sys-img/android/`);
  // Passing the manifest URL itself (not its directory) must resolve identically.
  sysGoogle = parseRepositoryXml(fixture('sys-img-google_apis.xml'), `${REPO_BASE}sys-img/google_apis/sys-img2-4.xml`);
  catalog = {
    packages: [...repo.packages, ...sysAndroid.packages, ...sysGoogle.packages],
    licenses: { ...repo.licenses, ...sysAndroid.licenses, ...sysGoogle.licenses },
    fetchedAt: new Date().toISOString(),
  };
});

describe('decodeXmlEntities', () => {
  it('decodes predefined entities and character references', () => {
    expect(decodeXmlEntities('&lt;a&gt; &amp; &quot;b&quot; &apos;c&apos;')).toBe(`<a> & "b" 'c'`);
    expect(decodeXmlEntities('&#60;&#x3C;&#X3c;&#169;&#x1F600;')).toBe('<<<©😀');
  });

  it('keeps unknown or invalid entities verbatim and does not double-decode', () => {
    expect(decodeXmlEntities('&nbsp; &#xD800; & alone')).toBe('&nbsp; &#xD800; & alone');
    expect(decodeXmlEntities('&amp;lt;')).toBe('&lt;');
  });
});

describe('parseXml', () => {
  it('handles prefixes, attributes, CDATA, comments, PIs, DOCTYPE and self-closing tags', () => {
    const doc = parseXml(
      `<?xml version="1.0"?>\r\n<!DOCTYPE x [ <!ENTITY foo "bar"> ]>\r\n<!-- <fake/> -->` +
        `<ns:root xmlns:ns="urn:x" a='1' ns:b="x &gt; y" c="with > inside">` +
        `<ns:item id="i1"/><item id="i2">t&amp;1<![CDATA[<raw & text>]]></item>` +
        `<!-- comment <item id="nope"/> --></ns:root>`,
    );
    const root = doc.children[0]!;
    expect(root.name).toBe('root');
    expect(root.qname).toBe('ns:root');
    expect(root.attrs).toEqual({ a: '1', b: 'x > y', c: 'with > inside' });
    expect(root.children.map((c) => [c.name, c.attrs.id])).toEqual([
      ['item', 'i1'],
      ['item', 'i2'],
    ]);
    expect(root.children[1]!.text).toBe('t&1<raw & text>');
  });

  it('is lenient with mismatched end tags', () => {
    const doc = parseXml('<a><b><c>x</b><d/></a>');
    const a = doc.children[0]!;
    expect(a.children.map((c) => c.name)).toEqual(['b', 'd']);
    expect(a.children[0]!.children[0]!.text).toBe('x');
  });
});

describe('parseRepositoryXml — synthetic manifest', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<sdk:sdk-repository xmlns:sdk="http://schemas.android.com/sdk/android/repo/repository2/03"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <license id="lic-a" type="text">Line &lt;1&gt; &amp; &quot;quoted&quot; &apos;x&apos; &#65;&#x42;
<![CDATA[<cdata & stuff>]]>
</license>
  <channel id="channel-0">stable</channel>
  <remotePackage path="tool;x">
    <type-details xsi:type="generic:genericDetailsType"/>
    <revision><major>1</major><minor>2</minor></revision>
    <display-name>Tool &amp; Co</display-name>
    <uses-license ref="lic-a"/>
    <dependencies>
      <dependency path="emulator"><min-revision><major>99</major><minor>9</minor><micro>9</micro></min-revision></dependency>
    </dependencies>
    <archives>
      <archive>
        <complete>
          <size>10</size>
          <checksum type="sha1">ABCDEF0123456789ABCDEF0123456789ABCDEF01</checksum>
          <url>sub/tool-1.2.zip</url>
        </complete>
        <patches><patch><complete><size>1</size><checksum type="sha1">0000000000000000000000000000000000000000</checksum><url>patch.zip</url></complete></patch></patches>
      </archive>
      <archive>
        <complete><size>5</size><checksum type="sha256">deadbeef</checksum><url>no-sha1.zip</url></complete>
      </archive>
    </archives>
  </remotePackage>
  <remotePackage obsolete="true" path="tool;old">
    <revision><major>1</major></revision>
    <archives><archive><complete><size>1</size><checksum>1111111111111111111111111111111111111111</checksum><url>https://example.com/old.zip</url></complete></archive></archives>
  </remotePackage>
  <wrapper>
    <remotePackage path="tool;nested">
      <revision><major>3</major><minor>0</minor><micro>0</micro><preview>2</preview></revision>
      <channelRef ref="channel-3"/>
      <archives><archive><complete><size>1</size><checksum type="sha1">2222222222222222222222222222222222222222</checksum><url>https://example.com/n.zip</url></complete></archive></archives>
    </remotePackage>
  </wrapper>
</sdk:sdk-repository>`;

  it('decodes license text, resolves URLs, ignores nested revision-like elements and obsolete packages', () => {
    const r = parseRepositoryXml(xml, 'https://mirror.example/repo');
    expect(r.licenses['lic-a']).toBe(`Line <1> & "quoted" 'x' AB\n<cdata & stuff>\n`);
    expect(r.packages.map((p) => p.path)).toEqual(['tool;x', 'tool;nested']);
    const tool = r.packages[0]!;
    expect(tool.revision).toBe('1.2');
    expect(tool.displayName).toBe('Tool & Co');
    expect(tool.channel).toBe('channel-0'); // default when no channelRef
    expect(tool.licenseId).toBe('lic-a');
    expect(tool.archives).toEqual([
      { url: 'https://mirror.example/repo/sub/tool-1.2.zip', size: 10, sha1: 'abcdef0123456789abcdef0123456789abcdef01' },
    ]);
    const nested = r.packages[1]!;
    expect(nested.revision).toBe('3.0.0.2');
    expect(nested.channel).toBe('channel-3');
    expect(nested.licenseId).toBe('');
    expect(nested.archives[0]!.url).toBe('https://example.com/n.zip');
  });
});

describe('parseRepositoryXml — real Google manifests', () => {
  it('parses repository2-3.xml', () => {
    expect(repo.packages.length).toBeGreaterThan(200);
    expect(Object.keys(repo.licenses)).toEqual(expect.arrayContaining(['android-sdk-license', 'android-sdk-preview-license']));
    expect(repo.licenses['android-sdk-license']!.startsWith('Terms and Conditions\n\nThis is the Android Software Development Kit License Agreement')).toBe(true);
    expect(repo.licenses['android-sdk-license']!.endsWith('January 16, 2019\n')).toBe(true);

    const emulators = repo.packages.filter((p) => p.path === 'emulator');
    expect(emulators.map((p) => `${p.revision}@${p.channel}`).sort()).toEqual([
      '37.1.11@channel-0',
      '37.2.10@channel-1',
      '37.3.1@channel-2',
    ]);
    const stable = emulators.find((p) => p.channel === 'channel-0')!;
    expect(stable.displayName).toBe('Android Emulator');
    expect(stable.licenseId).toBe('android-sdk-license');
    expect(stable.archives).toHaveLength(4);
    expect(stable.archives).toContainEqual({
      url: 'https://dl.google.com/android/repository/emulator-darwin_aarch64-15917651.zip',
      size: 394555844,
      sha1: 'f22f44948a2b7f0a0103645b9a639290eef92426',
      hostOs: 'macosx',
      hostArch: 'aarch64',
    });

    // <dependencies><min-revision> must not leak into <revision>.
    expect(repo.packages.find((p) => p.path === 'emulators;16373346')!.revision).toBe('37.1.3');
    // Preview revisions keep the preview component.
    expect(repo.packages.find((p) => p.path === 'ndk;30.0.16138531')!.revision).toBe('30.0.16138531.3');
    // Obsolete duplicates are skipped.
    expect(repo.packages.filter((p) => p.path === 'platforms;android-34')).toHaveLength(1);
    expect(repo.packages.some((p) => p.path === 'platforms;android-UpsideDownCake')).toBe(false);
  });

  it('parses platform-tools 37.0.1', () => {
    const pt = repo.packages.filter((p) => p.path === 'platform-tools');
    expect(pt).toHaveLength(1);
    expect(pt[0]!.revision).toBe('37.0.1');
    expect(pt[0]!.archives).toContainEqual({
      url: 'https://dl.google.com/android/repository/platform-tools_r37.0.1-darwin.zip',
      size: 16110554,
      sha1: '6ae73f4de6452dc57e62ec02b68eed92a4c21661',
      hostOs: 'macosx',
    });
  });

  it('parses the default arm64 Android 35 image with sys-img relative URL and type-details', () => {
    const img = sysAndroid.packages.find((p) => p.path === 'system-images;android-35;default;arm64-v8a')!;
    expect(img).toMatchObject({
      displayName: 'ARM 64 v8a System Image',
      revision: '2',
      channel: 'channel-0',
      licenseId: 'android-sdk-license',
      apiLevel: '35',
      tagId: 'default',
      tagDisplay: 'Default Android System Image',
      abi: 'arm64-v8a',
    });
    expect(img.archives).toEqual([
      {
        url: 'https://dl.google.com/android/repository/sys-img/android/arm64-v8a-35_r02.zip',
        size: 769099654,
        sha1: '2026a06409db630b56711afdbffb457c1dbaed49',
      },
    ]);
    expect(Object.keys(sysAndroid.licenses)).toEqual(
      expect.arrayContaining(['android-sdk-license', 'android-sdk-arm-dbt-license']),
    );
  });

  it('parses google_apis images (arm-dbt license, API extensions, minor levels, multi-tag)', () => {
    const g35 = sysGoogle.packages.find((p) => p.path === 'system-images;android-35;google_apis;arm64-v8a')!;
    expect(g35).toMatchObject({
      revision: '9',
      licenseId: 'android-sdk-arm-dbt-license',
      apiLevel: '35',
      tagId: 'google_apis',
      tagDisplay: 'Google APIs',
      abi: 'arm64-v8a',
    });
    expect(g35.archives[0]!.url).toBe('https://dl.google.com/android/repository/sys-img/google_apis/arm64-v8a-35_r09.zip');

    // Modern (API 29+) google_apis arm64 images use the arm-dbt license; old ones the plain SDK license.
    const googleArm = sysGoogle.packages.filter(
      (p) => p.path.includes(';google_apis;') && p.abi === 'arm64-v8a' && Number.parseInt(p.apiLevel!, 10) >= 29,
    );
    expect(googleArm.length).toBeGreaterThan(5);
    for (const p of googleArm) expect(p.licenseId).toBe('android-sdk-arm-dbt-license');
    expect(
      sysGoogle.packages.find((p) => p.path === 'system-images;android-28;google_apis;arm64-v8a')!.licenseId,
    ).toBe('android-sdk-license');

    const ext = sysGoogle.packages.find((p) => p.path === 'system-images;android-35-ext15;google_apis;arm64-v8a')!;
    expect(ext.apiLevel).toBe('35-ext15');
    const minor = sysGoogle.packages.find((p) => p.path === 'system-images;android-36.1;google_apis;arm64-v8a')!;
    expect(minor.apiLevel).toBe('36.1');

    // ps16k images list page_size_16kb as an extra (sometimes first) tag; primary tag follows the path.
    const ps = sysGoogle.packages.find((p) => p.path === 'system-images;android-36;google_apis_ps16k;arm64-v8a')!;
    expect(ps.tagId).toBe('google_apis');
    expect(ps.tagDisplay).toBe('Google APIs, 16 KB Page Size');
  });

  it('picks the longest matching tag as primary for multi-tag images', () => {
    const xml = `<sys-img:sdk-sys-img xmlns:sys-img="http://schemas.android.com/sdk/android/repo/sys-img2/04">
  <remotePackage path="system-images;android-37;google_apis_playstore_ps16k;arm64-v8a">
    <type-details><api-level>37</api-level>
      <tag><id>page_size_16kb</id><display>16 KB Page Size</display></tag>
      <tag><id>google_apis</id><display>Google APIs</display></tag>
      <tag><id>google_apis_playstore</id><display>Google Play</display></tag>
      <abi>arm64-v8a</abi></type-details>
    <revision><major>1</major></revision>
    <archives><archive><complete><size>1</size><checksum type="sha1">${'3'.repeat(40)}</checksum><url>a.zip</url></complete></archive></archives>
  </remotePackage>
</sys-img:sdk-sys-img>`;
    const p = parseRepositoryXml(xml, 'https://x/sys-img/google_apis_playstore/').packages[0]!;
    expect(p.tagId).toBe('google_apis_playstore');
    expect(p.tagDisplay).toBe('Google Play, 16 KB Page Size, Google APIs');
    expect(p.apiLevel).toBe('37');
  });
});

describe('compareRevisions', () => {
  it('orders numerically with previews before finals', () => {
    expect(compareRevisions('37.1.11', '37.1.3')).toBe(1);
    expect(compareRevisions('2', '2.0.0')).toBe(0);
    expect(compareRevisions('10', '9.9.9')).toBe(1);
    expect(compareRevisions('30.0.1.3', '30.0.1')).toBe(-1);
    expect(compareRevisions('30.0.1.3', '30.0.1.2')).toBe(1);
    expect(compareRevisions('30.0.1 rc3', '30.0.1.3')).toBe(0);
  });
});

describe('selectArchive', () => {
  it('picks the host archive and prefers the most specific match', () => {
    const emu = findPackage(catalog, 'emulator', { host: MAC_ARM })!;
    expect(selectArchive(emu, MAC_ARM)!.url).toMatch(/emulator-darwin_aarch64-15917651\.zip$/);
    expect(selectArchive(emu, MAC_X64)!.url).toMatch(/emulator-darwin_x64-15917651\.zip$/);
    expect(selectArchive(emu, LINUX)!.url).toMatch(/emulator-linux_x64-15917651\.zip$/);

    const pkg: RemotePackage = {
      path: 'p',
      displayName: 'p',
      revision: '1',
      channel: 'channel-0',
      licenseId: '',
      archives: [
        { url: 'https://x/any.zip', size: 1, sha1: 'a'.repeat(40) },
        { url: 'https://x/mac.zip', size: 1, sha1: 'b'.repeat(40), hostOs: 'macosx' },
        { url: 'https://x/win.zip', size: 1, sha1: 'c'.repeat(40), hostOs: 'windows' },
      ],
    };
    expect(selectArchive(pkg, MAC_ARM)!.url).toBe('https://x/mac.zip');
    expect(selectArchive(pkg, LINUX)!.url).toBe('https://x/any.zip');
    expect(selectArchive({ ...pkg, archives: [pkg.archives[2]!] }, MAC_ARM)).toBeUndefined();
  });
});

describe('findPackage', () => {
  it('returns the newest stable package with a host archive', () => {
    const emu = findPackage(catalog, 'emulator', { host: MAC_ARM })!;
    expect(emu.revision).toBe('37.1.11');
    expect(emu.channel).toBe('channel-0');
    expect(emu.licenseId).toBe('android-sdk-license');
    expect(findPackage(catalog, 'platform-tools', { host: MAC_ARM })!.revision).toBe('37.0.1');
    const img = findPackage(catalog, 'system-images;android-35;default;arm64-v8a', { host: MAC_ARM })!;
    expect(selectArchive(img, MAC_ARM)!.url).toBe(
      'https://dl.google.com/android/repository/sys-img/android/arm64-v8a-35_r02.zip',
    );
  });

  it('considers preview channels only with allowPreview', () => {
    const emu = findPackage(catalog, 'emulator', { host: MAC_ARM, allowPreview: true })!;
    expect(emu.revision).toBe('37.3.1');
    expect(emu.channel).toBe('channel-2');
  });

  it('skips packages without an archive for the host and unknown paths', () => {
    expect(findPackage(catalog, 'no;such;package')).toBeUndefined();
    const only: SdkCatalog = {
      ...catalog,
      packages: [
        {
          path: 'x',
          displayName: 'x',
          revision: '9',
          channel: 'channel-0',
          licenseId: '',
          archives: [{ url: 'https://x/w.zip', size: 1, sha1: 'c'.repeat(40), hostOs: 'windows' }],
        },
        {
          path: 'x',
          displayName: 'x',
          revision: '1',
          channel: 'channel-0',
          licenseId: '',
          archives: [{ url: 'https://x/m.zip', size: 1, sha1: 'd'.repeat(40), hostOs: 'macosx' }],
        },
      ],
    };
    expect(findPackage(only, 'x', { host: MAC_ARM })!.revision).toBe('1');
    expect(findPackage(only, 'x', { host: LINUX })).toBeUndefined();
  });
});

describe('listSystemImages', () => {
  it('lists stable arm64-v8a images, newest API first', () => {
    const list = listSystemImages(catalog);
    expect(list.length).toBeGreaterThan(20);
    for (const p of list) {
      expect(p.path.startsWith('system-images;')).toBe(true);
      expect(p.abi).toBe('arm64-v8a');
      expect(p.channel).toBe('channel-0');
      expect(p.path).not.toMatch(/CANARY|canary|beta/);
    }
    const paths = list.map((p) => p.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths).toContain('system-images;android-35;default;arm64-v8a');
    expect(paths).toContain('system-images;android-35;google_apis;arm64-v8a');
    // Descending API order.
    const i36 = paths.indexOf('system-images;android-36;default;arm64-v8a');
    const i35 = paths.indexOf('system-images;android-35;default;arm64-v8a');
    const i361 = paths.indexOf('system-images;android-36.1;google_apis;arm64-v8a');
    const iExt = paths.indexOf('system-images;android-35-ext15;google_apis;arm64-v8a');
    expect(i361).toBeLessThan(i36);
    expect(i36).toBeLessThan(iExt);
    expect(iExt).toBeLessThan(i35);
    // Within one API level the default tag comes first.
    expect(i35).toBeLessThan(paths.indexOf('system-images;android-35;google_apis;arm64-v8a'));
    expect(paths.at(-1)).toMatch(/android-21;/);
    // Every entry has a display name for its tag.
    for (const p of list) expect(p.tagDisplay).toBeTruthy();
  });

  it('includes developer previews with allowPreview', () => {
    const list = listSystemImages(catalog, { allowPreview: true });
    expect(list.map((p) => p.path)).toContain('system-images;android-CANARY;google_apis_ps16k;arm64-v8a');
    expect(list.length).toBeGreaterThan(listSystemImages(catalog).length);
  });
});

describe('fetchCatalog (offline, file:// mirror)', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'avdm-sdk-catalog-'));
    mkdirSync(path.join(dir, 'sys-img', 'android'), { recursive: true });
    mkdirSync(path.join(dir, 'sys-img', 'google_apis'), { recursive: true });
    writeFileSync(path.join(dir, 'repository2-3.xml'), fixture('repository2-3.xml'));
    writeFileSync(path.join(dir, 'sys-img', 'android', 'sys-img2-4.xml'), fixture('sys-img-android.xml'));
    writeFileSync(path.join(dir, 'sys-img', 'google_apis', 'sys-img2-4.xml'), fixture('sys-img-google_apis.xml'));
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it('downloads and merges the manifests, resolving archive URLs against each manifest', async () => {
    vi.stubEnv('AVDM_SDK_REPOSITORY', pathToFileURL(dir).href);
    const cat = await fetchCatalog({ tags: ['default', 'google_apis'] });
    expect(cat.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(cat.licenses['android-sdk-license']).toBeTruthy();
    expect(cat.licenses['android-sdk-arm-dbt-license']).toBeTruthy();
    const base = pathToFileURL(dir).href.replace(/\/?$/, '/');
    const emu = findPackage(cat, 'emulator', { host: MAC_ARM })!;
    expect(selectArchive(emu, MAC_ARM)!.url).toBe(`${base}emulator-darwin_aarch64-15917651.zip`);
    const img = findPackage(cat, 'system-images;android-35;default;arm64-v8a')!;
    expect(img.archives[0]!.url).toBe(`${base}sys-img/android/arm64-v8a-35_r02.zip`);
    const g = findPackage(cat, 'system-images;android-35;google_apis;arm64-v8a')!;
    expect(g.archives[0]!.url).toBe(`${base}sys-img/google_apis/arm64-v8a-35_r09.zip`);
  });

  it('fails with DOWNLOAD_FAILED when a manifest is missing', async () => {
    vi.stubEnv('AVDM_SDK_REPOSITORY', pathToFileURL(dir).href);
    const err = await fetchCatalog({ tags: ['default', 'google_apis_playstore'] }).catch((e: unknown) => e);
    expect(isAvdmError(err, 'DOWNLOAD_FAILED')).toBe(true);
  });

  it('rejects malformed tags', async () => {
    const err = await fetchCatalog({ tags: ['../etc'] }).catch((e: unknown) => e);
    expect(isAvdmError(err, 'INVALID_ARGUMENT')).toBe(true);
  });
});
