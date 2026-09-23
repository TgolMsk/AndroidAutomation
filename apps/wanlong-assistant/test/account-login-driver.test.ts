import { describe, expect, it, vi } from 'vitest';
import { byId, executeWanlongLoginCommand, loginScreen, parseNativeUi,
  type LoginInputDevice, type NativeNode } from '../src/main/automation/accounts/native-ui';

const pkg = 'com.lilithgames.samo.android.cn';
const node = (id: string, overrides: Partial<NativeNode> = {}): NativeNode => ({
  id: `${pkg}:id/${id}`, text: '', hint: '', className: 'android.widget.TextView', checked: false,
  enabled: true, x: 100, y: 100, width: 120, height: 40, ...overrides,
});

function device() {
  return {
    foregroundPackage: vi.fn().mockResolvedValue(pkg),
    shell: vi.fn().mockResolvedValue(''),
    tap: vi.fn().mockResolvedValue(undefined),
    keyevent: vi.fn().mockResolvedValue(undefined),
    text: vi.fn().mockResolvedValue(undefined),
  } satisfies LoginInputDevice;
}

describe('Wanlong native login controls', () => {
  it('parses only game nodes and requires a unique enabled resource ID', () => {
    const xml = `<hierarchy><node package="${pkg}" resource-id="${pkg}:id/phoneEditText" text="1&amp;2" hint="" class="android.widget.EditText" checked="false" enabled="true" bounds="[10,20][110,60]" />` +
      '<node package="com.other" resource-id="com.other:id/phoneEditText" text="" checked="false" enabled="true" bounds="[0,0][100,100]" /></hierarchy>';
    const nodes = parseNativeUi(xml, pkg);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ text: '1&2', x: 60, y: 40, width: 100, height: 40 });
    expect(byId(nodes, pkg, 'phoneEditText')).toBeDefined();
    expect(byId([...nodes, nodes[0]!], pkg, 'phoneEditText')).toBeUndefined();
  });

  it('never taps unknown screens or an unconfirmed agreement', async () => {
    const adb = device();
    const read = vi.fn().mockResolvedValue([]);
    const screen = await executeWanlongLoginCommand(adb, pkg, { requestId: 'one', action: 'inspect' },
      new AbortController().signal, read);
    expect(screen.step).toBe('manual');
    await expect(executeWanlongLoginCommand(adb, pkg,
      { requestId: 'two', action: 'requestSms', phone: '13800138000', agreementAccepted: true },
      new AbortController().signal, read)).rejects.toThrow('手机号登录页面');
    expect(adb.tap).not.toHaveBeenCalled();
  });

  it('re-reads nodes before agreement and submit, then masks the phone in returned state', async () => {
    const adb = device();
    const read = vi.fn()
      .mockResolvedValueOnce([node('phoneEditText')])
      .mockResolvedValueOnce([node('phoneEditText', { text: '13800138000' }), node('agreementCheckBox'), node('submitButton', { text: '登录' })])
      .mockResolvedValueOnce([node('agreementCheckBox', { checked: true }), node('submitButton', { text: '登录' })])
      .mockResolvedValueOnce([node('digitsInput'), node('messageText', { text: '已向 13800138000 发送验证码' })]);
    const result = await executeWanlongLoginCommand(adb, pkg,
      { requestId: 'sms', action: 'requestSms', phone: '13800138000', agreementAccepted: true },
      new AbortController().signal, read);
    expect(adb.text).toHaveBeenCalledWith('13800138000');
    expect(adb.tap).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ step: 'code', phoneMasked: '138****8000' });
    expect(JSON.stringify(result)).not.toContain('13800138000');
  });

  it('requires a fresh resend button and six-digit code', async () => {
    const adb = device();
    const read = vi.fn().mockResolvedValue([node('digitsInput'), node('resendButton', { text: '12 秒后重发' })]);
    await expect(executeWanlongLoginCommand(adb, pkg,
      { requestId: 'resend', action: 'resendCode' }, new AbortController().signal, read)).rejects.toThrow('倒计时');
    await expect(executeWanlongLoginCommand(adb, pkg,
      { requestId: 'code', action: 'submitCode', code: '123' }, new AbortController().signal, read)).rejects.toThrow('6 位');
    expect(adb.tap).not.toHaveBeenCalled();
    expect(loginScreen([node('unitySurfaceView')], pkg).step).toBe('game');
  });
});
