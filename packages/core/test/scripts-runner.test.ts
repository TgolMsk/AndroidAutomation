import { spawnSync } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isAvdmError } from '../src/errors.js';
import { resolvePaths } from '../src/paths.js';
import { EXAMPLE_SCRIPT_ID, LineSplitter, ScriptRunner, makeRunId, type ScriptTarget } from '../src/scripts.js';
import type { ManagerPaths, ScriptRunInfo } from '../src/types.js';

/**
 * ScriptRunner on its own: script dirs in a temp AVDM_HOME, node scripts as plugins, fake targets
 * (no emulator needed — the runner only passes the target's serial/ports as env vars).
 */

let tmp: string;
let paths: ManagerPaths;
let runner: ScriptRunner;
let output: Array<{ runId: string; line: string }>;
let runEvents: ScriptRunInfo[];

const target = (index: number, extra: Partial<ScriptTarget> = {}): ScriptTarget => ({
  index,
  name: `实例-${index}`,
  serial: `emulator-${5554 + 2 * index}`,
  consolePort: 5554 + 2 * index,
  adbPort: 5555 + 2 * index,
  grpcPort: 8554 + index,
  ...extra,
});

async function writeScript(id: string, manifest: unknown, files: Record<string, string> = {}): Promise<string> {
  const dir = path.join(paths.scriptsDir, id);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(
    path.join(dir, 'script.json'),
    typeof manifest === 'string' ? manifest : JSON.stringify(manifest, null, 2),
  );
  for (const [name, content] of Object.entries(files)) await fsp.writeFile(path.join(dir, name), content);
  return dir;
}

/** Resolve once the final 'script-run' event of every run id has arrived. */
function finals(runIds: string[], timeoutMs = 15_000): Promise<Map<string, ScriptRunInfo>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`runs did not finish: ${runIds.join(', ')}`)), timeoutMs);
    const check = () => {
      const done = new Map<string, ScriptRunInfo>();
      for (const e of runEvents) if (runIds.includes(e.runId) && e.status !== 'running') done.set(e.runId, e);
      if (done.size === runIds.length) {
        clearTimeout(timer);
        clearInterval(poll);
        resolve(done);
      }
    };
    const poll = setInterval(check, 20);
    check();
  });
}

function linesOf(runId: string): string[] {
  return output.filter((o) => o.runId === runId).map((o) => o.line);
}

function alive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'avdm-scripts-'));
  paths = resolvePaths(tmp);
  output = [];
  runEvents = [];
  runner = new ScriptRunner(
    paths,
    { adbBin: '/opt/fake-sdk/platform-tools/adb', sdkRoot: '/opt/fake-sdk' },
    {
      onRun: (r) => runEvents.push(r),
      onOutput: (runId, line) => output.push({ runId, line }),
    },
  );
});

afterEach(async () => {
  await runner.stopAll();
  await fsp.rm(tmp, { recursive: true, force: true });
});


describe('listScripts', () => {
  it('returns [] when the scripts dir does not exist', async () => {
    expect(await runner.listScripts()).toEqual([]);
  });

  it('loads valid manifests sorted by name and skips invalid ones', async () => {
    await writeScript('b-script', { name: 'B 脚本', command: ['node', 'b.js'], env: { FOO: 'bar', N: 3 } });
    await writeScript('a-script', { name: 'A 脚本', description: ' 说明 ', command: ['python3', 'main.py'] });
    await writeScript('no-name', { command: ['sh', 'run.sh'] });
    await writeScript('bad-json', '{ not json');
    await writeScript('no-command', { name: 'x' });
    await writeScript('empty-command', { name: 'x', command: [] });
    await writeScript('bad-env', { name: 'x', command: ['a'], env: { A: { nested: true } } });
    await fsp.mkdir(path.join(paths.scriptsDir, 'no-manifest'), { recursive: true });
    await fsp.mkdir(path.join(paths.scriptsDir, '.hidden'), { recursive: true });
    await fsp.writeFile(path.join(paths.scriptsDir, '.hidden', 'script.json'), '{"name":"h","command":["x"]}');
    await fsp.writeFile(path.join(paths.scriptsDir, 'loose-file.json'), '{}');

    const list = await runner.listScripts();
    expect(list.map((s) => s.id)).toEqual(['a-script', 'b-script', 'no-name']);
    const [a, b, n] = list;
    expect(a).toEqual({
      id: 'a-script',
      name: 'A 脚本',
      description: '说明',
      command: ['python3', 'main.py'],
      dir: path.join(paths.scriptsDir, 'a-script'),
    });
    expect(b!.env).toEqual({ FOO: 'bar', N: '3' });
    expect(n!.name).toBe('no-name'); // name defaults to the directory name
  });
});

describe('run', () => {
  const ENV_DUMP = `
const keys = ['ANDROID_SERIAL','AVDM_INDEX','AVDM_NAME','AVDM_CONSOLE_PORT','AVDM_ADB_PORT','AVDM_GRPC_PORT',
  'AVDM_GRPC_TOKEN','AVDM_ADB','ANDROID_SDK_ROOT','AVDM_HOME','PYTHONUNBUFFERED','CUSTOM'];
for (const k of keys) console.log(k + '=' + (process.env[k] ?? '<unset>'));
console.log('CWD=' + process.cwd());
console.log('ARGS=' + JSON.stringify(process.argv.slice(2)));
console.log('PATH0=' + process.env.PATH.split(':')[0]);
console.error('这是标准错误输出');
process.stdout.write('没有换行的最后一行');
process.exitCode = Number(process.env.AVDM_INDEX) === 1 ? 3 : 0;
`;

  it('starts one process per target with the documented env, args and line-split output', async () => {
    await writeScript('dump', { name: 'Dump', command: [process.execPath, 'main.mjs'], env: { CUSTOM: 'yes', AVDM_INDEX: 'no' } }, {
      'main.mjs': ENV_DUMP,
    });
    const runs = await runner.run('dump', [target(0, { grpcToken: 'tok' }), target(1)], ['--flag', 'a b']);
    expect(runs).toHaveLength(2);
    for (const r of runs) {
      expect(r.status).toBe('running');
      expect(r.pid).toBeGreaterThan(0);
      expect(r.scriptId).toBe('dump');
      expect(r.runId).toMatch(/^dump-[01]-\d{14}-[0-9a-f]{4}$/);
      expect(r.logFile).toBe(path.join(paths.scriptLogsDir, `${r.runId}.log`));
    }
    const done = await finals(runs.map((r) => r.runId));
    const [r0, r1] = runs;
    expect(done.get(r0!.runId)).toMatchObject({ status: 'exited', exitCode: 0, index: 0, serial: 'emulator-5554' });
    expect(done.get(r1!.runId)).toMatchObject({ status: 'failed', exitCode: 3, index: 1 });
    expect(done.get(r0!.runId)!.endedAt).toBeTruthy();

    const l0 = linesOf(r0!.runId);
    expect(l0).toEqual(
      expect.arrayContaining([
        'ANDROID_SERIAL=emulator-5554',
        'AVDM_INDEX=0', // per-instance vars win over manifest env
        'AVDM_NAME=实例-0',
        'AVDM_CONSOLE_PORT=5554',
        'AVDM_ADB_PORT=5555',
        'AVDM_GRPC_PORT=8554',
        'AVDM_GRPC_TOKEN=tok',
        'AVDM_ADB=/opt/fake-sdk/platform-tools/adb',
        'ANDROID_SDK_ROOT=/opt/fake-sdk',
        `AVDM_HOME=${tmp}`,
        'PYTHONUNBUFFERED=1',
        'CUSTOM=yes',
        'ARGS=["--flag","a b"]',
        'PATH0=/opt/fake-sdk/platform-tools',
        '这是标准错误输出',
        '没有换行的最后一行',
      ]),
    );
    const cwdLine = l0.find((l) => l.startsWith('CWD='))!;
    expect(await fsp.realpath(cwdLine.slice(4))).toBe(await fsp.realpath(path.join(paths.scriptsDir, 'dump')));
    expect(linesOf(r1!.runId)).toEqual(expect.arrayContaining(['ANDROID_SERIAL=emulator-5556', 'AVDM_GRPC_TOKEN=<unset>']));

    const log = await fsp.readFile(r0!.logFile, 'utf8');
    expect(log).toContain('ANDROID_SERIAL=emulator-5554');
    expect(log).toContain('这是标准错误输出');
    expect(log).toContain('# 结束');

    // listRuns: finished runs, most recent first; returned objects are copies
    const listed = runner.listRuns();
    expect(listed.map((r) => r.runId).sort()).toEqual(runs.map((r) => r.runId).sort());
    listed[0]!.status = 'running';
    expect(runner.listRuns()[0]!.status).not.toBe('running');
  });

  it('throws SCRIPT_NOT_FOUND for unknown or invalid scripts, even without targets', async () => {
    await writeScript('broken', { name: 'x' });
    for (const id of ['nope', 'broken', '../etc', '']) {
      const err = await runner.run(id, [target(0)]).catch((e: unknown) => e);
      expect(isAvdmError(err, 'SCRIPT_NOT_FOUND'), id).toBe(true);
    }
    const err = await runner.run('nope', []).catch((e: unknown) => e);
    expect(isAvdmError(err, 'SCRIPT_NOT_FOUND')).toBe(true);
  });

  it('returns [] for an existing script with no targets', async () => {
    await writeScript('ok', { command: [process.execPath, '-e', ''] });
    expect(await runner.run('ok', [])).toEqual([]);
  });

  it('reports a command that cannot be spawned as failed', async () => {
    await writeScript('missing-bin', { command: ['avdm-no-such-binary-xyz'] });
    const [run] = await runner.run('missing-bin', [target(0)]);
    expect(run!.status).toBe('failed');
    const done = await finals([run!.runId]);
    expect(done.get(run!.runId)!.status).toBe('failed');
    expect(linesOf(run!.runId).join('\n')).toContain('无法启动脚本进程');
  });

  it('stop() terminates the whole process group of a long-running script', async () => {
    const script = `
const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
console.log('CHILD=' + child.pid);
setInterval(() => console.log('tick'), 50);
`;
    await writeScript('forever', { command: [process.execPath, 'main.cjs'] }, { 'main.cjs': script });
    const [run] = await runner.run('forever', [target(2)]);
    const childLine = await waitFor(() => linesOf(run!.runId).find((l) => l.startsWith('CHILD=')));
    await waitFor(() => linesOf(run!.runId).includes('tick'));
    const grandchild = Number(childLine.slice('CHILD='.length));
    expect(alive(grandchild)).toBe(true);

    const t0 = Date.now();
    await runner.stop(run!.runId);
    expect(Date.now() - t0).toBeLessThan(5000); // SIGTERM was enough
    const info = runner.listRuns().find((r) => r.runId === run!.runId)!;
    expect(info.status).toBe('stopped');
    expect(alive(run!.pid)).toBe(false);
    await waitFor(() => !alive(grandchild), 3000);
    await runner.stop(run!.runId); // idempotent
    const err = await runner.stop('unknown-run').catch((e: unknown) => e);
    expect(isAvdmError(err, 'INVALID_ARGUMENT')).toBe(true);
  });

  it('stop() escalates to SIGKILL when SIGTERM is ignored', async () => {
    const script = `process.on('SIGTERM', () => console.log('ignoring SIGTERM')); console.log('ready'); setInterval(() => {}, 1000);`;
    await writeScript('stubborn', { command: [process.execPath, 'main.cjs'] }, { 'main.cjs': script });
    const [run] = await runner.run('stubborn', [target(0)]);
    await waitFor(() => linesOf(run!.runId).includes('ready'));
    await runner.stop(run!.runId);
    expect(runner.listRuns().find((r) => r.runId === run!.runId)!.status).toBe('stopped');
    expect(linesOf(run!.runId)).toContain('ignoring SIGTERM');
    expect(alive(run!.pid)).toBe(false);
  }, 20_000);

  it('stopAll(index) only stops runs of that instance', async () => {
    await writeScript('sleepy', { command: [process.execPath, '-e', 'console.log("up"); setInterval(() => {}, 1000)'] });
    const runs = await runner.run('sleepy', [target(0), target(1)]);
    await waitFor(() => runs.every((r) => linesOf(r.runId).includes('up')));
    await runner.stopAll(1);
    const byIndex = new Map(runner.listRuns().map((r) => [r.index, r]));
    expect(byIndex.get(1)!.status).toBe('stopped');
    expect(byIndex.get(0)!.status).toBe('running');
    expect(runner.listRuns()[0]!.index).toBe(0); // running first
    await runner.stopAll();
    expect(runner.listRuns().every((r) => r.status === 'stopped')).toBe(true);
  });
});

describe('createExample', () => {
  it('scaffolds hello-adb with a valid manifest and a syntactically valid main.py', async () => {
    const manifest = await runner.createExample();
    expect(manifest.id).toBe(EXAMPLE_SCRIPT_ID);
    expect(manifest.command).toEqual(['python3', 'main.py']);
    const dir = path.join(paths.scriptsDir, 'hello-adb');
    expect(manifest.dir).toBe(dir);
    const json = JSON.parse(await fsp.readFile(path.join(dir, 'script.json'), 'utf8'));
    expect(json.command).toEqual(['python3', 'main.py']);
    const main = await fsp.readFile(path.join(dir, 'main.py'), 'utf8');
    expect(main).toContain('AVDM_ADB');
    expect(main).toContain('getprop ro.product.model');
    expect(main).toContain('wm size');
    expect(main).toContain('input tap');
    expect((await runner.listScripts()).map((s) => s.id)).toEqual(['hello-adb']);

    const py = spawnSync('python3', ['--version']);
    if (py.status === 0) {
      const res = spawnSync('python3', ['-m', 'py_compile', path.join(dir, 'main.py')], { encoding: 'utf8' });
      expect(res.stderr).toBe('');
      expect(res.status).toBe(0);
    }
  });

  it('does not overwrite an edited main.py but repairs a broken script.json', async () => {
    await runner.createExample();
    const dir = path.join(paths.scriptsDir, 'hello-adb');
    await fsp.writeFile(path.join(dir, 'main.py'), 'print("mine")\n');
    await fsp.writeFile(path.join(dir, 'script.json'), '{ broken');
    const manifest = await runner.createExample();
    expect(manifest.command).toEqual(['python3', 'main.py']);
    expect(await fsp.readFile(path.join(dir, 'main.py'), 'utf8')).toBe('print("mine")\n');
  });

  it('main.py runs end to end against a stub adb (python3)', async () => {
    if (spawnSync('python3', ['--version']).status !== 0) return;
    await runner.createExample();
    const adbLog = path.join(tmp, 'adb.log');
    const stubAdb = path.join(tmp, 'adb');
    await fsp.writeFile(
      stubAdb,
      `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(adbLog)}, JSON.stringify(args) + '\\n');
const cmd = args.slice(2).join(' ');
if (cmd === 'shell getprop ro.product.model') console.log('sdk_gphone64_arm64');
else if (cmd === 'shell wm size') console.log('Physical size: 1280x720');
`,
      { mode: 0o755 },
    );
    const r = new ScriptRunner(paths, { adbBin: stubAdb, sdkRoot: tmp }, {
      onRun: (x) => runEvents.push(x),
      onOutput: (id, line) => output.push({ runId: id, line }),
    });
    const [run] = await r.run('hello-adb', [target(3)]);
    const done = await finals([run!.runId]);
    const lines = linesOf(run!.runId);
    expect(done.get(run!.runId), lines.join('\n')).toMatchObject({ status: 'exited', exitCode: 0 });
    expect(lines.join('\n')).toContain('设备型号: sdk_gphone64_arm64');
    expect(lines.join('\n')).toContain('屏幕尺寸: 1280x720');
    expect(lines.join('\n')).toContain('已点击屏幕中心 (640, 360)');
    const calls = (await fsp.readFile(adbLog, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as string[]);
    expect(calls).toContainEqual(['-s', 'emulator-5560', 'shell', 'input tap 640 360']);
  }, 20_000);
});

describe('helpers', () => {
  it('makeRunId uses <scriptId>-<index>-<yyyyMMddHHmmss>-<rand4> in local time', () => {
    const id = makeRunId('hello-adb', 7, new Date(2026, 8, 3, 4, 5, 6));
    expect(id).toMatch(/^hello-adb-7-20260903040506-[0-9a-f]{4}$/);
    expect(makeRunId('x', 0)).not.toBe(makeRunId('x', 0));
  });

  it('LineSplitter handles CRLF, split UTF-8 sequences and a final partial line', () => {
    const lines: string[] = [];
    const s = new LineSplitter((l) => lines.push(l));
    const bytes = Buffer.from('第一行\r\n第二', 'utf8');
    s.push(bytes.subarray(0, 4)); // cuts "第" (3 bytes) + 1 byte of "一"
    s.push(bytes.subarray(4));
    s.push(Buffer.from('行\n尾巴'));
    s.flush();
    expect(lines).toEqual(['第一行', '第二行', '尾巴']);
  });
});

async function waitFor<T>(fn: () => T | undefined | false, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}
