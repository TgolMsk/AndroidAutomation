import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { AdbDevice } from './adb.js';
import { AvdmError } from './errors.js';
import { parseBuildFingerprint } from './identity.js';
import { httpDownload } from './sdk/http.js';
import type { DeviceBuildProfile } from './types.js';
import { atomicWriteFile, ensureDir, withFileLock } from './util/fs.js';
import { execFileBuffer, sleep } from './util/proc.js';

// Download only when a build profile is enabled. The binary is extracted from the official Magisk APK;
// it is not redistributed with avdm. Pinned hashes prevent a changed release asset from being executed.
const MAGISK_VERSION = '30.6';
const MAGISK_URL = `https://github.com/topjohnwu/Magisk/releases/download/v${MAGISK_VERSION}/Magisk-v${MAGISK_VERSION}.apk`;
const APK_SHA256 = 'f1ffc3c9a5614c251ba6bada308163acc3c3d844cf01d33f55a8bc151adc34ce';
const BINARY_SHA256 = '70558e6d6199fa5a961b7bafeb8f96d8157cc63810db8df2a3cded1881763697';
const GUEST_DIR = '/data/local/tmp/avdm';
const GUEST_TOOL = `${GUEST_DIR}/magisk`;
const GUEST_PROFILE = `${GUEST_DIR}/build.prop`;

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

async function digestFile(file: string): Promise<string | undefined> {
  try {
    return sha256(await fsp.readFile(file));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

/** Cache an arm64 resetprop executable without storing an unverified download as executable. */
export async function ensureResetpropTool(cacheDir: string): Promise<string> {
  const dir = path.join(cacheDir, 'tools');
  const tool = path.join(dir, `resetprop-magisk-v${MAGISK_VERSION}-arm64`);
  await ensureDir(dir);
  if (process.env.AVDM_RESETPROP_BIN) {
    const supplied = path.resolve(process.env.AVDM_RESETPROP_BIN);
    if (!(await fsp.stat(supplied).catch(() => undefined))?.isFile()) {
      throw new AvdmError('INVALID_ARGUMENT', `AVDM_RESETPROP_BIN 文件不存在：${supplied}`);
    }
    return supplied;
  }
  if ((await digestFile(tool)) === BINARY_SHA256) return tool;
  return withFileLock(`${tool}.lock`, async () => {
    if ((await digestFile(tool)) === BINARY_SHA256) return tool;
    const apk = path.join(dir, `Magisk-v${MAGISK_VERSION}.apk`);
    if ((await digestFile(apk)) !== APK_SHA256) {
      await fsp.rm(apk, { force: true });
      await httpDownload(MAGISK_URL, apk);
      if ((await digestFile(apk)) !== APK_SHA256) {
        await fsp.rm(apk, { force: true });
        throw new AvdmError('CHECKSUM_MISMATCH', `Magisk v${MAGISK_VERSION} 下载文件校验失败`);
      }
    }
    const binary = await execFileBuffer(process.platform === 'darwin' ? '/usr/bin/unzip' : 'unzip', [
      '-p', apk, 'lib/arm64-v8a/libmagisk.so',
    ], { timeoutMs: 30_000, maxBuffer: 4 * 1024 * 1024 });
    if (sha256(binary) !== BINARY_SHA256) throw new AvdmError('CHECKSUM_MISMATCH', 'resetprop 二进制校验失败');
    await atomicWriteFile(tool, binary);
    await fsp.chmod(tool, 0o700);
    return tool;
  }, { timeoutMs: 180_000, staleMs: 180_000 });
}

function expectedTopLevel(profile: DeviceBuildProfile): Record<string, string> {
  const fp = parseBuildFingerprint(profile.fingerprint);
  return {
    'ro.product.brand': profile.brand,
    'ro.product.manufacturer': profile.manufacturer,
    'ro.product.model': profile.model,
    'ro.product.device': profile.device,
    'ro.product.name': profile.product,
    'ro.build.fingerprint': profile.fingerprint,
    'ro.build.id': fp.buildId,
    'ro.build.version.incremental': fp.incremental,
    'ro.build.type': fp.type,
    'ro.build.tags': fp.tags,
    'ro.build.display.id': fp.buildId,
    'ro.build.product': profile.device,
    'ro.build.flavor': `${profile.device}-${fp.type}`,
    'ro.build.description': `${profile.device}-${fp.type} ${fp.release} ${fp.buildId} ${fp.incremental} ${fp.tags}`,
  };
}

/** Include existing partition-specific properties so direct property readers see a consistent model. */
export function buildPropertyFile(profile: DeviceBuildProfile, currentProperties: string): string {
  const values = expectedTopLevel(profile);
  const fp = parseBuildFingerprint(profile.fingerprint);
  const exists = new Set([...currentProperties.matchAll(/^\[([^\]]+)\]: \[[^\]]*\]$/gm)].map((m) => m[1]!));
  for (const partition of ['system', 'system_ext', 'vendor', 'odm', 'product', 'bootimage']) {
    for (const field of ['brand', 'manufacturer', 'model', 'device', 'name'] as const) {
      const key = `ro.product.${partition}.${field}`;
      if (exists.has(key)) values[key] = field === 'name' ? profile.product : profile[field];
    }
    for (const [field, value] of [
      ['fingerprint', profile.fingerprint], ['id', fp.buildId], ['version.incremental', fp.incremental],
      ['type', fp.type], ['tags', fp.tags],
    ] as const) {
      const key = `ro.${partition}.build.${field}`;
      if (exists.has(key)) values[key] = value;
    }
  }
  return Object.entries(values).map(([name, value]) => `${name}=${value}`).join('\n') + '\n';
}

/** Apply before opening apps; Build.* is preloaded in Zygote, so the runtime must be restarted once. */
export async function ensureBuildProfile(device: AdbDevice, profile: DeviceBuildProfile, cacheDir: string): Promise<void> {
  const expected = expectedTopLevel(profile);
  const check = async () => {
    const names = ['ro.product.brand', 'ro.product.manufacturer', 'ro.product.model', 'ro.product.device',
      'ro.product.name', 'ro.build.fingerprint'];
    const result = await device.shell(names.map((name) => `getprop ${name}`).join('; '), { timeoutMs: 10_000 });
    return result.trimEnd().split(/\r?\n/).every((value, i) => value === expected[names[i]!]) && result.trimEnd().split(/\r?\n/).length === names.length;
  };
  if (await check()) return;
  const guestRelease = await device.getprop('ro.build.version.release');
  const requestedRelease = parseBuildFingerprint(profile.fingerprint).release;
  if (guestRelease !== requestedRelease) {
    throw new AvdmError('INVALID_ARGUMENT', `构建指纹为 Android ${requestedRelease}，但实例镜像为 Android ${guestRelease}；请选择同版本模板`);
  }
  await device.run(['root'], { timeoutMs: 15_000 });
  await device.run(['wait-for-device'], { timeoutMs: 20_000 });
  const tool = await ensureResetpropTool(cacheDir);
  const props = buildPropertyFile(profile, await device.shell('getprop', { timeoutMs: 10_000 }));
  const profileFile = path.join(cacheDir, 'tools', `profile-${sha256(Buffer.from(props))}.prop`);
  await atomicWriteFile(profileFile, props);
  await fsp.chmod(profileFile, 0o600);
  await device.shell(`mkdir -p ${GUEST_DIR}`, { timeoutMs: 10_000 });
  await device.run(['push', tool, GUEST_TOOL], { timeoutMs: 30_000 });
  await device.run(['push', profileFile, GUEST_PROFILE], { timeoutMs: 30_000 });
  await device.shell(`chmod 700 ${GUEST_TOOL}; chmod 600 ${GUEST_PROFILE}; ${GUEST_TOOL} resetprop -n --file ${GUEST_PROFILE}`, { timeoutMs: 20_000 });
  if (!(await check())) throw new AvdmError('COMMAND_FAILED', '构建属性写入后读回不一致');
  await device.shell('setprop ctl.restart zygote', { timeoutMs: 10_000 });
  const deadline = Date.now() + 35_000;
  while (Date.now() < deadline) {
    try {
      const status = await device.shell('getprop init.svc.zygote; service check activity; service check wifi', { timeoutMs: 5_000 });
      if (/^running\r?\n/.test(status) && /Service activity: found/.test(status) && /Service wifi: found/.test(status)) return;
    } catch { /* services are briefly unavailable while Zygote restarts */ }
    await sleep(500);
  }
  throw new AvdmError('BOOT_TIMEOUT', '构建属性已修改，但 Android 应用运行时未能在 35 秒内恢复');
}
