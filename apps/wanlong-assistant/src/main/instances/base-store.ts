import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { withFileLock } from '@avdm/core';
import type { BaseInstanceSelection } from './types';

const FILE_VERSION = 1;
const MAX_FILE_BYTES = 16 * 1024;
const GAME_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseBase(value: unknown): BaseInstanceSelection | null {
  if (value === null) return null;
  if (!record(value) || !Number.isInteger(value.index) || (value.index as number) < 0 || (value.index as number) > 63 ||
    typeof value.name !== 'string' || value.name.length > 200 ||
    typeof value.createdAt !== 'string' || !value.createdAt || value.createdAt.length > 64 ||
    typeof value.setAt !== 'number' || !Number.isSafeInteger(value.setAt) || value.setAt < 0) {
    throw new Error('invalid');
  }
  return { index: value.index as number, name: value.name, createdAt: value.createdAt, setAt: value.setAt };
}

/**
 * `automation/<gameId>/base-instance.json` = {version:1, base:{index,name,createdAt,setAt}|null}. Private, atomic,
 * cross-process locked. ★ A corrupt file is never overwritten: every write reads (and validates) it first.
 */
export class BaseInstanceStore {
  constructor(private readonly home: string) {
    if (!path.isAbsolute(home)) throw new Error('基础实例数据目录必须是绝对路径');
  }

  fileFor(gameId: string): string {
    if (!GAME_ID_RE.test(gameId)) throw new Error('游戏编号无效');
    return path.join(this.home, 'automation', gameId, 'base-instance.json');
  }

  async read(gameId: string): Promise<BaseInstanceSelection | null> {
    const file = this.fileFor(gameId);
    let json: string;
    try {
      if ((await stat(file)).size > MAX_FILE_BYTES) throw new Error('too large');
      json = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      if ((error as Error).message === 'too large') throw new Error(`基础实例设置文件损坏，已保留原文件，请恢复备份：${file}`);
      throw new Error(`无法读取基础实例设置，请检查数据目录权限：${file}`);
    }
    try {
      const raw = JSON.parse(json) as unknown;
      if (!record(raw) || raw.version !== FILE_VERSION || !('base' in raw)) throw new Error('invalid');
      return parseBase(raw.base);
    } catch {
      throw new Error(`基础实例设置文件损坏，已保留原文件，请恢复备份或删除该文件后重新设置：${file}`);
    }
  }

  /**
   * Replace the selection. With `expected`, only when the stored value still equals it (auto-clear must not undo
   * a base the user set in the meantime). Returns whether it wrote.
   */
  async write(gameId: string, base: BaseInstanceSelection | null, expected?: BaseInstanceSelection | null): Promise<boolean> {
    const file = this.fileFor(gameId);
    if (base) parseBase(base);
    return withFileLock(`${file}.lock`, async () => {
      const current = await this.read(gameId);
      if (expected !== undefined && JSON.stringify(current) !== JSON.stringify(expected)) return false;
      const json = JSON.stringify({ version: FILE_VERSION, base }, null, 2) + '\n';
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const temp = `${file}.${randomUUID()}.tmp`;
      try {
        const handle = await open(temp, 'wx', 0o600);
        try { await handle.writeFile(json); await handle.sync(); }
        finally { await handle.close(); }
        await rename(temp, file);
        await chmod(file, 0o600);
      } catch {
        await rm(temp, { force: true }).catch(() => undefined);
        throw new Error('基础实例设置保存失败，原设置未覆盖。');
      }
      return true;
    });
  }
}
