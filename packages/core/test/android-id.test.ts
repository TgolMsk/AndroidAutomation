import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AdbDevice } from '../src/adb.js';
import { ensureAndroidId } from '../src/android-id.js';

const TOKEN = '9cebbaea9ec601a5';

/** A guest with one user, an SSAID file, and a settings provider that is not ready for the first `putFailures` puts. */
function fakeGuest(options: { current: string; putFailures?: number }) {
  const shells: string[] = [];
  const runs: string[] = [];
  let current = options.current;
  let putFailures = options.putFailures ?? 0;
  const device = {
    run: async (args: string[]) => { runs.push(args.join(' ')); return ''; },
    shell: async (command: string) => {
      shells.push(command);
      if (command.startsWith('settings get')) return `${current}\n`;
      if (command.startsWith('settings put')) {
        if (putFailures > 0) { putFailures -= 1; throw new Error(`Command failed: adb shell ${command}`); }
        if (command.includes('--user 0 ')) current = command.split(' ').at(-1)!;
        return '';
      }
      if (command.includes('settings_ssaid.xml; do')) return '/data/system/users/0/settings_ssaid.xml\n';
      if (command.includes('[0-9]*; do')) return '0\n';
      if (command.startsWith('getprop init.svc.zygote')) return 'running\nService activity: found\nService wifi: found\n';
      return '';
    },
  } as unknown as AdbDevice;
  return { device, shells, runs };
}

describe('ensureAndroidId', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'avdm-android-id-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
  const marker = () => path.join(dir, '.avdm-android-id');

  it('never rotates again once the guest already has the token: the missing marker is just written (no framework restart)', async () => {
    const guest = fakeGuest({ current: TOKEN });
    await ensureAndroidId(guest.device, TOKEN, dir);
    expect(await readFile(marker(), 'utf8')).toBe(`${TOKEN}\n`);
    expect(guest.runs).toEqual([]);
    expect(guest.shells.some((command) => command === 'stop' || command === 'start')).toBe(false);
    // Marker and value agree: nothing but the read.
    await ensureAndroidId(guest.device, TOKEN, dir);
    expect(guest.shells.filter((command) => !command.startsWith('settings get'))).toEqual([]);
  });

  it('rotates once and waits for the settings provider after the framework restart', async () => {
    const guest = fakeGuest({ current: 'aaaaaaaaaaaaaaaa', putFailures: 2 });
    await ensureAndroidId(guest.device, TOKEN, dir, { settingsReadyMs: 5_000, settingsRetryMs: 1 });
    expect(await readFile(marker(), 'utf8')).toBe(`${TOKEN}\n`);
    expect(guest.shells.filter((command) => command === 'stop')).toHaveLength(1);
    expect(guest.shells.filter((command) => command === 'start')).toHaveLength(1);
    expect(guest.shells.filter((command) => command.startsWith('settings put'))).toHaveLength(3);
    // The next health tick sees the token and does nothing.
    const before = guest.shells.length;
    await ensureAndroidId(guest.device, TOKEN, dir);
    expect(guest.shells.slice(before).every((command) => command.startsWith('settings get'))).toBe(true);
  });

  it('gives up after the settings wait without writing the marker', async () => {
    const guest = fakeGuest({ current: 'aaaaaaaaaaaaaaaa', putFailures: 1_000 });
    await writeFile(marker(), 'old\n');
    await expect(ensureAndroidId(guest.device, TOKEN, dir, { settingsReadyMs: 20, settingsRetryMs: 5 })).rejects.toThrow('Command failed');
    expect(await readFile(marker(), 'utf8')).toBe('old\n');
  });
});
