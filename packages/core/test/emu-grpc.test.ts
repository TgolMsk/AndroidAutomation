import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  EmulatorGrpc,
  emulatorProtoCandidates,
  imageToFrame,
  resolveEmulatorProtoPath,
  setEmulatorProtoPath,
} from '../src/grpc.js';
import type { ScreenFrame } from '../src/types.js';
import {
  CORE_PROTO_PATH,
  createFakeSdk,
  getFreePort,
  startFakeEmulator,
  waitForExit,
  type FakeSdk,
  type RunningFakeEmulator,
} from './helpers/fakeSdk.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function readInputLog(file: string): Promise<Array<{ type: string; port: number; request: any }>> {
  const text = await fsp.readFile(file, 'utf8').catch(() => '');
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

describe('proto resolution', () => {
  const savedEnv = process.env.AVDM_PROTO_PATH;
  afterEach(() => {
    setEmulatorProtoPath(CORE_PROTO_PATH);
    if (savedEnv === undefined) delete process.env.AVDM_PROTO_PATH;
    else process.env.AVDM_PROTO_PATH = savedEnv;
  });

  it('the override wins and a missing file is UNSUPPORTED on first call, not at create()', async () => {
    setEmulatorProtoPath('/nonexistent/emulator_controller.proto');
    expect(emulatorProtoCandidates()).toEqual(['/nonexistent/emulator_controller.proto']);
    expect(() => resolveEmulatorProtoPath()).toThrow(/找不到模拟器 gRPC 协议文件/);
    const client = EmulatorGrpc.create(await getFreePort());
    await expect(client.getStatus()).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    const ended = await new Promise<Error | undefined>((resolve) => {
      client.streamScreenshot({}, () => {}, resolve);
    });
    expect(ended).toMatchObject({ code: 'UNSUPPORTED' });
    client.close();
  });

  it('create() validates the port', () => {
    expect(() => EmulatorGrpc.create(0)).toThrow(/无效的 gRPC 端口/);
    expect(() => EmulatorGrpc.create(70000)).toThrow(/无效的 gRPC 端口/);
  });
});

describe('imageToFrame', () => {
  it('prefers format.width/height and falls back to deprecated fields', () => {
    const png = new Uint8Array([1, 2, 3]);
    expect(imageToFrame({ format: { format: 'PNG', width: 640, height: 360 }, width: 0, height: 0, image: png, seq: 2, timestampUs: 99 })).toEqual({
      data: Buffer.from([1, 2, 3]),
      format: 'png',
      width: 640,
      height: 360,
      seq: 2,
      timestampUs: 99,
    });
    const old = imageToFrame({ format: { format: 'RGBA8888' }, width: 10, height: 20, image: new Uint8Array(800) });
    expect(old).toMatchObject({ format: 'rgba8888', width: 10, height: 20 });
    expect(old.data.length).toBe(800);
    expect(imageToFrame({ format: null, image: null })).toMatchObject({ format: 'png', width: 0, height: 0 });
    expect(imageToFrame({ format: { format: 'RGB888' } }).format).toBe('rgb888');
  });
});

describe('EmulatorGrpc against the fake gRPC server', () => {
  let fake: FakeSdk;
  let emu: RunningFakeEmulator;
  let secured: RunningFakeEmulator;
  const clients: EmulatorGrpc[] = [];
  const TOKEN = 'test-token-123';

  function client(port: number, token?: string): EmulatorGrpc {
    const c = EmulatorGrpc.create(port, token);
    clients.push(c);
    return c;
  }

  beforeAll(async () => {
    setEmulatorProtoPath(CORE_PROTO_PATH);
    fake = await createFakeSdk({ bootMs: 700 });
    [emu, secured] = await Promise.all([
      startFakeEmulator(fake),
      startFakeEmulator(fake, { env: { FAKE_GRPC_TOKEN: TOKEN, FAKE_BOOT_MS: '0' } }),
    ]);
  });
  afterAll(async () => {
    for (const c of clients) c.close();
    await Promise.all([emu?.stop(), secured?.stop()]);
    await fake?.cleanup();
  });

  it('getStatus: not booted first, booted after FAKE_BOOT_MS', async () => {
    const c = client(emu.grpcPort);
    const first = await c.getStatus();
    expect(first.version).toBe('37.1.11.0');
    expect(first.booted).toBe(false);
    expect(first.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(first.raw).toBeTruthy();
    const deadline = Date.now() + 5000;
    let status = first;
    while (!status.booted && Date.now() < deadline) {
      await sleep(100);
      status = await c.getStatus();
    }
    expect(status.booted).toBe(true);
    expect(status.uptimeMs).toBeGreaterThanOrEqual(700);
  });

  it('getScreenshot returns PNG bytes and the frame size', async () => {
    const c = client(emu.grpcPort);
    const full = await c.getScreenshot();
    expect(full.format).toBe('png');
    expect(full.data.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect([full.width, full.height]).toEqual([1280, 720]);
    const scaled = await c.getScreenshot({ width: 640 });
    expect([scaled.width, scaled.height]).toEqual([640, 360]);
    const raw = await c.getScreenshot({ width: 320, format: 'rgba8888' });
    expect(raw).toMatchObject({ format: 'rgba8888', width: 320, height: 180 });
    expect(raw.data.length).toBe(320 * 180 * 4);
    await expect(c.getScreenshot({ width: -1 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('full-size raw frames above the 4 MiB grpc default are received', async () => {
    const frame = await client(emu.grpcPort).getScreenshot({ width: 1280, height: 720, format: 'rgba8888' });
    expect(frame.data.length).toBe(1280 * 720 * 4);
  });

  it('sendTouch / sendKey / sendMouse reach the emulator', async () => {
    const c = client(emu.grpcPort);
    await c.sendTouch([{ x: 100.4, y: 200.6, id: 0, pressure: 1 }]);
    await c.sendTouch([{ x: 100, y: 200, id: 0, pressure: 0 }], 0);
    await c.sendKey({ key: 'GoBack' });
    await c.sendKey({ text: 'hello', eventType: 'keydown' });
    await c.sendMouse(5, 6, 1);
    await expect(c.sendKey({})).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(c.sendTouch([{ x: Number.NaN, y: 0, id: 0, pressure: 1 }])).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });

    const events = (await readInputLog(fake.inputLog)).filter((e) => e.port === emu.consolePort);
    const touches = events.filter((e) => e.type === 'touch').map((e) => e.request);
    expect(touches[0].touches[0]).toMatchObject({ x: 100, y: 201, identifier: 0, pressure: 1 });
    expect(touches[1].touches[0]).toMatchObject({ x: 100, y: 200, identifier: 0, pressure: 0 });
    const keys = events.filter((e) => e.type === 'key').map((e) => e.request);
    expect(keys[0]).toMatchObject({ key: 'GoBack', eventType: 'keypress' });
    expect(keys[1]).toMatchObject({ text: 'hello', eventType: 'keydown' });
    expect(events.find((e) => e.type === 'mouse')?.request).toMatchObject({ x: 5, y: 6, buttons: 1 });
  });

  it('setVmState / getVmState', async () => {
    const c = client(emu.grpcPort);
    expect(await c.getVmState()).toBe('RUNNING');
    await c.setVmState('PAUSED');
    expect(await c.getVmState()).toBe('PAUSED');
    await c.setVmState('RUNNING');
    expect(await c.getVmState()).toBe('RUNNING');
    await expect(c.setVmState('BOGUS' as never)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('streamScreenshot delivers frames and cancel() ends it once without error', async () => {
    const c = client(emu.grpcPort);
    const frames: ScreenFrame[] = [];
    let endCalls = 0;
    let endErr: Error | undefined;
    const sub = c.streamScreenshot(
      { width: 320 },
      (f) => frames.push(f),
      (err) => {
        endCalls++;
        endErr = err;
      },
    );
    const deadline = Date.now() + 5000;
    while (frames.length < 3 && Date.now() < deadline) await sleep(20);
    expect(frames.length).toBe(3);
    expect(frames.map((f) => f.seq)).toEqual([0, 1, 2]);
    expect(frames[0]).toMatchObject({ format: 'png', width: 320, height: 180 });
    sub.cancel();
    sub.cancel();
    await sleep(100);
    expect(endCalls).toBe(1);
    expect(endErr).toBeUndefined();
  });

  it('sends the bearer token when given; missing/wrong token is rejected', async () => {
    const ok = await client(secured.grpcPort, TOKEN).getStatus();
    expect(ok.booted).toBe(true);
    await expect(client(secured.grpcPort).getStatus()).rejects.toMatchObject({
      code: 'COMMAND_FAILED',
      message: expect.stringContaining('令牌'),
      details: expect.objectContaining({ grpcStatus: 'UNAUTHENTICATED' }),
    });
    await expect(client(secured.grpcPort, 'wrong').getScreenshot()).rejects.toMatchObject({ code: 'COMMAND_FAILED' });
    const endErr = await new Promise<Error | undefined>((resolve) => {
      client(secured.grpcPort).streamScreenshot({}, () => {}, resolve);
    });
    expect(endErr).toMatchObject({ code: 'COMMAND_FAILED' });
  });

  it('unreachable port: rejects quickly with a deadline', async () => {
    const t0 = Date.now();
    await expect(client(await getFreePort()).getStatus({ timeoutMs: 800 })).rejects.toMatchObject({
      code: 'COMMAND_FAILED',
    });
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it('close() makes further calls fail', async () => {
    const c = EmulatorGrpc.create(emu.grpcPort);
    await c.getStatus();
    c.close();
    await expect(c.getStatus()).rejects.toMatchObject({ message: expect.stringContaining('已关闭') });
  });

  it('setVmState SHUTDOWN stops the emulator', async () => {
    const victim = await startFakeEmulator(fake);
    try {
      await client(victim.grpcPort).setVmState('SHUTDOWN');
      expect(await waitForExit(victim.pid, 5000)).toBe(true);
      await expect(fsp.access(victim.discoveryFile)).rejects.toThrow();
    } finally {
      await victim.stop();
    }
  });
});

describe('proto path resolution order (fresh module, no override)', () => {
  it('AVDM_PROTO_PATH → ../proto next to the module → ./emulator_controller.proto', async () => {
    vi.resetModules();
    const mod = await import('../src/grpc.js');
    const prev = process.env.AVDM_PROTO_PATH;
    try {
      delete process.env.AVDM_PROTO_PATH;
      expect(mod.emulatorProtoCandidates()[0]).toBe(CORE_PROTO_PATH);
      expect(mod.resolveEmulatorProtoPath()).toBe(CORE_PROTO_PATH);

      process.env.AVDM_PROTO_PATH = '/custom/emulator_controller.proto';
      const candidates = mod.emulatorProtoCandidates();
      expect(candidates).toEqual([
        '/custom/emulator_controller.proto',
        CORE_PROTO_PATH,
        path.join(path.dirname(path.dirname(CORE_PROTO_PATH)), 'src', 'emulator_controller.proto'),
      ]);
      // a missing env path falls through to the next existing candidate
      expect(mod.resolveEmulatorProtoPath()).toBe(CORE_PROTO_PATH);

      mod.setEmulatorProtoPath('/override/emulator_controller.proto');
      expect(mod.emulatorProtoCandidates()).toEqual(['/override/emulator_controller.proto']);
    } finally {
      if (prev === undefined) delete process.env.AVDM_PROTO_PATH;
      else process.env.AVDM_PROTO_PATH = prev;
    }
  });
});
