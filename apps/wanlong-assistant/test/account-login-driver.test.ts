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

/**
 * Replay of the original `login-offline-check.ts` fixture section with hand-written UIAutomator trees (not copied
 * from real dumps): other-package nodes, a translucent status bar, the SDK login controls and the Unity surface.
 */
describe('Wanlong login fixture replay (synthetic UI trees)', () => {
  const other = '<node index="0" text="12:00" resource-id="com.android.systemui:id/clock" class="android.widget.TextView" package="com.android.systemui" checked="false" enabled="true" bounds="[0,0][120,40]" />';
  const n = (id: string, bounds: string, attrs = '') =>
    `<node index="0" text="" resource-id="${pkg}:id/${id}" class="android.view.View" package="${pkg}" checked="false" enabled="true" bounds="${bounds}" ${attrs}/>`;
  const tree = (...nodes: string[]) => `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="1">${other}${nodes.join('')}</hierarchy>`;
  const phoneXml = tree(
    n('phoneEditText', '[900,500][1660,580]', 'hint="请输入手机号"'),
    n('agreementCheckBox', '[900,700][940,740]'),
    n('submitButton', '[900,800][1660,880]').replace('text=""', 'text="&#30331;&#24405;"'),
  );
  const codeXml = tree(
    n('messageText', '[900,400][1660,440]').replace('text=""', 'text="验证码已发送至 13800000000"'),
    n('digitsInput', '[900,500][1620,600]'),
    n('resendButton', '[900,650][1200,700]').replace('text=""', 'text="59秒后重新获取"'),
  );
  const gameXml = tree(n('unitySurfaceView', '[0,0][2560,1440]'));

  it('classifies phone, code (masked, countdown) and game pages, filtering other packages and duplicates', () => {
    const phone = parseNativeUi(phoneXml, pkg);
    expect(phone.map((item) => item.id.split('/').at(-1))).toEqual(['phoneEditText', 'agreementCheckBox', 'submitButton']);
    expect(byId(phone, pkg, 'submitButton')?.text).toBe('登录');
    expect(loginScreen(phone, pkg).step).toBe('phone');
    const code = loginScreen(parseNativeUi(codeXml, pkg), pkg);
    expect(code).toMatchObject({ step: 'code', phoneMasked: '138****0000' });
    expect(code.retryAt).toBeGreaterThan(Date.now() + 50_000);
    expect(JSON.stringify(code)).not.toContain('13800000000');
    expect(loginScreen(parseNativeUi(gameXml, pkg), pkg).step).toBe('game');
    expect(byId([...phone, ...phone], pkg, 'phoneEditText')).toBeUndefined();
    expect(parseNativeUi(phoneXml.replaceAll(pkg, 'other.package'), pkg)).toHaveLength(0);
    expect(parseNativeUi(tree(n('phoneEditText', '[10,10][10,50]')), pkg)).toHaveLength(0); // empty bounds
  });

  it('drives phone → agreement → SMS → code → game in order, re-reading the page before every write', async () => {
    let page = parseNativeUi(phoneXml, pkg);
    const events: string[] = [];
    const idAt = (x: number, y: number) => page.find((item) =>
      Math.abs(item.x - x) <= item.width / 2 && Math.abs(item.y - y) <= item.height / 2)?.id.split('/').at(-1) ?? `${x},${y}`;
    const adb = {
      foregroundPackage: vi.fn().mockResolvedValue(pkg),
      shell: vi.fn(async () => { events.push('clear'); return ''; }),
      tap: vi.fn(async (x: number, y: number) => {
        const id = idAt(x, y);
        events.push(id);
        if (id === 'agreementCheckBox') page = page.map((item) => item.id.endsWith('agreementCheckBox') ? { ...item, checked: true } : item);
        if (id === 'submitButton') page = parseNativeUi(codeXml, pkg);
      }),
      keyevent: vi.fn(async () => { events.push('key'); }),
      text: vi.fn(async (value: string) => {
        events.push('text');
        if (page.some((item) => item.id.endsWith('phoneEditText'))) {
          page = page.map((item) => item.id.endsWith('phoneEditText') ? { ...item, text: value } : item);
        } else page = parseNativeUi(gameXml, pkg);
      }),
    } satisfies LoginInputDevice;
    const read = vi.fn(async () => structuredClone(page));
    const signal = new AbortController().signal;
    const sms = { requestId: 'sms', action: 'requestSms', phone: '13800000000', agreementAccepted: true } as const;
    expect((await executeWanlongLoginCommand(adb, pkg, sms, signal, read)).step).toBe('code');
    expect(events).toEqual(['phoneEditText', 'clear', 'text', 'key', 'agreementCheckBox', 'submitButton']);
    await expect(executeWanlongLoginCommand(adb, pkg, { requestId: 'r', action: 'resendCode' }, signal, read)).rejects.toThrow('倒计时');
    events.length = 0;
    const digits = byId(page, pkg, 'digitsInput')!;
    expect((await executeWanlongLoginCommand(adb, pkg, { requestId: 'c', action: 'submitCode', code: '123456' }, signal, read)).step).toBe('game');
    // The code is typed from the first of the six cells.
    expect(adb.tap).toHaveBeenLastCalledWith(Math.round(digits.x - digits.width / 2 + digits.width / 12), digits.y);
    expect(events).toEqual(['digitsInput', 'clear', 'text']);
    await expect(executeWanlongLoginCommand(adb, pkg, sms, signal, read)).rejects.toThrow('手机号登录页面');
    const aborted = new AbortController();
    aborted.abort();
    const taps = adb.tap.mock.calls.length;
    await expect(executeWanlongLoginCommand(adb, pkg, sms, aborted.signal, read)).rejects.toThrow();
    expect(adb.tap.mock.calls.length).toBe(taps);
  });

  it('refuses when the phone number did not land in the field, without echoing it', async () => {
    const page = parseNativeUi(phoneXml, pkg);
    const adb = device();
    const read = vi.fn(async () => structuredClone(page));
    const error = await executeWanlongLoginCommand(adb, pkg,
      { requestId: 'sms', action: 'requestSms', phone: '13800000000', agreementAccepted: true },
      new AbortController().signal, read).catch((e: unknown) => e as Error);
    expect(error?.message).toContain('未完整填入');
    expect(error?.message).not.toContain('13800000000');
  });
});
