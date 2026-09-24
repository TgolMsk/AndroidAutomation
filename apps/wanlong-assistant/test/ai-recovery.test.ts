/**
 * The three「认不出界面」chains in main (original recoverUnknownWithUpdate / gatherAdvisor / aiRecoverForScheduler /
 * aiAssistForRun): update handling first (even with the AI off), then the AI executor behind its opt-in switch;
 * attention codes reach the alerts port and are rethrown; every tap re-checks identity and foreground.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { MatchResult, RawFrame, TemplateSet } from '@avdm/automation';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdvisorService } from '../src/main/automation/advisor';
import { AiRecoveryService, NO_UPDATE, type AiRecoveryDeps, type UpdateVerdict } from '../src/main/automation/ai-recover';
import { chatBody, FakeApi } from './helpers/ai';

const PKG = 'com.lilithgames.samo.android.cn';
const SET_DIR = '/templates/tset_test';

function makeFrame(value: number): RawFrame {
  const data = new Uint8Array(1280 * 720 * 4);
  for (let i = 0; i < 1280 * 720; i++) {
    const v = value + ((i % 1280) >> 5) % 2 * 20;
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  }
  return { width: 1280, height: 720, format: 1, data, capturedAt: 0 };
}

const set = {
  id: 'tset_test', name: '测试模板集', packageName: PKG, refWidth: 2560, refHeight: 1440, directory: SET_DIR,
  templates: [{ id: 'tpl_nav_city_toggle' }, { id: 'tpl_btn_confirm' }, { id: 'game-update-message' }, { id: 'game-update-confirm' }],
} as unknown as TemplateSet;

const CLOSE = JSON.stringify({
  screen: 'popup', action: 'tap_close', target: { x: 900, y: 100, w: 40, h: 40 }, confidence: 0.93, reason: '活动弹窗',
  risk: { level: 'low', effect: 'dismiss', buttonText: '关闭', dialogText: '限时活动', consequence: '关闭弹窗', reason: '不花钱', hazards: [] },
});
const PURCHASE = JSON.stringify({
  screen: 'dialog', action: 'tap_confirm', target: { x: 600, y: 430, w: 180, h: 80 }, confidence: 0.97, reason: '购买',
  risk: { level: 'low', effect: 'purchase', buttonText: '购买', dialogText: '是否花费 100 钻石', consequence: '扣钻石', reason: '模型觉得便宜', hazards: [] },
});
const DOWNLOADING = JSON.stringify({
  screen: 'update', action: 'none', target: null, confidence: 0.9, reason: '正在下载更新',
  risk: { level: 'low', effect: 'download_update', buttonText: '无', dialogText: '正在下载资源 35%', consequence: '等待下载完成', reason: '官方资源下载', hazards: [] },
});

const KICKED = JSON.stringify({
  screen: 'kicked', action: 'none', target: null, confidence: 0.95, reason: '您已经在其他设备上登录了',
  risk: { level: 'low', effect: 'acknowledge', buttonText: '确定', dialogText: '您已经在其他设备上登录了', consequence: '回到登录', reason: '顶号', hazards: [] },
});

describe('AiRecoveryService', () => {
  let home: string;
  let api: FakeApi;
  let advisor: AdvisorService;
  let clock: number;
  let screen: RawFrame[];
  let taps: Array<[number, number]>;
  let createdAt: string;
  let foreground: string;
  let verdicts: UpdateVerdict[];
  let recognized: (raw: RawFrame) => boolean;
  let attention: Array<{ index: number; code: string; stage: string; context: string }>;
  let saved: string[];
  let logs: string[];
  let deps: AiRecoveryDeps;
  let lane: number;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'avdm-ai-recovery-'));
    api = new FakeApi();
    clock = 5_000_000;
    advisor = new AdvisorService(home, async () => { throw new Error('unused'); }, { fetch: api.fetch, now: () => clock, log: () => undefined });
    const popup = makeFrame(150);
    screen = [popup];
    taps = [];
    createdAt = 'avd-1';
    foreground = PKG;
    verdicts = [];
    recognized = () => false;
    attention = [];
    saved = [];
    logs = [];
    lane = 0;
    deps = {
      gameId: 'wanlong',
      packageName: PKG,
      advisor,
      manager: {
        getState: async () => ({ status: 'running', record: { createdAt } }),
        device: async () => ({
          screencapRaw: async () => screen[0]!,
          foregroundPackage: async () => foreground,
          tap: async (x, y) => { taps.push([x, y]); if (screen.length > 1) screen.shift(); },
        }),
      },
      lane: async (_index, work) => { lane++; return work(); },
      instanceTemplateSet: async () => set,
      loadTemplateSet: async () => set,
      recognize: async (_index, raw) => recognized(raw),
      match: async (_index, _dir, _raw, ids): Promise<MatchResult[]> => ids.map((templateId) => ({
        templateId, found: false, score: 0, x: -1, y: -1, w: 0, h: 0, centerX: -1, centerY: -1, threshold: 0.85, elapsedMs: 0,
      })),
      updateVerdict: async () => verdicts.shift() ?? NO_UPDATE,
      saveTemplate: async (_dir, draft) => { saved.push(draft.id!); return { id: draft.id!, std: 40 }; },
      onNeedsAttention: (index, info, context) => { attention.push({ index, code: info.code, stage: info.stage, context }); },
      log: (level, message) => logs.push(`[${level}] ${message}`),
      sleep: async (ms) => { clock += ms; },
      now: () => clock,
    };
  });
  afterEach(async () => { await rm(home, { recursive: true, force: true }); });

  async function enableAi(patch: Record<string, unknown> = {}): Promise<void> {
    await advisor.saveConfig({ baseUrl: 'https://ai.example.test/v1', model: 'fake-vl', apiKey: 'sk-test-abcdefgh', cooldownSeconds: 0, refine: false, autoActions: true, ...patch });
    await advisor.saveConfig({ enabled: true });
  }

  it('handles the calibrated update prompt even with the AI off: one tap (scaled to the device), wait, "updated"', async () => {
    const service = new AiRecoveryService(deps);
    const target = { x: 1280, y: 900 };
    verdicts = [{ target, downloading: false, progress: false }, { target, downloading: false, progress: false }, { target: null, downloading: true, progress: true }];
    let polls = 0;
    recognized = () => ++polls >= 2;
    await expect(service.adviseGather(3, screen[0]!, 1)).resolves.toBe(true);
    expect(taps).toEqual([[640, 450]]);
    expect(api.calls).toHaveLength(0);
    expect(await advisor.history()).toHaveLength(0);
    expect(lane).toBeGreaterThan(0);
  });

  it('with the AI off and no update: nothing is asked, nothing recorded, the caller keeps its BACK ladder', async () => {
    const service = new AiRecoveryService(deps);
    await expect(service.adviseGather(3, screen[0]!, 2)).resolves.toBe(false);
    expect(api.calls).toHaveLength(0);
    expect(taps).toHaveLength(0);
    expect(await advisor.history()).toHaveLength(0);
  });

  it('without update crops and with the AI off the device is not touched at all', async () => {
    const bare = { ...set, templates: [{ id: 'tpl_nav_city_toggle' }] } as unknown as TemplateSet;
    const getState = vi.fn(deps.manager.getState);
    const service = new AiRecoveryService({ ...deps, instanceTemplateSet: async () => bare, manager: { ...deps.manager, getState } });
    await expect(service.recoverForSampler(3, screen[0]!)).resolves.toBe(false);
    expect(getState).not.toHaveBeenCalled();
    expect(lane).toBe(0);
  });

  it('AI close: taps the close box in reference space, verifies on the worker, learns the template → handled', async () => {
    await enableAi();
    api.queue({ status: 200, body: chatBody(CLOSE) });
    // The click frame is the popup again; the tap reveals a known screen.
    screen = [screen[0]!, makeFrame(40)];
    recognized = (raw) => raw.data[0] === 40;
    const service = new AiRecoveryService(deps);
    await expect(service.adviseGather(4, screen[0]!, 3)).resolves.toBe(true);
    // Image 1280 wide → box ×2 in 2560 reference → centre (1840,240) → device (920,120).
    expect(taps).toEqual([[920, 120]]);
    expect(saved).toEqual(['tpl_btn_close_popup']);
    const [record] = await advisor.history();
    expect(record).toMatchObject({ outcome: 'harvested', context: 'gather-g0', index: 4, harvestedTemplateId: 'tpl_btn_close_popup' });
  });

  it('AI risk block: the alerts port hears it (stage AI 操作风险评估) and the code is rethrown; nothing tapped', async () => {
    await enableAi();
    api.queue({ status: 200, body: chatBody(PURCHASE) });
    const service = new AiRecoveryService(deps);
    await expect(service.adviseGather(5, screen[0]!, 1)).rejects.toMatchObject({ code: 'AI_RISK_BLOCKED' });
    expect(attention).toEqual([{ index: 5, code: 'AI_RISK_BLOCKED', stage: 'AI 操作风险评估', context: 'gather-g0' }]);
    expect(taps).toHaveLength(0);
    const [record] = await advisor.history();
    expect(record).toMatchObject({ outcome: 'rejected', requiresAttention: true });
  });

  it('a confident 「被顶号」 reading goes to the alerts port with its screen (never a tap or BACK) — only when 自动处理 is on', async () => {
    const screens: Array<string | undefined> = [];
    deps.onNeedsAttention = (index, info, context) => { attention.push({ index, code: info.code, stage: info.stage, context }); screens.push(info.screen); };
    await enableAi();
    api.queue({ status: 200, body: chatBody(KICKED) });
    await expect(new AiRecoveryService(deps).adviseGather(3, screen[0]!, 1)).rejects.toMatchObject({ code: 'AI_RISK_BLOCKED' });
    expect(attention).toEqual([{ index: 3, code: 'AI_RISK_BLOCKED', stage: 'AI 操作风险评估', context: 'gather-g0' }]);
    expect(screens).toEqual(['kicked']);
    expect(taps).toHaveLength(0);
    // Advice-only mode never changes what happens on the device: no verdict, the caller keeps its ladder.
    await enableAi({ autoActions: false });
    api.queue({ status: 200, body: chatBody(KICKED) });
    clock += 60_000;
    await expect(new AiRecoveryService(deps).adviseGather(3, screen[0]!, 1)).resolves.not.toBe('recovered');
    expect(screens).toEqual(['kicked']);
  });

  it('AI「正在下载更新」reuses the update wait only when 自动处理 is on', async () => {
    await enableAi({ autoActions: false });
    api.queue({ status: 200, body: chatBody(DOWNLOADING) });
    let polls = 0;
    recognized = () => ++polls >= 1;
    const service = new AiRecoveryService(deps);
    await expect(service.recoverForSampler(6, screen[0]!)).resolves.toBe(false);
    expect(polls).toBe(0);

    await advisor.saveConfig({ autoActions: true });
    api.queue({ status: 200, body: chatBody(DOWNLOADING) });
    await expect(service.recoverForSampler(6, screen[0]!)).resolves.toBe('updated');
    expect(polls).toBe(1);
    expect(taps).toHaveLength(0);
  });

  it('sampler: ordinary errors are logged and count as not handled; attention codes and aborts propagate', async () => {
    const broken = new AiRecoveryService({ ...deps, manager: { ...deps.manager, getState: async () => { throw new Error('adb 掉线'); } } });
    await expect(broken.recoverForSampler(1, screen[0]!)).resolves.toBe(false);
    expect(logs.some((line) => line.includes('按未处理继续') && line.includes('adb 掉线'))).toBe(true);

    await enableAi();
    api.queue({ status: 200, body: chatBody(PURCHASE) });
    await expect(new AiRecoveryService(deps).recoverForSampler(1, screen[0]!)).rejects.toMatchObject({ code: 'AI_RISK_BLOCKED' });
    // Every chain tells the alerts port (the host pauses and alerts there), not only gather and scripts.
    expect(attention).toEqual([{ index: 1, code: 'AI_RISK_BLOCKED', stage: 'AI 操作风险评估', context: 'scheduler-sample' }]);
    const controller = new AbortController();
    controller.abort(new Error('调度已停止'));
    await expect(new AiRecoveryService(deps).recoverForSampler(1, screen[0]!, controller.signal)).rejects.toThrow('调度已停止');
  });

  it('a replaced AVD or a foreign foreground app stops the tap', async () => {
    await enableAi();
    api.queue({ status: 200, body: chatBody(CLOSE) });
    const service = new AiRecoveryService({
      ...deps,
      manager: {
        ...deps.manager,
        // Identity holds for the first captures, then the AVD at this index is replaced before the tap.
        getState: vi.fn().mockResolvedValueOnce({ status: 'running', record: { createdAt } })
          .mockResolvedValueOnce({ status: 'running', record: { createdAt } })
          .mockResolvedValue({ status: 'running', record: { createdAt: 'avd-2' } }),
      },
    });
    await expect(service.adviseGather(7, screen[0]!, 1)).resolves.toBe(false);
    expect(taps).toHaveLength(0);
    expect((await advisor.history())[0]?.message).toContain('已停止或被替换');
  });

  it('acts for the AVD the running job / script run was admitted with, never for a replacement', async () => {
    await enableAi();
    // Gather / sampler: the job was admitted on avd-0; the AVD at this index is avd-1 now.
    api.queue({ status: 200, body: chatBody(CLOSE) });
    const replaced = new AiRecoveryService({ ...deps, admittedIdentity: () => 'avd-0' });
    await expect(replaced.adviseGather(4, screen[0]!, 1)).rejects.toThrow('已被替换');
    await expect(replaced.recoverForSampler(4, screen[0]!)).resolves.toBe(false);
    // No running job: nothing to act for.
    const idle = new AiRecoveryService({ ...deps, admittedIdentity: () => null });
    await expect(idle.recoverForSampler(4, screen[0]!)).resolves.toBe(false);
    expect(logs.some((line) => line.includes('没有正在运行的采样或采集'))).toBe(true);
    // Script run admitted on avd-0.
    const result = await new AiRecoveryService(deps).assistScript({
      gameId: 'wanlong', runId: 'r3', instanceIndex: 2, instanceIdentity: 'avd-0', scriptId: 's1', templateSetId: null, templateDir: null,
      stepId: null, reason: '超时', expectTemplateIds: [], signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ handled: false, message: expect.stringContaining('已被替换') });
    expect(taps).toHaveLength(0);
    expect(api.calls).toHaveLength(0);

    // The admitted AVD is still there: the tap goes through, and the frame checks run where the port says.
    const compared: string[] = [];
    screen = [screen[0]!, makeFrame(40)];
    recognized = (raw) => raw.data[0] === 40;
    const same = new AiRecoveryService({
      ...deps, admittedIdentity: () => createdAt,
      frames: () => ({
        meanAbsDiff: async () => { compared.push('diff'); return 30; },
        stableTarget: async () => { compared.push('stable'); return true; },
      }),
    });
    await expect(same.adviseGather(4, screen[0]!, 1)).resolves.toBe(true);
    expect(taps).toEqual([[920, 120]]);
    expect(compared).toEqual(['stable', 'diff']);
  });

  it('an instance paused by an alert is not touched by any automatic chain: no consult, no update tap, no AI tap', async () => {
    await enableAi();
    api.queue({ status: 200, body: chatBody(CLOSE) });
    const target = { x: 1280, y: 900 };
    verdicts = [{ target, downloading: false, progress: false }];
    const service = new AiRecoveryService({ ...deps, paused: (index) => (index === 3 ? '疑似被顶号' : null) });
    await expect(service.adviseGather(3, screen[0]!, 1)).resolves.toBe(false);
    await expect(service.recoverForSampler(3, screen[0]!)).resolves.toBe(false);
    const result = await service.assistScript({
      gameId: 'wanlong', runId: 'r4', instanceIndex: 3, instanceIdentity: createdAt, scriptId: 's1', templateSetId: null, templateDir: null,
      stepId: null, reason: '超时', expectTemplateIds: [], signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ handled: false, message: expect.stringContaining('已因异常被暂停（疑似被顶号）') });
    expect(taps).toHaveLength(0);
    expect(api.calls).toHaveLength(0);
    expect(lane).toBe(0);
    expect(attention).toHaveLength(0);
    expect(logs.some((line) => line.includes('已因异常被暂停'))).toBe(true);
    // A port that cannot answer counts as paused (never tap on a guess).
    const unsure = new AiRecoveryService({ ...deps, paused: () => { throw new Error('读不出'); } });
    await expect(unsure.adviseGather(4, screen[0]!, 1)).resolves.toBe(false);
    expect(taps).toHaveLength(0);
  });

  it('a pause that lands while the AI is thinking stops the tap', async () => {
    await enableAi();
    api.queue({ status: 200, body: chatBody(CLOSE) });
    // Paused by another chain's alert once the model has been asked.
    const service = new AiRecoveryService({ ...deps, paused: () => (api.calls.length > 0 ? '掉线' : null) });
    await expect(service.adviseGather(4, screen[0]!, 1)).resolves.toBe(false);
    expect(api.calls).toHaveLength(1);
    expect(taps).toHaveLength(0);
    expect((await advisor.history())[0]?.message).toContain('已因异常被暂停（掉线）');
  });

  it('script runs: gated by the advisor and the plan switch; the step\'s own templates are the known screen', async () => {
    const request = {
      gameId: 'wanlong', runId: 'r1', instanceIndex: 2, instanceIdentity: 'avd-1', scriptId: 's1', templateSetId: 'tset_test', templateDir: SET_DIR,
      stepId: 'step-3', reason: '等不到「确认」按钮', expectTemplateIds: ['tpl_btn_confirm', 'tpl_missing'], signal: new AbortController().signal,
    };
    const service = new AiRecoveryService({ ...deps, planAiAssist: async () => false });
    expect(await service.assistScript(request)).toMatchObject({ handled: false, message: expect.stringContaining('没开启') });
    await enableAi();
    expect(await service.assistScript(request)).toMatchObject({ handled: false, message: expect.stringContaining('关掉了') });

    const matched: string[][] = [];
    const active = new AiRecoveryService({
      ...deps,
      match: async (_index, _dir, raw, ids) => {
        matched.push(ids);
        return ids.map((templateId) => ({
          templateId, found: raw.data[0] === 40, score: 0.9, x: 0, y: 0, w: 1, h: 1, centerX: 0, centerY: 0, threshold: 0.85, elapsedMs: 0,
        }));
      },
    });
    api.queue({ status: 200, body: chatBody(CLOSE) });
    screen = [screen[0]!, makeFrame(40)];
    const result = await active.assistScript(request);
    expect(result).toMatchObject({ handled: true });
    expect(result.message).toContain('等不到「确认」按钮');
    expect(matched).toContainEqual(['tpl_btn_confirm']);
    expect((await advisor.history())[0]).toMatchObject({ context: 'script-run', index: 2 });

    api.queue({ status: 200, body: chatBody(PURCHASE) });
    const blocked = await active.assistScript(request);
    expect(blocked).toMatchObject({ handled: false, requiresAttention: true });
    expect(attention.at(-1)).toMatchObject({ index: 2, code: 'AI_RISK_BLOCKED', context: 'script-run' });
  });

  it('script runs with 自动处理 off: the suggestion is recorded and the device is never touched', async () => {
    await enableAi({ autoActions: false });
    api.queue({ status: 200, body: chatBody(CLOSE) });
    const service = new AiRecoveryService(deps);
    const result = await service.assistScript({
      gameId: 'wanlong', runId: 'r2', instanceIndex: 2, instanceIdentity: 'avd-1', scriptId: 's1', templateSetId: null, templateDir: null,
      stepId: null, reason: '超时', expectTemplateIds: [], signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ handled: false, message: expect.stringContaining('自动处理') });
    expect(taps).toHaveLength(0);
    expect((await advisor.history())[0]).toMatchObject({ outcome: 'advised', context: 'script-run' });
  });
});
