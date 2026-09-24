import { describe, expect, it } from 'vitest';
import { DeviceLanes, DeviceLaneCancelledError } from '../src/main/device/lane';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A device that records the order of calls and can hold a call open until released. */
class FakeDevice {
  readonly log: string[] = [];
  readonly serial = 'emulator-5556';
  holds = new Map<string, Promise<void>>();

  private async step(name: string): Promise<string> {
    this.log.push(`${name}:start`);
    await (this.holds.get(name) ?? Promise.resolve());
    this.log.push(`${name}:end`);
    return name;
  }

  foregroundPackage(): Promise<string> { return this.step('foreground'); }
  tap(_x: number, _y: number): Promise<string> { return this.step('tap'); }
  screencapRaw(): Promise<string> { return this.step('capture'); }
  async text(_value: string, beforeEach?: () => Promise<void>): Promise<void> {
    this.log.push('text:start');
    await beforeEach?.();
    this.log.push('text:end');
  }
  async fail(): Promise<void> { throw new Error('adb 失败'); }
}

describe('DeviceLane (per-instance serialized adb lane)', () => {
  it('runs one instance\'s operations one at a time, in submission order', async () => {
    const lanes = new DeviceLanes();
    const device = new FakeDevice();
    const held = gate();
    device.holds.set('tap', held.promise);
    const laned = lanes.device(1, device);
    const results = Promise.all([laned.tap(1, 2), laned.foregroundPackage(), laned.screencapRaw()]);
    await tick();
    expect(device.log).toEqual(['tap:start']);
    held.release();
    expect(await results).toEqual(['tap', 'foreground', 'capture']);
    expect(device.log).toEqual(['tap:start', 'tap:end', 'foreground:start', 'foreground:end', 'capture:start', 'capture:end']);
    expect(laned.serial).toBe('emulator-5556');
  });

  it('keeps different instances independent', async () => {
    const lanes = new DeviceLanes();
    const a = new FakeDevice();
    const b = new FakeDevice();
    const held = gate();
    a.holds.set('tap', held.promise);
    const slow = lanes.device(1, a).tap(0, 0);
    await expect(lanes.device(2, b).foregroundPackage()).resolves.toBe('foreground');
    held.release();
    await slow;
  });

  it('caps concurrency across instances', async () => {
    const lanes = new DeviceLanes({ globalConcurrency: 2 });
    const gates = [gate(), gate(), gate()];
    let running = 0;
    let peak = 0;
    const jobs = gates.map((g, index) => lanes.run(index, async () => {
      running++;
      peak = Math.max(peak, running);
      await g.promise;
      running--;
    }));
    await tick();
    expect(running).toBe(2);
    for (const g of gates) g.release();
    await Promise.all(jobs);
    expect(peak).toBe(2);
  });

  it('keeps the minimum capture interval per instance, waiting inside the lane', async () => {
    let now = 1_000;
    const waits: number[] = [];
    const lanes = new DeviceLanes({
      minCaptureIntervalMs: () => 400,
      now: () => now,
      sleep: async (ms) => { waits.push(ms); now += ms; },
    });
    const device = lanes.device(3, new FakeDevice());
    await device.screencapRaw();
    now += 150;
    await device.tap(1, 1); // Input is never throttled.
    await device.screencapRaw();
    expect(waits).toEqual([250]);
    now += 1_000;
    await device.screencapRaw();
    expect(waits).toEqual([250]);
    // Another instance has its own clock.
    await lanes.device(4, new FakeDevice()).screencapRaw();
    expect(waits).toEqual([250]);
    expect(lanes.stats().map((lane) => lane.index)).toEqual([3, 4]);
  });

  it('runs nested calls on the same lane inline instead of deadlocking', async () => {
    const lanes = new DeviceLanes();
    const device = new FakeDevice();
    const laned = lanes.device(5, device);
    // AdbDevice.text(value, beforeEach): the callback re-checks the foreground on the same instance.
    await laned.text('abc', async () => { await laned.foregroundPackage(); });
    expect(device.log).toEqual(['text:start', 'foreground:start', 'foreground:end', 'text:end']);
    // A composite section holds the lane; inner calls run inline and outside callers wait for it.
    const outside = new FakeDevice();
    const held = gate();
    const composite = lanes.run(6, async () => {
      await lanes.device(6, outside).foregroundPackage();
      await held.promise;
      return lanes.device(6, outside).screencapRaw();
    });
    const later = lanes.device(6, outside).tap(0, 0);
    await tick();
    expect(outside.log).toEqual(['foreground:start', 'foreground:end']);
    held.release();
    await composite;
    await later;
    expect(outside.log.slice(-2)).toEqual(['tap:start', 'tap:end']);
  });

  it('reports a failed call to its caller and keeps the lane going', async () => {
    const lanes = new DeviceLanes();
    const device = lanes.device(7, new FakeDevice());
    await expect(device.fail()).rejects.toThrow('adb 失败');
    await expect(device.foregroundPackage()).resolves.toBe('foreground');
  });

  it('drops queued work with a Chinese CANCELLED error, and refuses new work after dispose', async () => {
    const lanes = new DeviceLanes();
    const device = new FakeDevice();
    const held = gate();
    device.holds.set('tap', held.promise);
    const laned = lanes.device(8, device);
    const running = laned.tap(0, 0);
    const queued = laned.screencapRaw();
    await tick();
    lanes.drop(8);
    await expect(queued).rejects.toBeInstanceOf(DeviceLaneCancelledError);
    await expect(queued).rejects.toMatchObject({ code: 'CANCELLED' });
    held.release();
    await expect(running).resolves.toBe('tap');
    lanes.dispose();
    await expect(laned.foregroundPackage()).rejects.toThrow('助手正在退出');
  });

  it('wraps a manager host so every device handed out is lane-bound, leaving the rest untouched', async () => {
    const lanes = new DeviceLanes();
    const device = new FakeDevice();
    const held = gate();
    device.holds.set('tap', held.promise);
    const manager = {
      calls: 0,
      async device(index: number) { this.calls++; expect(index).toBe(2); return device; },
      async getState(index: number) { return { index, status: 'running' }; },
    };
    const host = { opened: 0, async get() { this.opened++; return manager; }, statuses: new Map([[2, 'running']]) };
    const wrapped = lanes.host(host);
    expect(wrapped.statuses.get(2)).toBe('running');
    const resolved = await wrapped.get();
    expect(await wrapped.get()).toBe(resolved);
    await expect(resolved.getState(2)).resolves.toEqual({ index: 2, status: 'running' });
    const first = (await resolved.device(2)).tap(0, 0);
    const second = (await resolved.device(2)).foregroundPackage();
    await tick();
    expect(device.log).toEqual(['tap:start']);
    held.release();
    await Promise.all([first, second]);
    expect(manager.calls).toBe(2);
    expect(host.opened).toBe(2);
  });
});
