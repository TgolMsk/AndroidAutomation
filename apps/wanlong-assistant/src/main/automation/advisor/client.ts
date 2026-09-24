/**
 * OpenAI-compatible vision client (POST <baseUrl>/chat/completions, the image as a data URL), ported from the
 * original src/main/ai/client.ts. It never throws: every failure comes back classified (ten kinds) with Chinese
 * guidance, and every text that leaves it has the API key scrubbed. Requests never follow redirects and responses
 * are capped at 512 KB (this repository's hardening).
 */
import sharp from 'sharp';
import type { RawFrame } from '@avdm/automation';
import { aiConfigProblems, scrubAiSecret, type AdvisorConfig, type AdvisorFailureKind } from '../../../shared/ai';

export interface VisionResponse {
  status: number;
  text(): Promise<string>;
}
export type VisionFetch = (url: string, init: {
  method: 'POST'; headers: Record<string, string>; body: string;
  signal: AbortSignal; redirect: 'error';
}) => Promise<VisionResponse>;

export interface VisionResult {
  ok: boolean;
  text: string;
  model: string;
  latencyMs: number;
  failure: string | null;
  failureKind: AdvisorFailureKind | null;
  /** HTTP status when the provider answered; null when the request never got a response. */
  status: number | null;
}

const MAX_RESPONSE_CHARS = 512_000;

async function systemFetch(): Promise<VisionFetch> {
  try {
    const electron = await import('electron');
    if (electron.net?.fetch) return electron.net.fetch.bind(electron.net) as VisionFetch;
  } catch { /* Vitest and plain Node use global fetch. */ }
  if (typeof globalThis.fetch === 'function') return globalThis.fetch as VisionFetch;
  throw new Error('当前运行环境没有可用的网络请求实现，无法调用 AI 接口。');
}

function assertFrame(frame: RawFrame): void {
  if (!Number.isInteger(frame.width) || !Number.isInteger(frame.height) || frame.width < 1 || frame.height < 1 ||
    frame.width > 8192 || frame.height > 8192 || frame.data.byteLength !== frame.width * frame.height * 4) {
    throw new Error('截图像素尺寸无效。');
  }
}

function rawInput(frame: RawFrame): Buffer {
  return Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
}

/** Raw RGBA frame → a JPEG at most `width` wide (never enlarged). */
export async function encodeFrame(frame: RawFrame, width: number): Promise<{ bytes: Buffer; width: number; height: number }> {
  assertFrame(frame);
  const { data, info } = await sharp(rawInput(frame), {
    raw: { width: frame.width, height: frame.height, channels: 4 },
  }).resize({ width: Math.min(width, frame.width), withoutEnlargement: true })
    .jpeg({ quality: 82, mozjpeg: true }).toBuffer({ resolveWithObject: true });
  return { bytes: data, width: info.width, height: info.height };
}

/** Crop a region of the raw frame and scale it up by an integer factor (nearest) → PNG (refine stage). */
export async function encodeCropPng(frame: RawFrame, left: number, top: number, width: number, height: number, up: number): Promise<Buffer> {
  assertFrame(frame);
  let pipe = sharp(rawInput(frame), { raw: { width: frame.width, height: frame.height, channels: 4 } })
    .extract({ left, top, width, height });
  if (up > 1) pipe = pipe.resize({ width: width * up, height: height * up, kernel: 'nearest' });
  return pipe.png({ compressionLevel: 6 }).toBuffer();
}

export function completionsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
}

function describeThrown(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const parts: string[] = [error.message];
  let cause: unknown = (error as { cause?: unknown }).cause;
  for (let i = 0; i < 2 && cause; i += 1) {
    if (cause instanceof Error) {
      const code = (cause as { code?: unknown }).code;
      parts.push(typeof code === 'string' ? `${cause.message}（${code}）` : cause.message);
      cause = (cause as { cause?: unknown }).cause;
    } else {
      parts.push(String(cause));
      break;
    }
  }
  return parts.join(' ← ');
}

/** One short line: control characters and runs of whitespace collapsed. */
function oneLine(value: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** The provider's own error line ({error:{message,code}} / {error:"…"} / {message}); a non-JSON body is cut short. */
function errorMessageOf(body: string): string {
  try {
    const json = JSON.parse(body) as { error?: { message?: unknown; code?: unknown; type?: unknown } | string; message?: unknown };
    if (typeof json.error === 'string') return oneLine(json.error, 200);
    if (json.error && typeof json.error === 'object') {
      const message = json.error.message;
      const code = json.error.code ?? json.error.type;
      if (typeof message === 'string') return oneLine(typeof code === 'string' ? `${message}（${code}）` : message, 200);
    }
    if (typeof json.message === 'string') return oneLine(json.message, 200);
  } catch { /* not JSON: a short excerpt */ }
  return oneLine(body, 160);
}

const VISION_UNSUPPORTED_RE =
  /image|vision|multimodal|multi-modal|图片|图像|视觉|content type|content_type|input type|unsupported.*type|not support/i;
const MODEL_MISSING_RE =
  /model.*(not (found|exist)|invalid|unknown|does not exist|unavailable)|no such model|模型不存在|不支持的模型|unknown model|invalid model/i;

/** Original classifyHttpFailure: kind + an actionable Chinese message with the provider's own reason. */
export function classifyHttpFailure(status: number, body: string): { kind: AdvisorFailureKind; message: string } {
  const detail = errorMessageOf(body);
  if (status === 401 || status === 403) {
    return { kind: 'auth', message: `鉴权失败（HTTP ${status}）：${detail}。请检查 API Key 是否正确、是否属于这个接口地址对应的平台。` };
  }
  if (status === 404) {
    return {
      kind: MODEL_MISSING_RE.test(detail) ? 'model' : 'bad_request',
      message: `接口返回 404：${detail}。多半是模型名写错，或接口地址不对（应填到 /v1 这一层）。`,
    };
  }
  if (status === 429 || status === 402) {
    return { kind: 'rate', message: `被限流或额度不足（HTTP ${status}）：${detail}。稍后再试，或到平台看余额/并发限制。` };
  }
  if (status === 400 || status === 422) {
    if (MODEL_MISSING_RE.test(detail)) return { kind: 'model', message: `模型不可用（HTTP ${status}）：${detail}。请核对模型名。` };
    if (VISION_UNSUPPORTED_RE.test(detail)) {
      return { kind: 'vision', message: `这个模型不接受图片输入（HTTP ${status}）：${detail}。请换一个视觉模型（名字里通常带 vl / vision / v）。` };
    }
    return { kind: 'bad_request', message: `请求被拒绝（HTTP ${status}）：${detail}` };
  }
  if (status >= 500) return { kind: 'server', message: `服务端错误（HTTP ${status}）：${detail}。通常过一会儿就好。` };
  return { kind: 'bad_request', message: `HTTP ${status}：${detail}` };
}

/** chat/completions body → text (content is a string or an array of parts). */
function parseChatResponse(body: string): { ok: true; text: string; model: string } | { ok: false; kind: AdvisorFailureKind; message: string } {
  let json: unknown;
  try { json = JSON.parse(body); } catch { return { ok: false, kind: 'bad_response', message: `响应不是 JSON：${oneLine(body, 160)}` }; }
  const value = json && typeof json === 'object' ? json as Record<string, unknown> : {};
  if (value['error']) {
    const message = errorMessageOf(body);
    return { ok: false, kind: VISION_UNSUPPORTED_RE.test(message) ? 'vision' : 'bad_request', message: `接口返回错误：${message}` };
  }
  const choices = Array.isArray(value['choices']) ? value['choices'] : [];
  const first = choices[0] && typeof choices[0] === 'object' ? choices[0] as Record<string, unknown> : {};
  const message = first['message'] && typeof first['message'] === 'object' ? first['message'] as Record<string, unknown> : {};
  const content = message['content'];
  const text = typeof content === 'string' ? content : Array.isArray(content)
    ? content.map((part) => part && typeof part === 'object' && typeof part.text === 'string' ? part.text : '').join('') : '';
  if (!text.trim()) return { ok: false, kind: 'bad_response', message: '模型返回了空内容。' };
  return { ok: true, text, model: typeof value['model'] === 'string' ? value['model'].slice(0, 200) : '' };
}

/** Send one「text + one image」conversation. Never throws. */
export async function chatVision(
  config: AdvisorConfig,
  input: { image: Uint8Array; mime: 'image/png' | 'image/jpeg'; system: string; user: string; maxTokens?: number },
  fetchOverride?: VisionFetch,
): Promise<VisionResult> {
  const start = Date.now();
  const fail = (failureKind: AdvisorFailureKind, failure: string, status: number | null): VisionResult =>
    ({ ok: false, text: '', model: config.model, latencyMs: Date.now() - start, failure: scrubAiSecret(failure, config), failureKind, status });
  const problems = aiConfigProblems(config);
  if (problems.length) return { ...fail('config', problems.join(' '), null), latencyMs: 0 };
  const body = JSON.stringify({
    model: config.model, temperature: 0, max_tokens: input.maxTokens ?? 400,
    messages: [
      { role: 'system', content: input.system },
      { role: 'user', content: [
        { type: 'text', text: input.user },
        { type: 'image_url', image_url: { url: `data:${input.mime};base64,${Buffer.from(input.image).toString('base64')}` } },
      ] },
    ],
  });
  let response: VisionResponse;
  try {
    const request = fetchOverride ?? await systemFetch();
    response = await request(completionsUrl(config.baseUrl), {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
      body, signal: AbortSignal.timeout(config.timeoutMs), redirect: 'error',
    });
  } catch (error) {
    const raw = scrubAiSecret(describeThrown(error), config);
    const name = error instanceof Error ? error.name : '';
    const timeout = name === 'TimeoutError' || name === 'AbortError' || /timeout|aborted/i.test(raw);
    return timeout
      ? fail('timeout', `请求超过 ${Math.round(config.timeoutMs / 1000)} 秒没有返回，已放弃。可以在设置里调大超时，或检查网络/代理。`, null)
      : fail('network', `网络请求失败：${oneLine(raw, 200)}。请确认接口地址能访问（浏览器能打开吗？）以及代理设置。`, null);
  }
  let raw: string;
  try { raw = await response.text(); }
  catch (error) { return fail('network', `读取响应失败：${oneLine(scrubAiSecret(describeThrown(error), config), 200)}`, response.status); }
  if (raw.length > MAX_RESPONSE_CHARS) return fail('bad_response', 'AI 接口响应过大（超过 512 KB），已放弃。', response.status);
  if (response.status < 200 || response.status >= 300) {
    const { kind, message } = classifyHttpFailure(response.status, raw);
    return fail(kind, message, response.status);
  }
  const parsed = parseChatResponse(raw);
  if (!parsed.ok) return fail(parsed.kind, parsed.message, response.status);
  return {
    ok: true, text: scrubAiSecret(parsed.text, config), model: scrubAiSecret(parsed.model || config.model, config),
    latencyMs: Date.now() - start, failure: null, failureKind: null, status: response.status,
  };
}

/** The probe letter: W has distinctive strokes and cannot be confused with a digit. */
export const PROBE_LETTER = 'W';

/** Fixed vector probe (red W and a blue square on white): no font is shipped and no user data is sent. */
export async function buildVisionProbe(): Promise<Buffer> {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="300"><rect width="480" height="300" fill="#fff"/><path d="M70 50l58 202h47l66-141 64 141h47L410 50h-49l-40 145-62-145h-38l-63 145-39-145z" fill="#dc2626"/><rect x="407" y="222" width="48" height="48" fill="#2563eb"/></svg>';
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/**
 * Whether a probe reply names the letter W. Relaxed from a bare「W」: a single W after stripping quotes and
 * punctuation, or an explicit sentence such as「这个字母是 W。」/「The letter is W」. Not the original
 * `includes('W')`: an English refusal (「Why…」「I can't view images」) must not pass.
 */
export function replyNamesProbeLetter(reply: string): boolean {
  const text = reply.normalize('NFKC').trim();
  const bare = text.replace(/[\s"'`“”‘’「」『』《》()（）[\]【】.,，。!！?？:：;；*_~-]+/g, '');
  if (/^w$/i.test(bare)) return true;
  if (/(字母|答案|结果)\s*(是|为|：|:)\s*["'“‘「『]?\s*W(?![A-Za-z])/i.test(text)) return true;
  if (/^(答|答案|回答)?\s*[:：]?\s*["'“‘「『]?W["'”’」』]?\s*[.。!！]?$/i.test(text)) return true;
  return /\b(letter|answer)\s+(is\s+)?["'“‘]?W\b/i.test(text) || /\bit'?s\s+(the\s+letter\s+)?["'“‘]?W\b/i.test(text);
}
