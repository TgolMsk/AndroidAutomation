/**
 * Run insights and notifications as they exist today: daily insight buckets, alert list, per-instance
 * notification settings and the read-only Telegram bot. The stats / alerts / bot modules move or replace these.
 */
import type {
  InsightAlert, InsightDay, NotificationConfigPatch, NotificationConfigView, NotificationTestResult,
  RemoteBotConfigPatch, RemoteBotConfigView, RemoteBotTestResult,
} from '../../main/automation/insights/contracts';
import type { Assert, ListsExactly } from './contract';

export interface InsightsApi {
  insightDays(gameId: string, index: number | null, days?: number): Promise<InsightDay[]>;
  insightAlerts(gameId: string, index: number | null, limit?: number): Promise<InsightAlert[]>;
  getNotificationConfig(gameId: string, index: number): Promise<NotificationConfigView>;
  saveNotificationConfig(gameId: string, index: number, patch: NotificationConfigPatch): Promise<NotificationConfigView>;
  testNotification(gameId: string, index: number, channel: 'local' | 'telegram'): Promise<NotificationTestResult>;
  remoteBotConfig(): Promise<RemoteBotConfigView>;
  saveRemoteBotConfig(patch: RemoteBotConfigPatch): Promise<RemoteBotConfigView>;
  testRemoteBot(): Promise<RemoteBotTestResult>;
}

export const INSIGHTS_METHODS = [
  'insightDays', 'insightAlerts', 'getNotificationConfig', 'saveNotificationConfig', 'testNotification',
  'remoteBotConfig', 'saveRemoteBotConfig', 'testRemoteBot',
] as const satisfies readonly (keyof InsightsApi)[];

/** No push events yet. */
export interface InsightsEvents {}

export const INSIGHTS_EVENTS = [] as const satisfies readonly (keyof InsightsEvents)[];

export type InsightsContractCheck = [
  Assert<ListsExactly<InsightsApi, typeof INSIGHTS_METHODS>>,
  Assert<ListsExactly<InsightsEvents, typeof INSIGHTS_EVENTS>>,
];
