import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => import('../../emulator-shell/test/helpers/electron-mock'));

import { DEFAULT_SPEC, Registry, resolvePaths, saveSettings, type InstanceRecord } from '@avdm/core';
import { ManagerHost } from '../src/main/manager-host';
import { BrowserWindow } from '../../emulator-shell/test/helpers/electron-mock';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred: () => boolean, timeoutMs: number): Promise<number> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout after ${timeoutMs} ms`);
    await sleep(20);
  }
  return Date.now() - t0;
}

function record(index: number): InstanceRecord {
  return {
    index,
    name: `CLI-${index}`,
    avdName: `avdm_${index}`,
    image: 'system-images;android-35;default;arm64-v8a',
    spec: { ...DEFAULT_SPEC, extraArgs: [] },
    createdAt: new Date().toISOString(),
    autoRestart: false,
  };
}

/**
 * The desktop main process must notice what the `avdm` CLI changes on disk well before the renderer's
 * 15 s safety poll: the CLI is simulated here by writing through core's Registry / saveSettings from
 * "outside" the ManagerHost's manager, exactly like another process would.
 */
describe('ManagerHost watches CLI changes', () => {
  let work: string;
  let host: ManagerHost;
  let win: BrowserWindow;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), 'avdm-host-'));
    for (const k of ['AVDM_HOME', 'AVDM_DISCOVERY_DIR', 'ANDROID_HOME', 'ANDROID_SDK_ROOT']) saved[k] = process.env[k];
    process.env['AVDM_HOME'] = join(work, 'home');
    process.env['AVDM_DISCOVERY_DIR'] = join(work, 'running');
    process.env['ANDROID_HOME'] = join(work, 'sdk');
    process.env['ANDROID_SDK_ROOT'] = join(work, 'sdk');
    win = new BrowserWindow();
    host = new ManagerHost();
    await host.get();
    await sleep(300); // watchers take their initial snapshot
  });

  afterAll(async () => {
    await host.dispose();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(work, { recursive: true, force: true });
  });

  it('`avdm create` / `avdm rm` → instances-changed within ~1 s', async () => {
    const registry = new Registry(resolvePaths(join(work, 'home')));
    const before = win.webContents.events('instances-changed').length;
    await registry.allocate(2, record);
    const ms = await waitFor(() => win.webContents.events('instances-changed').length > before, 3000);
    expect(ms).toBeLessThan(3000);
    await waitFor(() => host.statuses.has(0) && host.statuses.has(1), 3000);
    expect(host.specs.get(1)).toEqual({ width: DEFAULT_SPEC.width, height: DEFAULT_SPEC.height });

    const mid = win.webContents.events('instances-changed').length;
    await registry.remove(1);
    await waitFor(() => win.webContents.events('instances-changed').length > mid, 3000);
    await waitFor(() => !host.statuses.has(1), 3000);
    expect(host.statuses.has(0)).toBe(true);
  });

  it('`avdm settings set` → manager reloads promptly and settings-changed is broadcast', async () => {
    const manager = await host.get();
    expect(manager.getSettings().maxRunning).not.toBe(12);
    const before = win.webContents.events('settings-changed').length;
    await saveSettings(resolvePaths(join(work, 'home')), { maxRunning: 12 });
    await waitFor(() => win.webContents.events('settings-changed').length > before, 3000);
    // The broadcast comes after the manager picked the change up (not at its next 5 s health tick).
    expect(manager.getSettings().maxRunning).toBe(12);
  });
});
