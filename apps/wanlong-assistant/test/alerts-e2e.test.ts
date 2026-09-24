/**
 * Port of the original `scripts/alerts-offline-check.ts` section 六 (★ end to end: consecutive failures → the REAL
 * scheduler is paused → pushed once → resumed) on this app's EtaScheduler + AlertsService, plus the other hook paths
 * (sample failures → offline, kicked probe, health probe, host hooks, identity change). Fake device ports and a fake
 * Telegram: not one adb command, not one network request.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { wanlongPlugin, type GatherCycleFact } from '@avdm/automation/wanlong';
import type { PanelSample } from '@avdm/automation/wanlong/pure';
import type { MatchResult, RawFrame } from '@avdm/automation';
import { makeAlertEvent, type AlertRecord, type InstancePauseState } from '../src/shared/alerts';
import { AlertsService, ledgerAlertOf } from '../src/main/alerts';
import type { SecretCodec } from '../src/main/alerts/store';
import type { FetchLike } from '../src/main/alerts/telegram';
import { SchedulerError } from '../src/main/scheduler/errors';
import { InstanceLocks } from '../src/main/scheduler/instance-lock';
import { EtaScheduler } from '../src/main/scheduler/service';
import type { EtaSchedulerPorts, SampleRequest } from '../src/main/scheduler/types';

const PACKAGE = wanlongPlugin.packageName;
const START = Date.parse('2026-09-24T04:00:00.000Z');
const CREATED_AT = '2026-09-01T00:00:00.000Z';
// ★ Test data, not a credential.
const FAKE_TOKEN = '999888777:AAFakeTokenForOfflineCheckOnly_0123456789';
const FAKE_CHAT_ID = '123456789';
const leaks = (text: string) => text.includes(FAKE_TOKEN) || text.includes('AAFakeTokenForOfflineCheckOnly');

const codec: SecretCodec = {
  encrypt: async (plain) => `enc:${Buffer.from(plain).toString('base64')}`,
  decrypt: async (ciphertext) => Buffer.from(ciphertext.replace(/^enc:/, ''), 'base64').toString(),
};

const frame = (): RawFrame => ({ width: 2, height: 2, data: new Uint8Array(16), capturedAt: Date.now() });
const panel = (used: number, total: number): PanelSample => ({ sampledAt: Date.now(), queueUsed: used, queueTotal: total, rows: [], warnings: [] });

function factOf(p: Partial<GatherCycleFact> = {}): GatherCycleFact {
  return { outcome: 'error', message: '第 G7 步失败：找不到「创建部队」页', step: null, errorCode: 'STEP_FAILED', dispatched: 0, captures: 1, shotPath: null, kicked: null, ...p };
}

function missing(ids: string[]): MatchResult[] {
  return ids.map((templateId) => ({ templateId, found: false, score: 0, x: 0, y: 0, w: 0, h: 0, centerX: 0, centerY: 0, threshold: 0.9, elapsedMs: 0, reason: '模板缺失' }));
}

/** Let real I/O (atomic writes) and promise chains settle while setTimeout is faked. */
async function until(check: () => boolean | Promise<boolean>, what: string, budgetMs = 5_000): Promise<void> {
  const deadline = performance.now() + budgetMs;
  while (performance.now() < deadline) {
    if (await check()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  if (await check()) return;
  throw new Error(`等待超时：${what}`);
}

describe('alerts end to end with the real scheduler (original section 六)', () => {
  let home: string;
  let samples: Array<(req: SampleRequest) => Promise<PanelSample>>;
  let ports: EtaSchedulerPorts;
  let scheduler: EtaScheduler;
  let alerts: AlertsService;
  let calls: Array<{ url: string; text: string }>;
  let reply: () => Promise<{ status: number; text(): Promise<string> }>;
  let identity: string | null;
  let match: (ids: string[]) => Promise<MatchResult[]>;
  let running: boolean;
  let logs: string[];
  let autoChanges: Array<[number, boolean]>;
  let pauseEvents: InstancePauseState[];
  let raised: AlertRecord[];
  let ledger: AlertRecord[];

  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, text: typeof init.body === 'string' ? String((JSON.parse(init.body) as { text: string }).text) : '[FormData]' });
    return reply();
  };
  const pushed = () => calls.map((call) => call.text);

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(START);
    home = await mkdtemp(path.join(tmpdir(), 'avdm-alerts-e2e-'));
    samples = [];
    calls = [];
    reply = async () => ({ status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: 1 } }) });
    identity = CREATED_AT;
    match = async (ids) => missing(ids);
    running = true;
    logs = [];
    autoChanges = [];
    pauseEvents = [];
    raised = [];
    ledger = [];
    ports = {
      sample: vi.fn(async (_index: number, req: SampleRequest) => (samples.shift() ?? (async () => panel(5, 5)))(req)),
      healthFrame: vi.fn(async () => ({ raw: frame(), foreground: running ? PACKAGE : 'com.android.launcher3', running })),
      instance: vi.fn(async () => (identity ? { status: 'running', createdAt: identity } : null)),
    };
    scheduler = new EtaScheduler(home, ports, {
      ownerLease: false, locks: new InstanceLocks(home, { fileLock: async (_path, fn) => fn() }), random: () => 0, log: () => undefined,
    });
    await scheduler.restore();
    await scheduler.saveConfig({ healthProbeIntervalMin: 0 });
    alerts = new AlertsService(home, {
      setAuto: (index, enabled, reason) => scheduler.setAuto(index, enabled, reason),
      exclusive: (index, what, fn, signal) => scheduler.exclusive(index, what, fn, signal),
      accountOf: async (index) => (index === 0 ? { id: 'acc-1', name: '主号-王朝A区' } : null),
      identityOf: async () => identity,
      instanceAlive: async () => ({ alive: true, status: 'running', identity }),
      recoveryIo: () => { throw new Error('离线自检不该重启模拟器'); },
      matchTemplates: async (_index, _raw, ids) => match(ids),
      saveShot: async (index, label) => `automation/wanlong/shots/inst${index}-${label}-1.jpg`,
      ledger: async (record) => { ledger.push(record); },
      log: (level, message) => logs.push(`[${level}] ${message}`),
      onPauseChanged: (pause) => pauseEvents.push(pause),
      onRaised: (record) => raised.push(record),
      codec, fetch, sleep: async () => undefined, gamePackage: PACKAGE,
    });
    scheduler.setHooks(alerts.schedulerHooks());
    scheduler.setHooks({ onAutoChanged: (index, enabled) => autoChanges.push([index, enabled]) });
    await alerts.hub.saveConfig({ telegram: { enabled: true, botToken: FAKE_TOKEN, chatId: FAKE_CHAT_ID, retryCount: 0 } });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await alerts.dispose();
    await scheduler.dispose();
    await rm(home, { recursive: true, force: true });
  });

  it('★ consecutive failures pause the real scheduler, push once, stay idempotent, and resume cleanly', async () => {
    await scheduler.setAuto(0, true);
    expect(scheduler.getState(0).auto).toBe(true);
    expect(scheduler.listWakes().some((wake) => wake.instanceIndex === 0)).toBe(true);

    // Failures until an event (the hook runs in the lock and awaits the pause step).
    for (let round = 1; round <= 3; round += 1) {
      await alerts.onCycleResult(0, factOf({ message: `第 ${round} 轮：找不到「创建部队」页`, shotPath: 'automation/wanlong/shots/inst0-cycle-error-1.jpg' }), 'scheduled');
    }
    // ★ The pause is in force when the hook returns (before the push finished).
    expect(scheduler.getState(0)).toMatchObject({ auto: false, nextWakeAt: null });
    expect(scheduler.listWakes().some((wake) => wake.instanceIndex === 0)).toBe(false);
    await alerts.center.whenIdle();

    const pause = alerts.center.getPause(0);
    expect(pause).toMatchObject({
      paused: true, type: 'consecutiveFailures', shotPath: 'automation/wanlong/shots/inst0-cycle-error-1.jpg',
      notified: true, notifyError: null, accountName: '主号-王朝A区',
    });
    expect(pause.reason).toContain('连续 3 轮');
    expect(pause.pausedAt).toBe(START);
    expect(pause.advice).toContain('恢复');
    expect(alerts.center.pauseInfo(0)).toMatchObject({ reason: pause.reason, kind: 'consecutiveFailures' });

    // Persisted: the pause record and the scheduler's auto flag (a restart does not run on by itself).
    const stored = JSON.parse(await readFile(path.join(home, 'automation', 'alerts', 'pauses.json'), 'utf8')) as { pauses: Array<Record<string, unknown>> };
    expect(stored.pauses.find((item) => item.instanceIndex === 0)).toMatchObject({ paused: true, reason: pause.reason, pausedAt: START, instanceIdentity: CREATED_AT });
    const schedulerFile = JSON.parse(await readFile(path.join(home, 'automation', 'games', 'wanlong', 'scheduler', 'instances', '0.json'), 'utf8')) as { auto: boolean };
    expect(schedulerFile.auto).toBe(false);

    // Pushed exactly once, in Beijing time, with account and scene.
    expect(calls).toHaveLength(1);
    expect(pushed()[0]).toContain('实例 #0（主号-王朝A区）');
    expect(pushed()[0]).toContain('连续失败熔断');
    expect(pushed()[0]).toContain('（北京时间）');
    expect(pushed()[0]).toContain('automation/wanlong/shots/inst0-cycle-error-1.jpg');

    // Idempotent: no second pause, the first reason kept, the cooldown swallows repeats.
    const event = raised[0]!.event;
    const again = await alerts.center.raise(event);
    expect(again.pausedNow).toBe(false);
    expect(again.results[0]?.failure).toBe('throttled');
    for (let i = 0; i < 3; i += 1) await alerts.center.raise(event);
    expect(calls).toHaveLength(1);
    expect(alerts.center.getPause(0).reason).toBe(pause.reason);

    // A failed push never undoes a pause, and its reason is kept (scrubbed) for the banner.
    reply = async () => { throw new Error(`fetch failed https://api.telegram.org/bot${FAKE_TOKEN}/sendMessage`); };
    const failed = await alerts.center.raise(makeAlertEvent({ type: 'needsAttention', instanceIndex: 1, reason: '恢复阶梯用尽' }));
    expect(failed.pausedNow).toBe(true);
    expect(alerts.center.getPause(1)).toMatchObject({ paused: true, notified: false, accountName: null });
    expect(alerts.center.getPause(1).notifyError).toContain('网络不通');
    expect(leaks(alerts.center.getPause(1).notifyError ?? '')).toBe(false);
    // Only real flips reach the statistics: instance 1 was never on, so its pause is no flip.
    expect(autoChanges).toEqual([[0, true], [0, false]]);
    reply = async () => ({ status: 200, text: async () => JSON.stringify({ ok: true }) });

    // Resume: cleared first, counters and cooldown reset, auto on with a wake, closing push.
    calls.length = 0;
    await alerts.onCycleResult(0, factOf(), 'scheduled');
    expect(alerts.failures.peek(0)?.cycleFail).toBe(1);
    const after = await alerts.resume(0);
    expect(after.paused).toBe(false);
    expect(alerts.failures.peek(0)).toBeNull();
    expect(scheduler.getState(0).auto).toBe(true);
    expect(scheduler.listWakes().some((wake) => wake.instanceIndex === 0)).toBe(true);
    expect(autoChanges.at(-1)).toEqual([0, true]);
    const storedAfter = JSON.parse(await readFile(path.join(home, 'automation', 'alerts', 'pauses.json'), 'utf8')) as { pauses: Array<Record<string, unknown>> };
    expect(storedAfter.pauses.find((item) => item.instanceIndex === 0)?.paused).toBe(false);
    await alerts.center.whenIdle();
    expect(pushed().some((text) => text.includes('实例已恢复') && text.includes('连续 3 轮'))).toBe(true);

    // The cooldown was cleared: the same problem is pushed at once.
    calls.length = 0;
    await alerts.center.raise(makeAlertEvent({ type: 'consecutiveFailures', instanceIndex: 0, reason: '恢复之后又坏了' }));
    expect(calls).toHaveLength(1);

    // History and the ledger (info events are no ledger alerts).
    expect(alerts.center.history().length).toBeGreaterThanOrEqual(7);
    expect(ledger.every((record) => record.event.type !== 'instanceResumed')).toBe(true);
    expect(ledgerAlertOf(ledger[0]!, 'wanlong')).toMatchObject({ gameId: 'wanlong', index: 0, kind: 'consecutiveFailures', severity: 'critical' });
    expect(ledgerAlertOf(raised.find((record) => record.event.type === 'instanceResumed')!, 'wanlong')).toBeNull();
    expect(pauseEvents.some((item) => item.instanceIndex === 0 && item.paused && item.notified === true)).toBe(true);
    const history = JSON.parse(await readFile(path.join(home, 'automation', 'alerts', 'history.json'), 'utf8')) as { records: unknown[] };
    expect(history.records.length).toBeGreaterThanOrEqual(7);
    expect(logs.filter(leaks)).toEqual([]);
    // ★ No file of the alerts module (config ciphertext, cooldown, pauses, history) holds the token.
    for (const name of await readdir(path.join(home, 'automation', 'alerts'))) {
      expect(leaks(await readFile(path.join(home, 'automation', 'alerts', name), 'utf8')), name).toBe(false);
    }
  });

  it('resume fails loudly in Chinese when the scheduler refuses, with the pause already cleared', async () => {
    await alerts.center.raise(makeAlertEvent({ type: 'deviceOffline', instanceIndex: 3, reason: '掉线' }));
    identity = null;
    await expect(alerts.resume(3)).rejects.toThrow('恢复实例 #3 的自动调度失败');
    // The record was cleared for a new instance identity (null): nothing stays red for a vanished AVD.
    expect(alerts.center.getPause(3).paused).toBe(false);
  });

  it('counts failed samples in the lock and pauses as offline (freeze restart off, no freeze evidence)', async () => {
    await alerts.hub.saveConfig({ detect: { sampleFailThreshold: 2 } });
    samples.push(async () => { throw new SchedulerError('TIMEOUT', 'ADB 截图超时'); });
    await scheduler.setAuto(0, true);
    expect(scheduler.getState(0).auto).toBe(true);
    expect(alerts.failures.peek(0)?.sampleFail).toBe(1);
    samples.push(async () => { throw new SchedulerError('TIMEOUT', 'ADB 截图超时'); });
    for (let i = 0; i < 40 && scheduler.getState(0).auto; i += 1) {
      await vi.advanceTimersByTimeAsync(30_000);
      await until(() => !scheduler.getState(0).operating, '采样结束', 1_000).catch(() => undefined);
    }
    await until(() => alerts.center.isPaused(0), '按掉线暂停');
    expect(scheduler.getState(0).auto).toBe(false);
    expect(alerts.center.getPause(0)).toMatchObject({ type: 'deviceOffline' });
    expect(alerts.center.getPause(0).reason).toContain('ADB 截图超时');
    await alerts.center.whenIdle();
    expect(calls).toHaveLength(1);
    // A good sample restarts the count (after resuming, the next sample is fine).
    await alerts.resume(0);
    expect(alerts.failures.peek(0)?.sampleFail ?? 0).toBe(0);
  });

  it('records and pushes but does not pause while 「自动暂停」 is off; scheduler-made pauses are still recorded', async () => {
    await alerts.hub.saveConfig({ detect: { autoPauseEnabled: false } });
    await scheduler.setAuto(0, true);
    for (let i = 0; i < 3; i += 1) await alerts.onCycleResult(0, factOf(), 'scheduled');
    await alerts.center.whenIdle();
    expect(scheduler.getState(0).auto).toBe(true);
    expect(alerts.center.isPaused(0)).toBe(false);
    expect(alerts.center.history()[0]).toMatchObject({ pausedNow: false, event: { type: 'consecutiveFailures' } });
    expect(calls).toHaveLength(1);
    // The scheduler's safety pause already switched auto off itself: the record is written regardless.
    await alerts.hostHooks().onScheduleStop!('wanlong', 0, 8);
    expect(alerts.center.getPause(0)).toMatchObject({ paused: true, type: 'consecutiveFailures' });
    expect(alerts.center.getPause(0).reason).toContain('安全阀');
  });

  it('host hooks: manual rounds and human-needed codes are not counted; the readiness gate pauses as schedulePaused', async () => {
    const hooks = alerts.hostHooks();
    for (let i = 0; i < 5; i += 1) await hooks.onCycleResult!(0, factOf(), 'manual');
    for (let i = 0; i < 5; i += 1) await hooks.onCycleResult!(0, factOf({ errorCode: 'GAME_UPDATE_REQUIRED' }), 'scheduled');
    expect(alerts.failures.peek(0)?.cycleFail ?? 0).toBe(0);
    await hooks.onSchedulePause!('wanlong', 2, '账号「主号」尚未完成登录检查');
    expect(alerts.center.getPause(2)).toMatchObject({ paused: true, type: 'schedulePaused', severity: 'warning' });
    await hooks.onNeedsAttention!('wanlong', 4, { code: 'AI_RISK_BLOCKED', message: 'AI 判断这个确认框点了有风险' });
    await alerts.center.whenIdle();
    expect(alerts.center.getPause(4)).toMatchObject({ paused: true, type: 'needsAttention', detail: { 阶段: 'AI 操作风险评估' } });
  });

  it('the kicked probe: missing templates degrade silently; a hit pauses at once with the scene and stops the sampler', async () => {
    const hooks = alerts.schedulerHooks();
    const signal = new AbortController().signal;
    expect(await hooks.probeUnrecognizedFrame!(0, frame(), { signal })).toBe(false);
    expect(await alerts.probeKicked(0, frame())).toBeNull();
    match = async (ids) => missing(ids).map((result) => result.templateId === 'tpl_dlg_kicked' ? { ...result, found: true, score: 0.97, reason: undefined } : result);
    expect(await alerts.probeKicked(0, frame())).toMatchObject({ type: 'suspectedKicked', templateId: 'tpl_dlg_kicked', score: 0.97 });
    expect(await hooks.probeUnrecognizedFrame!(0, frame(), { signal })).toBe(true);
    expect(alerts.center.getPause(0)).toMatchObject({ paused: true, type: 'suspectedKicked', shotPath: 'automation/wanlong/shots/inst0-kicked-1.jpg' });
    // Already paused: no second probe, no second alert.
    expect(await hooks.probeUnrecognizedFrame!(0, frame(), { signal })).toBe(false);
    // The switch turns layer 2 off.
    await alerts.hub.saveConfig({ detect: { kickedProbeEnabled: false } });
    expect(await alerts.probeKicked(1, frame())).toBeNull();
  });

  it('the health probe pauses an exited game as offline with the probe frame as scene', async () => {
    const hooks = alerts.schedulerHooks();
    await hooks.onHealthProbe!(1, frame(), { signal: new AbortController().signal, foreground: 'com.android.launcher3', running: false });
    expect(alerts.center.getPause(1)).toMatchObject({ paused: true, type: 'deviceOffline', shotPath: 'automation/wanlong/shots/inst1-health-probe-1.jpg' });
    expect(alerts.center.getPause(1).reason).toContain('com.android.launcher3');
  });

  it('drops a pause whose AVD was deleted or recreated (identity changed)', async () => {
    await alerts.center.raise(makeAlertEvent({ type: 'deviceOffline', instanceIndex: 2, reason: '掉线' }));
    expect(alerts.center.isPaused(2)).toBe(true);
    identity = '2026-09-20T00:00:00.000Z';
    const list = await alerts.center.listPauses();
    expect(list.find((item) => item.instanceIndex === 2)?.paused).toBe(false);
    expect(pauseEvents.at(-1)).toMatchObject({ instanceIndex: 2, paused: false });
  });

  it('restores pauses from disk on start (a restart keeps the instance paused)', async () => {
    await alerts.center.raise(makeAlertEvent({ type: 'suspectedKicked', instanceIndex: 5, reason: '被顶号' }));
    await alerts.center.dispose();
    const second = new AlertsService(home, {
      setAuto: async () => undefined, exclusive: async (_i, _w, fn) => fn({ signal: new AbortController().signal }),
      accountOf: async () => null, identityOf: async () => identity, instanceAlive: async () => ({ alive: true, status: 'running' }),
      recoveryIo: () => { throw new Error('no'); }, matchTemplates: async (_i, _r, ids) => missing(ids), saveShot: async () => null,
      log: () => undefined, codec, fetch, gamePackage: PACKAGE,
    });
    try {
      expect((await second.center.listPauses()).find((item) => item.instanceIndex === 5)).toMatchObject({ paused: true, type: 'suspectedKicked' });
      expect(second.center.pauseInfo(5)?.reason).toBe('被顶号');
    } finally {
      await second.dispose();
    }
  });

  it('serves scene screenshots only from the shot directories', async () => {
    const shots = path.join(home, 'automation', 'wanlong', 'shots');
    await mkdir(shots, { recursive: true });
    await writeFile(path.join(shots, 'inst0-kicked-1.jpg'), Buffer.from([0xff, 0xd8, 0xff]));
    expect([...await alerts.screenshot('automation/wanlong/shots/inst0-kicked-1.jpg')]).toEqual([0xff, 0xd8, 0xff]);
    await writeFile(path.join(home, 'secret.jpg'), 'x');
    for (const bad of ['../secret.jpg', 'automation/wanlong/shots/../../../secret.jpg', 'secret.jpg', 'automation/alerts/config.json', '', 'automation/wanlong/shots/sub/a.jpg']) {
      await expect(alerts.screenshot(bad)).rejects.toThrow();
    }
    await expect(alerts.screenshot('automation/wanlong/shots/gone.jpg')).rejects.toThrow('已经不在了');
  });
});
