import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { withFileLock } from '@avdm/core';
import {
  BUILTIN_SCRIPT_PREFIX, builtinScriptMetas, fatalIssues, formatIssues, getBuiltinScript, isBuiltinScriptId, scriptMeta,
  validateScript as validateDsl, type ValidateOptions,
} from '@avdm/automation/script';
import type { ScriptDef, ScriptIssue, ScriptMeta } from './types';

const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/;
const MAX_SCRIPT_BYTES = 512 * 1024;

/**
 * Every script is checked before it can reach a device. Fatal issues (wrong shape, duplicate ids / labels,
 * goto out of scope, another app's package, size limits) refuse saving; other errors are saved as a draft and
 * refused at execution; warnings are advice. Old JSON keeps its field names.
 */
export function validateScript(raw: unknown, expectedPackage: string, templateIds?: readonly string[], extra: Omit<ValidateOptions, 'expectedPackage' | 'availableTemplateIds'> = {}): ScriptIssue[] {
  return validateDsl(raw, { expectedPackage, availableTemplateIds: templateIds, ...extra });
}

/** Script documents are game scoped, private, and atomically replaced. Built-in examples are read-only. */
export class ScriptStore {
  constructor(private readonly home: string) { if (!path.isAbsolute(home)) throw new Error('脚本数据目录必须是绝对路径'); }
  private dir(gameId: string): string { if (!ID.test(gameId)) throw new Error('游戏编号无效'); return path.join(this.home, 'automation', 'games', gameId, 'scripts'); }
  private file(gameId: string, id: string): string { if (!ID.test(id)) throw new Error('脚本编号无效'); return path.join(this.dir(gameId), `${id}.json`); }

  /** Built-in examples first, then user scripts by update time. An unreadable file shows as ⚠, never hidden. */
  async list(gameId: string, packageName?: string): Promise<ScriptMeta[]> {
    const builtins = builtinScriptMetas(packageName);
    let files: string[];
    try { files = await readdir(this.dir(gameId)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return builtins; throw error; }
    const out: ScriptMeta[] = [];
    for (const file of files.filter((f) => f.endsWith('.json') && ID.test(f.slice(0, -5)))) {
      const id = file.slice(0, -5);
      if (isBuiltinScriptId(id)) {
        out.push({ id, name: `⚠ 保留前缀的脚本文件：${file}`, version: '0', stepCount: 0, updatedAt: 0, builtin: false,
          description: `以 ${BUILTIN_SCRIPT_PREFIX} 开头的 id 留给内置示例。请把文件改名（连同其中的 id）后再使用。` });
        continue;
      }
      try { out.push(scriptMeta(await this.readUser(gameId, id, packageName))); }
      catch (error) { out.push({ id, name: `⚠ 无法读取：${file}`, version: '0', description: error instanceof Error ? error.message : String(error), stepCount: 0, updatedAt: 0, builtin: false }); }
    }
    return [...builtins, ...out.sort((a, b) => b.updatedAt - a.updatedAt)];
  }

  /** A built-in example (fresh copy) or a user script; a user file must still be a structurally valid script. */
  async get(gameId: string, id: string, packageName?: string): Promise<ScriptDef> {
    const builtin = getBuiltinScript(id, packageName);
    if (builtin) return builtin;
    if (isBuiltinScriptId(id)) throw new Error(`内置脚本不存在：${id}`);
    return this.readUser(gameId, id, packageName);
  }

  private async readUser(gameId: string, id: string, packageName?: string): Promise<ScriptDef> {
    const file = this.file(gameId, id);
    let info;
    try { info = await lstat(file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`脚本不存在：${id}`);
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_SCRIPT_BYTES) throw new Error('脚本文件无效或超过 512 KB');
    let data: unknown;
    try { data = JSON.parse(await readFile(file, 'utf8')); }
    catch { throw new Error(`脚本文件不是合法 JSON：${file}`); }
    if (!data || typeof data !== 'object' || Array.isArray(data) || (data as { id?: unknown }).id !== id) throw new Error('脚本文件 id 不匹配');
    const fatal = fatalIssues(validateDsl(data, { expectedPackage: packageName }));
    if (fatal.length) throw new Error(`脚本文件结构有误，无法使用：\n${formatIssues(fatal)}`);
    return data as ScriptDef;
  }

  /**
   * Save a user script. Fatal (structural) issues refuse it; anything else is saved as is and reported by
   * validation, as in the original. Built-in ids and the `builtin_` prefix are reserved.
   */
  async save(gameId: string, expectedPackage: string, raw: unknown, templateIds?: readonly string[]): Promise<ScriptMeta> {
    const id = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as { id?: unknown }).id : undefined;
    if (typeof id === 'string' && isBuiltinScriptId(id)) {
      throw new Error(`内置脚本不可覆盖：${id}。请用「另存为」改一个不以 ${BUILTIN_SCRIPT_PREFIX} 开头的 id。`);
    }
    const fatal = fatalIssues(validateScript(raw, expectedPackage, templateIds));
    if (fatal.length) throw new Error(`脚本存在结构性错误，无法保存：\n${formatIssues(fatal)}`);
    const script = { ...(raw as ScriptDef), packageName: expectedPackage, updatedAt: Date.now() };
    const json = JSON.stringify(script, null, 2) + '\n';
    if (Buffer.byteLength(json) > MAX_SCRIPT_BYTES) throw new Error('脚本超过 512 KB，请拆分成多个脚本');
    const file = this.file(gameId, script.id);
    await withFileLock(`${file}.lock`, async () => {
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const temp = `${file}.${randomUUID()}.tmp`;
      try {
        const handle = await open(temp, 'wx', 0o600);
        try { await handle.writeFile(json); await handle.sync(); }
        finally { await handle.close(); }
        await rename(temp, file);
        await chmod(file, 0o600);
      } catch (error) { await rm(temp, { force: true }).catch(() => undefined); throw error; }
    });
    return scriptMeta(script);
  }

  async remove(gameId: string, id: string): Promise<void> {
    if (isBuiltinScriptId(id)) throw new Error(`内置脚本不可删除：${id}`);
    const file = this.file(gameId, id);
    await withFileLock(`${file}.lock`, async () => {
      try { await rm(file); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`要删除的脚本不存在：${id}`);
        throw error;
      }
    });
  }
}
