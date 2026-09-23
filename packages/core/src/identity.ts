import { randomBytes } from 'node:crypto';
import type { AdbDevice } from './adb.js';
import { AvdmError } from './errors.js';
import type { DeviceBuildProfile, DeviceIdentity, DeviceIdentityInput } from './types.js';
import { sleep } from './util/proc.js';

function expand(value: string, index: number): string {
  return value.replaceAll('{indexHex2}', index.toString(16).padStart(2, '0')).replaceAll('{index}', String(index));
}

function randomSerial(): string {
  return randomBytes(6).toString('hex').toUpperCase();
}

function randomMac(): string {
  return `02:${[...randomBytes(5)].map((b) => b.toString(16).padStart(2, '0')).join(':')}`;
}

function randomAndroidId(): string {
  return randomBytes(8).toString('hex');
}

/** Resolve a preset once, when the instance is created or edited. Restarts reuse the stored values. */
export function resolveIdentity(input: DeviceIdentityInput | undefined, index: number): DeviceIdentity | undefined {
  if (input === undefined || input === 'system') return undefined;
  if (input === 'random') {
    return {
      serialNumber: randomSerial(),
      wifiMac: randomMac(),
      androidId: randomAndroidId(),
    };
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AvdmError('INVALID_ARGUMENT', '设备标识需为 system、random 或包含 serialNumber / wifiMac / androidId / build 的模板');
  }
  const raw = input as Record<string, unknown>;
  const unknown = Object.keys(raw).filter((key) => key !== 'serialNumber' && key !== 'wifiMac' && key !== 'androidId' && key !== 'build');
  if (unknown.length) {
    throw new AvdmError('INVALID_ARGUMENT', `当前镜像不支持设置 ${unknown.join('、')}；仅支持 serialNumber、wifiMac、androidId 和 build`);
  }
  const identity: DeviceIdentity = {};
  if (raw.serialNumber !== undefined) {
    if (typeof raw.serialNumber !== 'string') throw new AvdmError('INVALID_ARGUMENT', 'serialNumber 必须是字符串');
    const value = raw.serialNumber === 'random' ? randomSerial() : expand(raw.serialNumber, index);
    if (!/^[A-Za-z0-9._,-]{1,32}$/.test(value)) {
      throw new AvdmError('INVALID_ARGUMENT', '序列号必须为 1–32 位 ASCII 字母、数字或 . _ , -');
    }
    identity.serialNumber = value;
  }
  if (raw.wifiMac !== undefined) {
    if (typeof raw.wifiMac !== 'string') throw new AvdmError('INVALID_ARGUMENT', 'wifiMac 必须是字符串');
    const value = raw.wifiMac === 'random' ? randomMac() : expand(raw.wifiMac, index).toLowerCase();
    if (!/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(value) || (Number.parseInt(value.slice(0, 2), 16) & 1) !== 0) {
      throw new AvdmError('INVALID_ARGUMENT', 'Wi-Fi MAC 必须是单播地址，格式为 02:aa:bb:cc:dd:ee');
    }
    identity.wifiMac = value;
  }
  if (raw.androidId !== undefined) {
    if (typeof raw.androidId !== 'string') throw new AvdmError('INVALID_ARGUMENT', 'androidId 必须是字符串');
    const value = raw.androidId === 'random' ? randomAndroidId() : expand(raw.androidId, index).toLowerCase();
    if (!/^[0-9a-f]{16}$/.test(value)) throw new AvdmError('INVALID_ARGUMENT', 'androidId 必须是 16 位十六进制，或填 random');
    identity.androidId = value;
  }
  if (raw.build !== undefined) identity.build = validateBuildProfile(raw.build);
  if (!identity.serialNumber && !identity.wifiMac && !identity.androidId && !identity.build) {
    throw new AvdmError('INVALID_ARGUMENT', '模板至少需要 serialNumber、wifiMac、androidId 或 build');
  }
  return identity;
}

export function parseBuildFingerprint(value: string): {
  brand: string; product: string; device: string; release: string; buildId: string; incremental: string; type: string; tags: string;
} {
  const match = /^([^/:]+)\/([^/:]+)\/([^/:]+):([^/:]+)\/([^/:]+)\/([^/:]+):([^/:]+)\/([^/:]+)$/.exec(value);
  if (!match) throw new AvdmError('INVALID_ARGUMENT', 'build.fingerprint 格式应为 brand/product/device:version/id/incremental:type/tags');
  return {
    brand: match[1]!, product: match[2]!, device: match[3]!, release: match[4]!,
    buildId: match[5]!, incremental: match[6]!, type: match[7]!, tags: match[8]!,
  };
}

function validateBuildProfile(value: unknown): DeviceBuildProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AvdmError('INVALID_ARGUMENT', 'build 必须包含 brand、manufacturer、model、device、product、fingerprint');
  }
  const raw = value as Record<string, unknown>;
  const keys = ['brand', 'manufacturer', 'model', 'device', 'product', 'fingerprint'] as const;
  const unknown = Object.keys(raw).filter((key) => !keys.includes(key as typeof keys[number]));
  if (unknown.length) throw new AvdmError('INVALID_ARGUMENT', `不支持的 build 字段：${unknown.join('、')}`);
  const out = {} as DeviceBuildProfile;
  for (const key of keys) {
    const field = raw[key];
    if (typeof field !== 'string' || !field || field.length > 160 || /[\u0000-\u001f\u007f]/.test(field)) {
      throw new AvdmError('INVALID_ARGUMENT', `build.${key} 必须是 1–160 字符、无换行的字符串`);
    }
    out[key] = field;
  }
  for (const key of ['brand', 'device', 'product'] as const) {
    if (!/^[A-Za-z0-9._-]+$/.test(out[key])) throw new AvdmError('INVALID_ARGUMENT', `build.${key} 仅允许字母、数字、点、下划线和连字符`);
  }
  const fp = parseBuildFingerprint(out.fingerprint);
  if (fp.brand !== out.brand || fp.product !== out.product || fp.device !== out.device) {
    throw new AvdmError('INVALID_ARGUMENT', 'build.fingerprint 的 brand/product/device 与模板字段不一致');
  }
  if (fp.type !== 'user' || fp.tags !== 'release-keys') {
    throw new AvdmError('INVALID_ARGUMENT', '真机模板的 build.fingerprint 需使用 user/release-keys 构建');
  }
  return out;
}

/** The stock AOSP emulator permits this via root ADB, but the interface resets after a guest reboot. */
export async function ensureWifiMac(device: AdbDevice, expected: string): Promise<void> {
  const read = async () => (await device.shell('cat /sys/class/net/wlan0/address', { timeoutMs: 10_000 })).trim().toLowerCase();
  try {
    if ((await read()) === expected) return;
  } catch {
    // An unprivileged adbd can expose wlan0 only after `adb root` on this image.
  }
  try {
    await device.run(['root'], { timeoutMs: 15_000 });
    await device.run(['wait-for-device'], { timeoutMs: 20_000 });
    if ((await read()) === expected) return;
    await device.shell('ip link set dev wlan0 down', { timeoutMs: 10_000 });
    await device.shell(`ip link set dev wlan0 address ${expected}`, { timeoutMs: 10_000 });
    await device.shell('ip link set dev wlan0 up', { timeoutMs: 10_000 });
    // Right after a Zygote restart, the Wi-Fi service may be registered but not yet ready for `svc`.
    // The kernel address is authoritative; reconnect Wi-Fi when the service accepts the request.
    let disabled = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await device.shell('svc wifi disable', { timeoutMs: 10_000 });
        disabled = true;
        break;
      } catch {
        await sleep(1000);
      }
    }
    if (disabled) {
      let enabled = false;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          await device.shell('svc wifi enable', { timeoutMs: 10_000 });
          enabled = true;
          break;
        } catch {
          await sleep(1000);
        }
      }
      if (!enabled) throw new Error('Wi-Fi 服务已关闭，但重新开启失败');
    }
    const actual = await read();
    if (actual !== expected) throw new Error(`读回 ${actual}`);
  } catch (cause) {
    throw new AvdmError('COMMAND_FAILED', `Wi-Fi MAC 设置失败：当前镜像需支持 adb root 和 wlan0；${String(cause)}`);
  }
}
