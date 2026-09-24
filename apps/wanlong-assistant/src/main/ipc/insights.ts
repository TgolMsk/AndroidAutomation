import type { InsightsApi } from '../../shared/ipc';
import type { AlertsService } from '../alerts';
import type { InsightsService } from '../automation/insights';
import type { BotService } from '../bot';
import type { DomainHandlers } from './types';
import { asIndex, game, optionalIndex, patchObject } from './validate';

export interface InsightsServices {
  insights: InsightsService;
  remoteBot: BotService;
  /** Notification settings are global alerts settings now; these methods stay for compatibility. */
  alerts: AlertsService;
}

/**
 * The save already queued a reload (`onConfigChanged`); this waits for it (same serialized lifecycle, and a second
 * reload of unchanged settings is a no-op) so the returned `running` is current.
 */
async function reloadBot(remoteBot: BotService): Promise<void> {
  await remoteBot.reload().catch((error: unknown) =>
    console.warn('[wanlong] 机器人重载失败', error instanceof Error ? error.message : String(error)));
}

export const insightsHandlers: DomainHandlers<InsightsApi, InsightsServices> = {
  async insightDays({ insights }, gameId, index, days) {
    return insights.days(game(gameId), optionalIndex(index), days);
  },
  async insightAlerts({ insights }, gameId, index, limit) {
    return insights.alerts(game(gameId), optionalIndex(index), limit);
  },
  async getNotificationConfig({ alerts }, gameId, index) {
    return alerts.hub.legacyNotificationView(game(gameId), asIndex(index));
  },
  async saveNotificationConfig({ alerts, remoteBot }, gameId, index, patch) {
    const saved = await alerts.hub.saveLegacyNotification(game(gameId), asIndex(index), patchObject(patch, '通知设置'));
    await reloadBot(remoteBot);
    return saved;
  },
  async testNotification({ alerts }, gameId, index, channel) {
    game(gameId);
    asIndex(index);
    if (channel !== 'local' && channel !== 'telegram') throw new Error('通知渠道无效');
    return alerts.hub.legacyTest(channel);
  },
  async remoteBotConfig({ alerts, remoteBot }) {
    return alerts.hub.remoteBotConfig(remoteBot.isRunning());
  },
  async saveRemoteBotConfig({ alerts, remoteBot }, patch) {
    await alerts.hub.saveRemoteBotConfig(patchObject(patch, '机器人设置'));
    await reloadBot(remoteBot);
    return alerts.hub.remoteBotConfig(remoteBot.isRunning());
  },
  async testRemoteBot({ remoteBot }) { return remoteBot.testConnection(); },
};
