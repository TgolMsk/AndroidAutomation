import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { AdbDevice } from './adb.js';
import { AvdmError } from './errors.js';
import { atomicWriteFile, withFileLock } from './util/fs.js';
import { sleep } from './util/proc.js';

const USER_DIR = '/data/system/users';
const BACKUP_DIR = '/data/local/tmp/avdm/ssaid-backups';
/** After `start` the settings provider is published a little later than the services `waitFramework` checks. */
const SETTINGS_READY_MS = 30_000;
const SETTINGS_RETRY_MS = 1_000;

function userAndroidId(base: string, userId: number): string {
  return userId === 0 ? base : createHash('sha256').update(`${base}:${userId}`).digest('hex').slice(0, 16);
}

async function waitFramework(device: AdbDevice): Promise<void> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try {
      const status = await device.shell('getprop init.svc.zygote; service check activity; service check wifi', { timeoutMs: 5_000 });
      if (/^running\r?\n/.test(status) && /Service activity: found/.test(status) && /Service wifi: found/.test(status)) return;
    } catch { /* Android is restarting */ }
    await sleep(500);
  }
  throw new AvdmError('BOOT_TIMEOUT', '轮换 Android ID 后，系统服务未能在 45 秒内恢复');
}

/**
 * `settings put` right after a framework restart fails until SettingsProvider is back (seen on API 35: the command
 * fails, the same command a few seconds later succeeds). Retry within SETTINGS_READY_MS instead of failing the whole
 * rotation — a failed rotation used to be retried from scratch, restarting the framework (and the game) again.
 */
async function settingsPut(device: AdbDevice, command: string, readyMs: number, retryMs: number): Promise<void> {
  const deadline = Date.now() + readyMs;
  for (;;) {
    try {
      await device.shell(command, { timeoutMs: 10_000 });
      return;
    } catch (err) {
      if (Date.now() >= deadline) throw err;
      await sleep(retryMs);
    }
  }
}

export interface EnsureAndroidIdOptions {
  /** Tests shrink the settings-provider wait. */
  settingsReadyMs?: number;
  settingsRetryMs?: number;
}

/**
 * Android 8+ derives each app's SSAID from a per-user secret. Rotating the secret changes future
 * app-visible IDs without claiming that every app receives the same value. The secure setting is also
 * changed for shell/system tools. This intentionally runs once per stored token, not on every restart.
 */
export async function ensureAndroidId(device: AdbDevice, token: string, avdDir: string, options: EnsureAndroidIdOptions = {}): Promise<void> {
  const marker = path.join(avdDir, '.avdm-android-id');
  const readyMs = options.settingsReadyMs ?? SETTINGS_READY_MS;
  const retryMs = options.settingsRetryMs ?? SETTINGS_RETRY_MS;
  await withFileLock(`${marker}.lock`, async () => {
    const applied = await fsp.readFile(marker, 'utf8').catch(() => '');
    const current = await device.shell('settings get --user 0 secure android_id', { timeoutMs: 10_000 }).catch(() => '');
    if (current.trim() === token) {
      // Only this function ever writes the token, and only after the SSAID rotation: an earlier attempt rotated and
      // set it but died before the marker. Rotating again would restart the framework — killing the running game —
      // for nothing (it did, every health tick, while the marker stayed missing).
      if (applied.trim() !== token) await atomicWriteFile(marker, `${token}\n`);
      return;
    }

    await device.run(['root'], { timeoutMs: 15_000 });
    await device.run(['wait-for-device'], { timeoutMs: 20_000 });
    const filesText = await device.shell(
      `for file in ${USER_DIR}/*/settings_ssaid.xml; do [ -f "$file" ] && echo "$file"; done; true`,
      { timeoutMs: 10_000 },
    );
    const files = filesText.trim().split(/\r?\n/).filter(Boolean);
    if (files.some((file) => !/^\/data\/system\/users\/\d+\/settings_ssaid\.xml$/.test(file))) {
      throw new AvdmError('COMMAND_FAILED', 'Android ID 状态文件路径异常，已取消轮换');
    }
    const moved: Array<{ original: string; backup: string }> = [];
    if (files.length) {
      await device.shell('stop', { timeoutMs: 15_000 });
      try {
        await device.shell(`mkdir -p ${BACKUP_DIR}`, { timeoutMs: 10_000 });
        for (const original of files) {
          const userId = /\/users\/(\d+)\//.exec(original)![1]!;
          const backup = `${BACKUP_DIR}/user-${userId}-${Date.now()}.xml`;
          await device.shell(`mv ${original} ${backup}`, { timeoutMs: 10_000 });
          moved.push({ original, backup });
        }
      } catch (err) {
        for (const entry of moved.reverse()) {
          await device.shell(`mv ${entry.backup} ${entry.original}`, { timeoutMs: 10_000 }).catch(() => undefined);
        }
        await device.shell('start', { timeoutMs: 15_000 }).catch(() => undefined);
        throw err;
      }
      try {
        await device.shell('start', { timeoutMs: 15_000 });
        await waitFramework(device);
      } catch (err) {
        // A transient ADB failure during start must not leave the guest framework stopped.
        await device.shell('start', { timeoutMs: 15_000 }).catch(() => undefined);
        throw err;
      }
    }

    const usersText = await device.shell(
      `for dir in ${USER_DIR}/[0-9]*; do [ -d "$dir" ] && echo "\${dir##*/}"; done; true`,
      { timeoutMs: 10_000 },
    );
    const users = new Set<number>([0]);
    for (const line of usersText.trim().split(/\r?\n/)) {
      if (/^\d+$/.test(line)) users.add(Number(line));
    }
    for (const userId of users) {
      await settingsPut(device, `settings put --user ${userId} secure android_id ${userAndroidId(token, userId)}`, readyMs, retryMs);
    }
    const verified = await device.shell('settings get --user 0 secure android_id', { timeoutMs: 10_000 });
    if (verified.trim() !== token) throw new AvdmError('COMMAND_FAILED', `Android ID 读回不一致：${verified.trim()}`);
    await atomicWriteFile(marker, `${token}\n`);
  }, { timeoutMs: 120_000, staleMs: 120_000 });
}
