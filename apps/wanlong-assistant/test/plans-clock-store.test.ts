import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { beijingDayStart, dueAt, inWindow } from '../src/main/plans/clock';
import { convertLegacyAccountPlan, convertLegacyScript } from '../src/main/plans/legacy';
import { PlanStore } from '../src/main/plans/store';
import { ScriptStore, validateScript } from '../src/main/plans/scripts';
import type { AccountPlan, ScriptDef } from '../src/main/plans/types';

const GAME = 'wanlong';
const PKG = 'com.lilithgames.samo.android.cn';
const ACCOUNT = '00000000-0000-4000-8000-000000000001';
const SCRIPT: ScriptDef = { id: 'test-script', name: '测试脚本', version: '1.0.0', packageName: PKG,
  refWidth: 100, refHeight: 100, steps: [{ id: 'tap-1', kind: 'tap', at: { x: 50, y: 50 } }], updatedAt: 0 };
const PLAN: AccountPlan = { accountId: ACCOUNT, enabled: true, updatedAt: 0, tasks: [{ id: 'task-1',
  scriptId: SCRIPT.id, enabled: true, trigger: { kind: 'daily', at: ['08:00'] }, priority: 50, maxRunMinutes: 30 }] };

describe('Beijing plan clock', () => {
  it('uses fixed UTC+8 across a Los Angeles daylight-saving change', () => {
    const morning = Date.parse('2026-03-08T00:00:00.000Z');
    expect(beijingDayStart(morning)).toBe(Date.parse('2026-03-07T16:00:00.000Z'));
    expect(dueAt({ kind: 'daily', at: ['08:00', '20:30'] }, morning, null, 0)).toBe(morning);
    expect(dueAt({ kind: 'daily', at: ['08:00', '20:30'] }, morning + 60_000, morning, 0)).toBeNull();
    expect(inWindow(Date.parse('2026-03-08T20:00:00.000Z'), { from: '22:00', to: '06:00' })).toBe(true);
  });

  it('never fires a manual task and waits for interval baseline', () => {
    expect(dueAt({ kind: 'manual' }, 3_600_000, null, 0)).toBeNull();
    expect(dueAt({ kind: 'interval', everyMinutes: 60 }, 3_599_999, null, 0)).toBeNull();
    expect(dueAt({ kind: 'interval', everyMinutes: 60 }, 3_600_000, null, 0)).toBe(3_600_000);
  });
});

describe('private plan and script documents', () => {
  const work: string[] = [];
  afterEach(async () => { await Promise.all(work.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
  async function home(): Promise<string> { const dir = await mkdtemp(path.join(tmpdir(), 'wanlong-plans-')); work.push(dir); return dir; }

  it('saves atomically, claims a due task only once, and keeps it disabled by default', async () => {
    const root = await home();
    const store = new PlanStore(root);
    expect((await store.overview(GAME)).config.enabled).toBe(false);
    await store.savePlan(GAME, PLAN);
    const at = Date.parse('2026-09-23T00:00:00.000Z'); // 08:00 Beijing
    const run = { runId: 'run-1', gameId: GAME, accountId: ACCOUNT, accountName: '账号', instanceIndex: 1,
      taskId: 'task-1', scriptId: SCRIPT.id, priority: 50, status: 'queued' as const, queuedAt: at,
      startedAt: null, endedAt: null, message: '排队', stepId: null };
    expect(await store.claimScheduled(GAME, ACCOUNT, 'task-1', run, at)).toBeNull();
    await store.saveConfig(GAME, { enabled: true });
    expect(await store.claimScheduled(GAME, ACCOUNT, 'task-1', run, at)).not.toBeNull();
    expect(await store.claimScheduled(GAME, ACCOUNT, 'task-1', { ...run, runId: 'run-2' }, at)).toBeNull();
    const file = path.join(root, 'automation', 'games', GAME, 'plans.json');
    expect(JSON.parse(await readFile(file, 'utf8')).runs).toHaveLength(1);
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it('rejects unsafe script content and keeps old data opt-in', async () => {
    const root = await home();
    const scripts = new ScriptStore(root);
    await scripts.save(GAME, PKG, SCRIPT);
    expect((await scripts.get(GAME, SCRIPT.id)).steps).toHaveLength(1);
    expect(validateScript({ ...SCRIPT, id: '../escape' }, PKG).some((i) => i.level === 'error')).toBe(true);
    // Chinese text is a warning now (it needs ADBKeyboard at run time), no longer a refusal.
    const chinese = validateScript({ ...SCRIPT, steps: [{ id: 'bad', kind: 'text', text: '中文' }] }, PKG);
    expect(chinese.some((i) => i.level === 'warn' && i.message.includes('ADBKeyboard'))).toBe(true);
    expect(chinese.some((i) => i.level === 'error')).toBe(false);
    const listed = await scripts.list(GAME, PKG);
    expect(listed.slice(0, 2).map((item) => item.id)).toEqual(['builtin_wait_tap', 'builtin_keep_alive']);
    expect(listed.find((item) => !item.builtin)?.name).toBe('测试脚本');
    await expect(scripts.save(GAME, PKG, { ...SCRIPT, id: 'builtin_mine' })).rejects.toThrow('内置脚本不可覆盖');
    await expect(scripts.remove(GAME, 'builtin_wait_tap')).rejects.toThrow('内置脚本不可删除');
    expect((await scripts.get(GAME, 'builtin_wait_tap', PKG)).packageName).toBe(PKG);
  });

  it('converts legacy loop and account plans without importing auto-enable or runtime counters', () => {
    // Script-level loop mode is supported again; a too-short gap is raised to 3 s.
    const converted = convertLegacyScript({ ...SCRIPT, loop: true, loopIntervalMs: 200 }, PKG);
    expect(converted.script.loop).toBe(true);
    expect(converted.script.loopIntervalMs).toBe(3000);
    expect(converted.warnings).toHaveLength(2);
    const old = { version: 1, config: { enabled: true }, plans: [{ ...PLAN, accountId: 'legacy-id',
      tasks: [{ ...PLAN.tasks[0], maxRunMinutes: 0 }] }], runtime: [{ runs: 999 }] };
    const next = convertLegacyAccountPlan(old, 'legacy-id', ACCOUNT);
    expect(next.plan.enabled).toBe(false);
    expect(next.plan.tasks[0]?.maxRunMinutes).toBe(120);
    expect(next.plan.accountId).toBe(ACCOUNT);
  });
});
