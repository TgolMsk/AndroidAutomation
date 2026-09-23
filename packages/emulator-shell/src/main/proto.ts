import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setEmulatorProtoPath } from '@avdm/core';

export const PROTO_FILE = 'emulator_controller.proto';

const here = dirname(fileURLToPath(import.meta.url));

function resolveFromCorePackage(): string | undefined {
  try {
    return createRequire(import.meta.url).resolve(`@avdm/core/proto/${PROTO_FILE}`);
  } catch {
    return undefined;
  }
}

/**
 * Locate the EmulatorController proto. Core is bundled into the main process, so its own
 * import.meta.url-relative lookup does not apply:
 *  - dev (electron-vite dev): the file inside the @avdm/core package;
 *  - build: the copy placed next to the main bundle (out/main/) by the copy-proto vite plugin.
 */
export function findProtoPath(isDev: boolean): string | undefined {
  const bundled = join(here, PROTO_FILE);
  const fromPackage = [
    resolveFromCorePackage(),
    resolve(process.cwd(), 'packages', 'core', 'proto', PROTO_FILE),
    resolve(process.cwd(), '..', 'core', 'proto', PROTO_FILE),
    resolve(here, '..', '..', '..', 'core', 'proto', PROTO_FILE),
  ];
  const candidates = [process.env['AVDM_PROTO_PATH'], ...(isDev ? [...fromPackage, bundled] : [bundled, ...fromPackage])];
  return candidates.find((p): p is string => !!p && existsSync(p));
}

/** Point core's gRPC client at the proto; failures are logged (live view/thumbnails then fall back to adb). */
export function configureProto(isDev: boolean): string | undefined {
  const protoPath = findProtoPath(isDev);
  if (!protoPath) {
    console.warn(`[avdm] 未找到 ${PROTO_FILE}，gRPC 功能将不可用`);
    return undefined;
  }
  try {
    setEmulatorProtoPath(protoPath);
  } catch (err) {
    console.error('[avdm] 设置 proto 路径失败:', err);
  }
  return protoPath;
}
