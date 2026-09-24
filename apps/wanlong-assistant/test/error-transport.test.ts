import { beforeAll, describe, expect, it, vi } from 'vitest';

// A minimal sandboxed-preload environment: capture what the preload exposes and answer invokes from a table.
const bridge = vi.hoisted(() => ({
  exposed: {} as Record<string, unknown>,
  replies: new Map<string, unknown>(),
  listeners: new Map<string, (event: unknown, message: unknown) => void>(),
}));

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (key: string, api: unknown) => { bridge.exposed[key] = api; } },
  ipcRenderer: {
    invoke: async (channel: string) => bridge.replies.get(channel),
    on: (channel: string, fn: (event: unknown, message: unknown) => void) => { bridge.listeners.set(channel, fn); },
  },
}));

import { WanlongError, errMsg, errorCodeOf, unwrapEnvelope, wrapBridge } from '../src/renderer/api';
import type { WanlongBridge } from '../src/shared/ipc';

type Fn = (...args: unknown[]) => Promise<unknown>;

describe('renderer envelope unwrapping', () => {
  it('returns values and rebuilds failures as WanlongError with their code', () => {
    expect(unwrapEnvelope({ ok: true, value: 7 })).toBe(7);
    let caught: unknown;
    try { unwrapEnvelope({ ok: false, error: { message: '实例 #1 正被占用', code: 'LOCK_TIMEOUT' } }); }
    catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(WanlongError);
    expect(caught).toBeInstanceOf(Error);
    expect(errMsg(caught)).toBe('实例 #1 正被占用');
    expect(errorCodeOf(caught)).toBe('LOCK_TIMEOUT');
    expect(() => unwrapEnvelope(undefined)).toThrow('未知错误');
    expect(() => unwrapEnvelope({ ok: false, error: { message: '' } })).toThrow('未知错误');
    expect(errorCodeOf(new Error('x'))).toBeUndefined();
    expect(errorCodeOf(Object.assign(new Error('x'), { code: 'E' }))).toBe('E');
  });

  it('wraps assistant methods and passes shell methods and events through', async () => {
    const off = vi.fn();
    const raw = {
      listInstances: vi.fn(async () => { throw new Error('壳层错误'); }),
      automationRuns: vi.fn(async () => ({ ok: true, value: [] })),
      stopAutomation: vi.fn(async () => ({ ok: false, error: { message: '无法停止', code: 'CONCURRENCY_LIMIT' } })),
      on: vi.fn(() => off),
    };
    const api = wrapBridge(raw as unknown as WanlongBridge);
    await expect(api.automationRuns()).resolves.toEqual([]);
    await expect(api.stopAutomation('run-1')).rejects.toMatchObject({ name: 'WanlongError', code: 'CONCURRENCY_LIMIT', message: '无法停止' });
    expect(raw.stopAutomation).toHaveBeenCalledWith('run-1');
    await expect(api.listInstances()).rejects.toThrow('壳层错误');
    expect(api.on('automation-run', () => undefined)).toBe(off);
  });
});

describe('preload bridge', () => {
  beforeAll(async () => {
    bridge.replies.set('wanlong:stopAutomation', { ok: false, error: { message: '实例 #2 正在登录', code: 'LOCK_TIMEOUT' } });
    bridge.replies.set('wanlong:automationRuns', { ok: true, value: [{ runId: 'r' }] });
    bridge.replies.set('wanlong:advisorStatus', { ok: false, error: { message: 42 } });
    bridge.replies.set('avdm:listInstances', { ok: false, error: { message: '模拟器不可用', code: 'X' } });
    await import('../src/preload/index');
  });

  it('returns assistant envelopes instead of throwing, so codes survive contextBridge', async () => {
    const api = bridge.exposed['avdm'] as Record<string, Fn>;
    await expect(api['stopAutomation']!('r')).resolves.toEqual({ ok: false, error: { message: '实例 #2 正在登录', code: 'LOCK_TIMEOUT' } });
    await expect(api['automationRuns']!()).resolves.toEqual({ ok: true, value: [{ runId: 'r' }] });
    await expect(api['advisorStatus']!()).resolves.toEqual({ ok: false, error: { message: '未知错误' } });
    await expect(api['insightDays']!('wanlong', null)).resolves.toEqual({ ok: false, error: { message: '未知错误' } });
  });

  it('keeps shell methods throwing with the message only', async () => {
    const api = bridge.exposed['avdm'] as Record<string, Fn>;
    await expect(api['listInstances']!()).rejects.toThrow('模拟器不可用');
  });

  it('dispatches events from both channels to subscribers', () => {
    const api = bridge.exposed['avdm'] as { on(channel: string, fn: (payload: unknown) => void): () => void };
    const seen: unknown[] = [];
    const off = api.on('automation-run', (payload) => seen.push(payload));
    bridge.listeners.get('wanlong:event')!({}, { channel: 'automation-run', payload: 1 });
    bridge.listeners.get('avdm:event')!({}, { channel: 'automation-run', payload: 2 });
    off();
    bridge.listeners.get('wanlong:event')!({}, { channel: 'automation-run', payload: 3 });
    expect(seen).toEqual([1, 2]);
  });
});
