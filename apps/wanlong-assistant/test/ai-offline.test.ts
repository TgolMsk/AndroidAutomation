/**
 * Port of the original `scripts/ai-offline-check.ts` (check:ai, 76 assertions). Nothing touches an emulator or the
 * network: the provider is a scripted fake, the device a fake IO over synthetic 2560×1440 frames, and the template
 * library lives in a temporary AVDM home.
 *   一 config · 二 client (+ ★ key-leak) · 三 vision probe · 四 reply parsing · 五 rate limits ·
 *   六 ★ end to end: close a popup → learn tpl_btn_close_popup → the real vision layer finds it again → no re-learning
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadPrepared, loadTemplateSet, matchTemplate, prepareFrame, TemplateLibrary, type RawFrame } from '@avdm/automation';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AdvisorService } from '../src/main/automation/advisor';
import { chatVision, completionsUrl } from '../src/main/automation/advisor/client';
import { parseAdvice } from '../src/main/automation/advisor/risk';
import {
  aiRecoverUnknownScreen, CLOSE_POPUP_TEMPLATE_ID, meanAbsDiff, nextHarvestId, type HarvestPort, type RecoverContext,
} from '../src/main/automation/ai-recover';
import { WANLONG_PROFILE } from '../src/main/automation/advisor/profiles';
import {
  aiConfigProblems, defaultAiConfig, mergeAiConfig, normalizeAiConfig, redactAiConfig, toAiConfigView,
  type AdvisorConfig, type AdvisorRecord,
} from '../src/shared/ai';
import { chatBody, FakeApi, imageUrlOf, type FakeReply } from './helpers/ai';

/** ★ Fake key: shaped like a real one, never valid. */
const FAKE_KEY = 'sk-fakekey-0123456789abcdefFAKE';
const FAKE_KEY_TAIL = '0123456789abcdefFAKE';
const leaks = (text: string): boolean => text.includes(FAKE_KEY) || text.includes(FAKE_KEY_TAIL);

function cfgWith(patch: Partial<AdvisorConfig> = {}): AdvisorConfig {
  return normalizeAiConfig({
    ...defaultAiConfig(), enabled: true, apiKey: FAKE_KEY, model: 'fake-vl', baseUrl: 'https://ai.example.test/v1',
    timeoutMs: 5000, cooldownSeconds: 0, ...patch,
  });
}

const homes: string[] = [];
async function tempHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), 'avdm-ai-offline-'));
  homes.push(home);
  return home;
}
afterAll(async () => { await Promise.all(homes.map((home) => rm(home, { recursive: true, force: true }))); });

const logs: string[] = [];
const emitted: AdvisorRecord[] = [];

async function makeAdvisor(api: FakeApi, patch: Partial<AdvisorConfig> = {}): Promise<AdvisorService> {
  const advisor = new AdvisorService(await tempHome(), async () => { throw new Error('手动截图不在本测试里'); }, {
    fetch: api.fetch,
    log: (level, message) => logs.push(`[${level}] ${message}`),
    onRecord: (record) => emitted.push(record),
  });
  const config = cfgWith(patch);
  await advisor.saveConfig({ ...config, enabled: false });
  if (config.enabled) await advisor.saveConfig({ enabled: true });
  return advisor;
}

// ── synthetic frames ──
// 2560×1440 RGBA. A 64 px checkerboard background (texture, so shrink-4 differences mean something); the「popup」is a
// light rectangle; the 80×80 white × with a black cross at (1840,220) is the close button to learn.
const W = 2560;
const H = 1440;
const BTN = { x: 1840, y: 220, w: 80, h: 80 };

function makeFrame(withPopup: boolean): RawFrame {
  const data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = ((x >> 6) + (y >> 6)) % 2 === 0 ? 92 : 112;
      if (withPopup) {
        if (x >= 700 && x < 1900 && y >= 200 && y < 1240) v = 205;
        const bx = x - BTN.x;
        const by = y - BTN.y;
        if (bx >= 0 && bx < BTN.w && by >= 0 && by < BTN.h) {
          v = 250;
          if (Math.abs(bx - by) < 6 || Math.abs(bx + by - (BTN.w - 1)) < 6) v = 10;
          if (bx < 3 || by < 3 || bx >= BTN.w - 3 || by >= BTN.h - 3) v = 40;
        }
      } else {
        // 「World map」landmarks: a dark block bottom-left and a bright bar on the right.
        if (x >= 100 && x < 300 && y >= 1250 && y < 1400) v = 30;
        if (x >= 2400 && x < 2420 && y >= 300 && y < 900) v = 240;
      }
      const i = (y * W + x) * 4;
      data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
    }
  }
  return { width: W, height: H, format: 1, data, capturedAt: Date.now() };
}

/** Recognition criterion: the popup region still light ⇒ the popup is still there ⇒ not a known screen. */
async function recognizeNoPopup(raw: RawFrame): Promise<boolean> {
  return raw.data[(600 * W + 1300) * 4]! < 150;
}

const CLOSE_RISK = '"risk":{"level":"low","effect":"dismiss","buttonText":"关闭","dialogText":"活动公告，右上角关闭","consequence":"关闭覆盖层回到游戏","reason":"不会付费或改变账号数据","hazards":[]}';

describe('一、配置', () => {
  it('defaults: off, 百炼 + qwen3.8-flash', () => {
    const d = defaultAiConfig();
    expect(d.enabled).toBe(false);
    expect(d.model).toBe('qwen3.8-flash');
    expect(d.baseUrl).toContain('dashscope');
    expect(d.autoActions).toBe(false);
  });

  it('normalize: non-boolean → default, out of range → clamped, trailing slash dropped', () => {
    const n = normalizeAiConfig({ enabled: 'yes', maxCallsPerHour: 99999, minConfidence: 7, baseUrl: ' https://x.test/v1/ ', imageWidth: 10 });
    expect(n).toMatchObject({ enabled: false, maxCallsPerHour: 500, minConfidence: 1, baseUrl: 'https://x.test/v1', imageWidth: 640 });
  });

  it('merge: apiKey is tri-state (absent keeps, empty clears, non-empty replaces)', () => {
    const base = cfgWith();
    const m1 = mergeAiConfig(base, { model: 'other' });
    expect(m1.apiKey).toBe(FAKE_KEY);
    expect(m1.model).toBe('other');
    expect(mergeAiConfig({ ...base, enabled: false }, { apiKey: '' }).apiKey).toBe('');
    expect(mergeAiConfig(base, { apiKey: 'sk-new-key-xxxxxxxx' }).apiKey).toBe('sk-new-key-xxxxxxxx');
  });

  it('★ the masked view has no apiKey key; the log shape is masked', () => {
    const base = cfgWith();
    const view = toAiConfigView(base) as unknown as Record<string, unknown>;
    expect('apiKey' in view).toBe(false);
    expect(view['apiKeySet']).toBe(true);
    expect(String(view['apiKeyMasked'])).toMatch(/FAKE$/);
    expect(leaks(String(view['apiKeyMasked']))).toBe(false);
    expect(leaks(JSON.stringify(redactAiConfig(base)))).toBe(false);
    expect(toAiConfigView({ ...base, apiKey: 'abcd' }).apiKeyMasked).toBe('••••');
  });

  it('local check: valid config passes; /chat/completions and a missing key are pointed out', () => {
    expect(aiConfigProblems(cfgWith())).toEqual([]);
    expect(aiConfigProblems(cfgWith({ baseUrl: 'https://x.test/v1/chat/completions' })).some((p) => p.includes('/chat/completions'))).toBe(true);
    expect(aiConfigProblems(cfgWith({ apiKey: '' })).some((p) => p.includes('API Key'))).toBe(true);
  });
});

describe('二、客户端', () => {
  const cfg = cfgWith();
  const img = new Uint8Array([1, 2, 3, 4]);
  const api = new FakeApi();
  const send = () => chatVision(cfg, { system: 'S', user: 'U', image: img, mime: 'image/png' }, api.fetch);

  it('request shape: URL, Bearer header, model, system + user, image as data URL', async () => {
    api.reset();
    api.queue({ status: 200, body: chatBody('hello') });
    const r = await send();
    expect(r).toMatchObject({ ok: true, text: 'hello', model: 'fake-vl' });
    const call = api.calls[0]!;
    expect(call.url).toBe(completionsUrl(cfg.baseUrl));
    expect(call.url.endsWith('/v1/chat/completions')).toBe(true);
    expect(call.headers['authorization']).toBe(`Bearer ${FAKE_KEY}`);
    const body = JSON.parse(call.body) as { model: string; messages: Array<{ role: string }> };
    expect(body.model).toBe('fake-vl');
    expect(body.messages[0]!.role).toBe('system');
    expect(body.messages[1]!.role).toBe('user');
    expect(imageUrlOf(call).startsWith('data:image/png;base64,AQIDBA==')).toBe(true);
  });

  it('content as an array of parts is read too', async () => {
    api.queue({ status: 200, body: JSON.stringify({ model: 'x', choices: [{ message: { content: [{ type: 'text', text: 'seg' }] } }] }) });
    const r = await send();
    expect(r.ok && r.text).toBe('seg');
  });

  const cases: Array<[string, FakeReply, string, (m: string) => boolean]> = [
    ['401 ⇒ auth', { status: 401, body: '{"error":{"message":"Invalid API key"}}' }, 'auth', (m) => m.includes('鉴权')],
    ['404 mentioning model ⇒ model', { status: 404, body: '{"error":{"message":"model not found"}}' }, 'model', (m) => m.includes('404')],
    ['404 otherwise ⇒ bad_request with the /v1 hint', { status: 404, body: '{"error":{"message":"no route"}}' }, 'bad_request', (m) => m.includes('/v1')],
    ['400 mentioning image ⇒ vision', { status: 400, body: '{"error":{"message":"This model does not support image input"}}' }, 'vision', (m) => m.includes('不接受图片')],
    ['400 otherwise ⇒ bad_request', { status: 400, body: '{"error":{"message":"max_tokens too large"}}' }, 'bad_request', (m) => m.includes('max_tokens')],
    ['429 ⇒ rate', { status: 429, body: '{"error":{"message":"rate limit"}}' }, 'rate', (m) => m.includes('限流')],
    ['500 ⇒ server', { status: 500, body: 'oops' }, 'server', (m) => m.includes('服务端')],
    ['200 but not JSON ⇒ bad_response', { status: 200, body: '<html>' }, 'bad_response', (m) => m.includes('不是 JSON')],
    ['200 but empty ⇒ bad_response', { status: 200, body: chatBody('') }, 'bad_response', (m) => m.includes('空内容')],
  ];
  it.each(cases)('%s', async (_name, response, kind, check) => {
    api.queue(response);
    const r = await send();
    expect(r.ok).toBe(false);
    expect(r.failureKind).toBe(kind);
    expect(check(r.failure ?? '')).toBe(true);
  });

  it('timeout ⇒ timeout, with the seconds and what to adjust', async () => {
    const error = new Error('The operation was aborted due to timeout');
    error.name = 'TimeoutError';
    api.queue({ status: 0, body: '', throwWith: () => error });
    const r = await send();
    expect(r.failureKind).toBe('timeout');
    expect(r.failure).toContain('5 秒');
    expect(r.failure).toContain('调大超时');
  });

  it('★ network error ⇒ network, and the key in the exception is scrubbed', async () => {
    api.queue({ status: 0, body: '', throwWith: () => new Error(`fetch failed: https://ai.example.test/v1 Bearer ${FAKE_KEY} ECONNREFUSED`) });
    const r = await send();
    expect(r.failureKind).toBe('network');
    expect(r.failure).toContain('代理');
    expect(leaks(r.failure ?? '')).toBe(false);
  });

  it('★ a key echoed in the response body is scrubbed too', async () => {
    api.queue({ status: 401, body: `{"error":{"message":"bad key ${FAKE_KEY}"}}` });
    const r = await send();
    expect(r.ok).toBe(false);
    expect(leaks(r.failure ?? '')).toBe(false);
  });

  it('incomplete config ⇒ config, and nothing is sent', async () => {
    const before = api.calls.length;
    const r = await chatVision(cfgWith({ apiKey: '' }), { system: 'S', user: 'U', image: img, mime: 'image/png' }, api.fetch);
    expect(r.failureKind).toBe('config');
    expect(api.calls.length).toBe(before);
  });
});

describe('三、视觉能力探测', () => {
  it('recognises W / rejects an off-topic reply / 400 image / 401', async () => {
    const api = new FakeApi();
    const advisor = await makeAdvisor(api, { enabled: false });
    api.queue({ status: 200, body: chatBody('这个字母是 W。', 'qwen-fake') });
    const a = await advisor.test();
    expect(a).toMatchObject({ ok: true, vision: true, model: 'qwen-fake' });
    expect(a.message).toContain('能看图');
    expect(imageUrlOf(api.calls[0]!).startsWith('data:image/png;base64,')).toBe(true);

    api.queue({ status: 200, body: chatBody('我无法查看图片，请描述图片内容。') });
    const b = await advisor.test();
    expect(b).toMatchObject({ ok: false, vision: false, kind: 'vision' });
    expect(b.reply).not.toBeNull();

    api.queue({ status: 400, body: '{"error":{"message":"invalid content type: image_url is not supported"}}' });
    expect(await advisor.test()).toMatchObject({ ok: false, vision: false, kind: 'vision' });

    api.queue({ status: 401, body: '{"error":{"message":"unauthorized"}}' });
    expect(await advisor.test()).toMatchObject({ ok: false, vision: null, kind: 'auth' });
  });
});

describe('四、回复解析', () => {
  it('fenced JSON, bbox arrays with string confidence, whitelist, tap without / with an absurd box, none drops the box', () => {
    const p1 = parseAdvice(`\`\`\`json\n{"screen":"popup","action":"tap_close",${CLOSE_RISK},"target":{"x":10,"y":20,"w":40,"h":40},"confidence":0.9,"reason":"有×"}\n\`\`\``, 1280, 720, WANLONG_PROFILE.screens);
    expect(p1.ok && p1.value).toMatchObject({ action: 'tap_close', target: { x: 10 }, confidence: 0.9, screen: 'popup' });
    const p2 = parseAdvice('结果如下：{"screen":"dialog","action":"tap_cancel","target":{"bbox":[100,100,150,140]},"confidence":"0.8"}', 1280, 720);
    expect(p2.ok && p2.value).toMatchObject({ target: { w: 50, h: 40 }, confidence: 0.8 });
    expect(parseAdvice('{"screen":"popup","action":"tap_purchase","target":{"x":1,"y":1,"w":40,"h":40},"confidence":1}', 1280, 720).ok).toBe(false);
    expect(parseAdvice(`{"screen":"popup","action":"tap_close",${CLOSE_RISK},"target":null,"confidence":1}`, 1280, 720).ok).toBe(false);
    expect(parseAdvice(`{"screen":"popup","action":"tap_close",${CLOSE_RISK},"target":{"x":0,"y":0,"w":900,"h":600},"confidence":1}`, 1280, 720).ok).toBe(false);
    const p6 = parseAdvice('{"screen":"loading","action":"none","target":{"x":0,"y":0,"w":40,"h":40},"confidence":1}', 1280, 720);
    expect(p6.ok && p6.value).toMatchObject({ action: 'none', target: null });
    expect(parseAdvice('我不知道', 1280, 720).ok).toBe(false);
    // Fences anywhere are dropped (original extractJson), not only at the ends.
    expect(parseAdvice('好的 ```json {"screen":"world_map","action":"none","target":null,"confidence":0.7} ``` 完毕', 1280, 720).ok).toBe(true);
    // An unknown screen class of the game profile becomes unknown.
    const p8 = parseAdvice('{"screen":"gameplay","action":"none","target":null,"confidence":0.7}', 1280, 720, WANLONG_PROFILE.screens);
    expect(p8.ok && p8.value.screen).toBe('unknown');
  });

  it('nextHarvestId: original id first, then _ai2, null once 8 are learnt', () => {
    expect(nextHarvestId(['tpl_a'])).toBe(CLOSE_POPUP_TEMPLATE_ID);
    expect(nextHarvestId([CLOSE_POPUP_TEMPLATE_ID])).toBe(`${CLOSE_POPUP_TEMPLATE_ID}_ai2`);
    expect(nextHarvestId([CLOSE_POPUP_TEMPLATE_ID, ...[2, 3, 4, 5, 6, 7, 8].map((n) => `${CLOSE_POPUP_TEMPLATE_ID}_ai${n}`)])).toBeNull();
  });
});

describe('五、限频', () => {
  const frame = { width: 1280, height: 720, format: 1, data: new Uint8Array(1280 * 720 * 4).fill(128), capturedAt: 0 };
  const input = { gameId: 'wanlong', instanceIndex: 1, context: 't', raw: frame, refWidth: 1280, refHeight: 720, attempt: 1 };

  it('hourly limit: the third question within the hour is stopped', async () => {
    const api = new FakeApi();
    const advisor = await makeAdvisor(api, { maxCallsPerHour: 2, cooldownSeconds: 0, refine: false });
    const c1 = await advisor.consultFrame(input);
    const c2 = await advisor.consultFrame(input);
    const c3 = await advisor.consultFrame(input);
    expect(c1.advice && c2.advice).toBeTruthy();
    expect(api.calls).toHaveLength(2);
    expect(c3).toMatchObject({ advice: null, outcome: 'skipped' });
    expect(c3.reason).toContain('上限');
  });

  it('per-instance cooldown; another instance is not affected; 0 = unlimited', async () => {
    const api = new FakeApi();
    const advisor = await makeAdvisor(api, { maxCallsPerHour: 0, cooldownSeconds: 60, refine: false });
    const d1 = await advisor.consultFrame(input);
    const d2 = await advisor.consultFrame(input);
    const d3 = await advisor.consultFrame({ ...input, instanceIndex: 2 });
    expect(d1.advice).not.toBeNull();
    expect(d2).toMatchObject({ advice: null, outcome: 'skipped' });
    expect(d2.reason).toContain('不足');
    expect(d3.advice).not.toBeNull();
    expect(api.calls).toHaveLength(2);
  });

  it('switched off ⇒ no request and not even a skipped record', async () => {
    const api = new FakeApi();
    const advisor = await makeAdvisor(api, { enabled: false });
    const e1 = await advisor.consultFrame(input);
    expect(e1).toMatchObject({ advice: null, outcome: null });
    expect(api.calls).toHaveLength(0);
    expect(await advisor.history()).toHaveLength(0);
  });
});

describe('六、端到端：点掉弹窗 → 自学模板 → 本地重新认出', () => {
  let before: RawFrame;
  let after: RawFrame;
  let library: TemplateLibrary;
  let setDir: string;
  let advisor: AdvisorService;
  const api = new FakeApi();

  beforeAll(async () => {
    before = makeFrame(true);
    after = makeFrame(false);
    const home = await tempHome();
    library = new TemplateLibrary(home);
    setDir = (await library.createSet('wanlong', 'AI 自检模板集', 'com.lilithgames.samo.android.cn', W, H)).directory;
    advisor = await makeAdvisor(api, { refine: true, autoHarvest: true, autoActions: true, minConfidence: 0.5, imageWidth: 1280 });
    emitted.length = 0;
  }, 60_000);

  const harvest = (): HarvestPort => ({
    existingIds: async () => (await loadTemplateSet(setDir)).templates.map((item) => item.id),
    save: async (draft) => {
      const saved = await library.save(setDir, draft);
      return { id: saved.definition.id, std: saved.std };
    },
  });

  function makeIo(afterTap: () => RawFrame) {
    const taps: Array<[number, number]> = [];
    return { taps, capture: async () => (taps.length ? afterTap() : before), tap: async (x: number, y: number) => { taps.push([x, y]); } };
  }

  function ctx(io: ReturnType<typeof makeIo>, patch: Partial<RecoverContext> = {}): RecoverContext {
    return {
      gameId: 'wanlong', instanceIndex: 1, context: 'gather-g0', raw: before, io, refWidth: W, refHeight: H, attempt: 3,
      packageName: 'com.lilithgames.samo.android.cn', mainScreens: WANLONG_PROFILE.mainScreens, recognize: recognizeNoPopup,
      harvest: harvest(), log: (level, message) => logs.push(`[${level}] ${message}`), sleep: async () => undefined, ...patch,
    };
  }

  const closeReply = (box: string, confidence: number, reason = '活动弹窗右上角有关闭按钮'): FakeReply => ({
    status: 200,
    body: chatBody(`{"screen":"popup","action":"tap_close",${CLOSE_RISK},"target":${box},"confidence":${confidence},"reason":"${reason}"}`),
  });

  it('the two frames differ enough for the verification to mean something', async () => {
    expect(await meanAbsDiff(before, after, W, H)).toBeGreaterThan(6);
    expect(await recognizeNoPopup(before)).toBe(false);
    expect(await recognizeNoPopup(after)).toBe(true);
  });

  it('★ closes the popup, verifies and learns tpl_btn_close_popup; the real vision layer finds it again; no re-learning', async () => {
    // Stage one: whole frame 1280×720, button at (920,110) 40×40. Stage two: a 480×480 magnified crop, button (160,160) 160×160.
    api.reset();
    api.queue(closeReply('{"x":920,"y":110,"w":40,"h":40}', 0.92), { status: 200, body: chatBody('{"target":{"x":160,"y":160,"w":160,"h":160},"confidence":0.95}') });
    const io = makeIo(() => after);
    const r = await aiRecoverUnknownScreen(advisor, ctx(io));
    expect(r.outcome, r.message).toBe('harvested');
    expect(r.handled).toBe(true);
    expect(api.calls).toHaveLength(2);
    expect(imageUrlOf(api.calls[1]!).startsWith('data:image/png;base64,')).toBe(true);
    expect(r.advice?.refined).toBe(true);
    expect(r.advice?.target).toEqual(BTN);
    expect(io.taps).toHaveLength(1);
    const [tx, ty] = io.taps[0]!;
    expect(Math.abs(tx - (BTN.x + BTN.w / 2))).toBeLessThanOrEqual(1);
    expect(Math.abs(ty - (BTN.y + BTN.h / 2))).toBeLessThanOrEqual(1);

    const saved = await loadTemplateSet(setDir);
    const def = saved.templates.find((item) => item.id === CLOSE_POPUP_TEMPLATE_ID);
    expect(def).toBeDefined();
    expect(r.harvestedTemplateId).toBe(CLOSE_POPUP_TEMPLATE_ID);
    expect(def!.tags ?? []).toContain('ai-harvest');
    expect(Math.abs(def!.bounds.x - BTN.x)).toBeLessThanOrEqual(4);
    expect(Math.abs(def!.bounds.y - BTN.y)).toBeLessThanOrEqual(4);
    expect(def!.bounds.w).toBeGreaterThanOrEqual(BTN.w);
    expect(def!.bounds.w).toBeLessThanOrEqual(BTN.w + 8);
    expect(def!.std ?? 0).toBeGreaterThanOrEqual(12);
    expect(emitted.some((e) => e.outcome === 'harvested' && e.harvestedTemplateId === CLOSE_POPUP_TEMPLATE_ID)).toBe(true);
    const status = await advisor.status();
    expect(status.harvestedCount).toBe(1);
    expect(status.consultCount).toBe(1);

    // ★ The loop closes: the vision layer compiles the new template and finds it at the right place on the frame.
    const prepared = await loadPrepared(setDir, { shrink: 2 });
    const tpl = prepared.get(CLOSE_POPUP_TEMPLATE_ID)!;
    expect(tpl).toBeDefined();
    const hit = await matchTemplate(await prepareFrame(before, { refW: W, refH: H, shrink: 2 }), tpl, { roi: tpl.defaultRoi });
    expect(hit.found).toBe(true);
    expect(Math.abs(hit.centerX - (BTN.x + BTN.w / 2))).toBeLessThanOrEqual(4);
    expect(Math.abs(hit.centerY - (BTN.y + BTN.h / 2))).toBeLessThanOrEqual(4);
    const miss = await matchTemplate(await prepareFrame(after, { refW: W, refH: H, shrink: 2 }), tpl, { roi: tpl.defaultRoi });
    expect(miss.found).toBe(false);

    // The same popup again: an existing template covers it ⇒ verified, nothing new learnt.
    api.reset();
    api.queue(closeReply('{"x":920,"y":110,"w":40,"h":40}', 0.9, '×'));
    const io2 = makeIo(() => after);
    const r2 = await aiRecoverUnknownScreen(advisor, ctx(io2, {
      closeButtonCovered: async (raw, roi) => (await matchTemplate(await prepareFrame(raw, { refW: W, refH: H, shrink: 2 }), tpl, { roi })).found,
    }));
    expect(r2.handled).toBe(true);
    expect(r2.outcome).toBe('verified');
    expect(r2.message).toContain('不再重复');
    expect((await loadTemplateSet(setDir)).templates).toHaveLength(1);
  }, 120_000);

  it('back ⇒ no_action, nothing tapped', async () => {
    api.reset();
    api.queue({ status: 200, body: chatBody('{"screen":"other","action":"back","risk":{"level":"low","effect":"navigate","buttonText":"返回","dialogText":"背包页面","consequence":"回到上一页","reason":"不会付费或改变账号数据","hazards":[]},"target":null,"confidence":0.8,"reason":"在背包页"}') });
    const io = makeIo(() => after);
    const r = await aiRecoverUnknownScreen(advisor, ctx(io, { attempt: 4 }));
    expect(r.handled).toBe(false);
    expect(r.outcome).toBe('no_action');
    expect(io.taps).toHaveLength(0);
  });

  it('low confidence ⇒ rejected, nothing tapped', async () => {
    api.queue(closeReply('{"x":920,"y":110,"w":40,"h":40}', 0.2, '不太确定'));
    const io = makeIo(() => after);
    const r = await aiRecoverUnknownScreen(advisor, ctx(io, { attempt: 4 }));
    expect(r.handled).toBe(false);
    expect(r.outcome).toBe('rejected');
    expect(io.taps).toHaveLength(0);
  });

  it('tapped but the screen did not change ⇒ rejected, nothing learnt', async () => {
    api.queue(closeReply('{"x":300,"y":300,"w":40,"h":40}', 0.9, '认错了'));
    const io = makeIo(() => before);
    const r = await aiRecoverUnknownScreen(advisor, ctx(io, { attempt: 4 }));
    expect(r.handled, r.message).toBe(false);
    expect(r.outcome).toBe('rejected');
    expect(io.taps).toHaveLength(1);
    expect((await loadTemplateSet(setDir)).templates).toHaveLength(1);
  }, 60_000);

  it('the screen changed but no known screen yet ⇒ applied (handled), nothing learnt', async () => {
    // The lower half of the popup is painted dark (a big change), but the probe point (1300,600) is still light.
    const halfway = makeFrame(true);
    for (let y = 800; y < 1200; y++) {
      for (let x = 700; x < 1900; x++) {
        const i = (y * W + x) * 4;
        halfway.data[i] = halfway.data[i + 1] = halfway.data[i + 2] = 20;
      }
    }
    api.queue(closeReply('{"x":920,"y":110,"w":40,"h":40}', 0.9, '×'));
    const io = makeIo(() => halfway);
    const r = await aiRecoverUnknownScreen(advisor, ctx(io, { context: 'scheduler-sample' }));
    expect(r.handled, r.message).toBe(true);
    expect(r.outcome).toBe('applied');
    expect((await loadTemplateSet(setDir)).templates).toHaveLength(1);
  }, 60_000);

  it('request failure ⇒ failed, nothing tapped', async () => {
    api.queue({ status: 500, body: 'boom' });
    const io = makeIo(() => after);
    const r = await aiRecoverUnknownScreen(advisor, ctx(io));
    expect(r.handled).toBe(false);
    expect(r.outcome).toBe('failed');
    expect(io.taps).toHaveLength(0);
  });

  it('★ no key in any log line or record; 7 records (harvested, verified, no_action, 2 rejected, applied, failed)', async () => {
    expect(logs.some(leaks)).toBe(false);
    expect(emitted.some((e) => leaks(JSON.stringify(e)))).toBe(false);
    expect(await advisor.history()).toHaveLength(7);
  });
});
