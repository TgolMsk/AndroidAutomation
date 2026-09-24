/** The login preview is encoded off the main thread by a long-lived worker (DECISIONS A.6), with a fake worker. */
import { afterEach, describe, expect, it } from 'vitest';
import { Worker } from 'node:worker_threads';
import { LoginPreviewEncoder } from '../src/main/automation/accounts/login-preview';

// Mirrors login-preview-worker's protocol: halves the size; width 13 fails, width 99 crashes the worker.
const FAKE = `
const { parentPort } = require('node:worker_threads');
parentPort.on('message', (m) => {
  if (m.width === 99) process.exit(3);
  if (m.width === 13) return parentPort.postMessage({ id: m.id, ok: false });
  const jpeg = new Uint8Array([m.data.length % 256, m.maxWidth % 256, m.quality]);
  parentPort.postMessage({ id: m.id, ok: true, jpeg, width: m.width / 2, height: m.height / 2 }, [jpeg.buffer]);
});`;

const frame = (width: number) => ({ width, height: 8, data: new Uint8Array(width * 8 * 4), capturedAt: 1 });
const encoders: LoginPreviewEncoder[] = [];

function encoder(spawned: Worker[], options: { idleMs?: number } = {}): LoginPreviewEncoder {
  const created = new LoginPreviewEncoder({
    ...options, maxWidth: 960, quality: 70,
    spawn: () => { const worker = new Worker(FAKE, { eval: true }); spawned.push(worker); return worker; },
  });
  encoders.push(created);
  return created;
}

afterEach(async () => { await Promise.all(encoders.splice(0).map((item) => item.dispose())); });

describe('login preview encoder', () => {
  it('encodes in one reused worker, maps failures to a fixed message and respawns after a crash', async () => {
    const spawned: Worker[] = [];
    const service = encoder(spawned);
    const source = frame(40);
    await expect(service.encode(source)).resolves.toMatchObject({ width: 20, height: 4, jpeg: new Uint8Array([(40 * 8 * 4) % 256, 960 % 256, 70]) });
    expect(source.data.byteLength).toBe(40 * 8 * 4); // the caller's frame is copied, never detached
    await Promise.all([service.encode(frame(10)), service.encode(frame(20))]);
    expect(spawned).toHaveLength(1);
    await expect(service.encode(frame(13))).rejects.toThrow('画面编码失败');
    await expect(service.encode(frame(99))).rejects.toThrow('画面编码失败');
    await expect(service.encode(frame(10))).resolves.toMatchObject({ width: 5 });
    expect(spawned).toHaveLength(2);
  });

  it('stops the idle worker and refuses work after dispose', async () => {
    const spawned: Worker[] = [];
    const service = encoder(spawned, { idleMs: 20 });
    await service.encode(frame(10));
    const exited = new Promise<number>((resolve) => spawned[0]!.once('exit', resolve));
    await exited;
    await service.encode(frame(10));
    expect(spawned).toHaveLength(2);
    await service.dispose();
    await expect(service.encode(frame(10))).rejects.toThrow('应用正在退出');
  });
});
