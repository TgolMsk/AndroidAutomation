import type { ProbeReport } from '@avdm/automation';
import { inspectGatherProbe, type GatherProbeDecision } from '../automation/gather-probe-guard';

/**
 * The input gate of a resource-table read: the gather probe gate (exactly one strong known anchor, the game in
 * front) **and** a main screen — the world map or the city. An open troop panel is refused: the original precheck
 * sends no input at all unless the game is on the main screen (道具 is only reachable from there).
 */
export function inspectResourceProbe(probe: ProbeReport): GatherProbeDecision {
  const decision = inspectGatherProbe(probe);
  if (!decision.ok) return decision;
  if (decision.scene === 'troop-panel') {
    return { ok: false, reason: '部队管理面板开着，读资源统计需要游戏停在城内或世界地图（为安全起见一次都没点）' };
  }
  return decision;
}
