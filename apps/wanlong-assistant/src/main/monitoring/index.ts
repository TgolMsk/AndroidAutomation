/**
 * What is left of the earlier read-only monitor: the inbound Telegram bot (`/status`, `/shot <编号>`), which the bot
 * module replaces. Failure / freeze / kicked detection, pauses and notifications moved to `src/main/alerts`.
 */
export { ReadOnlyTelegramBot } from './telegram-readonly';
export type { ReadOnlyBotConfig, ReadOnlyBotPorts, ReadOnlyInstanceStatus } from './telegram-readonly';
