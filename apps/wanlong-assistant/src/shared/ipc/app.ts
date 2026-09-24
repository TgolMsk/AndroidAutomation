/** Assistant application settings, data paths, self-check, logs, toasts and instance occupancy. */
import type { AppSettings } from '../app-settings';
import type { Assert, ListsExactly } from './contract';

/** A background service that failed to start; the rest of the assistant keeps working without it. */
export interface ServiceFailure {
  /** Chinese service name, e.g. 「脚本计划」. */
  name: string;
  /** Error message only, never a stack (a stack or cause could carry a credential-bearing URL). */
  message: string;
  /** What the user loses while it is down, e.g. 「定时脚本不会自动运行」. */
  impact?: string;
  /** Epoch milliseconds of the failure. */
  at: number;
}

/** The saved settings plus where they live and why the file was reset, if it was. */
export interface AppSettingsView {
  settings: AppSettings;
  /** Absolute path of app-settings.json. */
  file: string;
  /** Set when the file on disk was unreadable or invalid at startup and the defaults were used (a backup was kept). */
  warning: string | null;
}

export type HealthLevel = 'ok' | 'warn' | 'fail';

/** One line of the environment self-check. Every failing line says what to do in Chinese. */
export interface HealthItem {
  key: string;
  label: string;
  level: HealthLevel;
  /** `level !== 'fail'`: warnings (optional components, low resolution) do not count as problems. */
  ok: boolean;
  detail: string;
  hint?: string;
  /** `environment` = host / SDK / emulator (shared with `avdm doctor`); `assistant` = this app's own needs. */
  group: 'environment' | 'assistant';
}

export interface HealthReport {
  /** True when no item failed. */
  ok: boolean;
  checkedAt: number;
  durationMs: number;
  items: HealthItem[];
}

export type AppLogLevel = 'debug' | 'info' | 'warn' | 'error';

/** One line of `automation/logs/app.ndjson`. Secrets are scrubbed before the line is written. */
export interface AppLogEntry {
  ts: number;
  level: AppLogLevel;
  /** Where it came from: `main`, `emulator`, `gather`, `scheduler`, `update`, `alerts` … */
  scope: string;
  message: string;
  /** Instance index when the line is about one instance. */
  index?: number;
  data?: Record<string, unknown>;
}

export interface AppLogQuery {
  /** Lowest level to return (default: everything stored). */
  minLevel?: AppLogLevel;
  scope?: string;
  index?: number;
  /** Only entries strictly after this epoch-ms timestamp. */
  since?: number;
  /** Case-insensitive substring of the message. */
  search?: string;
  /** Newest entries kept (default 300, at most 2000). Results are in chronological order. */
  limit?: number;
}

/** Whitelisted data locations the settings page can show and open (the renderer never sends a raw path). */
export type AppPathKey =
  | 'home' | 'automation' | 'appSettings' | 'logs' | 'gatherSettings' | 'gatherState' | 'templates' | 'scripts'
  | 'plans' | 'scriptRuns' | 'gatherShots' | 'monitoringShots' | 'accounts' | 'insights' | 'advisor' | 'scheduler'
  | 'leases' | 'botShots';

export interface AppPathEntry {
  key: AppPathKey;
  label: string;
  path: string;
  kind: 'dir' | 'file';
  description: string;
  exists: boolean;
  /** Set when nothing writes here yet (the feature that will is not wired): why the location may stay empty. */
  pending?: string;
}

/** The template set an instance uses (chosen with 「选择模板集」 or created in the library), for the data page. */
export interface AppTemplateSetEntry {
  index: number;
  /** Null when the instance was deleted but its settings file remains. */
  instanceName: string | null;
  path: string;
  exists: boolean;
  /** Manifest name and template count; null when the set could not be read (`error` says why). */
  name: string | null;
  templates: number | null;
  error?: string;
}

/** A main-process notice for the user (service start failures, self-check problems …). */
export interface AppToast {
  /** Increasing id: the renderer uses it to show each toast once, even when it also reads the recent list. */
  id: number;
  level: 'info' | 'success' | 'warn' | 'error';
  title: string;
  detail?: string;
  at: number;
  /** Page that resolves it (a renderer ViewKey such as `settings`). */
  view?: string;
}

/** Who is using an instance right now, as far as the assistant knows. */
export interface OccupancyHolder {
  index: number;
  /** Chinese activity, e.g. 「运行采集」「进行账号登录」「自动采集已开启」. */
  label: string;
  /** Source that reported it: `access` (occupancy table), `lease` (cross-process lock), `gather`, `plans` … */
  source: string;
  /** False for standing configuration (an enabled schedule) that does not touch the device right now. */
  blocking: boolean;
}

export interface AppApi {
  /**
   * Services that failed to start since launch. `restore()` runs while the window is still loading, so the
   * `service-failures` push can arrive before anyone listens: the renderer reads this once on mount.
   */
  appServiceFailures(): Promise<ServiceFailure[]>;
  appSettings(): Promise<AppSettingsView>;
  /** Validates strictly (unknown keys and out-of-range values are rejected with a Chinese message). */
  saveAppSettings(patch: Partial<AppSettings>): Promise<AppSettingsView>;
  appPaths(gameId: string): Promise<AppPathEntry[]>;
  /** Opens a directory in Finder, or reveals a file (never launches it). */
  openAppPath(gameId: string, key: AppPathKey): Promise<void>;
  /** Each instance's configured template set directory (reveal it with the shell's `revealPath`). */
  appTemplateSets(gameId: string): Promise<AppTemplateSetEntry[]>;
  /**
   * Writes text to the system clipboard from main (the renderer's clipboard permission is denied by the shell).
   * At most 4096 characters.
   */
  appCopyText(text: string): Promise<void>;
  /**
   * 设备工具「安装 APK…」: installs the picked files (`pickApks`) on one running instance, queued on that instance's
   * device lane. Several files are one split app. Returns adb's output.
   */
  appInstallApk(index: number, apkPaths: string[]): Promise<string>;
  /** The latest self-check report without running a new one (null until the first check finished). */
  appHealth(): Promise<HealthReport | null>;
  runAppHealthCheck(): Promise<HealthReport>;
  appLogs(query?: AppLogQuery): Promise<AppLogEntry[]>;
  /** Toasts pushed in the last minutes, for a window that loaded after they were sent. */
  appRecentToasts(): Promise<AppToast[]>;
  /** Activities currently holding (or configured on) the instance; ask the user before stop / restart / remove. */
  instanceOccupancy(index: number): Promise<OccupancyHolder[]>;
}

export const APP_METHODS = [
  'appServiceFailures', 'appSettings', 'saveAppSettings', 'appPaths', 'openAppPath', 'appHealth', 'runAppHealthCheck',
  'appLogs', 'appRecentToasts', 'instanceOccupancy', 'appTemplateSets', 'appCopyText', 'appInstallApk',
] as const satisfies readonly (keyof AppApi)[];

export interface AppEvents {
  /** The complete current list, pushed whenever a service fails to start. */
  'service-failures': ServiceFailure[];
  'app-settings-changed': AppSettingsView;
  'app-health': HealthReport;
  'app-toast': AppToast;
  /** A line that was just persisted to the app log. */
  'app-log': AppLogEntry;
}

export const APP_EVENTS = ['service-failures', 'app-settings-changed', 'app-health', 'app-toast', 'app-log'] as const satisfies readonly (keyof AppEvents)[];

export type AppContractCheck = [
  Assert<ListsExactly<AppApi, typeof APP_METHODS>>,
  Assert<ListsExactly<AppEvents, typeof APP_EVENTS>>,
];
