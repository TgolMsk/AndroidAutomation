import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  avdDirFor,
  cloneAvd,
  createAvd,
  readAvdConfig,
  readQcow2Header,
  rewriteSnapshotHardwareIni,
  type AvdContext,
} from '../src/avd/avdfiles.js';
import { isAvdmError } from '../src/errors.js';
import { updateIni } from '../src/util/ini.js';
import {
  makeFakeQemuImg,
  makeRecord,
  makeSdk,
  makeSpec,
  makeTempDir,
  snapshotTree,
  writeQcow2,
  type FakeQemuImg,
} from './fixtures/avd-support/helpers.js';

let tmp: string;
let avdHome: string;
let sdkRoot: string;
let fake: FakeQemuImg;

const SRC = 'avdm_0';

/** Entries that must never survive into a clone. */
const EXCLUDED = [
  'multiinstance.lock',
  'hardware-qemu.ini',
  'hardware-qemu.ini.lock',
  'userdata-qemu.img.lock',
  'bootcompleted.ini',
  'read-snapshot.txt',
  'quickbootChoice.ini',
  'tmpAdbCmds',
  path.join('data', 'misc', 'nested.lock'),
];

/** Entries that must be carried over. */
const KEPT = [
  'config.ini',
  'userdata-qemu.img',
  'userdata-qemu.img.qcow2',
  'encryptionkey.img',
  'encryptionkey.img.qcow2',
  'system.img.qcow2',
  'cache.img',
  'cache.img.qcow2',
  'sdcard.img.qcow2',
  'emulator-user.ini',
  path.join('data', 'misc', 'keep.txt'),
];

beforeEach(async () => {
  tmp = await makeTempDir('avdm-clone-');
  avdHome = path.join(tmp, 'home', 'avd');
  sdkRoot = path.join(tmp, 'sdk');
  fake = await makeFakeQemuImg(path.join(tmp, 'fake-qemu'));
});

afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

function ctxWith(qemuImg: string | undefined, home = avdHome): AvdContext {
  return { avdHome: home, sdk: makeSdk(sdkRoot, { qemuImg }) };
}

/**
 * A realistic stopped AVD: created by createAvd, then populated with the files a few emulator runs leave
 * behind. `backingDir` is the spelling of the source dir the emulator wrote into the overlays.
 */
async function makeSourceAvd(backingDir = avdDirFor(avdHome, SRC)): Promise<string> {
  await createAvd(ctxWith(undefined), makeRecord(0, { name: '源实例' }));
  const dir = avdDirFor(avdHome, SRC);
  const cfg = path.join(dir, 'config.ini');
  await fsp.writeFile(cfg, updateIni(await fsp.readFile(cfg, 'utf8'), { 'hw.custom.note': 'keep-me' }));

  const w = (rel: string, data: string | Buffer = rel) =>
    fsp.mkdir(path.dirname(path.join(dir, rel)), { recursive: true }).then(() => fsp.writeFile(path.join(dir, rel), data));

  // Disk images + qcow2 overlays.
  await w('userdata-qemu.img', Buffer.alloc(64 * 1024, 7));
  await writeQcow2(path.join(dir, 'userdata-qemu.img.qcow2'), path.join(backingDir, 'userdata-qemu.img'));
  await w('encryptionkey.img', Buffer.alloc(4096, 3));
  await writeQcow2(path.join(dir, 'encryptionkey.img.qcow2'), path.join(backingDir, 'encryptionkey.img'));
  const sdkSystemImg = path.join(sdkRoot, 'system-images', 'android-35', 'default', 'arm64-v8a', 'system.img');
  await writeQcow2(path.join(dir, 'system.img.qcow2'), sdkSystemImg);
  await w('cache.img', Buffer.alloc(4096, 5));
  await writeQcow2(path.join(dir, 'cache.img.qcow2'), 'cache.img'); // relative backing
  await writeQcow2(path.join(dir, 'sdcard.img.qcow2')); // no backing file

  // Runtime / lock state.
  await w('multiinstance.lock', '12345');
  await w('hardware-qemu.ini', `disk.dataPartition.path=${path.join(dir, 'userdata-qemu.img')}\n`);
  await fsp.mkdir(path.join(dir, 'hardware-qemu.ini.lock')); // emulator file locks can be directories
  await w(path.join('hardware-qemu.ini.lock', 'pid'), '12345');
  await w('userdata-qemu.img.lock', '');
  await w('bootcompleted.ini', 'boot=1');
  await w('read-snapshot.txt', 'default_boot');
  await w('quickbootChoice.ini', 'saveOnExit=true');
  await w(path.join('tmpAdbCmds', 'cmd-1'), 'shell ls');
  await w(path.join('data', 'misc', 'nested.lock'), '');

  // Quick Boot snapshot.
  await w(path.join('snapshots', 'default_boot', 'snapshot.pb'), 'pb');
  await w(path.join('snapshots', 'default_boot', 'hardware.ini'), 'hw');
  await w(path.join('snapshots', 'default_boot', 'ram.bin'), Buffer.alloc(8192, 9));
  await w(path.join('snapshots', 'default_boot', 'ram.bin.lock'), '');

  // User state that must be kept.
  await w('emulator-user.ini', 'window.x=10\nwindow.y=20\n');
  await w(path.join('data', 'misc', 'keep.txt'), 'hello');

  // Canned `qemu-img info` answers (keyed by basename, as a real qemu-img reading the cloned header would print).
  await fake.setInfo('userdata-qemu.img.qcow2', {
    filename: 'userdata-qemu.img.qcow2',
    format: 'qcow2',
    'backing-filename': path.join(backingDir, 'userdata-qemu.img'),
    'full-backing-filename': path.join(backingDir, 'userdata-qemu.img'),
    'backing-filename-format': 'raw',
  });
  // No backing-filename-format → the backing's own `format` must be looked up.
  await fake.setInfo('encryptionkey.img.qcow2', {
    format: 'qcow2',
    'backing-filename': path.join(backingDir, 'encryptionkey.img'),
  });
  await fake.setInfo('encryptionkey.img', { format: 'qcow2' });
  await fake.setInfo('system.img.qcow2', {
    format: 'qcow2',
    'backing-filename': sdkSystemImg,
    'backing-filename-format': 'raw',
  });
  await fake.setInfo('cache.img.qcow2', { format: 'qcow2', 'backing-filename': 'cache.img', 'backing-filename-format': 'raw' });
  await fake.setInfo('sdcard.img.qcow2', { format: 'qcow2' });
  return dir;
}

async function exists(p: string): Promise<boolean> {
  return fsp.access(p).then(
    () => true,
    () => false,
  );
}

async function expectCode(p: Promise<unknown>, code: string): Promise<Error> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(isAvdmError(err), `expected AvdmError(${code}), got ${String(err)}`).toBe(true);
  expect((err as { code: string }).code).toBe(code);
  return err as Error;
}

const dstRecord = () =>
  makeRecord(5, {
    name: '克隆-5',
    clonedFrom: 0,
    spec: makeSpec({ ramMb: 4096, dataPartitionGb: 32, width: 1920, height: 1080, dpi: 480 }),
  });

describe('cloneAvd with qemu-img', () => {
  it('copies the AVD, prunes runtime files, rewrites ini/config and rebases overlays into the clone', async () => {
    const srcDir = await makeSourceAvd();
    const srcIniBefore = await fsp.readFile(path.join(avdHome, `${SRC}.ini`), 'utf8');
    const srcTreeBefore = await snapshotTree(srcDir);

    const { method } = await cloneAvd(ctxWith(fake.bin), SRC, dstRecord());
    expect(['apfs-clone', 'copy']).toContain(method);

    const dstDir = avdDirFor(avdHome, 'avdm_5');
    for (const rel of EXCLUDED) expect(await exists(path.join(dstDir, rel)), `${rel} should be gone`).toBe(false);
    expect(await exists(path.join(dstDir, 'snapshots'))).toBe(false);
    for (const rel of KEPT) expect(await exists(path.join(dstDir, rel)), `${rel} should be kept`).toBe(true);
    expect(await fsp.readFile(path.join(dstDir, 'userdata-qemu.img'))).toEqual(Buffer.alloc(64 * 1024, 7));

    // Pointer .ini with the new path.
    expect(await fsp.readFile(path.join(avdHome, 'avdm_5.ini'), 'utf8')).toBe(
      ['avd.ini.encoding=UTF-8', `path=${dstDir}`, 'path.rel=avd/avdm_5.avd', 'target=android-35', ''].join('\n'),
    );

    // config.ini: identity + spec rewritten, everything else preserved, AvdId still first.
    const cfgText = await fsp.readFile(path.join(dstDir, 'config.ini'), 'utf8');
    expect(cfgText.split('\n')[0]).toBe('AvdId=avdm_5');
    expect(await readAvdConfig(avdHome, 'avdm_5')).toMatchObject({
      AvdId: 'avdm_5',
      'avd.ini.displayname': '克隆-5',
      'hw.ramSize': '4096',
      'disk.dataPartition.size': '32G',
      'hw.lcd.width': '1920',
      'hw.lcd.height': '1080',
      'hw.lcd.density': '480',
      'skin.name': '1920x1080',
      'hw.initialOrientation': 'landscape',
      'hw.custom.note': 'keep-me',
      'image.sysdir.1': 'system-images/android-35/default/arm64-v8a/',
      'tag.id': 'default',
    });

    // qemu-img: only overlays backed by files inside the source dir are rebased, onto the clone's copies.
    const calls = await fake.calls();
    const rebases = calls.filter((c) => c[0] === 'rebase');
    const key = (c: string[]) => c.join(' ');
    expect(rebases.map(key).sort()).toEqual(
      [
        ['rebase', '-u', '-F', 'raw', '-b', path.join(dstDir, 'userdata-qemu.img'), path.join(dstDir, 'userdata-qemu.img.qcow2')],
        ['rebase', '-u', '-F', 'qcow2', '-b', path.join(dstDir, 'encryptionkey.img'), path.join(dstDir, 'encryptionkey.img.qcow2')],
      ]
        .map(key)
        .sort(),
    );
    // The backing format lookup for encryptionkey used the clone's copy.
    expect(calls).toContainEqual(['info', '--output=json', path.join(dstDir, 'encryptionkey.img')]);
    // Every qemu-img invocation targeted the clone, never the source.
    for (const c of calls) expect(c[c.length - 1]!.startsWith(dstDir + path.sep)).toBe(true);

    // Source untouched.
    expect(await snapshotTree(srcDir)).toEqual(srcTreeBefore);
    expect(await fsp.readFile(path.join(avdHome, `${SRC}.ini`), 'utf8')).toBe(srcIniBefore);
    expect((await readAvdConfig(avdHome, SRC))?.AvdId).toBe(SRC);
  });

  it('keepSnapshots keeps snapshots/ (minus lock files)', async () => {
    await makeSourceAvd();
    await cloneAvd(ctxWith(fake.bin), SRC, dstRecord(), { keepSnapshots: true });
    const snap = path.join(avdDirFor(avdHome, 'avdm_5'), 'snapshots', 'default_boot');
    expect(await exists(path.join(snap, 'snapshot.pb'))).toBe(true);
    expect(await exists(path.join(snap, 'hardware.ini'))).toBe(true);
    expect(await fsp.readFile(path.join(snap, 'ram.bin'))).toEqual(Buffer.alloc(8192, 9));
    expect(await exists(path.join(snap, 'ram.bin.lock'))).toBe(false);
    // Runtime files are pruned regardless.
    expect(await exists(path.join(avdDirFor(avdHome, 'avdm_5'), 'multiinstance.lock'))).toBe(false);
  });

  it('keepSnapshots points the kept snapshot hardware.ini at the clone (id, name, disk paths)', async () => {
    const srcDir = await makeSourceAvd();
    const hw = [
      'avd.id = avdm_0',
      'avd.name = avdm_0',
      `disk.cachePartition.path = ${path.join(srcDir, 'cache.img')}`,
      `disk.dataPartition.path = ${path.join(srcDir, 'userdata-qemu.img')}`,
      `disk.encryptionKeyPartition.path = ${path.join(srcDir, 'encryptionkey.img')}`,
      `disk.systemPartition.initPath = ${path.join(sdkRoot, 'system-images', 'android-35', 'default', 'arm64-v8a', 'system.img')}`,
      'avd.ini.displayname = avdm_0 的副本名不应改',
      'hw.lcd.width = 1280',
      '',
    ].join('\n');
    await fsp.writeFile(path.join(srcDir, 'snapshots', 'default_boot', 'hardware.ini'), hw);
    await cloneAvd(ctxWith(fake.bin), SRC, dstRecord(), { keepSnapshots: true });
    const dstDir = avdDirFor(avdHome, 'avdm_5');
    const text = await fsp.readFile(path.join(dstDir, 'snapshots', 'default_boot', 'hardware.ini'), 'utf8');
    expect(text).toBe(
      [
        'avd.id = avdm_5',
        'avd.name = avdm_5',
        `disk.cachePartition.path = ${path.join(dstDir, 'cache.img')}`,
        `disk.dataPartition.path = ${path.join(dstDir, 'userdata-qemu.img')}`,
        `disk.encryptionKeyPartition.path = ${path.join(dstDir, 'encryptionkey.img')}`,
        `disk.systemPartition.initPath = ${path.join(sdkRoot, 'system-images', 'android-35', 'default', 'arm64-v8a', 'system.img')}`,
        'avd.ini.displayname = avdm_0 的副本名不应改',
        'hw.lcd.width = 1280',
        '',
      ].join('\n'),
    );
    // the source snapshot is untouched
    expect(await fsp.readFile(path.join(srcDir, 'snapshots', 'default_boot', 'hardware.ini'), 'utf8')).toBe(hw);
  });

  it('rewriteSnapshotHardwareIni keeps unrelated lines byte for byte (CRLF, comments, relative paths)', () => {
    const t = { srcDirs: ['/h/avd/avdm_0.avd'], dstDir: '/h/avd/avdm_7.avd', srcName: 'avdm_0', dstName: 'avdm_7' };
    const input = '# comment avdm_0\r\navd.id=avdm_0\r\nfoo = avdm_00\r\nrel = userdata.img\r\ndir = /h/avd/avdm_0.avd\r\n';
    expect(rewriteSnapshotHardwareIni(input, t)).toBe(
      '# comment avdm_0\r\navd.id=avdm_7\r\nfoo = avdm_00\r\nrel = userdata.img\r\ndir = /h/avd/avdm_7.avd\r\n',
    );
  });

  it('recognises overlays that reference the source through its real path (symlinked avdHome)', async () => {
    const realHome = path.join(tmp, 'real-home');
    await fsp.mkdir(realHome, { recursive: true });
    await fsp.mkdir(path.dirname(avdHome), { recursive: true });
    await fsp.symlink(realHome, avdHome);
    const realSrc = path.join(await fsp.realpath(realHome), `${SRC}.avd`);
    await makeSourceAvd(realSrc);

    await cloneAvd(ctxWith(fake.bin), SRC, dstRecord());
    const dstDir = avdDirFor(avdHome, 'avdm_5');
    const rebased = (await fake.calls()).filter((c) => c[0] === 'rebase').map((c) => c[c.length - 1]);
    expect(rebased.sort()).toEqual(
      [path.join(dstDir, 'encryptionkey.img.qcow2'), path.join(dstDir, 'userdata-qemu.img.qcow2')].sort(),
    );
  });

  it('rolls back the clone and rethrows when qemu-img rebase fails', async () => {
    const srcDir = await makeSourceAvd();
    const before = await snapshotTree(srcDir);
    await fake.failRebase();
    await expectCode(cloneAvd(ctxWith(fake.bin), SRC, dstRecord()), 'COMMAND_FAILED');
    expect(await exists(avdDirFor(avdHome, 'avdm_5'))).toBe(false);
    expect(await exists(path.join(avdHome, 'avdm_5.ini'))).toBe(false);
    expect(await snapshotTree(srcDir)).toEqual(before);
  });
});

describe('cloneAvd without qemu-img', () => {
  for (const [label, qemuImg] of [
    ['qemuImg undefined', undefined],
    ['qemuImg path missing on disk', '/nonexistent/emulator/qemu-img'],
  ] as const) {
    it(`deletes overlays that point into the source dir (${label})`, async () => {
      const srcDir = await makeSourceAvd();
      const before = await snapshotTree(srcDir);
      await cloneAvd(ctxWith(qemuImg), SRC, dstRecord());
      const dstDir = avdDirFor(avdHome, 'avdm_5');
      expect(await exists(path.join(dstDir, 'userdata-qemu.img.qcow2'))).toBe(false);
      expect(await exists(path.join(dstDir, 'encryptionkey.img.qcow2'))).toBe(false);
      // Overlays backed by SDK files, relative names or nothing are left alone.
      expect(await exists(path.join(dstDir, 'system.img.qcow2'))).toBe(true);
      expect(await exists(path.join(dstDir, 'cache.img.qcow2'))).toBe(true);
      expect(await exists(path.join(dstDir, 'sdcard.img.qcow2'))).toBe(true);
      // Base images stay.
      expect(await exists(path.join(dstDir, 'userdata-qemu.img'))).toBe(true);
      expect(await fake.calls()).toEqual([]);
      expect(await snapshotTree(srcDir)).toEqual(before);
      expect((await readAvdConfig(avdHome, 'avdm_5'))?.AvdId).toBe('avdm_5');
    });
  }

  it('readQcow2Header parses the backing file name and ignores non-qcow2 files', async () => {
    const f = path.join(tmp, 'a.qcow2');
    await writeQcow2(f, '/some/where/userdata-qemu.img');
    expect(await readQcow2Header(f)).toEqual({ format: 'qcow2', 'backing-filename': '/some/where/userdata-qemu.img' });
    await writeQcow2(f);
    expect(await readQcow2Header(f)).toEqual({ format: 'qcow2' });
    await fsp.writeFile(f, 'not a qcow2 image at all');
    expect(await readQcow2Header(f)).toBeUndefined();
    expect(await readQcow2Header(path.join(tmp, 'missing.qcow2'))).toBeUndefined();
  });
});

describe('cloneAvd argument errors', () => {
  it('throws INVALID_ARGUMENT for a missing source', async () => {
    await expectCode(cloneAvd(ctxWith(fake.bin), 'avdm_9', dstRecord()), 'INVALID_ARGUMENT');
    expect(await exists(avdDirFor(avdHome, 'avdm_5'))).toBe(false);
  });

  it('throws INVALID_ARGUMENT when the destination exists, leaving it untouched', async () => {
    await makeSourceAvd();
    const dstDir = avdDirFor(avdHome, 'avdm_5');
    await fsp.mkdir(dstDir, { recursive: true });
    await fsp.writeFile(path.join(dstDir, 'marker'), 'mine');
    await expectCode(cloneAvd(ctxWith(fake.bin), SRC, dstRecord()), 'INVALID_ARGUMENT');
    expect(await fsp.readdir(dstDir)).toEqual(['marker']);

    await fsp.rm(dstDir, { recursive: true });
    await fsp.writeFile(path.join(avdHome, 'avdm_5.ini'), 'path=/x\n');
    await expectCode(cloneAvd(ctxWith(fake.bin), SRC, dstRecord()), 'INVALID_ARGUMENT');
    expect(await fsp.readFile(path.join(avdHome, 'avdm_5.ini'), 'utf8')).toBe('path=/x\n');
  });

  it('throws INVALID_ARGUMENT when source and destination are the same AVD', async () => {
    await makeSourceAvd();
    await expectCode(cloneAvd(ctxWith(fake.bin), SRC, makeRecord(0)), 'INVALID_ARGUMENT');
  });
});
