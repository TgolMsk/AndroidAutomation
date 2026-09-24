import { mkdtemp, readdir, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdvisorService, type AdvisorCapturePort, type AdvisorConsultTarget } from '../src/main/automation/advisor';
import { adviceRejection, parseAdvice, riskRejection } from '../src/main/automation/advisor/risk';
import { ADVISOR_FILE_MAX_BYTES, AdvisorStore, emptyAdvisorFile } from '../src/main/automation/advisor/store';
import type { VisionFetch } from '../src/main/automation/advisor/client';
import type { AdvisorAdvice, AdvisorConfigView, AdvisorRecord } from '../src/shared/ai';

const secret = 'sk-private-123456';
const target: AdvisorConsultTarget = {
  gameId: 'wanlong', gameName: '万龙觉醒', packageName: 'com.example.wanlong', index: 1, context: 'manual',
};
const capturedAt = 1_000_000;
const safeClose = {
  screen: 'popup', action: 'tap_close', target: { x: 20, y: 15, w: 16, h: 16 },
  confidence: .94, reason: '关闭公告',
  risk: { level: 'low', effect: 'dismiss', buttonText: '×', dialogText: '活动公告', consequence: '只关闭公告', reason: '不影响资源', hazards: [] },
};
function reply(value: unknown) {
  return { status: 200, text: async () => JSON.stringify({ model: 'vision-test', choices: [{ message: { content: typeof value === 'string' ? value : JSON.stringify(value) } }] }) };
}
/** A blocked risky-popup record at every per-field cap (CJK: 3 bytes a character). */
function maxedAdvice(): AdvisorAdvice {
  const cjk = (n: number): string => '风'.repeat(n);
  return {
    screen: 'dialog', action: 'tap_confirm', target: { x: 600, y: 430, w: 180, h: 80 }, confidence: 0.97, reason: cjk(200),
    risk: {
      level: 'high', effect: 'purchase', buttonText: cjk(80), dialogText: cjk(600), consequence: cjk(240), reason: cjk(240),
      hazards: Array.from({ length: 20 }, () => cjk(120)),
    },
    model: 'vision-test', review: 'blocked', reviewReason: cjk(300), space: 'reference', latencyMs: 1200,
  };
}
function frame(width = 100, height = 80) {
  return { width, height, capturedAt, data: new Uint8Array(width * height * 4).fill(240) };
}

describe('AI advisor (read-only service)', () => {
  let home: string;
  let capture: ReturnType<typeof vi.fn<AdvisorCapturePort>>;
  let request: ReturnType<typeof vi.fn<VisionFetch>>;
  let now: number;
  let advisor: AdvisorService;
  let records: AdvisorRecord[];
  let views: AdvisorConfigView[];

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'avdm-advisor-'));
    now = 2_000_000;
    records = [];
    views = [];
    capture = vi.fn<AdvisorCapturePort>(async () => ({ foregroundPackage: target.packageName, frame: frame() }));
    request = vi.fn<VisionFetch>(async () => reply(safeClose));
    advisor = new AdvisorService(home, capture, {
      fetch: request, now: () => now, onRecord: (record) => records.push(record), onConfigChanged: (view) => views.push(view), log: () => undefined,
    });
  });
  afterEach(async () => { await rm(home, { recursive: true, force: true }); });

  async function configure(patch: Record<string, unknown> = {}): Promise<void> {
    await advisor.saveConfig({ baseUrl: 'https://vision.example/v1', model: 'vision-test', apiKey: secret, enabled: true,
      cooldownSeconds: 0, refine: false, ...patch });
  }

  it('starts from the original defaults: off, 百炼 compatible endpoint, qwen3.8-flash, refine and harvest on, autoActions off', async () => {
    const view = await advisor.config();
    expect(view).toMatchObject({
      enabled: false, baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen3.8-flash', timeoutMs: 40_000,
      maxCallsPerHour: 20, cooldownSeconds: 20, imageWidth: 1280, refine: true, autoHarvest: true, autoActions: false, minConfidence: .5,
      apiKeySet: false,
    });
    expect(advisor.isActive()).toBe(false);
  });

  it('keeps provider credentials private and defaults to no capture or network request', async () => {
    expect((await advisor.consult(target)).outcome).toBe('skipped');
    expect(capture).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();

    await configure();
    const view = await advisor.config();
    expect('apiKey' in view).toBe(false);
    expect(view.apiKeyMasked).toBe('••••••3456');
    expect(JSON.stringify(view)).not.toContain(secret);
    expect(views.at(-1)).toEqual(view);
    expect(JSON.stringify(views)).not.toContain(secret);
    const file = path.join(home, 'automation', 'advisor.json');
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await readFile(file, 'utf8'))).toContain(secret);
  });

  it('returns structured safe-close advice and a manual template candidate without device input', async () => {
    await configure();
    const result = await advisor.consult(target);
    expect(result.outcome).toBe('advised');
    expect(result.advice).toMatchObject({ action: 'tap_close', review: 'manual_review', target: safeClose.target, space: 'frame' });
    expect(result.templateProposal).toMatchObject({
      gameId: 'wanlong', index: 1, sourceCapturedAt: capturedAt,
      frameWidth: 100, frameHeight: 80, box: safeClose.target, sourceRecordId: result.id,
    });
    expect(capture).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledOnce();
    const [, init] = request.mock.calls[0]!;
    expect(init.headers.authorization).toBe(`Bearer ${secret}`);
    expect(init.redirect).toBe('error');
    expect(init.body).toContain('data:image/jpeg;base64,');
    // 万龙 uses the original game prompt (screen classes world_map / city / troop_panel / kicked).
    expect(init.body).toContain('万龙觉醒');
    expect(init.body).toContain('world_map');
    expect(JSON.stringify(await advisor.history())).not.toContain(secret);
    expect(records.map((record) => record.id)).toContain(result.id);
  });

  it('refines a close box on a magnified crop (second request, PNG) and records two provider calls', async () => {
    await configure({ refine: true });
    request.mockResolvedValueOnce(reply(safeClose)).mockResolvedValueOnce(reply({ target: { x: 44, y: 34, w: 28, h: 28 }, confidence: .9 }));
    const result = await advisor.consult(target);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]![1].body).toContain('data:image/png;base64,');
    expect(result.advice?.refined).toBe(true);
    expect(result.providerCalls).toBe(2);
    // Crop (0,0)–(96,80) doubled to 192×160: (44,34 28×28) on the crop → (22,17 14×14) on the frame.
    expect(result.advice?.target).toEqual({ x: 22, y: 17, w: 14, h: 14 });
  });

  it('automatic chains skip the refine request while「自动处理」is off (the box is only recorded)', async () => {
    const input = { gameId: 'wanlong', instanceIndex: 2, context: 'gather-g0', raw: frame(1280, 720), refWidth: 2560, refHeight: 1440, attempt: 1 };
    await configure({ refine: true, autoActions: false });
    request.mockResolvedValue(reply({ ...safeClose, target: { x: 200, y: 100, w: 40, h: 40 } }));
    const recorded = await advisor.consultFrame(input);
    expect(request).toHaveBeenCalledOnce();
    expect(recorded).toMatchObject({ providerCalls: 1, advice: { refined: false } });

    await advisor.saveConfig({ autoActions: true });
    request.mockReset();
    request.mockResolvedValueOnce(reply({ ...safeClose, target: { x: 200, y: 100, w: 40, h: 40 } }))
      .mockResolvedValueOnce(reply({ target: { x: 40, y: 40, w: 60, h: 60 }, confidence: .9 }));
    const acted = await advisor.consultFrame(input);
    expect(request).toHaveBeenCalledTimes(2);
    expect(acted).toMatchObject({ providerCalls: 2, advice: { refined: true } });
  });

  it('blocks a purchased resource even when a model labels it low risk', async () => {
    await configure();
    request.mockResolvedValue(reply({ ...safeClose, action: 'tap_confirm', risk: {
      ...safeClose.risk, effect: 'purchase', buttonText: '购买', consequence: '花费钻石购买物品',
    } }));
    const result = await advisor.consult(target);
    expect(result.outcome).toBe('blocked');
    expect(result.advice?.reviewReason).toContain('purchase');
    expect(result.templateProposal).toBeNull();
  });

  it('fails closed on missing hazards, unknown actions, low confidence and changed foreground', async () => {
    const missingRisk = parseAdvice(JSON.stringify({ ...safeClose, risk: { ...safeClose.risk, hazards: undefined } }), 100, 80);
    expect(missingRisk.ok).toBe(true);
    if (missingRisk.ok) {
      expect(riskRejection(missingRisk.value)).toContain('风险不明');
      expect(adviceRejection(missingRisk.value, .5)).toContain('风险不明');
    }
    expect(parseAdvice(JSON.stringify({ ...safeClose, action: 'adb_shell' }), 100, 80).ok).toBe(false);
    const qwenBox = parseAdvice(JSON.stringify({ ...safeClose, target: { bbox: [20, 15, 36, 31] } }), 100, 80);
    expect(qwenBox.ok && qwenBox.value.target).toEqual(safeClose.target);

    await configure();
    request.mockResolvedValue(reply({ ...safeClose, confidence: .2 }));
    expect((await advisor.consult(target)).outcome).toBe('blocked');
    capture.mockResolvedValueOnce({ foregroundPackage: 'com.other.app', frame: frame() });
    expect((await advisor.consult(target)).outcome).toBe('skipped');
    expect(request).toHaveBeenCalledOnce();
  });

  it('persists hourly quota and history across a restart; 0 means unlimited', async () => {
    await configure({ maxCallsPerHour: 1 });
    expect((await advisor.consult(target)).outcome).toBe('advised');
    const another = new AdvisorService(home, capture, { fetch: request, now: () => now });
    expect((await another.status()).callsLastHour).toBe(1);
    expect((await another.consult(target)).outcome).toBe('skipped');
    expect(request).toHaveBeenCalledOnce();
    expect((await another.history()).length).toBe(2);
    expect((await another.history())[1]?.templateProposal).toMatchObject({ sourceRecordId: (await another.history())[1]?.id });
    now += 3_600_001;
    expect((await another.status()).callsLastHour).toBe(0);
    expect((await another.consult(target)).outcome).toBe('advised');
    await another.saveConfig({ maxCallsPerHour: 0 });
    for (let i = 0; i < 3; i++) expect((await another.consult(target)).outcome).toBe('advised');
    expect((await another.status()).maxCallsPerHour).toBe(0);
  });

  it('tests vision with a synthetic image, accepts「这个字母是 W。」and rejects a refusal', async () => {
    await advisor.saveConfig({ baseUrl: 'https://vision.example/v1', model: 'vision-test', apiKey: secret });
    request.mockResolvedValueOnce(reply('W'));
    expect(await advisor.test()).toMatchObject({ ok: true, vision: true, kind: null, reply: 'W' });
    request.mockResolvedValueOnce(reply('这个字母是 W。'));
    expect(await advisor.test()).toMatchObject({ ok: true, vision: true });
    request.mockResolvedValueOnce(reply('I cannot view images. Why not describe it?'));
    const refused = await advisor.test();
    expect(refused).toMatchObject({ ok: false, vision: false, kind: 'vision' });
    expect(refused.reply).toContain('cannot view');
    expect(capture).not.toHaveBeenCalled();
    expect((await advisor.history())[1]).toMatchObject({ context: 'vision-test', outcome: 'test_passed' });
    // The test is never charged to (or blocked by) the hourly quota.
    expect((await advisor.status()).callsLastHour).toBe(0);
  });

  it('scrubs the key from provider errors and does not follow redirects', async () => {
    await configure();
    request.mockRejectedValue(new Error(`Authorization failed for ${secret}`));
    const result = await advisor.consult(target);
    expect(result.outcome).toBe('failed');
    expect(result.message).not.toContain(secret);
    expect(JSON.stringify(await advisor.history())).not.toContain(secret);
  });

  it('distinguishes a vision-incompatible provider without exposing the key', async () => {
    await advisor.saveConfig({ baseUrl: 'https://vision.example/v1', model: 'text-only', apiKey: secret });
    request.mockResolvedValue({ status: 400, text: async () => JSON.stringify({ error: { message: `image input unsupported; ${secret}` } }) });
    const result = await advisor.test();
    expect(result.vision).toBe(false);
    expect(result.kind).toBe('vision');
    expect(result.message).toContain('不接受图片');
    expect(result.message).not.toContain(secret);
    expect(JSON.stringify(await advisor.history())).not.toContain(secret);
  });

  it('consultFrame: off records nothing, a recheck skips the cooldown but counts, boxes come back in reference space', async () => {
    const raw = frame(1280, 720);
    const input = { gameId: 'wanlong', instanceIndex: 2, context: 'gather-g0', raw, refWidth: 2560, refHeight: 1440, attempt: 3 };
    const off = await advisor.consultFrame(input);
    expect(off).toMatchObject({ advice: null, outcome: null });
    expect(request).not.toHaveBeenCalled();
    expect(await advisor.history()).toHaveLength(0);

    await configure({ cooldownSeconds: 60 });
    request.mockResolvedValue(reply({ ...safeClose, target: { x: 200, y: 100, w: 40, h: 40 } }));
    const first = await advisor.consultFrame(input);
    expect(first.advice).toMatchObject({ space: 'reference', target: { x: 400, y: 200, w: 80, h: 80 } });
    expect(request.mock.calls[0]![1].body).toContain('第 3 次尝试');
    const cooled = await advisor.consultFrame(input);
    expect(cooled).toMatchObject({ advice: null, outcome: 'skipped' });
    expect(cooled.reason).toContain('不足 60 秒');
    const recheck = await advisor.consultFrame({ ...input, recheck: true });
    expect(recheck.advice).not.toBeNull();
    expect(request.mock.calls[1]![1].body).toContain('这是点击前的新截图复核');
    expect((await advisor.status()).callsLastHour).toBe(2);
    // Automatic questions write no record themselves (the executor records one result per recovery).
    expect(await advisor.history()).toHaveLength(0);
  });

  it('claims a confirmation once per 60 s per instance, effect and text', async () => {
    const advice = { risk: { ...safeClose.risk, effect: 'acknowledge' as const, level: 'low' as const, buttonText: '确 定', dialogText: '连接已恢复' } };
    expect(advisor.claimConfirmation(1, advice)).toBe(true);
    expect(advisor.claimConfirmation(1, { risk: { ...advice.risk, buttonText: '确定' } })).toBe(false);
    expect(advisor.claimConfirmation(2, advice)).toBe(true);
    now += 60_000;
    expect(advisor.claimConfirmation(1, advice)).toBe(true);
  });

  it('moves a corrupt advisor.json aside, starts from defaults and says so', async () => {
    const dir = path.join(home, 'automation');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'advisor.json'), `{"version":1,"config":{"apiKey":"${secret}"`);
    const fresh = new AdvisorService(home, capture, { fetch: request, now: () => now, log: () => undefined });
    const status = await fresh.status();
    expect(status.enabled).toBe(false);
    expect(status.loadWarning).toContain('advisor.json.corrupt-');
    expect(status.loadWarning).not.toContain(secret);
    expect((await readdir(dir)).some((name) => name.startsWith('advisor.json.corrupt-'))).toBe(true);
    // Saving works again and replaces the warning.
    await fresh.saveConfig({ model: 'vision-test' });
    expect((await fresh.status()).loadWarning).toBeNull();
  });

  it('keeps 50 records at every field cap under the size bound; the kill switch always saves', async () => {
    await configure();
    for (let i = 0; i < 50; i++) {
      await advisor.note({
        gameId: 'wanlong', index: 1, context: 'gather-g0', outcome: 'blocked', message: '险'.repeat(500),
        advice: maxedAdvice(), harvestedTemplateId: null, requiresAttention: true, latencyMs: 1200, providerCalls: 1,
      });
    }
    const file = path.join(home, 'automation', 'advisor.json');
    expect((await stat(file)).size).toBeLessThanOrEqual(ADVISOR_FILE_MAX_BYTES);
    await expect(advisor.saveConfig({ enabled: false })).resolves.toMatchObject({ enabled: false });
    const reloaded = new AdvisorService(home, capture, { fetch: request, now: () => now, log: () => undefined });
    expect(await reloaded.history()).toHaveLength(50);
    expect((await reloaded.status()).enabled).toBe(false);
  });

  it('drops the oldest records to fit the bound instead of refusing to save (the config always fits)', async () => {
    const store = new AdvisorStore(home, { maxBytes: 64 * 1024 });
    const records: AdvisorRecord[] = Array.from({ length: 50 }, (_, i) => ({
      id: `r-${i}`, at: 1_000 + (50 - i), gameId: 'wanlong', index: 1, context: 'gather-g0', outcome: 'blocked',
      message: '险'.repeat(500), advice: maxedAdvice(), templateProposal: null, harvestedTemplateId: null,
      requiresAttention: true, latencyMs: 1200, providerCalls: 1,
    }));
    const data = { ...emptyAdvisorFile(), history: records };
    const kept = await store.save(data);
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(50);
    expect((await stat(store.file)).size).toBeLessThanOrEqual(64 * 1024);
    // Newest first: the file holds exactly the first `kept` records.
    expect((await store.load()).history.map((item) => item.id)).toEqual(records.slice(0, kept).map((item) => item.id));
    // A record alone larger than the bound: the config is still written, with no history.
    const tiny = new AdvisorStore(home, { maxBytes: 8 * 1024 });
    expect(await tiny.save(data)).toBe(0);
    expect((await tiny.load()).history).toEqual([]);

    // The service drops what the file could not hold, so the page shows what a restart would.
    const small = new AdvisorService(home, capture, { fetch: request, now: () => now, log: () => undefined, maxFileBytes: 64 * 1024 });
    for (const record of records.slice(0, 20)) {
      await small.note({
        gameId: 'wanlong', index: 1, context: 'gather-g0', outcome: 'blocked', message: record.message,
        advice: maxedAdvice(), harvestedTemplateId: null, latencyMs: 1200, providerCalls: 1,
      });
    }
    const shown = await small.history();
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.length).toBeLessThan(20);
    expect((await store.load()).history.map((item) => item.id)).toEqual(shown.map((item) => item.id));
    await expect(small.saveConfig({ model: 'vision-test-2' })).resolves.toMatchObject({ model: 'vision-test-2' });
  });

  it('rejects unknown keys and wrong types, and cannot enable an incomplete config', async () => {
    await expect(advisor.saveConfig({ bogus: 1 } as never)).rejects.toThrow('未知字段');
    await expect(advisor.saveConfig({ autoActions: 'yes' } as never)).rejects.toThrow('开关无效');
    await expect(advisor.saveConfig({ enabled: true })).rejects.toThrow('无法启用');
    await expect(advisor.saveConfig({ baseUrl: 'http://vision.example/v1', apiKey: secret, enabled: true })).rejects.toThrow('HTTPS');
    const view = await advisor.saveConfig({ autoActions: true, maxCallsPerHour: 99_999 });
    expect(view).toMatchObject({ autoActions: true, maxCallsPerHour: 500 });
  });
});
