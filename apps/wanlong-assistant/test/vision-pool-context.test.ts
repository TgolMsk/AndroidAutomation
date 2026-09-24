import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RawFrame } from '@avdm/automation';
import { wanlongPlugin } from '@avdm/automation/wanlong';
import { defaultSchedulerConfig } from '@avdm/automation/wanlong/pure';
import { InstanceLocks } from '../src/main/scheduler/instance-lock';
import { VisionWorkerPool, type VisionDevice, type VisionJobContext, type VisionWorkerLike } from '../src/main/scheduler/vision-pool';
import type { VisionJobSpec } from '../src/main/scheduler/vision-protocol';

/**
 * A real worker thread speaking the vision protocol: every job hands one frame to main as "unrecognized", then
 * reports a sample result whose warning says whether main answered. Read-only queries are answered at any time —
 * also while the job awaits main — like the real worker does with its cached compiled set.
 * Real MessagePort delivery is what carries the worker's creation context.
 */
const WORKER_SOURCE = `
const { parentPort } = require('node:worker_threads');
let current = null;
let compiled = 0;
parentPort.on('message', (message) => {
  if (message.type === 'job') {
    current = message.jobId;
    parentPort.postMessage({ type: 'request', jobId: message.jobId, id: 1, op: 'unrecognized',
      args: [{ width: 1, height: 1, data: new Uint8Array(4), capturedAt: 0 }] });
  } else if (message.type === 'response' && message.jobId === current) {
    parentPort.postMessage({ type: 'result', jobId: message.jobId, result: { kind: 'sample', sample: {
      sampledAt: 0, queueUsed: 0, queueTotal: 5, rows: [], warnings: [message.ok ? 'answered:' + String(message.value) : 'refused'] } } });
  } else if (message.type === 'query') {
    compiled = compiled || 1;
    const q = message.query;
    const result = q.kind === 'recognize'
      ? { kind: 'recognize', recognized: q.frame.width === 2 && current !== null }
      : { kind: 'match', matches: q.templateIds.map((id) => ({ templateId: id, found: id === 'tpl_kicked', score: 0.95,
          x: 0, y: 0, w: 1, h: 1, centerX: 0, centerY: 0, threshold: q.threshold ?? 0.85, elapsedMs: 0 })) };
    parentPort.postMessage({ type: 'queryResult', queryId: message.queryId, ok: true, result });
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
    const spec: VisionJobSpec = {
      kind: 'sample', instanceIndex: 0, templateDir: home, config: defaultSchedulerConfig(), deadlineAt: Date.now() + 60_000, allowColdStart: false,
    };
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
    // A lock-free job creates the long-lived worker first.
    await pool.run(0, spec, ctx());
    expect(pool.size()).toBe(1);
    // A later sample runs inside the instance lock on the same worker.
    const result = await locks.run(0, '读取部队管理面板', () => pool.run(0, spec, ctx()));
    expect(result).toMatchObject({ kind: 'sample', sample: { warnings: ['answered:false'] } });
    expect(seen).toEqual([false, true]);
  });

  it('answers recognize / match queries from a hook the running job awaits, on the same worker (no CONCURRENCY_LIMIT)', async () => {
    const answers: unknown[] = [];
    const spec: VisionJobSpec = {
      kind: 'sample', instanceIndex: 0, templateDir: home, config: defaultSchedulerConfig(), deadlineAt: Date.now() + 60_000, allowColdStart: false,
    };
    const ctx: VisionJobContext = {
      device: {} as VisionDevice,
      packageName: wanlongPlugin.packageName,
      signal: new AbortController().signal,
      timeoutMs: 20_000,
      allowColdStart: false,
      approve: async () => { throw new Error('不允许输入'); },
      onUnrecognized: async (raw) => {
        // What the AI recover path (click, then re-check) and the kicked probe do from this hook.
        await expect(pool.run(0, spec, { ...ctx, onUnrecognized: undefined })).rejects.toMatchObject({ code: 'CONCURRENCY_LIMIT' });
        answers.push(await pool.query(0, { kind: 'recognize', templateDir: home, frame: { ...raw, width: 2 } }));
        answers.push(await pool.query(0, { kind: 'match', templateDir: home, frame: raw, templateIds: ['tpl_kicked', 'tpl_login'], threshold: 0.92 }));
        return 'recovered';
      },
    };
    const result = await pool.run(0, spec, ctx);
    expect(result).toMatchObject({ kind: 'sample', sample: { warnings: ['answered:recovered'] } });
    expect(answers).toEqual([
      { kind: 'recognize', recognized: true },
      { kind: 'match', matches: [expect.objectContaining({ templateId: 'tpl_kicked', found: true, threshold: 0.92 }), expect.objectContaining({ templateId: 'tpl_login', found: false })] },
    ]);
    expect(pool.size()).toBe(1);
    // Outside any job the same worker answers too.
    await expect(pool.query(0, { kind: 'recognize', templateDir: home, frame: frame() })).resolves.toEqual({ kind: 'recognize', recognized: false });
  });

  it('rejects pending queries when the worker dies and honours the caller signal', async () => {
    const silent = new VisionWorkerPool({ workerFactory: () => new Worker(`require('node:worker_threads').parentPort.on('message', () => {});`, { eval: true }) as unknown as VisionWorkerLike });
    try {
      const controller = new AbortController();
      const asked = silent.query(0, { kind: 'recognize', templateDir: home, frame: frame() }, controller.signal);
      controller.abort(new Error('不等了'));
      await expect(asked).rejects.toThrow('不等了');
      const pending = silent.query(0, { kind: 'recognize', templateDir: home, frame: frame() });
      await silent.dispose();
      await expect(pending).rejects.toThrow('视觉工作线程已退出');
    } finally {
      await silent.dispose();
    }
  });
});
