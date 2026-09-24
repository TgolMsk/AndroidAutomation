import { isBotAction } from '../../shared/bot';
import type { BotApi } from '../../shared/ipc';
import type { BotService } from '../bot';
import type { DomainHandlers } from './types';
import { optionalIndex } from './validate';

/** Services the bot handlers need (the same service the insights domain restarts on settings changes). */
export interface BotServices {
  remoteBot: BotService;
}

export const botHandlers: DomainHandlers<BotApi, BotServices> = {
  async botPerform({ remoteBot }, action, index) {
    if (!isBotAction(action)) throw new Error('机器人动作无效');
    return remoteBot.actions.perform(action, optionalIndex(index));
  },
  async botInstances({ remoteBot }) {
    return remoteBot.actions.listInstances();
  },
  async botStatus({ remoteBot }) {
    return remoteBot.status();
  },
};
