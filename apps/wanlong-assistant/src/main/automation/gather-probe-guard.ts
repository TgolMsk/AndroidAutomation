import type { ProbeReport } from '@avdm/automation';
import { wanlongPlugin } from '@avdm/automation/wanlong';

/** Each anchor describes one known entry screen for the Wanlong gather flow. */
export const GATHER_PROBE_SCENES = {
  tpl_world_search_icon: 'world-map',
  tpl_nav_map_toggle: 'city-a',
  tpl_nav_map_toggle_b: 'city-b',
  tpl_panel_title_troop: 'troop-panel',
} as const;

export const GATHER_PROBE_TEMPLATE_IDS = Object.keys(GATHER_PROBE_SCENES) as Array<keyof typeof GATHER_PROBE_SCENES>;

/** Empirical positives include a valid city A frame at 0.903; leave a narrow safety margin. */
export const MIN_GATHER_PROBE_SCORE = 0.90;
export const MIN_GATHER_PROBE_LEAD = 0.05;

export type GatherProbeScene = typeof GATHER_PROBE_SCENES[keyof typeof GATHER_PROBE_SCENES];
export type GatherProbeDecision =
  | { ok: true; scene: GatherProbeScene; score: number }
  | { ok: false; reason: string };

/** Accept one strong, unambiguous known screen before any device input is permitted. */
export function inspectGatherProbe(probe: ProbeReport): GatherProbeDecision {
  if (!probe || probe.gameId !== wanlongPlugin.id || probe.packageName !== wanlongPlugin.packageName ||
    probe.foregroundPackage !== wanlongPlugin.packageName || probe.foregroundMatches !== true) {
    return { ok: false, reason: '采集探针未确认万龙觉醒在前台' };
  }
  if (!probe.frame || !Number.isInteger(probe.frame.width) || !Number.isInteger(probe.frame.height) ||
    probe.frame.width <= 0 || probe.frame.height <= 0 || !Array.isArray(probe.matches) ||
    probe.matches.length !== GATHER_PROBE_TEMPLATE_IDS.length) {
    return { ok: false, reason: '采集探针结果不完整' };
  }
  const byId = new Map(probe.matches.map((match) => [match.templateId, match]));
  if (byId.size !== GATHER_PROBE_TEMPLATE_IDS.length ||
    GATHER_PROBE_TEMPLATE_IDS.some((id) => !byId.has(id)) ||
    probe.matches.some((match) => !Number.isFinite(match.score) || !Number.isFinite(match.threshold) ||
      match.threshold < 0 || match.threshold > 1 || typeof match.found !== 'boolean' ||
      (match.found && match.score < match.threshold))) {
    return { ok: false, reason: '采集探针锚点数据无效' };
  }
  const hits = probe.matches.filter((match) => match.found);
  if (hits.length === 0) return { ok: false, reason: '采集探针没有识别到正锚点' };
  if (hits.length !== 1) return { ok: false, reason: '采集探针同时命中多个画面锚点' };
  const best = hits[0]!;
  if (best.score < MIN_GATHER_PROBE_SCORE) {
    return { ok: false, reason: `采集探针最高分 ${best.score.toFixed(3)} 低于 ${MIN_GATHER_PROBE_SCORE.toFixed(2)}` };
  }
  const nextBest = Math.max(...probe.matches.filter((match) => match.templateId !== best.templateId).map((match) => match.score));
  if (best.score - nextBest < MIN_GATHER_PROBE_LEAD) {
    return { ok: false, reason: `采集探针画面锚点分数接近（${best.score.toFixed(3)} / ${nextBest.toFixed(3)}）` };
  }
  return { ok: true, scene: GATHER_PROBE_SCENES[best.templateId as keyof typeof GATHER_PROBE_SCENES], score: best.score };
}
