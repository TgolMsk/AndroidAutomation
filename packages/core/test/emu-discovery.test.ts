import { spawn, spawnSync } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoveryFilePid, listRunningEmulators, parseDiscoveryIni } from '../src/emulator/discovery.js';
import { isPidAlive, isPidStartedBy, parseEtime, processStartTimes } from '../src/util/proc.js';

/** Some live process owned by root other than launchd (pid > 1), or undefined. */
function rootOwnedPid(): number | undefined {
  const out = spawnSync('ps', ['-U', '0', '-o', 'pid='], { encoding: 'utf8' }).stdout ?? '';
  return out
    .split('\n')
    .map((l) => Number(l.trim()))
    .find((p) => Number.isInteger(p) && p > 1);
}

describe('process identity helpers', () => {
  it('parses ps etime', () => {
    expect(parseEtime('05:12')).toBe(312);
    expect(parseEtime('1:05:12')).toBe(3912);
    expect(parseEtime('2-01:05:12')).toBe(2 * 86400 + 3912);
    expect(parseEtime('garbage')).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')('estimates start times and recognises younger processes', async () => {
    const starts = await processStartTimes([process.pid]);
    expect(starts?.get(process.pid)).toBeLessThanOrEqual(Date.now());
    expect(await isPidStartedBy(process.pid, Date.now())).toBe(true);
    // this process did not exist an hour ago: a record from then cannot be about it
    expect(await isPidStartedBy(process.pid, Date.now() - 3600_000)).toBe(false);
    const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
    await new Promise((r) => child.once('exit', r));
    expect(await isPidStartedBy(child.pid!, Date.now())).toBe(false); // dead
  });
});

// Real format (vendor build of android-emu 36.6.1 on macOS), token/jwk shortened.
const REAL_DISCOVERY = [
  'emulator.build=standalone-0',
  'avd.id=avd_1',
  'port.serial=5554',
  'port.adb=5555',
  'avd.name=Temu',
  'emulator.version=36.6.1.0',
  'avd.dir=/Users/someone/Library/Vendor/avd_1',
  'cmdline="/Applications/Vendor.app/emulator" "-avd" "avd_1" "-port" "5554"',
  'grpc.token=c2VjcmV0LXRva2Vu==',
  'grpc.jwk={"keys":[{"kty":"EC","crv":"P-256","x":"abc=","y":"def="}]}',
  'grpc.allowlist=/Users/someone/Library/Vendor/emulator_access.json',
  'grpc.port=8554',
  '',
].join('\n');

describe('parseDiscoveryIni', () => {
  it('falls back to avd.name when avd.id is absent', () => {
    const e = parseDiscoveryIni('avd.name=avdm_3\nport.serial=5560\n', '/x/pid_1.ini', 1);
    expect(e.avdName).toBe('avdm_3');
  });

  it('parses the real discovery file format', () => {
    const e = parseDiscoveryIni(REAL_DISCOVERY, '/x/pid_4242.ini', 4242);
    expect(e).toMatchObject({
      pid: 4242,
      file: '/x/pid_4242.ini',
      // avd.id is the AVD id; avd.name is only the display name (verified on emulator 37.1.11)
      avdName: 'avd_1',
      avdDir: '/Users/someone/Library/Vendor/avd_1',
      consolePort: 5554,
      adbPort: 5555,
      grpcPort: 8554,
      grpcToken: 'c2VjcmV0LXRva2Vu==',
      emulatorVersion: '36.6.1.0',
    });
    expect(e.raw['avd.name']).toBe('Temu');
    // values containing '=' survive intact
    expect(e.raw['grpc.jwk']).toBe('{"keys":[{"kty":"EC","crv":"P-256","x":"abc=","y":"def="}]}');
    expect(e.raw.cmdline).toContain('"-avd" "avd_1"');
  });

  it('tolerates missing/garbage values and spaced keys', () => {
    const e = parseDiscoveryIni('avd.name = avdm_3\nport.serial=abc\ngrpc.port=\nport.adb = 5561\n', 'f', 1);
    expect(e.avdName).toBe('avdm_3');
    expect(e.consolePort).toBeUndefined();
    expect(e.grpcPort).toBeUndefined();
    expect(e.adbPort).toBe(5561);
    expect(e.grpcToken).toBeUndefined();
    expect(e.emulatorVersion).toBeUndefined();
  });

  it('extracts pids from file names', () => {
    expect(discoveryFilePid('pid_123.ini')).toBe(123);
    expect(discoveryFilePid('pid_0.ini')).toBeUndefined();
    expect(discoveryFilePid('pid_12.ini.tmp')).toBeUndefined();
    expect(discoveryFilePid('.pid_12.ini.tmp')).toBeUndefined();
    expect(discoveryFilePid('other.ini')).toBeUndefined();
  });
});

describe('listRunningEmulators', () => {
  let dir: string;
  let dir2: string;
  const children: number[] = [];

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'avdm-disc-'));
    dir2 = await fsp.mkdtemp(path.join(os.tmpdir(), 'avdm-disc2-'));
  });
  afterEach(async () => {
    for (const pid of children.splice(0)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.rm(dir2, { recursive: true, force: true });
  });

  /** A pid that is guaranteed dead: spawn a process and wait for it to exit. */
  async function deadPid(): Promise<number> {
    const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
    await new Promise((r) => child.once('exit', r));
    return child.pid!;
  }

  it('returns only entries whose pid is alive', async () => {
    const live = process.pid;
    const dead = await deadPid();
    await fsp.writeFile(path.join(dir, `pid_${live}.ini`), 'avd.name=avdm_0\nport.serial=5554\ngrpc.port=8554\n');
    await fsp.writeFile(path.join(dir, `pid_${dead}.ini`), 'avd.name=avdm_1\nport.serial=5556\n');
    await fsp.writeFile(path.join(dir, 'notes.txt'), 'ignored');
    await fsp.writeFile(path.join(dir, `.pid_${live}.ini.tmp`), 'avd.name=partial\n');
    const list = await listRunningEmulators([dir]);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ pid: live, avdName: 'avdm_0', consolePort: 5554, grpcPort: 8554 });
    expect(list[0]!.file).toBe(path.join(dir, `pid_${live}.ini`));
  });

  it('merges several dirs, skips empty files and missing dirs, sorts by console port', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 30000)'], { stdio: 'ignore' });
    children.push(child.pid!);
    await fsp.writeFile(path.join(dir, `pid_${child.pid}.ini`), 'avd.name=b\nport.serial=5560\n');
    await fsp.writeFile(path.join(dir2, `pid_${process.pid}.ini`), 'avd.name=a\nport.serial=5554\n');
    const emptyChild = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 30000)'], { stdio: 'ignore' });
    children.push(emptyChild.pid!);
    await fsp.writeFile(path.join(dir2, `pid_${emptyChild.pid}.ini`), '');
    const list = await listRunningEmulators([dir, path.join(dir, 'missing'), dir2]);
    expect(list.map((e) => e.avdName)).toEqual(['a', 'b']);
  });

  it('uses AVDM_DISCOVERY_DIR when no dirs are given', async () => {
    const prev = process.env.AVDM_DISCOVERY_DIR;
    process.env.AVDM_DISCOVERY_DIR = dir;
    try {
      await fsp.writeFile(path.join(dir, `pid_${process.pid}.ini`), 'avd.name=envdir\nport.serial=5570\n');
      const list = await listRunningEmulators();
      expect(list.map((e) => e.avdName)).toEqual(['envdir']);
    } finally {
      if (prev === undefined) delete process.env.AVDM_DISCOVERY_DIR;
      else process.env.AVDM_DISCOVERY_DIR = prev;
    }
  });

  it('ignores a stale file whose pid now belongs to a younger process (recycled pid)', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 30000)'], { stdio: 'ignore' });
    children.push(child.pid!);
    await new Promise((r) => child.once('spawn', r));
    const stale = path.join(dir, `pid_${child.pid}.ini`);
    await fsp.writeFile(stale, 'avd.id=avdm_0\nport.serial=5554\n');
    // written by an emulator that died an hour ago; the pid was since handed to this child
    const hourAgo = new Date(Date.now() - 3600_000);
    await fsp.utimes(stale, hourAgo, hourAgo);
    const fresh = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 30000)'], { stdio: 'ignore' });
    children.push(fresh.pid!);
    await new Promise((r) => fresh.once('spawn', r));
    await fsp.writeFile(path.join(dir, `pid_${fresh.pid}.ini`), 'avd.id=avdm_1\nport.serial=5556\n');
    const list = await listRunningEmulators([dir]);
    expect(list.map((e) => e.pid)).toEqual([fresh.pid]);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    "ignores a file whose pid belongs to another user's process (EPERM is not alive)",
    async () => {
      const rootPid = rootOwnedPid();
      if (rootPid === undefined) return;
      expect(isPidAlive(rootPid)).toBe(false);
      await fsp.writeFile(path.join(dir, `pid_${rootPid}.ini`), 'avd.id=avdm_0\nport.serial=5554\n');
      expect(await listRunningEmulators([dir])).toEqual([]);
    },
  );

  it('returns [] for a nonexistent dir', async () => {
    expect(await listRunningEmulators([path.join(dir, 'nope')])).toEqual([]);
  });
});
