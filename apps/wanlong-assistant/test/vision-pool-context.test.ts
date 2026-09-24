import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RawFrame } from '@avdm/automation';
import { wanlongPlugin } from '@avdm/automation/wanlong';
import { InstanceLocks } from '../src/main/scheduler/instance-lock';
import { VisionWorkerPool, type VisionDevice, type VisionJobContext, type VisionWorkerLike } from '../src/main/scheduler/vision-pool';
import type { VisionJobSpec } from '../src/main/scheduler/vision-protocol';

/**
 * A real worker thread speaking the vision protocol: every job hands one frame to main as "unrecognized", then
 * reports a recognize result. Real MessagePort delivery is what carries the worker's creation context.
 */
const WORKER_SOURCE = `
const { parentPort } = require('node:worker_threads');
let current = null;
parentPort.on('message', (message) => {
  if (message.type === 'job') {
    current = message.jobId;
    parentPort.postMessage({ type: 'request', jobId: message.jobId, id: 1, op: 'unrecognized',
      args: [{ width: 1, height: 1, data: new Uint8Array(4), capturedAt: 0 }] });
  } else if (message.type === 'response' && message.jobId === current) {
    parentPort.postMessage({ type: 'result', jobId: message.jobId, result: { kind: 'recognize', recognized: message.ok } });
  }
});
`;

const frame = (): RawFrame => ({ width: 1, height: 1, data: new Uint8Array(4), capturedAt: 0 });

describe('VisionWorkerPool async context', () => {
  let home: string;
  let pool: VisionWorkerPool;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'avdm-vision-pool-'));
    pool = new VisionWorkerPool({ workerFactory: () => new Worker(WORKER_SOURCE, { eval: true }) as unknown as VisionWorkerLike });
  });

  afterEach(async () => {
    await pool.dispose();
    await rm(home, { recursive: true, force: true });
  });

  it('runs worker-originated hooks in the job\'s lock context even when the worker was created outside the lock', async () => {
    const locks = new InstanceLocks(home, { fileLock: async (_path, fn) => fn() });
    const seen: boolean[] = [];
    const spec: VisionJobSpec = { kind: 'recognize', instanceIndex: 0, templateDir: home, frame: frame() };
    const ctx = (): VisionJobContext => ({
      device: {} as VisionDevice,
      packageName: wanlongPlugin.packageName,
      signal: new AbortController().signal,
      timeoutMs: 20_000,
      allowColdStart: false,
      approve: async () => { throw new Error('识别任务不允许输入'); },
      onUnrecognized: async () => {
        seen.push(locks.held(0));
        // What an AI click / kicked probe does from this hook: exclusive() re-enters instead of queueing behind
        // the very sample that awaits this hook (a deadlock until the 30-minute hook cap).
        if (locks.held(0)) await locks.run(0, 'AI 点击', async () => undefined);
        return false;
      },
    });
    // A lock-free recognize job (AI verification, freeze recovery) creates the long-lived worker first.
    await pool.run(0, spec, ctx());
    expect(pool.size()).toBe(1);
    // A later sample runs inside the instance lock on the same worker.
    const result = await locks.run(0, '读取部队管理面板', () => pool.run(0, spec, ctx()));
    expect(result).toEqual({ kind: 'recognize', recognized: true });
    expect(seen).toEqual([false, true]);
  });
});
