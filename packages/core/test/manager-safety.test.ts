import { spawnSync } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { avdDirFor, isSnapshotStale, markSnapshotStale, readAvdConfig } from '../src/avd/avdfiles.js';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { isAvdmError } from '../src/errors.js';
import { resolveEmulatorProtoPath } from '../src/grpc.js';
import { AvdManager } from '../src/manager.js';
import type { RunRecord } from '../src/types.js';
import { getFreePort } from './helpers/fakeSdk.js';
import {
  createManagerHarness,
  isAlive,
  recordEvents,
  reserveIndices,
  sleeper,
  type ManagerHarness,
} from './helpers/manager-harness.js';

/**
 * Safety of the computed state machine and the lifecycle guards, without launching emulators: synthetic
 * "emulators" are sleeping processes plus hand-written discovery files and run records.
 *
 * Instances live at indices ≥ 60 (console 5674+), and every discovery file uses a random free port unless a test
 * needs the instance's own console port number — the manager must never reach a real emulator from here.
 */

const BASE = 60;
let h: ManagerHarness;
let m: AvdManager;
let release: () => Promise<void>;
const sleepers: number[] = [];

beforeAll(async () => {
  h = await createManagerHarness();
  m = h.manager;
  release = await reserveIndices(m, BASE);
}, 60_000);

afterAll(async () => {
  await release?.();
  await h?.cleanup();
}, 60_000);

beforeEach(async () => {
  for (const i of await m.indices()) if (i >= BASE) await m.remove(i, { force: true });
  for (const f of await fsp.readdir(h.fake.discoveryDir)) await fsp.rm(path.join(h.fake.discoveryDir, f), { force: true });
});

afterEach(async () => {
  m.stopMonitor();
  delete process.env.FAKE_FAIL_START;
  for (const pid of sleepers.splice(0)) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // gone
    }
  }
});

async function sleepy(): Promise<number> {
  const pid = await sleeper();
  sleepers.push(pid);
  return pid;
}

async function one(): Promise<{ i: number; avdName: string; name: string }> {
  const [rec] = await m.create({ count: 1 });
  expect(rec!.index).toBeGreaterThanOrEqual(BASE);
  return { i: rec!.index, avdName: rec!.avdName, name: rec!.name };
}

async function writeDiscovery(pid: number, keys: Record<string, string | number>): Promise<string> {
  const file = path.join(h.fake.discoveryDir, `pid_${pid}.ini`);
  await fsp.writeFile(file, Object.entries(keys).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  return file;
}

async function writeRun(index: number, pid: number, extra: Partial<RunRecord> = {}): Promise<void> {
  const c = 5554 + 2 * index;
  await m.registry.writeRun({
    index,
    pid,
    startedAt: new Date().toISOString(),
    ports: { console: c, adb: c + 1, grpc: 8554 + index, serial: `emulator-${c}` },
    argv: ['emulator', '-avd', `avdm_${index}`],
    ...extra,
  });
}

/** Discovery keys of "our" emulator for instance `i` on a random console port. */
async function ours(i: number, avdName: string, extra: Record<string, string | number> = {}) {
  const port = await getFreePort();
  return {
    'avd.id': avdName,
    'avd.dir': avdDirFor(m.paths.avdHome, avdName),
    'port.serial': port,
    'port.adb': port + 1,
    'grpc.port': await getFreePort(),
    'fake.boot_at': Date.now() + 3600_000,
    ...extra,
  };
}

/** A minimal emulator console on a free port: banner, then `kill` just closes the connection. */
async function fakeConsole(): Promise<{ port: number; kills: () => number; close: () => Promise<void> }> {
  let kills = 0;
  const srv = net.createServer((sock) => {
    sock.write("Android Console: type 'help' for a list of commands\r\nOK\r\n");
    sock.on('data', (d) => {
      if (String(d).startsWith('kill')) {
        kills++;
        sock.end();
      }
    });
    sock.on('error', () => undefined);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as net.AddressInfo).port;
  return { port, kills: () => kills, close: () => new Promise((r) => srv.close(() => r())) };
}

describe('another manager home (same avdm_<i> names, same index → port mapping)', () => {
  it('never adopts its emulator even on our console port; start/stop/rm leave it alone', async () => {
    const { i, avdName } = await one();
    const pid = await sleepy();
    const consolePort = 5554 + 2 * i;
    await writeDiscovery(pid, {
      'avd.id': avdName,
      'avd.name': '实例-0',
      'avd.dir': `/Users/someone/.avdm/avd/${avdName}.avd`,
      'port.serial': consolePort,
      'port.adb': consolePort + 1,
      'grpc.port': await getFreePort(),
    });
    expect((await m.getState(i)).status).toBe('stopped');
    expect(isAvdmError(await m.grpc(i).catch((e: unknown) => e), 'INSTANCE_NOT_RUNNING')).toBe(true);
    expect(isAvdmError(await m.screenshot(i).catch((e: unknown) => e), 'INSTANCE_NOT_RUNNING')).toBe(true);
    await m.stop(i);
    await m.stop(i, { force: true });
    expect(isAlive(pid)).toBe(true);
    expect((await m.hostStats()).runningInstances).toBe(0);
    await m.remove(i, { force: true });
    expect(isAlive(pid)).toBe(true);
  });

  it('still matches our own AVD through a symlinked AVDM_HOME, and old builds without avd.dir by port', async () => {
    const link = path.join(os.tmpdir(), `avdm-link-${process.pid}-${Date.now()}`);
    await fsp.symlink(h.home, link);
    const other = await AvdManager.open({ home: link });
    try {
      const { i, avdName } = await one();
      const pid = await sleepy();
      const realDir = avdDirFor(await fsp.realpath(m.paths.avdHome), avdName);
      await writeDiscovery(pid, { ...(await ours(i, avdName)), 'avd.dir': realDir });
      expect((await other.getState(i)).status).toBe('booting');

      // an old/vendor build that publishes no avd.dir: name + our console port is enough
      await fsp.rm(path.join(h.fake.discoveryDir, `pid_${pid}.ini`));
      await writeDiscovery(pid, { 'avd.id': avdName, 'port.serial': 5554 + 2 * i });
      expect((await m.getState(i)).pid).toBe(pid);
      // …and a foreign avd.dir is still accepted for the very process we launched
      await fsp.rm(path.join(h.fake.discoveryDir, `pid_${pid}.ini`));
      await writeDiscovery(pid, { ...(await ours(i, avdName)), 'avd.dir': '/elsewhere/avdm.avd' });
      expect((await m.getState(i)).status).toBe('stopped');
      await writeRun(i, pid);
      expect((await m.getState(i)).pid).toBe(pid);
    } finally {
      await other.dispose();
      await fsp.rm(link, { force: true });
    }
  });
});

describe('recycled pids', () => {
  it('a run record whose pid now belongs to a younger process is a crash, and that process is never signalled', async () => {
    const { i } = await one();
    const pid = await sleepy();
    // the emulator was launched an hour ago (Mac rebooted / it was SIGKILLed); its pid now runs something else
    await writeRun(i, pid, { startedAt: new Date(Date.now() - 3600_000).toISOString() });
    const st = await m.getState(i);
    expect(st.status).toBe('error');
    expect(st.error).toContain('意外退出');
    expect(st.pid).toBeUndefined();
    expect((await m.hostStats()).runningInstances).toBe(0);
    await m.stop(i);
    expect(isAlive(pid)).toBe(true);
    expect(await m.registry.readRun(i)).toBeUndefined();
    expect((await m.getState(i)).status).toBe('stopped');
  });

  it('a stale discovery file of a recycled pid is ignored (no phantom 开机中, no kill)', async () => {
    const { i, avdName } = await one();
    const pid = await sleepy();
    const file = await writeDiscovery(pid, await ours(i, avdName));
    const hourAgo = new Date(Date.now() - 3600_000);
    await fsp.utimes(file, hourAgo, hourAgo);
    expect((await m.getState(i)).status).toBe('stopped');
    await m.stop(i, { force: true });
    expect(isAlive(pid)).toBe(true);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    "a run record pointing at another user's process neither counts as running nor wedges stop",
    async () => {
      const out = spawnSync('ps', ['-U', '0', '-o', 'pid='], { encoding: 'utf8' }).stdout ?? '';
      const rootPid = out.split('\n').map((l) => Number(l.trim())).find((p) => Number.isInteger(p) && p > 1);
      if (rootPid === undefined) return;
      const { i } = await one();
      await writeRun(i, rootPid);
      expect((await m.getState(i)).status).toBe('error');
      await m.stop(i); // used to throw STOP_TIMEOUT forever (EPERM counted as alive)
      expect(await m.registry.readRun(i)).toBeUndefined();
    },
  );

  it('after killing an emulator, stop removes the discovery file it left behind', async () => {
    const { i, avdName } = await one();
    const pid = await sleepy();
    await writeRun(i, pid);
    const file = await writeDiscovery(pid, await ours(i, avdName));
    expect((await m.getState(i)).status).toBe('booting');
    await m.stop(i, { timeoutMs: 3000 });
    expect(isAlive(pid)).toBe(false);
    await expect(fsp.access(file)).rejects.toThrow();
  });
});

describe('how an emulator ended', () => {
  it('shut down by itself (window closed / adb emu kill): stopping, then stopped — not a crash', async () => {
    const { i, avdName } = await one();
    const pid = await sleepy();
    await writeRun(i, pid);
    const file = await writeDiscovery(pid, await ours(i, avdName));
    expect((await m.getState(i)).status).toBe('booting');
    expect((await m.registry.readRun(i))?.discoveryFile).toBe(file); // registration remembered

    const ev = recordEvents(m);
    await markSnapshotStale(m.paths.avdHome, avdName, 'session running'); // as launch() does
    await fsp.rm(file); // the emulator withdraws its discovery file while it saves the snapshot…
    expect((await m.getState(i)).status).toBe('stopping');
    const snap = path.join(avdDirFor(m.paths.avdHome, avdName), 'snapshots', 'default_boot');
    await fsp.mkdir(snap, { recursive: true });
    await fsp.writeFile(path.join(snap, 'snapshot.pb'), 'saved on exit');
    process.kill(-pid, 'SIGKILL'); // …and exits
    await new Promise((r) => setTimeout(r, 100));
    const st = await m.getState(i);
    ev.stop();
    expect(st.status).toBe('stopped');
    expect(await m.registry.readRun(i)).toBeUndefined();
    expect(ev.logs.some((l) => l.level === 'info' && l.index === i && l.message.includes('自行正常关闭'))).toBe(true);
    expect(ev.logs.some((l) => l.level === 'error')).toBe(false);
    // it saved a snapshot during this session → quick boot is safe again
    expect(await isSnapshotStale(m.paths.avdHome, avdName)).toBe(false);
  });

  it('an orderly exit without a snapshot save (e.g. guest power-off) keeps the next start a cold boot', async () => {
    const { i, avdName } = await one();
    const snap = path.join(avdDirFor(m.paths.avdHome, avdName), 'snapshots', 'default_boot');
    await fsp.mkdir(snap, { recursive: true });
    await fsp.writeFile(path.join(snap, 'snapshot.pb'), 'older snapshot');
    const old = new Date(Date.now() - 3600_000);
    await fsp.utimes(path.join(snap, 'snapshot.pb'), old, old);
    const pid = await sleepy();
    await writeRun(i, pid);
    await markSnapshotStale(m.paths.avdHome, avdName, 'session running');
    const file = await writeDiscovery(pid, await ours(i, avdName));
    expect((await m.getState(i)).status).toBe('booting');
    await fsp.rm(file);
    process.kill(-pid, 'SIGKILL');
    await new Promise((r) => setTimeout(r, 100));
    expect((await m.getState(i)).status).toBe('stopped');
    expect(await isSnapshotStale(m.paths.avdHome, avdName)).toBe(true);
  });

  it('died leaving its discovery file: a crash, and it stays one after the file is cleaned up', async () => {
    const { i, avdName } = await one();
    const pid = await sleepy();
    await writeRun(i, pid);
    const file = await writeDiscovery(pid, await ours(i, avdName));
    expect((await m.getState(i)).status).toBe('booting');
    process.kill(-pid, 'SIGKILL');
    await new Promise((r) => setTimeout(r, 100));
    let st = await m.getState(i);
    expect(st.status).toBe('error');
    expect(st.error).toContain('意外退出');
    expect((await m.registry.readRun(i))?.crashedAt).toBeDefined();
    // another emulator's startup garbage-collects stale discovery files; a fresh manager must still see a crash
    await fsp.rm(file);
    const other = await AvdManager.open({ home: h.home });
    try {
      st = await other.getState(i);
      expect(st.status).toBe('error');
    } finally {
      await other.dispose();
    }
  });
});

/** A gRPC EmulatorController that only answers getStatus (booted = `booted()`), on a free port. */
async function fakeGrpcStatus(booted: () => boolean): Promise<{ port: number; close: () => void }> {
  const def = protoLoader.loadSync(resolveEmulatorProtoPath(), {
    keepCase: true,
    longs: Number,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const pkg = grpc.loadPackageDefinition(def) as unknown as {
    android: { emulation: { control: { EmulatorController: { service: grpc.ServiceDefinition } } } };
  };
  const server = new grpc.Server();
  server.addService(pkg.android.emulation.control.EmulatorController.service, {
    getStatus: (_call: unknown, cb: grpc.sendUnaryData<unknown>) => cb(null, { version: 'fake', uptime: 1000, booted: booted() }),
  });
  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (err, p) => (err ? reject(err) : resolve(p))),
  );
  return { port, close: () => server.forceShutdown() };
}

/** Run `fn` with `mgr`'s settings.bootTimeoutSec forced to `sec` (below the validated minimum, written directly). */
async function withBootTimeout(mgr: AvdManager, sec: number, fn: () => Promise<void>): Promise<void> {
  const file = mgr.paths.settingsFile;
  const saved = await fsp.readFile(file, 'utf8');
  const reload = () => (mgr as unknown as { reloadSettings(): Promise<void> }).reloadSettings();
  await fsp.writeFile(file, JSON.stringify({ ...JSON.parse(saved), bootTimeoutSec: sec }));
  await reload();
  try {
    await fn();
  } finally {
    await fsp.writeFile(file, saved);
    await reload();
  }
}

describe('boot detection', () => {
  it('gRPC booted=true is not enough: adb must be online before an instance counts as running', async () => {
    const { i, avdName } = await one();
    const pid = await sleepy();
    await writeRun(i, pid);
    const grpcServer = await fakeGrpcStatus(() => true);
    try {
      // right after a Quick Boot snapshot load: gRPC says booted, the adb transport is still offline
      const file = await writeDiscovery(pid, {
        ...(await ours(i, avdName, { 'fake.boot_at': 0, 'fake.adb_offline': 1 })),
        'grpc.port': grpcServer.port,
      });
      let st = await m.getState(i);
      expect(st).toMatchObject({ status: 'booting', bootCompleted: false });
      expect(isAvdmError(await m.device(i).then((d) => d.shell('true')).catch((e: unknown) => e), 'COMMAND_FAILED')).toBe(true);
      // adb comes online → running
      await fsp.writeFile(file, (await fsp.readFile(file, 'utf8')).replace('fake.adb_offline=1', 'fake.adb_offline=0'));
      st = await m.getState(i);
      expect(st).toMatchObject({ status: 'running', bootCompleted: true });
    } finally {
      grpcServer.close();
    }
  });

  it('gRPC booted=false is definitive: overdue → boot timeout right away', async () => {
    const { i, avdName } = await one();
    const pid = await sleepy();
    await writeRun(i, pid);
    const grpcServer = await fakeGrpcStatus(() => false);
    try {
      await writeDiscovery(pid, { ...(await ours(i, avdName)), 'grpc.port': grpcServer.port });
      await withBootTimeout(m, 1, async () => {
        await new Promise((r) => setTimeout(r, 1100));
        const st = await m.getState(i);
        expect(st.status).toBe('error');
        expect(st.error).toContain('启动超时');
      });
    } finally {
      grpcServer.close();
    }
  });

  it('a fresh manager does not call a long-running instance a boot timeout because one probe failed', async () => {
    const { i, avdName } = await one();
    const pid = await sleepy();
    await writeRun(i, pid);
    // booted long ago, but right now neither gRPC nor adb answers (e.g. another adb version restarted the server)
    await writeDiscovery(pid, await ours(i, avdName, { 'fake.boot_at': 0, 'fake.adb_offline': 1 }));
    const fresh = await AvdManager.open({ home: h.home });
    try {
      await withBootTimeout(fresh, 1, async () => {
        await new Promise((r) => setTimeout(r, 1100)); // older than the boot timeout, nothing cached
        const st = await fresh.getState(i);
        expect(st.status).toBe('booting'); // not 'error' → no auto-restart / start refusal for a healthy instance
      });
    } finally {
      await fresh.dispose();
    }
  });
});

describe('stop', () => {
  it('a force stop escalates a graceful stop that is waiting for the emulator to exit', async () => {
    const { i, avdName } = await one();
    const pid = await sleepy();
    await writeRun(i, pid);
    const con = await fakeConsole();
    try {
      await writeDiscovery(pid, {
        ...(await ours(i, avdName, { 'fake.boot_at': 0 })),
        'port.serial': con.port,
        'port.adb': con.port + 1,
      });
      expect((await m.getState(i)).status).toBe('running'); // booted (adb says so) → graceful path
      const t0 = Date.now();
      const graceful = m.stop(i); // console kill accepted, but the "emulator" never exits: waits up to 60 s
      await new Promise((r) => setTimeout(r, 1500));
      expect(con.kills()).toBe(1);
      expect(isAlive(pid)).toBe(true);
      await m.stop(i, { force: true });
      await graceful;
      expect(Date.now() - t0).toBeLessThan(10_000);
      expect(isAlive(pid)).toBe(false);
      expect((await m.getState(i)).status).toBe('stopped');
    } finally {
      await con.close();
    }
  }, 20_000);

  it('an instance that has not finished booting is killed, not asked to save a snapshot', async () => {
    const { i, avdName } = await one();
    const pid = await sleepy();
    await writeRun(i, pid);
    const con = await fakeConsole();
    try {
      await writeDiscovery(pid, { ...(await ours(i, avdName)), 'port.serial': con.port, 'port.adb': con.port + 1 });
      expect((await m.getState(i)).status).toBe('booting');
      await m.stop(i, { timeoutMs: 5000 });
      expect(con.kills()).toBe(0); // no console `kill` → the emulator cannot save a half-booted VM
      expect(isAlive(pid)).toBe(false);
    } finally {
      await con.close();
    }
  });

  it('a stop request abandoned long ago is reported as 停止未完成; start withdraws it, stop completes it', async () => {
    const { i } = await one();
    await m.update(i, { autoRestart: true });
    const pid = await sleepy();
    await writeRun(i, pid, { stopRequestedAt: new Date(Date.now() - 10 * 60_000).toISOString() });
    const st = await m.getState(i);
    expect(st.status).toBe('error');
    expect(st.error).toContain('停止未完成');
    expect(st.pid).toBe(pid);
    // a request with a long budget (stop --timeout 900) is not stale yet
    await writeRun(i, pid, { stopRequestedAt: new Date(Date.now() - 10 * 60_000).toISOString(), stopTimeoutMs: 900_000 });
    expect((await m.getState(i)).status).toBe('stopping');

    await writeRun(i, pid, { stopRequestedAt: new Date(Date.now() - 10 * 60_000).toISOString() });
    process.env.FAKE_FAIL_START = '1'; // safety net: nothing may be spawned here
    const started = await m.start(i);
    expect(started.status).toBe('starting');
    expect(started.pid).toBe(pid);
    expect((await m.registry.readRun(i))?.stopRequestedAt).toBeUndefined();

    await writeRun(i, pid, { stopRequestedAt: new Date(Date.now() - 10 * 60_000).toISOString() });
    await m.stop(i, { timeoutMs: 3000 });
    expect(isAlive(pid)).toBe(false);
    expect((await m.getState(i)).status).toBe('stopped');
  });
});

describe('Quick Boot snapshot bookkeeping', () => {
  it('switching the boot mode marks the snapshot stale (cold sessions never save one)', async () => {
    const { i, avdName } = await one();
    expect(await isSnapshotStale(m.paths.avdHome, avdName)).toBe(false);
    await m.update(i, { name: '改名' });
    expect(await isSnapshotStale(m.paths.avdHome, avdName)).toBe(false);
    await m.update(i, { spec: { bootMode: 'cold' } });
    expect(await isSnapshotStale(m.paths.avdHome, avdName)).toBe(true);
  });

  it('the marker is a plain file in the AVD dir that clones carry along', async () => {
    const { i, avdName } = await one();
    await markSnapshotStale(m.paths.avdHome, avdName, 'test');
    const [clone] = await m.clone(i, { count: 1, keepSnapshots: true });
    expect(await isSnapshotStale(m.paths.avdHome, clone!.avdName)).toBe(true);
  });
});

describe('names', () => {
  it('rejects control characters (config.ini injection) and over-long names from create, clone and update', async () => {
    const { i, avdName } = await one();
    const inject = await m.update(i, { name: 'x\nhw.ramSize=99999' }).catch((e: unknown) => e);
    expect(isAvdmError(inject, 'INVALID_ARGUMENT')).toBe(true);
    expect((await readAvdConfig(m.paths.avdHome, avdName))?.['hw.ramSize']).not.toBe('99999');
    for (const namePrefix of ['a\rb', 'tab\there', 'x'.repeat(62)]) {
      const c = await m.create({ count: 1, namePrefix }).catch((e: unknown) => e);
      expect(isAvdmError(c, 'INVALID_ARGUMENT'), JSON.stringify(namePrefix)).toBe(true);
      const k = await m.clone(i, { count: 1, namePrefix }).catch((e: unknown) => e);
      expect(isAvdmError(k, 'INVALID_ARGUMENT'), JSON.stringify(namePrefix)).toBe(true);
    }
    const ok = await m.create({ count: 1, namePrefix: 'x'.repeat(61) });
    expect(ok[0]!.name.length).toBeLessThanOrEqual(64);
  });
});

describe('cross-process guards', () => {
  it('a clone/delete in progress (held by another process) blocks start', async () => {
    const { i } = await one();
    const lock = path.join(m.paths.runDir, `instance-${i}.busy`);
    await fsp.mkdir(lock);
    try {
      process.env.FAKE_FAIL_START = '1'; // safety net
      const err = await m.start(i).catch((e: unknown) => e);
      expect(isAvdmError(err, 'INVALID_ARGUMENT')).toBe(true);
      expect((err as Error).message).toContain('正在被克隆或删除');
    } finally {
      await fsp.rm(lock, { recursive: true, force: true });
    }
  });

  it('remove refuses a live instance, and otherwise deletes AVD and logs without leftovers', async () => {
    const { i, avdName } = await one();
    const pid = await sleepy();
    await writeRun(i, pid);
    const err = await m.remove(i).catch((e: unknown) => e);
    expect(isAvdmError(err, 'INSTANCE_RUNNING')).toBe(true);
    expect((await m.registry.readRun(i))?.pid).toBe(pid);
    await fsp.access(avdDirFor(m.paths.avdHome, avdName));

    process.kill(-pid, 'SIGKILL');
    await new Promise((r) => setTimeout(r, 100));
    await fsp.writeFile(path.join(m.paths.logsDir, `instance-${i}.log.1`), 'old\n');
    await m.remove(i);
    const left = (await fsp.readdir(m.paths.avdHome)).filter((n) => n.startsWith(`${avdName}.`));
    expect(left).toEqual([]);
    await expect(fsp.access(path.join(m.paths.logsDir, `instance-${i}.log.1`))).rejects.toThrow();
    await expect(fsp.access(path.join(m.paths.runDir, `instance-${i}.busy`))).rejects.toThrow();
  });
});
