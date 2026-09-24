import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ScriptRunner, type ScriptExecuteOptions } from '../src/main/plans/script-runner';
import type { ScriptDef, ScriptStep } from '../src/main/plans/types';
import { FAST_PACING, PKG, fakeScriptDevice, fakeVision, inProcessWorkers, type FakeScriptDevice } from './helpers/script-worker';

const script = (steps: ScriptDef['steps'], extra: Partial<ScriptDef> = {}): ScriptDef => ({ id: 'test', name: '测试', version: '1.0.0', packageName: PKG,
  refWidth: 100, refHeight: 100, updatedAt: 0, steps, ...extra });

let home: string;
beforeEach(async () => { home = await mkdtemp(path.join(tmpdir(), 'wanlong-script-engine-')); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

async function run(def: ScriptDef, device: FakeScriptDevice, extra: Partial<ScriptExecuteOptions> = {}) {
  const workers = inProcessWorkers({ vision: fakeVision() });
  const runner = new ScriptRunner(home, {
    instance: async () => ({ status: 'running', record: { createdAt: 'identity-1' } }),
    device: async () => device,
  }, { workerFactory: workers.factory, pacing: FAST_PACING, foregroundPollMs: 5 });
  const result = await runner.execute({
    runId: '00000000-0000-4000-8000-00000000000a', gameId: 'wanlong', packageName: PKG, instanceIndex: 1, instanceIdentity: 'identity-1',
    script: def, params: {}, accountId: null, accountName: null, source: 'manual', taskId: null, templateDir: null,
    shotPolicy: 'onFail', maxRunMs: 60_000, ...extra,
  });
  return { result, runner };
}

describe('legacy JSON scripts through the worker executor (fake device)', () => {
  it('scales reference coordinates and executes branches, loops, parameters and goto', async () => {
    const device = fakeScriptDevice();
    const { result } = await run(script([
      { id: 'a', kind: 'tap', at: { x: 25, y: 50 } },
      { id: 'b', kind: 'if', cond: { kind: 'foreground', packageName: PKG }, then: [{ id: 'c', kind: 'key', key: 'BACK' }] },
      { id: 'd', kind: 'loop', repeat: 2, steps: [{ id: 'e', kind: 'log', level: 'info', message: '轮次' }] },
      { id: 'f', kind: 'goto', label: 'end' },
      { id: 'g', kind: 'tap', at: { x: 0, y: 0 } },
      { id: 'h', kind: 'label', label: 'end' },
      { id: 'i', kind: 'text', text: 'role={{name}}' },
    ]), device, { params: { name: 'Alice' } });
    expect(result.status).toBe('succeeded');
    expect(device.actions).toEqual(['tap:50,50', 'key:BACK', 'text:role=Alice']);
  });

  it('stops before input when aborted', async () => {
    const device = fakeScriptDevice();
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    const { result } = await run(script([{ id: 'a', kind: 'tap', at: { x: 5, y: 5 } }]), device, { signal: controller.signal });
    expect(result.status).toBe('aborted');
    expect(device.actions).toEqual([]);
  });

  it.each([
    { id: 'next-tap', kind: 'tap', at: { x: 5, y: 5 } },
    { id: 'next-swipe', kind: 'swipe', from: { x: 1, y: 1 }, to: { x: 5, y: 5 }, durationMs: 100 },
    { id: 'next-long', kind: 'longPress', at: { x: 5, y: 5 }, durationMs: 100 },
    { id: 'next-text', kind: 'text', text: 'hello' },
    { id: 'next-key', kind: 'key', key: 'BACK' },
  ] as ScriptStep[])('stops before $kind input after another app enters the foreground (retry / onFail cannot bypass it)', async (next) => {
    const device = fakeScriptDevice();
    device.tap = async (x, y) => { device.actions.push(`tap:${x},${y}`); device.foreground = 'com.example.other'; };
    const { result } = await run(script([
      { id: 'first', kind: 'tap', at: { x: 5, y: 5 } },
      { ...next, retry: 2, retryDelayMs: 0, onFail: { kind: 'continue' } } as ScriptStep,
    ]), device);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('目标游戏已离开前台');
    expect(device.actions).toEqual(['tap:10,5']);
    expect(device.shells.filter((cmd) => cmd.includes('motionevent'))).toEqual([]);
  });

  it('rechecks the foreground before retrying the same input', async () => {
    const device = fakeScriptDevice();
    device.tap = async (x, y) => { device.actions.push(`tap:${x},${y}`); device.foreground = 'com.example.other'; throw new Error('first adb error'); };
    const { result } = await run(script([{ id: 'retry-tap', kind: 'tap', at: { x: 5, y: 5 }, retry: 2, retryDelayMs: 0, onFail: { kind: 'continue' } }]), device);
    expect(result.error).toContain('目标游戏已离开前台');
    expect(device.actions).toEqual(['tap:10,5']);
  });

  it('passes a foreground guard into multi-command text input', async () => {
    const device = fakeScriptDevice();
    device.text = async (_value, beforeEach) => {
      await beforeEach?.();
      device.actions.push('text:first');
      device.foreground = 'com.example.other';
      await beforeEach?.();
      device.actions.push('text:second');
    };
    const { result } = await run(script([{ id: 'text', kind: 'text', text: 'first\tsecond', retry: 2, onFail: { kind: 'continue' } }]), device);
    expect(result.error).toContain('目标游戏已离开前台');
    expect(device.actions).toEqual(['text:first']);
  });

  it('refuses to start when the game is not in the foreground, unless the script begins with launchApp', async () => {
    const off = fakeScriptDevice();
    off.foreground = 'com.android.launcher3';
    const refused = await run(script([{ id: 'a', kind: 'tap', at: { x: 5, y: 5 } }]), off);
    expect(refused.result.status).toBe('failed');
    expect(refused.result.error).toContain('目标游戏已离开前台');
    expect(off.actions).toEqual([]);

    const cold = fakeScriptDevice();
    cold.foreground = 'com.android.launcher3';
    const launched = await run(script([{ id: 'go', kind: 'launchApp', cold: true }, { id: 'a', kind: 'tap', at: { x: 5, y: 5 } }]), cold);
    expect(launched.result.status).toBe('succeeded');
    expect(cold.actions).toEqual([`stop:${PKG}`, `start:${PKG}`, 'tap:10,5']);
  });

  it('restartApp stops, cold-launches through monkey, waits for the foreground and reruns from the top', async () => {
    const device = fakeScriptDevice();
    let failOnce = true;
    device.tap = async (x, y) => {
      device.actions.push(`tap:${x},${y}`);
      if (x === 20 && failOnce) { failOnce = false; throw new Error('卡界面'); }
    };
    const { result } = await run(script([{ id: 'a', kind: 'tap', at: { x: 5, y: 5 } }, { id: 'b', kind: 'tap', at: { x: 10, y: 10 }, onFail: { kind: 'restartApp' } }]), device);
    expect(result.status).toBe('succeeded');
    expect(device.actions).toEqual(['tap:10,5', 'tap:20,10', `stop:${PKG}`, `stop:${PKG}`, `start:${PKG}`, 'tap:10,5', 'tap:20,10']);
  });
});
