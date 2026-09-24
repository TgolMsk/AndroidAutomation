import { describe, expect, it } from 'vitest';
import { AvdmError } from '@avdm/core';
import { ExecutionGuardError } from '@avdm/automation';
import { deviceFailureReason, forwardedDeviceError, RunnerMessageError, safeErrorMessage, scrubDeviceMessage } from '../src/main/plans/device-errors';

const ADB = '/Users/me/Library/Android/sdk/platform-tools/adb';
const coreError = (args: string, detail: string): AvdmError =>
  new AvdmError('COMMAND_FAILED', `${ADB} -s emulator-5556 ${args} 失败: Command failed: ${ADB} -s emulator-5556 ${args}\n${detail}`);

describe('device error scrubbing (nothing sensitive reaches logs, plans.json or the AI)', () => {
  it('cuts the adb command line, Command failed lines and serials, keeping the device detail', () => {
    expect(scrubDeviceMessage(coreError('shell input tap 10 20', 'error: device offline').message)).toBe('adb 命令失败：error: device offline');
    expect(scrubDeviceMessage('连接 127.0.0.1:5555 与 emulator-5554 都失败了')).toBe('连接 模拟器 与 模拟器 都失败了');
    expect(scrubDeviceMessage(coreError('shell dumpsys window', '').message)).toBe('adb 命令失败');
    expect(scrubDeviceMessage('x'.repeat(400)).length).toBeLessThanOrEqual(301);
  });

  it('keeps messages that are not adb calls as they are (apart from serials)', () => {
    expect(scrubDeviceMessage('实例 #2 截图失败: gRPC 不可用')).toBe('实例 #2 截图失败: gRPC 不可用');
    expect(scrubDeviceMessage('启动应用 com.example.game 失败: Error: No activities found')).toBe('启动应用 com.example.game 失败: Error: No activities found');
  });

  it('text and long press never forward command output, only the length and a classified reason', () => {
    const secret = 'code-9876';
    const text = forwardedDeviceError('text', coreError(`shell input text ${secret}`, `/system/bin/sh: ${secret}: not found`), [secret]);
    expect(text).toBe(`输入文本失败（${secret.length} 字）：设备命令执行失败`);
    const b64 = Buffer.from('验证码', 'utf8').toString('base64');
    const ime = forwardedDeviceError('text', coreError(`shell am broadcast -a ADB_INPUT_B64 --es msg ${b64}`, 'error: closed'), ['验证码']);
    expect(ime).toBe('输入文本失败（3 字）：模拟器连接已断开');
    expect(forwardedDeviceError('longPress', coreError('shell input motionevent DOWN 1 1', 'timed out'), [1, 1, 500])).toBe('长按失败：设备响应超时');
    // core's own input-text rejections are fixed texts without the content.
    expect(forwardedDeviceError('text', new AvdmError('INVALID_ARGUMENT', '文本包含无法输入的控制字符（U+0007）'), ['a\u0007']))
      .toBe('输入文本失败（2 字）：文本包含无法输入的控制字符（U+0007）');
  });

  it('runner-written messages and guard errors pass through; other ops are scrubbed', () => {
    expect(forwardedDeviceError('text', new RunnerMessageError('实例 #1 没有可用的 ADBKeyboard 输入法'), ['你好'])).toBe('实例 #1 没有可用的 ADBKeyboard 输入法');
    expect(forwardedDeviceError('text', new ExecutionGuardError('目标游戏已离开前台'), ['x'])).toBe('目标游戏已离开前台');
    expect(forwardedDeviceError('tap', coreError('shell input tap 1 2', 'error: closed'), [1, 2])).toBe('adb 命令失败：error: closed');
    expect(safeErrorMessage(new Error('设备 emulator-5580 未响应'))).toBe('设备 模拟器 未响应');
  });

  it('classifies failures without echoing them', () => {
    expect(deviceFailureReason(new Error("adb: device 'emulator-5554' not found"))).toBe('模拟器连接已断开');
    expect(deviceFailureReason(new Error('Command failed … killed SIGTERM'))).toBe('设备响应超时');
    expect(deviceFailureReason(new Error('java.lang.NullPointerException'))).toBe('设备命令执行失败');
  });
});
