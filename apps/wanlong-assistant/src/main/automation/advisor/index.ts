import { createHash, randomUUID } from 'node:crypto';
import type { RawFrame } from '@avdm/automation';
import {
  AI_ACTION_LABEL, aiConfigProblems, mergeAiConfig, redactAiConfig, scrubAiSecret, toAiConfigView,
  type AdvisorAdvice, type AdvisorBox, type AdvisorConfig, type AdvisorConfigPatch, type AdvisorConfigView, type AdvisorRecord,
  type AdvisorStatus, type AdvisorTemplateProposal, type AdvisorTestResult,
} from '../../../shared/ai';
import { ADVISOR_HISTORY_LIMIT, AdvisorStore, emptyAdvisorFile, type AdvisorFile } from './store';
import { buildVisionProbe, chatVision, encodeCropPng, encodeFrame, PROBE_LETTER, replyNamesProbeLetter, type VisionFetch } from './client';
import { promptProfileOf } from './profiles';
import { adviceRejection, extractJson, parseAdvice, parseBox, scaleBox } from './risk';
import type {
  AdvisorCapturePort, AdvisorConsultTarget, AdvisorNote, AdvisorPromptProfile, FrameConsultInput, FrameConsultResult,
} from './types';

export type {
  AdvisorAction, AdvisorAdvice, AdvisorBox, AdvisorCapture, AdvisorCapturePort,
  AdvisorConfig, AdvisorConfigPatch, AdvisorConfigView, AdvisorConsultTarget,
  AdvisorEffect, AdvisorNote, AdvisorOutcome, AdvisorRecord, AdvisorRisk, AdvisorRiskLevel, AdvisorScreen,
  AdvisorStatus, AdvisorTemplateProposal, AdvisorTestResult, FrameConsultInput, FrameConsultResult,
} from './types';

export type AdvisorLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface AdvisorOptions {
  fetch?: VisionFetch;
  now?: () => number;
  /** Every record (manual analysis, automatic recovery, test, skipped): the `ai-consulted` push. */
  onRecord?: (record: AdvisorRecord) => void;
  /** After a saved config change: the `ai-config-changed` push (masked view only). */
  onConfigChanged?: (view: AdvisorConfigView) => void;
  /** Log lines (already scrubbed). */
  log?: (level: AdvisorLogLevel, message: string) => void;
  /** Display name of a game (used by the neutral prompt). */
  gameName?: (gameId: string) => string;
  /** Test seam: size bound of advisor.json (default 1 MB). */
  maxFileBytes?: number;
}

/** Repeat-confirmation lock: the same confirmation on the same instance is clicked at most once per this window. */
const CONFIRM_REPEAT_MS = 60_000;
const CONFIRM_MEMORY = 512;

/**
 * The visual advisor: configuration, rate limits, two-stage questions and records (original AiAdvisor). It only
 * gives advice — it never taps, presses keys or writes templates. Clicking, verifying and self-learned templates are
 * the executor's (`../ai-recover`), which asks through `consultFrame` / `claimConfirmation` / `note`.
 *
 * Rate limits are a circuit breaker, not an optimisation: `maxCallsPerHour` (all instances, 0 = unlimited) and
 * `cooldownSeconds` (per instance; a click-time recheck skips it but still counts). Only requests actually sent count;
 * with the advisor switched off automatic chains send nothing and record nothing (original iron rule 4).
 */
export class AdvisorService {
  private readonly store: AdvisorStore;
  private readonly ready: Promise<AdvisorFile>;
  private loaded: AdvisorFile | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private writes: Promise<unknown> = Promise.resolve();
  private readonly recentConfirmations = new Map<string, number>();

  constructor(home: string, private readonly capture: AdvisorCapturePort, private readonly options: AdvisorOptions = {}) {
    this.store = new AdvisorStore(home, options.maxFileBytes !== undefined ? { maxBytes: options.maxFileBytes } : {});
    // Tolerant like the original init: an unreadable file never takes the page down; the advisor starts off.
    this.ready = this.store.load().catch((error: unknown) => ({
      ...emptyAdvisorFile(),
      loadWarning: `读取 AI 顾问配置失败，本次从默认配置开始（顾问关闭）：${error instanceof Error ? error.message : String(error)}`,
    }));
    void this.ready.then((state) => {
      this.loaded = state;
      if (state.loadWarning) this.log('warn', state.loadWarning);
      this.log('info', `AI 顾问已就绪：${JSON.stringify(redactAiConfig(state.config))}`);
    });
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

  private log(level: AdvisorLogLevel, message: string): void {
    const safe = this.loaded ? scrubAiSecret(message, this.loaded.config) : message;
    if (this.options.log) {
      try { this.options.log(level, safe); } catch { /* a log sink never breaks the advisor */ }
    } else if (level === 'warn' || level === 'error') console.warn(`[wanlong/ai] ${safe}`);
  }

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const next = this.queue.then(action, action);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }

  /** Persist the current state (a snapshot at write time); writes are serialized. */
  private persist(state: AdvisorFile): Promise<void> {
    return this.persistWith(state, {});
  }

  async config(): Promise<AdvisorConfigView> { return toAiConfigView((await this.ready).config); }

  /** Whether automatic chains will ask: switched on and complete. False until the file is loaded. */
  isActive(): boolean {
    const config = this.loaded?.config;
    return Boolean(config?.enabled && aiConfigProblems(config).length === 0);
  }

  /** Execution switches for the executor (no credentials). */
  settings(): Pick<AdvisorConfig, 'enabled' | 'minConfidence' | 'autoActions' | 'autoHarvest' | 'refine'> {
    const config = this.loaded?.config ?? emptyAdvisorFile().config;
    return {
      enabled: config.enabled, minConfidence: config.minConfidence, autoActions: config.autoActions,
      autoHarvest: config.autoHarvest, refine: config.refine,
    };
  }

  async saveConfig(patch: AdvisorConfigPatch): Promise<AdvisorConfigView> {
    return this.serialize(async () => {
      const state = await this.ready;
      const config = mergeAiConfig(state.config, patch);
      await this.persistWith(state, { config });
      state.config = config;
      delete state.loadWarning;
      const view = toAiConfigView(config);
      this.log('info', `AI 顾问配置已更新：${JSON.stringify(redactAiConfig(config))}`);
      try { this.options.onConfigChanged?.(view); } catch { /* a closed window cannot undo a saved config */ }
      return view;
    });
  }

  /**
   * Save a modified copy first, then adopt it: a failed write leaves the old config in effect. The store leaves the
   * oldest records out when the file would exceed its size bound (a config save never fails because of the history);
   * those records are dropped from memory too, so the page shows what a restart would.
   */
  private persistWith(state: AdvisorFile, change: Partial<AdvisorFile>): Promise<void> {
    const write = async (): Promise<void> => {
      const written = { ...state, ...change };
      const history = written.history;
      const kept = await this.store.save(written);
      if (kept >= history.length) return;
      const dropped = new Set(history.slice(kept));
      state.history = state.history.filter((item) => !dropped.has(item));
      this.log('warn', `AI 顾问记录超过文件大小上限，已丢弃最早的 ${dropped.size} 条。`);
    };
    const next = this.writes.then(write, write);
    this.writes = next.then(() => undefined, () => undefined);
    return next;
  }

  async status(): Promise<AdvisorStatus> {
    const state = await this.ready;
    const config = state.config;
    return {
      enabled: config.enabled,
      configured: aiConfigProblems(config).length === 0,
      model: config.model,
      baseUrl: config.baseUrl,
      callsLastHour: this.recentCalls(state).length,
      maxCallsPerHour: config.maxCallsPerHour,
      consultCount: state.totalConsults,
      harvestedCount: state.history.filter((item) => item.outcome === 'harvested').length,
      autoActions: config.autoActions,
      autoHarvest: config.autoHarvest,
      refine: config.refine,
      lastRecord: state.history[0] ?? null,
      loadWarning: state.loadWarning ?? null,
    };
  }

  async history(limit = ADVISOR_HISTORY_LIMIT): Promise<AdvisorRecord[]> {
    const state = await this.ready;
    return state.history.slice(0, Math.max(1, Math.min(ADVISOR_HISTORY_LIMIT, Math.trunc(limit) || ADVISOR_HISTORY_LIMIT)));
  }

  private recentCalls(state: AdvisorFile): number[] {
    const now = this.now();
    const cutoff = now - 3_600_000;
    return state.calls.filter((at) => at >= cutoff && at <= now);
  }

  /**
   * Quota and cooldown, checked and reserved synchronously (two instances cannot both take the last call). Returns
   * the Chinese reason when this question must not be sent.
   */
  private reserve(state: AdvisorFile, key: string | null, label: string, recheck: boolean): string | null {
    const config = state.config;
    const recent = this.recentCalls(state);
    if (config.maxCallsPerHour > 0 && recent.length >= config.maxCallsPerHour) {
      return `最近一小时已问询 ${recent.length} 次，达到上限 ${config.maxCallsPerHour} 次，本次不问（防止识别出错时反复烧钱）。`;
    }
    const now = this.now();
    if (key !== null) {
      const last = state.lastConsultAt[key];
      if (!recheck && last !== undefined && now - last < config.cooldownSeconds * 1000) {
        const left = Math.ceil((config.cooldownSeconds * 1000 - (now - last)) / 1000);
        return `${label}距上次问询不足 ${config.cooldownSeconds} 秒（还剩 ${left} 秒），本次不问。`;
      }
      state.lastConsultAt[key] = now;
    }
    state.calls = [...recent, now].slice(-500);
    return null;
  }

  private async record(state: AdvisorFile, value: Omit<AdvisorRecord, 'id' | 'at'>, id = randomUUID()): Promise<AdvisorRecord> {
    const entry: AdvisorRecord = {
      id, at: this.now(), ...value,
      message: scrubAiSecret(value.message, state.config).slice(0, 500),
    };
    state.history = [entry, ...state.history].slice(0, ADVISOR_HISTORY_LIMIT);
    state.calls = this.recentCalls(state);
    if (entry.context !== 'vision-test' && entry.providerCalls > 0) state.totalConsults += 1;
    try { await this.persist(state); }
    catch (error) { this.log('warn', `AI 顾问记录落盘失败：${error instanceof Error ? error.message : String(error)}`); }
    try { this.options.onRecord?.(entry); } catch { /* event listeners cannot alter persisted evidence */ }
    return entry;
  }

  /**
   * Record an executor result (automatic recovery). ★ The message is scrubbed again here as the last safeguard.
   * Never throws.
   */
  async note(note: AdvisorNote): Promise<AdvisorRecord> {
    const state = await this.ready;
    return this.record(state, {
      gameId: note.gameId, index: note.index, context: note.context.slice(0, 80), outcome: note.outcome,
      message: note.message, advice: note.advice, templateProposal: null, harvestedTemplateId: note.harvestedTemplateId,
      ...(note.requiresAttention ? { requiresAttention: true } : {}),
      latencyMs: Math.max(0, note.latencyMs), providerCalls: Math.max(0, Math.min(4, note.providerCalls)),
    });
  }

  /**
   * Same confirmation (instance, effect, button text, dialog text; whitespace ignored) is clicked at most once per
   * 60 s — protects against a slow network or an unchanged screen repeating a confirmation. Memory only (digests).
   */
  claimConfirmation(instanceIndex: number | null, advice: Pick<AdvisorAdvice, 'risk'>): boolean {
    const now = this.now();
    for (const [key, at] of this.recentConfirmations) if (now - at >= CONFIRM_REPEAT_MS) this.recentConfirmations.delete(key);
    const risk = advice.risk;
    const key = createHash('sha256').update(JSON.stringify([
      instanceIndex, risk?.effect, risk?.buttonText.replace(/\s/g, ''), risk?.dialogText.replace(/\s/g, ''),
    ])).digest('hex');
    if (this.recentConfirmations.has(key)) return false;
    if (this.recentConfirmations.size >= CONFIRM_MEMORY) this.recentConfirmations.delete(this.recentConfirmations.keys().next().value!);
    this.recentConfirmations.set(key, now);
    return true;
  }

  /**
   * 「测试连接与视觉能力」: a synthetic image (red W) and one question. Recorded as a test; not charged to the hourly
   * quota (the original), so the user can always test. Never uses a game screenshot.
   */
  async test(): Promise<AdvisorTestResult> {
    return this.serialize(async () => {
      const state = await this.ready;
      const config = state.config;
      const start = this.now();
      const problems = aiConfigProblems(config);
      if (problems.length) return { ok: false, vision: null, kind: 'config', model: config.model, latencyMs: 0, message: problems.join(' '), reply: null };
      let image: Buffer;
      try { image = await buildVisionProbe(); }
      catch { return { ok: false, vision: null, kind: 'bad_request', model: config.model, latencyMs: 0, message: '生成测试图失败。', reply: null }; }
      const result = await chatVision(config, {
        image, mime: 'image/png', system: '你是图像识别助手。只回答问题本身，不要解释。',
        user: '这张图片里最大的那个字母是什么？只回答这个字母，不要任何其它文字。', maxTokens: 20,
      }, this.options.fetch);
      let outcome: AdvisorTestResult;
      if (!result.ok) {
        outcome = {
          ok: false, vision: result.failureKind === 'vision' ? false : null, kind: result.failureKind, model: config.model,
          latencyMs: result.latencyMs, message: result.failure ?? 'AI 接口请求失败。', reply: null,
        };
      } else {
        const reply = scrubAiSecret(result.text.trim().slice(0, 120), config);
        const seen = replyNamesProbeLetter(reply);
        outcome = {
          ok: seen, vision: seen, kind: seen ? null : 'vision', model: result.model, latencyMs: result.latencyMs, reply,
          message: seen
            ? `模型「${result.model}」能看图：正确认出了测试图里的字母 ${PROBE_LETTER}，耗时 ${result.latencyMs}ms。可以启用。`
            : `模型「${result.model}」回复了「${reply}」，没有认出测试图里的字母 ${PROBE_LETTER}。` +
              '它多半没有真的看到图片（纯文本模型，或网关静默丢掉了图片），请换一个视觉模型再测。',
        };
      }
      await this.record(state, {
        gameId: '', index: null, context: 'vision-test', outcome: outcome.ok ? 'test_passed' : 'failed',
        message: outcome.message, advice: null, templateProposal: null, harvestedTemplateId: null,
        latencyMs: Math.max(0, this.now() - start), providerCalls: 1,
      });
      return outcome;
    });
  }

  /**
   * Second stage: crop around the stage-one box from the raw frame (PNG, doubled when narrower than 480 px) and ask
   * for a tight box. Any failure keeps the stage-one box (null). The box is in `ref` space.
   * @returns the refined box and whether a request was sent
   */
  private async refineBox(
    config: AdvisorConfig, profile: AdvisorPromptProfile, raw: RawFrame, target: AdvisorBox, refWidth: number, refHeight: number,
  ): Promise<{ box: AdvisorBox | null; sent: boolean }> {
    const dx = raw.width / refWidth;
    const dy = raw.height / refHeight;
    const box = { x: target.x * dx, y: target.y * dy, w: Math.max(1, target.w * dx), h: Math.max(1, target.h * dy) };
    const pad = Math.max(box.w, box.h, 60);
    const clamp = (v: number, min: number, max: number): number => Math.round(Math.min(max, Math.max(min, v)));
    const left = clamp(box.x - pad, 0, raw.width - 1);
    const top = clamp(box.y - pad, 0, raw.height - 1);
    const right = clamp(box.x + box.w + pad, left + 1, raw.width);
    const bottom = clamp(box.y + box.h + pad, top + 1, raw.height);
    const cropW = right - left;
    const cropH = bottom - top;
    // Narrower than 480 px: double it — models locate small controls on small images poorly.
    const up = cropW < 480 ? 2 : 1;
    let png: Buffer;
    try { png = await encodeCropPng(raw, left, top, cropW, cropH, up); }
    catch (error) {
      this.log('warn', `局部放大图编码失败，沿用整帧框：${error instanceof Error ? error.message : String(error)}`);
      return { box: null, sent: false };
    }
    const reply = await chatVision(config, {
      system: profile.system, user: profile.refine(cropW * up, cropH * up), image: png, mime: 'image/png', maxTokens: 120,
    }, this.options.fetch);
    if (!reply.ok) {
      this.log('warn', `精定位请求失败，沿用整帧框：${reply.failure ?? ''}`);
      return { box: null, sent: true };
    }
    const json = extractJson(reply.text);
    const t = json && typeof json === 'object' ? (json as { target?: unknown }).target : null;
    const b = parseBox(t, cropW * up, cropH * up);
    if (!b) {
      this.log('warn', `精定位回复无法解析，沿用整帧框（原文：${reply.text.slice(0, 120)}）`);
      return { box: null, sent: true };
    }
    const device = { x: left + b.x / up, y: top + b.y / up, w: b.w / up, h: b.h / up };
    const ref: AdvisorBox = {
      x: Math.round(device.x / dx), y: Math.round(device.y / dy),
      w: Math.max(1, Math.round(device.w / dx)), h: Math.max(1, Math.round(device.h / dy)),
    };
    // The refined box must stay inside the padded region and not be much larger (3× + 40) than the first one.
    const cx = ref.x + ref.w / 2;
    const cy = ref.y + ref.h / 2;
    const withinX = cx >= left / dx && cx <= right / dx;
    const withinY = cy >= top / dy && cy <= bottom / dy;
    if (!withinX || !withinY || ref.w > target.w * 3 + 40 || ref.h > target.h * 3 + 40) {
      this.log('warn', '精定位给的框跑出了合理范围，沿用整帧框。');
      return { box: null, sent: true };
    }
    return { box: ref, sent: true };
  }

  /**
   * Both stages on a frame: stage one (whole frame JPEG), then — when `refine` — the magnified crop for close / cancel.
   * The box comes back in `refWidth × refHeight` space. Never throws.
   */
  private async ask(
    config: AdvisorConfig, gameId: string, raw: RawFrame, refWidth: number, refHeight: number, attempt: number | null, recheck: boolean,
    refine: boolean,
  ): Promise<{ advice: AdvisorAdvice | null; reason: string; outcome: 'failed' | 'unparsable' | null; providerCalls: number; failureKind?: FrameConsultResult['failureKind'] }> {
    const profile = promptProfileOf(gameId);
    let image: Awaited<ReturnType<typeof encodeFrame>>;
    try { image = await encodeFrame(raw, config.imageWidth); }
    catch (error) {
      return { advice: null, reason: `截图编码失败：${scrubAiSecret(error instanceof Error ? error.message : String(error), config)}`, outcome: 'failed', providerCalls: 0 };
    }
    const gameName = this.options.gameName?.(gameId) ?? gameId;
    const response = await chatVision(config, {
      image: image.bytes, mime: 'image/jpeg', system: profile.system,
      user: profile.stage1({ gameName, width: image.width, height: image.height, attempt, recheck }), maxTokens: 800,
    }, this.options.fetch);
    if (!response.ok) {
      this.log('warn', `AI 问询失败（${response.failureKind ?? '未知'}）：${response.failure ?? ''}`);
      return { advice: null, reason: response.failure ?? 'AI 接口请求失败。', outcome: 'failed', providerCalls: 1, failureKind: response.failureKind };
    }
    const parsed = parseAdvice(response.text, image.width, image.height, profile.screens);
    if (!parsed.ok) {
      this.log('warn', `AI 回复无法解析：${parsed.reason}（原文：${response.text.slice(0, 160)}）`);
      return { advice: null, reason: parsed.reason, outcome: 'unparsable', providerCalls: 1 };
    }
    const value = parsed.value;
    let target = value.target ? scaleBox(value.target, image.width, image.height, refWidth, refHeight) : null;
    let refined = false;
    let providerCalls = 1;
    if (target && refine && (value.action === 'tap_close' || value.action === 'tap_cancel')) {
      const better = await this.refineBox(config, profile, raw, target, refWidth, refHeight);
      if (better.sent) providerCalls += 1;
      if (better.box) { target = better.box; refined = true; }
    }
    const partial = { ...value, target };
    const rejection = adviceRejection(partial, config.minConfidence, profile.noConfirmScreens);
    const review: AdvisorAdvice['review'] = value.action === 'none' || value.action === 'back' ? 'no_action' : rejection ? 'blocked' : 'manual_review';
    const advice: AdvisorAdvice = {
      ...partial,
      reason: scrubAiSecret(value.reason, config),
      risk: {
        ...value.risk,
        buttonText: scrubAiSecret(value.risk.buttonText, config),
        dialogText: scrubAiSecret(value.risk.dialogText, config),
        consequence: scrubAiSecret(value.risk.consequence, config),
        reason: scrubAiSecret(value.risk.reason, config),
        hazards: value.risk.hazards.map((hazard) => scrubAiSecret(hazard, config)),
      },
      model: response.model,
      review,
      reviewReason: rejection ?? (review === 'no_action' ? '无需点击，交回兜底阶梯。' : '通过本地风险闸门。'),
      refined,
    };
    this.log('info', `AI 建议：界面=${advice.screen} 动作=${AI_ACTION_LABEL[advice.action]}` +
      (target ? ` 目标=(${target.x},${target.y} ${target.w}x${target.h})${refined ? '·已精修' : ''}` : '') +
      ` 置信=${advice.confidence.toFixed(2)} 理由=${advice.reason}`);
    return { advice, reason: '', outcome: null, providerCalls };
  }

  /**
   * An automatic chain's question about a frame it holds (gather G0, sampler, script run). The box is in reference
   * coordinates. Never throws and never records by itself: the executor records one result per recovery.
   */
  async consultFrame(input: FrameConsultInput): Promise<FrameConsultResult> {
    const state = await this.ready;
    const start = this.now();
    const config = state.config;
    const base = { latencyMs: 0, providerCalls: 0 };
    if (!config.enabled) return { ...base, advice: null, reason: 'AI 顾问未启用。', outcome: null };
    const problems = aiConfigProblems(config);
    if (problems.length) return { ...base, advice: null, reason: `AI 顾问配置不完整：${problems.join(' ')}`, outcome: 'skipped' };
    const key = input.instanceIndex === null ? null : `${input.gameId}:${input.instanceIndex}`;
    const skip = this.reserve(state, key, input.instanceIndex === null ? '' : `实例 #${input.instanceIndex} `, input.recheck === true);
    if (skip) return { ...base, advice: null, reason: skip, outcome: 'skipped' };
    // The magnified crop only sharpens a tap and a learnt template: with「自动处理」off an automatic chain only records
    // the suggestion, so the second request would be paid for nothing.
    const refine = config.refine && config.autoActions;
    const asked = await this.ask(config, input.gameId, input.raw, input.refWidth, input.refHeight, input.attempt, input.recheck === true, refine);
    const latencyMs = Math.max(0, this.now() - start);
    if (!asked.advice) {
      return { advice: null, reason: asked.reason, outcome: asked.outcome ?? 'failed', latencyMs, providerCalls: asked.providerCalls, failureKind: asked.failureKind ?? null };
    }
    return { advice: { ...asked.advice, space: 'reference', latencyMs }, reason: '', outcome: null, latencyMs, providerCalls: asked.providerCalls };
  }

  /** Manual, read-only analysis of the current screen (this repository's addition): advice and a template candidate. */
  async consult(target: AdvisorConsultTarget): Promise<AdvisorRecord> {
    return this.serialize(async () => {
      const state = await this.ready;
      const start = this.now();
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(target.gameId) || !Number.isInteger(target.index) || target.index < 0 || target.index > 63 ||
        !/^[a-zA-Z0-9_.]+$/.test(target.packageName)) throw new Error('AI 顾问目标无效。');
      const base = {
        gameId: target.gameId, index: target.index, context: target.context.slice(0, 80), advice: null, templateProposal: null,
        harvestedTemplateId: null, latencyMs: 0, providerCalls: 0,
      };
      const config = state.config;
      if (!config.enabled) return this.record(state, { ...base, outcome: 'skipped', message: 'AI 顾问尚未启用。' });
      const problems = aiConfigProblems(config);
      if (problems.length) return this.record(state, { ...base, outcome: 'skipped', message: `AI 顾问配置不完整：${problems.join(' ')}` });
      if (config.maxCallsPerHour > 0 && this.recentCalls(state).length >= config.maxCallsPerHour) {
        return this.record(state, { ...base, outcome: 'skipped', message: '最近一小时的 AI 请求已达到上限。' });
      }
      const key = `${target.gameId}:${target.index}`;
      const last = state.lastConsultAt[key];
      if (last !== undefined && this.now() - last < config.cooldownSeconds * 1000) {
        return this.record(state, { ...base, outcome: 'skipped', message: '该实例仍处于 AI 问询冷却时间。' });
      }
      let capture: Awaited<ReturnType<AdvisorCapturePort>>;
      try { capture = await this.capture(target.gameId, target.index); }
      catch (error) {
        return this.record(state, { ...base, outcome: 'failed', message: `无法读取设备画面：${scrubAiSecret(error instanceof Error ? error.message : String(error), config).slice(0, 150)}` });
      }
      if (capture.foregroundPackage !== target.packageName) {
        return this.record(state, { ...base, outcome: 'skipped', message: `前台应用与目标游戏不一致（当前：${capture.foregroundPackage ?? '未知'}）。` });
      }
      const skip = this.reserve(state, key, `实例 #${target.index} `, false);
      if (skip) return this.record(state, { ...base, outcome: 'skipped', message: skip });
      const frame = capture.frame;
      const asked = await this.ask(config, target.gameId, frame, frame.width, frame.height, null, false, config.refine);
      const latencyMs = Math.max(0, this.now() - start);
      if (!asked.advice) {
        return this.record(state, { ...base, outcome: asked.outcome ?? 'failed', message: asked.reason, latencyMs, providerCalls: asked.providerCalls });
      }
      const advice: AdvisorAdvice = {
        ...asked.advice, space: 'frame', latencyMs,
        reviewReason: asked.advice.review === 'manual_review'
          ? (asked.advice.action === 'tap_confirm' ? '仅供人工参考；确认动作仍需新截图独立复核，且必须由用户执行。' : '仅供人工核对；手动分析不会点击设备。')
          : asked.advice.reviewReason,
      };
      const recordId = randomUUID();
      const proposal: AdvisorTemplateProposal | null = advice.review === 'manual_review' && advice.action === 'tap_close' && advice.target
        ? {
          gameId: target.gameId, index: target.index, sourceCapturedAt: frame.capturedAt,
          frameWidth: frame.width, frameHeight: frame.height, box: advice.target,
          suggestedName: `关闭按钮 · ${target.gameName.slice(0, 50)}`, sourceRecordId: recordId,
        } : null;
      const outcome: AdvisorRecord['outcome'] = advice.review === 'blocked' ? 'blocked' : advice.review === 'no_action' ? 'no_action' : 'advised';
      return this.record(state, {
        ...base, outcome, message: advice.review === 'blocked' ? `已拦下模型建议：${advice.reviewReason}` : advice.reason || advice.reviewReason,
        advice, templateProposal: proposal, latencyMs, providerCalls: asked.providerCalls,
      }, recordId);
    });
  }
}
