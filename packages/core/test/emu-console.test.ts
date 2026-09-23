import { promises as fsp } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { authTokenFileFromBanner, consoleCommand, consoleKill } from '../src/emulator/console.js';
import { consoleAuthTokenFile } from '../src/paths.js';
import {
  createFakeSdk,
  getFreePort,
  startFakeEmulator,
  waitForExit,
  type FakeSdk,
  type RunningFakeEmulator,
} from './helpers/fakeSdk.js';

let fake: FakeSdk;
const running: RunningFakeEmulator[] = [];

beforeAll(async () => {
  fake = await createFakeSdk({ bootMs: 50 });
});
afterEach(async () => {
  await Promise.all(running.splice(0).map((e) => e.stop()));
});
afterAll(async () => {
  await fake.cleanup();
});

async function start(opts: Parameters<typeof startFakeEmulator>[1] = {}): Promise<RunningFakeEmulator> {
  const emu = await startFakeEmulator(fake, opts);
  running.push(emu);
  return emu;
}

describe('authTokenFileFromBanner', () => {
  it('takes the quoted token path from the banner, else the default', () => {
    const banner =
      "Android Console: Authentication required\nAndroid Console: type 'auth <auth_token>' to authenticate\n" +
      "Android Console: you can find your <auth_token> in \n'/Users/x/.emulator_console_auth_token'\n";
    expect(authTokenFileFromBanner(banner)).toBe('/Users/x/.emulator_console_auth_token');
    expect(authTokenFileFromBanner("type 'auth <auth_token>'\n'/etc/passwd'\n")).toBe(consoleAuthTokenFile());
    expect(authTokenFileFromBanner('no quotes')).toBe(consoleAuthTokenFile());
  });
});

describe('console against the fake emulator', () => {
  it('runs commands and returns their output', async () => {
    const emu = await start();
    expect(await consoleCommand(emu.consolePort, 'avd name')).toBe(emu.avdName);
    expect(await consoleCommand(emu.consolePort, 'ping')).toBe('I am alive!');
    expect(await consoleCommand(emu.consolePort, 'avd discoverypath')).toBe(emu.discoveryFile);
  });

  it('rejects KO replies with the message', async () => {
    const emu = await start();
    await expect(consoleCommand(emu.consolePort, 'bogus command')).rejects.toMatchObject({
      code: 'COMMAND_FAILED',
      message: expect.stringContaining("unknown command, try 'help'"),
    });
  });

  it('rejects commands containing newlines', async () => {
    await expect(consoleCommand(1, 'avd name\nkill')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('authenticates with the token file named in the banner', async () => {
    const tokenFile = path.join(fake.base, '.emulator_console_auth_token');
    await fsp.writeFile(tokenFile, 's3cret-token\n');
    const emu = await start({ env: { FAKE_CONSOLE_TOKEN_FILE: tokenFile } });
    expect(await consoleCommand(emu.consolePort, 'avd name')).toBe(emu.avdName);

    await fsp.writeFile(tokenFile, 'other\n'); // emulator now expects "other"; we read the same file → still ok
    expect(await consoleCommand(emu.consolePort, 'ping')).toBe('I am alive!');
  });

  it('reports a failed authentication', async () => {
    const tokenFile = path.join(fake.base, 'auth2', '.emulator_console_auth_token');
    await fsp.mkdir(path.dirname(tokenFile), { recursive: true });
    await fsp.writeFile(tokenFile, 'right\n');
    const emu = await start({ env: { FAKE_CONSOLE_TOKEN_FILE: tokenFile } });
    // Serve a banner that points at a different token file (wrong token) through a tiny proxy.
    const wrongFile = path.join(fake.base, 'auth3', '.emulator_console_auth_token');
    await fsp.mkdir(path.dirname(wrongFile), { recursive: true });
    await fsp.writeFile(wrongFile, 'wrong\n');
    const proxy = net.createServer((client) => {
      const upstream = net.connect(emu.consolePort, '127.0.0.1');
      upstream.on('data', (d) => client.write(d.toString('utf8').split(tokenFile).join(wrongFile)));
      client.on('data', (d) => upstream.write(d));
      client.on('close', () => upstream.destroy());
      upstream.on('close', () => client.destroy());
      client.on('error', () => {});
      upstream.on('error', () => {});
    });
    const proxyPort = await getFreePort();
    await new Promise<void>((r) => proxy.listen(proxyPort, '127.0.0.1', r));
    try {
      await expect(consoleCommand(proxyPort, 'avd name')).rejects.toMatchObject({
        message: expect.stringContaining('认证失败'),
      });
    } finally {
      await new Promise((r) => proxy.close(r));
    }
  });

  it('kill: resolves true, the emulator exits and removes its discovery file', async () => {
    const emu = await start();
    expect(await consoleKill(emu.consolePort)).toBe(true);
    expect(await waitForExit(emu.pid, 5000)).toBe(true);
    await expect(fsp.access(emu.discoveryFile)).rejects.toThrow();
  });

  it('kill: resolves true even when the emulator takes a while to exit', async () => {
    const emu = await start({ env: { FAKE_KILL_DELAY_MS: '400' } });
    const t0 = Date.now();
    expect(await consoleKill(emu.consolePort, { timeoutMs: 2000 })).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(await waitForExit(emu.pid, 5000)).toBe(true);
  });

  it('kill: resolves false when nothing listens; commands reject', async () => {
    const port = await getFreePort();
    expect(await consoleKill(port, { timeoutMs: 1000 })).toBe(false);
    await expect(consoleCommand(port, 'avd name', { timeoutMs: 1000 })).rejects.toMatchObject({
      code: 'COMMAND_FAILED',
      message: expect.stringContaining('无法连接模拟器控制台'),
    });
  });

  it('times out on a silent server', async () => {
    const server = net.createServer(() => {}); // accepts, never answers
    const port = await getFreePort();
    await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
    try {
      const t0 = Date.now();
      await expect(consoleCommand(port, 'avd name', { timeoutMs: 300 })).rejects.toMatchObject({
        message: expect.stringContaining('超时'),
      });
      expect(Date.now() - t0).toBeLessThan(2000);
      expect(await consoleKill(port, { timeoutMs: 300 })).toBe(false); // never got to send
    } finally {
      server.close();
    }
  });
});

describe('temp dir hygiene', () => {
  it('fake SDK lives under the OS temp dir', () => {
    expect(fake.root.startsWith(os.tmpdir())).toBe(true);
  });
});
