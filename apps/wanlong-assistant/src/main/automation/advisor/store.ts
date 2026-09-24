import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { withFileLock } from '@avdm/core';
import {
  AI_HISTORY_LIMIT, AI_OUTCOMES, aiConfigProblems, defaultAiConfig, mergeAiConfig, normalizeAiConfig, scrubAiSecret, toAiConfigView,
  type AdvisorAdvice, type AdvisorBox, type AdvisorConfig, type AdvisorConfigPatch, type AdvisorConfigView, type AdvisorRecord,
  type AdvisorTemplateProposal,
} from '../../../shared/ai';
import { adviceRejection, parseAdvice } from './risk';

export const ADVISOR_HISTORY_LIMIT = AI_HISTORY_LIMIT;
const MAX_FILE_BYTES = 256 * 1024;
const TEMPLATE_ID = /^[A-Za-z0-9_.-]{1,128}$/;

export interface AdvisorFile {
  version: 1;
  config: AdvisorConfig;
  history: AdvisorRecord[];
  calls: number[];
  lastConsultAt: Record<string, number>;
  totalConsults: number;
  /** Set when a corrupt or incompatible file was moved aside and defaults were used (never persisted). */
  loadWarning?: string;
}

// The pure config helpers live in src/shared/ai.ts (one source for main and renderer); these names stay for callers.
export {
  defaultAdvisorConfig, normalizeAiConfig as normalizeAdvisorConfig, mergeAiConfig as mergeAdvisorConfig,
  toAiConfigView as advisorConfigView, aiConfigProblems as configProblems, scrubAiSecret as scrubAdvisorSecret,
} from '../../../shared/ai';

export function emptyAdvisorFile(): AdvisorFile {
  return { version: 1, config: defaultAiConfig(), history: [], calls: [], lastConsultAt: {}, totalConsults: 0 };
}

function safeText(value: unknown, length: number, config: AdvisorConfig): string {
  return scrubAiSecret(typeof value === 'string' ? value.slice(0, length) : '', config);
}

const OUTCOMES: ReadonlySet<string> = new Set(AI_OUTCOMES);
const REVIEWS: ReadonlySet<string> = new Set(['no_action', 'manual_review', 'blocked']);

function safeAdvice(raw: unknown, config: AdvisorConfig): AdvisorAdvice | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const candidate = raw as Record<string, unknown>;
  const parsed = parseAdvice(JSON.stringify(candidate), 8192, 8192);
  if (!parsed.ok) return null;
  const value = parsed.value;
  const rejection = adviceRejection(value, config.minConfidence);
  const storedReview = typeof candidate['review'] === 'string' && REVIEWS.has(candidate['review']) ? candidate['review'] as AdvisorAdvice['review'] : null;
  const review = storedReview ?? (value.action === 'back' || value.action === 'none' ? 'no_action' : rejection ? 'blocked' : 'manual_review');
  const latency = candidate['latencyMs'];
  return {
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
    ...(candidate['space'] === 'reference' || candidate['space'] === 'frame' ? { space: candidate['space'] } : {}),
    ...(typeof candidate['refined'] === 'boolean' ? { refined: candidate['refined'] } : {}),
    ...(typeof candidate['riskRechecked'] === 'boolean' ? { riskRechecked: candidate['riskRechecked'] } : {}),
    ...(typeof latency === 'number' && Number.isFinite(latency) && latency >= 0 ? { latencyMs: latency } : {}),
  };
}

/** Re-validate a record read back from disk (and scrub it again): a bad record is dropped, never trusted. */
export function safeRecord(value: unknown, config: AdvisorConfig): AdvisorRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw['id'] !== 'string' || typeof raw['at'] !== 'number' || !Number.isFinite(raw['at']) ||
    typeof raw['gameId'] !== 'string' || typeof raw['context'] !== 'string' ||
    typeof raw['outcome'] !== 'string' || !OUTCOMES.has(raw['outcome']) ||
    typeof raw['message'] !== 'string') return null;
  const id = safeText(raw['id'], 80, config);
  const gameId = safeText(raw['gameId'], 64, config);
  const index = typeof raw['index'] === 'number' && Number.isInteger(raw['index']) && raw['index'] >= 0 && raw['index'] <= 63 ? raw['index'] : null;
  const advice = safeAdvice(raw['advice'], config);
  let templateProposal: AdvisorTemplateProposal | null = null;
  const rawProposal = raw['templateProposal'];
  if (advice?.review === 'manual_review' && advice.action === 'tap_close' && advice.target && advice.space !== 'reference' &&
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
  const harvested = raw['harvestedTemplateId'];
  return {
    id, at: raw['at'], gameId, index, context: safeText(raw['context'], 80, config),
    outcome: raw['outcome'] as AdvisorRecord['outcome'],
    message: safeText(raw['message'], 500, config), advice, templateProposal,
    harvestedTemplateId: typeof harvested === 'string' && TEMPLATE_ID.test(harvested) ? harvested : null,
    ...(typeof raw['requiresAttention'] === 'boolean' ? { requiresAttention: raw['requiresAttention'] } : {}),
    latencyMs: typeof raw['latencyMs'] === 'number' && Number.isFinite(raw['latencyMs']) ? Math.max(0, raw['latencyMs']) : 0,
    providerCalls: typeof raw['providerCalls'] === 'number' && Number.isInteger(raw['providerCalls']) && raw['providerCalls'] >= 0 && raw['providerCalls'] <= 4 ? raw['providerCalls'] : 0,
  };
}

/** Why a file cannot be used as it is (it is then moved aside and defaults are used, like the original loader). */
class CorruptAdvisorFile extends Error {}

/**
 * `~/.avdm/automation/advisor.json` (0600, atomic write under a cross-process file lock, ≤ 256 KB). Reading is
 * tolerant like the original `ai.json` loader: a missing file means defaults; a corrupt, oversized or incompatible
 * file is renamed to `advisor.json.corrupt-<time>` as evidence and the advisor starts from defaults (switched off),
 * with a warning for the status line and the log. Error messages carry the path only, never the content.
 */
export class AdvisorStore {
  readonly file: string;
  constructor(home: string) {
    if (!path.isAbsolute(home)) throw new Error('AI 顾问数据目录必须是绝对路径');
    this.file = path.join(home, 'automation', 'advisor.json');
  }

  async load(): Promise<AdvisorFile> {
    try {
      return await this.read();
    } catch (error) {
      if (!(error instanceof CorruptAdvisorFile)) throw error;
      const aside = `${this.file}.corrupt-${Date.now()}`;
      let moved = false;
      try {
        await withFileLock(`${this.file}.lock`, async () => { await rename(this.file, aside); });
        moved = true;
      } catch { /* The warning still says the file was ignored; the next save replaces it. */ }
      return {
        ...emptyAdvisorFile(),
        loadWarning: `AI 顾问配置文件${error.message}，` +
          (moved ? `已改名为 ${path.basename(aside)} 留证，` : '已忽略，') +
          '本次从默认配置开始（顾问保持关闭），请重新填写接口配置。',
      };
    }
  }

  private async read(): Promise<AdvisorFile> {
    let text: string;
    try {
      if ((await stat(this.file)).size > MAX_FILE_BYTES) throw new CorruptAdvisorFile('超过 256 KB');
      text = await readFile(this.file, 'utf8');
    } catch (error) {
      if (error instanceof CorruptAdvisorFile) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyAdvisorFile();
      throw new Error(`无法读取本机 AI 顾问配置：${this.file}`);
    }
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { throw new CorruptAdvisorFile('不是有效 JSON'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || (parsed as Record<string, unknown>)['version'] !== 1) {
      throw new CorruptAdvisorFile('版本不兼容');
    }
    const raw = parsed as Record<string, unknown>;
    const config = normalizeAiConfig(raw['config']);
    // An enabled flag that no longer passes the checks (edited by hand) is switched off rather than trusted.
    if (config.enabled && aiConfigProblems(config).length) config.enabled = false;
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
        throw new Error(`无法保存本机 AI 顾问配置或记录：${this.file}`);
      }
    });
  }
}

export type { AdvisorConfig, AdvisorConfigPatch, AdvisorConfigView };
