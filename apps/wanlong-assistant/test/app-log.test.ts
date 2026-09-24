import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppLog, installConsoleCapture, scrubSecrets, splitScope } from '../src/main/app/app-log';
import type { AppLogEntry } from '../src/shared/ipc';

let home: string;
let clock: number;
const quiet = { log: () => undefined, warn: () => undefined, error: () => undefined };

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'avdm-app-log-'));
  clock = 1_000;
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

function makeLog(options: ConstructorParameters<typeof AppLog>[1] = {}): AppLog {
  return new AppLog(home, { console: quiet, now: () => clock++, ...options });
}

async function lines(file: string): Promise<AppLogEntry[]> {
  return (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as AppLogEntry);
}

describe('persistent app log (automation/logs/app.ndjson)', () => {
  it('always persists warnings and errors, never debug, and info only when the settings ask for it', async () => {
    let level: 'warn' | 'info' = 'warn';
    const log = makeLog({ persistLevel: () => level });
    log.debug('gather', '调试');
    log.info('gather', '一般信息');
    log.warn('gather', '警告', undefined, 2);
    log.error('update', '错误');
    level = 'info';
    log.info('gather', '现在记录一般信息');
    await log.flush();
    const entries = await lines(log.file);
    expect(entries.map((entry) => [entry.level, entry.scope, entry.message])).toEqual([
      ['warn', 'gather', '警告'], ['error', 'update', '错误'], ['info', 'gather', '现在记录一般信息'],
    ]);
    expect(entries[0]!.index).toBe(2);
    if (process.platform !== 'win32') expect((await stat(log.file)).mode & 0o777).toBe(0o600);
  });

  it('echoes every line to the console and pushes persisted lines', async () => {
    const out = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const onEntry = vi.fn();
    const log = makeLog({ console: out, onEntry });
    log.debug('scheduler', '只打控制台');
    log.error('scheduler', '出错了', { step: 'G7' }, 1);
    await log.flush();
    expect(out.log).toHaveBeenCalledWith('[scheduler] 只打控制台');
    expect(out.error).toHaveBeenCalledWith('[scheduler] [实例 1] 出错了', { step: 'G7' });
    expect(onEntry).toHaveBeenCalledTimes(1);
    expect(onEntry.mock.calls[0]![0]).toMatchObject({ level: 'error', scope: 'scheduler', message: '出错了', index: 1, data: { step: 'G7' } });
  });

  it('never writes a credential: token URLs, API keys, bearer and key=value secrets, phone numbers, registered secrets', async () => {
    const onEntry = vi.fn();
    const log = makeLog({ onEntry });
    const token = '7234567890:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';
    const secret = 'my-private-apikey-value';
    log.addSecrets(() => [secret, null, '']);
    log.error('bot', `请求失败：https://api.telegram.org/bot${token}/sendMessage`, { url: `https://api.telegram.org/bot${token}/getUpdates` });
    log.warn('ai', `Authorization: Bearer sk-abcdef1234567890 返回 401，apiKey=${secret}`, { headers: { token: 'plain-token-123', password: 'pw123456' } });
    log.warn('login', '手机号 13812345678 登录失败，时间戳 1789360564667 保留');
    await log.flush();
    const text = await readFile(log.file, 'utf8');
    for (const leaked of [token, secret, 'sk-abcdef1234567890', 'plain-token-123', 'pw123456', '13812345678']) expect(text).not.toContain(leaked);
    expect(text).toContain('1789360564667');
    expect(text).toContain('[手机号]');
    for (const [entry] of onEntry.mock.calls as [AppLogEntry][]) expect(JSON.stringify(entry)).not.toContain(token);
    const queried = JSON.stringify(await log.query());
    expect(queried).not.toContain(secret);
  });

  it('limits live pushes during a warning storm but keeps every line on disk', async () => {
    const onEntry = vi.fn();
    const log = makeLog({ onEntry, maxPushesPerSecond: 3, now: () => 5_000 });
    for (let i = 0; i < 10; i++) log.warn('gather', `风暴 ${i}`);
    await log.flush();
    expect(onEntry).toHaveBeenCalledTimes(3);
    expect(await lines(log.file)).toHaveLength(10);
  });

  it('keeps a line whose data cannot be serialized', async () => {
    const log = makeLog();
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    log.warn('main', '循环数据', circular);
    await log.flush();
    expect((await lines(log.file))[0]).toMatchObject({ message: '循环数据', data: { __serializeFailed: true } });
  });

  it('rotates by size, keeps a bounded number of files and queries across them', async () => {
    const log = makeLog({ maxBytes: 400, keepFiles: 2 });
    for (let i = 0; i < 30; i++) log.warn('gather', `第 ${i} 条警告`, undefined, i % 3);
    await log.flush();
    const files = (await readdir(log.dir)).sort();
    expect(files).toEqual(['app.1.ndjson', 'app.2.ndjson', 'app.ndjson']);
    for (const name of files) expect((await stat(path.join(log.dir, name))).size).toBeLessThanOrEqual(400);
    const all = await log.query({ limit: 2000 });
    expect(all.length).toBeGreaterThan(3);
    expect(all.length).toBeLessThan(30); // The oldest rotation was deleted.
    expect(all.at(-1)!.message).toBe('第 29 条警告');
    expect(all.map((entry) => entry.ts)).toEqual([...all.map((entry) => entry.ts)].sort((a, b) => a - b));
  });

  it('filters queries by level, scope, instance, time and text, newest entries in chronological order', async () => {
    const log = makeLog({ persistLevel: () => 'info' });
    log.info('gather', '采集开始', undefined, 0);
    log.warn('gather', '搜索页卡住', undefined, 1);
    log.error('scheduler', '采样失败', undefined, 1);
    log.warn('update', '检查更新失败');
    await log.flush();
    expect((await log.query({ minLevel: 'warn' })).map((entry) => entry.message)).toEqual(['搜索页卡住', '采样失败', '检查更新失败']);
    expect((await log.query({ scope: 'gather' })).map((entry) => entry.message)).toEqual(['采集开始', '搜索页卡住']);
    expect((await log.query({ index: 1 })).map((entry) => entry.message)).toEqual(['搜索页卡住', '采样失败']);
    expect((await log.query({ search: '更新' })).map((entry) => entry.message)).toEqual(['检查更新失败']);
    expect((await log.query({ search: 'SCHED' })).map((entry) => entry.message)).toEqual(['采样失败']);
    const [first] = await log.query();
    expect((await log.query({ since: first!.ts })).length).toBe(3);
    expect((await log.query({ limit: 2 })).map((entry) => entry.message)).toEqual(['采样失败', '检查更新失败']);
  });

  it('skips broken lines and returns nothing for a missing file', async () => {
    const log = makeLog();
    expect(await log.query()).toEqual([]);
    await mkdir(log.dir, { recursive: true });
    await writeFile(log.file, '{"ts":1,"level":"warn","scope":"a","message":"好的"}\n{半截\n{"ts":2,"level":"bogus","scope":"a","message":"坏级别"}\n');
    expect((await log.query()).map((entry) => entry.message)).toEqual(['好的']);
  });

  it('persists console.warn / console.error of the main process once, with the [scope] tag as scope', async () => {
    const printed = vi.fn();
    // The app log echoes through the same (captured) console object, as it does in the main process.
    const target = { log: vi.fn(), warn: vi.fn((...args: unknown[]) => printed(...args)), error: vi.fn((...args: unknown[]) => printed(...args)) };
    const log = makeLog({ console: target });
    const uninstall = installConsoleCapture(log, target as unknown as Console);
    target.warn('[wanlong/bot] 按新配置重启失败', new Error('网络不可用', { cause: new Error('ENOTFOUND') }));
    target.error('没有标签的错误');
    // A line the app log echoes itself goes through the captured console but is persisted only once.
    log.warn('scheduler', '自己打印的行');
    uninstall();
    target.warn('卸载之后不再记录');
    await log.flush();
    const entries = await lines(log.file);
    expect(printed).toHaveBeenCalledWith('[scheduler] 自己打印的行');
    expect(entries.map((entry) => [entry.scope, entry.message])).toEqual([
      ['wanlong/bot', '按新配置重启失败 网络不可用（ENOTFOUND）'],
      ['main', '没有标签的错误'],
      ['scheduler', '自己打印的行'],
    ]);
  });

  it('splits a leading [scope] tag and scrubs without a log instance', () => {
    expect(splitScope('[plan] 计划启动', 'main')).toEqual({ scope: 'plan', message: '计划启动' });
    expect(splitScope('普通文本', 'main')).toEqual({ scope: 'main', message: '普通文本' });
    expect(scrubSecrets('key=abcdefgh token: "xyz12345"')).toBe('key=abcdefgh token: "***"');
  });
});

describe('console capture of Node process warnings', () => {
  it('records "(node:PID) … Warning:" lines as warnings from node, not errors', async () => {
    const home2 = await mkdtemp(path.join(tmpdir(), 'avdm-app-log-node-'));
    try {
      const log = new AppLog(home2, { console: { log: () => undefined, warn: () => undefined, error: () => undefined } });
      const target = { warn: vi.fn(), error: vi.fn() };
      const uninstall = installConsoleCapture(log, target as unknown as Console);
      target.error('(node:1532) [SharpElectronLinux] Warning: Binaries provided by Electron may be incompatible');
      uninstall();
      await log.flush();
      expect(await lines(log.file)).toMatchObject([{ level: 'warn', scope: 'node', message: '[SharpElectronLinux] Warning: Binaries provided by Electron may be incompatible' }]);
    } finally {
      await rm(home2, { recursive: true, force: true });
    }
  });
});
