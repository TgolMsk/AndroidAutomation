import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AdbDevice } from '../src/adb.js';
import {
  ANGLE_OVERRIDES_DISABLED_PROP as PROP,
  asRootCommand,
  ensureAngleOverrides,
  localPropScript,
  mergeAngleFeatureList,
} from '../src/angle-overrides.js';

const FEATURE = 'supportsSwapchainMaintenance1';

/**
 * A guest answering the commands ensureAngleOverrides sends. The /data/local.prop script is only recognised here (its
 * shell semantics are run for real below); `su` exists on userdebug images and not on user builds.
 */
function fakeGuest(options: { egl?: string; value?: string; uid?: string; su?: boolean; setpropSticks?: boolean } = {}) {
  const props = new Map<string, string>([['ro.hardware.egl', options.egl ?? 'angle']]);
  if (options.value !== undefined) props.set(PROP, options.value);
  const shells: string[] = [];
  const guest = { shells, localProp: undefined as string | undefined, device: undefined as unknown as AdbDevice };
  guest.device = {
    getprop: async (name: string) => props.get(name) ?? '',
    shell: async (command: string) => {
      shells.push(command);
      if (command === 'id -u') return `${options.uid ?? '0'}\n`;
      const set = /^setprop (\S+) '([^']*)'$/.exec(command);
      if (set) {
        if (options.setpropSticks !== false) props.set(set[1]!, set[2]!);
        return '';
      }
      let script = command;
      if (command.startsWith('su 0 sh -c ')) {
        if (!options.su) throw new Error('Command failed: /system/bin/sh: su: inaccessible or not found');
        script = command.slice('su 0 sh -c '.length).slice(1, -1).replace(/'\\''/g, "'");
      }
      const line = /echo '([^']*)'; \} > \/data\/local\.prop\.avdm-tmp/.exec(script)?.[1];
      if (line) {
        guest.localProp = line;
        return 'AVDM_OK\n';
      }
      return '';
    },
  } as unknown as AdbDevice;
  return guest;
}

describe('mergeAngleFeatureList', () => {
  it('adds the required features and keeps what the guest already lists', () => {
    expect(mergeAngleFeatureList('', [FEATURE])).toBe(FEATURE);
    expect(mergeAngleFeatureList('exposeN*', [FEATURE])).toBe(`exposeN*:${FEATURE}`);
    expect(mergeAngleFeatureList(` foo : ${FEATURE} `, [FEATURE])).toBe(`foo:${FEATURE}`);
  });

  it('matches names like ANGLE does (case and underscores ignored) and drops entries that are no feature names', () => {
    expect(mergeAngleFeatureList('supports_swapchain_maintenance1', [FEATURE])).toBe('supports_swapchain_maintenance1');
    expect(mergeAngleFeatureList("bad value:x';reboot::ok", [FEATURE])).toBe(`ok:${FEATURE}`);
  });
});

describe('ensureAngleOverrides', () => {
  it('leaves a guest that does not render through ANGLE alone', async () => {
    const guest = fakeGuest({ egl: 'emulation' });
    expect(await ensureAngleOverrides(guest.device)).toEqual({ state: 'not-angle', egl: 'emulation' });
    expect(guest.shells).toEqual([]);
  });

  it('only reads when the property already lists the feature (set by local.prop at boot or a Quick Boot snapshot)', async () => {
    const guest = fakeGuest({ value: FEATURE });
    expect(await ensureAngleOverrides(guest.device)).toEqual({ state: 'ok', value: FEATURE });
    expect(guest.shells).toEqual([]);
  });

  it('sets the property for this boot and keeps it in /data/local.prop (adbd already root)', async () => {
    const guest = fakeGuest();
    expect(await ensureAngleOverrides(guest.device)).toEqual({ state: 'applied', value: FEATURE, persisted: true });
    expect(guest.shells[0]).toBe(`setprop ${PROP} '${FEATURE}'`);
    expect(guest.shells.some((command) => command.startsWith('su '))).toBe(false);
    expect(guest.localProp).toBe(`${PROP}=${FEATURE}`);
    // The next check (another monitor tick) only reads.
    const before = guest.shells.length;
    expect(await ensureAngleOverrides(guest.device)).toEqual({ state: 'ok', value: FEATURE });
    expect(guest.shells).toHaveLength(before);
  });

  it('writes the file through su when adbd is not root, keeping the guest\'s own entries', async () => {
    const guest = fakeGuest({ uid: '2000', su: true, value: 'exposeN*' });
    expect(await ensureAngleOverrides(guest.device)).toEqual({ state: 'applied', value: `exposeN*:${FEATURE}`, persisted: true });
    expect(guest.shells.at(-1)).toMatch(/^su 0 sh -c '/);
    expect(guest.localProp).toBe(`${PROP}=exposeN*:${FEATURE}`);
  });

  it('still protects this boot when the file cannot be written (user build without su)', async () => {
    const guest = fakeGuest({ uid: '2000', su: false });
    expect(await ensureAngleOverrides(guest.device)).toEqual({ state: 'applied', value: FEATURE, persisted: false });
    expect(guest.shells).toContain(`setprop ${PROP} '${FEATURE}'`);
    expect(guest.localProp).toBeUndefined();
  });

  it('fails when the property does not read back, and when the merged list is too long for a property', async () => {
    await expect(ensureAngleOverrides(fakeGuest({ setpropSticks: false }).device)).rejects.toMatchObject({ code: 'COMMAND_FAILED' });
    // 65 characters of the guest's own entries + ours = 95 > 91 (PROP_VALUE_MAX - 1).
    const crowded = fakeGuest({ value: Array.from({ length: 3 }, (_, i) => `someOtherFeatureName${i}`).join(':') });
    await expect(ensureAngleOverrides(crowded.device)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(crowded.shells).toEqual([]);
  });
});

describe('the /data/local.prop script in a real shell', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'avdm-angle-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const run = (command: string, env: NodeJS.ProcessEnv = process.env) => execFileSync('/bin/sh', ['-c', command], { env, encoding: 'utf8' });

  it('creates the file with mode 644 (init skips group/world-writable ones)', async () => {
    const file = path.join(dir, 'local.prop');
    expect(run(localPropScript(PROP, FEATURE, file))).toBe('AVDM_OK\n');
    expect(await readFile(file, 'utf8')).toBe(`${PROP}=${FEATURE}\n`);
    expect((await stat(file)).mode & 0o777).toBe(0o644);
  });

  it('replaces an older value of the key and keeps every other line', async () => {
    const file = path.join(dir, 'local.prop');
    await writeFile(file, `# mine\npersist.x=1\n${PROP}=old\ndebug.y=2\n`);
    await chmod(file, 0o666);
    expect(run(localPropScript(PROP, `exposeN*:${FEATURE}`, file))).toBe('AVDM_OK\n');
    expect(await readFile(file, 'utf8')).toBe(`# mine\npersist.x=1\ndebug.y=2\n${PROP}=exposeN*:${FEATURE}\n`);
    expect((await stat(file)).mode & 0o777).toBe(0o644);
  });

  it('survives the quoting of the su wrapper', async () => {
    const file = path.join(dir, 'local.prop');
    // A stand-in for the image's su: `su 0 sh -c <script>` runs the script.
    await writeFile(path.join(dir, 'su'), '#!/bin/sh\nshift\nexec "$@"\n', { mode: 0o755 });
    const command = asRootCommand(localPropScript(PROP, FEATURE, file), '2000\n');
    expect(command.startsWith('su 0 sh -c ')).toBe(true);
    expect(run(command, { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` })).toBe('AVDM_OK\n');
    expect(await readFile(file, 'utf8')).toBe(`${PROP}=${FEATURE}\n`);
    expect(asRootCommand('true', '0\n')).toBe('true');
  });
});
