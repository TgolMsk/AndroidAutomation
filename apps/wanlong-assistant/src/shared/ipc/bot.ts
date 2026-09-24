/** Telegram bot menu actions and the in-panel action tester. */
import type { Assert, ListsExactly } from './contract';

/** No methods yet; the bot module adds them here (and to `BOT_METHODS`). */
export interface BotApi {}

export const BOT_METHODS = [] as const satisfies readonly (keyof BotApi)[];

/** No push events yet; the bot module adds them here (and to `BOT_EVENTS`). */
export interface BotEvents {}

export const BOT_EVENTS = [] as const satisfies readonly (keyof BotEvents)[];

export type BotContractCheck = [
  Assert<ListsExactly<BotApi, typeof BOT_METHODS>>,
  Assert<ListsExactly<BotEvents, typeof BOT_EVENTS>>,
];
