import type { AdbDevice } from '@avdm/core';
import type { AccountLoginCommand, LoginScreen } from './types';

/**
 * An error whose message was written here and is safe to show. Anything else raised while driving the login UI
 * (core adb errors carry the full argv, e.g. `input text <phone>`) is replaced by a fixed message upstream.
 */
export class LoginUserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoginUserError';
  }
}

const DIGITS_FAILED = '登录数字输入失败，请检查设备连接后重试。';

export interface NativeNode {
  id: string;
  text: string;
  hint: string;
  className: string;
  checked: boolean;
  enabled: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
}

function decodeXml(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|quot|apos|lt|gt|amp);/gi, (part, key: string) => {
    const entities: Record<string, string> = { quot: '"', apos: "'", lt: '<', gt: '>', amp: '&' };
    if (key[0] !== '#') return entities[key.toLowerCase()] ?? part;
    const radix = key[1]?.toLowerCase() === 'x' ? 16 : 10;
    const number = Number.parseInt(key.slice(radix === 16 ? 2 : 1), radix);
    return Number.isInteger(number) && number >= 0 && number <= 0x10ffff ? String.fromCodePoint(number) : part;
  });
}

/** Parse only UIAutomator node attributes. No XML entities, DTDs, or external references are loaded. */
export function parseNativeUi(xml: string, packageName: string): NativeNode[] {
  const nodes: NativeNode[] = [];
  if (xml.length > 2_000_000) throw new LoginUserError('登录界面树过大');
  for (const match of xml.matchAll(/<node\s+([^>]+?)\s*\/?>/g)) {
    const attrs = Object.fromEntries([...match[1]!.matchAll(/([\w-]+)="([^"]*)"/g)]
      .map((item) => [item[1]!, decodeXml(item[2]!) ]));
    if (attrs.package !== packageName) continue;
    const bounds = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(attrs.bounds ?? '');
    if (!bounds) continue;
    const x1 = Number(bounds[1]); const y1 = Number(bounds[2]);
    const x2 = Number(bounds[3]); const y2 = Number(bounds[4]);
    if (x2 <= x1 || y2 <= y1) continue;
    nodes.push({
      id: attrs['resource-id'] ?? '', text: attrs.text ?? '', hint: attrs.hint ?? '',
      className: attrs.class ?? '', checked: attrs.checked === 'true', enabled: attrs.enabled === 'true',
      x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2), width: x2 - x1, height: y2 - y1,
    });
  }
  return nodes;
}

export function byId(nodes: NativeNode[], packageName: string, id: string): NativeNode | undefined {
  const matches = nodes.filter((node) => node.id === `${packageName}:id/${id}` && node.enabled);
  return matches.length === 1 ? matches[0] : undefined;
}

export function loginScreen(nodes: NativeNode[], packageName: string): LoginScreen {
  if (byId(nodes, packageName, 'phoneEditText')) return { step: 'phone', message: '请输入手机号并发送验证码。' };
  if (byId(nodes, packageName, 'digitsInput')) {
    const raw = byId(nodes, packageName, 'messageText')?.text ?? '';
    const phone = /1\d{10}/.exec(raw)?.[0];
    const seconds = /^(\d+)\s*秒/.exec(byId(nodes, packageName, 'resendButton')?.text ?? '')?.[1];
    return {
      step: 'code', phoneMasked: phone ? `${phone.slice(0, 3)}****${phone.slice(-4)}` : undefined,
      retryAt: seconds ? Date.now() + Number(seconds) * 1000 : undefined,
      message: '输入收到的 6 位验证码。填满后游戏会自动校验。',
    };
  }
  if (byId(nodes, packageName, 'unitySurfaceView')) return {
    step: 'game', message: '登录窗口已关闭。请等待游戏加载，选择服务器和角色。',
  };
  return { step: 'manual', message: '当前界面没有已校准的登录控件，请在实时画面中手动处理。' };
}

export async function readLoginUi(device: Pick<AdbDevice, 'foregroundPackage' | 'shell'>, packageName: string): Promise<NativeNode[]> {
  let foreground: string | undefined;
  try { foreground = await device.foregroundPackage(); }
  catch { throw new LoginUserError('无法读取前台应用，请检查实例连接后重试'); }
  if (foreground !== packageName) throw new LoginUserError('请先让游戏显示在前台');
  const remote = '/sdcard/avdm-login-ui.xml';
  try {
    await device.shell(`rm -f ${remote}`, { timeoutMs: 5000 });
    const output = await device.shell(`uiautomator dump ${remote}; cat ${remote}`, { timeoutMs: 20_000 });
    if (!output.includes('<hierarchy')) throw new Error('UIAutomator 没有返回界面树');
    return parseNativeUi(output, packageName);
  } catch {
    throw new LoginUserError('当前登录页面暂时无法识别，请等待画面稳定或在下方画面中手动操作');
  } finally {
    await device.shell(`rm -f ${remote}`, { timeoutMs: 5000 }).catch(() => undefined);
  }
}

export interface LoginInputDevice {
  foregroundPackage(): Promise<string | undefined>;
  shell(command: string, opts?: { timeoutMs?: number }): Promise<string>;
  tap(x: number, y: number): Promise<void>;
  keyevent(code: number | string): Promise<void>;
  text(value: string): Promise<void>;
}

/**
 * Type a phone number or SMS code with Android's own `input text` (no third-party IME). ★ The digits are in the
 * adb argv, and core's COMMAND_FAILED message quotes the argv: never let that error escape.
 */
export async function inputLoginDigits(device: Pick<LoginInputDevice, 'text'>, value: string): Promise<void> {
  if (!/^\d{1,32}$/.test(value)) throw new LoginUserError('登录输入仅支持数字手机号或验证码');
  try { await device.text(value); }
  catch { throw new LoginUserError(DIGITS_FAILED); }
}

async function fillDigits(device: LoginInputDevice, node: NativeNode, value: string, signal: AbortSignal): Promise<void> {
  if (!/^\d{1,32}$/.test(value)) throw new LoginUserError('登录输入仅支持数字');
  signal.throwIfAborted();
  try {
    await device.tap(node.x, node.y);
    // MOVE_END plus enough DEL clears only the field that was just identified and tapped.
    await device.shell(`input keyevent KEYCODE_MOVE_END ${Array(32).fill('KEYCODE_DEL').join(' ')}`, { timeoutMs: 10_000 });
  } catch { throw new LoginUserError(DIGITS_FAILED); }
  signal.throwIfAborted();
  await inputLoginDigits(device, value);
  signal.throwIfAborted();
}

/** Wanlong's native SDK controls. Each write is preceded by a fresh UI tree; unknown layouts fail closed. */
export async function executeWanlongLoginCommand(
  device: LoginInputDevice, packageName: string, command: AccountLoginCommand, signal: AbortSignal,
  read: typeof readLoginUi = readLoginUi,
): Promise<LoginScreen> {
  signal.throwIfAborted();
  let nodes = await read(device, packageName);
  signal.throwIfAborted();
  if (command.action === 'inspect') return loginScreen(nodes, packageName);
  if (command.action === 'requestSms') {
    if (!/^1[3-9]\d{9}$/.test(command.phone) || command.agreementAccepted !== true) {
      throw new LoginUserError('请填写有效手机号，并确认已阅读游戏用户协议及隐私条款');
    }
    const field = byId(nodes, packageName, 'phoneEditText');
    if (!field) throw new LoginUserError('当前不是已校准的手机号登录页面，请刷新登录步骤');
    await fillDigits(device, field, command.phone, signal);
    await device.keyevent('BACK');
    signal.throwIfAborted();
    nodes = await read(device, packageName);
    if (byId(nodes, packageName, 'phoneEditText')?.text.replace(/\D/g, '') !== command.phone) {
      throw new LoginUserError('手机号未完整填入，请刷新登录步骤后重试');
    }
    const agreement = byId(nodes, packageName, 'agreementCheckBox');
    if (!agreement) throw new LoginUserError('未找到游戏协议控件，请在下方画面中检查');
    if (!agreement.checked) {
      await device.tap(agreement.x, agreement.y);
      nodes = await read(device, packageName);
      signal.throwIfAborted();
    }
    if (!byId(nodes, packageName, 'agreementCheckBox')?.checked) throw new LoginUserError('游戏协议未确认');
    const submit = byId(nodes, packageName, 'submitButton');
    if (!submit || submit.text !== '登录') throw new LoginUserError('未识别到登录按钮，请刷新登录步骤');
    await device.tap(submit.x, submit.y);
  } else if (command.action === 'submitCode') {
    if (!/^\d{6}$/.test(command.code)) throw new LoginUserError('验证码应为 6 位数字');
    const input = byId(nodes, packageName, 'digitsInput');
    if (!input) throw new LoginUserError('当前不是已校准的验证码页面，请刷新登录步骤');
    await fillDigits(device, { ...input, x: Math.round(input.x - input.width / 2 + input.width / 12) }, command.code, signal);
  } else {
    if (!byId(nodes, packageName, 'digitsInput')) throw new LoginUserError('当前不是已校准的验证码页面');
    const resend = byId(nodes, packageName, 'resendButton');
    if (!resend || /^\s*\d+\s*秒/.test(resend.text) || !/^(重新发送|重新获取|重发)(验证码)?$/.test(resend.text.trim())) {
      throw new LoginUserError('请等待短信倒计时结束后再重新发送');
    }
    await device.tap(resend.x, resend.y);
  }
  signal.throwIfAborted();
  nodes = await read(device, packageName);
  return loginScreen(nodes, packageName);
}
