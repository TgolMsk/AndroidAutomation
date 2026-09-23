import type { InstanceSpec } from './types.js';

/** Emulator console ports run 5554..5682 (even), i.e. 64 instances. */
export const CONSOLE_PORT_BASE = 5554;
export const GRPC_PORT_BASE = 8554;
export const MAX_INSTANCES = 64;

/** AVD names we own are always `${AVD_NAME_PREFIX}${index}`. */
export const AVD_NAME_PREFIX = 'avdm_';

/** AOSP (no GMS) Android 15 arm64 — standard android-sdk-license, adb root capable, lighter than Google APIs. */
export const DEFAULT_IMAGE = 'system-images;android-35;default;arm64-v8a';

/** Minimum emulator version: 36.6.11 fixes an HVF memory leak on macOS 26.x. */
export const MIN_EMULATOR_VERSION = '36.6.11';

/** Landscape-native display (most games are landscape; avoids sideways frames). 720/320dpi → 360dp smallest width. */
export const DEFAULT_SPEC: InstanceSpec = {
  cpuCores: 2,
  ramMb: 3072,
  width: 1280,
  height: 720,
  dpi: 320,
  dataPartitionGb: 16,
  gpuMode: 'host',
  glDriver: 'angle',
  headless: true,
  bootMode: 'quick',
  extraArgs: [],
};

export const SDK_REPOSITORY_BASE = 'https://dl.google.com/android/repository/';
export const SDK_REPOSITORY_XML = 'repository2-3.xml';
/** Relative (to SDK_REPOSITORY_BASE) system-image manifests we read, by tag. */
export const SDK_SYSIMG_XMLS: Record<string, string> = {
  default: 'sys-img/android/sys-img2-4.xml',
  google_apis: 'sys-img/google_apis/sys-img2-4.xml',
  google_apis_playstore: 'sys-img/google_apis_playstore/sys-img2-4.xml',
};

/** Packages installed by `avdm sdk install` when none are given. */
export const DEFAULT_SDK_PACKAGES = ['emulator', 'platform-tools', DEFAULT_IMAGE];

export function consolePortFor(index: number): number {
  return CONSOLE_PORT_BASE + index * 2;
}

export function grpcPortFor(index: number): number {
  return GRPC_PORT_BASE + index;
}

export function avdNameFor(index: number): string {
  return `${AVD_NAME_PREFIX}${index}`;
}
