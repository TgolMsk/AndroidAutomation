import type { AdvisorApi } from '../../shared/ipc';
import type { AdvisorService } from '../automation/advisor';
import { gamePlugin } from '../automation/games';
import type { DomainHandlers } from './types';
import { asIndex, game, patchObject } from './validate';

export interface AdvisorServices {
  advisor: AdvisorService;
}

export const advisorHandlers: DomainHandlers<AdvisorApi, AdvisorServices> = {
  async advisorConfig({ advisor }) { return advisor.config(); },
  async saveAdvisorConfig({ advisor }, patch) {
    return advisor.saveConfig(patchObject(patch, 'AI 设置'));
  },
  async advisorStatus({ advisor }) { return advisor.status(); },
  async advisorHistory({ advisor }, limit) { return advisor.history(limit); },
  async testAdvisor({ advisor }) { return advisor.test(); },
  async consultAdvisor({ advisor }, gameId, index) {
    const id = game(gameId);
    const plugin = gamePlugin(id);
    return advisor.consult({ gameId: id, gameName: plugin.name, packageName: plugin.packageName,
      index: asIndex(index), context: '用户手动查看当前画面' });
  },
};
