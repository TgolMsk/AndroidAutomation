/**
 * Port of wanlong-panel `scripts/login-offline-check.ts` (coordinator, lock, queued input, secrets, idempotency,
 * verify, commit race, readiness gate) against the AVD account manager, with fakes only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AvdmError, withFileLock } from '@avdm/core';
import type { ManagerHost } from '../src/main/manager-host';
import type { AutomationHost } from '../src/main/automation/host';
import { AccountManager, toDevicePoint, validateLoginInput, type AccountManagerPorts } from '../src/main/automation/accounts';
import type { AccountLoginSession, AccountsChangedEvent, GameAccount, HomeVerdict } from '../src/main/automation/accounts/types';

const PKG = 'com.lilithgames.samo.android.cn';
const CREATED = '2026-09-23T12:00:00.000Z';
const NEW_ID = '11111111-2222-4333-8444-555555555555';
const PHONE = '13800138000';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

async function until(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= end) throw new Error('timed out waiting for login state');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const node = (id: string, bounds: string, extra = '') =>
  `<node index="0" text="" resource-id="${PKG}:id/${id}" class="android.widget.EditText" package="${PKG}" checked="false" enabled="true" bounds="${bounds}" ${extra}/>`;
const PHONE_XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="1">${node('phoneEditText', '[100,100][500,160]')}</hierarchy>`;

interface Harness {
  accounts: AccountManager;
  records: string[];
  foreground: { value: string | undefined };
  state: { status: string; record: { index: number; name: string; createdAt: string; provisioning?: boolean } };
  device: Record<string, ReturnType<typeof vi.fn>>;
  manager: Record<string, ReturnType<typeof vi.fn>>;
  automation: Record<string, ReturnType<typeof vi.fn>>;
  verifyHome: ReturnType<typeof vi.fn<(gameId: string, index: number) => Promise<HomeVerdict>>>;
  accountEvents: AccountsChangedEvent[];
  loginEvents: AccountLoginSession[];
  base: { value: { index: number; createdAt: string } | null };
}

let home: string;
const managers: AccountManager[] = [];

function harness(overrides: Partial<AccountManagerPorts> = {}): Harness {
  const records: string[] = [];
  const foreground = { value: PKG as string | undefined };
  const state = { status: 'running', record: { index: 1, name: '实例 1', createdAt: CREATED } };
  const device = {
    listPackages: vi.fn(async () => [PKG]),
    startApp: vi.fn(async (..._args: unknown[]) => { records.push('launch'); }),
    foregroundPackage: vi.fn(async () => foreground.value),
    screencapRaw: vi.fn(async () => ({ width: 1280, height: 720, format: 1, data: new Uint8Array(4), capturedAt: 42 })),
    tap: vi.fn(async (x: number, y: number) => { records.push(`tap:${x},${y}`); }),
    swipe: vi.fn(async () => { records.push('swipe'); }),
    keyevent: vi.fn(async (key: string) => { records.push(`key:${key}`); }),
    text: vi.fn(async () => { records.push('text'); }),
    shell: vi.fn(async (command: string) => (command.includes('uiautomator dump') ? PHONE_XML : '')),
  };
  const manager = {
    getState: vi.fn(async (index: number) => {
      if (index !== 1 && index !== 2) throw new AvdmError('INSTANCE_NOT_FOUND', `实例 #${index} 不存在`);
      return structuredClone({ ...state, record: { ...state.record, index } });
    }),
    start: vi.fn(async (index: number) => {
      records.push('start');
      state.status = 'running';
      return structuredClone({ ...state, record: { ...state.record, index } });
    }),
    device: vi.fn(async () => device),
  };
  const automation = {
    setSchedule: vi.fn(async (_gameId: string, index: number, enabled: boolean) => { records.push(`schedule:${index}:${enabled}`); return {}; }),
    schedules: vi.fn(async () => [{ gameId: 'wanlong', index: 1, enabled: true, nextWakeAt: null, failureCount: 0 }]),
    runs: vi.fn(async () => []),
  };
  const verifyHome = vi.fn<(gameId: string, index: number) => Promise<HomeVerdict>>(async () => ({ ok: true, templateId: 'tpl_nav_map_toggle', score: 0.97 }));
  const accountEvents: AccountsChangedEvent[] = [];
  const loginEvents: AccountLoginSession[] = [];
  const base = { value: null as { index: number; createdAt: string } | null };
  const accounts = new AccountManager({ get: async () => manager } as unknown as ManagerHost,
    automation as unknown as AutomationHost, home, {
      base: async () => base.value,
      verifyHome,
      encodePreview: async (frame) => ({ jpeg: new Uint8Array([1, 2, 3]), width: frame.width / 2, height: frame.height / 2 }),
      onAccountsChanged: (event) => accountEvents.push(event),
      onLoginChanged: (session) => loginEvents.push(session),
      ...overrides,
    });
  managers.push(accounts);
  return { accounts, records, foreground, state, device, manager, automation, verifyHome, accountEvents, loginEvents, base };
}

async function account(h: Harness, name = '主号'): Promise<GameAccount> {
  return h.accounts.create('wanlong', { name });
}

async function ready(h: Harness, accountId: string, index = 1): Promise<AccountLoginSession> {
  const session = h.accounts.beginLogin('wanlong', index, accountId);
  await until(() => h.accounts.loginSession(index)?.phase === 'awaitingLogin');
  return session;
}

const leasePath = (index: number) => path.join(home, 'run', `automation-instance-${index}.lock`);

/** True when another process could take the instance lease right now. */
async function leaseFree(index: number): Promise<boolean> {
  try { await withFileLock(leasePath(index), async () => undefined, { timeoutMs: 40 }); return true; }
  catch (error) { if ((error as AvdmError).code === 'LOCK_TIMEOUT') return false; throw error; }
}

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'avdm-account-manager-'));
});

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.shutdown()));
  await rm(home, { recursive: true, force: true });
});

describe('login coordinator: lifecycle, lock and cancel', () => {
  it('pauses automatic work, holds the instance lease, and enables only after a home proof', async () => {
    const h = harness();
    const a = await account(h);
    const session = await ready(h, a.id);
    expect(h.device.startApp.mock.calls).toEqual([[PKG]]); // ★ monkey: package only, never an activity
    expect(h.records.filter((r) => r.startsWith('schedule:'))).toEqual(['schedule:1:false']);
    expect((await h.accounts.list('wanlong'))[0]).toMatchObject({ enabled: false, login: { status: 'pending' }, binding: { index: 1, instanceCreatedAt: CREATED } });
    expect(await stat(leasePath(1))).toBeDefined();
    expect(await leaseFree(1)).toBe(false);
    await expect(h.accounts.verifyLogin(session.id, false)).rejects.toThrow('先确认');
    const done = await h.accounts.verifyLogin(session.id, true);
    expect(done.phase).toBe('completed');
    expect(h.verifyHome).toHaveBeenCalledWith('wanlong', 1);
    expect((await h.accounts.list('wanlong'))[0]).toMatchObject({ enabled: true, login: { status: 'ready' } });
    // Completion enables the account only; the gather schedule is never switched back on.
    expect(h.records.filter((r) => r.startsWith('schedule:'))).toEqual(['schedule:1:false']);
    expect(await leaseFree(1)).toBe(true);
  });

  it('reserves the instance before the first await, rejoins the same session and cancels without side effects', async () => {
    const pause = gate();
    const h = harness();
    const a = await account(h);
    const b = await account(h, '小号');
    h.automation.schedules!.mockImplementationOnce(async () => { await pause.promise; return []; });
    const first = h.accounts.beginLogin('wanlong', 1, a.id);
    expect(h.accounts.beginLogin('wanlong', 1, a.id).id).toBe(first.id);
    expect(() => h.accounts.beginLogin('wanlong', 2, a.id)).toThrow('正在登录');
    expect(() => h.accounts.beginLogin('wanlong', 1, b.id)).toThrow('已有登录向导');
    await expect(h.accounts.bind(b.id, 1)).rejects.toThrow('正在登录');
    expect(await h.accounts.readiness('wanlong', 1)).toMatchObject({ ready: false, reason: expect.stringContaining('账号登录') });
    await until(() => h.automation.schedules!.mock.calls.length > 0);
    const cancel = h.accounts.cancelLogin(first.id);
    expect(h.accounts.loginActiveOn(1)).toBe(true); // still reserved while the in-flight await settles
    pause.release();
    await cancel;
    expect(h.accounts.loginSession(1)?.phase).toBe('cancelled');
    expect(h.records).toEqual([]);
    expect((await h.accounts.list('wanlong')).every((item) => item.binding === null)).toBe(true);
    expect(await leaseFree(1)).toBe(true);
    expect((await h.accounts.readiness('wanlong', 1)).ready).toBe(true);
  });

  it('refuses the base instance before touching schedules, accounts or the device', async () => {
    const h = harness();
    h.base.value = { index: 1, createdAt: CREATED };
    const a = await account(h);
    h.accounts.beginLogin('wanlong', 1, a.id);
    await until(() => h.accounts.loginSession(1)?.phase === 'failed');
    expect(h.accounts.loginSession(1)?.message).toContain('基础实例');
    expect(h.records).toEqual([]);
    expect((await h.accounts.list('wanlong'))[0]?.binding).toBeNull();
  });

  it('keeps a pending account after a launch failure and releases the lease', async () => {
    const h = harness();
    const a = await account(h);
    h.device.startApp!.mockRejectedValueOnce(new Error('游戏未安装'));
    h.accounts.beginLogin('wanlong', 1, a.id);
    await until(() => h.accounts.loginSession(1)?.phase === 'failed');
    expect(h.records).toEqual(['schedule:1:false']);
    expect((await h.accounts.list('wanlong'))[0]).toMatchObject({ enabled: false, login: { status: 'pending' }, binding: { index: 1 } });
    expect(await leaseFree(1)).toBe(true);
  });

  it('fails cleanly when core admission control refuses to boot the instance', async () => {
    const h = harness();
    h.state.status = 'stopped';
    h.manager.start!.mockRejectedValueOnce(new AvdmError('ADMISSION_DENIED', '已达到同时运行的实例上限（2），请先停止其他实例'));
    const a = await account(h);
    h.accounts.beginLogin('wanlong', 1, a.id);
    await until(() => h.accounts.loginSession(1)?.phase === 'failed');
    expect(h.accounts.loginSession(1)?.message).toContain('实例上限');
    expect((await h.accounts.list('wanlong'))[0]?.login.status).toBe('pending');
    expect(h.device.startApp).not.toHaveBeenCalled();
    expect(await leaseFree(1)).toBe(true);
  });

  it('maps a lease held by another process to an occupancy message', async () => {
    const h = harness();
    const a = await account(h);
    const held = gate();
    const entered = gate();
    const other = withFileLock(leasePath(1), async () => { entered.release(); await held.promise; });
    await entered.promise;
    h.accounts.beginLogin('wanlong', 1, a.id);
    await until(() => h.accounts.loginSession(1)?.phase === 'failed');
    expect(h.accounts.loginSession(1)?.message).toContain('正被采集、脚本计划或模板操作占用');
    held.release();
    await other;
  });

  it('creates a new account inline under the client id and reuses it on 继续登录', async () => {
    const h = harness();
    h.accounts.beginLogin('wanlong', 1, NEW_ID, '新号');
    await until(() => h.accounts.loginSession(1)?.phase === 'awaitingLogin');
    const session = h.accounts.loginSession(1)!;
    expect(session.accountName).toBe('新号');
    await h.accounts.cancelLogin(session.id);
    h.accounts.beginLogin('wanlong', 1, NEW_ID, '新号');
    await until(() => h.accounts.loginSession(1)?.phase === 'awaitingLogin');
    expect(await h.accounts.list('wanlong')).toHaveLength(1);
    expect((await h.accounts.list('wanlong'))[0]).toMatchObject({ id: NEW_ID, name: '新号', binding: { index: 1 } });
    expect(() => h.accounts.beginLogin('wanlong', 2, 'not-a-uuid', '坏号')).toThrow('登录目标无效');
    await vi.waitFor(() => expect(h.accountEvents.some((event) => event.accounts.some((item) => item.id === NEW_ID))).toBe(true));
  });

  it('pushes monotonic session snapshots that callers cannot mutate', async () => {
    const h = harness();
    const a = await account(h);
    await ready(h, a.id);
    const phases = h.loginEvents.map((event) => event.phase);
    expect(phases[0]).toBe('preparing');
    expect(phases).toContain('starting');
    expect(phases.at(-1)).toBe('awaitingLogin');
    for (let i = 1; i < h.loginEvents.length; i++) expect(h.loginEvents[i]!.updatedAt).toBeGreaterThan(h.loginEvents[i - 1]!.updatedAt);
    const snapshot = h.accounts.loginSession(1)!;
    snapshot.message = '外部修改';
    expect(h.accounts.loginSession(1)!.message).not.toBe('外部修改');
  });
});

describe('login coordinator: manual input, commands and secrets', () => {
  it('drops inputs queued after a cancel and keeps the lease until device I/O settles', async () => {
    const h = harness();
    const a = await account(h);
    const session = await ready(h, a.id);
    const entered = gate();
    const finish = gate();
    h.device.text!.mockImplementationOnce(async () => { h.records.push('text'); entered.release(); await finish.promise; });
    const p1 = h.accounts.loginInput(session.id, { kind: 'text', text: '123456' }).catch((error: unknown) => error);
    await entered.promise;
    const p2 = h.accounts.loginInput(session.id, { kind: 'key', key: 'ENTER' }).catch((error: unknown) => error);
    const stop = h.accounts.cancelLogin(session.id);
    expect(await leaseFree(1)).toBe(false);
    finish.release();
    await Promise.all([p1, p2, stop]);
    expect(h.records.filter((r) => r === 'text')).toHaveLength(1);
    expect(h.records.some((r) => r.startsWith('key:'))).toBe(false);
    expect(await leaseFree(1)).toBe(true);
  });

  it('never returns the digits typed during login, neither from preview input nor from SDK commands', async () => {
    const h = harness();
    const a = await account(h);
    const session = await ready(h, a.id);
    const leak = new AvdmError('COMMAND_FAILED', `adb -s emulator-5554 shell input text ${PHONE} 123456 失败: MTIzNDU2`);
    h.device.text!.mockRejectedValue(leak);
    const inputError = await h.accounts.loginInput(session.id, { kind: 'text', text: '123456' }).catch((error: unknown) => error as Error);
    const commandError = await h.accounts.loginCommand(session.id,
      { requestId: 'sms-1', action: 'requestSms', phone: PHONE, agreementAccepted: true }).catch((error: unknown) => error as Error);
    for (const error of [inputError, commandError]) {
      expect(error).toBeInstanceOf(Error);
      const serialized = JSON.stringify({ message: (error as Error).message, ...(error as object), stack: undefined });
      expect(serialized).not.toMatch(/123456|MTIzNDU2|13800138000/);
    }
    expect(inputError?.message).toContain('登录数字输入失败');
    expect(commandError?.message).toContain('登录数字输入失败');
    expect(JSON.stringify(h.accounts.loginSession(1))).not.toMatch(/123456|13800138000/);
    expect(JSON.stringify(h.loginEvents)).not.toMatch(/123456|13800138000/);
    // Other raw adb failures (coordinates, serials) are replaced by a fixed message as well.
    h.device.tap!.mockRejectedValueOnce(new AvdmError('COMMAND_FAILED', 'adb -s emulator-5554 shell input tap 1 2 失败'));
    await expect(h.accounts.loginInput(session.id, { kind: 'tap', at: { x: 10, y: 10 } })).rejects.toThrow(/^登录输入未完成/);
    h.device.shell!.mockRejectedValueOnce(new AvdmError('COMMAND_FAILED', 'adb -s emulator-5554 shell rm 失败'));
    await expect(h.accounts.loginCommand(session.id, { requestId: 'inspect-9', action: 'inspect' })).rejects.toThrow('暂时无法识别');
  });

  it('converts reference coordinates with the real screencap size and refuses taps outside the game', async () => {
    const h = harness();
    const a = await account(h);
    const session = await ready(h, a.id);
    const frame = await h.accounts.loginFrame(session.id);
    expect(frame).toMatchObject({ deviceWidth: 1280, deviceHeight: 720, width: 640, height: 360, foregroundPackage: PKG });
    await h.accounts.loginInput(session.id, { kind: 'tap', at: { x: 1280, y: 720 } });
    await h.accounts.loginInput(session.id, { kind: 'swipe', at: { x: 0, y: 0 }, to: { x: 2560, y: 1440 }, durationMs: 300 });
    expect(h.records).toContain('tap:640,360');
    expect(h.device.swipe).toHaveBeenCalledWith(0, 0, 1279, 719, 300);
    h.foreground.value = 'com.android.permissioncontroller';
    await expect(h.accounts.loginInput(session.id, { kind: 'tap', at: { x: 5, y: 5 } })).rejects.toThrow('游戏未处于前台');
    await expect(h.accounts.loginInput(session.id, { kind: 'text', text: '1' })).rejects.toThrow('游戏未处于前台');
    await h.accounts.loginInput(session.id, { kind: 'key', key: 'BACK' });
    expect(h.records).toContain('key:BACK');
    // The preview itself shows any foreground app (system dialogs stay visible) without storing anything.
    expect((await h.accounts.loginFrame(session.id)).foregroundPackage).toBe('com.android.permissioncontroller');
  });

  it('validates preview input strictly, without echoing it', () => {
    expect(validateLoginInput({ kind: 'tap', at: { x: 2560, y: 1440 } })).toEqual({ kind: 'tap', at: { x: 2560, y: 1440 } });
    for (const bad of [
      { kind: 'tap', at: { x: 2561, y: 0 } }, { kind: 'tap', at: { x: Number.NaN, y: 0 } },
      { kind: 'swipe', at: { x: 0, y: 0 }, to: { x: 1, y: 1 }, durationMs: 49 },
      { kind: 'swipe', at: { x: 0, y: 0 }, to: { x: 1, y: 1 }, durationMs: 2001 },
      { kind: 'key', key: 'POWER' }, { kind: 'text', text: 'abc' }, { kind: 'text', text: '1'.repeat(33) },
      { kind: 'text', text: '12\n34' }, { kind: 'shell', command: 'reboot' }, null,
    ]) {
      expect(() => validateLoginInput(bad), JSON.stringify(bad)).toThrow('登录输入无效');
    }
    try { validateLoginInput({ kind: 'text', text: '13800138000x' }); }
    catch (error) { expect((error as Error).message).not.toContain('13800138000'); }
    expect(toDevicePoint({ x: 2560, y: 1440 }, { width: 960, height: 540 })).toEqual({ x: 959, y: 539 });
  });

  it('executes identical requests once, rejects a reused id with other parameters and isolates snapshots', async () => {
    const h = harness();
    const a = await account(h);
    const session = await ready(h, a.id);
    const entered = gate();
    const finish = gate();
    h.device.shell!.mockImplementationOnce(async () => '').mockImplementationOnce(async () => {
      entered.release(); await finish.promise; return PHONE_XML;
    });
    const command = { requestId: 'request-1', action: 'inspect' } as const;
    const c1 = h.accounts.loginCommand(session.id, command);
    await entered.promise;
    const c2 = h.accounts.loginCommand(session.id, command);
    expect(() => h.accounts.loginCommand(session.id, { requestId: 'request-1', action: 'resendCode' })).toThrow('同一请求编号');
    finish.release();
    const [r1, r2] = await Promise.all([c1, c2]);
    expect(r2).toEqual(r1);
    expect(r1.screen?.step).toBe('phone');
    expect(h.device.shell!.mock.calls.filter(([cmd]) => String(cmd).includes('uiautomator dump'))).toHaveLength(1);
    const snapshot = h.accounts.loginSession(1)!;
    snapshot.screen!.message = '外部修改';
    expect(h.accounts.loginSession(1)!.screen!.message).not.toBe('外部修改');
    expect(() => h.accounts.loginCommand(session.id, { requestId: 'bad id!', action: 'inspect' })).toThrow('请求编号无效');
    expect(() => h.accounts.loginCommand(session.id, { requestId: 'x', action: 'submitCode', code: '12' })).toThrow('登录操作无效');
  });

  it('returns a failed home check to awaitingLogin without enabling, then completes once', async () => {
    const h = harness();
    const a = await account(h);
    const session = await ready(h, a.id);
    const complete = vi.spyOn(h.accounts.store, 'completeLogin');
    h.verifyHome.mockResolvedValueOnce({ ok: false, reason: '尚未识别到游戏主界面。' });
    await expect(h.accounts.verifyLogin(session.id, true)).rejects.toThrow('尚未识别');
    expect(h.accounts.loginSession(1)?.phase).toBe('awaitingLogin');
    expect(complete).not.toHaveBeenCalled();
    expect((await h.accounts.list('wanlong'))[0]?.enabled).toBe(false);
    h.verifyHome.mockRejectedValueOnce(new Error('缺少城内／世界地图模板'));
    await expect(h.accounts.verifyLogin(session.id, true)).rejects.toThrow('缺少城内');
    expect((await h.accounts.verifyLogin(session.id, true)).phase).toBe('completed');
    expect(complete).toHaveBeenCalledTimes(1);
    await expect(h.accounts.loginInput(session.id, { kind: 'key', key: 'BACK' })).rejects.toThrow('登录向导已结束');
  });

  it('waits for the completion write when the wizard is closed during the commit', async () => {
    const h = harness();
    const a = await account(h);
    const session = await ready(h, a.id);
    const entered = gate();
    const finish = gate();
    const original = h.accounts.store.completeLogin.bind(h.accounts.store);
    vi.spyOn(h.accounts.store, 'completeLogin').mockImplementation(async (...args) => {
      entered.release();
      await finish.promise;
      return original(...args);
    });
    const commit = h.accounts.verifyLogin(session.id, true);
    await entered.promise;
    const close = h.accounts.cancelLogin(session.id);
    expect(await leaseFree(1)).toBe(false);
    finish.release();
    await Promise.all([commit, close]);
    expect(h.accounts.loginSession(1)?.phase).toBe('completed');
    expect((await h.accounts.list('wanlong'))[0]?.enabled).toBe(true);
    expect(await leaseFree(1)).toBe(true);
  });
});

describe('accounts: binding, takeover and the automation readiness gate', () => {
  it('refuses an owned instance until the takeover is confirmed, then resets the displaced account', async () => {
    const h = harness();
    const a = await account(h, '甲');
    const b = await account(h, '乙');
    const session = await ready(h, a.id);
    await h.accounts.verifyLogin(session.id, true);
    h.records.length = 0;
    await expect(h.accounts.bind(b.id, 1)).rejects.toMatchObject({ code: 'ACCOUNT_SLOT_TAKEN', message: expect.stringContaining('「甲」') });
    const result = await h.accounts.bind(b.id, 1, { takeOver: true });
    expect(result.displaced).toEqual({ id: a.id, name: '甲' });
    expect(result.account.binding).toEqual({ index: 1, instanceCreatedAt: CREATED });
    expect(h.records).toEqual(['schedule:1:false']);
    expect((await h.accounts.store.get(a.id))).toMatchObject({ binding: null, enabled: false, login: { status: 'pending' } });
    await vi.waitFor(() => expect(h.accountEvents.at(-1)?.accounts.find((item) => item.id === a.id)?.binding).toBeNull());
  });

  it('refuses a rebind onto an owned instance before switching off any schedule', async () => {
    const h = harness();
    const a = await account(h, '甲');
    const b = await account(h, '乙');
    await h.accounts.bind(a.id, 1);
    await h.accounts.bind(b.id, 2);
    h.records.length = 0;
    // Refused (and then cancelled at the takeover dialog): 乙 keeps instance 2 and its gather schedule.
    await expect(h.accounts.bind(b.id, 1)).rejects.toMatchObject({ code: 'ACCOUNT_SLOT_TAKEN' });
    expect(h.records).toEqual([]);
    expect((await h.accounts.store.get(b.id))?.binding?.index).toBe(2);
    const moved = await h.accounts.bind(b.id, 1, { takeOver: true });
    expect(moved.displaced?.name).toBe('甲');
    expect(h.records).toEqual(['schedule:2:false', 'schedule:1:false']);
  });

  it('creates and binds in one step under the client id: a refusal leaves no account, a retry no duplicate', async () => {
    const h = harness();
    const a = await account(h, '甲');
    await h.accounts.bind(a.id, 1);
    h.records.length = 0;
    await expect(h.accounts.createAndBind('wanlong', 1, NEW_ID, { name: '新号' })).rejects.toMatchObject({ code: 'ACCOUNT_SLOT_TAKEN' });
    h.base.value = { index: 2, createdAt: CREATED };
    await expect(h.accounts.createAndBind('wanlong', 2, NEW_ID, { name: '新号' })).rejects.toThrow('基础实例只用于克隆');
    expect((await h.accounts.list('wanlong')).map((item) => item.name)).toEqual(['甲']);
    expect(h.records).toEqual([]);
    const created = await h.accounts.createAndBind('wanlong', 1, NEW_ID, { name: '新号' }, { takeOver: true });
    expect(created).toMatchObject({ account: { id: NEW_ID, name: '新号', binding: { index: 1 } }, displaced: { id: a.id, name: '甲' } });
    expect(h.records).toEqual(['schedule:1:false']);
    const retried = await h.accounts.createAndBind('wanlong', 1, NEW_ID, { name: '新号' });
    expect(retried.account.id).toBe(NEW_ID);
    expect(await h.accounts.list('wanlong')).toHaveLength(2);
    await expect(h.accounts.createAndBind('wanlong', 1, 'plain-id', { name: 'x' })).rejects.toThrow('账号编号无效');
    h.records.length = 0;
    await expect(h.accounts.createAndBind('wanlong', 1, '33333333-2222-4333-8444-555555555555', { name: ' ' }, { takeOver: true }))
      .rejects.toThrow('账号名称');
    expect(h.records).toEqual([]);
    await vi.waitFor(() => expect(h.accountEvents.at(-1)?.accounts.find((item) => item.id === NEW_ID)?.binding?.index).toBe(1));
  });

  it('refuses to bind the base instance and gates automation on base, pending and replaced instances', async () => {
    const h = harness();
    const a = await account(h);
    expect(await h.accounts.readiness('wanlong', 1)).toEqual({ ready: true });
    h.base.value = { index: 1, createdAt: CREATED };
    await expect(h.accounts.bind(a.id, 1)).rejects.toThrow('基础实例只用于克隆');
    await expect(h.accounts.assertInstanceAutomationReady('wanlong', 1)).rejects.toThrow('基础实例用于克隆');
    h.base.value = { index: 1, createdAt: 'another-avd' };
    await h.accounts.bind(a.id, 1);
    expect(await h.accounts.readiness('wanlong', 1)).toMatchObject({ ready: false, reason: expect.stringContaining('尚未完成登录检查') });
    const session = await ready(h, a.id);
    await h.accounts.verifyLogin(session.id, true);
    expect(await h.accounts.readiness('wanlong', 1)).toEqual({ ready: true });
    expect((await h.accounts.accountForInstance('wanlong', 1))?.id).toBe(a.id);
    h.state.record.createdAt = '2026-09-24T00:00:00.000Z';
    expect((await h.accounts.readiness('wanlong', 1)).ready).toBe(false);
    expect(await h.accounts.accountForInstance('wanlong', 1)).toBeNull();
    expect(await h.accounts.readiness('wanlong', 9)).toMatchObject({ ready: false, reason: expect.stringContaining('不存在') });
  });

  it('moves the instance gather config into a newly bound account and tells where it went on unbind', async () => {
    const h = harness({ instanceGatherConfig: async () => ({ version: 2, enabled: true }) });
    const a = await account(h);
    const bound = await h.accounts.bind(a.id, 2);
    expect(bound.notice).toContain('已搬到账号');
    expect(bound.account.scriptParams?.gather?.configJson).toBe('{"version":2,"enabled":true}');
    await h.accounts.setScriptParams(a.id, 'gather', { configJson: '{"version":2,"enabled":false}' });
    await h.accounts.bind(a.id, null);
    const again = await h.accounts.bind(a.id, 2);
    expect(again.notice).toContain('没有用实例上的那份覆盖');
    expect((await h.accounts.scriptParams(a.id, 'gather')).configJson).toBe('{"version":2,"enabled":false}');
    expect((await h.accounts.bind(a.id, null)).notice).toContain('采集配置仍留在账号');
  });

  it('keeps the instance file the only gather config while nothing reads the account copy', async () => {
    const h = harness();
    const a = await account(h);
    const bound = await h.accounts.bind(a.id, 2);
    expect(bound.notice).toBeUndefined();
    expect(bound.account.scriptParams).toBeUndefined();
    expect(await h.accounts.gatherConfigFor('wanlong', 2)).toBeNull();
    await h.accounts.saveGatherConfig(a.id, { version: 2, enabled: true });
    expect(await h.accounts.gatherConfigFor('wanlong', 2)).toEqual({ accountId: a.id, accountName: '主号', config: { version: 2, enabled: true } });
    expect((await h.accounts.bind(a.id, null)).notice).toBeUndefined();
    expect(await h.accounts.gatherConfigFor('wanlong', 2)).toBeNull();
    await h.accounts.bind(a.id, 2);
    await h.accounts.setScriptParams(a.id, 'gather', { configJson: '[1]' });
    await expect(h.accounts.gatherConfigFor('wanlong', 2)).rejects.toThrow('采集配置已损坏');
    expect((await h.accounts.saveGatherConfig(a.id, null)).scriptParams).toBeUndefined();
  });

  it('switches off the schedule of an account that is removed or disabled', async () => {
    const h = harness();
    const a = await account(h);
    const session = await ready(h, a.id);
    await h.accounts.verifyLogin(session.id, true);
    h.records.length = 0;
    await h.accounts.setEnabled(a.id, false);
    await h.accounts.remove(a.id);
    expect(h.records).toEqual(['schedule:1:false', 'schedule:1:false']);
    expect(await h.accounts.list('wanlong')).toEqual([]);
  });
});
