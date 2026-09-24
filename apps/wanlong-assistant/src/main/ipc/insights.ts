import type { InsightsApi } from '../../shared/ipc';
import type { InsightsService } from '../automation/insights';
import type { ReadOnlyTelegramBot } from '../monitoring';
import type { DomainHandlers } from './types';
import { asIndex, game, optionalIndex, patchObject } from './validate';

export interface InsightsServices {
  insights: InsightsService;
  remoteBot: ReadOnlyTelegramBot;
}

async function reloadBot(remoteBot: ReadOnlyTelegramBot): Promise<void> {
  await remoteBot.restart().catch((error: unknown) =>
    console.warn('[wanlong] 只读机器人重载失败', error instanceof Error ? error.message : String(error)));
}

export const insightsHandlers: DomainHandlers<InsightsApi, InsightsServices> = {
  async insightDays({ insights }, gameId, index, days) {
    return insights.days(game(gameId), optionalIndex(index), days);
  },
  async insightAlerts({ insights }, gameId, index, limit) {
    return insights.alerts(game(gameId), optionalIndex(index), limit);
  },
  async getNotificationConfig({ insights }, gameId, index) {
    return insights.config(game(gameId), asIndex(index));
  },
  async saveNotificationConfig({ insights, remoteBot }, gameId, index, patch) {
    const saved = await insights.saveConfig(game(gameId), asIndex(index), patchObject(patch, '通知设置'));
    await reloadBot(remoteBot);
    return saved;
  },
  async testNotification({ insights }, gameId, index, channel) {
    if (channel !== 'local' && channel !== 'telegram') throw new Error('通知渠道无效');
    return insights.test(game(gameId), asIndex(index), channel);
  },
  async remoteBotConfig({ insights, remoteBot }) {
    return insights.remoteBotConfig(remoteBot.isRunning());
  },
  async saveRemoteBotConfig({ insights, remoteBot }, patch) {
    await insights.saveRemoteBotConfig(patchObject(patch, '只读机器人设置'));
    await reloadBot(remoteBot);
    return insights.remoteBotConfig(remoteBot.isRunning());
  },
  async testRemoteBot({ remoteBot }) { return remoteBot.testConnection(); },
};
