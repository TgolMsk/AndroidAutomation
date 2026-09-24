import type { BotApi } from '../../shared/ipc';
import type { DomainHandlers } from './types';

/** Services the bot handlers need; the module that fills `BotApi` adds them here. */
export interface BotServices {}

export const botHandlers: DomainHandlers<BotApi, BotServices> = {};
