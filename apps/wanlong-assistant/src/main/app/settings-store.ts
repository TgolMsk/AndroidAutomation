import { copyFile, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { defaultAppSettings, mergeAppSettings, parseStoredAppSettings, type AppSettings } from '../../shared/app-settings';
import type { AppSettingsView } from '../../shared/ipc';
import { assertAbsoluteHome, writePrivateFile } from './private-file';

export const APP_SETTINGS_VERSION = 1;
const MAX_SETTINGS_BYTES = 16 * 1024;

export type AppSettingsListener = (settings: AppSettings) => void;

export interface AppSettingsStoreOptions {
  /** Pushed after every successful save (wired to the `app-settings-changed` event). */
  onChange?: (view: AppSettingsView) => void;
  /** Load problems (the file was reset); defaults to console.warn. */
  log?: (message: string) => void;
  now?: () => number;
}

function serialize(settings: AppSettings): string {
  return `${JSON.stringify({ version: APP_SETTINGS_VERSION, ...settings }, null, 2)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * `<AVDM_HOME>/automation/app-settings.json`. A broken file never keeps the assistant from starting: it is copied to
 * `app-settings.json.bad-<时间>` and the defaults are used, with a warning the settings page shows. Saves are serialized,
 * validated before anything is written, atomic (0600) and update memory only after the write succeeded.
 */
export class AppSettingsStore {
  readonly file: string;
  /** Resolves once the file was read (never rejects). */
  readonly ready: Promise<void>;
  private current: AppSettings = defaultAppSettings();
  private warning: string | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<AppSettingsListener>();
  private readonly now: () => number;

  constructor(home: string, private readonly options: AppSettingsStoreOptions = {}) {
    assertAbsoluteHome(home, '应用设置');
    this.file = path.join(home, 'automation', 'app-settings.json');
    this.now = options.now ?? Date.now;
    this.ready = this.serialized(() => this.load());
  }

  /** The settings in effect (the defaults until the file was read). Returns a copy. */
  get(): AppSettings {
    return { ...this.current };
  }

  view(): AppSettingsView {
    return { settings: this.get(), file: this.file, warning: this.warning };
  }

  /** Subscribe to saved changes; returns the unsubscribe function. A throwing listener never breaks a save. */
  onChange(listener: AppSettingsListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Merge `patch` over the saved settings. Invalid input throws a Chinese message and changes nothing. */
  save(patch: unknown): Promise<AppSettingsView> {
    const snapshot = isRecord(patch) ? { ...patch } : patch;
    return this.serialized(async () => {
      const next = mergeAppSettings(this.current, snapshot);
      try {
        await writePrivateFile(this.file, serialize(next));
      } catch (error) {
        throw new Error(`应用设置写入失败：${this.file}。请确认该目录有写权限（${error instanceof Error ? error.message : String(error)}）`, { cause: error });
      }
      this.current = next;
      this.warning = null;
      for (const listener of this.listeners) {
        try { listener(this.get()); }
        catch (error) { this.warn(`应用设置变更回调出错：${error instanceof Error ? error.message : String(error)}`); }
      }
      const view = this.view();
      try { this.options.onChange?.(view); }
      catch { /* A closed window must not fail the save. */ }
      return view;
    });
  }

  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work);
    this.chain = next.then(() => undefined, () => undefined);
    return next;
  }

  private warn(message: string): void {
    try { (this.options.log ?? ((text: string) => console.warn(`[wanlong/settings] ${text}`)))(message); }
    catch { /* Logging must not break loading. */ }
  }

  private async load(): Promise<void> {
    let text: string | null = null;
    try {
      if ((await stat(this.file)).size > MAX_SETTINGS_BYTES) {
        await this.reset(`设置文件超过 ${MAX_SETTINGS_BYTES / 1024} KB`);
        return;
      }
      text = await readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.warning = `设置文件无法读取（${error instanceof Error ? error.message : String(error)}），本次使用默认设置`;
        this.warn(this.warning);
        return;
      }
    }
    if (text === null) {
      // First start: write the defaults so the file can be inspected and edited by hand.
      await this.persistQuietly(this.current);
      return;
    }
    let raw: unknown;
    try { raw = JSON.parse(text); }
    catch { await this.reset('设置文件不是有效的 JSON'); return; }
    if (isRecord(raw) && raw['version'] !== undefined && raw['version'] !== APP_SETTINGS_VERSION) {
      await this.reset(`设置文件版本 ${String(raw['version'])} 与当前助手不兼容`);
      return;
    }
    const { settings, problems } = parseStoredAppSettings(raw);
    if (problems.length > 0) {
      await this.reset(problems.join('；'));
      return;
    }
    this.current = settings;
    // Only rewrite when something was filled in, so a normal start does not touch the file.
    if (serialize(settings) !== text) await this.persistQuietly(settings);
  }

  /** Keep a copy of the bad file, then fall back to the defaults. */
  private async reset(reason: string): Promise<void> {
    this.current = defaultAppSettings();
    const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, '-');
    const backup = `${this.file}.bad-${stamp}`;
    try {
      await copyFile(this.file, backup);
      this.warning = `${reason}，原文件已备份为 ${path.basename(backup)}，已恢复默认设置`;
    } catch {
      this.warning = `${reason}，已恢复默认设置（原文件未能备份，保存设置前请先手动备份）`;
      this.warn(this.warning);
      return; // Do not overwrite a file that could not be backed up.
    }
    this.warn(this.warning);
    await this.persistQuietly(this.current);
  }

  private async persistQuietly(settings: AppSettings): Promise<void> {
    try { await writePrivateFile(this.file, serialize(settings)); }
    catch (error) { this.warn(`应用设置写入失败：${this.file}（${error instanceof Error ? error.message : String(error)}）`); }
  }
}
