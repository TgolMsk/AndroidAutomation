/**
 * Assistant application settings (`<AVDM_HOME>/automation/app-settings.json`). Pure: main and renderer share this
 * file, so the defaults shown in the form are the defaults main actually uses (original: 「默认值只有一份权威」).
 *
 * Only the original AppSettings fields that still mean something on AVD instances live here. The emulator kind,
 * adb / CLI paths, data directory and reference resolution are gone (core owns the SDK, AVDM_HOME is fixed per
 * process, the reference size comes from the game plugin and each template set). The instance limit and the
 * polling interval map to core settings shared with the desktop manager (`maxRunning`, `healthIntervalSec`).
 */

/** Which screenshots are kept on disk (gather failure scenes, script step shots, alert evidence). */
export type ShotPolicy = 'never' | 'onFail' | 'always';

/** Lowest level written to the persistent app log; warn and error are always kept (packaged apps have no console). */
export type AppLogPersistLevel = 'info' | 'warn';

export interface AppSettings {
  /** Default: only failure scenes are kept (「仅失败时留痕」). */
  shotPolicy: ShotPolicy;
  /** Default hit threshold for script conditions and new templates that do not set their own. */
  matchThreshold: number;
  /** Downsampling factor for script matching (2 = measured sweet spot: 87 ms → 22 ms full-screen match). */
  shrink: number;
  /** Minimum interval between two screencaps of one instance (DeviceLane). */
  minCaptureIntervalMs: number;
  logLevel: AppLogPersistLevel;
  /** Interface language; only Simplified Chinese exists. */
  locale: 'zh-CN';
}

export const SHOT_POLICIES = ['never', 'onFail', 'always'] as const satisfies readonly ShotPolicy[];

export const SHOT_POLICY_LABEL: Readonly<Record<ShotPolicy, string>> = {
  never: '不留痕',
  onFail: '仅失败时留痕（推荐）',
  always: '每步都留痕',
};

export const APP_LOG_PERSIST_LEVELS = ['warn', 'info'] as const satisfies readonly AppLogPersistLevel[];

export const APP_LOG_PERSIST_LABEL: Readonly<Record<AppLogPersistLevel, string>> = {
  warn: '只记警告与错误（推荐）',
  info: '同时记录一般信息',
};

/** Measured on the emulator: screencap throughput tops out around 4.3 frames/s, faster requests only queue. */
export const MIN_CAPTURE_INTERVAL_MS = 400;
export const DEFAULT_MATCH_THRESHOLD = 0.85;
export const DEFAULT_SHRINK = 2;

/** Editable ranges; the settings form uses the same numbers for its inputs. */
export const APP_SETTINGS_RANGE = {
  matchThreshold: { min: 0.5, max: 0.999, step: 0.01 },
  shrink: { min: 1, max: 4, step: 1 },
  minCaptureIntervalMs: { min: 200, max: 5000, step: 50 },
} as const;

export const APP_SETTINGS_KEYS = [
  'shotPolicy', 'matchThreshold', 'shrink', 'minCaptureIntervalMs', 'logLevel', 'locale',
] as const satisfies readonly (keyof AppSettings)[];

/** The only source of default values. */
export function defaultAppSettings(): AppSettings {
  return {
    shotPolicy: 'onFail',
    matchThreshold: DEFAULT_MATCH_THRESHOLD,
    shrink: DEFAULT_SHRINK,
    minCaptureIntervalMs: MIN_CAPTURE_INTERVAL_MS,
    logLevel: 'warn',
    locale: 'zh-CN',
  };
}

const FIELD_LABEL: Readonly<Record<keyof AppSettings, string>> = {
  shotPolicy: '截图留痕策略',
  matchThreshold: '默认命中阈值',
  shrink: '匹配降采样倍率',
  minCaptureIntervalMs: '单实例最小截图间隔',
  logLevel: '日志记录级别',
  locale: '界面语言',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function inRange(value: unknown, range: { min: number; max: number }, integer: boolean): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= range.min && value <= range.max &&
    (!integer || Number.isInteger(value));
}

/** Chinese problem for one field value, or null when it is valid. */
export function appSettingProblem(key: keyof AppSettings, value: unknown): string | null {
  const label = FIELD_LABEL[key];
  switch (key) {
    case 'shotPolicy':
      return SHOT_POLICIES.includes(value as ShotPolicy) ? null : `${label}只能是「不留痕 / 仅失败时留痕 / 每步都留痕」之一`;
    case 'matchThreshold': {
      const r = APP_SETTINGS_RANGE.matchThreshold;
      return inRange(value, r, false) ? null : `${label}必须在 ${r.min} 到 ${r.max} 之间`;
    }
    case 'shrink': {
      const r = APP_SETTINGS_RANGE.shrink;
      return inRange(value, r, true) ? null : `${label}必须是 ${r.min} 到 ${r.max} 的整数`;
    }
    case 'minCaptureIntervalMs': {
      const r = APP_SETTINGS_RANGE.minCaptureIntervalMs;
      return inRange(value, r, true) ? null : `${label}必须是 ${r.min} 到 ${r.max} 毫秒的整数`;
    }
    case 'logLevel':
      return APP_LOG_PERSIST_LEVELS.includes(value as AppLogPersistLevel) ? null : `${label}只能是「只记警告与错误 / 同时记录一般信息」之一`;
    case 'locale':
      return value === 'zh-CN' ? null : `${label}目前只支持简体中文`;
  }
}

/**
 * Settings read from disk. Missing fields take their defaults and unknown keys are ignored; when a present value
 * is invalid the whole object falls back to the defaults (as the original loader did) and `problems` says why.
 */
export function parseStoredAppSettings(raw: unknown): { settings: AppSettings; problems: string[] } {
  const defaults = defaultAppSettings();
  if (!isRecord(raw)) return { settings: defaults, problems: ['设置文件不是 JSON 对象'] };
  const merged: Record<string, unknown> = { ...defaults };
  for (const key of APP_SETTINGS_KEYS) if (key in raw) merged[key] = raw[key];
  const problems = APP_SETTINGS_KEYS.map((key) => appSettingProblem(key, merged[key])).filter((p): p is string => p !== null);
  return problems.length > 0 ? { settings: defaults, problems } : { settings: merged as unknown as AppSettings, problems };
}

/**
 * Apply a renderer patch. Strict: an unknown key or an invalid value throws a Chinese message naming the field, and
 * nothing is changed.
 */
export function mergeAppSettings(current: AppSettings, patch: unknown): AppSettings {
  if (!isRecord(patch)) throw new Error('应用设置无效');
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (!(APP_SETTINGS_KEYS as readonly string[]).includes(key)) throw new Error(`未知的应用设置：${key}`);
    const problem = appSettingProblem(key as keyof AppSettings, value);
    if (problem) throw new Error(problem);
    next[key] = value;
  }
  return next as unknown as AppSettings;
}

/**
 * Whether a screenshot is kept under `policy`. `failure` = a failure scene (gather failure, alert evidence, a failed
 * script step); `process` = routine step evidence; `requested` = a shot the user explicitly asked for (bot /shot,
 * a script `shot` action), which only `never` suppresses.
 */
export function keepShot(policy: ShotPolicy, kind: 'failure' | 'process' | 'requested'): boolean {
  if (policy === 'never') return false;
  if (policy === 'always') return true;
  return kind !== 'process';
}

/** Original AppSettings keys that have no counterpart here, with the reason shown to the user on import. */
const LEGACY_DROPPED: Readonly<Record<string, string>> = {
  emulator: '模拟器种类由多开管理器（AVD）决定',
  adbPath: 'adb 由多开管理器的 SDK 提供',
  mumutoolPath: '模拟器命令行工具由多开管理器的 SDK 提供',
  dataDir: '数据目录固定为 AVDM_HOME',
  refWidth: '参考分辨率由游戏模块与模板集决定',
  refHeight: '参考分辨率由游戏模块与模板集决定',
  maxConcurrentInstances: '同时运行实例上限与多开管理器共用，请在「设置 → 模拟器参数」里手动确认',
  instancePollIntervalMs: '实例状态轮询间隔与多开管理器共用，请在「设置 → 模拟器参数」里手动确认',
};

/**
 * Values worth carrying over from the original panel's `settings.json` (explicit 「导入旧版数据」 only, never
 * automatic): the fields that still exist and are valid here. Everything else is listed in `ignored` with a reason.
 */
export function legacyAppSettingsPatch(raw: unknown): { patch: Partial<AppSettings>; ignored: string[] } {
  if (!isRecord(raw)) return { patch: {}, ignored: ['旧版设置文件不是 JSON 对象'] };
  const patch: Record<string, unknown> = {};
  const ignored: string[] = [];
  for (const [key, value] of Object.entries(raw)) {
    if ((APP_SETTINGS_KEYS as readonly string[]).includes(key)) {
      const problem = appSettingProblem(key as keyof AppSettings, value);
      if (problem) ignored.push(`${key}：${problem}`);
      else patch[key] = value;
    } else if (key in LEGACY_DROPPED) {
      ignored.push(`${key}：${LEGACY_DROPPED[key]}`);
    }
  }
  return { patch: patch as Partial<AppSettings>, ignored };
}
