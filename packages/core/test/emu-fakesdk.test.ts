import { execFile, spawn } from 'node:child_process';
import { constants as fsConstants, promises as fsp } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { consoleKill } from '../src/emulator/console.js';
import { listRunningEmulators } from '../src/emulator/discovery.js';
import {
  FAKE_DEFAULT_IMAGE,
  createFakeSdk,
  getFreePort,
  killIfFake,
  startFakeEmulator,
  waitForExit,
  writeFakeAvd,
  type FakeSdk,
  type RunningFakeEmulator,
} from './helpers/fakeSdk.js';

function run(
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(bin, args, { env, timeout: 15_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

let fake: FakeSdk;
const running: RunningFakeEmulator[] = [];

beforeAll(async () => {
  fake = await createFakeSdk({ bootMs: 50, acceptedLicenses: ['android-sdk-license'] });
});
afterEach(async () => {
  await Promise.all(running.splice(0).map((e) => e.stop()));
});
afterAll(async () => {
  await fake.cleanup();
});

describe('fake SDK layout', () => {
  it('has executable tools, versions, a system image and licenses', async () => {
    for (const bin of [fake.emulatorBin, fake.adbBin, fake.qemuImgBin]) {
      await fsp.access(bin, fsConstants.X_OK);
    }
    expect(await fsp.readFile(path.join(fake.root, 'emulator', 'source.properties'), 'utf8')).toContain('Pkg.Revision=37.1.11');
    expect(fake.images).toHaveLength(1);
    const img = fake.images[0]!;
    expect(img.packagePath).toBe(FAKE_DEFAULT_IMAGE);
    expect(img.sysdirRel).toBe('system-images/android-35/default/arm64-v8a/');
    expect(img.dir).toBe(path.join(fake.root, 'system-images', 'android-35', 'default', 'arm64-v8a'));
    await fsp.access(path.join(img.dir, 'system.img'));
    const props = await fsp.readFile(path.join(img.dir, 'source.properties'), 'utf8');
    expect(props).toContain('SystemImage.TagId=default');
    expect(props).toContain('AndroidVersion.ApiLevel=35');
    await fsp.access(path.join(fake.root, 'licenses', 'android-sdk-license'));
    expect(fake.env).toMatchObject({
      AVDM_DISCOVERY_DIR: fake.discoveryDir,
      ANDROID_HOME: fake.root,
      ANDROID_SDK_ROOT: fake.root,
      FAKE_BOOT_MS: '50',
    });
    await fsp.access(fake.env.FAKE_PROTO_PATH!);
  });

  it('can create an SDK without images', async () => {
    const bare = await createFakeSdk({ images: [] });
    try {
      expect(bare.images).toEqual([]);
      await expect(fsp.access(path.join(bare.root, 'system-images'))).rejects.toThrow();
    } finally {
      await bare.cleanup();
    }
  });
});

describe('fake qemu-img', () => {
  it('info --output=json and rebase', async () => {
    const plain = path.join(fake.base, 'plain.img');
    await fsp.writeFile(plain, 'data');
    const info = await run(fake.qemuImgBin, ['info', '--output=json', plain]);
    expect(info.code).toBe(0);
    expect(JSON.parse(info.stdout)).toMatchObject({ filename: plain, format: 'qcow2' });

    const overlay = path.join(fake.base, 'system.img.qcow2');
    await fsp.writeFile(overlay, 'fake-qcow2 backing=/old/system.img\n');
    expect(JSON.parse((await run(fake.qemuImgBin, ['info', '--output=json', '-U', overlay])).stdout)).toMatchObject({
      'backing-filename': '/old/system.img',
      'backing-filename-format': 'raw',
    });
    expect((await run(fake.qemuImgBin, ['rebase', '-u', '-b', '/new/system.img', '-F', 'raw', overlay])).code).toBe(0);
    expect(JSON.parse((await run(fake.qemuImgBin, ['info', '--output=json', overlay])).stdout)['backing-filename']).toBe(
      '/new/system.img',
    );
    const missing = await run(fake.qemuImgBin, ['info', '--output=json', path.join(fake.base, 'nope')]);
    expect(missing.code).toBe(1);
  });
});

describe('fake emulator', () => {
  it('-list-avds / -version', async () => {
    const avdHome = path.join(fake.base, 'list-avds');
    await writeFakeAvd(avdHome, 'avdm_1');
    await writeFakeAvd(avdHome, 'avdm_0');
    const res = await run(fake.emulatorBin, ['-list-avds'], { ...process.env, ANDROID_AVD_HOME: avdHome });
    expect(res.stdout).toBe('avdm_0\navdm_1\n');
    expect((await run(fake.emulatorBin, ['-version'])).stdout).toContain('37.1.11.0');
  });

  it('fails like the real one for an unknown AVD / missing discovery dir / simulated failure', async () => {
    const env = { ...process.env, ...fake.env, ANDROID_AVD_HOME: path.join(fake.base, 'empty-avd-home') };
    const unknown = await run(fake.emulatorBin, ['-avd', 'nope', '-port', String(await getFreePort())], env);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain('PANIC: Unknown AVD name [nope]');

    const noDisc = { ...env } as NodeJS.ProcessEnv;
    delete noDisc.AVDM_DISCOVERY_DIR;
    expect((await run(fake.emulatorBin, ['-avd', 'x'], noDisc)).code).toBe(1);

    expect((await run(fake.emulatorBin, ['-avd', 'x'], { ...env, FAKE_FAIL_START: '1' })).stderr).toContain(
      'simulated start failure',
    );
  });

  it('refuses a missing system image referenced by config.ini', async () => {
    const avdHome = path.join(fake.base, 'bad-sysdir');
    await writeFakeAvd(avdHome, 'avdm_9', { sysdirRel: 'system-images/android-99/default/arm64-v8a/' });
    const res = await run(fake.emulatorBin, ['-avd', 'avdm_9', '-port', String(await getFreePort())], {
      ...process.env,
      ...fake.env,
      ANDROID_AVD_HOME: avdHome,
    });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('Cannot find AVD system path');
  });

  it('exits 1 when the console port is taken, leaving no discovery file', async () => {
    const blocker = net.createServer();
    const port = await getFreePort();
    await new Promise<void>((r) => blocker.listen(port, '127.0.0.1', r));
    try {
      const avdHome = path.join(fake.base, 'busy');
      await writeFakeAvd(avdHome, 'avdm_2', { sysdirRel: fake.images[0]!.sysdirRel });
      const res = await run(fake.emulatorBin, ['-avd', 'avdm_2', '-port', String(port), '-grpc', String(await getFreePort())], {
        ...process.env,
        ...fake.env,
        ANDROID_AVD_HOME: avdHome,
      });
      expect(res.code).toBe(1);
      expect(res.stderr).toContain('startup failed');
      expect((await fsp.readdir(fake.discoveryDir)).filter((f) => f.startsWith('pid_'))).toEqual([]);
    } finally {
      blocker.close();
    }
  });

  it('writes a discovery file compatible with the real format and removes it on SIGTERM', async () => {
    const emu = await startFakeEmulator(fake, { env: { FAKE_GRPC_TOKEN: 'tok' } });
    running.push(emu);
    const [entry] = (await listRunningEmulators([fake.discoveryDir])).filter((e) => e.pid === emu.pid);
    expect(entry).toMatchObject({
      avdName: emu.avdName,
      consolePort: emu.consolePort,
      adbPort: emu.consolePort + 1,
      grpcPort: emu.grpcPort,
      grpcToken: 'tok',
      emulatorVersion: '37.1.11.0',
    });
    expect(entry!.avdDir).toBe(path.join(fake.base, 'avd', `${emu.avdName}.avd`));
    expect(entry!.raw['cmdline']).toContain('-avd');
    // runtime files like the real emulator
    await fsp.access(path.join(entry!.avdDir!, 'multiinstance.lock'));
    await fsp.access(path.join(entry!.avdDir!, 'hardware-qemu.ini'));
    expect(await fsp.readFile(path.join(entry!.avdDir!, 'system.img.qcow2'), 'utf8')).toContain(
      `backing=${path.join(fake.images[0]!.dir, 'system.img')}`,
    );

    process.kill(emu.pid, 'SIGTERM');
    expect(await waitForExit(emu.pid, 5000)).toBe(true);
    await expect(fsp.access(emu.discoveryFile)).rejects.toThrow();
    await expect(fsp.access(path.join(entry!.avdDir!, 'multiinstance.lock'))).rejects.toThrow();
  });

  it('console kill saves a quick-boot snapshot unless -no-snapshot', async () => {
    const quick = await startFakeEmulator(fake);
    const cold = await startFakeEmulator(fake, { args: ['-no-snapshot'] });
    running.push(quick, cold);
    await consoleKill(quick.consolePort);
    await consoleKill(cold.consolePort);
    await waitForExit(quick.pid, 5000);
    await waitForExit(cold.pid, 5000);
    const avdHome = path.join(fake.base, 'avd');
    await fsp.access(path.join(avdHome, `${quick.avdName}.avd`, 'snapshots', 'default_boot', 'snapshot.pb'));
    await expect(fsp.access(path.join(avdHome, `${cold.avdName}.avd`, 'snapshots'))).rejects.toThrow();
  });

  it('a simulated crash leaves a stale discovery file that listRunningEmulators ignores', async () => {
    const emu = await startFakeEmulator(fake, { env: { FAKE_CRASH_AFTER_MS: '150' } });
    running.push(emu);
    expect(await waitForExit(emu.pid, 5000)).toBe(true);
    await fsp.access(emu.discoveryFile); // still there, like after a real crash
    expect((await listRunningEmulators([fake.discoveryDir])).some((e) => e.pid === emu.pid)).toBe(false);
    await fsp.rm(emu.discoveryFile, { force: true });
  });

  it('killIfFake refuses to kill a process that is not from this SDK', async () => {
    const other = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 20000)'], { stdio: 'ignore' });
    try {
      expect(await killIfFake(other.pid!, fake.root)).toBe(false);
      expect(other.exitCode).toBeNull();
    } finally {
      other.kill('SIGKILL');
    }
  });
});

describe('cleanup', () => {
  it('kills leftover fake emulators and removes the temp dir', async () => {
    const own = await createFakeSdk();
    const a = await startFakeEmulator(own);
    const b = await startFakeEmulator(own, { env: { FAKE_KILL_DELAY_MS: '60000' } });
    await own.cleanup();
    expect(await waitForExit(a.pid, 3000)).toBe(true);
    expect(await waitForExit(b.pid, 3000)).toBe(true);
    await expect(fsp.access(own.base)).rejects.toThrow();
  });

  it('fake emulators exit by themselves when their temp dir disappears', async () => {
    const own = await createFakeSdk();
    const emu = await startFakeEmulator(own);
    try {
      await fsp.rm(own.base, { recursive: true, force: true });
      expect(await waitForExit(emu.pid, 5000)).toBe(true);
    } finally {
      await killIfFake(emu.pid, own.root);
    }
  });
});
