import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { withFileLock } from '@avdm/core';
import type { AccountDetails, GameAccount } from './types';

const FILE_VERSION = 1;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_ACCOUNTS = 512;
const GAME_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;
const PACKAGE_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;

interface AccountFile { version: 1; accounts: GameAccount[] }

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function text(value: unknown, label: string, max: number, required: boolean): string {
  if (typeof value !== 'string') throw new Error(`${label}必须是文字`);
  const clean = value.trim();
  if ((required && !clean) || clean.length > max || /[\0\r\n]/.test(clean)) {
    throw new Error(`${label}长度或内容无效`);
  }
  return clean;
}

function details(value: AccountDetails): Required<AccountDetails> {
  if (!record(value)) throw new Error('账号资料无效');
  return {
    name: text(value.name, '账号名称', 100, true),
    server: text(value.server ?? '', '服务器', 100, false),
    role: text(value.role ?? '', '角色名称', 100, false),
    note: text(value.note ?? '', '备注', 1000, false),
  };
}

function parseAccount(value: unknown): GameAccount {
  if (!record(value)) throw new Error('账号记录无效');
  const id = value.id;
  const gameId = value.gameId;
  const packageName = value.packageName;
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id) ||
    typeof gameId !== 'string' || !GAME_ID_RE.test(gameId) ||
    typeof packageName !== 'string' || !PACKAGE_RE.test(packageName)) throw new Error('账号标识无效');
  const binding = value.binding;
  if (binding !== null && (!record(binding) || !Number.isInteger(binding.index) ||
    (binding.index as number) < 0 || (binding.index as number) > 63 ||
    typeof binding.instanceCreatedAt !== 'string' || !binding.instanceCreatedAt)) {
    throw new Error('账号实例绑定无效');
  }
  const login = value.login;
  if (!record(login) || (login.status !== 'pending' && login.status !== 'ready') ||
    (login.attemptId !== null && (typeof login.attemptId !== 'string' || !/^[0-9a-f-]{36}$/i.test(login.attemptId))) ||
    (login.verifiedAt !== null && !validTime(login.verifiedAt)) ||
    (login.status === 'ready' && (binding === null || login.verifiedAt === null))) {
    throw new Error('账号登录状态无效');
  }
  if (typeof value.enabled !== 'boolean' || (value.enabled && login.status !== 'ready') ||
    !validTime(value.createdAt) || !validTime(value.updatedAt)) throw new Error('账号状态无效');
  const names = details({ name: value.name as string, server: value.server as string,
    role: value.role as string, note: value.note as string });
  return {
    id, gameId, packageName, ...names, enabled: value.enabled,
    binding: binding === null ? null : { index: binding.index as number, instanceCreatedAt: binding.instanceCreatedAt as string },
    login: { status: login.status as 'pending' | 'ready', attemptId: login.attemptId as string | null,
      verifiedAt: login.verifiedAt as number | null },
    createdAt: value.createdAt, updatedAt: value.updatedAt,
  };
}

function parseFile(raw: unknown): AccountFile {
  if (!record(raw) || raw.version !== FILE_VERSION || !Array.isArray(raw.accounts) || raw.accounts.length > MAX_ACCOUNTS) {
    throw new Error('账号文件格式不兼容');
  }
  const accounts = raw.accounts.map(parseAccount);
  const ids = new Set<string>();
  const bindings = new Set<string>();
  for (const account of accounts) {
    if (ids.has(account.id)) throw new Error('账号文件存在重复编号');
    ids.add(account.id);
    if (account.binding) {
      const key = `${account.gameId}:${account.binding.index}`;
      if (bindings.has(key)) throw new Error('账号文件存在重复实例绑定');
      bindings.add(key);
    }
  }
  return { version: 1, accounts };
}

/** Cross-process serialized, private, atomic account metadata. Never stores phone or SMS codes. */
export class AccountStore {
  readonly file: string;

  constructor(home: string) {
    if (!path.isAbsolute(home)) throw new Error('账号数据目录必须是绝对路径');
    this.file = path.join(home, 'automation', 'accounts.json');
  }

  private async read(): Promise<AccountFile> {
    let json: string;
    try {
      const metadata = await stat(this.file);
      if (metadata.size > MAX_FILE_BYTES) throw new Error('账号文件超过 512 KB');
      json = await readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, accounts: [] };
      throw error;
    }
    try { return parseFile(JSON.parse(json) as unknown); }
    catch (error) { throw new Error(`账号文件无法读取：${(error as Error).message}`); }
  }

  private async write(data: AccountFile): Promise<void> {
    const valid = parseFile(data);
    const json = JSON.stringify(valid, null, 2) + '\n';
    if (Buffer.byteLength(json) > MAX_FILE_BYTES) throw new Error('账号文件超过 512 KB');
    await mkdir(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temp, 'wx', 0o600);
      try { await handle.writeFile(json); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temp, this.file);
      await chmod(this.file, 0o600);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async change<T>(fn: (data: AccountFile) => Promise<T> | T): Promise<T> {
    return withFileLock(`${this.file}.lock`, async () => {
      const data = await this.read();
      const result = await fn(data);
      await this.write(data);
      return result;
    });
  }

  async list(gameId?: string): Promise<GameAccount[]> {
    if (gameId !== undefined && !GAME_ID_RE.test(gameId)) throw new Error('游戏编号无效');
    const accounts = (await this.read()).accounts;
    return accounts.filter((item) => !gameId || item.gameId === gameId)
      .sort((a, b) => a.createdAt - b.createdAt).map((item) => structuredClone(item));
  }

  async get(id: string): Promise<GameAccount | null> {
    const found = (await this.read()).accounts.find((item) => item.id === id);
    return found ? structuredClone(found) : null;
  }

  async create(gameId: string, packageName: string, input: AccountDetails): Promise<GameAccount> {
    if (!GAME_ID_RE.test(gameId) || !PACKAGE_RE.test(packageName)) throw new Error('游戏标识无效');
    const names = details(input);
    return this.change((data) => {
      if (data.accounts.length >= MAX_ACCOUNTS) throw new Error('账号数量已达上限');
      const now = Date.now();
      const account: GameAccount = {
        id: randomUUID(), gameId, packageName, ...names, enabled: false, binding: null,
        login: { status: 'pending', attemptId: null, verifiedAt: null }, createdAt: now, updatedAt: now,
      };
      data.accounts.push(account);
      return structuredClone(account);
    });
  }

  async update(id: string, patch: Partial<AccountDetails>): Promise<GameAccount> {
    if (!record(patch)) throw new Error('账号资料无效');
    return this.change((data) => {
      const account = data.accounts.find((item) => item.id === id);
      if (!account) throw new Error('账号不存在');
      const next = details({ name: patch.name ?? account.name, server: patch.server ?? account.server,
        role: patch.role ?? account.role, note: patch.note ?? account.note });
      Object.assign(account, next, { updatedAt: Date.now() });
      return structuredClone(account);
    });
  }

  async remove(id: string): Promise<void> {
    await this.change((data) => {
      const i = data.accounts.findIndex((item) => item.id === id);
      if (i < 0) throw new Error('账号不存在');
      data.accounts.splice(i, 1);
    });
  }

  async bind(id: string, binding: GameAccount['binding']): Promise<GameAccount> {
    return this.change((data) => {
      const account = data.accounts.find((item) => item.id === id);
      if (!account) throw new Error('账号不存在');
      if (binding && (!Number.isInteger(binding.index) || binding.index < 0 || binding.index > 63 || !binding.instanceCreatedAt)) {
        throw new Error('实例绑定无效');
      }
      if (binding && data.accounts.some((item) => item.id !== id && item.gameId === account.gameId && item.binding?.index === binding.index)) {
        throw new Error('该游戏的实例已绑定其他账号，请先解除原绑定');
      }
      const changed = account.binding?.index !== binding?.index ||
        account.binding?.instanceCreatedAt !== binding?.instanceCreatedAt;
      account.binding = binding;
      if (changed) {
        account.login = { status: 'pending', attemptId: null, verifiedAt: null };
        account.enabled = false;
      }
      account.updatedAt = Date.now();
      return structuredClone(account);
    });
  }

  async setEnabled(id: string, enabled: boolean): Promise<GameAccount> {
    if (typeof enabled !== 'boolean') throw new Error('启用状态无效');
    return this.change((data) => {
      const account = data.accounts.find((item) => item.id === id);
      if (!account) throw new Error('账号不存在');
      if (enabled && (account.login.status !== 'ready' || !account.binding)) throw new Error('请先完成登录验证');
      account.enabled = enabled;
      account.updatedAt = Date.now();
      return structuredClone(account);
    });
  }

  /** Bind without stealing another account, then mark this login attempt pending. */
  async prepareLogin(id: string, binding: NonNullable<GameAccount['binding']>, attemptId: string): Promise<GameAccount> {
    return this.change((data) => {
      const account = data.accounts.find((item) => item.id === id);
      if (!account) throw new Error('账号不存在');
      if (account.binding && (account.binding.index !== binding.index ||
        account.binding.instanceCreatedAt !== binding.instanceCreatedAt)) {
        throw new Error('该账号已绑定其他实例，请先解除绑定');
      }
      if (data.accounts.some((item) => item.id !== id && item.gameId === account.gameId && item.binding?.index === binding.index)) {
        throw new Error('该实例已绑定其他账号，请先解除原绑定');
      }
      account.binding = binding;
      account.login = { status: 'pending', attemptId, verifiedAt: null };
      account.enabled = false;
      account.updatedAt = Date.now();
      return structuredClone(account);
    });
  }

  /** A stale session or recycled AVD index cannot enable a different account/device. */
  async completeLogin(id: string, binding: NonNullable<GameAccount['binding']>, attemptId: string): Promise<GameAccount> {
    return this.change((data) => {
      const account = data.accounts.find((item) => item.id === id);
      if (!account || account.binding?.index !== binding.index ||
        account.binding.instanceCreatedAt !== binding.instanceCreatedAt ||
        account.login.status !== 'pending' || account.login.attemptId !== attemptId) {
        throw new Error('账号绑定或登录会话已变化，请重新开始登录');
      }
      const now = Date.now();
      account.login = { status: 'ready', attemptId: null, verifiedAt: now };
      account.enabled = true;
      account.updatedAt = now;
      return structuredClone(account);
    });
  }
}
