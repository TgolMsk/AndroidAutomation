import type { ResourcesApi } from '../../shared/ipc';
import type { ResourcesService } from '../resources/service';
import type { DomainHandlers } from './types';
import { asIndex, game } from './validate';

/** Services the resources handlers need. */
export interface ResourcesServices {
  resources: ResourcesService;
}

/** Only 万龙觉醒 has a resource table reader. */
function resourcesGame(resources: ResourcesService, value: unknown): string {
  const id = game(value);
  if (id !== resources.gameId) throw new Error('该游戏没有资源统计表');
  return id;
}

export const resourcesHandlers: DomainHandlers<ResourcesApi, ResourcesServices> = {
  async resourcesRead({ resources }, gameId, index) {
    resourcesGame(resources, gameId);
    return resources.read(asIndex(index));
  },
  async resourcesReading({ resources }, gameId) {
    resourcesGame(resources, gameId);
    return resources.readingList();
  },
};
