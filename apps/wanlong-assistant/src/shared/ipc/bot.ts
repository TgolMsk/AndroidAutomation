/** Telegram bot menu actions and the in-panel action tester (port of the original `bot:*` channel group). */
import type { BotAction, BotActionResult, BotInstanceRef, BotStatusView } from '../bot';
import type { Assert, ListsExactly } from './contract';

export type { BotAction, BotActionResult, BotInstanceRef, BotPhoto, BotStatusView } from '../bot';

export interface BotApi {
  /**
   * Run one bot action exactly as a phone button would (the same `BotActionPort`), for the settings page tester.
   * ★ The local tester is not gated by the phone switches (they guard remote access); device actions still take the
   *   instance lock and are refused with CONCURRENCY_LIMIT while a script, login or other writer holds it.
   */
  botPerform(action: BotAction, index: number | null): Promise<BotActionResult>;
  /** Instances the bot offers in its picker. */
  botInstances(): Promise<BotInstanceRef[]>;
  /** Whether the bot polls Telegram right now and which switches it serves. */
  botStatus(): Promise<BotStatusView>;
}

export const BOT_METHODS = ['botPerform', 'botInstances', 'botStatus'] as const satisfies readonly (keyof BotApi)[];

export interface BotEvents {
  /** The bot started, stopped, or polling began / stopped failing. */
  'bot-status': BotStatusView;
}

export const BOT_EVENTS = ['bot-status'] as const satisfies readonly (keyof BotEvents)[];

export type BotContractCheck = [
  Assert<ListsExactly<BotApi, typeof BOT_METHODS>>,
  Assert<ListsExactly<BotEvents, typeof BOT_EVENTS>>,
];
