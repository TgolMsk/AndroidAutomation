/**
 * IPC contract between the Electron main process (owns AvdManager) and renderers.
 * Renderer calls `window.avdm.<method>(...)` → preload → ipcRenderer.invoke(`avdm:<method>`, ...args)
 * → main handler. Main pushes events with webContents.send('avdm:event', { channel, payload }).
 * Keep this file free of runtime imports (types only) so it can be used by main, preload and renderer.
 */
import type {
  CloneOptions,
  CreateOptions,
  HostStats,
  InstallProgress,
  InstanceRecord,
  InstanceSpec,
  InstanceState,
  KeyEventType,
  RemotePackage,
  ScriptManifest,
  ScriptRunInfo,
  SdkInfo,
  SdkInstallPlan,
  Settings,
  StartOptions,
  StopOptions,
  TouchPoint,
  UpdateOptions,
} from '@avdm/core';

export type BatchResult<T = void> =
  | { index: number; ok: true; value: T }
  | { index: number; ok: false; error: string };

export interface ThumbnailFrame {
  index: number;
  /** PNG bytes */
  png: Uint8Array;
  width: number;
  height: number;
  at: number;
}

export interface LiveFrame {
  index: number;
  /** Raw pixels (format rgb888 or rgba8888) or PNG bytes. */
  data: Uint8Array;
  format: 'png' | 'rgba8888' | 'rgb888';
  /** Size of `data` image. */
  width: number;
  height: number;
  /** Device display size in pixels (touch coordinate space). */
  deviceWidth: number;
  deviceHeight: number;
  /**
   * Quarter turns (counter-clockwise) the view applies to show `data` upright. Frames stay panel-native when
   * Android rotates (e.g. a landscape game on a portrait panel), so the view rotates the image and maps
   * pointer positions back to panel coordinates (the space gRPC sendTouch uses).
   */
  rotation?: DisplayRotation;
  seq?: number;
}

/** Settings update: only the keys being changed; defaultSpec may be partial (merged field by field). */
export type SettingsPatch = Omit<Partial<Settings>, 'defaultSpec'> & { defaultSpec?: Partial<InstanceSpec> };

/** Android display rotation in quarter turns (Surface.ROTATION_0/90/180/270). */
export type DisplayRotation = 0 | 1 | 2 | 3;

/** State of the SDK install running in the main process (survives renderer reloads / closed windows). */
export interface SdkInstallStatus {
  /** Package paths being installed. */
  packages: string[];
  /** Plan computed when the install started (for the wizard's progress view). */
  plan: SdkInstallPlan;
  /** Latest progress per package path. */
  progress: Record<string, InstallProgress>;
  cancelling: boolean;
}

export interface LogEntry {
  level: 'info' | 'warn' | 'error';
  message: string;
  index?: number;
  at: string;
}

/** Event channel → payload. */
export interface AvdmEvents {
  'instance-state': InstanceState;
  'instances-changed': null;
  'thumbnail': ThumbnailFrame;
  'live-frame': LiveFrame;
  'live-ended': { index: number; error?: string };
  /** State of the window receiving the event changed (e.g. always-on-top toggled from the menu). */
  'window-state': { alwaysOnTop: boolean };
  /** settings.json changed on disk (e.g. `avdm settings set` from the CLI). */
  'settings-changed': null;
  'sdk-progress': InstallProgress;
  'script-run': ScriptRunInfo;
  'script-output': { runId: string; line: string };
  'log': LogEntry;
  /** The app bundle on disk was rebuilt after this process started: the running client is outdated. */
  'app-outdated': { builtAt: number };
}

export type AvdmEventChannel = keyof AvdmEvents;

export interface AvdmApi {
  // ── state / settings / host ──
  listInstances(): Promise<InstanceState[]>;
  hostStats(): Promise<HostStats>;
  getSettings(): Promise<Settings>;
  /** Send only changed keys: core merges the patch over settings.json, so untouched keys keep concurrent edits. */
  updateSettings(patch: SettingsPatch): Promise<Settings>;
  appInfo(): Promise<{ version: string; home: string; platform: string; arch: string }>;
  /** Restart the client (emulators keep running). Main window only. */
  relaunchApp(): Promise<void>;

  // ── SDK ──
  getSdk(): Promise<SdkInfo>;
  refreshSdk(): Promise<SdkInfo>;
  /** arm64-v8a system images from the Google catalog (stable). */
  listRemoteImages(): Promise<RemotePackage[]>;
  planSdkInstall(pkgPaths: string[]): Promise<SdkInstallPlan>;
  /**
   * Only called after the user ticked "I accept" for the shown license texts. `shownTexts` (id → the text the
   * wizard displayed, i.e. plan.licenses) makes core refuse if the repository text differs from what was read.
   */
  acceptLicenses(licenseIds: string[], shownTexts?: Record<string, string>): Promise<void>;
  /**
   * Runs the install in the main process. Calling it again with the same package set while that install is
   * running joins it (e.g. after a renderer reload); a different set is rejected.
   */
  installSdk(pkgPaths: string[]): Promise<void>;
  cancelSdkInstall(): Promise<void>;
  /** The install currently running in the main process, or null. */
  sdkInstallStatus(): Promise<SdkInstallStatus | null>;

  // ── lifecycle ──
  create(opts: CreateOptions): Promise<InstanceRecord[]>;
  clone(sourceIndex: number, opts: CloneOptions): Promise<InstanceRecord[]>;
  update(index: number, opts: UpdateOptions): Promise<InstanceRecord>;
  remove(indices: number[], force?: boolean): Promise<BatchResult[]>;
  start(indices: number[], opts?: StartOptions): Promise<BatchResult[]>;
  stop(indices: number[], opts?: StopOptions): Promise<BatchResult[]>;
  restart(indices: number[]): Promise<BatchResult[]>;

  // ── device ops ──
  /** Opens a native file dialog (multi-select .apk/.apks/.xapk). */
  pickApks(): Promise<string[]>;
  installApk(indices: number[], apkPaths: string[]): Promise<BatchResult<string>[]>;
  shell(indices: number[], command: string): Promise<BatchResult<string>[]>;
  startApp(indices: number[], pkg: string): Promise<BatchResult[]>;
  stopApp(indices: number[], pkg: string): Promise<BatchResult[]>;
  listPackages(index: number): Promise<string[]>;
  /** Saves a full-size PNG under ~/Pictures/avdm/ and returns the path. */
  saveScreenshot(index: number): Promise<string>;
  openScrcpy(index: number): Promise<void>;
  /** Opens (or focuses) the live control window for an instance. */
  openLiveView(index: number): Promise<void>;
  instanceLog(index: number, lines?: number): Promise<string[]>;
  revealPath(path: string): Promise<void>;

  // ── thumbnails: main polls gRPC screenshots for the given indices and pushes 'thumbnail' events ──
  setThumbnailSubscription(indices: number[], opts?: { width?: number; intervalMs?: number }): Promise<void>;

  // ── live view (used by the live window) ──
  liveStart(index: number, opts?: { maxWidth?: number }): Promise<{ deviceWidth: number; deviceHeight: number }>;
  liveStop(index: number): Promise<void>;
  /** Touch in device display pixels. */
  liveTouch(index: number, touches: TouchPoint[]): Promise<void>;
  liveKey(index: number, input: { key?: string; text?: string; eventType?: KeyEventType }): Promise<void>;
  /** Always-on-top of the calling window: sets it when `on` is a boolean, returns the resulting state. */
  alwaysOnTop(on?: boolean): Promise<boolean>;

  // ── scripts ──
  listScripts(): Promise<ScriptManifest[]>;
  runScript(scriptId: string, indices: number[], args?: string[]): Promise<ScriptRunInfo[]>;
  stopScript(runId: string): Promise<void>;
  listScriptRuns(): Promise<ScriptRunInfo[]>;
  createExampleScript(): Promise<ScriptManifest>;
  openScriptsDir(): Promise<void>;

  // ── events ──
  on<C extends AvdmEventChannel>(channel: C, listener: (payload: AvdmEvents[C]) => void): () => void;
}

/** Methods invoked through ipcRenderer.invoke (everything except `on`). */
export type AvdmInvokeMethod = Exclude<keyof AvdmApi, 'on'>;

/**
 * Methods a live-view window may call. Everything else (settings, SDK install, create/remove, scripts, …)
 * is only accepted from the main window.
 */
export const LIVE_WINDOW_METHODS: ReadonlySet<AvdmInvokeMethod> = new Set<AvdmInvokeMethod>([
  'listInstances', 'hostStats', 'appInfo',
  'liveStart', 'liveStop', 'liveTouch', 'liveKey', 'alwaysOnTop',
  'saveScreenshot', 'revealPath',
]);

export const INVOKE_METHODS: AvdmInvokeMethod[] = [
  'listInstances', 'hostStats', 'getSettings', 'updateSettings', 'appInfo', 'relaunchApp',
  'getSdk', 'refreshSdk', 'listRemoteImages', 'planSdkInstall', 'acceptLicenses', 'installSdk', 'cancelSdkInstall',
  'sdkInstallStatus',
  'create', 'clone', 'update', 'remove', 'start', 'stop', 'restart',
  'pickApks', 'installApk', 'shell', 'startApp', 'stopApp', 'listPackages', 'saveScreenshot', 'openScrcpy',
  'openLiveView', 'instanceLog', 'revealPath',
  'setThumbnailSubscription',
  'liveStart', 'liveStop', 'liveTouch', 'liveKey', 'alwaysOnTop',
  'listScripts', 'runScript', 'stopScript', 'listScriptRuns', 'createExampleScript', 'openScriptsDir',
];

export const EVENT_CHANNEL = 'avdm:event';
export const invokeChannel = (m: AvdmInvokeMethod) => `avdm:${m}`;
