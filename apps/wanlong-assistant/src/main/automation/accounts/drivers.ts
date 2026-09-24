import { CITY_TEMPLATES, WORLD_MAP_TEMPLATES } from '@avdm/automation/wanlong';
import { executeWanlongLoginCommand, type LoginInputDevice } from './native-ui';
import type { AccountLoginCommand, HomeVerdict, LoginScreen } from './types';

export interface GameLoginDriver {
  /** Optional native login controls; all taps use fresh page nodes. */
  command(device: LoginInputDevice, packageName: string, command: AccountLoginCommand,
    signal: AbortSignal): Promise<LoginScreen>;
  /**
   * Templates whose hit, each at its own threshold and default ROI, proves the game home screen. Only a verified
   * home scene can enable an account.
   */
  homeTemplates: readonly string[];
}

/**
 * Wanlong's home proof is the original `verifyGameHome`: any city template (map toggle A/B) or world-map template
 * (castle toggle A/B + magnifier). ★ Never the magnifier alone: its lens is translucent and its score drifts with
 * the terrain (0.981 → 0.794), gather iron rule 5.
 */
export const WANLONG_HOME_TEMPLATES: readonly string[] = [...CITY_TEMPLATES, ...WORLD_MAP_TEMPLATES];

const drivers = new Map<string, GameLoginDriver>([
  ['wanlong', { command: executeWanlongLoginCommand, homeTemplates: WANLONG_HOME_TEMPLATES }],
]);

/** Future games register a native login driver and a read-only home proof here. */
export function gameLoginDriver(gameId: string): GameLoginDriver | undefined {
  return drivers.get(gameId);
}

export const HOME_NOT_RECOGNIZED = '尚未识别到游戏主界面。请完成登录并关闭公告、角色选择或其他面板，回到城内或世界地图后再检查。';

/** Any single hit passes (original semantics): no lead or ambiguity rule, unlike the gather probe gate. */
export function decideHome(matches: ReadonlyArray<{ templateId: string; found: boolean; score: number }>): HomeVerdict {
  const hit = matches.filter((match) => match.found).sort((a, b) => b.score - a.score)[0];
  return hit ? { ok: true, templateId: hit.templateId, score: hit.score } : { ok: false, reason: HOME_NOT_RECOGNIZED };
}
