/**
 * Port of the original `scripts/ai-risk-offline-check.ts` (part of check:runtime; docs/ai-risk-control.md):
 * semantic confirmations, risky effects the model mislabels as low, missing evidence, two fresh assessments, a screen
 * that changed meanwhile, stop, foreground change, quota, a failed review, the 60 s repeat lock, no confirmation
 * template learning — plus the main-screen exception for back / none and this repository's opt-in switch.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { RawFrame } from '@avdm/automation';
import { AppError } from '@avdm/automation/wanlong';
import { afterAll, describe, expect, it } from 'vitest';
import { AdvisorService } from '../src/main/automation/advisor';
import { WANLONG_PROFILE } from '../src/main/automation/advisor/profiles';
import { parseAdvice, parseRisk, riskRejection } from '../src/main/automation/advisor/risk';
import { aiRecoverUnknownScreen } from '../src/main/automation/ai-recover';
import type { AdvisorRisk } from '../src/shared/ai';

const GAME_PACKAGE = 'com.lilithgames.samo.android.cn';
const homes: string[] = [];
afterAll(async () => { await Promise.all(homes.map((home) => rm(home, { recursive: true, force: true }))); });

const low: AdvisorRisk = {
  level: 'low', effect: 'acknowledge', buttonText: '确定', dialogText: '连接已恢复，点击确定继续',
  consequence: '关闭提示继续游戏', reason: '仅确认信息，无付费、资源消耗或账号变更', hazards: [],
};
const body = (risk: unknown = low, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  screen: 'dialog', action: 'tap_confirm', target: { x: 600, y: 430, w: 180, h: 80 }, confidence: 0.95, reason: '信息确认', risk, ...extra,
});
const frame = (v: number): RawFrame => {
  const data = new Uint8Array(1280 * 720 * 4);
  for (let i = 0; i < 1280 * 720; i++) {
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = v + (i % 31 < 10 ? 10 : 0);
    data[i * 4 + 3] = 255;
  }
  return { width: 1280, height: 720, format: 1, capturedAt: 0, data };
};
const before = frame(180);
const after = frame(60);
let sequence = 0;

interface RunOptions {
  cfg?: Record<string, unknown>;
  stale?: boolean;
  abortReview?: boolean;
  wrongApp?: boolean;
  captureError?: boolean;
  tapError?: boolean;
}

async function run(replies: unknown[], options: RunOptions = {}) {
  const home = await mkdtemp(path.join(tmpdir(), 'avdm-ai-risk-'));
  homes.push(home);
  let now = 1_000_000;
  let calls = 0;
  let captures = 0;
  const controller = new AbortController();
  const advisor = new AdvisorService(home, async () => { throw new Error('unused'); }, {
    now: () => now,
    log: () => undefined,
    fetch: async () => {
      const value = replies[calls++];
      if (options.abortReview && calls === 2) controller.abort();
      if (value === 'http-error') return { status: 500, text: async () => 'offline injected error' };
      return { status: 200, text: async () => JSON.stringify({ model: 'fake-risk-model', choices: [{ message: { content: JSON.stringify(value) } }] }) };
    },
  });
  await advisor.saveConfig({
    baseUrl: 'https://ai.example.test/v1', model: 'fake-risk-model', apiKey: 'fake-test-key', imageWidth: 1280, cooldownSeconds: 20,
    refine: false, autoActions: true, ...options.cfg,
  });
  await advisor.saveConfig({ enabled: true });
  const taps: number[][] = [];
  const ctx = {
    gameId: 'wanlong',
    instanceIndex: ++sequence,
    context: 'risk-test',
    raw: before,
    refWidth: 1280,
    refHeight: 720,
    attempt: 1,
    packageName: GAME_PACKAGE,
    mainScreens: WANLONG_PROFILE.mainScreens,
    noConfirmScreens: WANLONG_PROFILE.noConfirmScreens,
    checkAlive: () => {
      if (controller.signal.aborted) throw new AppError('RUN_ABORTED', 'stopped');
    },
    foregroundPackage: async () => (options.wrongApp ? 'other.app' : GAME_PACKAGE),
    io: {
      capture: async () => {
        if (options.captureError) throw new Error('capture failed');
        captures++;
        return taps.length || (options.stale && captures >= 2) ? after : before;
      },
      tap: async (x: number, y: number) => {
        if (options.tapError) throw new Error('tap failed');
        taps.push([x, y]);
      },
    },
    recognize: async (raw: RawFrame) => raw === after,
    log: () => undefined,
    sleep: async () => undefined,
  };
  const result = await aiRecoverUnknownScreen(advisor, ctx);
  return { result, taps, calls, advisor, ctx, advance: () => { now += 21_000; } };
}

describe('AI risk control (docs/ai-risk-control.md)', () => {
  it('a low-risk confirmation: second opinion on a fresh frame (quota, no cooldown), one tap, verified, never learnt', async () => {
    const success = await run([body(), body()]);
    expect(success.result.outcome).toBe('verified');
    expect(success.result.advice?.riskRechecked).toBe(true);
    expect(success.calls).toBe(2);
    expect(success.taps).toEqual([[690, 470]]);
    expect(success.result.harvestedTemplateId).toBeNull();
    // 60 s repeat lock (memory only): the same confirmation is refused, another instance is not.
    success.advance();
    expect(success.advisor.claimConfirmation(success.ctx.instanceIndex, success.result.advice!)).toBe(false);
    expect(success.advisor.claimConfirmation(success.ctx.instanceIndex + 100, success.result.advice!)).toBe(true);
  });

  it.each(['download_update', 'retry_connection', 'continue_loading', 'navigate'] as const)('low-risk effect %s is executed', async (effect) => {
    const risk = { ...low, effect };
    const result = await run([body(risk), body(risk)]);
    expect(result.result.outcome).toBe('verified');
    expect(result.taps).toHaveLength(1);
  });

  it.each(['purchase', 'spend_resource', 'delete', 'account_change', 'permission_change', 'send_message', 'combat', 'exit_game', 'unknown'] as const)(
    'a「low」label cannot override effect %s', async (effect) => {
      const result = await run([body({ ...low, effect })]);
      expect(result.result.requiresAttention).toBe(true);
      expect(result.taps).toHaveLength(0);
      expect(result.calls).toBe(1);
    });

  it.each([
    ['missing', undefined],
    ['high', { ...low, level: 'high' }],
    ['medium', { ...low, level: 'medium' }],
    ['unknown', { ...low, level: 'unknown' }],
    ['hazards listed', { ...low, hazards: ['消耗钻石'] }],
    ['hazards missing', { ...low, hazards: undefined }],
    ['no dialog text', { ...low, dialogText: '' }],
  ])('risk %s ⇒ needs a human, no tap', async (_name, risk) => {
    const result = await run([body(risk)]);
    expect(result.result.requiresAttention).toBe(true);
    expect(result.taps).toHaveLength(0);
  });

  it('the second opinion changes its mind (risk or button text) ⇒ needs a human', async () => {
    const secondRisk = await run([body(), body({ ...low, level: 'high', effect: 'purchase' })]);
    expect(secondRisk.result.requiresAttention).toBe(true);
    expect(secondRisk.taps).toHaveLength(0);
    const changedButton = await run([body(), body({ ...low, buttonText: '领取' })]);
    expect(changedButton.result.requiresAttention).toBe(true);
    expect(changedButton.taps).toHaveLength(0);
  });

  it('the screen changed after the review ⇒ re-judge (handled), no tap and no BACK', async () => {
    const stale = await run([body(), body()], { stale: true });
    expect(stale.result.handled).toBe(true);
    expect(stale.taps).toHaveLength(0);
  });

  it('stop during the review, foreground change, quota exhausted, failed review ⇒ no tap', async () => {
    const cancelled = await run([body(), body()], { abortReview: true });
    expect(cancelled.taps).toHaveLength(0);
    const wrongApp = await run([body()], { wrongApp: true });
    expect(wrongApp.taps).toHaveLength(0);
    expect(wrongApp.result.requiresAttention).toBe(true);
    const budget = await run([body()], { cfg: { maxCallsPerHour: 1 } });
    expect(budget.calls).toBe(1);
    expect(budget.result.requiresAttention).toBe(true);
    expect(budget.taps).toHaveLength(0);
    const network = await run([body(), 'http-error']);
    expect(network.result.requiresAttention).toBe(true);
    expect(network.taps).toHaveLength(0);
  });

  it.each([{ captureError: true }, { tapError: true }])('an uncertain confirmation never falls through to BACK on IO failure (%o)', async (failure) => {
    const failedIo = await run([body(), body()], failure);
    expect(failedIo.result.requiresAttention).toBe(true);
    expect(failedIo.taps).toHaveLength(0);
  });

  it('none on a risky dialog cannot fall through to BACK, even when mislabelled low', async () => {
    const decline = await run([body({ ...low, level: 'high', effect: 'delete' }, { action: 'none', target: null })]);
    expect(decline.result.requiresAttention).toBe(true);
    const mislabeledNone = await run([body({ ...low, effect: 'delete' }, { action: 'none', target: null })]);
    expect(mislabeledNone.result.requiresAttention).toBe(true);
  });

  // ★ 2026-09-18: a translucent guide bubble over the world map; the model said「this is the world map, nothing to
  //   close」with a high risk for the click it imagined — and the instance was paused. back / none are never clicked:
  //   on the game's own main screens they go back to the ladder instead of pausing.
  it.each(['world_map', 'city', 'troop_panel'])('none on %s never pauses the instance', async (screen) => {
    const onMain = await run([body({ ...low, level: 'high', effect: 'delete' }, { action: 'none', target: null, screen })]);
    expect(onMain.result.requiresAttention).toBe(false);
    expect(onMain.result.outcome).toBe('no_action');
    expect(onMain.taps).toHaveLength(0);
  });

  it.each(['kicked', 'maintenance', 'unknown'])('none on %s still pauses', async (screen) => {
    const risky = await run([body({ ...low, level: 'high', effect: 'delete' }, { action: 'none', target: null, screen })]);
    expect(risky.result.requiresAttention).toBe(true);
  });

  it.each(['kicked', 'unknown'])('a confirmation on %s needs a human', async (screen) => {
    const ambiguous = await run([body(low, { screen })]);
    expect(ambiguous.result.requiresAttention).toBe(true);
    expect(ambiguous.taps).toHaveLength(0);
  });

  it('a purchase disguised as a close ⇒ needs a human, no tap', async () => {
    const disguised = await run([body({ ...low, effect: 'purchase' }, { action: 'tap_close' })]);
    expect(disguised.taps).toHaveLength(0);
    expect(disguised.result.requiresAttention).toBe(true);
  });

  it('an unknown update layout can use risk-based confirmation; malformed risk blocks are unknown', () => {
    const parsed = parseAdvice(JSON.stringify(body({ ...low, effect: 'download_update' }, { screen: 'update' })), 1280, 720, WANLONG_PROFILE.screens);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(riskRejection(parsed.value)).toBeNull();
    expect(parseRisk({ ...low, hazards: 'none' }).level).toBe('unknown');
    expect(parseRisk({ ...low, level: 'safe' }).level).toBe('unknown');
  });

  it('allowUpdateConfirm=false (update already downloading) never confirms the update again', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'avdm-ai-risk-'));
    homes.push(home);
    const risk = { ...low, effect: 'download_update' };
    const advisor = new AdvisorService(home, async () => { throw new Error('unused'); }, {
      log: () => undefined,
      fetch: async () => ({ status: 200, text: async () => JSON.stringify({ model: 'm', choices: [{ message: { content: JSON.stringify(body(risk, { screen: 'update' })) } }] }) }),
    });
    await advisor.saveConfig({ baseUrl: 'https://ai.example.test/v1', model: 'm', apiKey: 'fake-test-key', imageWidth: 1280, cooldownSeconds: 0, refine: false, autoActions: true });
    await advisor.saveConfig({ enabled: true });
    const taps: number[][] = [];
    const result = await aiRecoverUnknownScreen(advisor, {
      gameId: 'wanlong', instanceIndex: 50, context: 'gather-g0', raw: before, refWidth: 1280, refHeight: 720, attempt: 1,
      packageName: GAME_PACKAGE, mainScreens: WANLONG_PROFILE.mainScreens, allowUpdateConfirm: false,
      foregroundPackage: async () => GAME_PACKAGE,
      io: { capture: async () => before, tap: async (x, y) => { taps.push([x, y]); } },
      log: () => undefined, sleep: async () => undefined,
    });
    expect(result.outcome).toBe('no_action');
    expect(result.requiresAttention).toBe(false);
    expect(taps).toHaveLength(0);
  });

  it('★ with「自动处理」off the AI only records its suggestion: no tap, no pause, even for a risky dialog', async () => {
    const safe = await run([body(), body()], { cfg: { autoActions: false } });
    expect(safe.result).toMatchObject({ handled: false, outcome: 'advised', requiresAttention: false });
    expect(safe.taps).toHaveLength(0);
    expect(safe.calls).toBe(1);
    const risky = await run([body({ ...low, effect: 'purchase' })], { cfg: { autoActions: false } });
    expect(risky.result).toMatchObject({ handled: false, outcome: 'blocked', requiresAttention: false });
    const declined = await run([body({ ...low, level: 'high', effect: 'delete' }, { action: 'none', target: null, screen: 'kicked' })], { cfg: { autoActions: false } });
    expect(declined.result).toMatchObject({ outcome: 'no_action', requiresAttention: false });
    expect((await safe.advisor.history())[0]).toMatchObject({ outcome: 'advised', context: 'risk-test' });
  });
});
