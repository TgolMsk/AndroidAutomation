import { promises as fsp } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { avdDirFor, isSnapshotStale } from '../src/avd/avdfiles.js';
import { consoleKill } from '../src/emulator/console.js';
import { isAvdmError } from '../src/errors.js';
import type { AvdManager } from '../src/manager.js';
import {
  createManagerHarness,
  isAlive,
  recordEvents,
  reserveIndices,
  waitUntil,
  type ManagerHarness,
} from './helpers/manager-harness.js';

/**
 * Health monitor, crash detection, auto-restart, boot timeout, admission control and port-conflict detection
 * against the fake SDK. Instances live at indices 50.. (console 5654.., grpc 8604..).
 */

const BASE = 50;
let h: ManagerHarness;
let m: AvdManager;
let ids: number[] = [];

const consolePort = (i: number) => 5554 + 2 * i;
const grpcPort = (i: number) => 8554 + i;

beforeAll(async () => {
  h = await createManagerHarness({ settings: { healthIntervalSec: 1 } });
  m = h.manager;
  const release = await reserveIndices(m, BASE);
  ids = (await m.create({ count: 3 })).map((r) => r.index);
  await release();
  expect(ids).toEqual([BASE, BASE + 1, BASE + 2]);
}, 60_000);

afterEach(async () => {
  m.stopMonitor();
  delete process.env.FAKE_FAIL_START;
  process.env.FAKE_BOOT_MS = '200';
  await Promise.all(ids.map((i) => m.stop(i, { force: true }).catch(() => undefined)));
  await m.updateSettings({ maxRunning: 16, memoryReserveMb: 0 });
  for (const i of ids) await m.update(i, { autoRestart: false }).catch(() => undefined);
}, 60_000);

afterAll(async () => {
  await h?.cleanup();
}, 60_000);

function listen(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer((s) => s.end());
    srv.once('error', reject);
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

describe('crash detection and auto-restart', () => {
  it('reports a killed emulator as error with the tail of its log', async () => {
    const i = ids[0]!;
    const started = await m.start(i, { wait: true, timeoutMs: 30_000 });
    expect(started.status).toBe('running');
    const ev = recordEvents(m);
    process.kill(started.pid!, 'SIGKILL');
    const st = await waitUntil(async () => {
      const s = await m.getState(i);
      return s.status === 'error' ? s : undefined;
    }, 'error status after SIGKILL');
    ev.stop();
    expect(st.error).toContain('意外退出');
    expect(st.error).toContain(`pid ${started.pid}`);
    expect(st.error).toContain('console listening'); // a line the fake printed into the instance log
    expect(st.pid).toBeUndefined();
    expect(await m.registry.readRun(i)).toBeDefined(); // kept so the crash stays visible
    expect(ev.states.some((s) => s.index === i && s.status === 'error')).toBe(true);
    expect(ev.logs.some((l) => l.level === 'error' && l.index === i && l.message.includes('意外退出'))).toBe(true);

    const waitErr = await m.waitForBoot(i, 2000).catch((e: unknown) => e);
    expect(isAvdmError(waitErr, 'INSTANCE_NOT_RUNNING')).toBe(true);
    expect((await m.hostStats()).runningInstances).toBe(0);

    // an errored instance can simply be started again
    const again = await m.start(i, { wait: true, timeoutMs: 30_000 });
    expect(again.status).toBe('running');
    expect(again.pid).not.toBe(started.pid);
    // stop clears the error for good
    await m.stop(i);
    expect((await m.getState(i)).status).toBe('stopped');
  }, 60_000);

  it('the monitor auto-restarts a crashed instance that has autoRestart on', async () => {
    const i = ids[1]!;
    await m.update(i, { autoRestart: true });
    const first = await m.start(i, { wait: true, timeoutMs: 30_000 });
    const ev = recordEvents(m);
    m.startMonitor();
    m.startMonitor(); // idempotent
    await new Promise((r) => setTimeout(r, 300)); // let the first tick record the baseline
    process.kill(first.pid!, 'SIGKILL');
    const restarted = await waitUntil(
      async () => {
        const s = await m.getState(i);
        return s.status === 'running' && s.pid !== first.pid ? s : undefined;
      },
      'auto-restart',
      30_000,
      200,
    );
    m.stopMonitor();
    ev.stop();
    expect(isAlive(restarted.pid)).toBe(true);
    expect(ev.logs.some((l) => l.index === i && l.message.includes('正在自动重启'))).toBe(true);
    await waitUntil(() => ev.logs.some((l) => l.index === i && l.message.includes('已自动重启')), 'restart log', 5000).catch(
      () => undefined,
    );
    const statuses = ev.states.filter((s) => s.index === i).map((s) => s.status);
    expect(statuses).toContain('error');
    expect(statuses[statuses.length - 1]).toBe('running');
  }, 60_000);

  it('the monitor gives up after 3 restarts in 10 minutes', async () => {
    const i = ids[2]!;
    await m.update(i, { autoRestart: true });
    process.env.FAKE_FAIL_START = '1'; // every launch dies immediately
    const ev = recordEvents(m);
    const err = await m.start(i).catch((e: unknown) => e);
    expect(isAvdmError(err, 'COMMAND_FAILED')).toBe(true);
    m.startMonitor();
    await waitUntil(() => ev.logs.some((l) => l.index === i && l.message.includes('暂停自动重启')), 'give-up log', 30_000);
    m.stopMonitor();
    ev.stop();
    const attempts = ev.logs.filter((l) => l.index === i && l.message.includes('正在自动重启'));
    expect(attempts).toHaveLength(3);
    expect(ev.logs.filter((l) => l.index === i && l.message.includes('自动重启失败')).length).toBeGreaterThanOrEqual(1);
    expect((await m.getState(i)).status).toBe('error');
  }, 60_000);

  it('dispose() waits for an auto-restart the monitor already started (no half-done launch on exit)', async () => {
    const i = ids[0]!;
    await m.update(i, { autoRestart: true });
    const first = await m.start(i, { wait: true, timeoutMs: 30_000 });
    process.kill(first.pid!, 'SIGKILL');
    await waitUntil(async () => (await m.getState(i)).status === 'error', 'error after SIGKILL');
    const m2 = await h.open(); // e.g. `avdm monitor`, interrupted right after it began a restart
    const ev = recordEvents(m2);
    m2.startMonitor();
    await waitUntil(() => ev.logs.some((l) => l.index === i && l.message.includes('正在自动重启')), 'restart begins', 15_000, 10);
    await m2.dispose();
    const outcome = ev.logs.filter((l) => l.index === i && /已自动重启|自动重启失败/.test(l.message));
    ev.stop();
    expect(outcome.map((l) => l.message)).toEqual([`实例 #${i} 已自动重启`]);
    const run = await m.registry.readRun(i);
    expect(run?.pid).toBeDefined();
    expect(run!.pid).not.toBe(first.pid);
    expect(isAlive(run!.pid)).toBe(true);
  }, 60_000);
});

describe('start failures', () => {
  it('an emulator that exits right away fails start() with its log', async () => {
    const i = ids[0]!;
    process.env.FAKE_FAIL_START = '1';
    const err = await m.start(i, { wait: true }).catch((e: unknown) => e);
    expect(isAvdmError(err, 'COMMAND_FAILED')).toBe(true);
    expect((err as Error).message).toContain('启动后立即退出');
    expect((err as Error).message).toContain('simulated start failure');
    const st = await m.getState(i);
    expect(st.status).toBe('error');
    delete process.env.FAKE_FAIL_START;
    await m.stop(i);
    expect((await m.getState(i)).status).toBe('stopped');
    expect(await m.registry.readRun(i)).toBeUndefined();
  }, 30_000);

  it('booting past bootTimeoutSec is reported as error / BOOT_TIMEOUT', async () => {
    const i = ids[2]!;
    process.env.FAKE_BOOT_MS = '600000';
    const st = await m.start(i);
    expect(['starting', 'booting']).toContain(st.status);
    await waitUntil(async () => (await m.getState(i)).status === 'booting', 'booting');
    const early = await m.waitForBoot(i, 800).catch((e: unknown) => e);
    expect(isAvdmError(early, 'BOOT_TIMEOUT')).toBe(true);

    // pretend it was launched two hours ago
    const run = (await m.registry.readRun(i))!;
    await m.registry.writeRun({ ...run, startedAt: new Date(Date.now() - 2 * 3600_000).toISOString() });
    const late = await m.getState(i);
    expect(late.status).toBe('error');
    expect(late.error).toContain('启动超时');
    expect(isAlive(late.pid)).toBe(true);
    const waitErr = await m.waitForBoot(i, 5000).catch((e: unknown) => e);
    expect(isAvdmError(waitErr, 'BOOT_TIMEOUT')).toBe(true);
    const startErr = await m.start(i).catch((e: unknown) => e);
    expect(isAvdmError(startErr, 'INSTANCE_RUNNING')).toBe(true);
    await m.stop(i);
    expect(isAlive(late.pid)).toBe(false);
    expect((await m.getState(i)).status).toBe('stopped');
  }, 30_000);

  it('stopping an instance that is still booting kills it: no half-booted Quick Boot snapshot is saved', async () => {
    const i = ids[1]!;
    const snap = path.join(avdDirFor(m.paths.avdHome, `avdm_${i}`), 'snapshots');
    await fsp.rm(snap, { recursive: true, force: true });
    process.env.FAKE_BOOT_MS = '600000';
    const st = await m.start(i);
    await waitUntil(async () => (await m.getState(i)).status === 'booting', 'booting');
    await m.stop(i, { timeoutMs: 5000 });
    expect(isAlive(st.pid)).toBe(false);
    expect((await m.getState(i)).status).toBe('stopped');
    await expect(fsp.access(snap)).rejects.toThrow(); // a console `kill` would have made the fake save one
    expect(await isSnapshotStale(m.paths.avdHome, `avdm_${i}`)).toBe(true);
  }, 30_000);

  it('stop --force kills immediately (no snapshot save) and removes the discovery file it leaves behind', async () => {
    const i = ids[0]!;
    const snap = path.join(avdDirFor(m.paths.avdHome, `avdm_${i}`), 'snapshots');
    await fsp.rm(snap, { recursive: true, force: true });
    const st = await m.start(i, { wait: true, timeoutMs: 30_000 });
    const discovery = path.join(h.fake.discoveryDir, `pid_${st.pid}.ini`);
    await fsp.access(discovery);
    await m.stop(i, { force: true });
    expect(isAlive(st.pid)).toBe(false);
    expect((await m.getState(i)).status).toBe('stopped');
    await expect(fsp.access(snap)).rejects.toThrow();
    await expect(fsp.access(discovery)).rejects.toThrow();
  }, 30_000);
});

describe('Quick Boot snapshot vs. disk', () => {
  it('after a crash the next start skips the older snapshot (-no-snapshot-load); a clean stop re-arms quick boot', async () => {
    const i = ids[0]!;
    const avd = `avdm_${i}`;
    const argv = async () => (await m.registry.readRun(i))!.argv;
    await m.start(i, { wait: true, timeoutMs: 30_000 });
    await m.stop(i); // graceful: the fake saves snapshots/default_boot and withdraws its discovery file
    expect(await isSnapshotStale(m.paths.avdHome, avd)).toBe(false);

    const first = await m.start(i, { wait: true, timeoutMs: 30_000 });
    expect(await argv()).not.toContain('-no-snapshot-load');
    process.kill(first.pid!, 'SIGKILL'); // crash: whatever it wrote since the snapshot is only on disk
    await waitUntil(async () => (await m.getState(i)).status === 'error', 'crash detected');

    await m.start(i, { wait: true, timeoutMs: 30_000 });
    expect(await argv()).toContain('-no-snapshot-load');
    expect((await m.instanceLog(i, 50)).join('\n')).toContain('(fake) cold boot');
    await m.stop(i); // graceful: fresh snapshot → quick boot is safe again
    expect(await isSnapshotStale(m.paths.avdHome, avd)).toBe(false);

    await m.start(i, { wait: true, timeoutMs: 30_000 });
    expect(await argv()).not.toContain('-no-snapshot-load');
    expect((await m.instanceLog(i, 50)).join('\n')).toContain('(fake) loading quick boot snapshot');
    await m.stop(i, { force: true });
    expect(await isSnapshotStale(m.paths.avdHome, avd)).toBe(true);
  }, 120_000);

  it('an emulator shut down outside avdm (adb emu kill / window closed) is stopped, not auto-restarted', async () => {
    const i = ids[1]!;
    process.env.FAKE_BOOT_MS = '200';
    await m.update(i, { autoRestart: true });
    const st = await m.start(i, { wait: true, timeoutMs: 30_000 });
    const ev = recordEvents(m);
    m.startMonitor();
    await new Promise((r) => setTimeout(r, 300)); // baseline tick
    expect(await consoleKill(st.ports.console)).toBe(true);
    await waitUntil(async () => (await m.getState(i)).status === 'stopped', 'stopped', 15_000);
    await new Promise((r) => setTimeout(r, 2500)); // a couple of monitor ticks
    m.stopMonitor();
    ev.stop();
    expect(ev.logs.some((l) => l.index === i && l.message.includes('正在自动重启'))).toBe(false);
    expect(ev.states.filter((s) => s.index === i).map((s) => s.status)).not.toContain('error');
    expect(await m.registry.readRun(i)).toBeUndefined();
  }, 60_000);
});

describe('admission control', () => {
  it('maxRunning=1 denies a second start unless forced', async () => {
    await m.updateSettings({ maxRunning: 1 });
    const [a, b] = ids;
    await m.start(a!, { wait: true, timeoutMs: 30_000 });
    const err = await m.start(b!).catch((e: unknown) => e);
    expect(isAvdmError(err, 'ADMISSION_DENIED')).toBe(true);
    expect((err as Error).message).toContain('最大同时运行数 1');
    expect((await m.getState(b!)).status).toBe('stopped');
    expect(await m.registry.readRun(b!)).toBeUndefined();

    const forced = await m.start(b!, { force: true, wait: true, timeoutMs: 30_000 });
    expect(forced.status).toBe('running');
  }, 60_000);

  it('denies a start that would eat into the memory reserve', async () => {
    await m.updateSettings({ memoryReserveMb: 10_000_000 });
    const err = await m.start(ids[2]!).catch((e: unknown) => e);
    expect(isAvdmError(err, 'ADMISSION_DENIED')).toBe(true);
    expect((err as Error).message).toContain('内存');
    expect((await m.getState(ids[2]!)).status).toBe('stopped');
  });

  it('two managers starting the same instance launch only one emulator', async () => {
    const other = await h.open();
    const i = ids[0]!;
    const [s1, s2] = await Promise.all([m.start(i), other.start(i)]);
    expect(s1.pid).toBeGreaterThan(0);
    expect(s2.pid).toBe(s1.pid);
    const st = await m.waitForBoot(i, 30_000);
    expect(st.pid).toBe(s1.pid);
    await other.dispose();
  }, 60_000);
});

describe('port conflicts', () => {
  it('refuses to start when the console port is taken by another program', async () => {
    const i = ids[2]!;
    const srv = await listen(consolePort(i));
    try {
      const err = await m.start(i).catch((e: unknown) => e);
      expect(isAvdmError(err, 'INVALID_ARGUMENT')).toBe(true);
      const msg = (err as Error).message;
      expect(msg).toContain('端口冲突');
      expect(msg).toContain(`控制台端口 ${consolePort(i)}`);
      expect(msg).toContain('占用');
      expect(msg).toContain(`pid ${process.pid}`); // lsof names the owner (this test process)
      expect((await m.getState(i)).status).toBe('stopped');
      expect(await m.registry.readRun(i)).toBeUndefined();
    } finally {
      await new Promise((r) => srv.close(r));
    }
    const ok = await m.start(i, { wait: true, timeoutMs: 30_000 });
    expect(ok.status).toBe('running');
  }, 30_000);

  it('names the gRPC port when that one is taken', async () => {
    const i = ids[1]!;
    const srv = await listen(grpcPort(i));
    try {
      const err = await m.start(i).catch((e: unknown) => e);
      expect(isAvdmError(err, 'INVALID_ARGUMENT')).toBe(true);
      expect((err as Error).message).toContain(`gRPC端口 ${grpcPort(i)}`);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});
