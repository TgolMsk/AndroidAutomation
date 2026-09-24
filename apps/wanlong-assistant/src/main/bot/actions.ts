/**
 * The bot's action layer: implements `BotActionPort` (port of wanlong-panel `src/main/bot/actions.ts`).
 *
 * ★ Electron-free: every capability is an injected port, so the tests run it with fakes.
 * ★ Device actions (shot / resources / relaunch) run inside `deps.exclusive()` = `EtaScheduler.exclusive()`, the same
 *   per-instance lock (and labelled device lease) as samples and dispatch cycles; a script, login or another writer
 *   on the instance refuses it with CONCURRENCY_LIMIT, and that refusal reaches the user unchanged.
 * ★ Resuming (`resumeInstance` → `AlertsService.resume` / `AutomationHost.setSchedule(true)`) samples and takes the
 *   lock, so it is only ever called outside the lock: relaunch is「lock → recoverGame → unlock → resume」.
 * ★ Pause records no statistics event: `SchedulerHooks.onAutoChanged` is the single source of pause/resume facts.
 * ★ This layer never sees the bot token; its Chinese errors can be forwarded to the user as they are.
 */
import type { InstanceQueueState, ResourceSnapshot } from '@avdm/automation/wanlong/pure';
import { renderResourceSnapshotText } from '@avdm/automation/wanlong/pure';
import {
  BOT_ACTION_SPECS, TELEGRAM_CAPTION_MAX, renderAccountList, renderShotCaption, shotFilename, describeInstanceState,
  type BotAccountRow, type BotAction, type BotActionPort, type BotActionResult, type BotInstanceRef,
} from '../../shared/bot';
import { formatCst, formatCstClock } from '../../shared/time';

export type BotLogLevel = 'debug' | 'info' | 'warn' | 'error';

/** A coded Chinese error (the IPC envelope and the channel forward `code` and `message`). */
export class BotActionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'BotActionError';
  }
}

/** An account as the bot needs it (from `AccountManager.list('wanlong')`). */
export interface BotAccountInfo {
  name: string;
  enabled: boolean;
  binding: { index: number; instanceCreatedAt: string } | null;
  /** The login check is done (`login.status === 'ready'`). */
  loginReady: boolean;
}

/** An AVD as the bot needs it (from `AvdManager.list()`; ★ never the whole InstanceState, it carries a gRPC token). */
export interface BotInstanceInfo {
  index: number;
  name: string;
  status: string;
  createdAt: string;
  /** The game's base instance for cloning: never automated, never offered by the bot. */
  base: boolean;
}

/** The part of the scheduler's queue view the texts use. */
export type BotQueueState = Pick<InstanceQueueState,
  'queueUsed' | 'queueTotal' | 'marches' | 'auto' | 'sampling' | 'nextWakeAt' | 'nextWakeReason' | 'lastSampledAt' | 'lastSampleOk' | 'error'>;

export interface BotPauseInfo {
  paused: boolean;
  reason: string | null;
}

/** One screenshot, already a JPEG ≤ BOT_PHOTO_MAX_WIDTH wide. */
export interface BotCaptureResult {
  jpeg: Uint8Array;
  at: number;
  /** Foreground package; null when unreadable. */
  foreground: string | null;
  /** Game process alive (pidof); null when not checked. */
  gameRunning: boolean | null;
}

export interface BotActionDeps {
  now?(): number;
  /** Turns the foreground package into 「游戏」 in captions. */
  gamePackage: string;
  accounts(): Promise<BotAccountInfo[]>;
  instances(): Promise<BotInstanceInfo[]>;
  /** `EtaScheduler.getState` (a read; never registers the instance). */
  schedulerState(index: number): BotQueueState;
  /** The alerts module's pause record (`AlertCenter.pauseInfo`). */
  pauseOf(index: number): BotPauseInfo;
  /** Switch auto off by hand (never takes the lock). */
  pauseInstance(index: number): Promise<unknown>;
  /** Switch auto back on (clears an alert pause first). ★ Takes the lock: only ever called outside `exclusive`. */
  resumeInstance(index: number): Promise<unknown>;
  /** The kicked / network recovery sequence; returns the steps in Chinese. Called inside `exclusive`. */
  recoverGame(index: number, signal?: AbortSignal): Promise<string>;
  /**
   * `EtaScheduler.exclusive(i, what, fn)`: refuses with CONCURRENCY_LIMIT while another writer holds the instance;
   * `signal` aborts when the assistant quits.
   */
  exclusive<T>(index: number, what: string, fn: (ctx: { signal: AbortSignal }) => Promise<T>): Promise<T>;
  /** Capture + JPEG + foreground / process (called inside `exclusive`). */
  captureShot(index: number): Promise<BotCaptureResult>;
  /**
   * Read the in-game resource table (called inside `exclusive`; it navigates, reads and restores the main screen).
   * Unset until the resources module is wired: the action answers that it is not available yet.
   */
  readResources?(index: number): Promise<ResourceSnapshot>;
  /**
   * Record the snapshot in the daily statistics (original `recordStats({kind:'snapshot'})`). Leave unset when
   * `readResources` already records it. A failure only warns.
   */
  recordSnapshot?(index: number, snapshot: ResourceSnapshot): void | Promise<void>;
  /** Today's statistics as text (`renderDailyStatsText` of the stats module). Unset → 「not available yet」. */
  dailyStatsText?(now: number): Promise<string>;
  /** Keep an audit copy of a screenshot; returns its relative path or null. A failure only warns. */
  saveShot?(index: number, jpeg: Uint8Array, at: number): Promise<string | null>;
  log(level: BotLogLevel, message: string): void;
}

// ── Pure helpers (tests call them directly) ─────────────────────────────────

/** A binding is valid only while the same AVD (index + creation identity) still exists. */
function validBinding(account: BotAccountInfo, instances: readonly BotInstanceInfo[]): BotInstanceInfo | null {
  if (!account.binding) return null;
  const { index, instanceCreatedAt } = account.binding;
  return instances.find((item) => item.index === index && item.createdAt === instanceCreatedAt) ?? null;
}

/** Account list rows from accounts + AVDs + scheduler + alerts. */
export function buildAccountRows(
  accounts: readonly BotAccountInfo[],
  instances: readonly BotInstanceInfo[],
  stateOf: (index: number) => BotQueueState,
  pauseOf: (index: number) => BotPauseInfo,
): BotAccountRow[] {
  return accounts.map((account) => {
    const blank = {
      accountName: account.name, enabled: account.enabled, bindingStale: false, loginReady: null, instanceName: null,
      instanceState: null, auto: null, pausedReason: null, lastSampledAt: null, lastSampleOk: null, queueUsed: null, queueTotal: null,
    };
    if (!account.binding) return { ...blank, instanceIndex: null };
    const index = account.binding.index;
    const instance = validBinding(account, instances);
    if (!instance) return { ...blank, instanceIndex: index, bindingStale: true };
    const state = stateOf(index);
    const pause = pauseOf(index);
    const sampled = state.lastSampledAt > 0;
    return {
      ...blank,
      instanceIndex: index,
      loginReady: account.loginReady,
      instanceName: instance.name,
      instanceState: instance.status,
      auto: state.auto,
      pausedReason: pause.paused ? (pause.reason ?? '（无原因）') : null,
      lastSampledAt: sampled ? state.lastSampledAt : null,
      lastSampleOk: sampled ? state.lastSampleOk : null,
      queueUsed: state.queueUsed,
      queueTotal: state.queueTotal,
    };
  });
}

function describeUntil(at: number, now: number): string {
  const ms = at - now;
  if (!Number.isFinite(ms)) return '';
  if (ms <= 0) return '（已到点）';
  const min = Math.round(ms / 60_000);
  return min < 1 ? '（1 分钟内）' : `（约 ${min} 分钟后）`;
}

/**
 * One instance's status text (/status), all times Beijing.
 *
 *   实例 0「主号」
 *     队列 5/5，在途 5 支
 *     自动调度：开
 *     下次唤醒：21:30:00（约 8 分钟后）（队列释放校验）
 *     上次读面板：21:20:11
 *     ⛔ 已暂停：疑似被顶号
 */
export function describeInstanceText(index: number, state: BotQueueState, pause: BotPauseInfo, accountName: string | null, now: number): string {
  const who = accountName ? `「${accountName}」` : '';
  const inFlight = state.marches.filter((march) => march.status !== 'idle').length;
  const lines: string[] = [
    `实例 ${index}${who}`,
    `  队列 ${state.queueUsed ?? '?'}/${state.queueTotal ?? '?'}，在途 ${inFlight} 支`,
    `  自动调度：${state.auto ? '开' : '关'}${state.sampling ? '（采样中）' : ''}`,
    state.nextWakeAt
      ? `  下次唤醒：${formatCstClock(state.nextWakeAt)}${describeUntil(state.nextWakeAt, now)}（${state.nextWakeReason ?? ''}）`
      : '  下次唤醒：未排',
  ];
  if (state.lastSampledAt > 0) lines.push(`  上次读面板：${formatCstClock(state.lastSampledAt)}${state.lastSampleOk ? '' : '（失败）'}`);
  if (pause.paused) lines.push(`  ⛔ 已暂停：${pause.reason ?? '（无原因）'}`);
  if (state.error) lines.push(`  ⚠️ ${state.error}`);
  return lines.join('\n');
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── The action executor ─────────────────────────────────────────────────────

export function createBotActions(deps: BotActionDeps): BotActionPort {
  const now = (): number => (deps.now ? deps.now() : Date.now());

  const accountNameOf = async (index: number): Promise<string | null> => {
    const [accounts, instances] = await Promise.all([deps.accounts(), deps.instances()]);
    return accounts.find((account) => account.binding?.index === index && validBinding(account, instances))?.name ?? null;
  };

  /**
   * Bound accounts (valid bindings only: a recreated AVD at the same index inherits nothing), sorted; the first
   * account wins for an instance bound twice. With nothing bound: every existing non-base instance (the original
   * fell back to MuMu's instance 0).
   */
  const listInstances = async (): Promise<BotInstanceRef[]> => {
    const [accounts, instances] = await Promise.all([deps.accounts(), deps.instances()]);
    const byIndex = new Map<number, string | null>();
    for (const account of accounts) {
      const instance = validBinding(account, instances);
      if (instance && !instance.base && !byIndex.has(instance.index)) byIndex.set(instance.index, account.name);
    }
    if (byIndex.size === 0) {
      return instances.filter((item) => !item.base).map((item) => item.index).sort((a, b) => a - b).map((index) => ({ index, name: null }));
    }
    return [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([index, name]) => ({ index, name }));
  };

  /** Required-index check before any lock or capture: missing or unknown → Chinese error. */
  const requireIndex = async (index: number | null): Promise<number> => {
    if (index === null) throw new BotActionError('INVALID_ARGUMENT', '请先选择账号/实例。');
    const known = (await listInstances()).map((item) => item.index);
    if (!known.includes(index)) throw new BotActionError('NOT_FOUND', `没有这个实例，可用：${known.length > 0 ? known.join(', ') : '（无）'}`);
    return index;
  };

  /** Actions that drive the emulator need it running (checked before the lock, with a clear reason). */
  const requireRunning = async (action: BotAction, index: number): Promise<void> => {
    if (BOT_ACTION_SPECS[action].worksOffline) return;
    const instance = (await deps.instances()).find((item) => item.index === index);
    if (!instance || instance.status !== 'running') {
      const state = instance ? describeInstanceState(instance.status) : '（不存在）';
      throw new BotActionError('DEVICE_NOT_READY', `实例 ${index} 没有在运行${state}，没法${BOT_ACTION_SPECS[action].description}。请先在助手里启动它并等 Android 启动完成。`);
    }
  };

  const statusText = async (index: number, t: number): Promise<string> =>
    describeInstanceText(index, deps.schedulerState(index), deps.pauseOf(index), await accountNameOf(index), t);

  const status = async (index: number | null): Promise<BotActionResult> => {
    const targets = index === null ? (await listInstances()).map((item) => item.index) : [await requireIndex(index)];
    const t = now();
    if (targets.length === 0) return { text: `还没有任何可操作的实例。先到助手「设备与账号」页创建实例并绑定账号。（北京时间 ${formatCstClock(t)}）` };
    const parts: string[] = [];
    for (const i of targets) parts.push(await statusText(i, t));
    return { text: `${parts.join('\n\n')}\n（北京时间 ${formatCstClock(t)}）` };
  };

  const accounts = async (): Promise<BotActionResult> => {
    const [list, instances] = await Promise.all([deps.accounts(), deps.instances()]);
    return { text: renderAccountList(buildAccountRows(list, instances, deps.schedulerState, deps.pauseOf), now()) };
  };

  const pause = async (index: number): Promise<BotActionResult> => {
    // The 「paused」 statistics event comes from the scheduler's onAutoChanged when the switch really flips.
    await deps.pauseInstance(index);
    return { text: `已手动关闭实例 ${index} 的自动调度。需要时发 /resume ${index} 或点「恢复」。` };
  };

  const resume = async (index: number): Promise<BotActionResult> => {
    await deps.resumeInstance(index);
    return { text: `已恢复实例 ${index} 的自动调度。\n${await statusText(index, now())}` };
  };

  const relaunch = async (index: number): Promise<BotActionResult> => {
    // ① The recovery drives the emulator → inside the lock; ② resuming samples and takes the lock → outside.
    const done = await deps.exclusive(index, '重启游戏', ({ signal }) => deps.recoverGame(index, signal));
    try {
      await deps.resumeInstance(index);
    } catch (error) {
      // The game is back; say so instead of hiding the done steps behind 「操作失败」.
      deps.log('warn', `机器人重启游戏后恢复自动调度失败（实例 ${index}）：${messageOf(error)}`);
      return { text: `已处理：${done}。\n⚠️ 恢复自动调度没有成功：${messageOf(error)}\n${await statusText(index, now())}` };
    }
    return { text: `已处理：${done}。\n已恢复实例 ${index} 的自动调度。\n${await statusText(index, now())}` };
  };

  const shot = async (index: number): Promise<BotActionResult> => {
    const cap = await deps.exclusive(index, '截图', () => deps.captureShot(index));
    const accountName = await accountNameOf(index);
    const state = deps.schedulerState(index);
    const pauseState = deps.pauseOf(index);
    const extra = [
      `队列 ${state.queueUsed ?? '?'}/${state.queueTotal ?? '?'}｜自动调度 ${state.auto ? '开' : '关'}`,
      pauseState.paused ? `⛔ 已暂停：${pauseState.reason ?? '（无原因）'}` : '',
    ].filter(Boolean);
    const caption = [
      renderShotCaption({
        instanceIndex: index, accountName, at: cap.at, foreground: cap.foreground, gameRunning: cap.gameRunning, gamePackage: deps.gamePackage,
      }),
      ...extra,
    ].join('\n').slice(0, TELEGRAM_CAPTION_MAX);
    if (deps.saveShot) {
      try {
        const saved = await deps.saveShot(index, cap.jpeg, cap.at);
        if (saved) deps.log('debug', `机器人截图已留痕：${saved}`);
      } catch (error) {
        deps.log('warn', `机器人截图留痕失败（图片照常发出）：${messageOf(error)}`);
      }
    }
    return { text: '', photo: { jpeg: cap.jpeg, caption, filename: shotFilename(index, cap.at) } };
  };

  const resourcesUnavailable = (): BotActionResult =>
    ({ text: `读资源统计还没有接入这一版助手（资源统计模块合并后可用）。（北京时间 ${formatCstClock(now())}）` });

  const resources = async (index: number): Promise<BotActionResult> => {
    const read = deps.readResources;
    if (!read) return resourcesUnavailable();
    await requireRunning('resources', index);
    const snapshot = await deps.exclusive(index, '读资源统计', () => read(index));
    if (deps.recordSnapshot) {
      try { await deps.recordSnapshot(index, snapshot); }
      catch (error) { deps.log('warn', `数据统计记资源快照失败（不影响动作）：${messageOf(error)}`); }
    }
    return { text: renderResourceSnapshotText(snapshot, { accountName: await accountNameOf(index), formatTime: formatCst }) };
  };

  const stats = async (): Promise<BotActionResult> => {
    const t = now();
    if (!deps.dailyStatsText) return { text: `今日统计还没有接入这一版助手（数据统计模块合并后可用）。（北京时间 ${formatCstClock(t)}）` };
    return { text: await deps.dailyStatsText(t) };
  };

  const perform = async (action: BotAction, instanceIndex: number | null): Promise<BotActionResult> => {
    if (!BOT_ACTION_SPECS[action]) throw new BotActionError('INVALID_ARGUMENT', `不认识的机器人动作：${String(action)}`);
    deps.log('info', `机器人动作 ${action}${instanceIndex === null ? '' : `（实例 ${instanceIndex}）`}`);
    switch (action) {
      case 'status': return status(instanceIndex);
      case 'accounts': return accounts();
      case 'stats': return stats();
      case 'menu': return { text: '菜单已刷新。', showMenu: true };
      case 'pause': return pause(await requireIndex(instanceIndex));
      case 'resume': return resume(await requireIndex(instanceIndex));
      case 'relaunch': {
        const index = await requireIndex(instanceIndex);
        await requireRunning(action, index);
        return relaunch(index);
      }
      case 'shot': {
        const index = await requireIndex(instanceIndex);
        await requireRunning(action, index);
        return shot(index);
      }
      case 'resources': return deps.readResources ? resources(await requireIndex(instanceIndex)) : resourcesUnavailable();
      default: {
        // A new BOT_ACTIONS value without an implementation fails to compile here; never turn this into a return.
        const never: never = action;
        throw new BotActionError('INVALID_ARGUMENT', `机器人动作 ${String(never)} 还没有实现。`);
      }
    }
  };

  return { perform, listInstances };
}
