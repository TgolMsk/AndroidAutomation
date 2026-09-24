import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AvdManager } from '@avdm/core';
import { ScriptRunner } from '../../src/main/plans/script-runner';
import { inProcessWorkers, PKG } from '../helpers/script-worker';

/**
 * Live smoke check on a real AVD (original scripts/smoke.ts §5), skipped unless WANLONG_LIVE_INDEX names a running
 * instance with the game in the foreground. It only captures, keeps one trace shot and presses HOME — no taps
 * on game content. Run: `WANLONG_LIVE_INDEX=0 pnpm --filter @avdm/wanlong-assistant exec vitest run test/live`.
 */
const LIVE_INDEX = process.env.WANLONG_LIVE_INDEX;

describe.skipIf(!LIVE_INDEX)('live script smoke (real AVD)', () => {
  it('runs log → screenshot → HOME through the worker executor', async () => {
    const index = Number(LIVE_INDEX);
    const manager = await AvdManager.open();
    const home = await mkdtemp(path.join(tmpdir(), 'wanlong-live-smoke-'));
    try {
      const state = await manager.getState(index);
      expect(state.status).toBe('running');
      const runner = new ScriptRunner(home, { instance: (i) => manager.getState(i), device: (i) => manager.device(i) },
        { workerFactory: inProcessWorkers().factory });
      const result = await runner.execute({
        runId: '00000000-0000-4000-8000-00000000feed', gameId: 'wanlong', packageName: PKG, instanceIndex: index,
        instanceIdentity: state.record.createdAt, params: {}, accountId: null, accountName: null, source: 'manual', taskId: null,
        templateDir: null, shotPolicy: 'onFail', maxRunMs: 120_000,
        script: { id: 'smoke', name: '冒烟', version: '1.0.0', packageName: PKG, refWidth: 2560, refHeight: 1440, updatedAt: 0, steps: [
          { id: 'begin', kind: 'log', level: 'info', message: '冒烟开始' },
          { id: 'shot', kind: 'screenshot', label: 'smoke' },
          { id: 'home', kind: 'key', key: 'HOME' },
          { id: 'end', kind: 'log', level: 'info', message: '冒烟结束' },
        ] },
      });
      expect(result.status).toBe('succeeded');
      expect(await runner.logs.listShots('wanlong', result.runId)).toHaveLength(1);
      expect((await runner.logs.query('wanlong', { runId: result.runId })).some((line) => line.message === '冒烟结束')).toBe(true);
    } finally {
      await manager.dispose();
      await rm(home, { recursive: true, force: true });
    }
  }, 180_000);
});
