import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MatchResult, PreparedFrame, PreparedTemplate, RawFrame, TemplateDefinition } from '@avdm/automation';
import { PlanService, ScriptRunner } from '../src/main/plans';
import type { ScriptExecuteOptions } from '../src/main/plans/script-runner';
import type { ScriptWorkerDeps } from '../src/main/plans/script-worker-core';
import type { GameAccount } from '../src/main/automation/accounts/types';
import type { PlanHostPort, ScriptDef } from '../src/main/plans/types';
import { eventually, FAST_PACING, fakeScriptDevice, inProcessWorkers, PKG, writeTemplateSet } from './helpers/script-worker';

/**
 * App settings `matchThreshold` / `shrink` reach script matching through the new executor path:
 * PlanHostPort.matchDefaults → PlanService → ScriptRunner.run({ matchDefaults }) → script worker (template compile + frames).
 */
const RUN = '00000000-0000-4000-8000-0000000000d1';
const ACCOUNT = '00000000-0000-4000-8000-000000000001';

const script: ScriptDef = { id: 'match-defaults', name: '匹配默认值', version: '1.0.0', packageName: PKG, refWidth: 100, refHeight: 100,
  updatedAt: 0, steps: [
    { id: 'a', kind: 'tapTemplate', templateId: 'tpl_plain' },
    { id: 'b', kind: 'tapTemplate', templateId: 'tpl_own' },
  ] };

/** Records what the worker compiled and prepared; every template is found. */
function spyVision() {
  const templates: Array<[id: string, threshold: number | undefined, shrink: number | undefined]> = [];
  const frames: Array<number | undefined> = [];
  const vision: NonNullable<ScriptWorkerDeps['vision']> = {
    async prepareFrame(raw: RawFrame, options: { refWidth: number; refHeight: number; shrink?: number }): Promise<PreparedFrame> {
      frames.push(options.shrink);
      return { gray: new Uint8Array(1), width: 1, height: 1, w: 1, h: 1, shrink: options.shrink ?? 2, refWidth: options.refWidth,
        refHeight: options.refHeight, deviceWidth: raw.width, deviceHeight: raw.height, capturedAt: raw.capturedAt };
    },
    async prepareTemplate(_image: Uint8Array, definition: TemplateDefinition, _set: unknown, shrink?: number): Promise<PreparedTemplate> {
      templates.push([definition.id, definition.threshold, shrink]);
      return { id: definition.id, name: definition.name, gray: new Uint8Array(9), width: 3, height: 3, w: 3, h: 3, refWidth: 6, refHeight: 6,
        refW: 6, refH: 6, shrink: shrink ?? 2, threshold: definition.threshold ?? 0.85, std: 40 };
    },
    async match(_frame: PreparedFrame, template: PreparedTemplate): Promise<MatchResult> {
      return { templateId: template.id, found: true, score: 0.99, x: 47, y: 47, w: 6, h: 6, centerX: 50, centerY: 50,
        threshold: template.threshold, elapsedMs: 1 };
    },
  };
  return { vision, templates, frames };
}

let home: string;
let dir: string;
beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'wanlong-match-defaults-'));
  dir = await writeTemplateSet(path.join(home, 'set'), ['tpl_plain', 'tpl_own']);
  // tpl_own carries its own threshold; tpl_plain has none.
  const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')) as { templates: Array<Record<string, unknown>> };
  manifest.templates[1]!['threshold'] = 0.95;
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

function runnerWith(vision: NonNullable<ScriptWorkerDeps['vision']>) {
  const device = fakeScriptDevice();
  const workers = inProcessWorkers({ vision });
  const runner = new ScriptRunner(home, {
    instance: async () => ({ status: 'running', record: { createdAt: 'identity-1' } }),
    device: async () => device,
  }, { workerFactory: workers.factory, pacing: FAST_PACING, foregroundPollMs: 5 });
  return { runner, device, workers };
}

function options(extra: Partial<ScriptExecuteOptions> = {}): ScriptExecuteOptions {
  return {
    runId: RUN, gameId: 'wanlong', packageName: PKG, instanceIndex: 1, instanceIdentity: 'identity-1', script, params: {},
    accountId: null, accountName: null, source: 'manual', taskId: null, templateDir: dir, shotPolicy: 'never', maxRunMs: 60_000, ...extra,
  };
}

describe('script matching uses the app settings defaults (matchThreshold / shrink)', () => {
  it('applies the default threshold only to templates without their own, and the configured shrink to frame and template', async () => {
    const spy = spyVision();
    const { runner, device, workers } = runnerWith(spy.vision);
    const result = await runner.run(options({ matchDefaults: { threshold: 0.77, shrink: 3 } }));
    expect(result.status).toBe('succeeded');
    expect(device.actions.filter((action) => action.startsWith('tap:'))).toHaveLength(2);
    expect(spy.templates).toEqual([['tpl_plain', 0.77, 3], ['tpl_own', 0.95, 3]]);
    expect(spy.frames.length).toBeGreaterThan(0);
    expect(spy.frames.every((shrink) => shrink === 3)).toBe(true);
    expect(workers.created[0]?.received.find((message) => message.type === 'ready')).toMatchObject({ shrink: 3 });
  });

  it('keeps the vision defaults when no settings are given (and ignores invalid values)', async () => {
    for (const matchDefaults of [undefined, { threshold: 7, shrink: 9 }]) {
      const spy = spyVision();
      const { runner } = runnerWith(spy.vision);
      const result = await runner.run(options(matchDefaults ? { matchDefaults } : {}));
      expect(result.status).toBe('succeeded');
      expect(spy.templates).toEqual([['tpl_plain', undefined, 2], ['tpl_own', 0.95, 2]]);
      expect(spy.frames.every((shrink) => shrink === 2)).toBe(true);
    }
  });

  it('PlanService hands PlanHostPort.matchDefaults to plan and manual runs', async () => {
    const account: GameAccount = { id: ACCOUNT, gameId: 'wanlong', packageName: PKG, name: '测试账号', server: '', role: '', note: '',
      enabled: true, binding: { index: 1, instanceCreatedAt: 'identity-1' }, login: { status: 'ready', attemptId: null, verifiedAt: 1 },
      createdAt: 1, updatedAt: 1 };
    const device = fakeScriptDevice();
    let defaults: ReturnType<NonNullable<PlanHostPort['matchDefaults']>> = { threshold: 0.9, shrink: 1 };
    const port: PlanHostPort = {
      accounts: async () => [account],
      instance: async () => ({ status: 'running', record: { createdAt: 'identity-1' } }),
      templateDir: async () => dir,
      gatherScheduleEnabled: async () => false,
      device: async () => device,
      matchDefaults: async () => defaults,
    };
    const spy = spyVision();
    const runner = new ScriptRunner(home, port, { workerFactory: inProcessWorkers({ vision: spy.vision }).factory, pacing: FAST_PACING, foregroundPollMs: 5 });
    const run = vi.spyOn(runner, 'run');
    const service = new PlanService(home, port, runner);
    try {
      await service.start('wanlong');
      await service.saveScript('wanlong', script);
      await service.savePlan('wanlong', { accountId: ACCOUNT, enabled: false, updatedAt: 0,
        tasks: [{ id: 'task-1', scriptId: script.id, enabled: true, trigger: { kind: 'manual' }, priority: 50, maxRunMinutes: 1 }] });
      const queued = await service.runNow('wanlong', ACCOUNT, 'task-1');
      await eventually(async () => (await service.overview('wanlong')).runs.find((row) => row.runId === queued.runId)?.status === 'succeeded');
      await eventually(() => !service.isActiveForInstance(1));
      expect(run.mock.calls[0]?.[0].matchDefaults).toEqual({ threshold: 0.9, shrink: 1 });
      expect(spy.templates).toEqual([['tpl_plain', 0.9, 1], ['tpl_own', 0.95, 1]]);

      defaults = { threshold: 0.8, shrink: 4 };
      const manual = await service.runScript('wanlong', 1, script.id);
      await eventually(() => service.listRuns('wanlong').find((item) => item.runId === manual.runId)?.status === 'succeeded');
      await eventually(() => !service.isActiveForInstance(1));
      expect(run.mock.calls[1]?.[0].matchDefaults).toEqual({ threshold: 0.8, shrink: 4 });

      // An out-of-range value from the port is not handed on: the worker keeps the vision defaults.
      defaults = { threshold: 0.8, shrink: 2.5 };
      const invalid = await service.runScript('wanlong', 1, script.id);
      await eventually(() => service.listRuns('wanlong').find((item) => item.runId === invalid.runId)?.status === 'succeeded');
      expect(run.mock.calls[2]?.[0].matchDefaults).toBeUndefined();
    } finally {
      await service.shutdown();
    }
  });
});
