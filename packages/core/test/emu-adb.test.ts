import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Adb, escapeInputText, parseAdbDevices, parseForegroundPackage, parsePackageList } from '../src/adb.js';
import { createFakeSdk, startFakeEmulator, waitForExit, type FakeSdk, type RunningFakeEmulator } from './helpers/fakeSdk.js';

describe('adb parsers', () => {
  it('parses `devices -l` (tab and space separated, odd states)', () => {
    const text = [
      '* daemon not running; starting now at tcp:5037',
      '* daemon started successfully',
      'List of devices attached',
      'emulator-5554\tdevice product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1',
      'emulator-5556          offline transport_id:2',
      '0123456789ABCDEF       unauthorized usb:1-1 transport_id:3',
      'R58M123       no permissions (missing udev rules? user is in the plugdev group); see [http://developer.android.com/tools/device.html] usb:1-2 transport_id:4',
      '',
    ].join('\n');
    const devs = parseAdbDevices(text);
    expect(devs.map((d) => [d.serial, d.state])).toEqual([
      ['emulator-5554', 'device'],
      ['emulator-5556', 'offline'],
      ['0123456789ABCDEF', 'unauthorized'],
      ['R58M123', 'no permissions (missing udev rules? user is in the plugdev group); see [http://developer.android.com/tools/device.html]'],
    ]);
    expect(devs[0]!.props).toEqual({ product: 'sdk_gphone64_arm64', model: 'sdk_gphone64_arm64', device: 'emu64a', transport_id: '1' });
    expect(devs[3]!.props).toMatchObject({ usb: '1-2', transport_id: '4' });
    expect(parseAdbDevices('List of devices attached\n\n')).toEqual([]);
  });

  it('escapes input text for the device shell', () => {
    expect(escapeInputText('hello world')).toBe('hello%sworld');
    expect(escapeInputText(`a'b"c`)).toBe(`a\\'b\\"c`);
    expect(escapeInputText('(x)&<y>|z;*~$`')).toBe('\\(x\\)\\&\\<y\\>\\|z\\;\\*\\~\\$\\`');
    expect(escapeInputText('back\\slash')).toBe('back\\\\slash');
    expect(escapeInputText('tab\there\n')).toBe('tabhere');
    expect(escapeInputText('user@example.com')).toBe('user@example.com');
  });

  it('finds the foreground package', () => {
    expect(
      parseForegroundPackage('  mCurrentFocus=Window{1a2b u0 com.example.game/com.example.game.Main}\n'),
    ).toBe('com.example.game');
    expect(
      parseForegroundPackage(
        '  mCurrentFocus=Window{9f u0 NotificationShade}\n  mFocusedApp=ActivityRecord{4d5e u0 com.android.settings/.Settings t7}\n',
      ),
    ).toBe('com.android.settings');
    expect(parseForegroundPackage('  mCurrentFocus=null\n  mFocusedApp=null\n')).toBeUndefined();
  });

  it('parses package lists (with -f paths too)', () => {
    expect(parsePackageList('package:b.b\npackage:a.a\r\npackage:/data/app/x/base.apk=c.c\ngarbage\n')).toEqual([
      'a.a',
      'b.b',
      'c.c',
    ]);
  });
});

describe('Adb against the fake adb', () => {
  let fake: FakeSdk;
  let emu: RunningFakeEmulator;
  let adb: Adb;
  const savedDiscovery = process.env.AVDM_DISCOVERY_DIR;
  const savedAdbLog = process.env.FAKE_ADB_LOG;

  beforeAll(async () => {
    fake = await createFakeSdk({ bootMs: 0 });
    // The fake adb finds devices through the discovery dir, inherited from our env.
    process.env.AVDM_DISCOVERY_DIR = fake.discoveryDir;
    process.env.FAKE_ADB_LOG = fake.adbLog;
    emu = await startFakeEmulator(fake);
    adb = new Adb(fake.adbBin);
  });
  afterAll(async () => {
    await emu?.stop();
    await fake?.cleanup();
    if (savedDiscovery === undefined) delete process.env.AVDM_DISCOVERY_DIR;
    else process.env.AVDM_DISCOVERY_DIR = savedDiscovery;
    if (savedAdbLog === undefined) delete process.env.FAKE_ADB_LOG;
    else process.env.FAKE_ADB_LOG = savedAdbLog;
  });

  async function adbLogLines(): Promise<Array<{ serial: string | null; args: string[] }>> {
    const text = await fsp.readFile(fake.adbLog, 'utf8').catch(() => '');
    return text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }

  it('server and version', async () => {
    await adb.startServer();
    expect(await adb.version()).toBe('37.0.1-fake');
    expect(await new Adb(path.join(fake.root, 'nope', 'adb')).version()).toBeUndefined();
  });

  it('lists the running fake emulator', async () => {
    const devs = await adb.devices();
    expect(devs).toHaveLength(1);
    expect(devs[0]).toMatchObject({ serial: emu.serial, state: 'device' });
    expect(devs[0]!.props.model).toBe('sdk_gphone64_arm64');
  });

  it('device state and props', async () => {
    const dev = adb.device(emu.serial);
    expect(await dev.getState()).toBe('device');
    expect(await dev.getprop('ro.product.model')).toBe('fake');
    expect(await dev.isBootCompleted()).toBe(true);
    await expect(dev.getprop('x; rm -rf /')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(await dev.shell('wm size')).toContain('Physical size: 1280x720');
  });

  it('unknown serial: getState undefined, isBootCompleted false, run rejects', async () => {
    const dev = adb.device('emulator-1');
    expect(await dev.getState()).toBeUndefined();
    expect(await dev.isBootCompleted()).toBe(false);
    await expect(dev.shell('echo hi')).rejects.toMatchObject({ code: 'COMMAND_FAILED' });
  });

  it('packages and foreground app', async () => {
    const dev = adb.device(emu.serial);
    expect(await dev.listPackages({ thirdPartyOnly: true })).toEqual(['com.example.game']);
    expect(await dev.listPackages()).toEqual(['com.android.settings', 'com.android.systemui', 'com.example.game']);
    expect(await dev.foregroundPackage()).toBe('com.example.game');
  });

  it('screencapPng returns PNG bytes', async () => {
    const png = await adb.device(emu.serial).screencapPng();
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(png.readUInt32BE(16)).toBe(4); // IHDR width
    expect(png.readUInt32BE(20)).toBe(2); // IHDR height
  });

  it('install / install-multiple / uninstall', async () => {
    const dev = adb.device(emu.serial);
    const apk = path.join(fake.base, 'app.apk');
    const split = path.join(fake.base, 'split.apk');
    await fsp.writeFile(apk, 'PK fake');
    await fsp.writeFile(split, 'PK fake');
    expect(await dev.install([apk], { grantAll: true })).toContain('Success');
    expect(await dev.install([apk, split])).toContain('Success');
    await expect(dev.install([path.join(fake.base, 'missing.apk')])).rejects.toMatchObject({ code: 'COMMAND_FAILED' });
    await expect(dev.install([])).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(await dev.uninstall('com.example.game')).toBe('Success');
    const calls = (await adbLogLines()).map((c) => c.args);
    expect(calls).toContainEqual(['install', '-r', '-g', apk]);
    expect(calls).toContainEqual(['install-multiple', '-r', apk, split]);
  });

  it('push / pull', async () => {
    const dev = adb.device(emu.serial);
    const local = path.join(fake.base, 'push.txt');
    await fsp.writeFile(local, 'x');
    expect(await dev.push(local, '/sdcard/push.txt')).toContain('1 file pushed');
    const dest = path.join(fake.base, 'pulled.txt');
    expect(await dev.pull('/sdcard/push.txt', dest)).toContain('1 file pulled');
    expect(await fsp.readFile(dest, 'utf8')).toContain('/sdcard/push.txt');
  });

  it('input helpers send the expected shell commands', async () => {
    const dev = adb.device(emu.serial);
    await dev.tap(10.4, 20.6);
    await dev.swipe(1, 2, 3, 4, 500);
    await dev.keyevent(4);
    await dev.keyevent('home');
    await dev.keyevent('KEYCODE_BACK');
    await dev.text("it's a test");
    await dev.startApp('com.example.game');
    await dev.startApp('com.example.game', '.Main');
    await dev.stopApp('com.example.game');
    await expect(dev.keyevent('bad key')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(dev.tap(Number.NaN, 1)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(dev.startApp('com.x; reboot')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });

    const shells = (await adbLogLines())
      .filter((c) => c.serial === emu.serial && c.args[0] === 'shell')
      .map((c) => c.args.slice(1));
    for (const s of shells) expect(s).toHaveLength(1); // always ONE shell argument
    const cmds = shells.map((s) => s[0]);
    expect(cmds).toEqual(
      expect.arrayContaining([
        'input tap 10 21',
        'input swipe 1 2 3 4 500',
        'input keyevent 4',
        'input keyevent KEYCODE_HOME',
        'input keyevent KEYCODE_BACK',
        "input text it\\'s%sa%stest",
        'monkey -p com.example.game -c android.intent.category.LAUNCHER 1',
        "am start -n 'com.example.game/.Main'",
        'am force-stop com.example.game',
      ]),
    );
  });

  it('emu kill (via the console) stops the fake emulator', async () => {
    const other = await startFakeEmulator(fake);
    try {
      const dev = adb.device(other.serial);
      expect(await dev.getState()).toBe('device');
      const out = await dev.run(['emu', 'kill']);
      expect(out).toContain('OK: killing emulator');
      expect(await waitForExit(other.pid, 5000)).toBe(true);
      expect(await dev.getState()).toBeUndefined();
    } finally {
      await other.stop();
    }
  });
});
