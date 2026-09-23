import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PlanService } from '../src/main/plans';
import type { GameAccount } from '../src/main/automation/accounts/types';
import type { PlanHostPort, ScriptDef } from '../src/main/plans/types';

const GAME = 'wanlong';
const PKG = 'com.lilithgames.samo.android.cn';
const ACCOUNT = '00000000-0000-4000-8000-000000000001';
const account: GameAccount = { id: ACCOUNT, gameId: GAME, packageName: PKG, name: '测试账号', server: '', role: '', note: '',
  enabled: true, binding: { index: 1, instanceCreatedAt: 'identity-1' }, login: { status: 'ready', attemptId: null, verifiedAt: 1 },
  createdAt: 1, updatedAt: 1 };
const script: ScriptDef = { id: 'tap-once', name: '点击一次', version: '1.0.0', packageName: PKG, refWidth: 100, refHeight: 100,
  updatedAt: 0, steps: [{ id: 'tap-1', kind: 'tap', at: { x: 50, y: 50 } }] };

async function eventually(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('运行未在 1 秒内结束');
}

describe('PlanService integration with fake device', () => {
  const homes: string[] = [];
  const services: PlanService[] = [];
  afterEach(async () => {
    await Promise.all(services.splice(0).map((service) => service.shutdown()));
    await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
  });

  async function setup(schedule: () => boolean, tap?: (x: number, y: number) => Promise<void>) {
    const home = await mkdtemp(path.join(tmpdir(), 'wanlong-plan-service-'));
    homes.push(home);
    const actions: string[] = [];
    const port: PlanHostPort = {
      accounts: async () => [account],
      instance: async () => ({ status: 'running', record: { createdAt: 'identity-1' } }),
      templateDir: async () => '',
      gatherScheduleEnabled: async () => schedule(),
      device: async () => ({
        screencapRaw: async () => ({ width: 200, height: 200, data: new Uint8Array(200 * 200 * 4), capturedAt: Date.now() }),
        screencapPng: async () => new Uint8Array([1]),
        foregroundPackage: async () => PKG,
        tap: async (x, y) => { actions.push(`${x},${y}`); await tap?.(x, y); },
        swipe: async () => undefined,
        keyevent: async () => undefined,
        text: async () => undefined,
        startApp: async () => undefined,
        stopApp: async () => undefined,
        shell: async () => '',
      }),
    };
    const service = new PlanService(home, port);
    services.push(service);
    await service.start(GAME);
    await service.saveScript(GAME, script);
    await service.savePlan(GAME, { accountId: ACCOUNT, enabled: false, updatedAt: 0,
      tasks: [{ id: 'task-1', scriptId: script.id, enabled: true, trigger: { kind: 'manual' }, priority: 50, maxRunMinutes: 1 }] });
    return { service, actions, home, port };
  }

  it('runs a manual script through the shared instance lease and records success', async () => {
    const { service, actions } = await setup(() => false);
    const run = await service.runNow(GAME, ACCOUNT, 'task-1');
    await eventually(async () => (await service.overview(GAME)).runs.find((row) => row.runId === run.runId)?.status === 'succeeded');
    await eventually(async () => !service.isActiveForInstance(1));
    expect(actions).toEqual(['100,100']);
    expect((await service.overview(GAME)).runtime[0]?.runs).toBe(1);
    expect(service.isActiveForInstance(1)).toBe(false);
  });

  it('refuses script input while gather scheduling is enabled', async () => {
    const { service, actions } = await setup(() => true);
    await expect(service.runNow(GAME, ACCOUNT, 'task-1')).rejects.toThrow('自动采集');
    expect(actions).toEqual([]);
  });

  it.each([
    ['disabled', (current: GameAccount) => { current.enabled = false; }],
    ['login reset', (current: GameAccount) => { current.login.status = 'pending'; }],
    ['rebound index', (current: GameAccount) => { current.binding!.index = 2; }],
    ['replaced AVD identity', (current: GameAccount) => { current.binding!.instanceCreatedAt = 'identity-2'; }],
  ] as const)('stops before the next input when account becomes %s', async (_name, change) => {
    const current = structuredClone(account);
    let firstTap = true;
    const { service, actions, port } = await setup(() => false, async () => {
      if (firstTap) { firstTap = false; change(current); }
    });
    port.accounts = async () => [current];
    await service.saveScript(GAME, { ...script, steps: [
      { id: 'tap-1', kind: 'tap', at: { x: 50, y: 50 } },
      { id: 'tap-2', kind: 'tap', at: { x: 60, y: 60 }, retry: 2, onFail: { kind: 'continue' } },
    ] });
    const run = await service.runNow(GAME, ACCOUNT, 'task-1');
    await eventually(async () => (await service.overview(GAME)).runs.find((row) => row.runId === run.runId)?.status === 'failed');
    expect(actions).toEqual(['100,100']);
    expect((await service.overview(GAME)).runs.find((row) => row.runId === run.runId)?.message).toContain('账号已禁用');
  });

  it('cancels a long retry delay promptly and releases the instance', async () => {
    const { service, actions } = await setup(() => false, async () => { throw new Error('fake adb failure'); });
    await service.saveConfig(GAME, { retry: 1, retryDelayMs: 30 * 60_000 });
    const run = await service.runNow(GAME, ACCOUNT, 'task-1');
    await eventually(async () => actions.length === 1);
    const started = Date.now();
    await service.cancelRun(GAME, run.runId);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect((await service.overview(GAME)).runs.find((row) => row.runId === run.runId)?.status).toBe('cancelled');
    expect(service.isActiveForInstance(1)).toBe(false);
    expect(actions).toHaveLength(1);
  });

  it('only the scheduler lease owner may evaluate due tasks after another process edits plans', async () => {
    const { service: owner, home, port, actions } = await setup(() => false);
    const second = new PlanService(home, port);
    services.push(second);
    await second.start(GAME); // contended: read/edit access remains, timed execution belongs to owner.
    const nowBeijing = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(11, 16);
    await second.savePlan(GAME, { accountId: ACCOUNT, enabled: true, updatedAt: 0,
      tasks: [{ id: 'task-1', scriptId: script.id, enabled: true,
        trigger: { kind: 'daily', at: [nowBeijing] }, priority: 50, maxRunMinutes: 1 }] });
    await second.saveConfig(GAME, { enabled: true });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await owner.overview(GAME)).runs).toHaveLength(0);
    expect(actions).toHaveLength(0);
    await expect(second.runNow(GAME, ACCOUNT, 'task-1')).rejects.toThrow('另一个万龙助手进程');
  });
});
