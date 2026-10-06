import type { AdbDevice } from './adb.js';
import { AvdmError } from './errors.js';

/**
 * ANGLE feature overrides for guests that render GLES through ANGLE on the guest Vulkan driver (`-feature GuestAngle`,
 * which makes the guest report `ro.hardware.egl=angle`).
 *
 * supportsSwapchainMaintenance1 (verified 2026-09-25, emulator 37.1.11 + android-35 arm64 on an M4): with it ANGLE hands
 * a present fence to every vkQueuePresentKHR and libvulkan imports that frame's sync fd into it. gfxstream's guest driver
 * (vulkan.ranchu.so) keeps the fd but answers vkGetFenceStatus from the host, which never saw it, so the fence never reads
 * signalled and ANGLE never recycles it: one sync_file fd leaks per frame. A 30 fps game reaches RLIMIT_NOFILE (32768)
 * in about 18 minutes, then exits by itself or freezes (SurfaceFlinger's buffer release can no longer be received).
 * Turning the feature off also removes the vkWaitForFences-on-sync-fd path behind the gfxstream WaitGroup livelock.
 * Without the extension ANGLE takes its ordinary present path (the one every pre-Android-14 device uses).
 *
 * The emulator's own channel (host env ANGLE_FEATURE_OVERRIDES_DISABLED → ro.boot.hardware.angle_feature_overrides_disabled)
 * is not read by this guest, and `-prop` cannot carry the name (at most 32 characters), so the manager sets the property
 * after boot and keeps it in /data/local.prop for the next ones.
 */
export const ANGLE_OVERRIDES_DISABLED_PROP = 'debug.angle.feature_overrides_disabled';
export const ANGLE_DISABLED_FEATURES: readonly string[] = ['supportsSwapchainMaintenance1'];
/** Loaded by init before zygote starts on debuggable (userdebug / eng) images: later boots start with the override. */
export const LOCAL_PROP_FILE = '/data/local.prop';

/** PROP_VALUE_MAX (92) minus the terminator. */
const MAX_PROP_VALUE = 91;
/** ANGLE feature names, optionally ending in its `*` wildcard; anything else is dropped from the list. */
const FEATURE_NAME = /^[A-Za-z0-9_]+\*?$/;

export type AngleOverrideResult =
  /** The guest does not render GLES through ANGLE (translator, software GPU): nothing to do. */
  | { state: 'not-angle'; egl: string }
  /** The property already lists every feature (set by /data/local.prop at boot, or restored with a Quick Boot snapshot). */
  | { state: 'ok'; value: string }
  /** Set now for apps started from here on; `persisted` = /data/local.prop now carries it for the next boots. */
  | { state: 'applied'; value: string; persisted: boolean };

/**
 * Add `required` features to an ANGLE override list (`:`-separated, as ANGLE splits it). The guest's own entries stay;
 * names compare like ANGLE matches them (case and underscores ignored); entries that are not feature names are dropped.
 */
export function mergeAngleFeatureList(current: string, required: readonly string[]): string {
  const key = (name: string) => name.toLowerCase().replace(/_/g, '');
  const list = current.split(':').map((entry) => entry.trim()).filter((entry) => FEATURE_NAME.test(entry));
  const have = new Set(list.map(key));
  for (const name of required) {
    if (have.has(key(name))) continue;
    list.push(name);
    have.add(key(name));
  }
  return list.join(':');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Shell script (run as root) that sets `name=value` in `file`, keeping the file's other lines, and prints AVDM_OK once
 * the line reads back. init skips a group- or world-writable file ("Skipping insecure file"), hence 644, written aside
 * and renamed into place. `name` and `value` must not contain a single quote (property names and feature lists do not).
 */
export function localPropScript(name: string, value: string, file = LOCAL_PROP_FILE): string {
  const line = `${name}=${value}`;
  const tmp = `${file}.avdm-tmp`;
  return (
    `{ grep -v '^${name.replace(/\./g, '[.]')}=' ${file} 2>/dev/null; echo '${line}'; } > ${tmp}` +
    ` && chmod 644 ${tmp} && mv -f ${tmp} ${file} && grep -qxF '${line}' ${file} && echo AVDM_OK`
  );
}

/** `script` as root: as is when adbd already runs as root (`id -u` = 0), else through the image's `su` (userdebug). */
export function asRootCommand(script: string, uid: string): string {
  return uid.trim() === '0' ? script : `su 0 sh -c ${shellQuote(script)}`;
}

/**
 * Keep `name=value` in /data/local.prop for the next boots. Best effort: false when the file could not be written or
 * read back (e.g. a user build without `su`, whose init would not load the file anyway).
 */
async function persistLocalProp(device: AdbDevice, name: string, value: string): Promise<boolean> {
  try {
    const uid = await device.shell('id -u', { timeoutMs: 10_000 });
    return (await device.shell(asRootCommand(localPropScript(name, value), uid), { timeoutMs: 15_000 })).includes('AVDM_OK');
  } catch {
    return false;
  }
}

/**
 * Turn off the ANGLE features in ANGLE_DISABLED_FEATURES on a booted guest. Idempotent and cheap once applied (two
 * getprops). The property only reaches apps started after it (ANGLE reads it when a process sets up EGL), so this belongs
 * right after boot, before the game starts; processes already running (SystemUI, the launcher) keep the old behaviour
 * until they restart. @throws AvdmError when the property cannot be set.
 */
export async function ensureAngleOverrides(device: AdbDevice): Promise<AngleOverrideResult> {
  const egl = await device.getprop('ro.hardware.egl');
  if (egl !== 'angle') return { state: 'not-angle', egl };
  const current = await device.getprop(ANGLE_OVERRIDES_DISABLED_PROP);
  const value = mergeAngleFeatureList(current, ANGLE_DISABLED_FEATURES);
  if (value === current) return { state: 'ok', value };
  if (value.length > MAX_PROP_VALUE) {
    throw new AvdmError('INVALID_ARGUMENT', `${ANGLE_OVERRIDES_DISABLED_PROP} 合并后超过 ${MAX_PROP_VALUE} 个字符：${value}`);
  }
  // This boot first (the game is protected even when the file cannot be written), then the next boots.
  await device.shell(`setprop ${ANGLE_OVERRIDES_DISABLED_PROP} '${value}'`, { timeoutMs: 10_000 });
  const readBack = await device.getprop(ANGLE_OVERRIDES_DISABLED_PROP);
  if (readBack !== value) {
    throw new AvdmError('COMMAND_FAILED', `${ANGLE_OVERRIDES_DISABLED_PROP} 写入后读回不一致：${readBack || '（空）'}`);
  }
  return { state: 'applied', value, persisted: await persistLocalProp(device, ANGLE_OVERRIDES_DISABLED_PROP, value) };
}
