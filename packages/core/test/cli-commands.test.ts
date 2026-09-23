import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AvdManager } from '@avdm/core';
import { AvdManager as SrcAvdManager } from '../src/index.js';
import type { Command } from 'commander';
import { buildProgram } from '../../cli/src/index.js';
import { withManager } from '../../cli/src/runtime.js';
import { confirm } from '../../cli/src/ui/prompt.js';
import { claimTerminal, releaseTerminal } from '../../cli/src/ui/terminal.js';
import { DEFAULT_SPEC } from '../src/constants.js';
import { AvdmError } from '../src/errors.js';
import { resolvePaths } from '../src/paths.js';
import type {
  InstallProgress,
  InstanceRecord,
  InstanceState,
  InstanceStatus,
  ManagerEventMap,
  RemotePackage,
  SdkInfo,
  Settings,
} from '../src/types.js';

/**
 * CLI command tests: the real commander program from packages/cli is driven against a fake AvdManager
 * (AvdManager.open is stubbed), so no emulator, SDK or ~/.avdm is touched.
 */

process.env.NO_COLOR = '1';

// The CLI imports '@avdm/core' (package exports → dist/). Point it at the sources so these tests do not
// depend on a prior `tsc` build and exercise the same code as the rest of the core test suite.
vi.mock('@avdm/core', async () => await import('../src/index.js'));

// confirm() reads the real stdin; tests that reach a y/N question stub its answer (and see its output stream).
vi.mock('../../cli/src/ui/prompt.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../cli/src/ui/prompt.js')>();
  return { ...actual, confirm: vi.fn(actual.confirm) };
});

/**
 * Fake `adb`: `adb -s <serial> shell <command>` echoes two lines, "sleep …" runs for real (timeouts),
 * "fail" prints to stdout and stderr and exits 127.
 */
const FAKE_ADB = `#!/bin/sh
serial="$2"; cmd="$4"
case "$cmd" in
  sleep*) exec $cmd ;;
  fail*) echo "partial output"; echo "boom: not found" >&2; exit 127 ;;
  *) echo "line1 of $cmd on $serial"; echo line2 ;;
esac
`;

const LICENSE_TEXT = 'Terms and Conditions\n\n1. Introduction\nThis is the Android SDK License Agreement.';

class FakeManager extends EventEmitter<ManagerEventMap> {
  calls: string[] = [];
  batchConcurrency: Array<number | undefined> = [];
  paths;
  settings: Settings;
  records: InstanceRecord[];
  statuses = new Map<number, InstanceStatus>();
  sdk: SdkInfo;
  plan = {
    packages: [] as RemotePackage[],
    licenses: { 'android-sdk-license': LICENSE_TEXT } as Record<string, string>,
    unaccepted: ['android-sdk-license'],
    missing: [] as string[],
    totalBytes: 0,
  };

  registry = { list: async () => this.records };
  scripts = { listRuns: () => [], stop: async () => {}, createExample: async () => ({}) };

  constructor(readonly home: string) {
    super();
    this.paths = resolvePaths(home);
    this.settings = {
      sdkRoot: path.join(home, 'sdk'),
      defaultImage: 'system-images;android-35;default;arm64-v8a',
      defaultSpec: { ...DEFAULT_SPEC, extraArgs: [] },
      maxRunning: 6,
      memoryReserveMb: 6144,
      bootTimeoutSec: 240,
      healthIntervalSec: 5,
      proxy: 'direct',
      emulatorExtraArgs: [],
      scrcpyPath: '',
    };
    this.records = [0, 1, 2].map((index) => ({
      index,
      name: index === 2 ? 'phone' : `实例-${index}`,
      avdName: `avdm_${index}`,
      image: 'system-images;android-35;default;arm64-v8a',
      spec: { ...DEFAULT_SPEC, extraArgs: [] },
      createdAt: '2026-09-01T00:00:00.000Z',
      autoRestart: false,
    }));
    this.statuses.set(0, 'running');
    this.statuses.set(1, 'stopped');
    this.statuses.set(2, 'running');
    this.sdk = { root: this.settings.sdkRoot, exists: false, images: [], acceptedLicenses: [] };
  }

  state(rec: InstanceRecord): InstanceState {
    const status = this.statuses.get(rec.index) ?? 'stopped';
    const console = 5554 + rec.index * 2;
    return {
      record: rec,
      ports: { console, adb: console + 1, grpc: 8554 + rec.index, serial: `emulator-${console}` },
      status,
      bootCompleted: status === 'running',
      ...(status !== 'stopped' ? { pid: 1000 + rec.index, grpcToken: 'super-secret-token' } : {}),
    };
  }

  getSettings() {
    return this.settings;
  }
  async updateSettings(patch: Partial<Settings>) {
    this.calls.push(`updateSettings ${JSON.stringify(patch)}`);
    this.settings = { ...this.settings, ...patch };
    return this.settings;
  }
  async indices() {
    return this.records.map((r) => r.index);
  }
  async list() {
    return this.records.map((r) => this.state(r));
  }
  async batch<T>(indices: number[], fn: (i: number) => Promise<T>, opts?: { concurrency?: number }) {
    this.batchConcurrency.push(opts?.concurrency);
    const out: Array<{ index: number; ok: true; value: T } | { index: number; ok: false; error: Error }> = [];
    for (const index of indices) {
      try {
        out.push({ index, ok: true, value: await fn(index) });
      } catch (error) {
        out.push({ index, ok: false, error: error as Error });
      }
    }
    return out;
  }
  async start(index: number) {
    this.calls.push(`start ${index}`);
    if (index === 1) throw new AvdmError('ADMISSION_DENIED', '可用内存不足');
    this.statuses.set(index, 'booting');
    return this.state(this.records[index]!);
  }
  async stop(index: number) {
    this.calls.push(`stop ${index}`);
    this.statuses.set(index, 'stopped');
  }
  async create(opts: unknown) {
    this.calls.push(`create ${JSON.stringify(opts)}`);
    return [this.records[0]!];
  }
  async update(index: number, opts: unknown) {
    this.calls.push(`update ${index} ${JSON.stringify(opts)}`);
    return this.records[index]!;
  }
  async remove(index: number) {
    this.calls.push(`remove ${index}`);
  }
  async device(index: number) {
    const bin = path.join(this.home, 'adb');
    await fsp.writeFile(bin, FAKE_ADB, { mode: 0o755 });
    return { adb: { bin }, serial: `emulator-${5554 + index * 2}` };
  }
  async waitForBoot(index: number) {
    this.calls.push(`waitForBoot ${index}`);
    this.statuses.set(index, 'running');
    return this.state(this.records[index]!);
  }
  async instanceLog(index: number, lines?: number) {
    this.calls.push(`instanceLog ${index} ${lines}`);
    return ['a', 'b'];
  }
  async planSdkInstall(pkgs: string[]) {
    this.calls.push(`plan ${pkgs.join(',')}`);
    return this.plan;
  }
  async refreshSdk() {
    return this.sdk;
  }
  async getSdk() {
    return this.sdk;
  }
  async acceptLicenses(ids: string[]) {
    this.calls.push(`accept ${ids.join(',')}`);
  }
  async installSdkPackages(pkgs: string[]) {
    this.calls.push(`install ${pkgs.join(',')}`);
    for (const pkg of pkgs) {
      const events: InstallProgress[] = [
        { packagePath: pkg, phase: 'download', receivedBytes: 0, totalBytes: 100 },
        { packagePath: pkg, phase: 'download', receivedBytes: 100, totalBytes: 100 },
        { packagePath: pkg, phase: 'extract' },
        { packagePath: pkg, phase: 'done' },
      ];
      for (const e of events) this.emit('sdk-progress', e);
    }
  }
  async hostStats() {
    return {
      platform: 'darwin' as const,
      arch: 'arm64',
      cpuModel: 'Apple M4',
      cpuCount: 10,
      loadAvg: [1, 1, 1] as [number, number, number],
      totalMemMb: 32768,
      availableMemMb: 20000,
      memoryPressure: 'normal' as const,
      committedInstanceRamMb: 6144,
      runningInstances: 2,
    };
  }
  async dispose() {
    this.calls.push('dispose');
  }
}

function pkg(pathId: string, revision: string, size: number): RemotePackage {
  return {
    path: pathId,
    displayName: pathId,
    revision,
    channel: 'channel-0',
    licenseId: 'android-sdk-license',
    archives: [{ url: `https://example.invalid/${pathId}.zip`, size, sha1: 'a'.repeat(40) }],
  };
}

let home: string;
let fake: FakeManager;
let stdout: string;
let stderr: string;

function exitOverrideAll(cmd: Command): void {
  cmd.exitOverride();
  for (const sub of cmd.commands) exitOverrideAll(sub);
}

async function run(...args: string[]): Promise<void> {
  const program = buildProgram();
  exitOverrideAll(program);
  await program.parseAsync(['node', 'avdm', ...args]);
}

beforeEach(async () => {
  home = await fsp.mkdtemp(path.join(os.tmpdir(), 'avdm-cli-'));
  fake = new FakeManager(home);
  vi.spyOn(AvdManager, 'open').mockResolvedValue(fake as unknown as AvdManager);
  stdout = '';
  stderr = '';
  const capture = (append: (text: string) => void) =>
    ((chunk: unknown, encOrCb?: unknown, cb?: unknown) => {
      append(String(chunk));
      const done = typeof encOrCb === 'function' ? encOrCb : cb;
      if (typeof done === 'function') (done as () => void)();
      return true;
    }) as typeof process.stdout.write;
  vi.spyOn(process.stdout, 'write').mockImplementation(capture((t) => (stdout += t)));
  vi.spyOn(process.stderr, 'write').mockImplementation(capture((t) => (stderr += t)));
  vi.mocked(confirm).mockClear();
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = 0;
  await fsp.rm(home, { recursive: true, force: true });
});

/**
 * Capture withManager's SIGINT/SIGTERM/SIGHUP listeners instead of installing them (a real signal would
 * hit the test runner), and stub process.exit. `fire(sig)` delivers a signal to the command.
 */
function interceptSignals() {
  const handlers = new Map<string | symbol, (sig: NodeJS.Signals) => void>();
  const realOn = process.on.bind(process);
  vi.spyOn(process, 'on').mockImplementation(((event: string | symbol, listener: (...args: unknown[]) => void) => {
    if (event === 'SIGINT' || event === 'SIGTERM' || event === 'SIGHUP') {
      handlers.set(event, listener as (sig: NodeJS.Signals) => void);
      return process;
    }
    return realOn(event as 'exit', listener);
  }) as typeof process.on);
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  const fire = (sig: NodeJS.Signals) => {
    const handler = handlers.get(sig);
    if (!handler) throw new Error(`no ${sig} handler installed`);
    handler(sig);
  };
  return { fire, exit };
}

/** A promise to block a fake manager call on, plus one that resolves when the call is reached. */
function gate() {
  let release!: () => void;
  let reached!: () => void;
  const released = new Promise<void>((r) => (release = r));
  const entered = new Promise<void>((r) => (reached = r));
  return { release, entered, pass: async () => (reached(), released) };
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

/** Temporarily pretend stdin/stdout/stderr are (not) terminals. */
async function withTty(tty: { stdin: boolean; stdout: boolean; stderr: boolean }, fn: () => Promise<void>) {
  const streams = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr };
  const saved = Object.entries(streams).map(([k, st]) => [k, Object.getOwnPropertyDescriptor(st, 'isTTY')] as const);
  for (const [k, st] of Object.entries(streams)) {
    Object.defineProperty(st, 'isTTY', { value: tty[k as keyof typeof tty], configurable: true, writable: true });
  }
  try {
    await fn();
  } finally {
    for (const [k, desc] of saved) {
      const st = streams[k as keyof typeof streams];
      if (desc) Object.defineProperty(st, 'isTTY', desc);
      else delete (st as { isTTY?: boolean }).isTTY;
    }
  }
}

describe('module wiring', () => {
  it('resolves @avdm/core to the core sources', () => {
    expect(AvdManager).toBe(SrcAvdManager);
  });
});

describe('avdm list', () => {
  it('prints a table with Chinese statuses and disposes the manager', async () => {
    await run('list');
    expect(stdout).toContain('实例-0');
    expect(stdout).toContain('运行中');
    expect(stdout).toContain('已停止');
    expect(stdout).toContain('emulator-5554');
    expect(stdout).toContain('2核/3G/1280x720@320');
    expect(stdout).toContain('android-35/default');
    expect(stdout).toMatch(/共 3 个实例，运行中 2 个/);
    expect(fake.calls).toContain('dispose');
  });

  it('prints JSON only, without the gRPC token', async () => {
    await run('ls', '--json');
    const parsed = JSON.parse(stdout) as Array<{ record: { index: number }; grpcAuth: boolean }>;
    expect(parsed.map((s) => s.record.index)).toEqual([0, 1, 2]);
    expect(parsed[0]!.grpcAuth).toBe(true);
    expect(stdout).not.toContain('super-secret-token');
  });
});

describe('avdm start/stop (batch)', () => {
  it('prints ✓/✗ per instance, honours -j and sets exit code 1 on failure', async () => {
    await run('start', 'all', '-j', '2');
    expect(fake.calls.filter((c) => c.startsWith('start'))).toEqual(['start 0', 'start 1', 'start 2']);
    expect(fake.batchConcurrency).toEqual([2]);
    expect(stdout).toMatch(/✓ #0 实例-0 → 开机中/);
    expect(stdout).toContain('✗ #1 可用内存不足');
    expect(stdout).toMatch(/成功 2 个，失败 1 个/);
    expect(process.exitCode).toBe(1);
    expect(fake.calls).toContain('dispose');
  });

  it('emits a JSON result array for stop', async () => {
    await run('stop', '0,2', '--json');
    const parsed = JSON.parse(stdout) as Array<{ index: number; ok: boolean; value: unknown }>;
    expect(parsed).toEqual([
      { index: 0, name: '实例-0', ok: true, value: null },
      { index: 2, name: 'phone', ok: true, value: null },
    ]);
    expect(fake.batchConcurrency).toEqual([8]);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('rejects unknown indices via the selector', async () => {
    await expect(run('stop', '7')).rejects.toMatchObject({ code: 'INSTANCE_NOT_FOUND' });
  });
});

describe('avdm shell', () => {
  it('prefixes output with [#i] and fails non-running instances', async () => {
    await run('shell', 'all', '--', 'getprop', 'ro.product.model');
    expect(stdout).toContain('[#0] line1 of getprop ro.product.model on emulator-5554');
    expect(stdout).toContain('[#2] line2');
    expect(stdout).toMatch(/✗ #1 实例未运行/);
    expect(process.exitCode).toBe(1);
  });

  it('prints raw output for a single instance', async () => {
    await run('shell', '0', '--', 'echo', 'hi');
    expect(stdout.startsWith('line1 of echo hi on emulator-5554\nline2\n')).toBe(true);
  });

  it('is not capped at 60 s: no timeout by default, --timeout kills and says 超时', async () => {
    const started = Date.now();
    await run('shell', '0', '--timeout', '0.3', '--', 'sleep', '10');
    expect(Date.now() - started).toBeLessThan(5000);
    expect(stdout).toContain('✗ #0 超时（0.3 秒），已终止命令（可用 --timeout 调整，0 为不限时）');
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    await run('shell', '0', '--', 'sleep', '0.2');
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('streams partial output and reports the exit status and stderr of a failing command', async () => {
    await run('shell', '0,2', '--', 'fail');
    expect(stdout).toContain('[#0] partial output');
    expect(stderr).toContain('[#2] boom: not found');
    expect(stdout).toContain('✗ #0 命令失败（退出码 127）: boom: not found');
    expect(process.exitCode).toBe(1);
  });

  it('collects output for --json', async () => {
    await run('shell', '0', '--json', '--', 'getprop', 'x');
    const parsed = JSON.parse(stdout) as Array<{ ok: boolean; value: string }>;
    expect(parsed[0]).toMatchObject({ ok: true, value: 'line1 of getprop x on emulator-5554\nline2\n' });
  });
});

describe('Ctrl-C / SIGTERM / SIGHUP handling', () => {
  it('create: the first Ctrl-C lets core finish its rollback instead of exiting mid-operation', async () => {
    const { fire, exit } = interceptSignals();
    const g = gate();
    fake.create = async () => {
      fake.calls.push('create');
      await g.pass(); // cp -c got the terminal's SIGINT too and failed…
      fake.calls.push('rollback'); // …so core removes the half-created records
      throw new AvdmError('COMMAND_FAILED', 'cp -c 失败: interrupted');
    };
    const done = run('create', '-n', '3');
    await g.entered;
    fire('SIGINT');
    await tick();
    expect(exit).not.toHaveBeenCalled();
    expect(fake.calls).not.toContain('dispose');
    expect(stderr).toContain('正在完成当前操作…（再按一次 Ctrl-C 强制退出）');
    g.release();
    await done;
    expect(fake.calls.slice(-2)).toEqual(['rollback', 'dispose']);
    expect(stderr).toContain('已取消');
    expect(process.exitCode).toBe(130);
    expect(exit).not.toHaveBeenCalled();
  });

  it('start: the launch in progress completes (lock released), the rest are skipped, exit 130', async () => {
    const { fire, exit } = interceptSignals();
    const g = gate();
    const realStart = fake.start.bind(fake);
    fake.start = async (index: number) => {
      if (index === 0) await g.pass();
      return realStart(index);
    };
    const done = run('start', '0,2', '-j', '1');
    await g.entered;
    fire('SIGTERM');
    g.release();
    await done;
    expect(fake.calls.filter((c) => c.startsWith('start'))).toEqual(['start 0']);
    expect(stdout).toMatch(/✓ #0 实例-0 → 开机中/);
    expect(stdout).toContain('⚠ #2 phone 已跳过（已中断）');
    expect(stdout).toMatch(/成功 1 个，已中断 1 个/);
    expect(process.exitCode).toBe(130);
    expect(exit).not.toHaveBeenCalled();
  });

  it('start --wait: Ctrl-C abandons only the wait for boot', async () => {
    const { fire } = interceptSignals();
    const g = gate();
    fake.waitForBoot = async () => {
      await g.pass();
      return fake.state(fake.records[0]!);
    };
    const done = run('start', '0', '--wait', '--json');
    await g.entered;
    fire('SIGINT');
    await done;
    expect(fake.calls).toContain('start 0');
    const parsed = JSON.parse(stdout) as Array<{ ok: boolean; cancelled?: boolean; error: { code: string; message: string } }>;
    expect(parsed[0]).toMatchObject({ ok: false, cancelled: true, error: { code: 'CANCELLED', message: '已启动，未等待开机完成（已中断）' } });
    expect(process.exitCode).toBe(130);
    g.release();
  });

  it('a second Ctrl-C still force-exits', async () => {
    const { fire, exit } = interceptSignals();
    const g = gate();
    fake.stop = async () => {
      await g.pass();
    };
    const done = run('stop', '0');
    await g.entered;
    fire('SIGINT');
    fire('SIGINT');
    await tick();
    expect(exit).toHaveBeenCalledWith(130);
    expect(stderr).toContain('已强制退出');
    g.release();
    await done;
  });

  it('read-only commands still exit on the first Ctrl-C', async () => {
    const { fire, exit } = interceptSignals();
    const g = gate();
    fake.list = async () => {
      await g.pass();
      return fake.records.map((r) => fake.state(r));
    };
    const done = run('list');
    await g.entered;
    fire('SIGINT');
    await tick();
    expect(stderr).toContain('已中断');
    expect(exit).toHaveBeenCalledWith(130);
    g.release();
    await done;
  });

  it('SIGHUP (terminal closed) stops a long-running command and disposes the manager (script runs)', async () => {
    const { fire, exit } = interceptSignals();
    const done = run('logs', '0', '-f');
    await tick(50);
    fire('SIGHUP');
    await done;
    expect(fake.calls).toContain('dispose');
    expect(exit).not.toHaveBeenCalled();
    expect(stderr).not.toContain('正在取消'); // nothing is written to a terminal that is gone
  });

  it('shell: SIGTERM kills the adb children instead of leaving them running (e.g. logcat)', async () => {
    const { fire, exit } = interceptSignals();
    const started = Date.now();
    const done = run('shell', '0', '--', 'sleep', '10');
    await tick(400);
    fire('SIGTERM');
    await done;
    expect(Date.now() - started).toBeLessThan(5000);
    expect(stdout).toContain('⚠ #0 实例-0 已中断');
    expect(process.exitCode).toBe(130);
    expect(exit).not.toHaveBeenCalled();
  });

  it('Ctrl-C while the license pager owns the terminal is deferred, never force-exits, and replays afterwards', async () => {
    const { fire, exit } = interceptSignals();
    const pager = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kill: vi.fn() });
    let abortedWhilePaging: boolean | undefined;
    let abortedAfter: boolean | undefined;
    await withManager({ interruptible: true }, async (ctx) => {
      claimTerminal(pager as unknown as ChildProcess);
      fire('SIGINT');
      fire('SIGINT');
      abortedWhilePaging = ctx.signal.aborted;
      releaseTerminal(); // the user quit the pager
      abortedAfter = ctx.signal.aborted;
    });
    expect(abortedWhilePaging).toBe(false);
    expect(abortedAfter).toBe(true);
    expect(exit).not.toHaveBeenCalled();
    expect(pager.kill).not.toHaveBeenCalled();
  });
});

describe('avdm list hints', () => {
  it('prints a self-contained crash line with an `avdm logs` pointer, and how to clear a stuck 准备中 record', async () => {
    fake.records[2] = { ...fake.records[2]!, provisioning: true };
    fake.statuses.set(1, 'error');
    const realState = fake.state.bind(fake);
    fake.state = (rec) => {
      const st = realState(rec);
      return rec.index === 1
        ? { ...st, error: '模拟器进程意外退出（pid 78209），日志末尾:\nINFO | Boot completed in 15964 ms' }
        : st;
    };
    await run('list');
    expect(stdout).toContain('#1 异常: 模拟器进程意外退出（pid 78209）（详见 avdm logs 1）');
    expect(stdout).not.toContain('日志末尾');
    expect(stdout).toMatch(/#2 准备中: .*avdm rm 2 -y/);
  });
});

describe('avdm rm', () => {
  it('refuses to delete without -y when not interactive', async () => {
    await expect(run('rm', '0')).rejects.toThrow(/-y/);
    expect(fake.calls.some((c) => c.startsWith('remove'))).toBe(false);
  });

  it('deletes with -y', async () => {
    await run('rm', '0-1', '-y');
    expect(fake.calls.filter((c) => c.startsWith('remove'))).toEqual(['remove 0', 'remove 1']);
  });
});

describe('avdm settings', () => {
  it('parses values as JSON and validates through updateSettings', async () => {
    await run('settings', 'set', 'maxRunning', '8');
    expect(fake.calls).toContain('updateSettings {"maxRunning":8}');
    expect(stdout).toContain('✓ maxRunning = 8');
  });

  it('`settings --json` prints the whole settings object', async () => {
    await run('settings', '--json');
    expect(JSON.parse(stdout)).toMatchObject({ maxRunning: 6, defaultSpec: { ramMb: 3072 } });
  });

  it('get is the default subcommand', async () => {
    await run('settings');
    expect(stdout).toContain('defaultSpec.ramMb');
    expect(stdout).toContain('最多同时运行的实例数');
    stdout = '';
    await run('settings', 'get', 'defaultSpec.cpuCores', '--json');
    expect(JSON.parse(stdout)).toBe(2);
  });
});

describe('avdm create/set', () => {
  it('passes only explicitly given spec fields to create', async () => {
    await run('create', '-n', '2', '--name', '账号', '--ram', '4G', '--res', '720x1280', '--window', '--auto-restart');
    const call = fake.calls.find((c) => c.startsWith('create '))!;
    expect(JSON.parse(call.slice('create '.length))).toEqual({
      count: 2,
      namePrefix: '账号',
      autoRestart: true,
      spec: { ramMb: 4096, width: 720, height: 1280, headless: false },
    });
    expect(stdout).toContain('已创建 1 个实例');
  });

  it('names multiple instances <name>-<index> and supports --no-auto-restart', async () => {
    await run('set', '0,2', '--name', 'farm', '--no-auto-restart', '--cold-boot');
    const updates = fake.calls.filter((c) => c.startsWith('update '));
    expect(updates).toEqual([
      'update 0 {"autoRestart":false,"spec":{"bootMode":"cold"},"name":"farm-0"}',
      'update 2 {"autoRestart":false,"spec":{"bootMode":"cold"},"name":"farm-2"}',
    ]);
  });

  it('requires at least one change', async () => {
    await expect(run('set', '0')).rejects.toThrow(/未指定任何要修改的项/);
  });
});

describe('avdm logs', () => {
  it('passes -n through to instanceLog', async () => {
    await run('logs', '2', '-n', '5', '--json');
    expect(fake.calls).toContain('instanceLog 2 5');
    expect(JSON.parse(stdout)).toMatchObject({ index: 2, lines: ['a', 'b'] });
  });
});

describe('avdm sdk install', () => {
  beforeEach(() => {
    fake.plan.packages = [pkg('emulator', '36.6.11', 300 * 1024 * 1024), pkg('platform-tools', '36.0.0', 8 * 1024 * 1024)];
  });

  it('never accepts licenses without consent in JSON / non-interactive mode', async () => {
    await expect(run('sdk', 'install', '--json')).rejects.toMatchObject({ code: 'LICENSE_NOT_ACCEPTED' });
    await expect(run('sdk', 'install')).rejects.toMatchObject({ code: 'LICENSE_NOT_ACCEPTED' });
    expect(fake.calls.some((c) => c.startsWith('accept'))).toBe(false);
    expect(fake.calls.some((c) => c.startsWith('install'))).toBe(false);
  });

  it('shows the license where the user can see it when stdout is redirected, and asks there', async () => {
    vi.mocked(confirm).mockResolvedValueOnce(true);
    await withTty({ stdin: true, stdout: false, stderr: true }, () => run('sdk', 'install'));
    expect(stderr).toContain('This is the Android SDK License Agreement');
    expect(stdout).not.toContain('This is the Android SDK License Agreement');
    expect(vi.mocked(confirm)).toHaveBeenCalledWith('是否接受许可 android-sdk-license？[y/N] ', expect.objectContaining({ output: process.stderr }));
    expect(fake.calls).toContain('accept android-sdk-license');
  });

  it('refuses instead of prompting blind when no output is a terminal', async () => {
    await withTty({ stdin: true, stdout: false, stderr: false }, async () => {
      await expect(run('sdk', 'install')).rejects.toMatchObject({ code: 'LICENSE_NOT_ACCEPTED' });
    });
    expect(vi.mocked(confirm)).not.toHaveBeenCalled();
    expect(fake.calls.some((c) => c.startsWith('accept'))).toBe(false);
  });

  it('--accept-licenses prints the license ids, accepts, then installs with progress', async () => {
    await run('sdk', 'install', '--accept-licenses');
    expect(fake.calls.find((c) => c.startsWith('plan'))).toBe('plan emulator,platform-tools,system-images;android-35;default;arm64-v8a');
    expect(stdout).toContain('android-sdk-license');
    expect(stdout).toContain('合计下载: 308.0 MB');
    const accept = fake.calls.indexOf('accept android-sdk-license');
    const install = fake.calls.indexOf('install emulator,platform-tools');
    expect(accept).toBeGreaterThanOrEqual(0);
    expect(install).toBeGreaterThan(accept);
    // Non-TTY progress: one line per 10 % step and a done line per package.
    expect(stderr).toContain('下载 emulator  100%');
    expect(stderr).toContain('✓ emulator 安装完成');
    expect(stdout).toContain('安装完成（2 个组件）');
    const saved = await fsp.readFile(path.join(home, 'licenses', 'android-sdk-license.txt'), 'utf8');
    expect(saved).toContain('Android SDK License Agreement');
  });

  it('skips packages that are already up to date', async () => {
    const root = fake.settings.sdkRoot;
    await fsp.mkdir(path.join(root, 'emulator'), { recursive: true });
    await fsp.writeFile(path.join(root, 'emulator', 'source.properties'), 'Pkg.Revision=36.6.11\n');
    await fsp.mkdir(path.join(root, 'platform-tools'), { recursive: true });
    await fsp.writeFile(path.join(root, 'platform-tools', 'source.properties'), 'Pkg.Revision=35.0.2\n');
    fake.sdk = { ...fake.sdk, exists: true };
    await run('sdk', 'install', 'emulator', 'platform-tools', '--accept-licenses');
    expect(stdout).toContain('已是最新，跳过');
    expect(stdout).toContain('升级（35.0.2 → 36.0.0）');
    expect(fake.calls).toContain('install platform-tools');
  });

  it('reports packages missing from the catalog', async () => {
    fake.plan.missing = ['system-images;android-99;default;arm64-v8a'];
    await expect(run('sdk', 'install', 'system-images;android-99;default;arm64-v8a')).rejects.toThrow(/android-99/);
  });
});

describe('avdm doctor', () => {
  it('flags an emulator older than the minimum version and exits 1', async () => {
    fake.sdk = {
      root: fake.settings.sdkRoot,
      exists: true,
      emulator: { dir: '/x/emulator', bin: '/x/emulator/emulator', version: '36.5.2' },
      adb: { bin: '/x/platform-tools/adb', version: '36.0.0' },
      images: [],
      acceptedLicenses: ['android-sdk-license'],
    };
    await run('doctor', '--json');
    const report = JSON.parse(stdout) as { ok: boolean; checks: Array<{ id: string; level: string; hint?: string }> };
    expect(report.ok).toBe(false);
    const emu = report.checks.find((c) => c.id === 'emulator')!;
    expect(emu.level).toBe('fail');
    expect(emu.hint).toContain('avdm sdk install emulator');
    expect(report.checks.find((c) => c.id === 'adb')!.level).toBe('ok');
    expect(report.checks.find((c) => c.id === 'default-image')!.level).toBe('fail');
    expect(report.checks.find((c) => c.id === 'memory')!.level).toBe('ok');
    expect(process.exitCode).toBe(1);
  });

  it('prints ✓/⚠/✗ lines with hints', async () => {
    await run('doctor');
    expect(stdout).toMatch(/✗ Android SDK/);
    expect(stdout).toContain('avdm sdk install');
    expect(stdout).toMatch(/体检完成：\d+ 项通过/);
  });
});
