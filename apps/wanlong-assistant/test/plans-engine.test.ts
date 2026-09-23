import { describe, expect, it } from 'vitest';
import { executeScript } from '../src/main/plans/engine';
import type { ScriptDef, ScriptDevice, ScriptStep } from '../src/main/plans/types';

const PKG = 'com.lilithgames.samo.android.cn';
function device(actions: string[]): ScriptDevice {
  return {
    screencapRaw: async () => ({ width: 200, height: 100, data: new Uint8Array(200 * 100 * 4), capturedAt: Date.now() }),
    screencapPng: async () => new Uint8Array([1, 2, 3]),
    foregroundPackage: async () => PKG,
    tap: async (x, y) => { actions.push(`tap:${x},${y}`); },
    swipe: async (x1, y1, x2, y2, ms) => { actions.push(`swipe:${x1},${y1},${x2},${y2},${ms}`); },
    keyevent: async (key) => { actions.push(`key:${key}`); },
    text: async (value) => { actions.push(`text:${value}`); },
    startApp: async (pkg) => { actions.push(`start:${pkg}`); },
    stopApp: async (pkg) => { actions.push(`stop:${pkg}`); },
    shell: async (cmd) => { actions.push(`shell:${cmd}`); return ''; },
  };
}
const script = (steps: ScriptDef['steps']): ScriptDef => ({ id: 'test', name: '测试', version: '1.0.0', packageName: PKG,
  refWidth: 100, refHeight: 100, updatedAt: 0, steps });

describe('legacy JSON interpreter with fake device', () => {
  it('scales reference coordinates and executes branches, loops, parameters and goto', async () => {
    const actions: string[] = [];
    const result = await executeScript({ script: script([
      { id: 'a', kind: 'tap', at: { x: 25, y: 50 } },
      { id: 'b', kind: 'if', cond: { kind: 'foreground', packageName: PKG }, then: [{ id: 'c', kind: 'key', key: 'BACK' }] },
      { id: 'd', kind: 'loop', repeat: 2, steps: [{ id: 'e', kind: 'log', level: 'info', message: '轮次' }] },
      { id: 'f', kind: 'goto', label: 'end' },
      { id: 'g', kind: 'tap', at: { x: 0, y: 0 } },
      { id: 'h', kind: 'label', label: 'end' },
      { id: 'i', kind: 'text', text: 'role={{name}}' },
    ]), device: device(actions), templateDir: '', signal: new AbortController().signal,
    params: { name: 'Alice' }, maxRunMs: 60_000 });
    expect(result.executed).toBeGreaterThanOrEqual(7);
    expect(actions).toEqual(['tap:50,50', 'key:BACK', 'text:role=Alice']);
  });

  it('stops before input when aborted', async () => {
    const actions: string[] = [];
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(executeScript({ script: script([{ id: 'a', kind: 'tap', at: { x: 5, y: 5 } }]),
      device: device(actions), templateDir: '', signal: controller.signal, maxRunMs: 60_000 })).rejects.toThrow('cancelled');
    expect(actions).toEqual([]);
  });

  it.each([
    { id: 'next-tap', kind: 'tap', at: { x: 5, y: 5 } },
    { id: 'next-swipe', kind: 'swipe', from: { x: 1, y: 1 }, to: { x: 5, y: 5 }, durationMs: 100 },
    { id: 'next-long', kind: 'longPress', at: { x: 5, y: 5 }, durationMs: 100 },
    { id: 'next-text', kind: 'text', text: 'hello' },
    { id: 'next-key', kind: 'key', key: 'BACK' },
  ] as ScriptStep[])('stops before $kind input after another app enters the foreground', async (next) => {
    const actions: string[] = [];
    let foreground = PKG;
    const fake = device(actions);
    fake.foregroundPackage = async () => foreground;
    fake.tap = async (x, y) => { actions.push(`tap:${x},${y}`); foreground = 'com.example.other'; };
    await expect(executeScript({ script: script([
      { id: 'first', kind: 'tap', at: { x: 5, y: 5 } },
      { ...next, retry: 2, retryDelayMs: 0, onFail: { kind: 'continue' } },
    ]), device: fake, templateDir: '', signal: new AbortController().signal, maxRunMs: 60_000 }))
      .rejects.toThrow('目标游戏已离开前台');
    expect(actions).toEqual(['tap:10,5']);
  });

  it('rechecks the foreground before retrying the same input', async () => {
    const actions: string[] = [];
    let foreground = PKG;
    const fake = device(actions);
    fake.foregroundPackage = async () => foreground;
    fake.tap = async (x, y) => { actions.push(`tap:${x},${y}`); foreground = 'com.example.other'; throw new Error('first adb error'); };
    await expect(executeScript({ script: script([{ id: 'retry-tap', kind: 'tap', at: { x: 5, y: 5 },
      retry: 2, retryDelayMs: 0, onFail: { kind: 'continue' } }]), device: fake, templateDir: '',
      signal: new AbortController().signal, maxRunMs: 60_000 })).rejects.toThrow('目标游戏已离开前台');
    expect(actions).toEqual(['tap:10,5']);
  });

  it('passes a foreground guard into multi-command text input', async () => {
    const actions: string[] = [];
    let foreground = PKG;
    const fake = device(actions);
    fake.foregroundPackage = async () => foreground;
    fake.text = async (_value, beforeEach) => {
      await beforeEach?.();
      actions.push('text:first');
      foreground = 'com.example.other';
      await beforeEach?.();
      actions.push('text:second');
    };
    await expect(executeScript({ script: script([{ id: 'text', kind: 'text', text: 'first\tsecond',
      retry: 2, onFail: { kind: 'continue' } }]), device: fake, templateDir: '',
      signal: new AbortController().signal, maxRunMs: 60_000 })).rejects.toThrow('目标游戏已离开前台');
    expect(actions).toEqual(['text:first']);
  });
});
