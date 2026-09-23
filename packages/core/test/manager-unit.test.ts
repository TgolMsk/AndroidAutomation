import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { avdDirFor, avdIniFor, readAvdConfig } from '../src/avd/avdfiles.js';
import { DEFAULT_SPEC } from '../src/constants.js';
import { isAvdmError } from '../src/errors.js';
import { AvdManager, statusLabel } from '../src/manager.js';
import type { RunRecord } from '../src/types.js';
import { getFreePort } from './helpers/fakeSdk.js';
import {
  createManagerHarness,
  deadPid,
  isAlive,
  recordEvents,
  sleeper,
  waitUntil,
  type ManagerHarness,
} from './helpers/manager-harness.js';

/**
 * AvdManager without launching emulators: create/clone/update/remove on disk, the computed state machine
 * driven by synthetic run records and discovery files, batch(), the monitor, and error paths.
 * Synthetic "emulators" are plain sleeping processes; their discovery files use random free ports so
 * nothing here ever talks to a real emulator.
 */

let h: ManagerHarness;
let m: AvdManager;
const sleepers: number[] = [];

beforeAll(async () => {
  h = await createManagerHarness();
  m = h.manager;
}, 60_000);

afterAll(async () => {
  await h?.cleanup();
}, 60_000);

beforeEach(async () => {
  for (const i of await m.indices()) await m.remove(i, { force: true });
  for (const f of await fsp.readdir(h.fake.discoveryDir)) await fsp.rm(path.join(h.fake.discoveryDir, f), { force: true });
});

afterEach(async () => {
  m.stopMonitor();
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

async function writeDiscovery(pid: number, keys: Record<string, string | number>): Promise<string> {
  const file = path.join(h.fake.discoveryDir, `pid_${pid}.ini`);
  await fsp.writeFile(file, Object.entries(keys).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  return file;
}

/** Run `fn` with settings.bootTimeoutSec forced to `sec` (below the validated minimum, so written directly). */
async function withBootTimeout(sec: number, fn: () => Promise<void>): Promise<void> {
  const file = m.paths.settingsFile;
  const saved = await fsp.readFile(file, 'utf8');
  await fsp.writeFile(file, JSON.stringify({ ...JSON.parse(saved), bootTimeoutSec: sec }));
  await (m as unknown as { reloadSettings(): Promise<void> }).reloadSettings();
  try {
    await fn();
  } finally {
    await fsp.writeFile(file, saved);
    await (m as unknown as { reloadSettings(): Promise<void> }).reloadSettings();
  }
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

describe('open / settings / sdk', () => {
  it('creates the manager directories and reads settings + SDK', async () => {
    for (const d of [m.paths.avdHome, m.paths.logsDir, m.paths.scriptLogsDir, m.paths.runDir, m.paths.scriptsDir, m.paths.downloadsDir]) {
      expect((await fsp.stat(d)).isDirectory()).toBe(true);
    }
    const s = m.getSettings();
    expect(s.sdkRoot).toBe(h.fake.root);
    expect(s.memoryReserveMb).toBe(0);
    expect(s.bootTimeoutSec).toBe(60);
    s.maxRunning = 99;
    expect(m.getSettings().maxRunning).toBe(16); // a copy
    const sdk = await m.getSdk();
    expect(sdk.emulator?.bin).toBe(h.fake.emulatorBin);
    expect(sdk.adb?.bin).toBe(h.fake.adbBin);
    expect(sdk.images.map((i) => i.packagePath)).toEqual(['system-images;android-35;default;arm64-v8a']);
    expect((await m.adb()).bin).toBe(h.fake.adbBin);
    expect(statusLabel('running')).toBe('运行中');
  });

  it('updateSettings validates, persists and rescans the SDK when sdkRoot changes', async () => {
    const bad = await m.updateSettings({ maxRunning: 0 }).catch((e: unknown) => e);
    expect(isAvdmError(bad, 'INVALID_ARGUMENT')).toBe(true);
    await m.updateSettings({ maxRunning: 5, defaultSpec: { ...DEFAULT_SPEC, ramMb: 2048 } });
    const other = await AvdManager.open({ home: h.home });
    expect(other.getSettings().maxRunning).toBe(5);
    expect(other.getSettings().defaultSpec.ramMb).toBe(2048);
    await other.dispose();

    const empty = await fsp.mkdtemp(path.join(os.tmpdir(), 'avdm-empty-sdk-'));
    try {
      await m.updateSettings({ sdkRoot: empty });
      const sdk = await m.getSdk();
      expect(sdk.emulator).toBeUndefined();
      const adbErr = await m.adb().catch((e: unknown) => e);
      expect(isAvdmError(adbErr, 'ADB_MISSING')).toBe(true);
    } finally {
      await m.updateSettings({ sdkRoot: h.fake.root, maxRunning: 16, defaultSpec: { ...DEFAULT_SPEC, ramMb: 1024, cpuCores: 1 } });
      await fsp.rm(empty, { recursive: true, force: true });
    }
    expect((await m.getSdk()).emulator?.bin).toBe(h.fake.emulatorBin);
  });

  it('refuses to open with a corrupt settings.json', async () => {
    const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'avdm-badsettings-'));
    try {
      await fsp.writeFile(path.join(home, 'settings.json'), '{ nope');
      const err = await AvdManager.open({ home }).catch((e: unknown) => e);
      expect(isAvdmError(err, 'INVALID_ARGUMENT')).toBe(true);
      expect((err as Error).message).toContain('settings.json');
    } finally {
      await fsp.rm(home, { recursive: true, force: true });
    }
  });
});

describe('create', () => {
  it('validates count, spec and image before touching the registry', async () => {
    for (const count of [0, 65, 1.5]) {
      const err = await m.create({ count }).catch((e: unknown) => e);
      expect(isAvdmError(err, 'INVALID_ARGUMENT'), String(count)).toBe(true);
    }
    const spec = await m.create({ count: 1, spec: { ramMb: 1 } }).catch((e: unknown) => e);
    expect(isAvdmError(spec, 'INVALID_ARGUMENT')).toBe(true);
    const img = await m.create({ count: 1, image: 'system-images;android-99;default;arm64-v8a' }).catch((e: unknown) => e);
    expect(isAvdmError(img, 'IMAGE_MISSING')).toBe(true);
    expect((img as Error).message).toContain('avdm sdk install');
    expect(await m.indices()).toEqual([]);
  });

  it('uses defaults (名称 实例-<i>, settings.defaultSpec) merged with overrides', async () => {
    const ev = recordEvents(m);
    const recs = await m.create({ count: 2, spec: { cpuCores: 3, width: 1080, height: 1920 }, autoRestart: true });
    ev.stop();
    expect(recs.map((r) => r.name)).toEqual(['实例-0', '实例-1']);
    for (const r of recs) {
      expect(r.spec).toEqual({ ...DEFAULT_SPEC, ramMb: 1024, cpuCores: 3, width: 1080, height: 1920 });
      expect(r.autoRestart).toBe(true);
      expect(r.createdAt).toMatch(/^\d{4}-/);
      const cfg = await readAvdConfig(m.paths.avdHome, r.avdName);
      expect(cfg).toMatchObject({ 'hw.cpu.ncore': '3', 'hw.lcd.width': '1080', 'hw.initialOrientation': 'portrait' });
    }
    expect(ev.changed).toBe(2);
    expect(ev.logs.some((l) => l.message.includes('已创建 2 个实例'))).toBe(true);
    expect((await m.registry.list()).every((r) => r.provisioning === undefined)).toBe(true);
  });

  it('finds an image installed after the manager was opened', async () => {
    const pkg = 'system-images;android-34;google_apis;arm64-v8a';
    const dir = path.join(h.fake.root, 'system-images', 'android-34', 'google_apis', 'arm64-v8a');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'system.img'), 'x');
    await fsp.writeFile(
      path.join(dir, 'source.properties'),
      'Pkg.Revision=1\nAndroidVersion.ApiLevel=34\nSystemImage.TagId=google_apis\nSystemImage.TagDisplay=Google APIs\nSystemImage.Abi=arm64-v8a\n',
    );
    try {
      const [rec] = await m.create({ count: 1, image: pkg, namePrefix: '谷歌' });
      expect(rec).toMatchObject({ image: pkg, name: '谷歌-0' });
      expect((await readAvdConfig(m.paths.avdHome, rec!.avdName))?.['tag.id']).toBe('google_apis');
    } finally {
      await fsp.rm(path.join(h.fake.root, 'system-images', 'android-34'), { recursive: true, force: true });
      await m.refreshSdk();
    }
  });

  it('moves an unregistered AVD at a reused index aside instead of deleting it', async () => {
    const orphan = avdDirFor(m.paths.avdHome, 'avdm_0');
    await fsp.mkdir(orphan, { recursive: true });
    await fsp.writeFile(path.join(orphan, 'userdata-qemu.img'), 'precious game data');
    await fsp.writeFile(avdIniFor(m.paths.avdHome, 'avdm_0'), 'path=/nowhere\n');
    await fsp.writeFile(path.join(m.paths.logsDir, 'instance-0.log'), 'old log\n');
    await fsp.writeFile(path.join(m.paths.logsDir, 'instance-0.log.1'), 'older log\n');
    // leftovers of an interrupted delete are disposable
    const retired = `${orphan}.deleting-xyz`;
    await fsp.mkdir(retired, { recursive: true });
    const ev = recordEvents(m);
    const [rec] = await m.create({ count: 1 });
    ev.stop();
    expect(rec!.index).toBe(0);
    await expect(fsp.access(path.join(orphan, 'userdata-qemu.img'))).rejects.toThrow();
    await fsp.access(path.join(orphan, 'config.ini'));
    await expect(fsp.access(retired)).rejects.toThrow();
    const kept = await fsp.readdir(path.join(m.paths.avdHome, 'orphaned'));
    expect(kept).toHaveLength(1);
    const keptDir = path.join(m.paths.avdHome, 'orphaned', kept[0]!);
    expect(await fsp.readFile(path.join(keptDir, 'avdm_0.avd', 'userdata-qemu.img'), 'utf8')).toBe('precious game data');
    await fsp.access(path.join(keptDir, 'avdm_0.ini'));
    const warn = ev.logs.find((l) => l.level === 'warn' && l.message.includes('未登记'));
    expect(warn?.message).toContain(keptDir);
    expect(await m.instanceLog(0)).toEqual([]);
    await expect(fsp.access(path.join(m.paths.logsDir, 'instance-0.log.1'))).rejects.toThrow();
    await fsp.rm(path.join(m.paths.avdHome, 'orphaned'), { recursive: true, force: true });
  });

  it('an empty or truncated instances.json is reported as corrupt, not treated as "no instances"', async () => {
    await m.create({ count: 1 });
    const file = m.paths.registryFile;
    const good = await fsp.readFile(file, 'utf8');
    try {
      for (const text of ['', '  \n', '{"version":1}']) {
        await fsp.writeFile(file, text);
        const err = await m.create({ count: 1 }).catch((e: unknown) => e);
        expect(isAvdmError(err, 'INVALID_ARGUMENT'), JSON.stringify(text)).toBe(true);
        expect((err as Error).message).toContain('已损坏');
      }
      // the existing instance's AVD was not touched
      await fsp.access(path.join(avdDirFor(m.paths.avdHome, 'avdm_0'), 'config.ini'));
    } finally {
      await fsp.writeFile(file, good);
    }
  });

  it('rolls back every record and file when one instance cannot be created', async () => {
    // index 1 has leftover files that a live emulator still uses → create must fail and undo index 0 too
    const busyDir = avdDirFor(m.paths.avdHome, 'avdm_1');
    await fsp.mkdir(busyDir, { recursive: true });
    await fsp.writeFile(path.join(busyDir, 'in-use.txt'), 'x');
    const pid = await sleepy();
    await writeDiscovery(pid, { 'avd.id': 'avdm_1', 'avd.dir': busyDir, 'port.serial': await getFreePort() });
    const err = await m.create({ count: 3 }).catch((e: unknown) => e);
    expect(isAvdmError(err, 'INVALID_ARGUMENT')).toBe(true);
    expect(await m.indices()).toEqual([]);
    await expect(fsp.access(avdDirFor(m.paths.avdHome, 'avdm_0'))).rejects.toThrow();
    // the rollback must not delete the AVD the guard refused to touch
    await fsp.access(path.join(busyDir, 'in-use.txt'));
    await fsp.rm(busyDir, { recursive: true, force: true });
  });
});

describe('computed state', () => {
  it('dead launched pid without stop request → error with the last launch log lines', async () => {
    const [rec] = await m.create({ count: 1 });
    const i = rec!.index;
    expect((await m.getState(i)).status).toBe('stopped');
    await fsp.writeFile(
      path.join(m.paths.logsDir, `instance-${i}.log`),
      '\n=== launch 2026-01-01T00:00:00Z ===\nold command\nold output\n' +
        '\n=== launch 2026-01-02T00:00:00Z ===\n/sdk/emulator/emulator -avd avdm_0\nINFO | booting\nFATAL | out of memory\n',
    );
    const ev = recordEvents(m);
    const pid = await deadPid();
    await writeRun(i, pid);
    const st = await m.getState(i);
    ev.stop();
    expect(st.status).toBe('error');
    expect(st.error).toBe(`模拟器进程意外退出（pid ${pid}）\n日志末尾:\nINFO | booting\nFATAL | out of memory`);
    expect(ev.states).toEqual([{ index: i, status: 'error', pid: undefined, error: st.error }]);
    expect(ev.logs.filter((l) => l.level === 'error')).toHaveLength(1);
    expect((await m.list())[0]!.status).toBe('error'); // stays visible
  });

  it('dead pid with stop requested → stopped and the run record is cleared', async () => {
    const [rec] = await m.create({ count: 1 });
    await writeRun(rec!.index, await deadPid(), { stopRequestedAt: new Date().toISOString() });
    expect((await m.getState(rec!.index)).status).toBe('stopped');
    expect(await m.registry.readRun(rec!.index)).toBeUndefined();
  });

  it('live launched pid without discovery → starting / stopping / error after bootTimeoutSec', async () => {
    const [rec] = await m.create({ count: 1 });
    const i = rec!.index;
    const pid = await sleepy();
    await writeRun(i, pid);
    let st = await m.getState(i);
    expect(st).toMatchObject({ status: 'starting', pid, bootCompleted: false });
    await writeRun(i, pid, { stopRequestedAt: new Date().toISOString() });
    expect((await m.getState(i)).status).toBe('stopping');
    await writeRun(i, pid);
    await withBootTimeout(1, async () => {
      await new Promise((r) => setTimeout(r, 1100));
      st = await m.getState(i);
    });
    expect(st.status).toBe('error');
    expect(st.error).toContain('启动超时');
    expect((await m.hostStats()).runningInstances).toBe(1); // a live process still uses memory

    // stop without a console (never booted): killed right away, no graceful path
    await m.stop(i, { timeoutMs: 3000 });
    expect(isAlive(pid)).toBe(false);
    expect((await m.getState(i)).status).toBe('stopped');
    expect(await m.registry.readRun(i)).toBeUndefined();
  });

  it('discovery entry → booting / running (adb fallback when gRPC is unreachable)', async () => {
    const [rec] = await m.create({ count: 1 });
    const i = rec!.index;
    const pid = await sleepy();
    const port = await getFreePort();
    const file = await writeDiscovery(pid, {
      'avd.id': rec!.avdName,
      'avd.name': rec!.name,
      'avd.dir': avdDirFor(m.paths.avdHome, rec!.avdName),
      'port.serial': port,
      'port.adb': port + 1,
      'grpc.port': await getFreePort(),
      'grpc.token': 'secret',
      'fake.boot_at': Date.now() + 3600_000,
    });
    let st = await m.getState(i);
    expect(st).toMatchObject({ status: 'booting', pid, bootCompleted: false, grpcToken: 'secret' });
    expect(st.ports).toMatchObject({ console: port, adb: port + 1, serial: `emulator-${port}` });
    expect((await m.device(i)).serial).toBe(`emulator-${port}`);

    await fsp.writeFile(file, (await fsp.readFile(file, 'utf8')).replace(/fake\.boot_at=\d+/, 'fake.boot_at=0'));
    st = await m.getState(i);
    expect(st).toMatchObject({ status: 'running', bootCompleted: true });
    // boot=true is cached for this pid: removing the adb evidence does not flip it back
    await fsp.writeFile(file, (await fsp.readFile(file, 'utf8')).replace(/fake\.boot_at=0/, `fake.boot_at=${Date.now() + 3600_000}`));
    expect((await m.getState(i)).status).toBe('running');

    // not a real emulator: the console is closed, so stop falls back to SIGTERM
    await m.stop(i, { timeoutMs: 2000 });
    expect(isAlive(pid)).toBe(false);
    expect((await m.getState(i)).status).toBe('stopped');
  }, 30_000);

  it('ignores discovery entries of a same-named AVD from another manager home', async () => {
    const [rec] = await m.create({ count: 1 });
    const pid = await sleepy();
    await writeDiscovery(pid, {
      'avd.id': rec!.avdName,
      'avd.dir': '/Users/someone/.other-avdm/avd/avdm_0.avd',
      'port.serial': await getFreePort(),
    });
    expect((await m.getState(rec!.index)).status).toBe('stopped');
  });

  it('matches older discovery files by avd.dir when avd.name is only the display name', async () => {
    const [rec] = await m.create({ count: 1 });
    const pid = await sleepy();
    await writeDiscovery(pid, {
      'avd.name': '显示名',
      'avd.dir': avdDirFor(m.paths.avdHome, rec!.avdName),
      'port.serial': await getFreePort(),
      'fake.boot_at': Date.now() + 3600_000,
    });
    const st = await m.getState(rec!.index);
    expect(st.status).toBe('booting');
    expect(st.pid).toBe(pid);
  });
});

describe('guards on busy instances', () => {
  it('update / clone / remove / start respect a live process and provisioning', async () => {
    const [rec] = await m.create({ count: 1 });
    const i = rec!.index;
    const pid = await sleepy();
    await writeRun(i, pid);
    const spec = await m.update(i, { spec: { cpuCores: 4 } }).catch((e: unknown) => e);
    expect(isAvdmError(spec, 'INSTANCE_RUNNING')).toBe(true);
    const renamed = await m.update(i, { name: '改名' });
    expect(renamed.name).toBe('改名');
    // config.ini is not rewritten while the emulator runs
    expect((await readAvdConfig(m.paths.avdHome, rec!.avdName))?.['avd.ini.displayname']).toBe(rec!.name);
    const clone = await m.clone(i, { count: 1 }).catch((e: unknown) => e);
    expect(isAvdmError(clone, 'INSTANCE_RUNNING')).toBe(true);
    const rm = await m.remove(i).catch((e: unknown) => e);
    expect(isAvdmError(rm, 'INSTANCE_RUNNING')).toBe(true);
    await m.remove(i, { force: true });
    expect(isAlive(pid)).toBe(false);
    expect(await m.indices()).toEqual([]);

    const [p] = await m.create({ count: 1 });
    await m.registry.update(p!.index, (r) => ({ ...r, provisioning: true }));
    for (const op of [() => m.start(p!.index), () => m.clone(p!.index, { count: 1 })]) {
      const err = await op().catch((e: unknown) => e);
      expect(isAvdmError(err, 'INVALID_ARGUMENT')).toBe(true);
    }
  });

  it('start reports missing emulator, image and AVD files', async () => {
    const [rec] = await m.create({ count: 1 });
    const i = rec!.index;
    await m.registry.update(i, (r) => ({ ...r, image: 'system-images;android-99;default;arm64-v8a' }));
    const img = await m.start(i).catch((e: unknown) => e);
    expect(isAvdmError(img, 'IMAGE_MISSING')).toBe(true);
    await m.registry.update(i, (r) => ({ ...r, image: rec!.image }));

    await fsp.rm(avdDirFor(m.paths.avdHome, rec!.avdName), { recursive: true });
    const files = await m.start(i).catch((e: unknown) => e);
    expect(isAvdmError(files, 'INVALID_ARGUMENT')).toBe(true);
    expect((files as Error).message).toContain('AVD 文件缺失');

    const empty = await fsp.mkdtemp(path.join(os.tmpdir(), 'avdm-empty-sdk-'));
    try {
      await m.updateSettings({ sdkRoot: empty });
      const emu = await m.start(i).catch((e: unknown) => e);
      expect(isAvdmError(emu, 'EMULATOR_MISSING')).toBe(true);
    } finally {
      await m.updateSettings({ sdkRoot: h.fake.root });
      await fsp.rm(empty, { recursive: true, force: true });
    }
    const unknown = await m.start(63).catch((e: unknown) => e);
    expect(isAvdmError(unknown, 'INSTANCE_NOT_FOUND')).toBe(true);
  });

  it('device access on a stopped instance fails with INSTANCE_NOT_RUNNING / UNSUPPORTED', async () => {
    const [rec] = await m.create({ count: 1 });
    const i = rec!.index;
    for (const op of [() => m.grpc(i), () => m.screenshot(i), () => m.installApk(i, [h.fake.adbBin])]) {
      const err = await op().catch((e: unknown) => e);
      expect(isAvdmError(err, 'INSTANCE_NOT_RUNNING')).toBe(true);
    }
    await m.updateSettings({ scrcpyPath: '/definitely/not/scrcpy' });
    const scrcpy = await m.openScrcpy(i).catch((e: unknown) => e);
    expect(isAvdmError(scrcpy, 'UNSUPPORTED')).toBe(true);
    await m.updateSettings({ scrcpyPath: '' });

    const ev = recordEvents(m);
    await m.scripts.createExample();
    expect(await m.runScript('hello-adb', [i, 42])).toEqual([]);
    ev.stop();
    expect(ev.logs.filter((l) => l.level === 'warn').map((l) => l.index)).toEqual([i, 42]);
  });
});

describe('clone / update / remove on disk', () => {
  it('clones with keepSnapshots and names clones <prefix>-<index>', async () => {
    const [src] = await m.create({ count: 1 });
    const snap = path.join(avdDirFor(m.paths.avdHome, src!.avdName), 'snapshots', 'default_boot');
    await fsp.mkdir(snap, { recursive: true });
    await fsp.writeFile(path.join(snap, 'snapshot.pb'), 'x');
    await fsp.writeFile(path.join(avdDirFor(m.paths.avdHome, src!.avdName), 'multiinstance.lock'), '1');
    const clones = await m.clone(src!.index, { count: 2, namePrefix: '副本', keepSnapshots: true });
    expect(clones.map((c) => [c.index, c.name, c.clonedFrom])).toEqual([
      [1, '副本-1', 0],
      [2, '副本-2', 0],
    ]);
    for (const c of clones) {
      const dir = avdDirFor(m.paths.avdHome, c.avdName);
      await fsp.access(path.join(dir, 'snapshots', 'default_boot', 'snapshot.pb'));
      await expect(fsp.access(path.join(dir, 'multiinstance.lock'))).rejects.toThrow();
    }
    const missing = await m.clone(40, { count: 1 }).catch((e: unknown) => e);
    expect(isAvdmError(missing, 'INSTANCE_NOT_FOUND')).toBe(true);
  });

  it('update keeps unrelated fields and syncs the display name into config.ini', async () => {
    const [rec] = await m.create({ count: 1 });
    const r1 = await m.update(rec!.index, { name: '新名字', notes: '备注' });
    expect(r1).toMatchObject({ name: '新名字', notes: '备注', spec: rec!.spec, image: rec!.image });
    expect((await readAvdConfig(m.paths.avdHome, rec!.avdName))?.['avd.ini.displayname']).toBe('新名字');
    const r2 = await m.update(rec!.index, { autoRestart: true });
    expect(r2).toMatchObject({ name: '新名字', notes: '备注', autoRestart: true });
    const long = await m.update(rec!.index, { name: 'x'.repeat(65) }).catch((e: unknown) => e);
    expect(isAvdmError(long, 'INVALID_ARGUMENT')).toBe(true);
  });
});

describe('batch', () => {
  it('runs with bounded concurrency, keeps order and never throws', async () => {
    let active = 0;
    let peak = 0;
    const results = await m.batch(
      [5, 1, 4, 2, 3, 0],
      async (i) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 20 + i * 5));
        active--;
        if (i === 4) throw new Error('boom');
        if (i === 2) throw 'plain string'; // eslint-disable-line no-throw-literal
        return i * 10;
      },
      { concurrency: 2 },
    );
    expect(peak).toBe(2);
    expect(results.map((r) => r.index)).toEqual([5, 1, 4, 2, 3, 0]);
    expect(results.map((r) => r.ok)).toEqual([true, true, false, false, true, true]);
    const bad = results[2]!;
    expect(!bad.ok && bad.error.message).toBe('boom');
    const str = results[3]!;
    expect(!str.ok && str.error instanceof Error && str.error.message).toBe('plain string');
    expect(results[0]).toEqual({ index: 5, ok: true, value: 50 });
    expect(await m.batch([], async () => 1)).toEqual([]);

    let peak3 = 0;
    let active3 = 0;
    await m.batch([0, 1, 2, 3, 4, 5, 6], async () => {
      peak3 = Math.max(peak3, ++active3);
      await new Promise((r) => setTimeout(r, 10));
      active3--;
    });
    expect(peak3).toBe(3); // default concurrency
  });
});

describe('monitor', () => {
  it('emits instance-state changes and a log entry when an instance dies', async () => {
    const [rec] = await m.create({ count: 1 });
    const i = rec!.index;
    const pid = await sleepy();
    await writeRun(i, pid);
    const ev = recordEvents(m);
    m.startMonitor();
    await new Promise((r) => setTimeout(r, 300)); // first tick: baseline ('starting')
    process.kill(-pid, 'SIGKILL');
    const err = await waitUntil(() => ev.states.find((s) => s.index === i && s.status === 'error'), 'error event', 5000);
    expect(err.error).toContain('意外退出');
    expect(ev.logs.some((l) => l.level === 'error' && l.index === i)).toBe(true);
    m.stopMonitor();
    const count = ev.states.length;
    await writeRun(i, await sleepy());
    await new Promise((r) => setTimeout(r, 1500));
    expect(ev.states.length).toBe(count); // stopped: no more ticks
    ev.stop();
  }, 20_000);

  it('dispose() stops the monitor and refuses a restart', async () => {
    const other = await AvdManager.open({ home: h.home });
    other.startMonitor();
    await other.dispose();
    expect(() => other.startMonitor()).toThrow();
  });
});

describe('logs and host stats', () => {
  it('instanceLog returns the tail of the emulator log', async () => {
    const [rec] = await m.create({ count: 1 });
    const lines = Array.from({ length: 300 }, (_, k) => `line ${k}`);
    await fsp.writeFile(path.join(m.paths.logsDir, `instance-${rec!.index}.log`), lines.join('\n') + '\n');
    expect(await m.instanceLog(rec!.index, 3)).toEqual(['line 297', 'line 298', 'line 299']);
    expect(await m.instanceLog(rec!.index)).toHaveLength(200);
    const err = await m.instanceLog(33).catch((e: unknown) => e);
    expect(isAvdmError(err, 'INSTANCE_NOT_FOUND')).toBe(true);
  });

  it('hostStats reports host numbers and the committed RAM of live instances', async () => {
    const recs = await m.create({ count: 2 });
    await writeRun(recs[1]!.index, await sleepy());
    const stats = await m.hostStats();
    expect(stats.totalMemMb).toBeGreaterThan(0);
    expect(stats.cpuCount).toBeGreaterThan(0);
    expect(stats.runningInstances).toBe(1);
    expect(stats.committedInstanceRamMb).toBe(1024);
  });
});
