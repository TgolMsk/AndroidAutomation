import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { beijingDayStart, inWindow } from '../src/main/plans/clock';
import { convertLegacyAccountPlan, convertLegacyConfig, convertLegacyScript } from '../src/main/plans/legacy';
import { PlanStore, validatePlan } from '../src/main/plans/store';
import { ScriptStore, validateScript } from '../src/main/plans/scripts';
import type { AccountPlan, PlanRun, ScriptDef } from '../src/main/plans/types';

const GAME = 'wanlong';
const PKG = 'com.lilithgames.samo.android.cn';
const ACCOUNT = '00000000-0000-4000-8000-000000000001';
const ACCOUNT_2 = '00000000-0000-4000-8000-000000000002';
const SCRIPT: ScriptDef = { id: 'test-script', name: '测试脚本', version: '1.0.0', packageName: PKG,
  refWidth: 100, refHeight: 100, steps: [{ id: 'tap-1', kind: 'tap', at: { x: 50, y: 50 } }], updatedAt: 0 };
const PLAN: AccountPlan = { accountId: ACCOUNT, enabled: true, updatedAt: 0, tasks: [{ id: 'task-1',
  scriptId: SCRIPT.id, enabled: true, trigger: { kind: 'daily', at: ['08:00'] }, priority: 50, maxRunMinutes: 30 }] };
const run = (runId: string, at: number): PlanRun => ({ runId, gameId: GAME, accountId: ACCOUNT, accountName: '账号', instanceIndex: 1,
  taskId: 'task-1', scriptId: SCRIPT.id, priority: 50, status: 'queued', queuedAt: at, startedAt: null, endedAt: null, message: '排队', stepId: null });

describe('store-side clock checks', () => {
  it('uses fixed UTC+8 across a Los Angeles daylight-saving change and rejects invalid windows', () => {
    const morning = Date.parse('2026-03-08T00:00:00.000Z');
    expect(beijingDayStart(morning)).toBe(Date.parse('2026-03-07T16:00:00.000Z'));
    expect(inWindow(Date.parse('2026-03-08T20:00:00.000Z'), { from: '22:00', to: '06:00' })).toBe(true);
    expect(inWindow(morning, { from: 'x', to: '06:00' })).toBe(false);
  });
});

describe('private plan and script documents', () => {
  const work: string[] = [];
  afterEach(async () => { await Promise.all(work.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
  async function home(): Promise<string> { const dir = await mkdtemp(path.join(tmpdir(), 'wanlong-plans-')); work.push(dir); return dir; }
  const fileOf = (root: string) => path.join(root, 'automation', 'games', GAME, 'plans.json');
  async function writeRaw(root: string, text: string): Promise<void> {
    await mkdir(path.dirname(fileOf(root)), { recursive: true });
    await writeFile(fileOf(root), text);
  }

  it('saves atomically, claims a due task only once, and keeps it disabled by default', async () => {
    const root = await home();
    const store = new PlanStore(root);
    expect((await store.overview(GAME)).config.enabled).toBe(false);
    await store.savePlan(GAME, PLAN);
    const at = Date.parse('2026-09-23T00:00:00.000Z'); // 08:00 Beijing
    expect(await store.claimScheduled(GAME, ACCOUNT, 'task-1', run('run-1', at), at)).toBeNull();
    await store.saveConfig(GAME, { enabled: true });
    const claimed = await store.claimScheduled(GAME, ACCOUNT, 'task-1', run('run-1', at), at);
    expect(claimed).toMatchObject({ message: '到点（每天 08:00）', origin: 'schedule', attempt: 1 });
    expect(await store.claimScheduled(GAME, ACCOUNT, 'task-1', run('run-2', at), at)).toBeNull();
    const file = fileOf(root);
    const raw = JSON.parse(await readFile(file, 'utf8'));
    expect(raw.runs).toHaveLength(1);
    expect(raw.runtime[0].lastClaimedAt).toBe(at);
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it('★ claims an overdue interval after a long downtime, and applies catch-up to daily tasks only', async () => {
    const root = await home();
    const store = new PlanStore(root);
    await store.savePlan(GAME, { ...PLAN, tasks: [{ ...PLAN.tasks[0]!, id: 'hourly', trigger: { kind: 'interval', everyMinutes: 60 } }] });
    await store.saveConfig(GAME, { enabled: true, catchUpMs: 60_000 });
    const t0 = Date.parse('2026-09-23T04:00:00.000Z');
    // Never ran: fires at once (original), not everyMinutes after the last save.
    expect(await store.claimScheduled(GAME, ACCOUNT, 'hourly', { ...run('a', t0), taskId: 'hourly' }, t0)).not.toBeNull();
    expect(await store.claimScheduled(GAME, ACCOUNT, 'hourly', { ...run('b', t0), taskId: 'hourly' }, t0 + 30 * 60_000)).toBeNull();
    // Three hours of downtime, far beyond the one-minute catch-up window: due once, never stalled.
    const late = t0 + 3 * 3_600_000;
    expect(await store.claimScheduled(GAME, ACCOUNT, 'hourly', { ...run('c', late), taskId: 'hourly' }, late)).not.toBeNull();
    expect(await store.claimScheduled(GAME, ACCOUNT, 'hourly', { ...run('d', late), taskId: 'hourly' }, late + 1000)).toBeNull();
  });

  it('keeps the runtime across restarts, counts runs and failures, and ignores a cancel before the start', async () => {
    const root = await home();
    const store = new PlanStore(root);
    await store.savePlan(GAME, PLAN);
    await store.addRun(GAME, run('r1', 1));
    await store.updateRun(GAME, 'r1', { status: 'cancelled', endedAt: 2, message: '用户取消排队' });
    let rt = (await store.overview(GAME)).runtime;
    expect(rt).toEqual([]);
    await store.addRun(GAME, run('r2', 3));
    await store.updateRun(GAME, 'r2', { status: 'running', startedAt: 4 });
    await store.updateRun(GAME, 'r2', { status: 'failed', endedAt: 5, message: '模板没找到' });
    await store.addRun(GAME, run('r3', 6));
    await store.updateRun(GAME, 'r3', { status: 'running', startedAt: 7 });
    await store.updateRun(GAME, 'r3', { status: 'succeeded', endedAt: 8, message: '脚本执行完成' });
    rt = (await new PlanStore(root).overview(GAME)).runtime;
    expect(rt[0]).toMatchObject({ lastStartedAt: 7, lastEndedAt: 8, lastResult: 'succeeded', lastError: null, runs: 2, fails: 1 });
    const text = await readFile(fileOf(root), 'utf8');
    expect(text).toContain(`"accountId": "${ACCOUNT}"`);
  });

  it('§二 a missing file gives the defaults; broken JSON is repaired, backed up and explained (never throws)', async () => {
    const root = await home();
    const warned: string[] = [];
    const store = new PlanStore(root, (message) => warned.push(message));
    expect((await store.overview(GAME)).config).toMatchObject({ enabled: false, retry: 1, aiAssist: true });
    await writeRaw(root, '{ 这不是 JSON');
    const broken = await store.overview(GAME);
    expect(broken.plans).toEqual([]);
    expect(store.warnings(GAME)[0]).toContain('不是合法 JSON');
    expect(warned[0]).toContain('不是合法 JSON');
    // The next write repairs the file and keeps the broken original next to it.
    await store.recoverInterrupted(GAME);
    const files = await readdir(path.dirname(fileOf(root)));
    const backup = files.find((name) => name.startsWith('plans.json.corrupt-'));
    expect(backup).toBeDefined();
    expect(await readFile(path.join(path.dirname(fileOf(root)), backup!), 'utf8')).toBe('{ 这不是 JSON');
    if (process.platform !== 'win32') expect((await stat(path.join(path.dirname(fileOf(root)), backup!))).mode & 0o777).toBe(0o600);
    expect(store.warnings(GAME).some((w) => w.includes('已备份为'))).toBe(true);
    expect(JSON.parse(await readFile(fileOf(root), 'utf8')).version).toBe(1);
  });

  it('§二 a hand-edited file is repaired field by field like the original loader', async () => {
    const root = await home();
    const store = new PlanStore(root, () => undefined);
    await writeRaw(root, JSON.stringify({
      version: 1,
      config: { version: 1, enabled: true, retry: 999, preemptGraceMs: -5, catchUpMs: 60_000, queueWaitMs: 60_000, retryDelayMs: 0 },
      plans: [
        { accountId: ACCOUNT, enabled: true, tasks: [
          { id: 't1', scriptId: 's1', enabled: true, trigger: { kind: 'daily', at: ['25:00'] } },
          { id: 't1', scriptId: 's2', enabled: true, trigger: { kind: 'manual' } },
          { id: 't2', scriptId: 's3', enabled: true, trigger: { kind: 'interval', everyMinutes: 99999 } },
          { scriptId: 's4' },
        ] },
        { accountId: ACCOUNT, enabled: false, tasks: [] },
        { enabled: true, tasks: [] },
        { accountId: 'not-a-uuid', enabled: true, tasks: [] },
      ],
      runtime: [{ accountId: ACCOUNT, taskId: 't2', lastRunAt: 1_700_000_000_000, lastResult: 'aborted', runs: 3, fails: 1 }, { bad: true }],
      runs: [{ runId: 'broken' }],
    }));
    const messy = await store.overview(GAME);
    expect(messy.config).toMatchObject({ retry: 5, preemptGraceMs: 0, enabled: true, aiAssist: true, maxConcurrentScripts: 4 });
    expect(messy.plans).toHaveLength(1);
    const plan = messy.plans[0]!;
    expect(plan.tasks.filter((t) => t.id === 't1')).toHaveLength(1);
    expect(plan.tasks.some((t) => t.scriptId === 's4')).toBe(false);
    expect(plan.tasks.find((t) => t.id === 't1')?.trigger.kind).toBe('manual');
    expect(plan.tasks.find((t) => t.id === 't2')?.trigger).toEqual({ kind: 'interval', everyMinutes: 1440 });
    expect(messy.runtime).toEqual([expect.objectContaining({ taskId: 't2', lastStartedAt: 1_700_000_000_000, lastResult: 'cancelled', runs: 3, fails: 1 })]);
    expect(messy.runs).toEqual([]);
    const warnings = store.warnings(GAME);
    expect(warnings[0]).toContain('已按原版规则逐项修复');
    expect(warnings.some((w) => w.includes('已改成仅手动'))).toBe(true);
    expect(warnings.some((w) => w.includes('两份计划'))).toBe(true);
    // The repaired content is writable (strict validation on write).
    await store.saveConfig(GAME, { enabled: false });
    expect(JSON.parse(await readFile(fileOf(root), 'utf8')).plans[0].tasks).toHaveLength(2);
  });

  it('upgrades a file written before preemption / AI assist / the script cap without warnings', async () => {
    const root = await home();
    const store = new PlanStore(root, () => undefined);
    await writeRaw(root, JSON.stringify({ version: 1, config: { version: 1, enabled: false, catchUpMs: 60_000, queueWaitMs: 60_000, retry: 0, retryDelayMs: 0 },
      plans: [PLAN], runtime: [], runs: [] }));
    expect((await store.overview(GAME)).config).toMatchObject({ preemptGraceMs: 8_000, aiAssist: true, maxConcurrentScripts: 4, retry: 0 });
    expect(store.warnings(GAME)).toEqual([]);
  });

  it('validates on write: 0–720 minute limits (0 = unlimited), canonical daily times, config patches', async () => {
    const root = await home();
    const store = new PlanStore(root);
    const saved = await store.savePlan(GAME, { ...PLAN, tasks: [{ ...PLAN.tasks[0]!, maxRunMinutes: 0, trigger: { kind: 'daily', at: [' 20:30', '08:00', '08:00'] } }] });
    expect(saved.tasks[0]?.trigger).toEqual({ kind: 'daily', at: ['08:00', '20:30'] });
    await store.savePlan(GAME, { ...PLAN, tasks: [{ ...PLAN.tasks[0]!, maxRunMinutes: 720 }] });
    await expect(store.savePlan(GAME, { ...PLAN, tasks: [{ ...PLAN.tasks[0]!, maxRunMinutes: 721 }] })).rejects.toThrow('0–720');
    await expect(store.savePlan(GAME, { ...PLAN, tasks: [{ ...PLAN.tasks[0]!, trigger: { kind: 'daily', at: [] } }] })).rejects.toThrow('HH:MM');
    expect(() => validatePlan({ ...PLAN, tasks: [{ ...PLAN.tasks[0]!, priority: 50.5 }] })).toThrow('优先级');
    expect(await store.saveConfig(GAME, { retry: 9, preemptGraceMs: 5_000, maxConcurrentScripts: 0 })).toMatchObject({ retry: 5, preemptGraceMs: 5_000, maxConcurrentScripts: 1 });
    await expect(store.saveConfig(GAME, { retry: 'x' } as never)).rejects.toThrow('应为数字');
    await expect(store.saveConfig(GAME, { surprise: 1 } as never)).rejects.toThrow('不认识的字段');
  });

  it('switches a task or an account without rewriting the plan, and removes tasks with their runtime', async () => {
    const root = await home();
    const store = new PlanStore(root);
    await store.savePlan(GAME, PLAN);
    expect((await store.setTaskEnabled(GAME, ACCOUNT, 'task-1', false)).tasks[0]?.enabled).toBe(false);
    await expect(store.setTaskEnabled(GAME, ACCOUNT, 'missing', true)).rejects.toThrow('刷新一下再试');
    expect(await store.setAccountEnabled(GAME, ACCOUNT_2, true)).toMatchObject({ accountId: ACCOUNT_2, enabled: true, tasks: [] });
    await store.addRun(GAME, run('r1', 1));
    await store.updateRun(GAME, 'r1', { status: 'running', startedAt: 2 });
    expect((await store.overview(GAME)).runtime).toHaveLength(1);
    expect(await store.removeTask(GAME, ACCOUNT, 'task-1')).toMatchObject({ tasks: [] });
    expect((await store.overview(GAME)).runtime).toEqual([]);
    await store.savePlan(GAME, PLAN);
    expect(await store.removeTask(GAME, ACCOUNT, 'task-1', true)).toBeNull();
    expect((await store.overview(GAME)).plans.map((p) => p.accountId)).toEqual([ACCOUNT_2]);
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
});

describe('legacy (wanlong-panel) plans.json import', () => {
  it('converts loop scripts and account plans without importing auto-enable or runtime counters', () => {
    // Script-level loop mode is supported again; a too-short gap is raised to 3 s.
    const converted = convertLegacyScript({ ...SCRIPT, loop: true, loopIntervalMs: 200 }, PKG);
    expect(converted.script.loop).toBe(true);
    expect(converted.script.loopIntervalMs).toBe(3000);
    expect(converted.warnings).toHaveLength(2);
    const old = { version: 1, config: { enabled: true }, plans: [{ ...PLAN, accountId: 'legacy-id',
      tasks: [{ ...PLAN.tasks[0], maxRunMinutes: 0 }] }], runtime: [{ runs: 999 }] };
    const next = convertLegacyAccountPlan(old, 'legacy-id', ACCOUNT);
    expect(next.plan.enabled).toBe(false);
    // 0 = unlimited is a legal value again (original range 0–720).
    expect(next.plan.tasks[0]?.maxRunMinutes).toBe(0);
    expect(next.plan.accountId).toBe(ACCOUNT);
    expect(() => validatePlan(next.plan)).not.toThrow();
  });

  it('sanitizes what the original accepted instead of failing the whole import', () => {
    const old = {
      version: 1,
      config: { version: 1, enabled: true, preemptGraceMs: 500_000, catchUpMs: 60_000, retry: 2, aiAssist: false, queueWaitMs: 'x' },
      plans: [{ accountId: 'legacy-id', enabled: true, updatedAt: 1, tasks: [
        { id: 'task_abc', scriptId: 'daily', enabled: true, trigger: { kind: 'daily', at: ['25:00'] }, priority: 50.5, maxRunMinutes: 900 },
        { id: '任务二', scriptId: 'weekly', enabled: false, trigger: { kind: 'interval', everyMinutes: 30, window: { from: '9', to: '23:00' } }, priority: 10, maxRunMinutes: 720 },
      ] }],
    };
    const next = convertLegacyAccountPlan(old, 'legacy-id', ACCOUNT, () => 'task_fresh');
    expect(next.plan.tasks.map((task) => task.id)).toEqual(['task_abc', 'task_fresh']);
    expect(next.plan.tasks[0]).toMatchObject({ trigger: { kind: 'manual' }, priority: 51, maxRunMinutes: 720 });
    expect(next.plan.tasks[1]).toMatchObject({ trigger: { kind: 'interval', everyMinutes: 30 }, enabled: false, maxRunMinutes: 720 });
    expect(next.warnings.some((w) => w.includes('已改成仅手动'))).toBe(true);
    expect(next.warnings.some((w) => w.includes('720'))).toBe(true);
    expect(() => validatePlan(next.plan)).not.toThrow();
    expect(convertLegacyConfig(old)).toEqual({ enabled: false, preemptGraceMs: 120_000, catchUpMs: 60_000, retry: 2, aiAssist: false });
    expect(convertLegacyConfig({})).toEqual({ enabled: false });
  });
});
