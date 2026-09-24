import { appendFile, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LogEntry } from '@avdm/automation/script';
import { MAX_TAIL_BYTES, RunLogStore, splitShotPath } from '../src/main/plans/run-logs';

const GAME = 'wanlong';
const RUN = '00000000-0000-4000-8000-000000000001';
const run = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const entry = (ts: number, extra: Partial<LogEntry> = {}): LogEntry => ({ ts, level: 'info', runId: RUN, instanceIndex: 1, scope: 'engine', message: `m${ts}`, ...extra });

let home: string;
let store: RunLogStore;
beforeEach(async () => { home = await mkdtemp(path.join(tmpdir(), 'wanlong-run-logs-')); store = new RunLogStore(home); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });
const logFile = (runId = RUN): string => path.join(home, 'automation', 'games', GAME, 'runs', runId, 'events.ndjson');

describe('RunLogStore (original store/logs.ts + store/shots.ts)', () => {
  it('serializes appends so concurrent batches never interleave half lines', async () => {
    const long = 'x'.repeat(20_000);
    await Promise.all(Array.from({ length: 40 }, (_v, i) => store.append(GAME, RUN, [entry(i, { message: `${i}:${long}` }), entry(i + 0.5)])));
    const lines = (await readFile(logFile(), 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(80);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    if (process.platform !== 'win32') expect((await stat(logFile())).mode & 0o777).toBe(0o600);
  });

  it('filters by level, time and instance and returns the newest N in time order', async () => {
    await store.append(GAME, RUN, [
      entry(1, { level: 'debug' }), entry(2, { level: 'warn' }), entry(3, { level: 'error', instanceIndex: 2 }), entry(4, { level: 'warn' }), entry(5),
    ]);
    expect((await store.query(GAME, { runId: RUN, minLevel: 'warn' })).map((line) => line.ts)).toEqual([2, 3, 4]);
    expect((await store.query(GAME, { runId: RUN, since: 3 })).map((line) => line.ts)).toEqual([4, 5]);
    expect((await store.query(GAME, { runId: RUN, instanceIndex: 1 })).map((line) => line.ts)).toEqual([1, 2, 4, 5]);
    expect((await store.query(GAME, { runId: RUN, limit: 2 })).map((line) => line.ts)).toEqual([4, 5]);
    expect(await store.query(GAME, { runId: run(99) })).toEqual([]);
  });

  it('skips malformed lines and still reads the older {at, level, stepId, message} lines', async () => {
    await mkdir(path.dirname(logFile()), { recursive: true });
    await writeFile(logFile(), [
      JSON.stringify({ at: 10, level: 'warn', stepId: 'tap-1', message: '旧格式' }),
      '{"ts": 11, "message": "半截',
      'not json',
      JSON.stringify(entry(12)),
    ].join('\n') + '\n');
    const lines = await store.query(GAME, { runId: RUN });
    expect(lines.map((line) => [line.ts, line.message])).toEqual([[10, '旧格式'], [12, 'm12']]);
    expect(lines[0]).toMatchObject({ runId: RUN, stepId: 'tap-1', level: 'warn', scope: 'engine', instanceIndex: null });
  });

  it('reads at most the last 4 MB and drops the half line at the cut', async () => {
    const filler = 'y'.repeat(1000);
    await mkdir(path.dirname(logFile()), { recursive: true });
    const lines: string[] = [];
    for (let i = 0; i < 5000; i++) lines.push(JSON.stringify(entry(i, { message: `${i}-${filler}` })));
    await writeFile(logFile(), lines.join('\n') + '\n');
    expect((await stat(logFile())).size).toBeGreaterThan(MAX_TAIL_BYTES);
    const result = await store.query(GAME, { runId: RUN, limit: 5000 });
    expect(result.length).toBeLessThan(5000);
    expect(result.at(-1)?.ts).toBe(4999);
    expect(result.every((line, i) => i === 0 || line.ts === result[i - 1]!.ts + 1)).toBe(true);
  });

  it('keeps a line whose data cannot be serialized, without the data', async () => {
    const data: Record<string, unknown> = {};
    data.self = data;
    await store.append(GAME, RUN, [entry(1, { data })]);
    const [line] = await store.query(GAME, { runId: RUN });
    expect(line).toMatchObject({ ts: 1, message: 'm1', data: { __serializeFailed: true } });
  });

  it('rejects path traversal in run ids and shot names', async () => {
    await expect(store.append(GAME, '../escape', [entry(1)])).rejects.toThrow('运行 ID 无效');
    await expect(store.query(GAME, { runId: '../../x' })).rejects.toThrow('运行 ID 无效');
    expect(() => splitShotPath(RUN, '../../secret.jpg')).toThrow('截图路径非法');
    expect(() => splitShotPath(RUN, `${RUN}/../x.jpg`)).toThrow();
    expect(() => splitShotPath(RUN, 'a/b/c.jpg')).toThrow('截图路径非法');
    expect(() => splitShotPath(RUN, 'evil.sh')).toThrow('截图文件名非法');
    expect(splitShotPath(RUN, '0001-fail.jpg')).toEqual({ runId: RUN, file: '0001-fail.jpg' });
    expect(splitShotPath('ignored', `${RUN}/0002-ok.jpg`)).toEqual({ runId: RUN, file: '0002-ok.jpg' });
  });

  it('saves shots privately without overwriting and reads them back', async () => {
    const saved = await store.saveShot(GAME, RUN, '0001-fail-a.jpg', new Uint8Array([0xff, 0xd8, 1]));
    expect(saved).toBe(`${RUN}/0001-fail-a.jpg`);
    await expect(store.saveShot(GAME, RUN, '0001-fail-a.jpg', new Uint8Array([1]))).rejects.toThrow();
    expect(Array.from(await store.readShot(GAME, RUN, saved))).toEqual([0xff, 0xd8, 1]);
    expect(await store.listShots(GAME, RUN)).toEqual(['0001-fail-a.jpg']);
    await expect(store.readShot(GAME, RUN, '0009-none.jpg')).rejects.toThrow('截图不存在');
  });

  it('lists runs newest first and prunes to the newest N, never a protected run', async () => {
    for (let i = 1; i <= 5; i++) {
      await store.append(GAME, run(i), [entry(i)]);
      const when = new Date(Date.UTC(2026, 0, 1, 0, i));
      await utimes(logFile(run(i)), when, when);
      await utimes(path.dirname(logFile(run(i))), when, when);
    }
    expect((await store.list(GAME)).map((item) => item.runId)).toEqual([run(5), run(4), run(3), run(2), run(1)]);
    const removed = await store.prune(GAME, 2, new Set([run(1)]));
    expect(removed).toEqual([run(3), run(2)]);
    expect((await store.list(GAME)).map((item) => item.runId)).toEqual([run(5), run(4), run(1)]);
    await store.delete(GAME, run(1));
    expect((await store.list(GAME)).map((item) => item.runId)).toEqual([run(5), run(4)]);
  });

  it('flushed() waits for queued appends', async () => {
    void store.append(GAME, RUN, [entry(1)]);
    void store.append(GAME, RUN, [entry(2)]);
    await store.flushed(GAME, RUN);
    expect((await readFile(logFile(), 'utf8')).trim().split('\n')).toHaveLength(2);
    await appendFile(logFile(), '');
  });
});
