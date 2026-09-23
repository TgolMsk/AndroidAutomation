import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdvisorService, type AdvisorCapturePort, type AdvisorConsultTarget } from '../src/main/automation/advisor';
import { parseAdvice, riskRejection } from '../src/main/automation/advisor/risk';
import type { VisionFetch } from '../src/main/automation/advisor/client';

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
  return { status: 200, text: async () => JSON.stringify({ model: 'vision-test', choices: [{ message: { content: JSON.stringify(value) } }] }) };
}

describe('read-only AI advisor', () => {
  let home: string;
  let capture: ReturnType<typeof vi.fn<AdvisorCapturePort>>;
  let request: ReturnType<typeof vi.fn<VisionFetch>>;
  let now: number;
  let advisor: AdvisorService;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'avdm-advisor-'));
    now = 2_000_000;
    capture = vi.fn<AdvisorCapturePort>(async () => ({
      foregroundPackage: target.packageName,
      frame: { width: 100, height: 80, capturedAt, data: new Uint8Array(100 * 80 * 4).fill(240) },
    }));
    request = vi.fn<VisionFetch>(async () => reply(safeClose));
    advisor = new AdvisorService(home, capture, { fetch: request, now: () => now });
  });
  afterEach(async () => { await rm(home, { recursive: true, force: true }); });

  async function configure(): Promise<void> {
    await advisor.saveConfig({ baseUrl: 'https://vision.example/v1', model: 'vision-test', apiKey: secret, enabled: true,
      cooldownSeconds: 0 });
  }

  it('keeps provider credentials private and defaults to no capture or network request', async () => {
    expect((await advisor.config()).apiKeySet).toBe(false);
    expect((await advisor.consult(target)).outcome).toBe('skipped');
    expect(capture).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();

    await configure();
    const view = await advisor.config();
    expect('apiKey' in view).toBe(false);
    expect(view.apiKeyMasked).toBe('••••••3456');
    expect(JSON.stringify(view)).not.toContain(secret);
    const file = path.join(home, 'automation', 'advisor.json');
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await readFile(file, 'utf8'))).toContain(secret);
  });

  it('returns structured safe-close advice and a manual template candidate without device input', async () => {
    await configure();
    const result = await advisor.consult(target);
    expect(result.outcome).toBe('advised');
    expect(result.advice).toMatchObject({ action: 'tap_close', review: 'manual_review', target: safeClose.target });
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
    expect(JSON.stringify(await advisor.history())).not.toContain(secret);
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
    if (missingRisk.ok) expect(riskRejection(missingRisk.value, .5)).toContain('风险等级');
    expect(parseAdvice(JSON.stringify({ ...safeClose, action: 'adb_shell' }), 100, 80).ok).toBe(false);
    const qwenBox = parseAdvice(JSON.stringify({ ...safeClose, target: { bbox: [20, 15, 36, 31] } }), 100, 80);
    expect(qwenBox.ok && qwenBox.value.target).toEqual(safeClose.target);

    await configure();
    request.mockResolvedValue(reply({ ...safeClose, confidence: .2 }));
    expect((await advisor.consult(target)).outcome).toBe('blocked');
    capture.mockResolvedValueOnce({ foregroundPackage: 'com.other.app', frame: {
      width: 100, height: 80, capturedAt, data: new Uint8Array(100 * 80 * 4),
    } });
    expect((await advisor.consult(target)).outcome).toBe('skipped');
    expect(request).toHaveBeenCalledOnce();
  });

  it('persists hourly quota and history across a restart', async () => {
    await configure();
    await advisor.saveConfig({ maxCallsPerHour: 1 });
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
  });

  it('tests vision with a synthetic image and records no game screenshot', async () => {
    await advisor.saveConfig({ baseUrl: 'https://vision.example/v1', model: 'vision-test', apiKey: secret });
    request.mockResolvedValue({ status: 200, text: async () => JSON.stringify({ model: 'vision-test', choices: [{ message: { content: 'W' } }] }) });
    const result = await advisor.test();
    expect(result).toMatchObject({ ok: true, vision: true });
    expect(capture).not.toHaveBeenCalled();
    expect((await advisor.history())[0]).toMatchObject({ context: 'vision-test', outcome: 'test_passed' });
  });

  it('scrubs the key from provider errors and does not follow redirects', async () => {
    await configure();
    request.mockRejectedValue(new Error(`Authorization failed for ${secret}`));
    const result = await advisor.consult(target);
    expect(result.outcome).toBe('failed');
    expect(result.message).not.toContain(secret);
    expect(JSON.stringify(await advisor.history())).not.toContain(secret);
  });

  it('distinguishes a vision-incompatible provider without exposing its response body', async () => {
    await advisor.saveConfig({ baseUrl: 'https://vision.example/v1', model: 'text-only', apiKey: secret });
    request.mockResolvedValue({ status: 400, text: async () => JSON.stringify({ error: { message: `image input unsupported; ${secret}` } }) });
    const result = await advisor.test();
    expect(result.vision).toBe(false);
    expect(result.message).toContain('不接受图片');
    expect(result.message).not.toContain(secret);
    expect(JSON.stringify(await advisor.history())).not.toContain(secret);
  });
});
