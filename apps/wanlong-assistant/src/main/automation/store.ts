import { randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdir, open, readFile, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { withFileLock } from '@avdm/core';
import type { AutomationSettings } from '../../shared/ipc';

const STORE_VERSION = 1;
const GAME_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_CONFIG_BYTES = 64 * 1024;

interface StoredSettings extends AutomationSettings {
  version: number;
  configFor?: string;
}

/**
 * The instance file as stored: `configFor` is the AVD identity (`record.createdAt`) the gather config was saved for,
 * so a config left behind by a deleted AVD is flagged instead of silently inherited by a new AVD at the same index
 * (docs/APPLICATIONS.md: never inherit by index alone). Absent in files written before the stamp existed.
 */
export interface StoredAutomationSettings extends AutomationSettings {
  configFor?: string;
}

/** A lenient read: `error` is set (Chinese) when the file exists but cannot be used; `settings` is then a salvage. */
export interface SettingsRead {
  settings: StoredAutomationSettings;
  error?: string;
}

/** How a user repairs a broken instance file (the gather config page's 「保存」 rewrites it). */
const REPAIR_HINT = '打开这个实例的采集配置，核对后点「保存」即可重建（损坏的文件会备份为 .corrupt）';

export interface SaveSettingsOptions {
  /** Identity of the AVD the config in this patch is saved for (ignored without `patch.config`). */
  configFor?: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Per-game, per-instance settings. No game or account data is committed to the repository. */
export class AutomationSettingsStore {
  constructor(readonly home: string) {}

  private fileFor(gameId: string, index: number): string {
    if (!GAME_ID_RE.test(gameId)) throw new Error('游戏包 ID 无效');
    if (!Number.isInteger(index) || index < 0 || index > 63) throw new Error('实例编号无效');
    return path.join(this.home, 'automation', gameId, `${index}.json`);
  }

  async get(gameId: string, index: number): Promise<StoredAutomationSettings> {
    const read = await this.inspect(gameId, index);
    if (read.error) throw new Error(read.error);
    return read.settings;
  }

  /**
   * Lenient read for pages that must still open (and repair) an instance whose file is broken: an unreadable or
   * incompatible file yields `error` (Chinese, with how to fix it) plus empty settings that keep the template set when
   * the file still names one. `get()` is the strict read every run uses.
   */
  async inspect(gameId: string, index: number): Promise<SettingsRead> {
    const file = this.fileFor(gameId, index);
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { settings: { templateDir: '', config: {} } };
      return { settings: { templateDir: '', config: {} }, error: `自动化配置无法读取：${file}（${(err as Error).message}）` };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return { settings: { templateDir: '', config: {} }, error: `自动化配置无法读取：${file}。${REPAIR_HINT}` };
    }
    const salvaged = isRecord(raw) && typeof raw['templateDir'] === 'string' ? raw['templateDir'] : '';
    if (!isRecord(raw) || raw['version'] !== STORE_VERSION || typeof raw['templateDir'] !== 'string' || !isRecord(raw['config'])) {
      return { settings: { templateDir: salvaged, config: {} }, error: `自动化配置格式不兼容：${file}。${REPAIR_HINT}` };
    }
    const configFor = typeof raw['configFor'] === 'string' && raw['configFor'] ? raw['configFor'] : undefined;
    return { settings: { templateDir: raw['templateDir'], config: raw['config'], ...(configFor ? { configFor } : {}) } };
  }

  /**
   * Merge a patch into the instance file. A patch that carries `config` replaces the gather config, so it also
   * repairs a broken file (original configStorage: a failed read falls back to defaults and the next save overwrites
   * it): the broken file is kept as `<i>.json.corrupt` and only a template set it still names survives. A patch without
   * `config` never overwrites a broken file (it could be a newer version's data): it fails with the reason.
   */
  async save(gameId: string, index: number, patch: Partial<AutomationSettings>, options: SaveSettingsOptions = {}): Promise<StoredAutomationSettings> {
    if (!isRecord(patch)) throw new Error('自动化配置补丁无效');
    if ('templateDir' in patch && typeof patch.templateDir !== 'string') throw new Error('模板目录无效');
    if ('config' in patch && !isRecord(patch.config)) throw new Error('自动化参数无效');
    const file = this.fileFor(gameId, index);
    return withFileLock(`${file}.lock`, async () => {
      const read = await this.inspect(gameId, index);
      if (read.error && patch.config === undefined) throw new Error(read.error);
      const current = read.settings;
      let templateDir = patch.templateDir ?? current.templateDir;
      if (templateDir) {
        if (!path.isAbsolute(templateDir)) throw new Error('模板目录必须是绝对路径');
        try {
          templateDir = await realpath(templateDir);
          if (!(await stat(templateDir)).isDirectory()) throw new Error('模板路径不是目录');
        } catch (err) {
          // A template set salvaged from a broken file that no longer exists is dropped rather than blocking the repair.
          if (!read.error || patch.templateDir !== undefined) throw err;
          templateDir = '';
        }
      }
      const config = patch.config ?? current.config;
      // A new config carries the identity it was saved for (none when cleared); a template-only patch keeps the old stamp.
      const configFor = patch.config !== undefined
        ? (Object.keys(patch.config).length > 0 && options.configFor ? options.configFor : undefined)
        : current.configFor;
      const value: StoredSettings = { version: STORE_VERSION, templateDir, config, ...(configFor ? { configFor } : {}) };
      const json = JSON.stringify(value, null, 2) + '\n';
      if (Buffer.byteLength(json) > MAX_CONFIG_BYTES) throw new Error('自动化参数超过 64 KB 上限');
      if (read.error) await copyFile(file, `${file}.corrupt`).catch(() => undefined);
      await writePrivateJson(file, json);
      return { templateDir, config, ...(configFor ? { configFor } : {}) };
    });
  }

  /** Instance indexes that have a settings file for this game (for example to find every instance bound to a set). */
  async indexes(gameId: string): Promise<number[]> {
    const directory = path.dirname(this.fileFor(gameId, 0));
    const names = await readdir(directory).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return [] as string[];
      throw err;
    });
    return names.map((name) => /^(\d{1,2})\.json$/.exec(name)?.[1]).filter((value): value is string => value !== undefined)
      .map(Number).filter((index) => index <= 63).sort((a, b) => a - b);
  }
}

async function writePrivateJson(file: string, json: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(json);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, file);
    await chmod(file, 0o600);
  } catch (err) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw err;
  }
}
