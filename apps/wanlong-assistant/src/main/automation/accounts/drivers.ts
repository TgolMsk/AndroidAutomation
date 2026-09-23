import type { AutomationProbeReport } from '../../../shared/ipc';
import { executeWanlongLoginCommand, type LoginInputDevice } from './native-ui';
import type { AccountLoginCommand, LoginScreen } from './types';

export interface GameLoginDriver {
  /** Optional native login controls; all taps use fresh page nodes. */
  command(device: LoginInputDevice, packageName: string, command: AccountLoginCommand,
    signal: AbortSignal): Promise<LoginScreen>;
  /** Only a verified home scene can enable an account. */
  verifyHome(probe: AutomationProbeReport): { ok: true } | { ok: false; reason: string };
}

const WANLONG_HOME_ANCHORS = new Set([
  'tpl_world_search_icon', 'tpl_nav_map_toggle', 'tpl_nav_map_toggle_b',
]);

const drivers = new Map<string, GameLoginDriver>([
  ['wanlong', {
    command: executeWanlongLoginCommand,
    verifyHome(probe) {
      if (!probe.launchReady) return { ok: false, reason: probe.launchReason };
      if (!probe.matches.some((match) => match.found && WANLONG_HOME_ANCHORS.has(match.templateId))) {
        return { ok: false, reason: '没有识别到城内或世界地图' };
      }
      return { ok: true };
    },
  }],
]);

/** Future games register a native login driver and a read-only home proof here. */
export function gameLoginDriver(gameId: string): GameLoginDriver | undefined {
  return drivers.get(gameId);
}
