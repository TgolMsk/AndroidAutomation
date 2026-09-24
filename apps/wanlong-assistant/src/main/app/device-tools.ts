import { stat } from 'node:fs/promises';
import path from 'node:path';

/** Package files `adb install` / `install-multiple` accepts (the same filter as the shell's APK picker). */
const APK_RE = /\.(apk|apks|xapk)$/i;
export const MAX_APK_FILES = 16;

/** The part of the (lane-wrapped) manager host device tools use. */
export interface DeviceToolsHost {
  get(): Promise<{
    getState(index: number): Promise<{ status: string }>;
    device(index: number): Promise<{ install(apkPaths: string[]): Promise<string> }>;
  }>;
}

/**
 * The settings page's 设备工具 (original `device:installApk`): install packages the user picked on one running
 * instance. The host is the DeviceLane-wrapped one, so the install queues behind other adb work on that instance
 * instead of interleaving with a gather or script (the original enqueued it on the device's serial queue).
 */
export class DeviceTools {
  constructor(private readonly host: DeviceToolsHost) {}

  /** Several files are one split app (`adb install-multiple`); returns adb's output. */
  async installApk(index: number, apkPaths: readonly string[]): Promise<string> {
    if (apkPaths.length === 0) throw new Error('请先选择要安装的 APK 文件');
    if (apkPaths.length > MAX_APK_FILES) throw new Error(`一次最多安装 ${MAX_APK_FILES} 个文件`);
    const files: string[] = [];
    for (const file of apkPaths) {
      if (!path.isAbsolute(file) || !APK_RE.test(file)) throw new Error(`不是可安装的 APK 文件：${file}`);
      const info = await stat(file).catch(() => null);
      if (!info?.isFile()) throw new Error(`找不到安装包文件：${file}`);
      files.push(file);
    }
    const manager = await this.host.get();
    const state = await manager.getState(index);
    if (state.status !== 'running') throw new Error(`实例 #${index} 尚未就绪，请先启动并等待 Android 启动完成`);
    return (await manager.device(index)).install(files);
  }
}
