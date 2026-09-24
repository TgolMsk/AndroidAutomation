import type { StatsApi } from '../../shared/ipc';
import { assertDateKey } from '../stats/errors';
import type { StatsService } from '../stats/service';
import type { DomainHandlers } from './types';
import { asIndex, game } from './validate';

/** Services the stats handlers need. */
export interface StatsServices {
  stats: StatsService;
}

/** Statistics are recorded for 万龙觉醒 only; another registered game is refused with a Chinese reason. */
function statsGame(stats: StatsService, value: unknown): string {
  const id = game(value);
  if (id !== stats.gameId) throw new Error('该游戏尚未接入数据统计');
  return id;
}

export const statsHandlers: DomainHandlers<StatsApi, StatsServices> = {
  async statsDaily({ stats }, gameId, dateKey) {
    statsGame(stats, gameId);
    return stats.daily(dateKey === undefined || dateKey === null ? null : assertDateKey(dateKey));
  },
  async statsRange({ stats }, gameId, from, to) {
    statsGame(stats, gameId);
    return stats.range(from, to);
  },
  async statsSnapshotNow({ stats }, gameId, index) {
    statsGame(stats, gameId);
    return stats.snapshotNow(asIndex(index));
  },
};
