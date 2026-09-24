/**
 * The Telegram bot module (port of wanlong-panel `src/main/bot/` + `src/main/alerts/telegramBot.ts` + the bot wiring
 * of `src/main/index.ts`), replacing this app's earlier read-only bot. See ./README.md.
 *
 *   actions.ts       `createBotActions` — the nine actions, Electron-free, ports injected
 *   telegram-bot.ts  `TelegramBot` — long polling, authorization, permission switches, replies
 *   device.ts        `BotDevice` — screenshot and 「重启游戏」 on the Android Emulator (inside the instance lock)
 *   shots.ts         `BotShotStore` — audit copies of sent screenshots (shot policy applies)
 * Built in `src/main/index.ts` (`// ── bot (Telegram) ──`); the `bot` IPC domain runs the same `BotActionPort`.
 */
import type { MatchResult, RawFrame } from '@avdm/automation';
import type { ResourceSnapshot } from '@avdm/automation/wanlong/pure';
import type { TelegramConfig } from '../../shared/alerts';
import type { ShotPolicy } from '../../shared/app-settings';
import { BOT_PHOTO_JPEG_QUALITY, BOT_PHOTO_MAX_WIDTH, type BotActionPort, type BotStatusView } from '../../shared/bot';
import type { FetchLike } from '../alerts/telegram';
import { LoginPreviewEncoder } from '../automation/accounts/login-preview';
import {
  createBotActions, type BotAccountInfo, type BotActionDeps, type BotInstanceInfo, type BotLogLevel, type BotPauseInfo,
  type BotQueueState,
} from './actions';
import { BotDevice, type BotManagerPort } from './device';
import { BotShotStore } from './shots';
import { TelegramBot } from './telegram-bot';

/**
 * Ports of modules that may be wired after this one (statistics and the resource-table reader). Unset → the bot
 * answers that the feature is not available yet.
 */
export interface BotLatePorts {
  /** Read the in-game resource table (it navigates and restores; the bot calls it inside the instance lock). */
  readResources?(index: number): Promise<ResourceSnapshot>;
  /** Record a snapshot in the daily statistics; leave unset when `readResources` already records it. */
  recordSnapshot?(index: number, snapshot: ResourceSnapshot): void | Promise<void>;
  /** Today's statistics text (`renderDailyStatsText(await stats.daily(), { now, formatClock: formatCstClock })`). */
  dailyStatsText?(now: number): Promise<string>;
}

export interface BotServiceOptions extends BotLatePorts {
  home: string;
  gamePackage: string;
  referenceSize: { width: number; height: number };
  /** ★ Plaintext token: `NotifyHub.currentTelegramConfig()` after `hub.ready`. */
  config(): Promise<TelegramConfig>;
  accounts(): Promise<BotAccountInfo[]>;
  instances(): Promise<BotInstanceInfo[]>;
  schedulerState(index: number): BotQueueState;
  pauseOf(index: number): BotPauseInfo;
  pauseInstance(index: number): Promise<unknown>;
  /** ★ Outside the lock only. */
  resumeInstance(index: number): Promise<unknown>;
  exclusive<T>(index: number, what: string, fn: (ctx: { signal: AbortSignal }) => Promise<T>): Promise<T>;
  /** Lane-bound manager (`deviceHost.get()`). */
  manager(): Promise<BotManagerPort>;
  lane<T>(index: number, work: () => Promise<T>): Promise<T>;
  matchTemplates(index: number, raw: RawFrame, templateIds: string[]): Promise<MatchResult[]>;
  /** App setting: 「不留痕」 keeps no audit copy of bot screenshots. */
  shotPolicy(): ShotPolicy;
  log(level: BotLogLevel, message: string, index?: number): void;
  onStatus?(status: BotStatusView): void;
  fetch?: FetchLike;
  /** Frame → JPEG; defaults to a worker-backed encoder at 1280 px, q70 (DECISIONS A.6: no sharp on main). */
  encode?(frame: RawFrame): Promise<{ jpeg: Uint8Array }>;
  now?(): number;
  sleep?(ms: number, signal?: AbortSignal): Promise<void>;
}

export class BotService {
  readonly actions: BotActionPort;
  readonly channel: TelegramBot;
  readonly shots: BotShotStore;
  readonly device: BotDevice;
  private readonly late: BotLatePorts;
  private readonly encoder: LoginPreviewEncoder | null;

  constructor(options: BotServiceOptions) {
    const { readResources, recordSnapshot, dailyStatsText } = options;
    this.late = {
      ...(readResources ? { readResources } : {}),
      ...(recordSnapshot ? { recordSnapshot } : {}),
      ...(dailyStatsText ? { dailyStatsText } : {}),
    };
    this.shots = new BotShotStore(options.home, options.now);
    this.encoder = options.encode ? null : new LoginPreviewEncoder({ maxWidth: BOT_PHOTO_MAX_WIDTH, quality: BOT_PHOTO_JPEG_QUALITY });
    const encoder = this.encoder;
    this.device = new BotDevice({
      manager: options.manager,
      gamePackage: options.gamePackage,
      referenceSize: options.referenceSize,
      lane: options.lane,
      encode: options.encode ?? ((frame) => encoder!.encode(frame)),
      matchTemplates: options.matchTemplates,
      log: (level, message, index) => options.log(level, message, index),
      ...(options.sleep ? { sleep: options.sleep } : {}),
    });
    const late = this.late;
    const deps: BotActionDeps = {
      ...(options.now ? { now: options.now } : {}),
      gamePackage: options.gamePackage,
      accounts: options.accounts,
      instances: options.instances,
      schedulerState: options.schedulerState,
      pauseOf: options.pauseOf,
      pauseInstance: options.pauseInstance,
      resumeInstance: options.resumeInstance,
      recoverGame: (index, signal) => this.device.recoverGame(index, signal),
      exclusive: options.exclusive,
      captureShot: (index) => this.device.captureShot(index),
      // Read on every call: the statistics / resources module may plug in after construction (`setPorts`).
      get readResources() { return late.readResources; },
      get recordSnapshot() { return late.recordSnapshot; },
      get dailyStatsText() { return late.dailyStatsText; },
      saveShot: async (index, jpeg, at) => (options.shotPolicy() === 'never' ? null : this.shots.save(index, jpeg, at)),
      log: (level, message) => options.log(level, message),
    };
    this.actions = createBotActions(deps);
    this.channel = new TelegramBot({
      config: options.config,
      actions: this.actions,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      log: (level, message) => options.log(level, message),
      ...(options.onStatus ? { onStatus: options.onStatus } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
  }

  /** Wire (or replace) the statistics / resources ports from their own section of `main/index.ts`. */
  setPorts(ports: BotLatePorts): void {
    Object.assign(this.late, ports);
  }

  start(): Promise<boolean> { return this.channel.start(); }
  stop(): Promise<void> { return this.channel.stop(); }
  restart(): Promise<boolean> { return this.channel.restart(); }
  status(): BotStatusView { return this.channel.status(); }
  isRunning(): boolean { return this.channel.isRunning(); }
  testConnection(): Promise<{ ok: boolean; message: string }> { return this.channel.testConnection(); }

  /** Inbound network first (quit): stop polling, then the encoder worker. */
  async dispose(): Promise<void> {
    await this.channel.stop();
    await this.encoder?.dispose();
  }
}

export { BotActionError, buildAccountRows, createBotActions, describeInstanceText } from './actions';
export type { BotAccountInfo, BotActionDeps, BotCaptureResult, BotInstanceInfo, BotPauseInfo, BotQueueState } from './actions';
export { BotDevice } from './device';
export type { BotDevicePort, BotManagerPort } from './device';
export { BotShotStore } from './shots';
export { BotApiError, TelegramBot } from './telegram-bot';
export type { TelegramBotDeps } from './telegram-bot';
