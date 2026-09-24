/**
 * Layer 2: precise recognition of kicked / login / maintenance / update screens (port of the original `kicked.ts`).
 *
 * ★★ Degradation rule: the repository ships no template images. A template missing from the instance's set answers
 *    `found: false` (reason 「模板缺失」) from the vision worker's match query, and this probe returns null — never
 *    an error, never an alert, never an aborted cycle. Once the user adds a template with one of these ids (template
 *    library, or the old panel's set imported), layer 2 works without a code change. The ids are never added to the
 *    gather flow's critical or optional template lists.
 *
 * The probe runs on a frame that was captured anyway (a gather failure scene, an unrecognised sampler frame, a health
 * probe frame): zero extra screenshots. It uses the templates the instance's long-lived vision worker already
 * compiled (`AutomationHost.matchTemplates`, a read-only query that also answers while a cycle awaits a hook).
 * Safety floor kept from this app's earlier monitor: a hit needs `max(0.92, template threshold)`.
 */
import type { MatchResult } from '@avdm/automation';
import { RESERVED_TEMPLATE, type KickedProbeHit } from '../../shared/alerts';

interface Candidate {
  id: string;
  type: KickedProbeHit['type'];
  reason: string;
}

/** Order = priority: the most telling dialog first, then the login screen, then maintenance and update notices. */
export const KICKED_CANDIDATES: readonly Candidate[] = [
  { id: RESERVED_TEMPLATE.kickedDialog, type: 'suspectedKicked', reason: '画面上出现了「账号已在其他设备登录」的提示框，本端已被踢下线。' },
  { id: RESERVED_TEMPLATE.loginScreen, type: 'suspectedKicked', reason: '游戏停在登录界面，且自动恢复没能回到世界地图 —— 多半是被顶号踢了出来。' },
  { id: RESERVED_TEMPLATE.maintenanceDialog, type: 'needsAttention', reason: '画面上出现了「服务器维护中」公告，现在进不去游戏。' },
  { id: RESERVED_TEMPLATE.updateDialog, type: 'needsAttention', reason: '画面上出现了强制更新弹窗，需要先更新客户端才能继续。' },
];

/** Score floor of a layer-2 hit (the template's own threshold applies when it is higher). */
export const KICKED_MIN_SCORE = 0.92;

export type KickedMatch = (templateIds: string[]) => Promise<MatchResult[]>;

/**
 * Match the reserved templates on one frame. @returns the first hit in priority order, or null (templates missing, no
 * hit, or the match itself failed — the latter is logged and treated as「no conclusion」).
 */
export async function probeKickedFrame(
  match: KickedMatch,
  log?: (level: 'debug' | 'warn', message: string) => void,
): Promise<KickedProbeHit | null> {
  let results: MatchResult[];
  try {
    results = await match(KICKED_CANDIDATES.map((candidate) => candidate.id));
  } catch (error) {
    log?.('warn', `[告警] 顶号精确识别没能运行，本次降级到通用兜底：${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  for (const candidate of KICKED_CANDIDATES) {
    const result = results.find((item) => item.templateId === candidate.id);
    if (!result || !result.found) continue;
    const threshold = Math.max(KICKED_MIN_SCORE, result.threshold || 0);
    if (!(result.score >= threshold)) {
      log?.('debug', `[告警] 顶号精确识别：${candidate.id} 分数 ${result.score.toFixed(3)} 低于 ${threshold.toFixed(2)}，不算命中。`);
      continue;
    }
    log?.('warn', `[告警] 顶号精确识别命中模板「${candidate.id}」（score=${result.score.toFixed(3)}）。`);
    return {
      type: candidate.type,
      reason: candidate.reason,
      detail: { 命中模板: candidate.id, 匹配分: Number(result.score.toFixed(3)), 阈值: Number(threshold.toFixed(2)) },
    };
  }
  return null;
}
