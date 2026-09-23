import { mkdtemp, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DirWatcher } from '../src/main/fs-watch';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('timeout');
    await sleep(20);
  }
}

/** What core's atomicWriteJson does: write a temp file next to the target and rename it over. */
async function atomicWrite(file: string, text: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${Math.random().toString(16).slice(2, 10)}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, file);
}

describe('DirWatcher', () => {
  let dir: string;
  const watchers: DirWatcher[] = [];
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'avdm-watch-'));
  });
  afterEach(async () => {
    for (const w of watchers.splice(0)) w.close();
    await rm(dir, { recursive: true, force: true });
  });

  const start = async (target: string, filter?: (n: string) => boolean, pollMs = 60_000) => {
    let calls = 0;
    const w = new DirWatcher(target, () => calls++, { filter, debounceMs: 50, pollMs });
    watchers.push(w);
    await w.start();
    return { w, calls: () => calls };
  };

  it('reports an atomic rewrite once with fs.watch and the polling backup', async () => {
    const file = join(dir, 'instances.json');
    await writeFile(file, '{"version":1,"instances":[]}');
    // macOS CI volumes can drop an fs.watch rename notification. A short poll
    // keeps this test about the observable change rather than that OS event.
    const { w, calls } = await start(dir, (n) => n === 'instances.json', 150);
    expect(w.watching).toBe(true);
    await atomicWrite(file, '{"version":1,"instances":[{"index":0}]}');
    await waitFor(() => calls() >= 1, 5000);
    await sleep(300);
    expect(calls()).toBe(1);
    // A second change after the first rename is still seen (a file watch would have gone silent).
    await atomicWrite(file, '{"version":1,"instances":[]}');
    await waitFor(() => calls() >= 2);
  });

  it('ignores files outside the filter (lock dirs, temp files, logs)', async () => {
    const { calls } = await start(dir, (n) => n === 'settings.json');
    await mkdir(join(dir, 'settings.json.lock'));
    await writeFile(join(dir, 'settings.json.123.abcd.tmp'), 'x');
    await writeFile(join(dir, 'instances.json'), '{}');
    await sleep(400);
    expect(calls()).toBe(0);
    await atomicWrite(join(dir, 'settings.json'), '{"maxRunning":12}');
    await waitFor(() => calls() === 1);
  });

  it('reports files appearing and disappearing (run records, discovery files)', async () => {
    const { calls } = await start(dir, (n) => /^instance-\d+\.json$/.test(n));
    await atomicWrite(join(dir, 'instance-3.json'), '{"index":3}');
    await waitFor(() => calls() === 1);
    await rm(join(dir, 'instance-3.json'));
    await waitFor(() => calls() === 2);
  });

  it('falls back to polling for a directory that does not exist yet', async () => {
    const later = join(dir, 'avd', 'running');
    const { w, calls } = await start(later, (n) => /^pid_\d+\.ini$/.test(n), 100);
    expect(w.watching).toBe(false);
    await mkdir(later, { recursive: true });
    await writeFile(join(later, 'pid_4242.ini'), 'avd.id=avdm_0\n');
    await waitFor(() => calls() >= 1);
    // The poll attached fs.watch once the directory existed.
    await waitFor(() => w.watching);
  });

  it('does not call back after close()', async () => {
    const { w, calls } = await start(dir);
    w.close();
    await writeFile(join(dir, 'a'), '1');
    await sleep(300);
    expect(calls()).toBe(0);
  });
});
