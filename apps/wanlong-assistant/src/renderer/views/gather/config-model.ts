/**
 * Where a gather config lives and how healthy it is (original features/gather/configStorage.ts +
 * useGatherConfigBadges.ts), over the main process storage:
 *   · an instance with a bound account (identity-checked) reads and saves `Account.scriptParams.gather.configJson`
 *     (`AutomationSettings.configAccount` says whose), so the config follows the account to another instance;
 *   · an instance without one uses its own settings file (`automation/wanlong/<i>.json`), stamped with the AVD it was
 *     saved for (`configReplaced` when the AVD at that index was recreated);
 *   · binding moves the instance copy into an account that has none and clears it (main, AccountManager.bind).
 * Defaults come ONLY from `@avdm/automation/wanlong/pure`; validation is the shared `validateGatherConfig`.
 */
import {
  coerceGatherConfig, hasBlockingIssue, validateGatherConfig, type GatherConfig, type SchedulerConfig,
} from '@avdm/automation/wanlong/pure';
import type { AutomationSettings } from '../../../shared/ipc';

/** `account-broken`: the bound account's copy cannot be parsed, so the form shows defaults (original warning path). */
export type GatherConfigOrigin = 'account' | 'account-broken' | 'instance' | 'default';

/** Where the shown config came from. */
export function configOriginOf(settings: Pick<AutomationSettings, 'config' | 'configAccount' | 'accountConfigError'>): GatherConfigOrigin {
  if (settings.configAccount) return 'account';
  if (settings.accountConfigError) return 'account-broken';
  return Object.keys(settings.config).length > 0 ? 'instance' : 'default';
}

/** 「当前配置来源」 text (original ORIGIN_TEXT, adapted to the account-or-instance storage). */
export function originText(origin: GatherConfigOrigin, settings: Pick<AutomationSettings, 'configAccount'>, index: number): string {
  if (origin === 'account') return `存于绑定账号「${settings.configAccount?.name ?? ''}」（accounts.json，跟着账号走）`;
  if (origin === 'account-broken') return '绑定账号里的那份读不出来，当前显示的是默认配置（保存后覆盖账号里的那份）';
  if (origin === 'instance') return `存于实例 #${index} 的本机设置（未绑定账号）`;
  return '尚未保存过，当前是默认配置';
}

/**
 * The stored copies the page could not read (original configStorage warning): the bound account's gather config and
 * the instance's own settings file. Saving from the page rewrites both; runs refuse until then.
 */
export function storageWarnings(settings: Pick<AutomationSettings, 'accountConfigError' | 'settingsError'> | null): string[] {
  if (!settings) return [];
  const list: string[] = [];
  if (settings.accountConfigError) {
    list.push(`${settings.accountConfigError.replace(/。$/, '')}。下面显示的是默认配置，采集在修好之前不会开跑；核对后点「保存」即可用它覆盖账号里损坏的那份。`);
  }
  if (settings.settingsError) {
    list.push(`实例的本机设置文件读不出来：${settings.settingsError.replace(/。$/, '')}。采集在修好之前不会开跑。`);
  }
  return list;
}

/** Where 「保存」 will write (the drawer's permanent hint). `boundAccount` = the account bound to this AVD, if any. */
export function saveTargetText(boundAccount: string | null, index: number): string {
  return boundAccount
    ? `配置存在账号「${boundAccount}」里，跟着账号走。`
    : `配置存在本机实例 #${index} 的设置里 —— 这个实例还没绑账号，给它绑一个账号后配置会搬进账号、跟着账号走。`;
}

/** The form draft of a saved config: missing fields filled with the single defaults, values kept as saved. */
export function draftOf(settings: Pick<AutomationSettings, 'config'>): GatherConfig {
  return coerceGatherConfig(settings.config);
}

/** The success toast after saving (original SaveResult.message). */
export function savedMessage(saved: Pick<AutomationSettings, 'configAccount'>, index: number, autoWasOn: boolean): string {
  const where = saved.configAccount
    ? `已保存到账号「${saved.configAccount.name}」，随 accounts.json 落盘。`
    : `已保存到实例 #${index} 的本机设置。这个实例还没绑定账号 —— 建议到「账号」页给它绑一个账号，配置才能跟着账号走。`;
  return autoWasOn ? `${where}改了采集配置，自动采集已关闭：核对后请重新开启（会先做一次只读探针）。` : where;
}

export interface GatherConfigBadge {
  /** The master switch (`enabled`) of the config in effect. */
  enabled: boolean;
  /** Whether the instance has a bound account (the config then follows the account). */
  bound: boolean;
  /** Error-level validation issues (they block saving). */
  errors: number;
  /** How loud to be; null = nothing to fix (the entry button gets no dot). */
  tone: 'warning' | 'danger' | null;
  /** One Chinese sentence, used as the tooltip; there is something to say even when everything is fine. */
  text: string;
}

export interface GatherConfigEntry {
  settings?: AutomationSettings;
  /** The settings could not be read (e.g. a corrupt settings file). */
  error?: string;
}

/**
 * The config-health badge of one instance (original describeGatherConfigBadge). Single implementation for the
 * overview header, the card footers and the instance table.
 *
 * ★ A "problem" is an instance that is asked to gather (auto on) but whose config cannot: with auto off the scheduler
 *   never touches it, so only a broken config itself is reported — otherwise the header count could never reach zero
 *   and the badge would become permanent decoration. Unlike the original, an unbound instance is not a problem: the
 *   instance's own config applies without an account.
 */
export function describeGatherConfigBadge(entry: GatherConfigEntry | undefined, autoOn: boolean, bound: boolean): GatherConfigBadge {
  if (!entry?.settings) {
    return {
      enabled: false, bound, errors: 0, tone: entry?.error ? 'danger' : null,
      text: entry?.error ? `采集配置读不出来：${entry.error.replace(/。$/, '')}。打开采集配置核对后点「保存」即可修复。` : '正在读取采集配置…',
    };
  }
  // A copy that cannot be read blocks every run (original: a load failure falls back to defaults and says so).
  const unreadable = entry.settings.accountConfigError ?? entry.settings.settingsError;
  if (unreadable) {
    return {
      enabled: false, bound, errors: 0, tone: 'danger',
      text: `采集配置读不出来：${unreadable.replace(/。$/, '')}。打开采集配置核对后点「保存」即可修复。`,
    };
  }
  const config = draftOf(entry.settings);
  const issues = validateGatherConfig(config);
  const errors = issues.filter((issue) => issue.level === 'error').length;
  const enabled = config.enabled;
  if (hasBlockingIssue(issues)) {
    return { enabled, bound, errors, tone: 'danger', text: `采集配置有 ${errors} 处错误，修好才能保存。点开展开配置。` };
  }
  if (!entry.settings.templateDir) {
    return {
      enabled, bound, errors, tone: autoOn ? 'warning' : null,
      text: autoOn ? '自动调度开着，但这个实例还没选模板集，读不了面板也派不了兵。先到「模板库」为它选一个模板集。'
        : '这个实例还没选模板集。要用它采集的话先到「模板库」选一个。',
    };
  }
  if (entry.settings.configReplaced) {
    // Runs refuse it (never inherited by index alone), so it is a problem even with auto off.
    return {
      enabled, bound, errors, tone: autoOn ? 'danger' : 'warning',
      text: '这份采集配置是这个序号上被删掉的旧实例留下的，采集不会用它（会拒绝开跑）。点开核对后重新保存一次，它才算这个实例自己的配置。',
    };
  }
  if (!enabled) {
    return {
      enabled, bound, errors, tone: autoOn ? 'warning' : null,
      text: autoOn ? '自动调度开着，但采集配置里的总开关是关的，不会派兵。点开打开总开关并保存。'
        : '采集总开关没打开。点开可以配置，配好后再开自动调度。',
    };
  }
  return { enabled, bound, errors, tone: null, text: '采集配置正常。点开可以就地修改。' };
}

export interface SchedulerMismatch {
  key: 'slackSeconds' | 'retryBackoffSeconds' | 'maxBackoffSeconds' | 'calibrateIntervalMin' | 'jitterSeconds' | 'unknownEtaFallbackSeconds';
  label: string;
  here: string;
  there: string;
}

/**
 * The six fields the page's `schedule.*` / `safety.unknownEtaFallbackSeconds` share with the scheduler's own runtime
 * config (original GatherConfigView schedMismatch). The scheduler's copy decides when it wakes, so a difference is
 * shown with a one-click sync.
 */
export function schedulerMismatch(cfg: GatherConfig, sched: SchedulerConfig): SchedulerMismatch[] {
  const diffs: SchedulerMismatch[] = [];
  const sec = (n: number) => `${n} 秒`;
  if (cfg.schedule.slackSeconds !== sched.slackSeconds) {
    diffs.push({ key: 'slackSeconds', label: '唤醒冗余', here: sec(cfg.schedule.slackSeconds), there: sec(sched.slackSeconds) });
  }
  if (cfg.schedule.retryBackoffSeconds.join(',') !== sched.retryBackoffSeconds.join(',')) {
    diffs.push({ key: 'retryBackoffSeconds', label: '退避序列', here: cfg.schedule.retryBackoffSeconds.join(', '), there: sched.retryBackoffSeconds.join(', ') });
  }
  if (cfg.schedule.maxBackoffSeconds !== sched.maxBackoffSeconds) {
    diffs.push({ key: 'maxBackoffSeconds', label: '退避上限', here: sec(cfg.schedule.maxBackoffSeconds), there: sec(sched.maxBackoffSeconds) });
  }
  if (cfg.schedule.calibrateIntervalMin !== sched.calibrateIntervalMin) {
    diffs.push({ key: 'calibrateIntervalMin', label: '兜底校准间隔', here: `${cfg.schedule.calibrateIntervalMin} 分钟`, there: `${sched.calibrateIntervalMin} 分钟` });
  }
  if (cfg.schedule.jitterSeconds !== sched.jitterSeconds) {
    diffs.push({ key: 'jitterSeconds', label: '错峰抖动', here: sec(cfg.schedule.jitterSeconds), there: sec(sched.jitterSeconds) });
  }
  if (cfg.safety.unknownEtaFallbackSeconds !== sched.unknownEtaFallbackSeconds) {
    diffs.push({
      key: 'unknownEtaFallbackSeconds', label: '倒计时读不出时的保守 ETA',
      here: sec(cfg.safety.unknownEtaFallbackSeconds), there: sec(sched.unknownEtaFallbackSeconds),
    });
  }
  return diffs;
}

/** The scheduler patch that makes its copy match the page (「把本页的值同步给调度器」). */
export function schedulerSyncPatch(cfg: GatherConfig): Partial<SchedulerConfig> {
  return {
    slackSeconds: cfg.schedule.slackSeconds,
    retryBackoffSeconds: [...cfg.schedule.retryBackoffSeconds],
    maxBackoffSeconds: cfg.schedule.maxBackoffSeconds,
    calibrateIntervalMin: cfg.schedule.calibrateIntervalMin,
    jitterSeconds: cfg.schedule.jitterSeconds,
    unknownEtaFallbackSeconds: cfg.safety.unknownEtaFallbackSeconds,
  };
}

/** The backoff text box: split on commas (half and full width) and whitespace, keep the integers (original). */
export function parseBackoffText(text: string): number[] {
  return text.split(/[,，\s]+/).map((part) => Number.parseInt(part, 10)).filter((n) => Number.isFinite(n));
}
