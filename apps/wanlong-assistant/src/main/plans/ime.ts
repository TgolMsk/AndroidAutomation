import { lstat } from 'node:fs/promises';
import path from 'node:path';
import type { ImeStatus, ScriptDevice } from './types';

/**
 * ADBKeyboard: the only way to type non-ASCII (Chinese) text — `adb shell input text` cannot (original rule:
 * 中文必须走 ADBKeyboard 的 base64 broadcast). The APK is never bundled: the user picks their own file.
 */
export const ADB_KEYBOARD_PACKAGE = 'com.android.adbkeyboard';
export const ADB_KEYBOARD_IME = 'com.android.adbkeyboard/.AdbIME';
const MAX_APK_BYTES = 200 * 1024 * 1024;
// eslint-disable-next-line no-control-regex
const NON_ASCII = /[^\x00-\x7F]/;

export function needsUnicodeInput(text: string): boolean {
  return NON_ASCII.test(text);
}

/** `am broadcast` that makes ADBKeyboard commit `text` (base64 keeps the shell argument ASCII-only). */
export function imeBroadcastCommand(text: string): string {
  return `am broadcast -a ADB_INPUT_B64 --es msg ${Buffer.from(text, 'utf8').toString('base64')}`;
}

type ImeDevice = Pick<ScriptDevice, 'shell'>;

export async function readImeStatus(device: ImeDevice, index: number): Promise<ImeStatus> {
  const packages = await device.shell(`pm list packages ${ADB_KEYBOARD_PACKAGE}`, { timeoutMs: 15_000 });
  const installed = packages.split(/\r?\n/).some((line) => line.trim() === `package:${ADB_KEYBOARD_PACKAGE}`);
  const enabledList = installed ? await device.shell('ime list -s', { timeoutMs: 15_000 }) : '';
  const enabled = enabledList.split(/\r?\n/).some((line) => line.trim() === ADB_KEYBOARD_IME);
  const current = installed ? (await device.shell('settings get secure default_input_method', { timeoutMs: 15_000 })).trim() : '';
  const selected = current === ADB_KEYBOARD_IME;
  const available = installed && enabled && selected;
  const message = available
    ? 'ADBKeyboard 已安装并启用，脚本可以输入中文。'
    : !installed ? '未安装 ADBKeyboard：脚本只能输入英文、数字和符号。点「安装输入法」选择 ADBKeyboard 的 APK 即可。'
      : !enabled ? 'ADBKeyboard 已安装但未启用，点「安装输入法」重新启用。'
        : 'ADBKeyboard 已启用但不是当前输入法，点「安装输入法」把它设为当前输入法。';
  return { index, installed, enabled, selected, available, message };
}

/** A user-picked APK path: absolute, a regular `.apk` file, not a symlink, bounded size. */
export async function checkedApkPath(file: string): Promise<string> {
  if (typeof file !== 'string' || !path.isAbsolute(file) || !/\.apk$/i.test(file)) throw new Error('请选择 ADBKeyboard 的 .apk 安装包');
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size === 0 || info.size > MAX_APK_BYTES) throw new Error('所选文件不是有效的 APK（为空、过大或是链接）');
  return file;
}

/** Install the APK, then enable ADBKeyboard and make it the current input method (original device:setupIme). */
export async function setupIme(device: ImeDevice & Pick<ScriptDevice, 'install'>, index: number, apkPath: string): Promise<ImeStatus> {
  const apk = await checkedApkPath(apkPath);
  if (!device.install) throw new Error('当前设备接口不支持安装 APK');
  await device.install([apk], { timeoutMs: 5 * 60_000 });
  const after = await device.shell(`pm list packages ${ADB_KEYBOARD_PACKAGE}`, { timeoutMs: 15_000 });
  if (!after.includes(`package:${ADB_KEYBOARD_PACKAGE}`)) {
    throw new Error(`安装完成，但设备上没有 ${ADB_KEYBOARD_PACKAGE}。请确认选择的是 ADBKeyboard 的安装包。`);
  }
  await device.shell(`ime enable ${ADB_KEYBOARD_IME}`, { timeoutMs: 15_000 });
  await device.shell(`ime set ${ADB_KEYBOARD_IME}`, { timeoutMs: 15_000 });
  const status = await readImeStatus(device, index);
  if (!status.available) throw new Error(`已安装 ADBKeyboard，但未能启用：${status.message}`);
  return status;
}
