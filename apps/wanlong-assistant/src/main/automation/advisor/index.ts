import { randomUUID } from 'node:crypto';
import type { AdvisorAdvice, AdvisorCapturePort, AdvisorConfigPatch, AdvisorConfigView, AdvisorConsultTarget, AdvisorRecord, AdvisorStatus, AdvisorTemplateProposal, AdvisorTestResult } from './types';
import { ADVISOR_HISTORY_LIMIT, AdvisorStore, advisorConfigView, configProblems, mergeAdvisorConfig, scrubAdvisorSecret, type AdvisorFile } from './store';
import { ADVISOR_SYSTEM_PROMPT, advisorPrompt, buildVisionProbe, chatVision, encodeFrame, type VisionFetch } from './client';
import { parseAdvice, riskRejection, scaleBox } from './risk';

export type {
  AdvisorAction, AdvisorAdvice, AdvisorBox, AdvisorCapture, AdvisorCapturePort,
  AdvisorConfig, AdvisorConfigPatch, AdvisorConfigView, AdvisorConsultTarget,
  AdvisorEffect, AdvisorRecord, AdvisorRisk, AdvisorRiskLevel, AdvisorScreen,
  AdvisorStatus, AdvisorTemplateProposal, AdvisorTestResult,
} from './types';

interface AdvisorOptions {
  fetch?: VisionFetch;
  now?: () => number;
  onRecord?: (record: AdvisorRecord) => void;
}

/**
 * Opt-in, read-only visual advisor. Its only device dependency is a capture callback;
 * it cannot send taps, keys, installs or template writes.
 */
export class AdvisorService {
  private readonly store: AdvisorStore;
  private readonly ready: Promise<AdvisorFile>;
  private loaded: AdvisorFile | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(home: string, private readonly capture: AdvisorCapturePort, private readonly options: AdvisorOptions = {}) {
    this.store = new AdvisorStore(home);
    this.ready = this.store.load();
    this.ready.then((state) => { this.loaded = state; }, () => undefined);
  }

  /**
   * Main process only: the live API key, for the app log to scrub (`appLog.addSecrets`). Synchronous because the
   * log is; `saveConfig` updates the same state object, so a new key is covered as soon as it is saved.
   */
  logSecrets(): string[] {
    const key = this.loaded?.config.apiKey;
    return key ? [key] : [];
  }

  private now(): number { return this.options.now?.() ?? Date.now(); }

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const next = this.queue.then(action, action);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }

  async config(): Promise<AdvisorConfigView> { return advisorConfigView((await this.ready).config); }

  async saveConfig(patch: AdvisorConfigPatch): Promise<AdvisorConfigView> {
    return this.serialize(async () => {
      const state = await this.ready;
      const config = mergeAdvisorConfig(state.config, patch);
      await this.store.save({ ...state, config });
      state.config = config;
      return advisorConfigView(config);
    });
  }

  async status(): Promise<AdvisorStatus> {
    const state = await this.ready;
    return {
      enabled: state.config.enabled,
      configured: configProblems(state.config).length === 0,
      model: state.config.model,
      callsLastHour: this.recentCalls(state).length,
      maxCallsPerHour: state.config.maxCallsPerHour,
      consultCount: state.totalConsults,
      lastRecord: state.history[0] ?? null,
    };
  }

  async history(limit = ADVISOR_HISTORY_LIMIT): Promise<AdvisorRecord[]> {
    const state = await this.ready;
    return state.history.slice(0, Math.max(1, Math.min(ADVISOR_HISTORY_LIMIT, Math.trunc(limit) || ADVISOR_HISTORY_LIMIT)));
  }

  private recentCalls(state: AdvisorFile): number[] {
    const cutoff = this.now() - 3_600_000;
    return state.calls.filter((at) => at >= cutoff && at <= this.now());
  }

  private async record(state: AdvisorFile, value: Omit<AdvisorRecord, 'id' | 'at'>, callsAt: number[] = [], id = randomUUID()): Promise<AdvisorRecord> {
    const entry: AdvisorRecord = {
      id, at: this.now(), ...value,
      message: scrubAdvisorSecret(value.message, state.config).slice(0, 500),
    };
    const next = {
      ...state,
      history: [entry, ...state.history].slice(0, ADVISOR_HISTORY_LIMIT),
      calls: [...this.recentCalls(state), ...callsAt].slice(-500),
      totalConsults: state.totalConsults + (entry.context !== 'vision-test' && entry.providerCalls > 0 ? 1 : 0),
    };
    await this.store.save(next);
    state.history = next.history;
    state.calls = next.calls;
    state.totalConsults = next.totalConsults;
    try { this.options.onRecord?.(entry); } catch { /* event listeners cannot alter persisted evidence */ }
    return entry;
  }

  /** A synthetic visual-capability check. It never uses a game screenshot. */
  async test(): Promise<AdvisorTestResult> {
    return this.serialize(async () => {
      const state = await this.ready;
      const start = this.now();
      const problems = configProblems(state.config);
      if (problems.length) return { ok: false, vision: null, model: state.config.model, latencyMs: 0, message: problems.join(' ') };
      if (this.recentCalls(state).length >= state.config.maxCallsPerHour) {
        return { ok: false, vision: null, model: state.config.model, latencyMs: 0, message: '最近一小时的 AI 请求已达到上限。' };
      }
      let image: Buffer;
      try { image = await buildVisionProbe(); }
      catch { return { ok: false, vision: null, model: state.config.model, latencyMs: 0, message: '无法创建本地视觉测试图片。' }; }
      const sentAt = this.now();
      const result = await chatVision(state.config, {
        image, mime: 'image/png', system: '请读取图片中最大的红色英文字母，只回答这个字母。',
        user: '图片中最大的红色英文字母是什么？只返回一个字母。', maxTokens: 32,
      }, this.options.fetch);
      const vision = result.ok ? /^W[.。!！]?$/i.test(result.text.trim()) : result.failureKind === 'vision' ? false : null;
      const message = result.failure ?? (vision ? '视觉测试通过：模型正确识别了字母 W。' : '视觉测试未通过：模型没有正确识别字母 W。');
      await this.record(state, {
        gameId: '', index: null, context: 'vision-test', outcome: vision ? 'test_passed' : 'failed',
        message, advice: null, templateProposal: null, latencyMs: Math.max(0, this.now() - start), providerCalls: 1,
      }, [sentAt]);
      return { ok: Boolean(vision), vision, model: result.model, latencyMs: result.latencyMs, message };
    });
  }

  async consult(target: AdvisorConsultTarget): Promise<AdvisorRecord> {
    return this.serialize(async () => {
      const state = await this.ready;
      const start = this.now();
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(target.gameId) || !Number.isInteger(target.index) || target.index < 0 || target.index > 63 ||
        !/^[a-zA-Z0-9_.]+$/.test(target.packageName)) throw new Error('AI 顾问目标无效。');
      const base = { gameId: target.gameId, index: target.index, context: target.context.slice(0, 80), advice: null, templateProposal: null, latencyMs: 0, providerCalls: 0 };
      if (!state.config.enabled) return this.record(state, { ...base, outcome: 'skipped', message: 'AI 顾问尚未启用。' });
      const problems = configProblems(state.config);
      if (problems.length) return this.record(state, { ...base, outcome: 'skipped', message: `AI 顾问配置不完整：${problems.join(' ')}` });
      if (this.recentCalls(state).length >= state.config.maxCallsPerHour) {
        return this.record(state, { ...base, outcome: 'skipped', message: '最近一小时的 AI 请求已达到上限。' });
      }
      const cooldownKey = `${target.gameId}:${target.index}`;
      const last = state.lastConsultAt[cooldownKey];
      if (last && this.now() - last < state.config.cooldownSeconds * 1000) {
        return this.record(state, { ...base, outcome: 'skipped', message: '该实例仍处于 AI 问询冷却时间。' });
      }
      let capture: Awaited<ReturnType<AdvisorCapturePort>>;
      try { capture = await this.capture(target.gameId, target.index); }
      catch (error) {
        return this.record(state, { ...base, outcome: 'failed', message: `无法读取设备画面：${scrubAdvisorSecret(error instanceof Error ? error.message : String(error), state.config).slice(0, 150)}` });
      }
      if (capture.foregroundPackage !== target.packageName) {
        return this.record(state, { ...base, outcome: 'skipped', message: `前台应用与目标游戏不一致（当前：${capture.foregroundPackage ?? '未知'}）。` });
      }
      let image: Awaited<ReturnType<typeof encodeFrame>>;
      try { image = await encodeFrame(capture.frame, state.config.imageWidth); }
      catch { return this.record(state, { ...base, outcome: 'failed', message: '设备截图编码失败。' }); }
      const sentAt = this.now();
      const response = await chatVision(state.config, {
        image: image.bytes, mime: 'image/jpeg', system: ADVISOR_SYSTEM_PROMPT,
        user: advisorPrompt(target.gameName, image.width, image.height),
      }, this.options.fetch);
      state.lastConsultAt[cooldownKey] = sentAt;
      if (!response.ok) {
        return this.record(state, { ...base, outcome: 'failed', message: response.failure ?? 'AI 接口请求失败。',
          latencyMs: Math.max(0, this.now() - start), providerCalls: 1 }, [sentAt]);
      }
      const parsed = parseAdvice(response.text, image.width, image.height);
      if (!parsed.ok) {
        return this.record(state, { ...base, outcome: 'unparsable', message: parsed.reason,
          latencyMs: Math.max(0, this.now() - start), providerCalls: 1 }, [sentAt]);
      }
      const value = parsed.value;
      const rawTarget = value.target ? scaleBox(value.target, image.width, image.height, capture.frame.width, capture.frame.height) : null;
      const partial = { ...value, target: rawTarget };
      const rejection = riskRejection(partial, state.config.minConfidence);
      const review: AdvisorAdvice['review'] = value.action === 'none' || value.action === 'back' ? 'no_action' : rejection ? 'blocked' : 'manual_review';
      const advice: AdvisorAdvice = {
        ...partial, model: response.model, review,
        reviewReason: rejection ?? (review === 'no_action' ? '无需制作点击模板或执行输入。' :
          value.action === 'tap_confirm' ? '仅供人工参考；确认动作仍需新截图独立复核，且必须由用户执行。' : '仅供人工核对；顾问不会点击设备。'),
      };
      const recordId = randomUUID();
      const proposal: AdvisorTemplateProposal | null = review === 'manual_review' && advice.action === 'tap_close' && rawTarget
        ? {
          gameId: target.gameId, index: target.index, sourceCapturedAt: capture.frame.capturedAt,
          frameWidth: capture.frame.width, frameHeight: capture.frame.height, box: rawTarget,
          suggestedName: `关闭按钮 · ${target.gameName.slice(0, 50)}`, sourceRecordId: recordId,
        } : null;
      const outcome: AdvisorRecord['outcome'] = review === 'blocked' ? 'blocked' : review === 'no_action' ? 'no_action' : 'advised';
      return this.record(state, {
        ...base, outcome, message: review === 'blocked' ? `已拦下模型建议：${advice.reviewReason}` : advice.reason || advice.reviewReason,
        advice, templateProposal: proposal, latencyMs: Math.max(0, this.now() - start), providerCalls: 1,
      }, [sentAt], recordId);
    });
  }
}
