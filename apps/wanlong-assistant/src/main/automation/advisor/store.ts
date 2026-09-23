import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { withFileLock } from '@avdm/core';
import type { AdvisorAdvice, AdvisorBox, AdvisorConfig, AdvisorConfigPatch, AdvisorConfigView, AdvisorRecord, AdvisorTemplateProposal } from './types';
import { parseAdvice, riskRejection } from './risk';

export const ADVISOR_HISTORY_LIMIT = 50;
const MAX_FILE_BYTES = 256 * 1024;

export interface AdvisorFile {
  version: 1;
  config: AdvisorConfig;
  history: AdvisorRecord[];
  calls: number[];
  lastConsultAt: Record<string, number>;
  totalConsults: number;
}

export function defaultAdvisorConfig(): AdvisorConfig {
  return {
    enabled: false, baseUrl: '', apiKey: '', model: '', timeoutMs: 40_000,
    maxCallsPerHour: 20, cooldownSeconds: 20, imageWidth: 1280, minConfidence: .5,
  };
}

const RANGES = {
  timeoutMs: [5_000, 180_000], maxCallsPerHour: [1, 500],
  cooldownSeconds: [0, 3_600], imageWidth: [640, 2560], minConfidence: [0, 1],
} as const;

function number(value: unknown, fallback: number, range: readonly [number, number]): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(range[1], Math.max(range[0], value));
}

export function normalizeAdvisorConfig(value: unknown): AdvisorConfig {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const defaults = defaultAdvisorConfig();
  return {
    enabled: typeof raw['enabled'] === 'boolean' ? raw['enabled'] : defaults.enabled,
    baseUrl: typeof raw['baseUrl'] === 'string' ? raw['baseUrl'].trim().replace(/\/+$/, '').slice(0, 2048) : defaults.baseUrl,
    apiKey: typeof raw['apiKey'] === 'string' ? raw['apiKey'].trim().slice(0, 4096) : defaults.apiKey,
    model: typeof raw['model'] === 'string' ? raw['model'].trim().slice(0, 200) : defaults.model,
    timeoutMs: Math.round(number(raw['timeoutMs'], defaults.timeoutMs, RANGES.timeoutMs)),
    maxCallsPerHour: Math.round(number(raw['maxCallsPerHour'], defaults.maxCallsPerHour, RANGES.maxCallsPerHour)),
    cooldownSeconds: Math.round(number(raw['cooldownSeconds'], defaults.cooldownSeconds, RANGES.cooldownSeconds)),
    imageWidth: Math.round(number(raw['imageWidth'], defaults.imageWidth, RANGES.imageWidth)),
    minConfidence: number(raw['minConfidence'], defaults.minConfidence, RANGES.minConfidence),
  };
}

export function mergeAdvisorConfig(current: AdvisorConfig, patch: AdvisorConfigPatch): AdvisorConfig {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('AI 顾问配置补丁无效');
  const allowed = new Set<keyof AdvisorConfig>([
    'enabled', 'baseUrl', 'apiKey', 'model', 'timeoutMs', 'maxCallsPerHour',
    'cooldownSeconds', 'imageWidth', 'minConfidence',
  ]);
  if (Object.keys(patch).some((key) => !allowed.has(key as keyof AdvisorConfig))) throw new Error('AI 顾问配置包含未知字段');
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (key === 'enabled' && typeof value !== 'boolean') throw new Error('AI 顾问开关无效');
    if (['baseUrl', 'apiKey', 'model'].includes(key) && typeof value !== 'string') throw new Error('AI 接口字段无效');
    if (!['enabled', 'baseUrl', 'apiKey', 'model'].includes(key) && (typeof value !== 'number' || !Number.isFinite(value))) {
      throw new Error('AI 顾问限额参数无效');
    }
  }
  const next = normalizeAdvisorConfig({ ...current, ...patch });
  if (next.enabled && configProblems(next).length) throw new Error(`无法启用 AI 顾问：${configProblems(next).join(' ')}`);
  return next;
}

/** The renderer never receives the stored key. */
export function advisorConfigView(config: AdvisorConfig): AdvisorConfigView {
  const { apiKey, ...rest } = config;
  return {
    ...rest,
    apiKeySet: Boolean(apiKey),
    apiKeyMasked: apiKey ? `••••••${apiKey.slice(-4)}` : '',
  };
}

/** Only explicit HTTPS endpoints or an opt-in local loopback provider can receive a screenshot. */
export function configProblems(config: AdvisorConfig): string[] {
  const result: string[] = [];
  let url: URL | null = null;
  try { url = new URL(config.baseUrl); } catch { result.push('接口地址不是有效 URL。'); }
  if (url) {
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) result.push('接口必须使用 HTTPS；本机模型可使用 HTTP localhost。');
    if (url.username || url.password || url.search || url.hash) result.push('接口地址不得包含用户名、密码、查询参数或片段。');
    if (/\/chat\/completions\/?$/i.test(url.pathname)) result.push('接口地址请填到 /v1 等根路径，不要带 /chat/completions。');
  }
  if (!config.model) result.push('模型名不能为空。');
  if (!config.apiKey) result.push('API Key 尚未设置。');
  return result;
}

export function scrubAdvisorSecret(value: string, config: Pick<AdvisorConfig, 'apiKey'>): string {
  const secret = config.apiKey;
  return secret ? value.split(secret).join('[已隐藏的凭据]') : value;
}

function safeText(value: unknown, length: number, config: AdvisorConfig): string {
  return scrubAdvisorSecret(typeof value === 'string' ? value.slice(0, length) : '', config);
}

function safeRecord(value: unknown, config: AdvisorConfig): AdvisorRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const outcomes: ReadonlySet<string> = new Set(['skipped', 'failed', 'unparsable', 'advised', 'blocked', 'no_action', 'test_passed']);
  if (typeof raw['id'] !== 'string' || typeof raw['at'] !== 'number' || !Number.isFinite(raw['at']) ||
    typeof raw['gameId'] !== 'string' || typeof raw['context'] !== 'string' ||
    typeof raw['outcome'] !== 'string' || !outcomes.has(raw['outcome']) ||
    typeof raw['message'] !== 'string') return null;
  const id = safeText(raw['id'], 80, config);
  const gameId = safeText(raw['gameId'], 64, config);
  const index = typeof raw['index'] === 'number' && Number.isInteger(raw['index']) && raw['index'] >= 0 && raw['index'] <= 63 ? raw['index'] : null;
  let advice: AdvisorAdvice | null = null;
  if (raw['advice'] && typeof raw['advice'] === 'object' && !Array.isArray(raw['advice'])) {
    const candidate = raw['advice'] as Record<string, unknown>;
    const parsed = parseAdvice(JSON.stringify(candidate), 8192, 8192);
    if (parsed.ok) {
      const value = parsed.value;
      const rejection = riskRejection(value, config.minConfidence);
      const review = value.action === 'back' || value.action === 'none' ? 'no_action' : rejection ? 'blocked' : 'manual_review';
      advice = {
        ...value,
        reason: safeText(value.reason, 200, config),
        risk: {
          ...value.risk,
          buttonText: safeText(value.risk.buttonText, 80, config),
          dialogText: safeText(value.risk.dialogText, 600, config),
          consequence: safeText(value.risk.consequence, 240, config),
          reason: safeText(value.risk.reason, 240, config),
          hazards: value.risk.hazards.map((hazard) => safeText(hazard, 120, config)),
        },
        model: safeText(candidate['model'], 200, config),
        review,
        reviewReason: safeText(candidate['reviewReason'], 300, config) || rejection || '仅供人工核对。',
      };
    }
  }
  let templateProposal: AdvisorTemplateProposal | null = null;
  const rawProposal = raw['templateProposal'];
  if (advice?.review === 'manual_review' && advice.action === 'tap_close' && advice.target &&
    rawProposal && typeof rawProposal === 'object' && !Array.isArray(rawProposal) && index !== null) {
    const proposal = rawProposal as Record<string, unknown>;
    const width = proposal['frameWidth']; const height = proposal['frameHeight'];
    const capturedAt = proposal['sourceCapturedAt'];
    const box = proposal['box'] as AdvisorBox | undefined;
    if (typeof width === 'number' && Number.isInteger(width) && width > 0 && width <= 8192 &&
      typeof height === 'number' && Number.isInteger(height) && height > 0 && height <= 8192 &&
      typeof capturedAt === 'number' && Number.isFinite(capturedAt) &&
      box && [box.x, box.y, box.w, box.h].every((n) => typeof n === 'number' && Number.isFinite(n)) &&
      box.x === advice.target.x && box.y === advice.target.y && box.w === advice.target.w && box.h === advice.target.h) {
      templateProposal = { gameId, index, sourceCapturedAt: capturedAt, frameWidth: width, frameHeight: height,
        box: advice.target, suggestedName: safeText(proposal['suggestedName'], 100, config), sourceRecordId: id };
    }
  }
  return {
    id, at: raw['at'], gameId, index, context: safeText(raw['context'], 80, config),
    outcome: raw['outcome'] as AdvisorRecord['outcome'],
    message: safeText(raw['message'], 500, config), advice, templateProposal,
    latencyMs: typeof raw['latencyMs'] === 'number' && Number.isFinite(raw['latencyMs']) ? Math.max(0, raw['latencyMs']) : 0,
    providerCalls: typeof raw['providerCalls'] === 'number' && Number.isInteger(raw['providerCalls']) && raw['providerCalls'] >= 0 && raw['providerCalls'] <= 2 ? raw['providerCalls'] : 0,
  };
}

export class AdvisorStore {
  readonly file: string;
  constructor(home: string) { this.file = path.join(home, 'automation', 'advisor.json'); }

  async load(): Promise<AdvisorFile> {
    let text: string;
    try { text = await readFile(this.file, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, config: defaultAdvisorConfig(), history: [], calls: [], lastConsultAt: {}, totalConsults: 0 };
      throw new Error('无法读取本机 AI 顾问配置。');
    }
    if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new Error('本机 AI 顾问配置文件过大，请检查文件。');
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { throw new Error('本机 AI 顾问配置文件不是有效 JSON。'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || (parsed as Record<string, unknown>)['version'] !== 1) {
      throw new Error('本机 AI 顾问配置版本不兼容。');
    }
    const raw = parsed as Record<string, unknown>;
    const config = normalizeAdvisorConfig(raw['config']);
    const history = Array.isArray(raw['history']) ? raw['history'].map((item) => safeRecord(item, config)).filter((item): item is AdvisorRecord => item !== null).slice(0, ADVISOR_HISTORY_LIMIT) : [];
    return {
      version: 1,
      config,
      history,
      calls: Array.isArray(raw['calls']) ? raw['calls'].filter((at): at is number => typeof at === 'number' && Number.isFinite(at)).slice(-500) : [],
      lastConsultAt: raw['lastConsultAt'] && typeof raw['lastConsultAt'] === 'object' && !Array.isArray(raw['lastConsultAt'])
        ? Object.fromEntries(Object.entries(raw['lastConsultAt']).filter(([key, at]) =>
          /^[a-z][a-z0-9-]{0,63}:[0-9]{1,2}$/.test(key) && typeof at === 'number' && Number.isFinite(at))) : {},
      totalConsults: typeof raw['totalConsults'] === 'number' && Number.isInteger(raw['totalConsults']) && raw['totalConsults'] >= 0
        ? raw['totalConsults'] : history.filter((item) => item.context !== 'vision-test' && item.providerCalls > 0).length,
    };
  }

  async save(data: AdvisorFile): Promise<void> {
    const payload = `${JSON.stringify({
      version: 1, config: data.config, history: data.history.slice(0, ADVISOR_HISTORY_LIMIT),
      calls: data.calls.slice(-500), lastConsultAt: data.lastConsultAt, totalConsults: data.totalConsults,
    }, null, 2)}\n`;
    if (Buffer.byteLength(payload) > MAX_FILE_BYTES) throw new Error('AI 顾问记录达到文件大小限制。');
    const folder = path.dirname(this.file);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    await withFileLock(`${this.file}.lock`, async () => {
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        const handle = await open(temporary, 'wx', 0o600);
        try { await handle.writeFile(payload); await handle.sync(); }
        finally { await handle.close(); }
        await rename(temporary, this.file);
        await chmod(this.file, 0o600);
      } catch {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw new Error('无法保存本机 AI 顾问配置或记录。');
      }
    });
  }
}
