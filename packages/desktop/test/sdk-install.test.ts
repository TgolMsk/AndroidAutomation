import { describe, expect, it } from 'vitest';
import type { SdkInstallPlan } from '@avdm/core';
import { SdkInstallTask } from '../src/main/sdk-install';

const plan = (paths: string[]): SdkInstallPlan => ({
  packages: paths.map((path) => ({ path }) as SdkInstallPlan['packages'][number]),
  licenses: {},
  unaccepted: [],
  missing: [],
  totalBytes: 0,
});

/** An install that runs until aborted (like curl downloading), then settles after `cleanupMs`. */
function blockingInstall(log: string[], cleanupMs = 20) {
  return (signal: AbortSignal) =>
    new Promise<void>((_resolve, reject) => {
      log.push('started');
      signal.addEventListener('abort', () => {
        log.push('abort-signal');
        setTimeout(() => {
          log.push('rolled-back');
          reject(new Error('curl terminated'));
        }, cleanupMs);
      });
    });
}

describe('SdkInstallTask', () => {
  it('joins a running install for the same package set and rejects a different one', async () => {
    const task = new SdkInstallTask();
    let finish!: () => void;
    const first = task.run(['emulator', 'platform-tools'], async () => plan(['emulator']), () => new Promise<void>((r) => (finish = r)));
    // Reopened wizard (e.g. after Cmd-R): same set, any order → same promise, no second install.
    let secondStarted = false;
    const joined = task.run(['platform-tools', 'emulator'], async () => plan([]), async () => {
      secondStarted = true;
    });
    expect(joined).toBe(first);
    await expect(task.run(['emulator'], async () => plan([]), async () => undefined)).rejects.toThrow('已有 SDK 安装任务');
    await new Promise((r) => setTimeout(r, 5));
    finish();
    await first;
    expect(secondStarted).toBe(false);
    expect(task.active).toBe(false);
    expect(task.status()).toBeNull();
  });

  it('exposes plan and progress while running so a reopened wizard can show them', async () => {
    const task = new SdkInstallTask();
    let finish!: () => void;
    const p = task.run(['emulator'], async () => plan(['emulator']), () => new Promise<void>((r) => (finish = r)));
    await new Promise((r) => setTimeout(r, 5));
    task.noteProgress({ packagePath: 'emulator', phase: 'download', receivedBytes: 10, totalBytes: 100 });
    const status = task.status();
    expect(status?.packages).toEqual(['emulator']);
    expect(status?.plan.packages.map((x) => x.path)).toEqual(['emulator']);
    expect(status?.progress['emulator']?.receivedBytes).toBe(10);
    expect(status?.cancelling).toBe(false);
    finish();
    await p;
    task.noteProgress({ packagePath: 'emulator', phase: 'done' }); // ignored when idle
    expect(task.status()).toBeNull();
  });

  it('abortAndWait aborts the install and resolves only after it settled (quit path)', async () => {
    const task = new SdkInstallTask();
    const log: string[] = [];
    const running = task.run(['system-images;android-35;default;arm64-v8a'], async () => plan([]), blockingInstall(log, 30));
    await new Promise((r) => setTimeout(r, 5));
    expect(task.status()?.cancelling).toBe(false);
    await task.abortAndWait();
    log.push('quit');
    // The rollback finished before the app would quit.
    expect(log).toEqual(['started', 'abort-signal', 'rolled-back', 'quit']);
    await expect(running).rejects.toThrow('安装已取消');
    expect(task.active).toBe(false);
  });

  it('cancel() makes the joined promise reject with 安装已取消', async () => {
    const task = new SdkInstallTask();
    const log: string[] = [];
    const running = task.run(['emulator'], async () => plan([]), blockingInstall(log, 1));
    await new Promise((r) => setTimeout(r, 5));
    const joined = task.run(['emulator'], async () => plan([]), async () => undefined);
    task.cancel();
    expect(task.status()?.cancelling).toBe(true);
    await expect(joined).rejects.toThrow('安装已取消');
    await expect(running).rejects.toThrow('安装已取消');
  });

  it('abortAndWait is a no-op when nothing runs', async () => {
    await expect(new SdkInstallTask().abortAndWait()).resolves.toBeUndefined();
  });
});
