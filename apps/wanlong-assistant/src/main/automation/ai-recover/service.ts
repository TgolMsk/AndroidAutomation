/**
 * The three「认不出界面」entry points of the original panel (src/main/index.ts gatherAdvisor / aiRecoverForScheduler /
 * aiAssistForRun), all through one `recoverUnknownWithUpdate`: the calibrated game-update handler first (even with the
 * AI off), then the AI executor; an AI verdict「低风险资源更新」 reuses the update wait. GAME_UPDATE_REQUIRED /
 * AI_RISK_BLOCKED go to `onNeedsAttention` and are rethrown (the caller never presses BACK after them).
 *
 * Runs in main, inside the caller's instance ownership: the gather cycle's or the sample's instance lock (the vision
 * job waits on the hook), or the script run's lease (the script worker waits on its aiConsult). Every capture and tap
 * goes through the instance's device lane and re-checks the instance identity against the one that writer was
 * admitted with (the running job's, the script run's), and every tap re-checks the foreground package. Template
 * matching (recognition, close-button dedupe, update detection) and the frame comparisons are asked of the instance's
 * long-lived vision worker; neither OpenCV nor the per-pixel loops run here.
 */
import type { MatchResult, RawFrame, TemplateDraft, TemplateSet } from '@avdm/automation';
import type { AiAssistResult } from '@avdm/automation/script';
import { AppError, GAME_UPDATE_TPL, recoverUnknownWithUpdate, type OverlayConsult, type UnknownScreenRecovery } from '@avdm/automation/wanlong';
import type { AdvisorScreen } from '../../../shared/ai';
import { promptProfileOf } from '../advisor/profiles';
import type { ScriptAiRequest } from '../../plans/types';
import type { FrameComparer } from './frame-diff';
import { isClosePopupTemplateId, type HarvestPort } from './harvest';
import { aiRecoverUnknownScreen, type RecoverAdvisorPort, type RecoverIo, type RecoverLogger } from './recover';
import { NO_UPDATE, WorkerUpdateRecovery, type UpdateVerdict } from './update';

/** The script worker gives up on an AI consult after 180 s: stop acting well before that. */
export const SCRIPT_ASSIST_BUDGET_MS = 170_000;
const DEFAULT_REF = { width: 2560, height: 1440 };
const UPDATE_TEMPLATE_IDS: ReadonlySet<string> = new Set(Object.values(GAME_UPDATE_TPL));

export type AiChainContext = 'gather-g0' | 'scheduler-sample' | 'script-run';

/** The device subset the executor drives (`@avdm/core` AdbDevice, lane-bound in the app). */
export interface AiDevice {
  screencapRaw(): Promise<RawFrame>;
  foregroundPackage(): Promise<string | undefined>;
  tap(x: number, y: number): Promise<void>;
}

export interface AiAttentionInfo {
  code: string;
  message: string;
  /** 「AI 操作风险评估」or「游戏资源更新」 (original alert detail 阶段). */
  stage: string;
}

export interface AiRecoveryDeps {
  gameId: string;
  packageName: string;
  advisor: RecoverAdvisorPort & { isActive(): boolean };
  /** AvdManager subset: instance state (identity = record.createdAt) and its device. */
  manager: {
    getState(index: number): Promise<{ status: string; record: { createdAt: string } }>;
    device(index: number): Promise<AiDevice>;
  };
  /** Run a check-then-act unit on the instance's device lane. */
  lane?<T>(index: number, work: () => Promise<T>): Promise<T>;
  /**
   * The identity (`record.createdAt`) the sample or gather cycle now running on the instance was admitted with (null:
   * none runs, so the gather / sampler chains do not touch the device). Absent: the identity read at the start.
   */
  admittedIdentity?(index: number): string | null;
  /** Frame comparisons on the instance's vision worker (off the main thread). Absent: computed in this process. */
  frames?(index: number, signal?: AbortSignal): FrameComparer;
  /** The instance's own template set (gather G0 / sampler), or null when none is selected. */
  instanceTemplateSet(index: number): Promise<TemplateSet | null>;
  /** A template set by directory (script runs, fresh ids before a harvest). */
  loadTemplateSet(directory: string): Promise<TemplateSet>;
  /** Known screen (world map / city / panels…) with the instance worker's compiled templates. */
  recognize(index: number, raw: RawFrame, signal?: AbortSignal): Promise<boolean>;
  /** Template matches by id in a set (instance worker, read-only query). */
  match(index: number, directory: string, raw: RawFrame, ids: string[], options: { roi?: { x: number; y: number; w: number; h: number }; signal?: AbortSignal }): Promise<MatchResult[]>;
  /** Game-update prompt / progress verdict for a frame (instance worker, read-only query). */
  updateVerdict(index: number, directory: string, raw: RawFrame, signal?: AbortSignal): Promise<UpdateVerdict>;
  /** Save a learnt template through the template library (change notification invalidates compiled caches). */
  saveTemplate(directory: string, draft: TemplateDraft): Promise<{ id: string; std: number }>;
  /** Plan config「脚本执行期间允许 AI 介入」(default true until the plans module provides it). */
  planAiAssist?(gameId: string): Promise<boolean>;
  /**
   * A human must look, on every chain: the host pauses first, then alerts (`EtaScheduler.raiseAttention`). Called
   * before the error is rethrown; a failing hook never hides the error.
   */
  onNeedsAttention?(index: number, info: AiAttentionInfo, context: AiChainContext): void | Promise<void>;
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, index?: number): void;
  /** Tests shorten the executor's and the update wait's pauses. */
  sleep?(ms: number): Promise<void>;
  now?(): number;
  updateMaxWaitMs?: number;
}

interface ChainOptions {
  index: number;
  context: AiChainContext;
  raw: RawFrame;
  attempt: number;
  signal?: AbortSignal;
  /** Template set for update detection, dedupe and harvest (null: none of these). */
  set: TemplateSet | null;
  /**
   * The identity the calling writer was admitted with. undefined: read at the start of the session; null: no running
   * job to act for (the device is not touched).
   */
  identity?: string | null;
  recognize?: (raw: RawFrame) => Promise<boolean>;
}

function abortCheck(signal: AbortSignal | undefined): () => void {
  return () => {
    if (!signal?.aborted) return;
    const reason = signal.reason;
    throw reason instanceof Error ? reason : new AppError('RUN_ABORTED', 'AI 处理已停止。');
  };
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : '';
}

function needsHuman(code: string): boolean {
  return code === 'AI_RISK_BLOCKED' || code === 'GAME_UPDATE_REQUIRED';
}

export class AiRecoveryService {
  constructor(private readonly deps: AiRecoveryDeps) {}

  /**
   * Gather G0 (before the blind BACK) and the pre-gate recovery ladder of a gather cycle.
   * @returns true = the screen was handled (recovered or an update finished); the caller re-judges.
   * @throws GAME_UPDATE_REQUIRED / AI_RISK_BLOCKED (never press BACK after them), aborts, other errors (the caller warns)
   */
  async adviseGather(index: number, raw: RawFrame, attempt: number, signal?: AbortSignal): Promise<boolean> {
    const set = await this.instanceSet(index);
    const result = await this.run({
      index, context: 'gather-g0', raw, attempt, signal, set, ...this.jobIdentity(index),
      recognize: (frame) => this.deps.recognize(index, frame, signal),
    });
    return result !== false;
  }

  /**
   * The troop-panel sampler could not recognise the screen (after the kicked probe): 'recovered' → recapture without
   * BACK, 'updated' → the sample's budget is extended. Other errors are logged and count as not handled.
   */
  async recoverForSampler(index: number, raw: RawFrame, signal?: AbortSignal): Promise<UnknownScreenRecovery> {
    try {
      const set = await this.instanceSet(index);
      return await this.run({
        index, context: 'scheduler-sample', raw, attempt: 1, signal, set, ...this.jobIdentity(index),
        recognize: (frame) => this.deps.recognize(index, frame, signal),
      });
    } catch (error) {
      if (needsHuman(errorCode(error)) || signal?.aborted) throw error;
      this.deps.log('warn', `AI 顾问在采样链路上出错，按未处理继续：${error instanceof Error ? error.message : String(error)}`, index);
      return false;
    }
  }

  /**
   * A script step exhausted its retries (original aiAssistForRun). The「known screen」 is what this step was waiting
   * for (`expectTemplateIds`), which also makes a learnt close button trustworthy. Never throws: needing a human is
   * `requiresAttention`, which fails the step without a retry.
   */
  async assistScript(request: ScriptAiRequest): Promise<AiAssistResult> {
    if (request.gameId !== this.deps.gameId) return { handled: false, message: '这个游戏没有接入脚本执行期间的 AI 介入。' };
    if (!this.deps.advisor.isActive()) return { handled: false, message: 'AI 顾问没开启（或没配 Key），本次不介入。' };
    try {
      if (this.deps.planAiAssist && !(await this.deps.planAiAssist(request.gameId))) {
        return { handled: false, message: '计划配置里关掉了「脚本执行期间允许 AI 介入」。' };
      }
    } catch { /* unreadable plan config: the default (on) applies */ }
    const index = request.instanceIndex;
    // Stop acting before the script worker stops waiting (it would otherwise continue while this still taps).
    const budget = new AbortController();
    const timer = setTimeout(() => budget.abort(new AppError('TIMEOUT', `AI 介入超过 ${SCRIPT_ASSIST_BUDGET_MS / 1000} 秒，已停止。`)), SCRIPT_ASSIST_BUDGET_MS);
    timer.unref?.();
    const onStop = (): void => budget.abort(request.signal.reason ?? new AppError('RUN_ABORTED', '脚本已停止。'));
    if (request.signal.aborted) onStop();
    else request.signal.addEventListener('abort', onStop, { once: true });
    const signal = budget.signal;
    try {
      let set: TemplateSet | null = null;
      if (request.templateDir) {
        try { set = await this.deps.loadTemplateSet(request.templateDir); }
        catch (error) {
          this.deps.log('warn', `载入脚本模板集失败，复验退化为只看画面变化：${error instanceof Error ? error.message : String(error)}`, index);
        }
      }
      const known = new Set(set?.templates.map((item) => item.id) ?? []);
      const expect = [...new Set(request.expectTemplateIds)].filter((id) => known.has(id)).slice(0, 64);
      const recognize = set && expect.length > 0
        ? async (frame: RawFrame) => (await this.deps.match(index, set.directory, frame, expect, { signal })).some((m) => m.found)
        : undefined;
      const session = await this.session(index, signal, DEFAULT_REF, request.instanceIdentity);
      const raw = await session.io.capture();
      const result = await this.run({
        index, context: 'script-run', raw, attempt: 1, signal, set, identity: request.instanceIdentity, ...(recognize ? { recognize } : {}),
      }, session);
      if (result === 'updated') return { handled: true, message: '游戏正在更新，已按更新流程处理，稍后重试这一步。' };
      if (result === 'recovered') return { handled: true, message: `AI 顾问已处理挡在前面的界面（${request.reason}）。` };
      return {
        handled: false,
        message: this.deps.advisor.settings().autoActions
          ? 'AI 顾问看过了，没有可执行的低风险操作。'
          : 'AI 顾问已记录建议；「自动处理」未开启，不会点击设备。',
      };
    } catch (error) {
      const code = errorCode(error);
      return {
        handled: false,
        message: error instanceof Error ? error.message : String(error),
        requiresAttention: needsHuman(code),
      };
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener('abort', onStop);
    }
  }

  /**
   * The identity the running sample / cycle was admitted with (nothing without the port). ★ With the port and no
   * running job (null) there is no writer to act for: the session refuses to touch the device.
   */
  private jobIdentity(index: number): { identity?: string | null } {
    return this.deps.admittedIdentity ? { identity: this.deps.admittedIdentity(index) ?? null } : {};
  }

  private async instanceSet(index: number): Promise<TemplateSet | null> {
    try { return await this.deps.instanceTemplateSet(index); }
    catch (error) {
      this.deps.log('warn', `读不出实例的模板集，AI 只看画面变化、不做更新识别与模板自学：${error instanceof Error ? error.message : String(error)}`, index);
      return null;
    }
  }

  /**
   * Device access for one recovery: identity checked before every capture and tap — against the identity the calling
   * writer was admitted with when known — and the foreground before every tap.
   */
  private async session(index: number, signal: AbortSignal | undefined, ref: { width: number; height: number }, admitted?: string | null) {
    const { manager, packageName } = this.deps;
    const check = abortCheck(signal);
    check();
    if (admitted === null) throw new AppError('DEVICE_NOT_READY', `实例 #${index} 上没有正在运行的采样或采集，AI 不操作设备`);
    const state = await manager.getState(index);
    if (state.status !== 'running') throw new AppError('DEVICE_NOT_READY', `实例 #${index} 尚未就绪，AI 不操作设备`);
    if (admitted !== undefined && state.record.createdAt !== admitted) {
      throw new AppError('DEVICE_NOT_READY', `实例 #${index} 已被替换（不是开始这次任务时的那台），AI 不操作设备`);
    }
    const createdAt = admitted ?? state.record.createdAt;
    const device = await manager.device(index);
    const onLane = <T>(work: () => Promise<T>): Promise<T> => this.deps.lane ? this.deps.lane(index, work) : work();
    const assertIdentity = async (): Promise<void> => {
      const now = await manager.getState(index);
      if (now.status !== 'running' || now.record.createdAt !== createdAt) {
        throw new AppError('DEVICE_NOT_READY', `实例 #${index} 已停止或被替换，AI 已停止操作`);
      }
    };
    let size = { width: 0, height: 0 };
    let refSize = ref;
    const io: RecoverIo & { foreground(): Promise<string | null>; setRef(ref: { width: number; height: number }): void; seed(frame: RawFrame): void } = {
      setRef(next) { refSize = next; },
      seed(frame) { size = { width: frame.width, height: frame.height }; },
      capture: () => onLane(async () => {
        check();
        await assertIdentity();
        check();
        const frame = await device.screencapRaw();
        size = { width: frame.width, height: frame.height };
        check();
        return frame;
      }),
      tap: (x, y) => onLane(async () => {
        check();
        if (!size.width || !size.height) throw new AppError('INVALID_ARGUMENT', '还没有截图，无法换算点击坐标');
        await assertIdentity();
        const foreground = await device.foregroundPackage();
        if (foreground !== packageName) throw new AppError('NOT_FOUND', `游戏已离开前台（当前：${foreground ?? '未知'}），AI 已停止点击`);
        check();
        await device.tap(Math.round(x * size.width / refSize.width), Math.round(y * size.height / refSize.height));
      }),
      foreground: async () => {
        check();
        return (await device.foregroundPackage()) ?? null;
      },
    };
    return { io, check };
  }

  private async run(options: ChainOptions, existing?: Awaited<ReturnType<AiRecoveryService['session']>>): Promise<UnknownScreenRecovery> {
    const { deps } = this;
    const { index, context, raw, signal, set } = options;
    // The update handler needs the calibrated prompt + confirm crops; without them (and with the AI off) there is
    // nothing to do and the device is not touched at all.
    const updateSet = set && set.templates.some((item) => UPDATE_TEMPLATE_IDS.has(item.id)) ? set : null;
    if (!updateSet && !deps.advisor.isActive()) return false;
    const ref = set ? { width: set.refWidth, height: set.refHeight } : DEFAULT_REF;
    const session = existing ?? await this.session(index, signal, ref, options.identity);
    session.io.setRef(ref);
    session.io.seed(raw);
    const { io, check } = session;
    const log: RecoverLogger = (level, message) => deps.log(level, `[AI] ${message}`, index);
    const profile = promptProfileOf(deps.gameId);
    const closeIds = set ? set.templates.map((item) => item.id).filter(isClosePopupTemplateId) : [];
    const harvest: HarvestPort | null = set ? {
      existingIds: async () => (await deps.loadTemplateSet(set.directory)).templates.map((item) => item.id),
      save: (draft) => deps.saveTemplate(set.directory, draft),
    } : null;
    const updater = new WorkerUpdateRecovery(
      (frame) => updateSet ? deps.updateVerdict(index, updateSet.directory, frame, signal) : Promise.resolve(NO_UPDATE),
      {
        ...(deps.sleep ? { sleep: deps.sleep } : {}), ...(deps.now ? { now: deps.now } : {}),
        ...(deps.updateMaxWaitMs !== undefined ? { maxWaitMs: deps.updateMaxWaitMs } : {}),
      },
    );
    const consult: OverlayConsult = async (frame, waiting) => {
      if (!deps.advisor.isActive()) return null;
      const result = await aiRecoverUnknownScreen(deps.advisor, {
        gameId: deps.gameId, instanceIndex: index, context, raw: frame, io, refWidth: ref.width, refHeight: ref.height,
        attempt: options.attempt, packageName: deps.packageName,
        mainScreens: profile.mainScreens as readonly AdvisorScreen[], noConfirmScreens: profile.noConfirmScreens,
        foregroundPackage: () => io.foreground(),
        allowUpdateConfirm: !waiting,
        checkAlive: check,
        ...(options.recognize ? { recognize: options.recognize } : {}),
        ...(set && closeIds.length > 0 ? {
          closeButtonCovered: async (image: RawFrame, roi: { x: number; y: number; w: number; h: number }) =>
            (await deps.match(index, set.directory, image, closeIds, { roi, signal })).some((m) => m.found),
        } : {}),
        harvest,
        ...(deps.frames ? { frames: deps.frames(index, signal) } : {}),
        log,
        ...(deps.sleep ? { sleep: deps.sleep } : {}),
      });
      return {
        handled: result.handled,
        outcome: result.outcome,
        action: result.advice?.action ?? null,
        // ★ With automatic handling off the AI only advises: its word never starts an update wait either.
        riskEffect: deps.advisor.settings().autoActions ? result.advice?.risk.effect ?? null : null,
        requiresAttention: result.requiresAttention,
        message: result.message,
      };
    };
    return recoverUnknownWithUpdate({
      updater,
      raw,
      refWidth: ref.width,
      refHeight: ref.height,
      io: { capture: () => io.capture(), tap: (x, y) => io.tap(x, y) },
      foregroundPackage: () => io.foreground(),
      check,
      ...(options.recognize ? { recognize: options.recognize } : {}),
      log: (level, message) => deps.log(level, message, index),
      consult,
      onNeedsAttention: async (error) => {
        const info: AiAttentionInfo = {
          code: error.code, message: error.message,
          stage: error.code === 'AI_RISK_BLOCKED' ? 'AI 操作风险评估' : '游戏资源更新',
        };
        await deps.onNeedsAttention?.(index, info, context);
      },
    });
  }
}
