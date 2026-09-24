/**
 * The device-writing AI executor (original src/main/ai/recover.ts `aiRecoverUnknownScreen`): consult → risk gate →
 * foreground check → fresh frame + stable-target check (confirmations: a second opinion on the fresh frame and the
 * 60 s repeat lock) → one tap at the box centre → wait 900 ms → verify → learn the close button → one record.
 *
 * It is a separate module from the read-only advisor (`../advisor`), which never touches a device. Safety edges kept
 * from the original, plus this repository's opt-in switch:
 *   0. `autoActions` off (the default): consult and record the suggestion only — no tap, no pause, the caller's own
 *      ladder continues (DECISIONS A.3).
 *   1. Taps need the risk gate; a confirmation also needs a fresh-frame second opinion and the repeat lock.
 *   2. Only tap_close / tap_cancel / tap_confirm are ever executed; back / none go back to the caller's own BACK
 *      ladder (where「BACK 之后必须取消退出框」lives), and this module never presses a key.
 *   3. Every tap is verified: no change ⇒ as if nothing happened; changed but unknown ⇒ `applied` (re-judge);
 *      a known screen ⇒ `verified`, and only then may a close button be learnt as a template.
 * Never throws: failures are results (`failed`, with `requiresAttention` for an interrupted confirmation).
 */
import type { RawFrame, Rect } from '@avdm/automation';
import { AI_ACTION_LABEL, AI_SCREEN_LABEL, type AdvisorAdvice, type AdvisorOutcome, type AdvisorScreen } from '../../../shared/ai';
import { adviceRejection, backNoneNeedsAttention, confidenceFloor, riskRejection } from '../advisor/risk';
import type { AdvisorNote, FrameConsultInput, FrameConsultResult } from '../advisor/types';
import { CHANGED_THRESHOLD, meanAbsDiff, stableTarget } from './frame-diff';
import { harvestCloseButton, type HarvestPort } from './harvest';

/** What the executor needs from the advisor (credentials, quota and records stay in the advisor). */
export interface RecoverAdvisorPort {
  consultFrame(input: FrameConsultInput): Promise<FrameConsultResult>;
  claimConfirmation(instanceIndex: number | null, advice: AdvisorAdvice): boolean;
  note(note: AdvisorNote): Promise<unknown> | unknown;
  settings(): { minConfidence: number; autoActions: boolean; autoHarvest: boolean };
}

/** Device access in reference coordinates (the caller converts and checks identity / foreground before input). */
export interface RecoverIo {
  capture(): Promise<RawFrame>;
  tap(x: number, y: number): Promise<void>;
}

export type RecoverLogger = (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;

export interface RecoverContext {
  gameId: string;
  instanceIndex: number | null;
  /** gather-g0 / scheduler-sample / script-run. */
  context: string;
  /** The unrecognised frame (before any click). */
  raw: RawFrame;
  io: RecoverIo;
  refWidth: number;
  refHeight: number;
  attempt: number;
  /** The game package that must be in front before a tap. */
  packageName: string;
  /** The game profile's own main screens (back / none there never escalates). */
  mainScreens: readonly AdvisorScreen[];
  /** Screens where confirmations are never automatic (account / login / unreadable). */
  noConfirmScreens?: readonly AdvisorScreen[];
  foregroundPackage?: () => Promise<string | null>;
  /** false while a game update is already downloading: never confirm the update a second time. */
  allowUpdateConfirm?: boolean;
  /** Throws the abort error once the caller stopped. */
  checkAlive?: () => void;
  /** Whether a frame is a known screen (local templates). Absent: only "did the screen change" counts. */
  recognize?: (raw: RawFrame) => Promise<boolean>;
  /** Whether an existing close-button template already matches in this region of the frame (no re-learning). */
  closeButtonCovered?: (raw: RawFrame, roi: Rect) => Promise<boolean>;
  /** Where to learn close buttons; null / absent = never learn. */
  harvest?: HarvestPort | null;
  log: RecoverLogger;
  /** Waits (tests shorten them). */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface RecoverResult {
  /** The screen was changed or must be re-judged (the caller recaptures instead of pressing BACK). */
  handled: boolean;
  advice: AdvisorAdvice | null;
  harvestedTemplateId: string | null;
  outcome: AdvisorOutcome;
  message: string;
  /** Pause and hand to a human: never continue the BACK ladder around this decision. */
  requiresAttention: boolean;
}

/** Wait after a tap before verifying. */
export const AFTER_TAP_MS = 900;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function aiRecoverUnknownScreen(advisor: RecoverAdvisorPort, ctx: RecoverContext): Promise<RecoverResult> {
  const now = ctx.now ?? Date.now;
  const sleep = ctx.sleep ?? defaultSleep;
  const t0 = now();
  let pendingAdvice: AdvisorAdvice | null = null;
  let providerCalls = 0;
  const finish = async (
    outcome: AdvisorOutcome, message: string, advice: AdvisorAdvice | null, harvestedTemplateId: string | null,
    handled: boolean, requiresAttention = false,
  ): Promise<RecoverResult> => {
    try {
      await advisor.note({
        gameId: ctx.gameId, index: ctx.instanceIndex, context: ctx.context, outcome, message, advice, harvestedTemplateId,
        ...(requiresAttention ? { requiresAttention } : {}), latencyMs: now() - t0, providerCalls,
      });
    } catch { /* recording never changes the outcome */ }
    ctx.log(handled ? 'info' : 'warn', `AI 顾问：${message}`);
    return { handled, advice, harvestedTemplateId, outcome, message, requiresAttention };
  };

  try {
    ctx.checkAlive?.();
    const c = await advisor.consultFrame({
      gameId: ctx.gameId, instanceIndex: ctx.instanceIndex, context: ctx.context, raw: ctx.raw,
      refWidth: ctx.refWidth, refHeight: ctx.refHeight, attempt: ctx.attempt,
    });
    providerCalls += c.providerCalls;
    if (!c.advice) {
      // Switched off: no record (otherwise every unrecognised screen writes「未启用」). Skipped / failed are recorded.
      if (c.outcome === null) {
        ctx.log('debug', `AI 顾问未参与：${c.reason}`);
        return { handled: false, advice: null, harvestedTemplateId: null, outcome: 'skipped', message: c.reason, requiresAttention: false };
      }
      return finish(c.outcome, c.reason, null, null, false);
    }
    let advice = c.advice;
    pendingAdvice = advice;
    const settings = advisor.settings();
    const noConfirm = ctx.noConfirmScreens;
    ctx.checkAlive?.();

    if (advice.action === 'back' || advice.action === 'none') {
      const screen = AI_SCREEN_LABEL[advice.screen] ?? advice.screen;
      if (settings.autoActions && backNoneNeedsAttention(advice, ctx.mainScreens)) {
        return finish('rejected', `风险判断未通过：${advice.risk.reason || '风险不明'}，停止自动处理。`, advice, null, false, true);
      }
      return finish('no_action',
        `模型判断当前是「${screen}」，建议「${AI_ACTION_LABEL[advice.action]}」，交回兜底阶梯处理（${advice.reason}）。`,
        advice, null, false);
    }

    // ★ Opt-in (DECISIONS A.3): with automatic handling off the suggestion is only recorded — no tap, no pause.
    if (!settings.autoActions) {
      const rejection = adviceRejection(advice, settings.minConfidence, noConfirm);
      return finish(rejection ? 'blocked' : 'advised',
        `自动处理未开启：模型建议「${AI_ACTION_LABEL[advice.action]}」${rejection ? `（本地风险闸门不会放行：${rejection}）` : ''}，仅记录建议，交回兜底阶梯。`,
        advice, null, false);
    }

    const rejectedRisk = riskRejection(advice, noConfirm);
    if (rejectedRisk) return finish('rejected', rejectedRisk, advice, null, false, true);
    if (ctx.allowUpdateConfirm === false && advice.risk.effect === 'download_update') {
      return finish('no_action', '资源更新已开始，继续等待，不重复确认下载。', advice, null, false);
    }
    if (!advice.target) return finish('rejected', '模型建议点击但没有给出目标框，不执行。', advice, null, false);
    const floor = confidenceFloor(advice.action, settings.minConfidence);
    if (advice.confidence < floor) {
      return finish('rejected',
        `模型置信度 ${advice.confidence.toFixed(2)} 低于阈值 ${floor}，不执行「${AI_ACTION_LABEL[advice.action]}」。`,
        advice, null, false, advice.action === 'tap_confirm');
    }

    const checkForeground = async (): Promise<boolean> => {
      ctx.checkAlive?.();
      if (!ctx.foregroundPackage) return advice.action !== 'tap_confirm';
      const ok = (await ctx.foregroundPackage()) === ctx.packageName;
      ctx.checkAlive?.();
      return ok;
    };
    if (!(await checkForeground())) return finish('rejected', '无法确认游戏仍在前台，已停止点击。', advice, null, false, true);
    let clickFrame = await ctx.io.capture();
    ctx.checkAlive?.();
    if (advice.action === 'tap_confirm') {
      const original = advice;
      const second = await advisor.consultFrame({
        gameId: ctx.gameId, instanceIndex: ctx.instanceIndex, context: ctx.context, raw: clickFrame,
        refWidth: ctx.refWidth, refHeight: ctx.refHeight, attempt: ctx.attempt, recheck: true,
      });
      providerCalls += second.providerCalls;
      ctx.checkAlive?.();
      if (!second.advice) return finish('rejected', `点击前风险复核未完成：${second.reason}`, original, null, false, true);
      advice = { ...second.advice, riskRechecked: true };
      pendingAdvice = advice;
      const secondRisk = riskRejection(advice, noConfirm);
      if (secondRisk || advice.action !== 'tap_confirm' || advice.confidence < floor ||
        advice.risk.effect !== original.risk.effect ||
        advice.risk.buttonText.replace(/\s/g, '') !== original.risk.buttonText.replace(/\s/g, '')) {
        return finish('rejected', `点击前复核未通过：${secondRisk ?? '按钮、后果或置信度发生变化'}。`, advice, null, false, true);
      }
      const latest = await ctx.io.capture();
      ctx.checkAlive?.();
      if (!advice.target || !(await stableTarget(clickFrame, latest, advice.target, ctx.refWidth, ctx.refHeight))) {
        return finish('rejected', '复核后画面发生变化，本次未点击，重新判断。', advice, null, true);
      }
      clickFrame = latest;
    } else if (!(await stableTarget(ctx.raw, clickFrame, advice.target, ctx.refWidth, ctx.refHeight))) {
      return finish('rejected', '等待模型回复期间目标发生变化，本次未点击，重新判断。', advice, null, true);
    }
    if (!(await checkForeground())) return finish('rejected', '点击前前台已变化，停止操作。', advice, null, false, true);
    ctx.checkAlive?.();
    if (advice.action === 'tap_confirm' && !advisor.claimConfirmation(ctx.instanceIndex, advice)) {
      return finish('rejected', '60 秒内已执行过相同确认，停止重复点击，请检查当前进度。', advice, null, false, true);
    }

    // ── act ──
    const box = advice.target!;
    const cx = Math.round(box.x + box.w / 2);
    const cy = Math.round(box.y + box.h / 2);
    ctx.log('info', `按 AI 建议「${AI_ACTION_LABEL[advice.action]}」点击 (${cx},${cy})：${advice.reason}`);
    await ctx.io.tap(cx, cy);
    await sleep(AFTER_TAP_MS);
    ctx.checkAlive?.();
    const after = await ctx.io.capture();

    // ── verify ──
    const diff = await meanAbsDiff(clickFrame, after, ctx.refWidth, ctx.refHeight);
    const changed = diff >= CHANGED_THRESHOLD;
    let recognized = false;
    if (ctx.recognize) {
      try { recognized = await ctx.recognize(after); }
      catch (error) { ctx.log('warn', `复验时模板判断出错，按未识别处理：${error instanceof Error ? error.message : String(error)}`); }
    }
    if (!changed && !recognized) {
      return finish('rejected', `点了 (${cx},${cy}) 之后画面没有变化（差异 ${diff.toFixed(1)}），判定无效，交回兜底阶梯。`,
        advice, null, false, advice.action === 'tap_confirm');
    }
    if (!recognized) {
      return finish('applied', `点了 (${cx},${cy})，画面变了（差异 ${diff.toFixed(1)}）但还没回到已知界面，重新判断。`, advice, null, true);
    }

    // ── learn: only tap_close back to a known screen (a confirmation is re-judged every time) ──
    if (advice.action !== 'tap_close' || !settings.autoHarvest || !ctx.harvest) {
      return finish('verified', `点了 (${cx},${cy})，已回到已知界面。`, advice, null, true);
    }
    if (await alreadyCovered(ctx, box)) {
      return finish('verified', `点了 (${cx},${cy})，已回到已知界面；模板库里已有模板能认出这个关闭按钮，不再重复学习。`, advice, null, true);
    }
    let skipReason = '';
    const harvested = await harvestCloseButton({
      raw: ctx.raw, box, refWidth: ctx.refWidth, refHeight: ctx.refHeight,
      note: `AI 自学（${ctx.context}，置信 ${advice.confidence.toFixed(2)}，模型 ${advice.model}）：${advice.reason}`,
    }, ctx.harvest, (reason) => { skipReason = reason; });
    if (!harvested) {
      return finish('verified', `点了 (${cx},${cy})，已回到已知界面；本次没有裁模板：${skipReason}`, advice, null, true);
    }
    return finish('harvested',
      `点了 (${cx},${cy})，已回到已知界面，并把关闭按钮裁成了模板「${harvested.id}」（std ${Math.round(harvested.std * 10) / 10}），下次同样的弹窗本地就能认出。`,
      advice, harvested.id, true);
  } catch (error) {
    return finish('failed', `AI 恢复流程出错：${error instanceof Error ? error.message : String(error)}`,
      pendingAdvice, null, false, pendingAdvice?.action === 'tap_confirm');
  }
}

/** Whether an existing close-button template already finds this × around the box (before the click). */
async function alreadyCovered(ctx: RecoverContext, box: { x: number; y: number; w: number; h: number }): Promise<boolean> {
  if (!ctx.closeButtonCovered) return false;
  const pad = Math.max(40, Math.max(box.w, box.h));
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
  const roi: Rect = { x, y, w: Math.min(ctx.refWidth, box.x + box.w + pad) - x, h: Math.min(ctx.refHeight, box.y + box.h + pad) - y };
  try { return await ctx.closeButtonCovered(ctx.raw, roi); }
  catch (error) {
    ctx.log('warn', `查重时模板匹配出错，按「没有覆盖」处理：${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
